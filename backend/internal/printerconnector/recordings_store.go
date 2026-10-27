package printerconnector

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"time"

	"github.com/google/uuid"
)

// Run reports, run commands and timelapse retrievals: what a connector tells
// Core about a recorded run besides events, kept durably until Core has it.

// RunReportSection is one section of a run report.
type RunReportSection struct {
	State  string  `json:"state"`
	Reason *string `json:"reason"`
	Detail *string `json:"detail"`
}

// PendingRunReport is a run report Core has not received in its latest revision.
type PendingRunReport struct {
	AssignmentID, RunID    uuid.UUID
	Revision               int64
	ObservedAt             time.Time
	Consumption, Timelapse *RunReportSection
}

// Local command states. accepted: stored but not started; the others mirror Core.
const (
	commandAccepted  = "accepted"
	commandRunning   = "running"
	commandSucceeded = "succeeded"
	commandFailed    = "failed"
)

// RunCommand is a command from Core as the connector tracks it.
type RunCommand struct {
	ID, AssignmentID, RunID uuid.UUID
	Kind                    string
	State                   string
	ReasonCode              *string
	AcceptedAt              time.Time
}

// Timelapse retrieval states.
const (
	timelapseBaseline = "baseline" // the directory listing at print start is still missing
	timelapseWaiting  = "waiting"  // baseline taken, the print has not ended
	timelapseSearch   = "search"   // the print ended; looking for the new video
	timelapseStaged   = "staged"   // retrieved, waiting for upload
	timelapseDone     = "done"
	timelapseGaveUp   = "gave_up"
)

func (s *Store) migrateRecordings(ctx context.Context) error {
	for _, statement := range []string{
		`CREATE TABLE IF NOT EXISTS run_reports (
			assignment_id TEXT NOT NULL, run_id TEXT NOT NULL,
			consumption_state TEXT, consumption_reason TEXT, consumption_detail TEXT,
			timelapse_state TEXT, timelapse_reason TEXT, timelapse_detail TEXT,
			observed_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, delivered_revision INTEGER NOT NULL DEFAULT 0,
			next_attempt_at TEXT NOT NULL, PRIMARY KEY(assignment_id, run_id)
		) STRICT`,
		`CREATE INDEX IF NOT EXISTS run_reports_pending_idx ON run_reports(delivered_revision, revision, next_attempt_at)`,
		`CREATE TABLE IF NOT EXISTS run_commands (
			id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL, run_id TEXT NOT NULL, kind TEXT NOT NULL,
			state TEXT NOT NULL CHECK(state IN ('accepted','running','succeeded','failed')),
			reason_code TEXT, reported_state TEXT, accepted_at TEXT NOT NULL, updated_at TEXT NOT NULL
		) STRICT`,
		`CREATE TABLE IF NOT EXISTS consumption_revisions (
			assignment_id TEXT NOT NULL, run_id TEXT NOT NULL, last_revision INTEGER NOT NULL CHECK(last_revision > 0),
			PRIMARY KEY(assignment_id, run_id)
		) STRICT`,
		`CREATE TABLE IF NOT EXISTS timelapse_retrievals (
			assignment_id TEXT NOT NULL, run_id TEXT NOT NULL, configuration_version INTEGER NOT NULL CHECK(configuration_version > 0),
			state TEXT NOT NULL, baseline TEXT, candidate_name TEXT, candidate_size INTEGER,
			staged_path TEXT, size_bytes INTEGER, sha256 TEXT, attempt_count INTEGER NOT NULL DEFAULT 0,
			next_attempt_at TEXT NOT NULL, ended_at TEXT, deadline_at TEXT, reason_code TEXT, detail TEXT,
			created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(assignment_id, run_id)
		) STRICT`,
	} {
		if _, err := s.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("initialize connector recording state: %w", err)
		}
	}
	return nil
}

func nowText() string { return time.Now().UTC().Format(time.RFC3339Nano) }

// SetRunConsumptionReport records why a run has (no) consumption. An unchanged
// report is not sent again.
func (s *Store) SetRunConsumptionReport(
	ctx context.Context,
	assignmentID, runID uuid.UUID,
	state string,
	reason, detail *string,
) error {
	return s.setRunReport(ctx, assignmentID, runID, "consumption", state, reason, detail)
}

