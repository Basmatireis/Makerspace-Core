package printerconnector

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/textproto"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/printartifacts/parser"
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
	// RunEndedAt is when the connector saw the run end; a lookup that finds no
	// archive gives up postRunArtifactWindow after it.
	RunEndedAt *time.Time
}

// migrateArtifactRetrievals adds the columns later connector versions need to
// the retrieval table of an existing state file.
func (s *Store) migrateArtifactRetrievals(ctx context.Context) error {
	rows, err := s.db.QueryContext(ctx, `PRAGMA table_info(artifact_retrievals)`)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	hasRunEnded := false
	for rows.Next() {
		var (
			id, notNull, primaryKey int
			name, columnType        string
			defaultValue            sql.NullString
		)
		if err = rows.Scan(&id, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			return err
		}
		if name == "run_ended_at" {
			hasRunEnded = true
		}
	}
	if err = rows.Err(); err != nil {
		return err
	}
	if hasRunEnded {
		return nil
	}
	_, err = s.db.ExecContext(ctx, `ALTER TABLE artifact_retrievals ADD COLUMN run_ended_at TEXT`)
	return err
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

// MarkArtifactRunEnded records when the run ended, so a lookup that finds no
// archive gives up after the post-run window, and makes a pending retrieval
// due at once: the end of the print is the best moment to look again.
func (s *Store) MarkArtifactRunEnded(ctx context.Context, assignmentID, runID uuid.UUID, endedAt time.Time) error {
	_, err := s.db.ExecContext(
		ctx,
		`UPDATE artifact_retrievals SET run_ended_at=coalesce(run_ended_at,?),
			next_attempt_at=CASE WHEN state='pending' THEN ? ELSE next_attempt_at END,updated_at=?
		WHERE assignment_id=? AND run_id=?`,
		endedAt.UTC().Format(time.RFC3339Nano),
		time.Now().UTC().Format(time.RFC3339Nano),
		time.Now().UTC().Format(time.RFC3339Nano),
		assignmentID.String(),
		runID.String(),
	)
	return err
}

// MarkArtifactLookupFinal makes the next listing that holds no archive the last
// one: the run is treated as having ended before the post-run window.
func (s *Store) MarkArtifactLookupFinal(ctx context.Context, assignmentID, runID uuid.UUID) error {
	_, err := s.db.ExecContext(
		ctx,
		`UPDATE artifact_retrievals SET run_ended_at=?,updated_at=? WHERE assignment_id=? AND run_id=?`,
		time.Now().UTC().Add(-postRunArtifactWindow).Format(time.RFC3339Nano),
		time.Now().UTC().Format(time.RFC3339Nano),
		assignmentID.String(),
		runID.String(),
	)
	return err
}

func (s *Store) PendingArtifactRetrieval(ctx context.Context, assignmentID uuid.UUID) (*ArtifactRetrieval, error) {
	row := s.db.QueryRowContext(
		ctx,
		`SELECT assignment_id,run_id,configuration_version,reported_path,candidate_path,candidate_size,attempt_count,expires_at,run_ended_at
		FROM artifact_retrievals WHERE assignment_id=? AND state='pending' AND next_attempt_at<=? AND expires_at>? ORDER BY created_at LIMIT 1`,
		assignmentID.String(),
		time.Now().UTC().Format(time.RFC3339Nano),
		time.Now().UTC().Format(time.RFC3339Nano),
	)
	var value ArtifactRetrieval
	var assignment, run, expires string
	var candidatePath, runEnded sql.NullString
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
		&runEnded,
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
	if runEnded.Valid {
		endedAt, parseErr := time.Parse(time.RFC3339Nano, runEnded.String)
		if parseErr != nil {
			return nil, parseErr
		}
		value.RunEndedAt = &endedAt
	}
	return &value, nil
}

// ObserveArtifactCandidate is ObserveArtifactCandidates for one candidate.
func (s *Store) ObserveArtifactCandidate(
	ctx context.Context,
	retrieval ArtifactRetrieval,
	candidate ArtifactCandidate,
) (bool, error) {
	return s.ObserveArtifactCandidates(ctx, retrieval, []ArtifactCandidate{candidate})
}

// ObserveArtifactCandidates remembers the archives a listing found with their
// sizes and reports whether the previous listing found the same set with the
// same positive sizes, which means the printer is no longer writing them.
func (s *Store) ObserveArtifactCandidates(
	ctx context.Context,
	retrieval ArtifactRetrieval,
	candidates []ArtifactCandidate,
) (bool, error) {
	if len(candidates) == 0 {
		return false, errors.New("no artifact candidates to observe")
	}
	fingerprint, total := candidateFingerprint(candidates)
	positive := true
	for _, candidate := range candidates {
		positive = positive && candidate.Size > 0
	}
	stable := positive && retrieval.CandidatePath != nil && retrieval.CandidateSize != nil &&
		*retrieval.CandidatePath == fingerprint &&
		*retrieval.CandidateSize == total
	next := time.Now().UTC()
	if !stable {
		next = next.Add(5 * time.Second)
	}
	_, err := s.db.ExecContext(
		ctx,
		`UPDATE artifact_retrievals SET candidate_path=?,candidate_size=?,next_attempt_at=?,updated_at=? WHERE assignment_id=? AND run_id=? AND state='pending'`,
		fingerprint,
		total,
		next.Format(time.RFC3339Nano),
		time.Now().UTC().Format(time.RFC3339Nano),
		retrieval.AssignmentID.String(),
		retrieval.RunID.String(),
	)
	return stable, err
}

// MarkArtifactRetrievalFailure defers the retrieval with exponential backoff
// (5 s doubling up to 5 min) and remembers why it did not succeed.
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
		`UPDATE artifact_retrievals SET attempt_count=attempt_count+1,next_attempt_at=?,reason_code=?,candidate_path=NULL,candidate_size=NULL,updated_at=? WHERE assignment_id=? AND run_id=? AND state='pending'`,
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

// HasArtifactTransfer is true when the run already has a transfer of exactly
// these bytes, staged or quarantined, so the same archive is never queued twice.
func (s *Store) HasArtifactTransfer(ctx context.Context, assignmentID, runID uuid.UUID, sha string) (bool, error) {
	var count int64
	err := s.db.QueryRowContext(
		ctx,
		`SELECT count(*) FROM artifact_transfers WHERE assignment_id=? AND run_id=? AND sha256=?`,
		assignmentID.String(),
		runID.String(),
		sha,
	).Scan(&count)
	return count > 0, err
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

// retrieveOneArtifact advances the assignment's oldest due retrieval by one
// step: it settles legacy and expired rows, lists external storage, decides
// what the evidence identifies, waits for a stable size, downloads and
// validates the archive and stages it. It returns true when a retrieval
// reached a terminal state (staged or given up) and an error only for
// transport or storage failures, which degrade the assignment until they heal.
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
		return true, a.settleArtifactRetrieval(ctx, *retrieval, diagnosticArtifactNotArchive)
	}
	// A run whose archive is already staged (Core's copy was adopted, or an earlier
	// lookup succeeded) needs no further lookup.
	if staged, stagedErr := a.store.StagedArtifactForRun(ctx, a.assignmentID, retrieval.RunID); stagedErr != nil {
		return false, stagedErr
	} else if staged != nil {
		return true, a.store.MarkArtifactRetrievalStaged(ctx, *retrieval)
	}
	facts, known, err := a.store.RunFactsFor(ctx, a.assignmentID, retrieval.RunID, a.kind)
	if err != nil {
		return false, err
	}
	evidence := artifactEvidenceFor(retrieval.ReportedPath, facts, known)
	client, err := a.openFTPS(ctx)
	if err != nil {
		return false, a.recordRetrievalFailure(ctx, *retrieval, err)
	}
	defer func() { _ = client.Close() }()
	listings, listingErr := listBambuArtifactDirectories(ctx, client.List)
	candidates, err := discoverArtifacts(evidence, listings)
	switch {
	case err == nil:
	case listingErr != nil:
		// A file found in either permitted location is sufficient. If it was
		// not found and the other location could not be listed, retain the
		// transport failure and retry instead of claiming the file is absent.
		return false, a.recordRetrievalFailure(ctx, *retrieval, listingErr)
	case errors.Is(err, errArtifactAmbiguous):
		return true, a.settleArtifactRetrieval(ctx, *retrieval, diagnosticArtifactAmbiguous)
	default:
		return a.deferMissingArtifact(ctx, *retrieval, facts, known)
	}
	stable, err := a.store.ObserveArtifactCandidates(ctx, *retrieval, candidates)
	if err != nil || !stable {
		return false, err
	}
	downloads, err := a.downloadArtifactCandidates(ctx, client, candidates)
	defer func() {
		for _, item := range downloads {
			_ = os.Remove(item.path)
		}
	}()
	if err != nil {
		return false, a.recordRetrievalFailure(ctx, *retrieval, err)
	}
	chosen, diagnostic := chooseRetrievedArtifact(downloads, evidence, facts, known)
	if diagnostic != "" {
		return true, a.settleArtifactRetrieval(ctx, *retrieval, diagnostic)
	}
	return a.stageRetrievedArtifact(ctx, *retrieval, chosen)
}

