package runrecordings

import (
	"context"
	"errors"
	"io"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/runrecordings/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// PrintPage is one recorded print as the recipient of its job sees it. It deliberately carries no material,
// quantities, prices, operator, starter or recipient.
type PrintPage struct {
	RunID       uuid.UUID
	DisplayID   string
	Title       string
	MachineName string
	StartedAt   time.Time
	// EndedAt and DurationSeconds are nil while the print runs.
	EndedAt         *time.Time
	DurationSeconds *int64
	Outcome         *machinelogbook.RunOutcome
	Artifact        *ArtifactFile
	Previews        []Preview
	Timelapse       *Timelapse
	TimelapseStatus *TimelapseStatus
	// ViewerIsStaff says the viewer holds machine_jobs.read and may open the run in the workshop pages.
	ViewerIsStaff bool
}

// GetPrintPage returns the print page of a recorded run. The current recipient of the run's job (a person, never an
// organization) and holders of machine_jobs.read may open it; everybody else gets the same not-found answer as for a
// run that does not exist, so the page never reveals that a run exists.
func (s *Service) GetPrintPage(ctx context.Context, p authorization.Principal, runID uuid.UUID) (PrintPage, error) {
	row, err := s.printPageRun(ctx, p, runID)
	if err != nil {
		return PrintPage{}, err
	}
	recordings, err := s.recordings(ctx, []machinelogbook.MachineRun{{
		ID:        row.ID,
		DisplayID: row.DisplayID,
		Source:    machinelogbook.RunSourceRecorded,
		StartedAt: row.StartedAt.UTC(),
	}})
	if err != nil {
		return PrintPage{}, err
	}
	recording := recordings[0]
	page := PrintPage{
		RunID:         row.ID,
		DisplayID:     row.DisplayID,
		Title:         printPageTitle(row),
		MachineName:   row.MachineName,
		StartedAt:     row.StartedAt.UTC(),
		Artifact:      recording.Artifact,
		Previews:      recording.Previews,
		Timelapse:     recording.Timelapse,
		ViewerIsStaff: p.Has(authorization.MachineJobsRead),
	}
	if row.Outcome != nil {
		outcome := machinelogbook.RunOutcome(*row.Outcome)
		page.Outcome = &outcome
	}
	if row.EndedAt.Valid {
		ended := row.EndedAt.Time.UTC()
		duration := max(0, int64(ended.Sub(page.StartedAt).Seconds()))
		page.EndedAt, page.DurationSeconds = &ended, &duration
	}
	if status := recording.TimelapseStatus; status != nil {
		// The connector's free-text detail stays on the staff pages.
		page.TimelapseStatus = &TimelapseStatus{State: status.State, Reason: status.Reason}
	}
	return page, nil
}

// OpenPrintPageTimelapse opens the timelapse video of a print page, with the access of GetPrintPage.
func (s *Service) OpenPrintPageTimelapse(
	ctx context.Context,
	p authorization.Principal,
	runID uuid.UUID,
) (FileContent, io.ReadCloser, error) {
	if _, err := s.printPageRun(ctx, p, runID); err != nil {
		return FileContent{}, nil, err
	}
	return s.openTimelapse(ctx, runID)
}

// OpenPrintPageArtifact opens the original 3MF of a print page, with the access of GetPrintPage.
func (s *Service) OpenPrintPageArtifact(
	ctx context.Context,
	p authorization.Principal,
	runID uuid.UUID,
) (FileContent, io.ReadCloser, error) {
	if _, err := s.printPageRun(ctx, p, runID); err != nil {
		return FileContent{}, nil, err
	}
	return s.openArtifact(ctx, runID)
}

// OpenPrintPagePreview opens a preview image of a print page's 3MF, with the access of GetPrintPage.
func (s *Service) OpenPrintPagePreview(
	ctx context.Context,
	p authorization.Principal,
	runID, previewID uuid.UUID,
) (FileContent, io.ReadCloser, error) {
	if _, err := s.printPageRun(ctx, p, runID); err != nil {
		return FileContent{}, nil, err
	}
	return s.openPreview(ctx, runID, previewID)
}

// printPageRun loads the run of a print page and decides whether the viewer may open it. A run the viewer may not
// open answers exactly like a missing one.
func (s *Service) printPageRun(
	ctx context.Context,
	p authorization.Principal,
	runID uuid.UUID,
) (db.GetPrintPageRunRow, error) {
	row, err := db.New(s.pool).GetPrintPageRun(ctx, runID)
	if errors.Is(err, pgx.ErrNoRows) {
		return db.GetPrintPageRunRow{}, apperror.NotFound
	}
	if err != nil {
		return db.GetPrintPageRunRow{}, err
	}
	if !MayOpenPrintPage(p, row.CustomerPersonID) {
		return db.GetPrintPageRunRow{}, apperror.NotFound
	}
	return row, nil
}

// MayOpenPrintPage says whether the viewer may open the print page of a run whose job has the given recipient
// person: staff with machine_jobs.read always, anyone else only as that recipient.
func MayOpenPrintPage(p authorization.Principal, recipientPersonID *uuid.UUID) bool {
	if p.Has(authorization.MachineJobsRead) {
		return true
	}
	return recipientPersonID != nil && p.PersonID != uuid.Nil && *recipientPersonID == p.PersonID
}

// printPageTitle names the print: the job's title, else the 3MF's original file name, the printer's file name or
// the run's number.
func printPageTitle(row db.GetPrintPageRunRow) string {
	for _, candidate := range []*string{row.JobTitle, row.ArtifactFilename, row.FileName} {
		if candidate != nil && strings.TrimSpace(*candidate) != "" {
			return strings.TrimSpace(*candidate)
		}
	}
	return row.DisplayID
}