// SetRunTimelapseReport records the state of a run's timelapse retrieval.
func (s *Store) SetRunTimelapseReport(
	ctx context.Context,
	assignmentID, runID uuid.UUID,
	state string,
	reason, detail *string,
) error {
	return s.setRunReport(ctx, assignmentID, runID, "timelapse", state, reason, detail)
}

func (s *Store) setRunReport(
	ctx context.Context,
	assignmentID, runID uuid.UUID,
	section, state string,
	reason, detail *string,
) error {
	if assignmentID == uuid.Nil || runID == uuid.Nil || state == "" {
		return errors.New("invalid run report")
	}
	now := nowText()
	// The column names come from the two fixed section names above.
	statement := fmt.Sprintf( //nolint:gosec // section is "consumption" or "timelapse", never input
		`INSERT INTO run_reports(assignment_id,run_id,%[1]s_state,%[1]s_reason,%[1]s_detail,observed_at,next_attempt_at)
		VALUES(?,?,?,?,?,?,?)
		ON CONFLICT(assignment_id,run_id) DO UPDATE SET
			%[1]s_state=excluded.%[1]s_state,%[1]s_reason=excluded.%[1]s_reason,%[1]s_detail=excluded.%[1]s_detail,
			observed_at=excluded.observed_at,revision=revision+1,next_attempt_at=excluded.next_attempt_at
		WHERE run_reports.%[1]s_state IS NOT excluded.%[1]s_state OR run_reports.%[1]s_reason IS NOT excluded.%[1]s_reason
			OR run_reports.%[1]s_detail IS NOT excluded.%[1]s_detail`,
		section,
	)
	_, err := s.db.ExecContext(ctx, statement, assignmentID.String(), runID.String(), state, reason, detail, now, now)
	return err
}

// PendingRunReports returns reports whose latest revision Core has not acknowledged.
func (s *Store) PendingRunReports(ctx context.Context, limit int) ([]PendingRunReport, error) {
	rows, err := s.db.QueryContext(
		ctx,
		`SELECT assignment_id,run_id,revision,observed_at,consumption_state,consumption_reason,consumption_detail,
			timelapse_state,timelapse_reason,timelapse_detail
		FROM run_reports WHERE delivered_revision<revision AND next_attempt_at<=? ORDER BY observed_at LIMIT ?`,
		nowText(),
		limit,
	)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var result []PendingRunReport
	for rows.Next() {
		var assignment, run, observed string
		var cState, cReason, cDetail, tState, tReason, tDetail sql.NullString
		var item PendingRunReport
		if err = rows.Scan(&assignment, &run, &item.Revision, &observed, &cState, &cReason, &cDetail, &tState, &tReason, &tDetail); err != nil {
			return nil, err
		}
		if item.AssignmentID, err = uuid.Parse(assignment); err != nil {
			return nil, err
		}
		if item.RunID, err = uuid.Parse(run); err != nil {
			return nil, err
		}
		if item.ObservedAt, err = time.Parse(time.RFC3339Nano, observed); err != nil {
			return nil, err
		}
		item.Consumption = reportSection(cState, cReason, cDetail)
		item.Timelapse = reportSection(tState, tReason, tDetail)
		result = append(result, item)
	}
	return result, rows.Err()
}

func reportSection(state, reason, detail sql.NullString) *RunReportSection {
	if !state.Valid {
		return nil
	}
	section := &RunReportSection{State: state.String}
	if reason.Valid {
		section.Reason = &reason.String
	}
	if detail.Valid {
		section.Detail = &detail.String
	}
	return section
}

// MarkRunReportDelivered records that Core holds this revision (or will never take it).
func (s *Store) MarkRunReportDelivered(ctx context.Context, report PendingRunReport) error {
	_, err := s.db.ExecContext(
		ctx,
		`UPDATE run_reports SET delivered_revision=? WHERE assignment_id=? AND run_id=? AND delivered_revision<?`,
		report.Revision,
		report.AssignmentID.String(),
		report.RunID.String(),
		report.Revision,
	)
	return err
}

// DeferRunReport retries a failed delivery later.
func (s *Store) DeferRunReport(ctx context.Context, report PendingRunReport) error {
	_, err := s.db.ExecContext(
		ctx,
		`UPDATE run_reports SET next_attempt_at=? WHERE assignment_id=? AND run_id=?`,
		time.Now().UTC().Add(30*time.Second).Format(time.RFC3339Nano),
		report.AssignmentID.String(),
		report.RunID.String(),
	)
	return err
}

