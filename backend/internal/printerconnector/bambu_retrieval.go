package printerconnector

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
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

func (s *Store) ScheduleArtifactRetrieval(ctx context.Context, assignmentID, runID uuid.UUID, configurationVersion int64, reportedPath string, expiresAt time.Time) error {
	reportedPath = strings.TrimSpace(reportedPath)
	if assignmentID == uuid.Nil || runID == uuid.Nil || configurationVersion < 1 || reportedPath == "" || len(reportedPath) > 255 {
		return errors.New("invalid artifact retrieval")
	}
	var pending int64
	if err := s.db.QueryRowContext(ctx, `SELECT (SELECT count(*) FROM artifact_transfers)+(SELECT count(*) FROM artifact_retrievals WHERE state='pending')`).Scan(&pending); err != nil {
		return err
	}
	if pending >= maxArtifactTransfers {
		return errors.New("artifact transfer queue is full")
	}
	now := time.Now().UTC()
	if expiresAt.IsZero() {
		expiresAt = now.Add(24 * time.Hour)
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO artifact_retrievals(assignment_id,run_id,configuration_version,reported_path,next_attempt_at,expires_at,created_at,updated_at)
		VALUES(?,?,?,?,?,?,?,?)
		ON CONFLICT(assignment_id,run_id) DO UPDATE SET
			configuration_version=excluded.configuration_version,
			reported_path=CASE WHEN artifact_retrievals.state='pending' THEN excluded.reported_path ELSE artifact_retrievals.reported_path END,
			expires_at=CASE WHEN artifact_retrievals.state='pending' AND excluded.expires_at>artifact_retrievals.expires_at THEN excluded.expires_at ELSE artifact_retrievals.expires_at END,
			updated_at=excluded.updated_at`, assignmentID.String(), runID.String(), configurationVersion, reportedPath, now.Format(time.RFC3339Nano), expiresAt.UTC().Format(time.RFC3339Nano), now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano))
	return err
}

func (s *Store) PendingArtifactRetrieval(ctx context.Context, assignmentID uuid.UUID) (*ArtifactRetrieval, error) {
	row := s.db.QueryRowContext(ctx, `SELECT assignment_id,run_id,configuration_version,reported_path,candidate_path,candidate_size,attempt_count,expires_at
		FROM artifact_retrievals WHERE assignment_id=? AND state='pending' AND next_attempt_at<=? AND expires_at>? ORDER BY created_at LIMIT 1`, assignmentID.String(), time.Now().UTC().Format(time.RFC3339Nano), time.Now().UTC().Format(time.RFC3339Nano))
	var value ArtifactRetrieval
	var assignment, run, expires string
	var candidatePath sql.NullString
	var candidateSize sql.NullInt64
	if err := row.Scan(&assignment, &run, &value.ConfigurationVersion, &value.ReportedPath, &candidatePath, &candidateSize, &value.AttemptCount, &expires); errors.Is(err, sql.ErrNoRows) {
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

func (s *Store) ObserveArtifactCandidate(ctx context.Context, retrieval ArtifactRetrieval, candidate ArtifactCandidate) (bool, error) {
	stable := candidate.Size > 0 && retrieval.CandidatePath != nil && retrieval.CandidateSize != nil && *retrieval.CandidatePath == candidate.RemotePath && *retrieval.CandidateSize == candidate.Size
	next := time.Now().UTC()
	if !stable {
		next = next.Add(5 * time.Second)
	}
	_, err := s.db.ExecContext(ctx, `UPDATE artifact_retrievals SET candidate_path=?,candidate_size=?,next_attempt_at=?,updated_at=? WHERE assignment_id=? AND run_id=? AND state='pending'`, candidate.RemotePath, candidate.Size, next.Format(time.RFC3339Nano), time.Now().UTC().Format(time.RFC3339Nano), retrieval.AssignmentID.String(), retrieval.RunID.String())
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
	_, err := s.db.ExecContext(ctx, `UPDATE artifact_retrievals SET attempt_count=attempt_count+1,next_attempt_at=?,reason_code=?,updated_at=? WHERE assignment_id=? AND run_id=? AND state='pending'`, time.Now().UTC().Add(delay).Format(time.RFC3339Nano), reason, time.Now().UTC().Format(time.RFC3339Nano), retrieval.AssignmentID.String(), retrieval.RunID.String())
	return err
}

func (s *Store) MarkArtifactRetrievalStaged(ctx context.Context, retrieval ArtifactRetrieval) error {
	_, err := s.db.ExecContext(ctx, `UPDATE artifact_retrievals SET state='staged',reason_code=NULL,updated_at=? WHERE assignment_id=? AND run_id=? AND state='pending'`, time.Now().UTC().Format(time.RFC3339Nano), retrieval.AssignmentID.String(), retrieval.RunID.String())
	return err
}

func (s *Store) QuarantineExpiredArtifactRetrievals(ctx context.Context, assignmentID uuid.UUID) error {
	_, err := s.db.ExecContext(ctx, `UPDATE artifact_retrievals SET state='quarantined',reason_code='artifact_retry_expired',updated_at=? WHERE assignment_id=? AND state='pending' AND expires_at<=?`, time.Now().UTC().Format(time.RFC3339Nano), assignmentID.String(), time.Now().UTC().Format(time.RFC3339Nano))
	return err
}

func (a *bambuH2DAdapter) runArtifactRetrievals(ctx context.Context, errorsOut chan<- error) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		if err := a.processArtifactConsumptions(ctx); err != nil && !errors.Is(err, context.Canceled) {
			select {
			case errorsOut <- err:
			default:
			}
		}
		if err := a.retrieveOneArtifact(ctx); err != nil && !errors.Is(err, context.Canceled) {
			select {
			case errorsOut <- err:
			default:
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (a *bambuH2DAdapter) retrieveOneArtifact(ctx context.Context) error {
	if err := a.store.QuarantineExpiredArtifactRetrievals(ctx, a.assignmentID); err != nil {
		return err
	}
	retrieval, err := a.store.PendingArtifactRetrieval(ctx, a.assignmentID)
	if err != nil || retrieval == nil {
		return err
	}
	client, err := NewBambuFTPSClient(a.settings, a.secrets)
	if err != nil {
		return a.recordRetrievalFailure(ctx, *retrieval, err)
	}
	if err = client.Connect(ctx); err != nil {
		return a.recordRetrievalFailure(ctx, *retrieval, err)
	}
	defer client.Close()
	listings := make(map[string][]FTPEntry, 2)
	for _, directory := range []string{"/cache", "/"} {
		listings[directory], err = client.List(ctx, directory)
		if err != nil {
			return a.recordRetrievalFailure(ctx, *retrieval, err)
		}
	}
	candidate, err := SelectArtifactCandidate(retrieval.ReportedPath, listings)
	if err != nil {
		return a.recordRetrievalFailure(ctx, *retrieval, err)
	}
	stable, err := a.store.ObserveArtifactCandidate(ctx, *retrieval, candidate)
	if err != nil || !stable {
		return err
	}
	directory := filepath.Join(a.store.dataDir, "artifacts")
	if err = os.MkdirAll(directory, 0o700); err != nil {
		return a.recordRetrievalFailure(ctx, *retrieval, err)
	}
	temporary, err := os.CreateTemp(directory, ".retrieval-*.3mf")
	if err != nil {
		return a.recordRetrievalFailure(ctx, *retrieval, err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err = temporary.Chmod(0o600); err == nil {
		err = client.Retrieve(ctx, candidate.RemotePath, temporary)
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return a.recordRetrievalFailure(ctx, *retrieval, err)
	}
	info, err := os.Stat(temporaryPath)
	if err != nil || info.Size() != candidate.Size {
		if err == nil {
			err = fmt.Errorf("retrieved artifact size changed from %d to %d", candidate.Size, info.Size())
		}
		return a.recordRetrievalFailure(ctx, *retrieval, err)
	}
	reader, err := os.Open(temporaryPath)
	if err != nil {
		return a.recordRetrievalFailure(ctx, *retrieval, err)
	}
	_, stageErr := a.store.StageArtifact(ctx, retrieval.AssignmentID, retrieval.RunID, retrieval.ConfigurationVersion, candidate.RemotePath, candidate.Name, reader, retrieval.ExpiresAt)
	closeErr := reader.Close()
	if stageErr != nil {
		return a.recordRetrievalFailure(ctx, *retrieval, stageErr)
	}
	if closeErr != nil {
		return a.recordRetrievalFailure(ctx, *retrieval, closeErr)
	}
	return a.store.MarkArtifactRetrievalStaged(ctx, *retrieval)
}

func (a *bambuH2DAdapter) recordRetrievalFailure(ctx context.Context, retrieval ArtifactRetrieval, err error) error {
	if queueErr := a.store.MarkArtifactRetrievalFailure(ctx, retrieval, classifyAdapterError(err)); queueErr != nil {
		return queueErr
	}
	return err
}