// deferMissingArtifact handles a listing that holds no archive for the run.
// While the run is active, and for postRunArtifactWindow after it ended, the
// archive may still appear (the slicer is sending it, or a status naming its
// path is yet to come), so the lookup is repeated with backoff. Afterwards
// Core's own copy is adopted when staff uploaded one, otherwise the run is
// settled as having no archive on the printer.
func (a *bambuH2DAdapter) deferMissingArtifact(
	ctx context.Context,
	retrieval ArtifactRetrieval,
	facts bambuRunFacts,
	known bool,
) (bool, error) {
	ended := !known || facts.Outcome != "" || retrieval.RunEndedAt != nil
	withinWindow := retrieval.RunEndedAt != nil && time.Since(*retrieval.RunEndedAt) < postRunArtifactWindow
	if !ended || withinWindow {
		if err := a.store.MarkArtifactRetrievalFailure(ctx, retrieval, diagnosticArtifactNotAvailable); err != nil {
			return false, err
		}
		return false, a.reportArtifactProblem(ctx, retrieval.RunID, "pending", diagnosticArtifactNotAvailable)
	}
	adopted, err := a.adoptCoreArtifact(ctx, retrieval.RunID)
	if err != nil {
		return false, err
	}
	if adopted {
		return true, a.store.MarkArtifactRetrievalStaged(ctx, retrieval)
	}
	return true, a.settleArtifactRetrieval(ctx, retrieval, diagnosticArtifactNotAvailable)
}