// AcceptRunCommand stores a command from Core once; a known command is ignored.
func (s *Store) AcceptRunCommand(ctx context.Context, command RunCommand) error {
	now := nowText()
	_, err := s.db.ExecContext(
		ctx,
		`INSERT INTO run_commands(id,assignment_id,run_id,kind,state,accepted_at,updated_at) VALUES(?,?,?,?,?,?,?)
		ON CONFLICT(id) DO NOTHING`,
		command.ID.String(),
		command.AssignmentID.String(),
		command.RunID.String(),
		command.Kind,
		commandAccepted,
		now,
		now,
	)
	return err
}

const runCommandColumns = `SELECT id,assignment_id,run_id,kind,state,reason_code,accepted_at FROM run_commands `

// RunCommandsInState lists local commands in one state.
func (s *Store) RunCommandsInState(ctx context.Context, state string) ([]RunCommand, error) {
	return s.queryRunCommands(ctx, runCommandColumns+`WHERE state=? ORDER BY accepted_at LIMIT 50`, state)
}

// UnreportedRunCommands lists commands whose state Core does not know yet.
func (s *Store) UnreportedRunCommands(ctx context.Context) ([]RunCommand, error) {
	return s.queryRunCommands(
		ctx,
		runCommandColumns+`WHERE state<>'accepted' AND reported_state IS NOT state ORDER BY accepted_at LIMIT 50`,
	)
}

