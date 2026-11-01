package machinelogbook

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// DeletedJob is a job in the recycle bin.
type DeletedJob struct {
	ID               uuid.UUID
	DisplayID        string
	Title            *string
	MachineID        uuid.UUID
	MachineName      string
	DeletedAt        time.Time
	DeletedByName    *string
	DeletedRunCount  int64
	DetachedRunCount int64
	// HasInventoryBookings: the immutable inventory ledger refers to the job's material; it can stay in the bin but
	// cannot be deleted for good.
	HasInventoryBookings bool
	Version              int64
}

// DeletedRun is a run in the recycle bin.
type DeletedRun struct {
	ID                   uuid.UUID
	DisplayID            string
	FileName             *string
	Source               string
	MachineID            uuid.UUID
	MachineName          string
	DeletedAt            time.Time
	DeletedByName        *string
	FormerJobID          *uuid.UUID
	FormerJobDisplayID   *string
	FormerJobInBin       bool
	HasInventoryBookings bool
	Version              int64
}

// errInventoryBookingsExist: the inventory ledger is immutable and keeps its link to the material usage, so the rows
// behind it have to stay.
var errInventoryBookingsExist = apperror.Conflicting(
	"inventory_bookings_exist",
	"Material bookings in the inventory ledger refer to it, so it can stay in the recycle bin but cannot be deleted for good",
)

// RecycleBin holds what can still be restored.
type RecycleBin struct {
	Jobs []DeletedJob
	Runs []DeletedRun
}

func personName(first, last *string) *string {
	if first == nil && last == nil {
		return nil
	}
	name := strings.TrimSpace(strings.TrimSpace(deref(first)) + " " + strings.TrimSpace(deref(last)))
	if name == "" {
		return nil
	}
	return &name
}

