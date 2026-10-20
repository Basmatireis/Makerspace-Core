package machinelogbook

import (
	"bytes"
	"context"
	"errors"
	"sort"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// replaceRunUsages reverses the given active usages with compensating
// inventory transactions, deactivates them and records the new usages with
// their consumption. The caller holds the locks on the run (and its job).
func (s *Service) replaceRunUsages(
	ctx context.Context,
	tx pgx.Tx,
	q *machinelogbookdb.Queries,
	p authorization.Principal,
	runID uuid.UUID,
	old []machinelogbookdb.MachineRunUsage,
	parsed []parsedUsage,
	occurredAt time.Time,
	requestID *uuid.UUID,
) error {
	materialIDs := map[uuid.UUID]bool{}
	for _, u := range old {
		if u.Ownership == "makerspace" && u.MaterialID != nil {
			materialIDs[*u.MaterialID] = true
		}
	}
	for _, u := range parsed {
		if u.Ownership == "makerspace" && u.MaterialID != nil {
			materialIDs[*u.MaterialID] = true
		}
	}
	ordered := make([]uuid.UUID, 0, len(materialIDs))
	for materialID := range materialIDs {
		ordered = append(ordered, materialID)
	}
	sort.Slice(ordered, func(i, j int) bool { return bytes.Compare(ordered[i][:], ordered[j][:]) < 0 })
	versions := map[uuid.UUID]int64{}
	for _, materialID := range ordered {
		row, err := q.GetMaterialForUpdate(ctx, materialID)
		if err != nil {
			return noRows(err)
		}
		versions[materialID] = row.InventoryVersion
	}
	for _, u := range old {
		if u.Ownership != "external" {
			row, err := q.GetMaterialForUpdate(ctx, *u.MaterialID)
			if err != nil {
				return err
			}
			average := decimalFromNumeric(row.AverageUnitCost)
			quantity := decimalFromNumeric(u.Quantity)
			reversal, err := s.reversalFill(ctx, q, u)
			if err != nil {
				return err
			}
			usageID := u.ID
			if _, err = s.applyInventoryMutation(
				ctx,
				tx,
				q,
				p,
				*u.MaterialID,
				versions[*u.MaterialID],
				inventoryMutation{
					Kind:          "adjustment",
					QuantityDelta: quantity,
					UnitCost:      average,
					ValueDelta:    quantity.Mul(average),
					OccurredAt:    time.Now().UTC(),
					Reason:        stringPointer("job_corrected"),
					UsageID:       &usageID,
					Fill:          reversal,
				},
				requestID,
			); err != nil {
				return err
			}
			versions[*u.MaterialID]++
		}
		if err := q.DeactivateRunUsage(ctx, u.ID); err != nil {
			return err
		}
	}
	if err := s.resolveUsageFills(ctx, q, parsed); err != nil {
		return err
	}
	if err := s.insertUsages(ctx, q, runID, parsed); err != nil {
		return err
	}
	for _, u := range parsed {
		if u.Ownership == "external" {
			continue
		}
		row, err := q.GetMaterialForUpdate(ctx, *u.MaterialID)
		if err != nil {
			return err
		}
		average := decimalFromNumeric(row.AverageUnitCost)
		usageID := u.UsageID
		if _, err = s.applyInventoryMutation(
			ctx,
			tx,
			q,
			p,
			*u.MaterialID,
			versions[*u.MaterialID],
			inventoryMutation{
				Kind:          "machine_run_consumption",
				QuantityDelta: u.Quantity.Neg(),
				UnitCost:      average,
				ValueDelta:    u.Quantity.Mul(average).Neg(),
				OccurredAt:    occurredAt,
				UsageID:       &usageID,
				Fill:          u.Fill,
			},
			requestID,
		); err != nil {
			return err
		}
		versions[*u.MaterialID]++
	}
	return nil
}

// lockedRun locks a run and, when it belongs to a job, the job. The job is
// always locked before its runs, the order of every job operation.
func (s *Service) lockedRun(
	ctx context.Context,
	tx pgx.Tx,
	id uuid.UUID,
) (machinelogbookdb.MachineRun, *machinelogbookdb.MachineJob, error) {
	run, job, err := LockRunChain(ctx, tx, id)
	if err != nil {
		return run, nil, err
	}
	return run, job, nil
}

// LockRunChain locks the job of a run and then the run, never the other way
// around, so it cannot deadlock with job operations that lock a job before its
// runs. The run's job is read without a lock; once the job is locked the run is
// locked and its job re-checked. If the run moved to another job meanwhile, the
// locks of the attempt are released and the attempt is repeated once. It
// returns apperror.NotFound for an unknown run.
func LockRunChain(
	ctx context.Context,
	tx pgx.Tx,
	id uuid.UUID,
) (machinelogbookdb.MachineRun, *machinelogbookdb.MachineJob, error) {
	for attempt := 0; attempt < 2; attempt++ {
		run, job, ok, err := tryLockRunChain(ctx, tx, id)
		if err != nil {
			return run, nil, err
		}
		if ok {
			return run, job, nil
		}
	}
	return machinelogbookdb.MachineRun{}, nil, apperror.New(
		409,
		"retry_conflict",
		"The request conflicted with a concurrent change; try again",
	)
}

func tryLockRunChain(
	ctx context.Context,
	tx pgx.Tx,
	id uuid.UUID,
) (machinelogbookdb.MachineRun, *machinelogbookdb.MachineJob, bool, error) {
	attempt, err := tx.Begin(ctx) // a savepoint, so a failed attempt releases its row locks
	if err != nil {
		return machinelogbookdb.MachineRun{}, nil, false, err
	}
	defer func() { _ = attempt.Rollback(ctx) }()
	q := machinelogbookdb.New(attempt)
	base, err := q.GetRunBase(ctx, id)
	if err != nil {
		return base, nil, false, noRows(err)
	}
	var job *machinelogbookdb.MachineJob
	if base.JobID != nil {
		locked, err := q.GetMachineJobForUpdate(ctx, *base.JobID)
		if err != nil {
			return base, nil, false, noRows(err)
		}
		job = &locked
	}
	run, err := q.GetRunForUpdate(ctx, id)
	if err != nil {
		return run, nil, false, noRows(err)
	}
	if (run.JobID == nil) != (base.JobID == nil) || (run.JobID != nil && *run.JobID != *base.JobID) {
		return run, nil, false, nil
	}
	if err = attempt.Commit(ctx); err != nil {
		return run, nil, false, err
	}
	return run, job, true, nil
}

// manualRunState is the state a manual run has at a point in time.
func manualRunState(run machinelogbookdb.MachineRun, now time.Time) string {
	if run.State != nil {
		return *run.State
	}
	if run.EndedAt.Valid && run.EndedAt.Time.After(now) {
		return "running"
	}
	return "finished"
}

// finishRunChange reprices the run's job, audits the change and returns the
// updated run with its job.
func (s *Service) finishRunChange(
	ctx context.Context,
	tx pgx.Tx,
	q *machinelogbookdb.Queries,
	p authorization.Principal,
	run machinelogbookdb.MachineRun,
	action string,
	fields []string,
	requestID *uuid.UUID,
) error {
	if err := writeAudit(ctx, tx, p, action, "machine_run", run.ID, requestID, fields); err != nil {
		return err
	}
	if run.JobID == nil {
		return nil
	}
	if _, err := s.settleJob(ctx, q, *run.JobID); err != nil {
		return err
	}
	return writeAudit(
		ctx,
		tx,
		p,
		"machine_job.repriced",
		"machine_job",
		*run.JobID,
		requestID,
		[]string{"runs", "calculatedPrice", "effectivePrice"},
	)
}

func (s *Service) runResult(ctx context.Context, id uuid.UUID) (RunUpdateResult, error) {
	q := machinelogbookdb.New(s.pool)
	run, err := s.loadRun(ctx, q, id)
	if err != nil {
		return RunUpdateResult{}, err
	}
	result := RunUpdateResult{Run: run}
	if run.Job != nil {
		job, err := s.loadJob(ctx, run.Job.ID)
		if err != nil {
			return RunUpdateResult{}, err
		}
		result.Job = &job
	}
	return result, nil
}

// UpdateRun corrects a run: the outcome of any run and the times of manual
// runs. An outcome cannot be recorded while the run is running.
func (s *Service) UpdateRun(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	input RunUpdate,
	requestID *uuid.UUID,
) (RunUpdateResult, error) {
	if err := require(p, authorization.MachineJobsEdit); err != nil {
		return RunUpdateResult{}, err
	}
	if expected < 1 {
		return RunUpdateResult{}, apperror.Invalid("expectedVersion must be positive")
	}
	outcome, err := validateOptionalOutcome(input.Outcome)
	if err != nil {
		return RunUpdateResult{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return RunUpdateResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	run, _, err := s.lockedRun(ctx, tx, id)
	if err != nil {
		return RunUpdateResult{}, err
	}
	if run.Version != expected {
		return RunUpdateResult{}, apperror.StaleWrite
	}
	now := s.now()
	fields := []string{"outcome"}
	var updated machinelogbookdb.MachineRun
	if run.Source == "manual" {
		if manualRunState(run, now) == "replaced" {
			return RunUpdateResult{}, apperror.Conflicting("run_replaced", "A replaced run cannot be changed")
		}
		startsAt, endsAt := run.StartedAt.Time, run.EndedAt.Time
		if input.StartsAt != nil {
			startsAt = input.StartsAt.UTC()
			fields = append(fields, "startsAt")
		}
		if input.EndsAt != nil {
			endsAt = input.EndsAt.UTC()
			fields = append(fields, "endsAt")
		}
		if err = validateInterval(startsAt, endsAt); err != nil {
			return RunUpdateResult{}, err
		}
		if err = validateOutcomeTiming(endsAt, outcome, now); err != nil {
			return RunUpdateResult{}, err
		}
		if input.Measures != nil {
			process, processErr := machineProcess(ctx, q, run.MachineID)
			if processErr != nil {
				return RunUpdateResult{}, processErr
			}
			if err = validateMeasures(process, input.Measures); err != nil {
				return RunUpdateResult{}, err
			}
			if err = storeRunMeasures(ctx, q, id, input.Measures); err != nil {
				return RunUpdateResult{}, err
			}
			fields = append(fields, "measures")
		}
		updated, err = q.UpdateManualRunFacts(
			ctx,
			machinelogbookdb.UpdateManualRunFactsParams{
				StartedAt:       pgTime(&startsAt),
				EndedAt:         pgTime(&endsAt),
				Outcome:         outcome,
				ID:              id,
				ExpectedVersion: expected,
			},
		)
	} else {
		if input.StartsAt != nil || input.EndsAt != nil {
			return RunUpdateResult{}, apperror.New(
				422,
				"run_times_read_only",
				"The times of a recorded run come from the machine",
			)
		}
		if input.Measures != nil {
			return RunUpdateResult{}, apperror.New(
				422,
				"run_measures_read_only",
				"The measures of a recorded run come from the machine",
			)
		}
		if run.State != nil && *run.State == "running" && outcome != nil {
			return RunUpdateResult{}, apperror.New(
				422,
				"outcome_before_run_end",
				"An outcome cannot be recorded before the run has ended",
			)
		}
		updated, err = q.UpdateRecordedRunOutcome(
			ctx,
			machinelogbookdb.UpdateRecordedRunOutcomeParams{Outcome: outcome, ID: id, ExpectedVersion: expected},
		)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return RunUpdateResult{}, apperror.StaleWrite
	}
	if err != nil {
		return RunUpdateResult{}, databaseError(err)
	}
	if err = s.finishRunChange(ctx, tx, q, p, updated, "machine_run.updated", fields, requestID); err != nil {
		return RunUpdateResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return RunUpdateResult{}, err
	}
	return s.runResult(ctx, id)
}

// ReplaceRunUsages swaps the run's material usage for the given one with
// compensating inventory transactions. Usage set by staff replaces what the
// machine reported.
func (s *Service) ReplaceRunUsages(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	inputs []UsageInput,
	requestID *uuid.UUID,
) (RunUpdateResult, error) {
	if err := require(p, authorization.MachineJobsEdit); err != nil {
		return RunUpdateResult{}, err
	}
	if expected < 1 {
		return RunUpdateResult{}, apperror.Invalid("expectedVersion must be positive")
	}
	parsed, err := parseUsages(inputs)
	if err != nil {
		return RunUpdateResult{}, err
	}
	for i := range parsed {
		parsed[i].StaffCorrected = true
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return RunUpdateResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	run, _, err := s.lockedRun(ctx, tx, id)
	if err != nil {
		return RunUpdateResult{}, err
	}
	if run.Version != expected {
		return RunUpdateResult{}, apperror.StaleWrite
	}
	if run.State != nil && *run.State == "replaced" {
		return RunUpdateResult{}, apperror.Conflicting("run_replaced", "A replaced run cannot be changed")
	}
	old, err := q.ListActiveRunUsagesForUpdate(ctx, id)
	if err != nil {
		return RunUpdateResult{}, err
	}
	process, err := machineProcess(ctx, q, run.MachineID)
	if err != nil {
		return RunUpdateResult{}, err
	}
	// Material the run already used stays allowed, so correcting a run does not
	// fail on material that no longer matches the process.
	keep := map[uuid.UUID]bool{}
	for _, u := range old {
		if u.MaterialID != nil {
			keep[*u.MaterialID] = true
		}
	}
	if err = requireMaterialsForProcess(ctx, q, process, parsed, keep); err != nil {
		return RunUpdateResult{}, err
	}
	if err = s.replaceRunUsages(ctx, tx, q, p, id, old, parsed, time.Now().UTC(), requestID); err != nil {
		return RunUpdateResult{}, err
	}
	updated, err := q.BumpRunVersion(ctx, machinelogbookdb.BumpRunVersionParams{ID: id, ExpectedVersion: expected})
	if errors.Is(err, pgx.ErrNoRows) {
		return RunUpdateResult{}, apperror.StaleWrite
	}
	if err != nil {
		return RunUpdateResult{}, err
	}
	if err = s.finishRunChange(
		ctx,
		tx,
		q,
		p,
		updated,
		"machine_run.usages_replaced",
		[]string{"usages", "inventory"},
		requestID,
	); err != nil {
		return RunUpdateResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return RunUpdateResult{}, err
	}
	return s.runResult(ctx, id)
}

// CancelRun ends a running manual run now and records it as cancelled.
func (s *Service) CancelRun(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) (MachineJob, error) {
	if err := require(p, authorization.MachineJobsEdit); err != nil {
		return MachineJob{}, err
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
	run, _, err := s.lockedRun(ctx, tx, id)
	if err != nil {
		return MachineJob{}, err
	}
	if run.Version != expected {
		return MachineJob{}, apperror.StaleWrite
	}
	now := s.now()
	if run.Source != "manual" || manualRunState(run, now) != "running" {
		return MachineJob{}, apperror.Conflicting("run_not_running", "Only a running manual run can be cancelled")
	}
	endsAt := now.UTC().Truncate(time.Second)
	if earliest := run.StartedAt.Time.Add(time.Second); endsAt.Before(earliest) {
		endsAt = earliest
	}
	updated, err := q.CancelManualRun(
		ctx,
		machinelogbookdb.CancelManualRunParams{EndedAt: pgTime(&endsAt), ID: id, ExpectedVersion: expected},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return MachineJob{}, apperror.StaleWrite
	}
	if err != nil {
		return MachineJob{}, err
	}
	if err = s.finishRunChange(
		ctx,
		tx,
		q,
		p,
		updated,
		"machine_run.cancelled",
		[]string{"endedAt", "state", "outcome"},
		requestID,
	); err != nil {
		return MachineJob{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MachineJob{}, err
	}
	return s.loadJob(ctx, *run.JobID)
}

// AddManualRun adds a manual run, for example a reprint, to a job.
func (s *Service) AddManualRun(
	ctx context.Context,
	p authorization.Principal,
	jobID uuid.UUID,
	expectedJobVersion int64,
	input ManualRunInput,
	requestID *uuid.UUID,
) (MachineJob, error) {
	if err := require(p, authorization.MachineJobsEdit); err != nil {
		return MachineJob{}, err
	}
	if expectedJobVersion < 1 {
		return MachineJob{}, apperror.Invalid("expectedJobVersion must be positive")
	}
	plan, err := planManualRun(input, s.now())
	if err != nil {
		return MachineJob{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MachineJob{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	job, err := q.GetMachineJobForUpdate(ctx, jobID)
	if err != nil {
		return MachineJob{}, noRows(err)
	}
	if job.Version != expectedJobVersion {
		return MachineJob{}, apperror.StaleWrite
	}
	machine, err := q.GetMachineForUpdate(ctx, job.MachineID)
	if err != nil {
		return MachineJob{}, err
	}
	if machine.Status == "retired" {
		return MachineJob{}, apperror.Conflicting("machine_retired", "Retired machines cannot receive new runs")
	}
	if _, err = s.storeManualRun(ctx, tx, q, p, job, plan, requestID); err != nil {
		return MachineJob{}, err
	}
	if _, err = s.settleJob(ctx, q, jobID); err != nil {
		return MachineJob{}, err
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"machine_job.run_added",
		"machine_job",
		jobID,
		requestID,
		[]string{"runs", "usages", "calculatedPrice", "effectivePrice"},
	); err != nil {
		return MachineJob{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MachineJob{}, err
	}
	return s.loadJob(ctx, jobID)
}