func (s *Store) queryRunCommands(ctx context.Context, query string, args ...any) ([]RunCommand, error) {
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var result []RunCommand
	for rows.Next() {
		var id, assignment, run, accepted string
		var reason sql.NullString
		var item RunCommand
		if err = rows.Scan(&id, &assignment, &run, &item.Kind, &item.State, &reason, &accepted); err != nil {
			return nil, err
		}
		if item.ID, err = uuid.Parse(id); err != nil {
			return nil, err
		}
		if item.AssignmentID, err = uuid.Parse(assignment); err != nil {
			return nil, err
		}
		if item.RunID, err = uuid.Parse(run); err != nil {
			return nil, err
		}
		if item.AcceptedAt, err = time.Parse(time.RFC3339Nano, accepted); err != nil {
			return nil, err
		}
		if reason.Valid {
			item.ReasonCode = &reason.String
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

// SetRunCommandState moves a local command on; reason applies to failures.
func (s *Store) SetRunCommandState(ctx context.Context, id uuid.UUID, state string, reason *string) error {
	if state != commandFailed {
		reason = nil
	}
	_, err := s.db.ExecContext(
		ctx,
		`UPDATE run_commands SET state=?,reason_code=?,updated_at=? WHERE id=? AND state NOT IN ('succeeded','failed')`,
		state,
		reason,
		nowText(),
		id.String(),
	)
	return err
}

// MarkRunCommandReported records the state Core acknowledged. Finished commands
// that Core knows are kept for a day so a repeated poll does not run them again.
func (s *Store) MarkRunCommandReported(ctx context.Context, id uuid.UUID, state string) error {
	if _, err := s.db.ExecContext(
		ctx,
		`UPDATE run_commands SET reported_state=? WHERE id=?`,
		state,
		id.String(),
	); err != nil {
		return err
	}
	_, err := s.db.ExecContext(
		ctx,
		`DELETE FROM run_commands WHERE state IN ('succeeded','failed') AND reported_state=state AND updated_at<?`,
		time.Now().UTC().Add(-24*time.Hour).Format(time.RFC3339Nano),
	)
	return err
}

// RequeueArtifactRetrieval makes a run's archive retrieval pending again for a
// manual re-fetch. It fails when the printer never reported an archive path.
func (s *Store) RequeueArtifactRetrieval(ctx context.Context, assignmentID, runID uuid.UUID, expiresAt time.Time) error {
	result, err := s.db.ExecContext(
		ctx,
		`UPDATE artifact_retrievals SET state='pending',attempt_count=0,candidate_path=NULL,candidate_size=NULL,
			reason_code=NULL,next_attempt_at=?,expires_at=?,updated_at=? WHERE assignment_id=? AND run_id=?`,
		nowText(),
		expiresAt.UTC().Format(time.RFC3339Nano),
		nowText(),
		assignmentID.String(),
		runID.String(),
	)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return errArtifactPathUnknown
	}
	return nil
}

var errArtifactPathUnknown = errors.New("the printer never reported an archive for this run")

// ArtifactRetrievalState returns the retrieval state and last reason of a run's archive.
func (s *Store) ArtifactRetrievalState(ctx context.Context, assignmentID, runID uuid.UUID) (string, *string, bool, error) {
	var state string
	var reason sql.NullString
	err := s.db.QueryRowContext(
		ctx,
		`SELECT state,reason_code FROM artifact_retrievals WHERE assignment_id=? AND run_id=?`,
		assignmentID.String(),
		runID.String(),
	).Scan(&state, &reason)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil, false, nil
	}
	if err != nil {
		return "", nil, false, err
	}
	if reason.Valid {
		return state, &reason.String, true, nil
	}
	return state, nil, true, nil
}

// RunArtifactUploadSettled is true when no staged archive of the run still waits for Core.
func (s *Store) RunArtifactUploadSettled(ctx context.Context, assignmentID, runID uuid.UUID) (bool, error) {
	var waiting int64
	err := s.db.QueryRowContext(
		ctx,
		`SELECT count(*) FROM artifact_transfers t WHERE t.assignment_id=? AND t.run_id=? AND t.state='pending'
			AND NOT EXISTS (SELECT 1 FROM artifact_upload_receipts r WHERE r.transfer_id=t.id)`,
		assignmentID.String(),
		runID.String(),
	).Scan(&waiting)
	return waiting == 0, err
}

// ConsumptionReportedSince is true when a consumption report for the run was
// queued at or after since.
func (s *Store) ConsumptionReportedSince(ctx context.Context, assignmentID, runID uuid.UUID, since time.Time) (bool, error) {
	rows, err := s.db.QueryContext(
		ctx,
		`SELECT created_at FROM artifact_consumption_reports WHERE assignment_id=? AND run_id=?`,
		assignmentID.String(),
		runID.String(),
	)
	if err != nil {
		return false, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var created string
		if err = rows.Scan(&created); err != nil {
			return false, err
		}
		// Timestamps are compared as times: RFC 3339 strings with trimmed fractions do not sort.
		if value, parseErr := time.Parse(time.RFC3339Nano, created); parseErr == nil && !value.Before(since) {
			return true, nil
		}
	}
	return false, rows.Err()
}

// PrepareConsumptionRecompute forgets the run's earlier calculations so its
// staged archive is calculated again, with the next report revision.
func (s *Store) PrepareConsumptionRecompute(ctx context.Context, assignmentID, runID uuid.UUID) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var last sql.NullInt64
	if err = tx.QueryRowContext(
		ctx,
		`SELECT max(report_revision) FROM artifact_consumption_reports WHERE assignment_id=? AND run_id=?`,
		assignmentID.String(),
		runID.String(),
	).Scan(&last); err != nil {
		return err
	}
	if last.Valid && last.Int64 > 0 {
		if _, err = tx.ExecContext(
			ctx,
			`INSERT INTO consumption_revisions(assignment_id,run_id,last_revision) VALUES(?,?,?)
			ON CONFLICT(assignment_id,run_id) DO UPDATE SET last_revision=max(last_revision,excluded.last_revision)`,
			assignmentID.String(),
			runID.String(),
			last.Int64,
		); err != nil {
			return err
		}
	}
	if _, err = tx.ExecContext(
		ctx,
		`DELETE FROM artifact_consumption_reports WHERE assignment_id=? AND run_id=?`,
		assignmentID.String(),
		runID.String(),
	); err != nil {
		return err
	}
	return tx.Commit()
}

// StagedArtifactForRun returns a still staged archive of the run, if any.
func (s *Store) StagedArtifactForRun(ctx context.Context, assignmentID, runID uuid.UUID) (*ArtifactTransfer, error) {
	rows, err := s.db.QueryContext(
		ctx,
		`SELECT id,assignment_id,run_id,configuration_version,remote_path,file_name,staged_path,size_bytes,sha256,attempt_count,expires_at
		FROM artifact_transfers WHERE assignment_id=? AND run_id=? AND state='pending' ORDER BY created_at DESC LIMIT 1`,
		assignmentID.String(),
		runID.String(),
	)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	transfers, err := scanArtifactTransfers(rows)
	if err != nil || len(transfers) == 0 {
		return nil, err
	}
	return &transfers[0], nil
}

