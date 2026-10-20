package machinelogbook

import (
	"bytes"
	"context"
	"sort"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
)

// DeleteJobInput says what happens to a job's runs and to the material they
// consumed when the job is deleted.
type DeleteJobInput struct {
	ExpectedVersion int64
	// ReverseConsumption restores the consumed material of the deleted runs to
	// inventory; otherwise the ledger is left untouched.
	ReverseConsumption bool
	// DeleteRecordedRuns deletes the job's recorded runs as well; otherwise
	// they are detached and become unassigned runs. Manual runs are always
	// deleted with the job.
	DeleteRecordedRuns bool
}

func auditDeletedRun(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	run machinelogbookdb.MachineRun,
	reversed bool,
	requestID *uuid.UUID,
) error {
	fields := []string{"deletedAt"}
	if reversed {
		fields = append(fields, "usages", "inventory")
	}
	metadata := map[string]any{}
	if run.JobID != nil {
		metadata["jobId"] = run.JobID.String()
	}
	event := audit.Event{
		ActorAccountID: accountPointer(p),
		Action:         "machine_run.deleted",
		ResourceType:   "machine_run",
		ResourceID:     &run.ID,
		RequestID:      requestID,
		ChangedFields:  fields,
		Metadata:       metadata,
	}
	if event.ActorAccountID == nil {
		event.ActorType = "system"
	}
	return audit.Write(ctx, tx, event)
}

// reverseRunConsumption restores the material the runs consumed. For every
// active usage with posted consumption it records a compensating ledger entry
// (a positive "job_corrected" adjustment linked to the same usage) at the unit
// cost of the consumption, back into the usage's spool fill while that fill is
// still open and into loose stock otherwise. The usages are deactivated. The
// caller holds the locks on the runs. It returns the quantity restored.
func (s *Service) reverseRunConsumption(
	ctx context.Context,
	tx pgx.Tx,
	q *machinelogbookdb.Queries,
	p authorization.Principal,
	runs []machinelogbookdb.MachineRun,
	requestID *uuid.UUID,
) (decimal.Decimal, error) {
	type pending struct {
		usage machinelogbookdb.MachineRunUsage
		run   machinelogbookdb.MachineRun
	}
	var usages []pending
	materialIDs := map[uuid.UUID]bool{}
	for _, run := range runs {
		active, err := q.ListActiveRunUsagesForUpdate(ctx, run.ID)
		if err != nil {
			return decimal.Zero, err
		}
		for _, u := range active {
			usages = append(usages, pending{usage: u, run: run})
			if u.Ownership != "external" && u.MaterialID != nil {
				materialIDs[*u.MaterialID] = true
			}
		}
	}
	ids := make([]uuid.UUID, 0, len(materialIDs))
	for id := range materialIDs {
		ids = append(ids, id)
	}
	if err := lockMaterials(ctx, q, ids...); err != nil {
		return decimal.Zero, err
	}
	sort.SliceStable(usages, func(i, j int) bool {
		a, b := usages[i].usage, usages[j].usage
		if cmp := compareOptionalUUID(a.MaterialID, b.MaterialID); cmp != 0 {
			return cmp < 0
		}
		if cmp := compareOptionalUUID(a.SpoolID, b.SpoolID); cmp != 0 {
			return cmp < 0
		}
		return bytes.Compare(a.ID[:], b.ID[:]) < 0
	})
	total := decimal.Zero
	for _, item := range usages {
		u := item.usage
		if u.Ownership != "external" && u.MaterialID != nil {
			ledger, err := q.SumRunUsageLedger(ctx, &u.ID)
			if err != nil {
				return decimal.Zero, err
			}
			quantity := decimalFromNumeric(ledger.Quantity).Neg()
			if quantity.IsPositive() {
				value := decimalFromNumeric(ledger.Value).Neg()
				unitCost := value.Div(quantity).Round(6)
				fill, err := s.reversalFill(ctx, q, u)
				if err != nil {
					return decimal.Zero, err
				}
				note := "Consumption reversed with the deletion of " + item.run.DisplayID
				if fill == nil && usageFillRef(u) != nil {
					note += "; the spool fill was closed, so the material went back to loose stock"
				}
				usageID := u.ID
				if _, err = s.applyInventoryMutation(
					ctx,
					tx,
					q,
					p,
					*u.MaterialID,
					anyInventoryVersion,
					inventoryMutation{
						Kind:          "adjustment",
						QuantityDelta: quantity,
						UnitCost:      unitCost,
						ValueDelta:    value,
						OccurredAt:    s.now().UTC(),
						Reason:        stringPointer("job_corrected"),
						Note:          &note,
						UsageID:       &usageID,
						Fill:          fill,
					},
					requestID,
				); err != nil {
					return decimal.Zero, err
				}
				total = total.Add(quantity)
			}
		}
		if err := q.DeactivateRunUsage(ctx, u.ID); err != nil {
			return decimal.Zero, err
		}
	}
	return total, nil
}

