package printerconnector

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net/textproto"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
)

type ArtifactRetrieval struct {
	AssignmentID, RunID  uuid.UUID
	ConfigurationVersion int64
	ReportedPath         string
	CandidatePath        *string
	CandidateSize        *int64
	AttemptCount         int
	ExpiresAt            time.Time
}

func (s *Store) ScheduleArtifactRetrieval(
	ctx context.Context,
	assignmentID, runID uuid.UUID,
	configurationVersion int64,
	reportedPath string,
	expiresAt time.Time,
) error {
	reportedPath = strings.TrimSpace(reportedPath)
	if assignmentID == uuid.Nil || runID == uuid.Nil || configurationVersion < 1 || reportedPath == "" ||
		len(reportedPath) > 255 {
		return errors.New("invalid artifact retrieval")
	}
	var pending int64
	if err := s.db.QueryRowContext(
		ctx,
		`SELECT (SELECT count(*) FROM artifact_transfers WHERE `+queuedArtifactTransfer+`)+(SELECT count(*) FROM artifact_retrievals WHERE state='pending')`,
	).Scan(&pending); err != nil {
		return err
	}
	if pending >= maxArtifactTransfers {
		return errors.New("artifact transfer queue is full")
	}
	now := time.Now().UTC()
	if expiresAt.IsZero() {
		expiresAt = now.Add(24 * time.Hour)
	}
	_, err := s.db.ExecContext(
		ctx,
		`INSERT INTO artifact_retrievals(assignment_id,run_id,configuration_version,reported_path,next_attempt_at,expires_at,created_at,updated_at)
		VALUES(?,?,?,?,?,?,?,?)
		ON CONFLICT(assignment_id,run_id) DO UPDATE SET
			configuration_version=excluded.configuration_version,
			reported_path=CASE WHEN artifact_retrievals.state='pending' THEN excluded.reported_path ELSE artifact_retrievals.reported_path END,
			expires_at=CASE WHEN artifact_retrievals.state='pending' AND excluded.expires_at>artifact_retrievals.expires_at
				THEN excluded.expires_at ELSE artifact_retrievals.expires_at END,
			updated_at=excluded.updated_at`,
		assignmentID.String(),
		runID.String(),
		configurationVersion,
		reportedPath,
		now.Format(time.RFC3339Nano),
		expiresAt.UTC().Format(time.RFC3339Nano),
		now.Format(time.RFC3339Nano),
		now.Format(time.RFC3339Nano),
	)
	return err
}

func (s *Store) PendingArtifactRetrieval(ctx context.Context, assignmentID uuid.UUID) (*ArtifactRetrieval, error) {
	row := s.db.QueryRowContext(
		ctx,
		`SELECT assignment_id,run_id,configuration_version,reported_path,candidate_path,candidate_size,attempt_count,expires_at
		FROM artifact_retrievals WHERE assignment_id=? AND state='pending' AND next_attempt_at<=? AND expires_at>? ORDER BY created_at LIMIT 1`,
		assignmentID.String(),
		time.Now().UTC().Format(time.RFC3339Nano),
		time.Now().UTC().Format(time.RFC3339Nano),
	)
	var value ArtifactRetrieval
	var assignment, run, expires string
	var candidatePath sql.NullString
	var candidateSize sql.NullInt64
	if err := row.Scan(
		&assignment,
		&run,
		&value.ConfigurationVersion,
		&value.ReportedPath,
		&candidatePath,
		&candidateSize,
		&value.AttemptCount,
		&expires,
	); errors.Is(
		err,
		sql.ErrNoRows,
	) {
		return nil, nil
	} else if err != nil {
		return nil, err
	}
	var err error
	if value.AssignmentID, err = uuid.Parse(assignment); err != nil {
		return nil, err
	}
	if value.RunID, err = uuid.Parse(run); err != nil {
		return nil, err
	}
	if value.ExpiresAt, err = time.Parse(time.RFC3339Nano, expires); err != nil {
		return nil, err
	}
	if candidatePath.Valid {
		value.CandidatePath = &candidatePath.String
	}
	if candidateSize.Valid {
		value.CandidateSize = &candidateSize.Int64
	}
	return &value, nil
}

