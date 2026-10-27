package runrecordings

import (
	"context"
	"errors"
	"io"
	"path"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printerconnectors"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/runrecordings/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// GetRecording returns the files, consumption status, timelapse and latest
// commands of one run. Needs machine_jobs.read.
func (s *Service) GetRecording(ctx context.Context, p authorization.Principal, runID uuid.UUID) (Recording, error) {
	detail, err := s.logbook.GetRun(ctx, p, runID)
	if err != nil {
		return Recording{}, err
	}
	recordings, err := s.recordings(ctx, []machinelogbook.MachineRun{detail.MachineRun})
	if err != nil {
		return Recording{}, err
	}
	return recordings[0], nil
}

// ListJobRecordings returns the recordings of every recorded run of a job,
// oldest run first. Needs machine_jobs.read.
func (s *Service) ListJobRecordings(ctx context.Context, p authorization.Principal, jobID uuid.UUID) ([]Recording, error) {
	job, err := s.logbook.GetJob(ctx, p, jobID)
	if err != nil {
		return nil, err
	}
	runs := make([]machinelogbook.MachineRun, 0, len(job.Runs))
	for _, run := range job.Runs {
		if run.Source == machinelogbook.RunSourceRecorded {
			runs = append(runs, run)
		}
	}
	return s.recordings(ctx, runs)
}

func (s *Service) recordings(ctx context.Context, runs []machinelogbook.MachineRun) ([]Recording, error) {
	result := make([]Recording, 0, len(runs))
	if len(runs) == 0 {
		return result, nil
	}
	ids := make([]uuid.UUID, 0, len(runs))
	for _, run := range runs {
		ids = append(ids, run.ID)
	}
	q := db.New(s.pool)
	settings, err := q.GetRecordingSettings(ctx)
	if err != nil {
		return nil, err
	}
	artifacts, err := q.ListRunArtifactFiles(ctx, ids)
	if err != nil {
		return nil, err
	}
	artifactByRun := map[uuid.UUID]ArtifactFile{}
	for _, row := range artifacts {
		artifactByRun[row.RunID] = ArtifactFile{
			ID:               row.ArtifactID,
			OriginalFilename: row.OriginalFilename,
			SizeBytes:        row.SizeBytes,
			SHA256:           row.Sha256,
			ParserStatus:     row.ParserStatus,
			UploadedManually: row.ArtifactManual,
		}
	}
	previews, err := q.ListRunPreviews(ctx, ids)
	if err != nil {
		return nil, err
	}
	previewsByRun := map[uuid.UUID][]Preview{}
	for _, row := range previews {
		var plate *int
		if row.PlateNumber != nil {
			value := int(*row.PlateNumber)
			plate = &value
		}
		previewsByRun[row.RunID] = append(previewsByRun[row.RunID], Preview{
			ID:          row.ID,
			Role:        row.Role,
			PlateNumber: plate,
			Width:       int(row.Width),
			Height:      int(row.Height),
			MIMEType:    row.MimeType,
			Primary:     row.IsPrimary,
		})
	}
	timelapses, err := q.ListRunTimelapses(ctx, ids)
	if err != nil {
		return nil, err
	}
	timelapseByRun := map[uuid.UUID]Timelapse{}
	for _, row := range timelapses {
		timelapseByRun[row.RunID] = Timelapse{
			SizeBytes: row.SizeBytes,
			CreatedAt: row.CreatedAt.UTC(),
			ExpiresAt: timelapseExpiry(row.CreatedAt, int(settings.TimelapseRetentionDays)),
		}
	}
	reports, err := q.ListRunTimelapseReports(ctx, ids)
	if err != nil {
		return nil, err
	}
	reportByRun := map[uuid.UUID]db.ListRunTimelapseReportsRow{}
	for _, row := range reports {
		reportByRun[row.RunID] = row
	}
	commands, err := q.ListLatestRunCommands(ctx, ids)
	if err != nil {
		return nil, err
	}
	commandsByRun := map[uuid.UUID][]Command{}
	for _, row := range commands {
		commandsByRun[row.RunID] = append(commandsByRun[row.RunID], commandFrom(row))
	}
	for _, run := range runs {
		recording := Recording{
			RunID:             run.ID,
			RunDisplayID:      run.DisplayID,
			Source:            run.Source,
			State:             run.State,
			StartedAt:         run.StartedAt,
			ConsumptionStatus: run.ConsumptionStatus,
			Previews:          previewsByRun[run.ID],
			Commands:          commandsByRun[run.ID],
		}
		if recording.Previews == nil {
			recording.Previews = []Preview{}
		}
		if recording.Commands == nil {
			recording.Commands = []Command{}
		}
		if artifact, ok := artifactByRun[run.ID]; ok {
			recording.Artifact = &artifact
		}
		timelapse, hasTimelapse := timelapseByRun[run.ID]
		if hasTimelapse {
			recording.Timelapse = &timelapse
		}
		var report *db.ListRunTimelapseReportsRow
		if row, ok := reportByRun[run.ID]; ok {
			report = &row
		}
		recording.TimelapseStatus = DeriveTimelapseStatus(run.Source, hasTimelapse, report)
		result = append(result, recording)
	}
	return result, nil
}

// DeriveTimelapseStatus explains a run's timelapse: available when stored,
// expired when the connector uploaded one that the retention removed, otherwise
// what the connector reported; nil without a report (manual runs, running runs,
// older connectors).
func DeriveTimelapseStatus(
	source machinelogbook.RunSource,
	stored bool,
	report *db.ListRunTimelapseReportsRow,
) *TimelapseStatus {
	if source != machinelogbook.RunSourceRecorded {
		return nil
	}
	if stored {
		return &TimelapseStatus{State: TimelapseAvailable}
	}
	if report == nil || report.TimelapseState == nil {
		return nil
	}
	switch *report.TimelapseState {
	case "uploaded":
		return &TimelapseStatus{State: TimelapseExpired}
	case string(TimelapsePending), string(TimelapseNotFound), string(TimelapseFailed), string(TimelapseSkipped):
		return &TimelapseStatus{
			State:  TimelapseState(*report.TimelapseState),
			Reason: report.TimelapseReason,
			Detail: report.TimelapseDetail,
		}
	}
	return nil
}

func timelapseExpiry(created time.Time, retentionDays int) *time.Time {
	if retentionDays <= 0 {
		return nil
	}
	value := created.UTC().AddDate(0, 0, retentionDays)
	return &value
}

// OpenRunArtifact opens the original 3MF of a run. Needs machine_jobs.read.
func (s *Service) OpenRunArtifact(
	ctx context.Context,
	p authorization.Principal,
	runID uuid.UUID,
) (FileContent, io.ReadCloser, error) {
	if !p.Has(authorization.MachineJobsRead) {
		return FileContent{}, nil, apperror.PermissionDenied
	}
	return s.openArtifact(ctx, runID)
}

func (s *Service) openArtifact(ctx context.Context, runID uuid.UUID) (FileContent, io.ReadCloser, error) {
	row, err := db.New(s.pool).GetRunArtifactFile(ctx, runID)
	if errors.Is(err, pgx.ErrNoRows) {
		return FileContent{}, nil, apperror.NotFound
	}
	if err != nil {
		return FileContent{}, nil, err
	}
	_, reader, err := s.files.Open(ctx, row.OriginalFileID)
	if err != nil {
		return FileContent{}, nil, err
	}
	return FileContent{
		FileName:    row.OriginalFilename,
		ContentType: "application/octet-stream",
		SizeBytes:   row.SizeBytes,
		SHA256:      row.Sha256,
	}, reader, nil
}

// OpenConnectorRunArtifact lets a connector download the stored 3MF of one of
// its runs, to recompute consumption after its staged copy is gone.
func (s *Service) OpenConnectorRunArtifact(
	ctx context.Context,
	connector printerconnectors.Context,
	assignmentID, runID uuid.UUID,
) (FileContent, io.ReadCloser, error) {
	if connector.Lifecycle != printerconnectors.LifecycleActive {
		return FileContent{}, nil, apperror.PermissionDenied
	}
	if _, err := db.New(s.pool).GetConnectorRunTarget(ctx, db.GetConnectorRunTargetParams{
		RunID:        runID,
		AssignmentID: assignmentID,
		ConnectorID:  connector.ID,
	}); errors.Is(err, pgx.ErrNoRows) {
		return FileContent{}, nil, apperror.NotFound
	} else if err != nil {
		return FileContent{}, nil, err
	}
	return s.openArtifact(ctx, runID)
}

// OpenRunPreview opens a preview image of the run's 3MF. Needs machine_jobs.read.
func (s *Service) OpenRunPreview(
	ctx context.Context,
	p authorization.Principal,
	runID, previewID uuid.UUID,
) (FileContent, io.ReadCloser, error) {
	if !p.Has(authorization.MachineJobsRead) {
		return FileContent{}, nil, apperror.PermissionDenied
	}
	row, err := db.New(s.pool).GetRunPreviewFile(ctx, db.GetRunPreviewFileParams{RunID: runID, PreviewID: previewID})
	if errors.Is(err, pgx.ErrNoRows) {
		return FileContent{}, nil, apperror.NotFound
	}
	if err != nil {
		return FileContent{}, nil, err
	}
	_, reader, err := s.files.Open(ctx, row.FileID)
	if err != nil {
		return FileContent{}, nil, err
	}
	return FileContent{
		FileName:    path.Base(row.ArchivePath),
		ContentType: row.MimeType,
		SizeBytes:   row.SizeBytes,
	}, reader, nil
}

// OpenRunTimelapse opens the run's timelapse video. The reader is an io.Seeker
// when the storage backend can seek. Needs machine_jobs.read.
func (s *Service) OpenRunTimelapse(
	ctx context.Context,
	p authorization.Principal,
	runID uuid.UUID,
) (FileContent, io.ReadCloser, error) {
	if !p.Has(authorization.MachineJobsRead) {
		return FileContent{}, nil, apperror.PermissionDenied
	}
	row, err := db.New(s.pool).GetRunTimelapseFile(ctx, runID)
	if errors.Is(err, pgx.ErrNoRows) {
		return FileContent{}, nil, apperror.NotFound
	}
	if err != nil {
		return FileContent{}, nil, err
	}
	_, reader, err := s.files.Open(ctx, row.FileID)
	if err != nil {
		return FileContent{}, nil, err
	}
	return FileContent{
		FileName:    row.DisplayID + "-timelapse.mp4",
		ContentType: TimelapseContentType,
		SizeBytes:   row.SizeBytes,
	}, reader, nil
}