// settleArtifactRetrieval gives the retrieval up for good with the diagnostic
// and tells Core why the run has no archive.
func (a *bambuH2DAdapter) settleArtifactRetrieval(ctx context.Context, retrieval ArtifactRetrieval, diagnostic string) error {
	if err := a.store.QuarantineArtifactRetrieval(ctx, retrieval, diagnostic); err != nil {
		return err
	}
	return a.reportArtifactProblem(ctx, retrieval.RunID, "unavailable", diagnostic)
}

// retrievedArtifact is one candidate downloaded to a temporary file.
type retrievedArtifact struct {
	candidate ArtifactCandidate
	path      string
	sha       string
}

// downloadArtifactCandidates fetches every candidate (at most one per directory)
// into the connector's data directory, hashing while writing. A size that
// differs from the listing means the printer changed the file meanwhile; that
// is a transport failure to retry, not a verdict about the archive.
func (a *bambuH2DAdapter) downloadArtifactCandidates(
	ctx context.Context,
	client bambuFTPS,
	candidates []ArtifactCandidate,
) ([]retrievedArtifact, error) {
	if len(candidates) > maxArtifactCandidates {
		return nil, fmt.Errorf("%d artifact candidates exceed the limit of %d", len(candidates), maxArtifactCandidates)
	}
	directory := filepath.Join(a.store.dataDir, "artifacts")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, err
	}
	var downloads []retrievedArtifact
	for _, candidate := range candidates {
		item, err := downloadArtifactCandidate(ctx, client, candidate, directory)
		if err != nil {
			return downloads, err
		}
		downloads = append(downloads, item)
	}
	return downloads, nil
}