func (s *Store) ObserveArtifactCandidate(
	ctx context.Context,
	retrieval ArtifactRetrieval,
	candidate ArtifactCandidate,
) (bool, error) {
	stable := candidate.Size > 0 && retrieval.CandidatePath != nil && retrieval.CandidateSize != nil &&
		*retrieval.CandidatePath == candidate.RemotePath &&
		*retrieval.CandidateSize == candidate.Size
	next := time.Now().UTC()
	if !stable {
		next = next.Add(5 * time.Second)
	}
	_, err := s.db.ExecContext(
		ctx,
		`UPDATE artifact_retrievals SET candidate_path=?,candidate_size=?,next_attempt_at=?,updated_at=? WHERE assignment_id=? AND run_id=? AND state='pending'`,
		candidate.RemotePath,
		candidate.Size,
		next.Format(time.RFC3339Nano),
		time.Now().UTC().Format(time.RFC3339Nano),
		retrieval.AssignmentID.String(),
		retrieval.RunID.String(),
	)
	return stable, err
}

func (s *Store) MarkArtifactRetrievalFailure(ctx context.Context, retrieval ArtifactRetrieval, reason string) error {
	if len(reason) > 80 {
		reason = reason[:80]
	}
	delay := 5 * time.Second * time.Duration(1<<min(retrieval.AttemptCount, 6))
	if delay > 5*time.Minute {
		delay = 5 * time.Minute
	}
	_, err := s.db.ExecContext(
		ctx,
		`UPDATE artifact_retrievals SET attempt_count=attempt_count+1,next_attempt_at=?,reason_code=?,updated_at=? WHERE assignment_id=? AND run_id=? AND state='pending'`,
		time.Now().UTC().Add(delay).Format(time.RFC3339Nano),
		reason,
		time.Now().UTC().Format(time.RFC3339Nano),
		retrieval.AssignmentID.String(),
		retrieval.RunID.String(),
	)
	return err
}

func (s *Store) MarkArtifactRetrievalStaged(ctx context.Context, retrieval ArtifactRetrieval) error {
	_, err := s.db.ExecContext(
		ctx,
		`UPDATE artifact_retrievals SET state='staged',reason_code=NULL,updated_at=? WHERE assignment_id=? AND run_id=? AND state='pending'`,
		time.Now().UTC().Format(time.RFC3339Nano),
		retrieval.AssignmentID.String(),
		retrieval.RunID.String(),
	)
	return err
}

func (s *Store) RetryPendingArtifactRetrievalsNow(ctx context.Context, assignmentID uuid.UUID) error {
	if assignmentID == uuid.Nil {
		return errors.New("artifact retrieval assignment is required")
	}
	_, err := s.db.ExecContext(
		ctx,
		`UPDATE artifact_retrievals SET next_attempt_at=?,updated_at=? WHERE assignment_id=? AND state='pending'`,
		time.Now().UTC().Format(time.RFC3339Nano),
		time.Now().UTC().Format(time.RFC3339Nano),
		assignmentID.String(),
	)
	return err
}

func (s *Store) QuarantineExpiredArtifactRetrievals(ctx context.Context, assignmentID uuid.UUID) error {
	_, err := s.db.ExecContext(
		ctx,
		`UPDATE artifact_retrievals SET state='quarantined',reason_code='artifact_retry_expired',updated_at=? WHERE assignment_id=? AND state='pending' AND expires_at<=?`,
		time.Now().UTC().Format(time.RFC3339Nano),
		assignmentID.String(),
		time.Now().UTC().Format(time.RFC3339Nano),
	)
	return err
}