func deref(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

// RecycleBin lists the deleted jobs and runs (machine_jobs.delete).
func (s *Service) RecycleBin(ctx context.Context, p authorization.Principal) (RecycleBin, error) {
	if !p.Has(authorization.MachineJobsDelete) {
		return RecycleBin{}, apperror.PermissionDenied
	}
	q := machinelogbookdb.New(s.pool)
	jobs, err := q.ListDeletedMachineJobs(ctx)
	if err != nil {
		return RecycleBin{}, databaseError(err)
	}
	runs, err := q.ListDeletedMachineRuns(ctx)
	if err != nil {
		return RecycleBin{}, databaseError(err)
	}
	bin := RecycleBin{Jobs: make([]DeletedJob, 0, len(jobs)), Runs: make([]DeletedRun, 0, len(runs))}
	for _, row := range jobs {
		bin.Jobs = append(bin.Jobs, DeletedJob{
			ID: row.ID, DisplayID: row.DisplayID, Title: row.Title, MachineID: row.MachineID, MachineName: row.MachineName,
			DeletedAt: row.DeletedAt.Time, DeletedByName: personName(row.DeletedByFirstName, row.DeletedByLastName),
			DeletedRunCount: row.DeletedRunCount, DetachedRunCount: row.DetachedRunCount,
			HasInventoryBookings: row.HasInventoryBookings, Version: row.Version,
		})
	}
	for _, row := range runs {
		bin.Runs = append(bin.Runs, DeletedRun{
			ID: row.ID, DisplayID: row.DisplayID, FileName: row.FileName, Source: row.Source, MachineID: row.MachineID,
			MachineName: row.MachineName, DeletedAt: row.DeletedAt.Time,
			DeletedByName: personName(row.DeletedByFirstName, row.DeletedByLastName),
			FormerJobID:   row.FormerJobID, FormerJobDisplayID: row.FormerJobDisplayID,
			FormerJobInBin: row.FormerJobDeletedAt.Valid, HasInventoryBookings: row.HasInventoryBookings, Version: row.Version,
		})
	}
	return bin, nil
}

// RestoreJob brings a deleted job back with the runs that were deleted with it and re-attaches the recorded runs
// the deletion detached, as long as they are still unassigned. Material the deletion reversed stays reversed.
func (s *Service) RestoreJob(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, requestID *uuid.UUID) (MachineJob, error) {
	if !p.Has(authorization.MachineJobsDelete) {
		return MachineJob{}, apperror.PermissionDenied
	}
	if expected < 1 {
		return MachineJob{}, apperror.Invalid("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MachineJob{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	job, err := q.GetDeletedMachineJobForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return MachineJob{}, apperror.NotFound
	}
	if err != nil {
		return MachineJob{}, databaseError(err)
	}
	if job.Version != expected {
		return MachineJob{}, apperror.StaleWrite
	}
	runs, err := q.ListRunsDeletedWithJob(ctx, machinelogbookdb.ListRunsDeletedWithJobParams{JobID: &id, DeletedAt: job.DeletedAt.Time})
	if err != nil {
		return MachineJob{}, databaseError(err)
	}
	if err = q.RestoreMachineJob(ctx, id); err != nil {
		return MachineJob{}, databaseError(err)
	}
	for _, run := range runs {
		if err = q.RestoreMachineRun(ctx, machinelogbookdb.RestoreMachineRunParams{ID: run.ID, Reattach: true}); err != nil {
			return MachineJob{}, databaseError(err)
		}
	}
	reattached, err := q.ReattachDetachedRunsOfJob(ctx, &id)
	if err != nil {
		return MachineJob{}, databaseError(err)
	}
	if err = q.ForgetFormerJobOfRuns(ctx, &id); err != nil {
		return MachineJob{}, databaseError(err)
	}
	if _, err = s.settleJob(ctx, q, id); err != nil {
		return MachineJob{}, err
	}
	if err = audit.Write(ctx, tx, audit.Event{
		ActorAccountID: accountPointer(p),
		Action:         "machine_job.restored",
		ResourceType:   "machine_job",
		ResourceID:     &id,
		RequestID:      requestID,
		ChangedFields:  []string{"deletedAt", "runs"},
		Metadata: map[string]any{
			"countRunsRestored": fmt.Sprint(len(runs)), "countRunsReattached": fmt.Sprint(reattached),
		},
	}); err != nil {
		return MachineJob{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MachineJob{}, err
	}
	return s.GetJob(ctx, p, id)
}

// RestoreRun brings a deleted run back: into its former job when that job is alive, otherwise unassigned.
func (s *Service) RestoreRun(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, requestID *uuid.UUID) (MachineRun, error) {
	if !p.Has(authorization.MachineJobsDelete) {
		return MachineRun{}, apperror.PermissionDenied
	}
	if expected < 1 {
		return MachineRun{}, apperror.Invalid("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MachineRun{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	run, err := q.GetDeletedMachineRunForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return MachineRun{}, apperror.NotFound
	}
	if err != nil {
		return MachineRun{}, databaseError(err)
	}
	if run.Version != expected {
		return MachineRun{}, apperror.StaleWrite
	}
	reattach := false
	if run.FormerJobID != nil {
		// A manual run only exists inside its job; a recorded one may live on as an unassigned run.
		if _, err := q.GetMachineJobForUpdate(ctx, *run.FormerJobID); err == nil {
			reattach = true
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return MachineRun{}, databaseError(err)
		} else if run.Source != "recorded" {
			return MachineRun{}, apperror.Conflicting("job_in_bin", "Restore the job first; a manual run only exists inside its job")
		}
	} else if run.Source != "recorded" {
		return MachineRun{}, apperror.Conflicting("job_missing", "The job of this manual run is gone for good")
	}
	if err = q.RestoreMachineRun(ctx, machinelogbookdb.RestoreMachineRunParams{ID: id, Reattach: reattach}); err != nil {
		return MachineRun{}, databaseError(err)
	}
	fields := []string{"deletedAt"}
	if reattach {
		fields = append(fields, "jobId")
		if _, err = s.settleJob(ctx, q, *run.FormerJobID); err != nil {
			return MachineRun{}, err
		}
	}
	if err = audit.Write(ctx, tx, audit.Event{
		ActorAccountID: accountPointer(p),
		Action:         "machine_run.restored",
		ResourceType:   "machine_run",
		ResourceID:     &id,
		RequestID:      requestID,
		ChangedFields:  fields,
	}); err != nil {
		return MachineRun{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MachineRun{}, err
	}
	detail, err := s.GetRun(ctx, p, id)
	if err != nil {
		return MachineRun{}, err
	}
	return detail.MachineRun, nil
}

// PurgeJob removes a deleted job for good, together with the runs that went into the bin with it. Runs the
// deletion left behind as unassigned runs stay; inventory bookings are kept.
func (s *Service) PurgeJob(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, requestID *uuid.UUID) error {
	if !p.Has(authorization.MachineJobsDelete) {
		return apperror.PermissionDenied
	}
	if expected < 1 {
		return apperror.Invalid("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	job, err := q.GetDeletedMachineJobForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	if err != nil {
		return databaseError(err)
	}
	if job.Version != expected {
		return apperror.StaleWrite
	}
	bookings, err := q.CountLedgerEntriesOfJob(ctx, machinelogbookdb.CountLedgerEntriesOfJobParams{JobID: &id, DeletedAt: job.DeletedAt.Time})
	if err != nil {
		return databaseError(err)
	}
	if bookings > 0 {
		return errInventoryBookingsExist
	}
	runs, err := q.ListRunsDeletedWithJob(ctx, machinelogbookdb.ListRunsDeletedWithJobParams{JobID: &id, DeletedAt: job.DeletedAt.Time})
	if err != nil {
		return databaseError(err)
	}
	for _, run := range runs {
		if _, err = q.PurgeMachineRun(ctx, run.ID); err != nil {
			return databaseError(err)
		}
	}
	if err = q.ForgetFormerJobOfRuns(ctx, &id); err != nil {
		return databaseError(err)
	}
	if _, err = q.PurgeMachineJob(ctx, id); err != nil {
		return databaseError(err)
	}
	if err = audit.Write(ctx, tx, audit.Event{
		ActorAccountID: accountPointer(p),
		Action:         "machine_job.purged",
		ResourceType:   "machine_job",
		ResourceID:     &id,
		RequestID:      requestID,
		ChangedFields:  []string{"job", "runs"},
		Metadata:       map[string]any{"countRunsPurged": fmt.Sprint(len(runs))},
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// PurgeRun removes a deleted run for good. Inventory bookings are kept; the print file stays for other runs.
func (s *Service) PurgeRun(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, requestID *uuid.UUID) error {
	if !p.Has(authorization.MachineJobsDelete) {
		return apperror.PermissionDenied
	}
	if expected < 1 {
		return apperror.Invalid("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	run, err := q.GetDeletedMachineRunForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	if err != nil {
		return databaseError(err)
	}
	if run.Version != expected {
		return apperror.StaleWrite
	}
	bookings, err := q.CountLedgerEntriesOfRun(ctx, id)
	if err != nil {
		return databaseError(err)
	}
	if bookings > 0 {
		return errInventoryBookingsExist
	}
	if _, err = q.PurgeMachineRun(ctx, id); err != nil {
		return databaseError(err)
	}
	if err = audit.Write(ctx, tx, audit.Event{
		ActorAccountID: accountPointer(p),
		Action:         "machine_run.purged",
		ResourceType:   "machine_run",
		ResourceID:     &id,
		RequestID:      requestID,
		ChangedFields:  []string{"run"},
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