func downloadArtifactCandidate(
	ctx context.Context,
	client bambuFTPS,
	candidate ArtifactCandidate,
	directory string,
) (retrievedArtifact, error) {
	temporary, err := os.CreateTemp(directory, ".retrieval-*.3mf")
	if err != nil {
		return retrievedArtifact{}, err
	}
	item := retrievedArtifact{candidate: candidate, path: temporary.Name()}
	keep := false
	defer func() {
		if !keep {
			_ = os.Remove(item.path)
		}
	}()
	hash := sha256.New()
	err = temporary.Chmod(0o600)
	if err == nil {
		err = client.RetrieveLimited(ctx, candidate.RemotePath, io.MultiWriter(temporary, hash), maxStagedArtifact+1)
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return retrievedArtifact{}, err
	}
	info, err := os.Stat(item.path)
	if err != nil {
		return retrievedArtifact{}, err
	}
	if info.Size() != candidate.Size {
		return retrievedArtifact{}, fmt.Errorf("retrieved artifact size changed from %d to %d", candidate.Size, info.Size())
	}
	item.sha = hex.EncodeToString(hash.Sum(nil))
	keep = true
	return item, nil
}

// artifactIdentity is what a downloaded archive says about itself.
type artifactIdentity struct {
	jobName    string
	layerCount *int
}

// inspectArtifact checks that the download is a complete, well-formed 3MF and
// reads the metadata the run is compared with.
func inspectArtifact(item retrievedArtifact) (artifactIdentity, error) {
	if err := validateStagedZIP(item.path, item.candidate.Size); err != nil {
		return artifactIdentity{}, err
	}
	file, err := os.Open(item.path) //nolint:gosec // temporary file created by this process in the connector data directory
	if err != nil {
		return artifactIdentity{}, err
	}
	defer func() { _ = file.Close() }()
	parsed, err := parser.Parse(file, item.candidate.Size, parser.DefaultLimits())
	if err != nil {
		return artifactIdentity{}, fmt.Errorf("parse retrieved artifact: %w", err)
	}
	return artifactIdentity{jobName: parsed.Metadata.JobName, layerCount: parsed.Metadata.LayerCount}, nil
}

// artifactMatchesRun applies Core's manual-upload rule before the connector
// associates an archive with a run: the file name or the project name inside
// the 3MF must match the print name. Without a print name there is nothing to
// compare, so nothing mismatches.
func artifactMatchesRun(identity artifactIdentity, fileName string, facts bambuRunFacts, known bool) bool {
	if !known || facts.PrintName == "" {
		return true
	}
	return archiveNameMatchesPrint(facts.PrintName, fileName) ||
		(identity.jobName != "" && archiveNameMatchesPrint(facts.PrintName, identity.jobName))
}

// chooseRetrievedArtifact decides which download, if any, is the run's archive.
// Byte-identical copies in / and /cache are one logical artifact. A single
// candidate must be a valid 3MF and, unless the printer named its path itself,
// carry the print's name. Candidates with different content need run-specific
// evidence (the printer's layer count) to pick one; otherwise nothing is chosen
// and the diagnostic says why.
func chooseRetrievedArtifact(
	downloads []retrievedArtifact,
	evidence artifactEvidence,
	facts bambuRunFacts,
	known bool,
) (retrievedArtifact, string) {
	if len(downloads) == 0 {
		return retrievedArtifact{}, diagnosticArtifactNotAvailable
	}
	identical := true
	for _, item := range downloads[1:] {
		identical = identical && item.sha == downloads[0].sha
	}
	if identical {
		downloads = downloads[:1]
	}
	type inspected struct {
		item     retrievedArtifact
		identity artifactIdentity
	}
	var matching []inspected
	invalid, mismatched := 0, 0
	for _, item := range downloads {
		identity, err := inspectArtifact(item)
		if err != nil {
			slog.Warn("retrieved artifact is not a valid 3MF", "remote_path", item.candidate.RemotePath, "error", err)
			invalid++
			continue
		}
		explicit := len(downloads) == 1 && item.candidate.RemotePath == evidence.ExplicitPath
		if !explicit && !artifactMatchesRun(identity, item.candidate.Name, facts, known) {
			mismatched++
			continue
		}
		matching = append(matching, inspected{item: item, identity: identity})
	}
	switch len(matching) {
	case 1:
		return matching[0].item, ""
	case 0:
		if mismatched > 0 {
			return retrievedArtifact{}, diagnosticArtifactNameMismatch
		}
		if invalid > 0 {
			return retrievedArtifact{}, diagnosticArtifactInvalid
		}
		return retrievedArtifact{}, diagnosticArtifactNotAvailable
	}
	if known && facts.TotalLayers != nil {
		var byLayers []inspected
		for _, entry := range matching {
			if entry.identity.layerCount != nil && *entry.identity.layerCount == *facts.TotalLayers {
				byLayers = append(byLayers, entry)
			}
		}
		if len(byLayers) == 1 {
			return byLayers[0].item, ""
		}
	}
	return retrievedArtifact{}, diagnosticArtifactAmbiguous
}