func (s *Store) QuarantineInvalidArtifactRetrievals(ctx context.Context, assignmentID uuid.UUID) (bool, error) {
	result, err := s.db.ExecContext(
		ctx,
		`UPDATE artifact_retrievals SET state='quarantined',reason_code='artifact_candidate_not_archive',updated_at=? WHERE assignment_id=? AND state='pending' AND lower(trim(reported_path)) NOT LIKE '%.3mf'`,
		time.Now().UTC().Format(time.RFC3339Nano),
		assignmentID.String(),
	)
	if err != nil {
		return false, err
	}
	count, err := result.RowsAffected()
	return count > 0, err
}

func (s *Store) QuarantineArtifactRetrieval(ctx context.Context, retrieval ArtifactRetrieval, reason string) error {
	if len(reason) > 80 {
		reason = reason[:80]
	}
	_, err := s.db.ExecContext(
		ctx,
		`UPDATE artifact_retrievals SET state='quarantined',reason_code=?,updated_at=? WHERE assignment_id=? AND run_id=? AND state='pending'`,
		reason,
		time.Now().UTC().Format(time.RFC3339Nano),
		retrieval.AssignmentID.String(),
		retrieval.RunID.String(),
	)
	return err
}

// runArtifactRetrievals reports both failures and the first successful retry.
// Artifact transport is independent from MQTT, but its diagnostic must still
// clear after recovery instead of leaving the assignment degraded forever.
func (a *bambuH2DAdapter) runArtifactRetrievals(ctx context.Context, results chan<- error) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	retrievalFailed, consumptionFailed := false, false
	send := func(err error) bool {
		select {
		case results <- err:
			return true
		case <-ctx.Done():
			return false
		}
	}
	if err := a.store.RetryPendingArtifactRetrievalsNow(ctx, a.assignmentID); err != nil && !send(err) {
		return
	}
	for {
		wasFailed := retrievalFailed || consumptionFailed
		consumptionErr := a.processArtifactConsumptions(ctx)
		if consumptionErr != nil && !errors.Is(consumptionErr, context.Canceled) {
			consumptionFailed = true
			if !send(consumptionErr) {
				return
			}
		} else if consumptionErr == nil {
			consumptionFailed = false
		}
		// Timelapse problems are recorded per run and never degrade the assignment.
		_ = a.processTimelapses(ctx)
		succeeded, err := a.retrieveOneArtifact(ctx)
		if err != nil && !errors.Is(err, context.Canceled) {
			retrievalFailed = true
			if !send(err) {
				return
			}
		} else if succeeded {
			retrievalFailed = false
		}
		if wasFailed && !retrievalFailed && !consumptionFailed {
			if !send(nil) {
				return
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (a *bambuH2DAdapter) retrieveOneArtifact(ctx context.Context) (bool, error) {
	cleaned, err := a.store.QuarantineInvalidArtifactRetrievals(ctx, a.assignmentID)
	if err != nil || cleaned {
		return cleaned, err
	}
	expired, err := a.store.ExpireArtifactRetrievals(ctx, a.assignmentID)
	if err != nil {
		return false, err
	}
	for _, item := range expired {
		if err = a.reportArtifactProblem(ctx, item.RunID, "unavailable", item.LastReason); err != nil {
			return false, err
		}
	}
	retrieval, err := a.store.PendingArtifactRetrieval(ctx, a.assignmentID)
	if err != nil || retrieval == nil {
		return false, err
	}
	if !isBambuArchivePath(retrieval.ReportedPath) {
		// Older connector builds incorrectly queued H2D's internal
		// /data/Metadata/plate_N.gcode path. Stop retrying it; it is not the
		// original archive and cannot pass the 3MF validation anyway.
		if err = a.store.QuarantineArtifactRetrieval(ctx, *retrieval, "artifact_candidate_not_archive"); err != nil {
			return false, err
		}
		return true, a.reportArtifactProblem(ctx, retrieval.RunID, "unavailable", "artifact_candidate_not_archive")
	}
	listings, listingErr := listBambuArtifactDirectories(ctx, a.listArtifactDirectory)
	candidate, err := SelectArtifactCandidate(retrieval.ReportedPath, listings)
	if err != nil {
		// A file found in either permitted location is sufficient. If it was
		// not found and the other location could not be listed, retain the
		// transport failure and retry instead of claiming the file is absent.
		if listingErr != nil {
			err = listingErr
		} else if _, internal, factsErr := a.store.InternalStorageRunFacts(
			ctx, a.assignmentID, retrieval.RunID, a.kind,
		); factsErr == nil && internal {
			// The print came from internal storage and external storage was listed
			// successfully: the file is not there, so do not keep retrying. Staff may have
			// uploaded the 3MF to Core meanwhile; that settles the run instead.
			adopted, adoptErr := a.adoptCoreArtifact(ctx, retrieval.RunID)
			if adoptErr != nil {
				return false, adoptErr
			}
			if adopted {
				return true, a.store.MarkArtifactRetrievalStaged(ctx, *retrieval)
			}
			diagnostic := classifyAdapterError(err)
			if err = a.store.QuarantineArtifactRetrieval(ctx, *retrieval, diagnostic); err != nil {
				return false, err
			}
			return true, a.reportArtifactProblem(ctx, retrieval.RunID, "unavailable", diagnostic)
		}
		return false, a.recordRetrievalFailure(ctx, *retrieval, err)
	}
	stable, err := a.store.ObserveArtifactCandidate(ctx, *retrieval, candidate)
	if err != nil || !stable {
		return false, err
	}
	directory := filepath.Join(a.store.dataDir, "artifacts")
	if err = os.MkdirAll(directory, 0o700); err != nil {
		return false, a.recordRetrievalFailure(ctx, *retrieval, err)
	}
	temporary, err := os.CreateTemp(directory, ".retrieval-*.3mf")
	if err != nil {
		return false, a.recordRetrievalFailure(ctx, *retrieval, err)
	}
	temporaryPath := temporary.Name()
	defer func() { _ = os.Remove(temporaryPath) }()
	if err = temporary.Chmod(0o600); err == nil {
		client, clientErr := NewBambuFTPSClient(a.settings, a.secrets)
		if clientErr == nil {
			clientErr = client.Connect(ctx)
		}
		if clientErr == nil {
			clientErr = client.Retrieve(ctx, candidate.RemotePath, temporary)
		}
		if client != nil {
			_ = client.Close()
		}
		err = clientErr
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return false, a.recordRetrievalFailure(ctx, *retrieval, err)
	}
	info, err := os.Stat(temporaryPath)
	if err != nil || info.Size() != candidate.Size {
		if err == nil {
			err = fmt.Errorf("retrieved artifact size changed from %d to %d", candidate.Size, info.Size())
		}
		return false, a.recordRetrievalFailure(ctx, *retrieval, err)
	}
	reader, err := os.Open(temporaryPath) //nolint:gosec // temporary file created by this process in the connector data directory
	if err != nil {
		return false, a.recordRetrievalFailure(ctx, *retrieval, err)
	}
	_, stageErr := a.store.StageArtifact(
		ctx,
		retrieval.AssignmentID,
		retrieval.RunID,
		retrieval.ConfigurationVersion,
		candidate.RemotePath,
		candidate.Name,
		reader,
		retrieval.ExpiresAt,
	)
	closeErr := reader.Close()
	if stageErr != nil {
		return false, a.recordRetrievalFailure(ctx, *retrieval, stageErr)
	}
	if closeErr != nil {
		return false, a.recordRetrievalFailure(ctx, *retrieval, closeErr)
	}
	if err = a.store.MarkArtifactRetrievalStaged(ctx, *retrieval); err != nil {
		return false, err
	}
	pending := string(machineConsumptionPending)
	return true, a.store.SetRunConsumptionReport(ctx, a.assignmentID, retrieval.RunID, "pending", &pending, nil)
}

func (a *bambuH2DAdapter) listArtifactDirectory(ctx context.Context, directory string) ([]FTPEntry, error) {
	client, err := NewBambuFTPSClient(a.settings, a.secrets)
	if err != nil {
		return nil, err
	}
	if err = client.Connect(ctx); err != nil {
		return nil, err
	}
	defer func() { _ = client.Close() }()
	return client.List(ctx, directory)
}

func listBambuArtifactDirectories(
	ctx context.Context,
	list func(context.Context, string) ([]FTPEntry, error),
) (map[string][]FTPEntry, error) {
	listings := make(map[string][]FTPEntry, 2)
	var failures []error
	// H2D FTPS may expose only its external-storage root. Try that first and
	// treat /cache as an independent optional location.
	for _, directory := range []string{"/", "/cache"} {
		entries, err := list(ctx, directory)
		if err != nil {
			failures = append(failures, err)
			continue
		}
		listings[directory] = entries
	}
	return listings, errors.Join(failures...)
}

func (a *bambuH2DAdapter) recordRetrievalFailure(ctx context.Context, retrieval ArtifactRetrieval, err error) error {
	diagnostic := classifyAdapterError(err)
	var protocolErr *textproto.Error
	if errors.As(err, &protocolErr) {
		// The numeric FTP reply is safe operational context and is sufficient
		// to distinguish an unavailable path from a broken protected channel.
		slog.Warn("Bambu FTPS artifact retrieval failed", "diagnostic", diagnostic, "ftp_reply_code", protocolErr.Code)
	}
	if queueErr := a.store.MarkArtifactRetrievalFailure(ctx, retrieval, diagnostic); queueErr != nil {
		return queueErr
	}
	if reportErr := a.reportArtifactProblem(ctx, retrieval.RunID, "pending", diagnostic); reportErr != nil {
		return reportErr
	}
	return err
}

// Consumption reasons the connector reports to Core (machinelogbook.ConsumptionReason).
type consumptionReason string

const (
	machineArtifactNotFound         consumptionReason = "artifact_not_found_on_printer"
	machineArtifactRetrievalFailed  consumptionReason = "artifact_retrieval_failed"
	machineArtifactUploadFailed     consumptionReason = "artifact_upload_failed"
	machineArtifactRejected         consumptionReason = "artifact_rejected"
	machineNoSlicerWeights          consumptionReason = "no_slicer_weights_in_artifact"
	machineGCodeEstimateUnavailable consumptionReason = "gcode_estimate_unavailable"
	machineCancelledBeforeLayer     consumptionReason = "cancelled_before_first_layer"
	machineConsumptionPending       consumptionReason = "consumption_pending"
	machineArtifactOnInternal       consumptionReason = "artifact_on_internal_storage"
)

// artifactProblemReason maps a retrieval diagnostic to the consumption reason
// Core shows: the archive was not there (or not unambiguous), or the transport failed.
func artifactProblemReason(diagnostic string) consumptionReason {
	switch diagnostic {
	case "", "artifact_not_available", "artifact_ambiguous", "artifact_candidate_not_archive", "artifact_retry_expired",
		"no_archive_reported":
		return machineArtifactNotFound
	}
	return machineArtifactRetrievalFailed
}

// reportArtifactProblem records why the run's archive is missing; state is
// pending while retries continue and unavailable once the connector gave up.
func (a *bambuH2DAdapter) reportArtifactProblem(ctx context.Context, runID uuid.UUID, state, diagnostic string) error {
	reason := string(artifactProblemReason(diagnostic))
	var detail *string
	if diagnostic != "" && reasonCodePattern.MatchString(diagnostic) {
		detail = &diagnostic
	}
	if reason == string(machineArtifactNotFound) {
		// A print from internal storage has no archive the connector can reach;
		// say that instead of blaming a missing file, and name the internal path.
		facts, internal, err := a.store.InternalStorageRunFacts(ctx, a.assignmentID, runID, a.kind)
		if err != nil {
			return err
		}
		if internal {
			reason, detail = string(machineArtifactOnInternal), nil
			if facts.InternalPath != "" {
				detail = &facts.InternalPath
			}
		}
	}
	return a.store.SetRunConsumptionReport(ctx, a.assignmentID, runID, state, &reason, detail)
}