func compareOptionalUUID(a, b *uuid.UUID) int {
	switch {
	case a == nil && b == nil:
		return 0
	case a == nil:
		return 1
	case b == nil:
		return -1
	}
	return bytes.Compare(a[:], b[:])
}

func timePtr(t time.Time) *time.Time { t = t.UTC(); return &t }

func deletedBy(p authorization.Principal) *uuid.UUID { return accountPointer(p) }

// DeleteRun deletes a run of any source. The run is tombstoned, detached from
// its job and excluded from every list and total; its display ID is never
// reused. A run that is the only remaining run of its job cannot be deleted
// (delete the job instead). A running recorded run may be deleted; the
// connector's later reports for it are stored but ignored. With
// reverseConsumption the consumed material goes back to inventory. Manual
// runs need machine_jobs.edit or machine_jobs.delete, recorded runs
// machine_jobs.delete.
func (s *Service) DeleteRun(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	reverseConsumption bool,
	requestID *uuid.UUID,
) error {
	// Removing a mistaken manual run is an editing operation; recorded runs
	// need machine_jobs.delete, which is checked once the run is known.
	if !p.Has(authorization.MachineJobsEdit) && !p.Has(authorization.MachineJobsDelete) {
		return apperror.PermissionDenied
	}
	if expected < 1 {
		return validation("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	run, _, err := s.lockedRun(ctx, tx, id)
	if err != nil {
		return err
	}
	if run.Source == "recorded" {
		if err = require(p, authorization.MachineJobsDelete); err != nil {
			return err
		}
	}
	if run.Version != expected {
		return apperror.StaleWrite
	}
	if run.JobID != nil && (run.State == nil || *run.State != "replaced") {
		active, err := q.ListActiveJobRunIDs(ctx, run.JobID)
		if err != nil {
			return err
		}
		if len(active) <= 1 {
			return conflict("last_run", "The only run of a job cannot be deleted; delete the job instead")
		}
	}
	if err = s.deleteRunRows(ctx, tx, q, p, run, reverseConsumption, requestID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// deleteRunRows tombstones a locked run, optionally reversing its consumption,
// audits it and reprices the job it belonged to. The caller has checked
// permissions, the version and the last-run rule.
func (s *Service) deleteRunRows(
	ctx context.Context,
	tx pgx.Tx,
	q *machinelogbookdb.Queries,
	p authorization.Principal,
	run machinelogbookdb.MachineRun,
	reverseConsumption bool,
	requestID *uuid.UUID,
) error {
	deletedAt := pgTime(timePtr(s.now()))
	reversed := false
	if reverseConsumption {
		quantity, err := s.reverseRunConsumption(ctx, tx, q, p, []machinelogbookdb.MachineRun{run}, requestID)
		if err != nil {
			return err
		}
		reversed = quantity.IsPositive()
	}
	if err := q.SoftDeleteMachineRun(
		ctx,
		machinelogbookdb.SoftDeleteMachineRunParams{ID: run.ID, DeletedAt: deletedAt, DeletedBy: deletedBy(p)},
	); err != nil {
		return databaseError(err)
	}
	if err := auditDeletedRun(ctx, tx, p, run, reversed, requestID); err != nil {
		return err
	}
	if run.JobID != nil {
		if _, err := s.settleJob(ctx, q, *run.JobID); err != nil {
			return err
		}
		if err := writeAudit(
			ctx,
			tx,
			p,
			"machine_job.repriced",
			"machine_job",
			*run.JobID,
			requestID,
			[]string{"runs", "calculatedPrice", "effectivePrice"},
		); err != nil {
			return err
		}
	}
	return nil
}

// DeleteJob deletes a job and its manual runs. Its recorded runs are deleted
// with it or detached into unassigned runs. A job on an order cannot be
// deleted. All rows are locked in the order job, runs.
func (s *Service) DeleteJob(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	input DeleteJobInput,
	requestID *uuid.UUID,
) error {
	if err := require(p, authorization.MachineJobsDelete); err != nil {
		return err
	}
	if input.ExpectedVersion < 1 {
		return validation("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	job, err := q.GetMachineJobForUpdate(ctx, id)
	if err != nil {
		return noRows(err)
	}
	if job.Version != input.ExpectedVersion {
		return apperror.StaleWrite
	}
	onOrder, err := q.JobIsOnOrder(ctx, id)
	if err != nil {
		return err
	}
	if onOrder {
		return conflict("job_on_order", "A job on an order cannot be deleted")
	}
	runs, err := q.ListJobRunsForUpdate(ctx, &id)
	if err != nil {
		return err
	}
	if err = s.deleteJobRows(
		ctx,
		tx,
		q,
		p,
		job,
		runs,
		input.DeleteRecordedRuns,
		input.ReverseConsumption,
		requestID,
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// deleteJobRows deletes a locked job with its locked runs: manual runs (and
// recorded runs with deleteRecorded) are tombstoned, the other recorded runs
// are detached. The caller has checked permissions, the version and the
// order guard.
func (s *Service) deleteJobRows(
	ctx context.Context,
	tx pgx.Tx,
	q *machinelogbookdb.Queries,
	p authorization.Principal,
	job machinelogbookdb.MachineJob,
	runs []machinelogbookdb.MachineRun,
	deleteRecorded, reverseConsumption bool,
	requestID *uuid.UUID,
) error {
	var deleting, detaching []machinelogbookdb.MachineRun
	for _, run := range runs {
		if run.Source == "manual" || deleteRecorded {
			deleting = append(deleting, run)
		} else {
			detaching = append(detaching, run)
		}
	}
	reversed := false
	if reverseConsumption {
		quantity, err := s.reverseRunConsumption(ctx, tx, q, p, deleting, requestID)
		if err != nil {
			return err
		}
		reversed = quantity.IsPositive()
	}
	at := pgTime(timePtr(s.now()))
	for _, run := range deleting {
		if err := q.SoftDeleteMachineRun(
			ctx,
			machinelogbookdb.SoftDeleteMachineRunParams{ID: run.ID, DeletedAt: at, DeletedBy: deletedBy(p)},
		); err != nil {
			return databaseError(err)
		}
		if err := auditDeletedRun(ctx, tx, p, run, reversed, requestID); err != nil {
			return err
		}
	}
	for _, run := range detaching {
		if _, err := q.DetachRunFromJob(ctx, run.ID); err != nil {
			return databaseError(err)
		}
	}
	if _, err := q.SoftDeleteMachineJob(
		ctx,
		machinelogbookdb.SoftDeleteMachineJobParams{
			ID:              job.ID,
			ExpectedVersion: job.Version,
			DeletedAt:       at,
			DeletedBy:       deletedBy(p),
		},
	); err != nil {
		if err == pgx.ErrNoRows {
			return apperror.StaleWrite
		}
		return databaseError(err)
	}
	fields := []string{"deletedAt", "runs"}
	if reversed {
		fields = append(fields, "usages", "inventory")
	}
	if len(detaching) > 0 {
		fields = append(fields, "recordedRunsDetached")
	}
	for _, run := range deleting {
		if run.Source == "recorded" {
			fields = append(fields, "recordedRunsDeleted")
			break
		}
	}
	return writeAudit(ctx, tx, p, "machine_job.deleted", "machine_job", job.ID, requestID, fields)
}