// stageRetrievedArtifact queues the chosen download for upload. Bytes the run
// already has a transfer for are not queued again: the retrieval is simply
// settled, which keeps a repeated discovery or a re-fetch from creating a
// second transfer, attachment or consumption booking.
func (a *bambuH2DAdapter) stageRetrievedArtifact(
	ctx context.Context,
	retrieval ArtifactRetrieval,
	chosen retrievedArtifact,
) (bool, error) {
	pending := string(machineConsumptionPending)
	exists, err := a.store.HasArtifactTransfer(ctx, retrieval.AssignmentID, retrieval.RunID, chosen.sha)
	if err != nil {
		return false, err
	}
	if !exists {
		reader, openErr := os.Open(chosen.path) //nolint:gosec // temporary file created by this process in the connector data directory
		if openErr != nil {
			return false, a.recordRetrievalFailure(ctx, retrieval, openErr)
		}
		_, stageErr := a.store.StageArtifact(
			ctx,
			retrieval.AssignmentID,
			retrieval.RunID,
			retrieval.ConfigurationVersion,
			chosen.candidate.RemotePath,
			chosen.candidate.Name,
			reader,
			retrieval.ExpiresAt,
		)
		closeErr := reader.Close()
		if stageErr != nil {
			return false, a.recordRetrievalFailure(ctx, retrieval, stageErr)
		}
		if closeErr != nil {
			return false, a.recordRetrievalFailure(ctx, retrieval, closeErr)
		}
	}
	if err = a.store.MarkArtifactRetrievalStaged(ctx, retrieval); err != nil {
		return false, err
	}
	return true, a.store.SetRunConsumptionReport(ctx, a.assignmentID, retrieval.RunID, "pending", &pending, nil)
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
// Core shows and says whether a print from internal storage explains it. It
// does when external storage held no archive at all; it does not when
// archives were there but none could be attributed to the print (ambiguous,
// another print's name, not a valid 3MF), because then the storage the print
// ran from is not the problem.
func artifactProblemReason(diagnostic string) (consumptionReason, bool) {
	switch diagnostic {
	case "", diagnosticArtifactNotAvailable, diagnosticArtifactNotArchive, diagnosticArtifactRetryExpired,
		diagnosticNoArchiveReported:
		return machineArtifactNotFound, true
	case diagnosticArtifactAmbiguous, diagnosticArtifactNameMismatch:
		return machineArtifactNotFound, false
	case diagnosticArtifactInvalid:
		return machineArtifactRejected, false
	}
	return machineArtifactRetrievalFailed, false
}

// artifactFailureFor is the consumption reason and detail for a run whose
// archive retrieval ended with the diagnostic.
func artifactFailureFor(
	ctx context.Context,
	store *Store,
	assignmentID, runID uuid.UUID,
	kind AdapterKind,
	diagnostic string,
) (string, *string, error) {
	reason, internalExplains := artifactProblemReason(diagnostic)
	var detail *string
	if diagnostic != "" && reasonCodePattern.MatchString(diagnostic) {
		detail = &diagnostic
	}
	if !internalExplains {
		return string(reason), detail, nil
	}
	// A print from internal storage has no archive the connector can reach;
	// say that instead of blaming a missing file, and name the internal path.
	facts, internal, err := store.InternalStorageRunFacts(ctx, assignmentID, runID, kind)
	if err != nil {
		return "", nil, err
	}
	if internal {
		detail = nil
		if facts.InternalPath != "" {
			detail = &facts.InternalPath
		}
		return string(machineArtifactOnInternal), detail, nil
	}
	return string(reason), detail, nil
}

// reportArtifactProblem records why the run's archive is missing; state is
// pending while retries continue and unavailable once the connector gave up.
func (a *bambuH2DAdapter) reportArtifactProblem(ctx context.Context, runID uuid.UUID, state, diagnostic string) error {
	reason, detail, err := artifactFailureFor(ctx, a.store, a.assignmentID, runID, a.kind, diagnostic)
	if err != nil {
		return err
	}
	return a.store.SetRunConsumptionReport(ctx, a.assignmentID, runID, state, &reason, detail)
}
