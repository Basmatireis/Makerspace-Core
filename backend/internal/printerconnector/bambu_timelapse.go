package printerconnector

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/textproto"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
)

// Timelapse retrieval. Bambu printers write a print's timelapse video below
// /timelapse on their storage when the timelapse option was enabled for the
// print. The file name carries a local printer time without a time zone, so
// it is never used for matching. Instead the connector lists /timelapse when it
// first sees the print active (the baseline) and, after the print ended,
// accepts exactly one .mp4 file that is new since the baseline or grew since
// then and that no other run of the assignment claimed. Zero candidates are
// retried until timelapseSearchWindow after the end; two or more candidates, a
// missing baseline or an oversized file give up for good. The file is retrieved
// only after two listings at least timelapseStableAfter apart report the same
// size.
const (
	bambuTimelapseDirectory = "/timelapse"
	timelapseSearchWindow   = 15 * time.Minute
	timelapseStableAfter    = 15 * time.Second
	timelapseRetryDelay     = 20 * time.Second
	maxTimelapseAttempts    = 20
)

var timelapseNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.(?i:mp4)$`)

var (
	errTimelapseNotFound  = errors.New("no new timelapse video")
	errTimelapseAmbiguous = errors.New("several new timelapse videos")
)

// Timelapse reasons reported to Core.
const (
	reasonTimelapseNotRecorded           = "timelapse_not_recorded"
	reasonTimelapseAmbiguous             = "timelapse_ambiguous"
	reasonTimelapseBaselineMissing       = "timelapse_baseline_missing"
	reasonTimelapseTooLarge              = "timelapse_too_large"
	reasonTimelapseRetrievalFailed       = "timelapse_retrieval_failed"
	reasonTimelapseUploadFailed          = "timelapse_upload_failed"
	reasonTimelapseDisabled              = "timelapse_disabled"
	timelapseReportPending               = "pending"
	timelapseReportUploaded              = "uploaded"
	timelapseReportNotFound              = "not_found"
	timelapseReportFailed                = "failed"
	timelapseReportSkipped               = "skipped"
	timelapseStagingDirectory            = "timelapses"
	defaultTimelapseMaxBytes       int64 = 2 << 30
)

// TimelapseMatch is the video selected for a run.
type TimelapseMatch struct {
	Name string
	Size int64
}

// SelectTimelapseCandidate applies the matching rule to a /timelapse listing:
// exactly one plain .mp4 file that is absent from the baseline or larger than
// in it, and not claimed by another run.
func SelectTimelapseCandidate(
	baseline map[string]int64,
	listing []FTPEntry,
	claimed map[string]bool,
) (TimelapseMatch, error) {
	var matches []TimelapseMatch
	for _, entry := range listing {
		if entry.IsDir || entry.Size <= 0 || !timelapseNamePattern.MatchString(entry.Name) || claimed[entry.Name] {
			continue
		}
		if before, known := baseline[entry.Name]; known && entry.Size <= before {
			continue
		}
		matches = append(matches, TimelapseMatch{Name: entry.Name, Size: entry.Size})
	}
	switch len(matches) {
	case 0:
		return TimelapseMatch{}, errTimelapseNotFound
	case 1:
		return matches[0], nil
	default:
		return TimelapseMatch{}, errTimelapseAmbiguous
	}
}

// timelapseFTPS is the part of the FTPS client timelapse retrieval needs.
type timelapseFTPS interface {
	List(context.Context, string) ([]FTPEntry, error)
	RetrieveLimited(context.Context, string, io.Writer, int64) error
	Close() error
}

// recordingFeatureSource gives adapters Core's current recording features.
type recordingFeatureSource interface {
	RecordingFeatures() *RecordingFeatures
}

func (a *bambuH2DAdapter) recordingFeatures() *RecordingFeatures {
	if a.features == nil {
		return nil
	}
	return a.features.RecordingFeatures()
}

func (a *bambuH2DAdapter) openTimelapseFTPS(ctx context.Context) (timelapseFTPS, error) {
	if a.newTimelapseFTPS != nil {
		return a.newTimelapseFTPS(ctx)
	}
	client, err := NewBambuFTPSClient(a.settings, a.secrets)
	if err != nil {
		return nil, err
	}
	if err = client.Connect(ctx); err != nil {
		return nil, err
	}
	return client, nil
}

// noteRunsForRecordings starts timelapse baselines for runs that became active
// and settles artifact and timelapse reports for runs that ended.
func (a *bambuH2DAdapter) noteRunsForRecordings(ctx context.Context, observations []Observation) error {
	for _, observation := range observations {
		if observation.RunID == nil {
			continue
		}
		switch observation.Kind {
		case ObservationOperationalState, ObservationProgress:
			if features := a.recordingFeatures(); features != nil && features.TimelapseEnabled {
				if err := a.store.StartTimelapseBaseline(ctx, a.assignmentID, *observation.RunID, a.configurationVersion); err != nil {
					return err
				}
			}
		case ObservationTerminalOutcome:
			if err := a.noteRunEnded(ctx, *observation.RunID); err != nil {
				return err
			}
		}
	}
	return nil
}

func (a *bambuH2DAdapter) noteRunEnded(ctx context.Context, runID uuid.UUID) error {
	_, _, scheduled, err := a.store.ArtifactRetrievalState(ctx, a.assignmentID, runID)
	if err != nil {
		return err
	}
	if facts, internal, factsErr := a.store.InternalStorageRunFacts(ctx, a.assignmentID, runID, a.kind); factsErr != nil {
		return factsErr
	} else if internal && !scheduled && isBambuArchivePath(facts.ArchiveCandidate) {
		// Conservative fallback: the file might exist on external storage after all.
		// Looked up once; a successful listing without it settles the report.
		expiresAt := time.Now().UTC().Add(24 * time.Hour)
		if err = a.store.ScheduleArtifactRetrieval(
			ctx, a.assignmentID, runID, a.configurationVersion, facts.ArchiveCandidate, expiresAt,
		); err != nil {
			return err
		}
		if err = a.store.ExtendArtifactTransferExpiry(ctx, a.assignmentID, runID, expiresAt); err != nil {
			return err
		}
		scheduled = true
	}
	if !scheduled {
		// The printer never named an archive for this print (for example a plain G-code print).
		if err = a.reportArtifactProblem(ctx, runID, "unavailable", "no_archive_reported"); err != nil {
			return err
		}
	}
	features := a.recordingFeatures()
	if features == nil {
		return nil
	}
	if !features.TimelapseEnabled {
		reason := reasonTimelapseDisabled
		return a.store.SetRunTimelapseReport(ctx, a.assignmentID, runID, timelapseReportSkipped, &reason, nil)
	}
	state, reason, err := a.store.MarkTimelapseRunEnded(ctx, a.assignmentID, runID, a.configurationVersion, time.Now().UTC())
	if err != nil {
		return err
	}
	if state == timelapseGaveUp {
		return a.store.SetRunTimelapseReport(ctx, a.assignmentID, runID, timelapseReportNotFound, &reason, nil)
	}
	return a.store.SetRunTimelapseReport(ctx, a.assignmentID, runID, timelapseReportPending, nil, nil)
}

// processTimelapses takes due baselines and searches for ended runs. Failures
// are recorded per run and never degrade the assignment.
func (a *bambuH2DAdapter) processTimelapses(ctx context.Context) error {
	features := a.recordingFeatures()
	if features == nil || !features.TimelapseEnabled {
		return nil
	}
	due, err := a.store.DueTimelapseRetrievals(ctx, a.assignmentID)
	if err != nil || len(due) == 0 {
		return err
	}
	client, err := a.openTimelapseFTPS(ctx)
	if err != nil {
		for _, item := range due {
			if deferErr := a.deferTimelapse(ctx, item, err); deferErr != nil {
				return deferErr
			}
		}
		return nil
	}
	defer func() { _ = client.Close() }()
	listing, listErr := client.List(ctx, bambuTimelapseDirectory)
	var protocolErr *textproto.Error
	if errors.As(listErr, &protocolErr) && protocolErr.Code == 550 {
		// No /timelapse directory yet: nothing has been recorded so far.
		listing, listErr = []FTPEntry{}, nil
	}
	for _, item := range due {
		if listErr != nil {
			if err = a.deferTimelapse(ctx, item, listErr); err != nil {
				return err
			}
			continue
		}
		if item.State == timelapseBaseline {
			if err = a.store.RecordTimelapseBaseline(ctx, item, listing); err != nil {
				return err
			}
			continue
		}
		if err = a.searchTimelapse(ctx, client, item, listing, maxTimelapseBytes(features)); err != nil {
			return err
		}
	}
	return nil
}

func maxTimelapseBytes(features *RecordingFeatures) int64 {
	if features.TimelapseMaxBytes > 0 {
		return features.TimelapseMaxBytes
	}
	return defaultTimelapseMaxBytes
}

func (a *bambuH2DAdapter) searchTimelapse(
	ctx context.Context,
	client timelapseFTPS,
	item timelapseRetrieval,
	listing []FTPEntry,
	maxBytes int64,
) error {
	claimed, err := a.store.ClaimedTimelapseNames(ctx, a.assignmentID, item.RunID)
	if err != nil {
		return err
	}
	match, err := SelectTimelapseCandidate(item.Baseline, listing, claimed)
	switch {
	case errors.Is(err, errTimelapseAmbiguous):
		return a.giveUpTimelapse(ctx, item, timelapseReportNotFound, reasonTimelapseAmbiguous, nil)
	case errors.Is(err, errTimelapseNotFound):
		if item.Deadline != nil && time.Now().UTC().After(*item.Deadline) {
			return a.giveUpTimelapse(ctx, item, timelapseReportNotFound, reasonTimelapseNotRecorded, nil)
		}
		return a.store.RetryTimelapseLater(ctx, item, timelapseRetryDelay, nil)
	case err != nil:
		return err
	}
	if match.Size > maxBytes {
		return a.giveUpTimelapse(ctx, item, timelapseReportFailed, reasonTimelapseTooLarge, nil)
	}
	stable, err := a.store.ObserveTimelapseCandidate(ctx, item, match)
	if err != nil || !stable {
		return err
	}
	staged, err := a.stageTimelapse(ctx, client, item, match, maxBytes)
	if err != nil {
		return a.deferTimelapse(ctx, item, err)
	}
	return a.store.MarkTimelapseStaged(ctx, item, match.Name, staged)
}

type stagedTimelapse struct {
	Path   string
	Size   int64
	SHA256 string
}

func (a *bambuH2DAdapter) stageTimelapse(
	ctx context.Context,
	client timelapseFTPS,
	item timelapseRetrieval,
	match TimelapseMatch,
	maxBytes int64,
) (stagedTimelapse, error) {
	directory := filepath.Join(a.store.dataDir, timelapseStagingDirectory)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return stagedTimelapse{}, err
	}
	target := filepath.Join(directory, ids.New().String()+".mp4")
	//nolint:gosec // path is built from a generated UUID inside the connector data directory
	file, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return stagedTimelapse{}, err
	}
	keep := false
	defer func() {
		_ = file.Close()
		if !keep {
			_ = os.Remove(target)
		}
	}()
	hash := sha256.New()
	counter := &countingWriter{}
	if err = client.RetrieveLimited(ctx, path.Join(bambuTimelapseDirectory, match.Name), io.MultiWriter(file, hash, counter), maxBytes+1); err != nil {
		return stagedTimelapse{}, err
	}
	if counter.n != match.Size {
		return stagedTimelapse{}, fmt.Errorf("retrieved timelapse size changed from %d to %d", match.Size, counter.n)
	}
	if err = file.Sync(); err != nil {
		return stagedTimelapse{}, err
	}
	keep = true
	_ = item
	return stagedTimelapse{Path: target, Size: counter.n, SHA256: hex.EncodeToString(hash.Sum(nil))}, nil
}

type countingWriter struct{ n int64 }

func (w *countingWriter) Write(p []byte) (int, error) {
	w.n += int64(len(p))
	return len(p), nil
}

func (a *bambuH2DAdapter) deferTimelapse(ctx context.Context, item timelapseRetrieval, cause error) error {
	diagnostic := classifyAdapterError(cause)
	if item.State == timelapseBaseline {
		// Without a baseline taken while the print runs, matching would have to guess.
		return a.store.RetryTimelapseLater(ctx, item, timelapseRetryDelay, &diagnostic)
	}
	if item.AttemptCount+1 >= maxTimelapseAttempts {
		return a.giveUpTimelapse(ctx, item, timelapseReportFailed, reasonTimelapseRetrievalFailed, &diagnostic)
	}
	return a.store.RetryTimelapseLater(ctx, item, timelapseRetryDelay, &diagnostic)
}

func (a *bambuH2DAdapter) giveUpTimelapse(
	ctx context.Context,
	item timelapseRetrieval,
	reportState, reason string,
	detail *string,
) error {
	if err := a.store.GiveUpTimelapse(ctx, item, reason, detail); err != nil {
		return err
	}
	return a.store.SetRunTimelapseReport(ctx, item.AssignmentID, item.RunID, reportState, &reason, detail)
}

// timelapseRetrieval is one run's timelapse search.
type timelapseRetrieval struct {
	AssignmentID, RunID  uuid.UUID
	ConfigurationVersion int64
	State                string
	Baseline             map[string]int64
	CandidateName        *string
	CandidateSize        *int64
	AttemptCount         int
	Deadline             *time.Time
	UpdatedAt            time.Time
}

// StartTimelapseBaseline schedules the baseline listing of a run that became active.
func (s *Store) StartTimelapseBaseline(ctx context.Context, assignmentID, runID uuid.UUID, configurationVersion int64) error {
	now := nowText()
	_, err := s.db.ExecContext(
		ctx,
		`INSERT INTO timelapse_retrievals(assignment_id,run_id,configuration_version,state,next_attempt_at,created_at,updated_at)
		VALUES(?,?,?,?,?,?,?) ON CONFLICT(assignment_id,run_id) DO NOTHING`,
		assignmentID.String(),
		runID.String(),
		configurationVersion,
		timelapseBaseline,
		now,
		now,
		now,
	)
	return err
}

// MarkTimelapseRunEnded starts the search for an ended run. A run without a
// baseline gives up with timelapse_baseline_missing.
func (s *Store) MarkTimelapseRunEnded(
	ctx context.Context,
	assignmentID, runID uuid.UUID,
	configurationVersion int64,
	endedAt time.Time,
) (string, string, error) {
	now := nowText()
	deadline := endedAt.Add(timelapseSearchWindow).Format(time.RFC3339Nano)
	if _, err := s.db.ExecContext(
		ctx,
		`INSERT INTO timelapse_retrievals(assignment_id,run_id,configuration_version,state,reason_code,next_attempt_at,created_at,updated_at)
		VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(assignment_id,run_id) DO NOTHING`,
		assignmentID.String(), runID.String(), configurationVersion, timelapseGaveUp, reasonTimelapseBaselineMissing, now, now, now,
	); err != nil {
		return "", "", err
	}
	if _, err := s.db.ExecContext(
		ctx,
		`UPDATE timelapse_retrievals SET
			state=CASE WHEN state='waiting' THEN 'search' WHEN state='baseline' THEN 'gave_up' ELSE state END,
			reason_code=CASE WHEN state='baseline' THEN ? ELSE reason_code END,
			ended_at=coalesce(ended_at,?),deadline_at=coalesce(deadline_at,?),next_attempt_at=?,updated_at=?
		WHERE assignment_id=? AND run_id=?`,
		reasonTimelapseBaselineMissing, endedAt.UTC().Format(time.RFC3339Nano), deadline, now, now, assignmentID.String(), runID.String(),
	); err != nil {
		return "", "", err
	}
	var state string
	var reason sql.NullString
	err := s.db.QueryRowContext(
		ctx,
		`SELECT state,reason_code FROM timelapse_retrievals WHERE assignment_id=? AND run_id=?`,
		assignmentID.String(),
		runID.String(),
	).Scan(&state, &reason)
	return state, reason.String, err
}

// DueTimelapseRetrievals lists baselines and searches whose next attempt is due.
func (s *Store) DueTimelapseRetrievals(ctx context.Context, assignmentID uuid.UUID) ([]timelapseRetrieval, error) {
	rows, err := s.db.QueryContext(
		ctx,
		`SELECT run_id,configuration_version,state,baseline,candidate_name,candidate_size,attempt_count,deadline_at,updated_at
		FROM timelapse_retrievals WHERE assignment_id=? AND state IN ('baseline','search') AND next_attempt_at<=?
		ORDER BY created_at LIMIT 10`,
		assignmentID.String(),
		nowText(),
	)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var result []timelapseRetrieval
	for rows.Next() {
		var run, updated string
		var baseline, candidate, deadline sql.NullString
		var size sql.NullInt64
		item := timelapseRetrieval{AssignmentID: assignmentID}
		if err = rows.Scan(&run, &item.ConfigurationVersion, &item.State, &baseline, &candidate, &size, &item.AttemptCount, &deadline, &updated); err != nil {
			return nil, err
		}
		if item.RunID, err = uuid.Parse(run); err != nil {
			return nil, err
		}
		if item.UpdatedAt, err = time.Parse(time.RFC3339Nano, updated); err != nil {
			return nil, err
		}
		if baseline.Valid {
			if err = json.Unmarshal([]byte(baseline.String), &item.Baseline); err != nil {
				return nil, err
			}
		}
		if candidate.Valid && size.Valid {
			item.CandidateName, item.CandidateSize = &candidate.String, &size.Int64
		}
		if deadline.Valid {
			value, parseErr := time.Parse(time.RFC3339Nano, deadline.String)
			if parseErr != nil {
				return nil, parseErr
			}
			item.Deadline = &value
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

// RecordTimelapseBaseline stores the /timelapse listing taken while the print runs.
func (s *Store) RecordTimelapseBaseline(ctx context.Context, item timelapseRetrieval, listing []FTPEntry) error {
	baseline := make(map[string]int64, len(listing))
	for _, entry := range listing {
		if !entry.IsDir {
			baseline[entry.Name] = entry.Size
		}
	}
	encoded, err := json.Marshal(baseline)
	if err != nil {
		return err
	}
	if len(encoded) > 1<<20 {
		return errors.New("timelapse baseline exceeds 1 MiB")
	}
	_, err = s.db.ExecContext(
		ctx,
		`UPDATE timelapse_retrievals SET baseline=?,state=CASE WHEN ended_at IS NULL THEN 'waiting' ELSE 'search' END,
			reason_code=NULL,next_attempt_at=?,updated_at=? WHERE assignment_id=? AND run_id=? AND state='baseline'`,
		string(encoded),
		nowText(),
		nowText(),
		item.AssignmentID.String(),
		item.RunID.String(),
	)
	return err
}

// ObserveTimelapseCandidate is true when the previous listing, at least
// timelapseStableAfter ago, showed the same file with the same size.
func (s *Store) ObserveTimelapseCandidate(ctx context.Context, item timelapseRetrieval, match TimelapseMatch) (bool, error) {
	stable := item.CandidateName != nil && item.CandidateSize != nil && *item.CandidateName == match.Name &&
		*item.CandidateSize == match.Size && time.Since(item.UpdatedAt) >= timelapseStableAfter
	if stable {
		return true, nil
	}
	if item.CandidateName != nil && item.CandidateSize != nil && *item.CandidateName == match.Name &&
		*item.CandidateSize == match.Size {
		// Same observation, but not long enough ago: keep the first sighting time.
		_, err := s.db.ExecContext(
			ctx,
			`UPDATE timelapse_retrievals SET next_attempt_at=? WHERE assignment_id=? AND run_id=?`,
			time.Now().UTC().Add(timelapseStableAfter).Format(time.RFC3339Nano),
			item.AssignmentID.String(),
			item.RunID.String(),
		)
		return false, err
	}
	_, err := s.db.ExecContext(
		ctx,
		`UPDATE timelapse_retrievals SET candidate_name=?,candidate_size=?,next_attempt_at=?,updated_at=? WHERE assignment_id=? AND run_id=?`,
		match.Name,
		match.Size,
		time.Now().UTC().Add(timelapseStableAfter).Format(time.RFC3339Nano),
		nowText(),
		item.AssignmentID.String(),
		item.RunID.String(),
	)
	return false, err
}

// RetryTimelapseLater schedules another attempt and keeps the last diagnostic.
func (s *Store) RetryTimelapseLater(ctx context.Context, item timelapseRetrieval, delay time.Duration, diagnostic *string) error {
	increment := 0
	if diagnostic != nil {
		increment = 1
	}
	_, err := s.db.ExecContext(
		ctx,
		`UPDATE timelapse_retrievals SET attempt_count=attempt_count+?,detail=coalesce(?,detail),next_attempt_at=? WHERE assignment_id=? AND run_id=?`,
		increment,
		diagnostic,
		time.Now().UTC().Add(delay).Format(time.RFC3339Nano),
		item.AssignmentID.String(),
		item.RunID.String(),
	)
	return err
}

// GiveUpTimelapse ends a run's search for good.
func (s *Store) GiveUpTimelapse(ctx context.Context, item timelapseRetrieval, reason string, detail *string) error {
	_, err := s.db.ExecContext(
		ctx,
		`UPDATE timelapse_retrievals SET state='gave_up',reason_code=?,detail=?,updated_at=? WHERE assignment_id=? AND run_id=?`,
		reason,
		detail,
		nowText(),
		item.AssignmentID.String(),
		item.RunID.String(),
	)
	return err
}

// MarkTimelapseStaged records the retrieved video for upload.
func (s *Store) MarkTimelapseStaged(ctx context.Context, item timelapseRetrieval, name string, staged stagedTimelapse) error {
	_, err := s.db.ExecContext(
		ctx,
		`UPDATE timelapse_retrievals SET state='staged',candidate_name=?,staged_path=?,size_bytes=?,sha256=?,attempt_count=0,
			next_attempt_at=?,updated_at=? WHERE assignment_id=? AND run_id=?`,
		name,
		staged.Path,
		staged.Size,
		staged.SHA256,
		nowText(),
		nowText(),
		item.AssignmentID.String(),
		item.RunID.String(),
	)
	if err != nil {
		_ = os.Remove(staged.Path)
	}
	return err
}

// ClaimedTimelapseNames are the videos already matched to other runs of the assignment.
func (s *Store) ClaimedTimelapseNames(ctx context.Context, assignmentID, exceptRun uuid.UUID) (map[string]bool, error) {
	rows, err := s.db.QueryContext(
		ctx,
		`SELECT candidate_name FROM timelapse_retrievals WHERE assignment_id=? AND run_id<>? AND state IN ('staged','done')
			AND candidate_name IS NOT NULL`,
		assignmentID.String(),
		exceptRun.String(),
	)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	claimed := map[string]bool{}
	for rows.Next() {
		var name string
		if err = rows.Scan(&name); err != nil {
			return nil, err
		}
		claimed[name] = true
	}
	return claimed, rows.Err()
}

// stagedTimelapseUpload is a staged video with its delivery bookkeeping.
type stagedTimelapseUpload struct {
	TimelapseUpload
	AttemptCount int
}

// StagedTimelapses returns videos due for upload.
func (s *Store) StagedTimelapses(ctx context.Context, limit int) ([]stagedTimelapseUpload, error) {
	rows, err := s.db.QueryContext(
		ctx,
		`SELECT assignment_id,run_id,candidate_name,staged_path,size_bytes,sha256,attempt_count FROM timelapse_retrievals
		WHERE state='staged' AND next_attempt_at<=? ORDER BY updated_at LIMIT ?`,
		nowText(),
		limit,
	)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var result []stagedTimelapseUpload
	for rows.Next() {
		var assignment, run string
		var item stagedTimelapseUpload
		if err = rows.Scan(&assignment, &run, &item.FileName, &item.StagedPath, &item.SizeBytes, &item.SHA256, &item.AttemptCount); err != nil {
			return nil, err
		}
		if item.AssignmentID, err = uuid.Parse(assignment); err != nil {
			return nil, err
		}
		if item.RunID, err = uuid.Parse(run); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

// FinishTimelapseUpload removes the staged video; state is done or gave_up.
func (s *Store) FinishTimelapseUpload(ctx context.Context, upload TimelapseUpload, state string, reason *string) error {
	if _, err := s.db.ExecContext(
		ctx,
		`UPDATE timelapse_retrievals SET state=?,reason_code=?,staged_path=NULL,updated_at=? WHERE assignment_id=? AND run_id=?`,
		state,
		reason,
		nowText(),
		upload.AssignmentID.String(),
		upload.RunID.String(),
	); err != nil {
		return err
	}
	if err := os.Remove(upload.StagedPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// DeferTimelapseUpload retries an upload with exponential backoff.
func (s *Store) DeferTimelapseUpload(ctx context.Context, upload stagedTimelapseUpload, diagnostic string) error {
	delay := 5 * time.Second * time.Duration(1<<min(upload.AttemptCount, 6))
	_, err := s.db.ExecContext(
		ctx,
		`UPDATE timelapse_retrievals SET attempt_count=attempt_count+1,detail=?,next_attempt_at=? WHERE assignment_id=? AND run_id=?`,
		diagnostic,
		time.Now().UTC().Add(min(delay, 5*time.Minute)).Format(time.RFC3339Nano),
		upload.AssignmentID.String(),
		upload.RunID.String(),
	)
	return err
}