// nextConsumptionRevision returns the report revision for the run's next calculation.
func nextConsumptionRevision(ctx context.Context, tx *sql.Tx, assignmentID, runID uuid.UUID) (int64, error) {
	var last int64
	err := tx.QueryRowContext(
		ctx,
		`SELECT last_revision FROM consumption_revisions WHERE assignment_id=? AND run_id=?`,
		assignmentID.String(),
		runID.String(),
	).Scan(&last)
	if errors.Is(err, sql.ErrNoRows) {
		return bambuConsumptionRevision, nil
	}
	if err != nil {
		return 0, err
	}
	return last + 1, nil
}

// MarkArtifactAcknowledged records that Core already holds a staged archive (it
// was downloaded from Core), so it is never uploaded again.
func (s *Store) MarkArtifactAcknowledged(ctx context.Context, transferID uuid.UUID) error {
	_, err := s.db.ExecContext(
		ctx,
		`INSERT INTO artifact_upload_receipts(transfer_id,acknowledged_at) VALUES(?,?) ON CONFLICT(transfer_id) DO NOTHING`,
		transferID.String(),
		nowText(),
	)
	return err
}

var reasonCodePattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,79}$`)

// expiredRetrieval is an archive retrieval the connector gave up on.
type expiredRetrieval struct {
	RunID      uuid.UUID
	LastReason string
}

// ExpireArtifactRetrievals quarantines the assignment's retrievals whose retry
// window ended and returns them with their last failure diagnostic.
func (s *Store) ExpireArtifactRetrievals(ctx context.Context, assignmentID uuid.UUID) ([]expiredRetrieval, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	now := nowText()
	rows, err := tx.QueryContext(
		ctx,
		`SELECT run_id,coalesce(reason_code,'') FROM artifact_retrievals WHERE assignment_id=? AND state='pending' AND expires_at<=?`,
		assignmentID.String(),
		now,
	)
	if err != nil {
		return nil, err
	}
	var result []expiredRetrieval
	for rows.Next() {
		var run, reason string
		if err = rows.Scan(&run, &reason); err != nil {
			_ = rows.Close()
			return nil, err
		}
		id, parseErr := uuid.Parse(run)
		if parseErr != nil {
			_ = rows.Close()
			return nil, parseErr
		}
		result = append(result, expiredRetrieval{RunID: id, LastReason: reason})
	}
	if err = rows.Close(); err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(
		ctx,
		`UPDATE artifact_retrievals SET state='quarantined',reason_code='artifact_retry_expired',updated_at=? WHERE assignment_id=? AND state='pending' AND expires_at<=?`,
		now,
		assignmentID.String(),
		now,
	); err != nil {
		return nil, err
	}
	return result, tx.Commit()
}

// expiredTransfer is a staged archive whose upload window ended.
type expiredTransfer struct {
	AssignmentID, RunID uuid.UUID
	LastReason          string
}

// ExpireArtifactTransfers quarantines staged archives that were not uploaded in
// time and returns them.
func (s *Store) ExpireArtifactTransfers(ctx context.Context) ([]expiredTransfer, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	now := nowText()
	condition := `state='pending' AND expires_at<=? AND NOT EXISTS (SELECT 1 FROM artifact_upload_receipts r WHERE r.transfer_id=artifact_transfers.id)`
	rows, err := tx.QueryContext(ctx, `SELECT assignment_id,run_id,coalesce(reason_code,'') FROM artifact_transfers WHERE `+condition, now)
	if err != nil {
		return nil, err
	}
	var result []expiredTransfer
	for rows.Next() {
		var assignment, run, reason string
		if err = rows.Scan(&assignment, &run, &reason); err != nil {
			_ = rows.Close()
			return nil, err
		}
		item := expiredTransfer{LastReason: reason}
		if item.AssignmentID, err = uuid.Parse(assignment); err == nil {
			item.RunID, err = uuid.Parse(run)
		}
		if err != nil {
			_ = rows.Close()
			return nil, err
		}
		result = append(result, item)
	}
	if err = rows.Close(); err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(
		ctx,
		`UPDATE artifact_transfers SET state='quarantined',reason_code='artifact_retry_expired' WHERE `+condition,
		now,
	); err != nil {
		return nil, err
	}
	return result, tx.Commit()
}

// PruneRunReports drops reports older than 30 days, delivered or not, so a Core
// without recording support cannot make the table grow forever.
func (s *Store) PruneRunReports(ctx context.Context) error {
	_, err := s.db.ExecContext(
		ctx,
		`DELETE FROM run_reports WHERE observed_at<?`,
		time.Now().UTC().Add(-30*24*time.Hour).Format(time.RFC3339Nano),
	)
	return err
}
