package machinelogbook

import (
	"context"
	"errors"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/optional"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// CreateJobFromRun creates a job for an unassigned recorded run; the run may
// still be running.
func (s *Service) CreateJobFromRun(
	ctx context.Context,
	p authorization.Principal,
	runID uuid.UUID,
	input RunJobInput,
	requestID *uuid.UUID,
) (MachineJob, error) {
	if err := require(p, authorization.MachineJobsCreate); err != nil {
		return MachineJob{}, err
	}
	title, err := cleanTitle(input.Title)
	if err != nil {
		return MachineJob{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MachineJob{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	run, err := q.GetRunForUpdate(ctx, runID)
	if err != nil {
		return MachineJob{}, noRows(err)
	}
	if run.JobID != nil {
		return MachineJob{}, apperror.Conflicting("run_already_assigned", "The run already belongs to a job")
	}
	machine, err := q.GetMachineForUpdate(ctx, run.MachineID)
	if err != nil {
		return MachineJob{}, noRows(err)
	}
	if MachineStatus(machine.Status) == MachineStatusRetired {
		return MachineJob{}, apperror.Conflicting("machine_retired", "Retired machines cannot receive new jobs")
	}
	personID, organizationID, err := validateJobAssignments(ctx, q, input.Customer, input.OperatorPersonID, false)
	if err != nil {
		return MachineJob{}, err
	}
	group, err := resolvePricingGroup(ctx, q, personID, organizationID, input.PricingGroupID)
	if err != nil {
		return MachineJob{}, err
	}
	job, err := s.insertJob(
		ctx,
		q,
		s.now(),
		run.MachineID,
		personID,
		organizationID,
		input.OperatorPersonID,
		title,
		optional.Trimmed(input.Notes),
	)
	if err != nil {
		return MachineJob{}, err
	}
	if _, err = q.AssignRunToJob(
		ctx,
		machinelogbookdb.AssignRunToJobParams{JobID: &job.ID, ID: runID, MachineID: run.MachineID},
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return MachineJob{}, apperror.Conflicting("run_already_assigned", "The run already belongs to a job")
		}
		return MachineJob{}, databaseError(err)
	}
	job, err = s.capturePricingSnapshot(ctx, q, p, job, group, SnapshotInitial)
	if err != nil {
		return MachineJob{}, err
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"machine_job.created",
		"machine_job",
		job.ID,
		requestID,
		[]string{"machineId", "title", "customer", "operatorPersonId", "notes", "runs", "pricingSnapshot"},
	); err != nil {
		return MachineJob{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MachineJob{}, err
	}
	return s.loadJob(ctx, job.ID)
}

// AttachRun attaches an unassigned recorded run to a job on the same machine.
// With replaceManualRuns the job's manual runs are marked replaced and their
// material is reversed with compensating transactions, so the recorded run
// stands in for the manually entered work.
func (s *Service) AttachRun(
	ctx context.Context,
	p authorization.Principal,
	runID, jobID uuid.UUID,
	replaceManualRuns bool,
	expectedJobVersion int64,
	requestID *uuid.UUID,
) (MachineJob, error) {
	if err := require(p, authorization.MachineJobsEdit); err != nil {
		return MachineJob{}, err
	}
	if expectedJobVersion < 1 {
		return MachineJob{}, apperror.Invalid("expectedJobVersion must be positive")
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
	run, err := q.GetRunForUpdate(ctx, runID)
	if err != nil {
		return MachineJob{}, noRows(err)
	}
	if run.JobID != nil {
		return MachineJob{}, apperror.Conflicting("run_already_assigned", "The run already belongs to a job")
	}
	if job.MachineID != run.MachineID {
		return MachineJob{}, apperror.Conflicting(
			"run_machine_mismatch",
			"The run was recorded on another machine than the job",
		)
	}
	if job.ArtifactID != nil && run.ArtifactID != nil && *job.ArtifactID != *run.ArtifactID {
		return MachineJob{}, apperror.Conflicting(
			"artifact_mismatch",
			"Run and job reference different print artifacts",
		)
	}
	if job.Version != expectedJobVersion {
		return MachineJob{}, apperror.StaleWrite
	}
	fields := []string{"runs", "calculatedPrice", "effectivePrice"}
	if replaceManualRuns {
		replaced, err := s.replaceManualRuns(ctx, tx, q, p, jobID, requestID)
		if err != nil {
			return MachineJob{}, err
		}
		fields = append(fields, replaced...)
	}
	if _, err = q.AssignRunToJob(
		ctx,
		machinelogbookdb.AssignRunToJobParams{JobID: &jobID, ID: runID, MachineID: job.MachineID},
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return MachineJob{}, apperror.Conflicting("run_already_assigned", "The run already belongs to a job")
		}
		return MachineJob{}, databaseError(err)
	}
	if _, err = s.settleJob(ctx, q, jobID); err != nil {
		return MachineJob{}, err
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"machine_job.run_attached",
		"machine_job",
		jobID,
		requestID,
		dedupe(fields),
	); err != nil {
		return MachineJob{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MachineJob{}, err
	}
	return s.loadJob(ctx, jobID)
}

// replaceManualRuns marks the manual runs of a locked job as replaced and
// reverses their material with compensating inventory transactions. It
// returns the audit fields it touched beyond the run list.
func (s *Service) replaceManualRuns(
	ctx context.Context,
	tx pgx.Tx,
	q *machinelogbookdb.Queries,
	p authorization.Principal,
	jobID uuid.UUID,
	requestID *uuid.UUID,
) ([]string, error) {
	var fields []string
	runs, err := q.ListJobRunsForUpdate(ctx, &jobID)
	if err != nil {
		return nil, err
	}
	for _, existing := range runs {
		if RunSource(existing.Source) != RunSourceManual || (existing.State != nil && RunState(*existing.State) == RunStateReplaced) {
			continue
		}
		old, err := q.ListActiveRunUsagesForUpdate(ctx, existing.ID)
		if err != nil {
			return nil, err
		}
		if len(old) > 0 {
			if err = s.replaceRunUsages(ctx, tx, q, p, existing.ID, old, nil, time.Now().UTC(), requestID); err != nil {
				return nil, err
			}
			fields = append(fields, "usages", "inventory")
		}
		if err = q.MarkManualRunReplaced(ctx, existing.ID); err != nil {
			return nil, databaseError(err)
		}
	}
	return fields, nil
}

// AttachPlannedRunSystem performs the connector-only exact-artifact attach in
// the caller's transaction. It never replaces a staff assignment and only
// accepts a job that still has no active runs and references the same artifact.
func (s *Service) AttachPlannedRunSystem(
	ctx context.Context,
	tx pgx.Tx,
	connectorID, assignmentID, runID, jobID, artifactID uuid.UUID,
	requestID *uuid.UUID,
) (bool, error) {
	q := machinelogbookdb.New(tx)
	job, err := q.GetMachineJobForUpdate(ctx, jobID)
	if err != nil {
		return false, noRows(err)
	}
	run, err := q.GetRunForUpdate(ctx, runID)
	if err != nil {
		return false, noRows(err)
	}
	if run.JobID != nil {
		return false, nil
	}
	if job.ArtifactID == nil || run.ArtifactID == nil || *job.ArtifactID != artifactID ||
		*run.ArtifactID != artifactID ||
		job.MachineID != run.MachineID {
		return false, apperror.Conflicting("artifact_mismatch", "Run and planned job artifacts must match exactly")
	}
	active, err := q.ListActiveJobRunIDs(ctx, &jobID)
	if err != nil {
		return false, err
	}
	if len(active) != 0 {
		return false, nil
	}
	if _, err = q.AssignRunToJob(
		ctx,
		machinelogbookdb.AssignRunToJobParams{JobID: &jobID, ID: runID, MachineID: job.MachineID},
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	if _, err = s.settleJob(ctx, q, jobID); err != nil {
		return false, err
	}
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorType:     "system",
			Action:        "machine_run.artifact_auto_attached",
			ResourceType:  "machine_run",
			ResourceID:    &runID,
			RequestID:     requestID,
			Source:        "system",
			ChangedFields: []string{"jobId"},
			Metadata: map[string]any{
				"connectorId":  connectorID.String(),
				"assignmentId": assignmentID.String(),
				"runId":        runID.String(),
				"jobId":        jobID.String(),
				"artifactId":   artifactID.String(),
			},
		},
	); err != nil {
		return false, err
	}
	return true, nil
}

func dedupe(values []string) []string {
	seen := map[string]bool{}
	result := make([]string, 0, len(values))
	for _, value := range values {
		if !seen[value] {
			seen[value] = true
			result = append(result, value)
		}
	}
	return result
}

// DetachRun detaches a recorded run from its job. The run keeps its material
// and its consumption. When it was the job's only run that is not replaced,
// the job gets a manual run with the same start, end (now while the run still
// runs) and outcome but no material, so the job keeps its times and its
// material then comes only from its remaining runs.
func (s *Service) DetachRun(
	ctx context.Context,
	p authorization.Principal,
	runID uuid.UUID,
	expectedJobVersion int64,
	requestID *uuid.UUID,
) (MachineJob, error) {
	if err := require(p, authorization.MachineJobsEdit); err != nil {
		return MachineJob{}, err
	}
	if expectedJobVersion < 1 {
		return MachineJob{}, apperror.Invalid("expectedJobVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MachineJob{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	run, job, err := s.lockedRun(ctx, tx, runID)
	if err != nil {
		return MachineJob{}, err
	}
	if RunSource(run.Source) != RunSourceRecorded {
		return MachineJob{}, apperror.Conflicting("run_not_recorded", "Only recorded runs can be detached")
	}
	if job == nil {
		return MachineJob{}, apperror.Conflicting("run_not_assigned", "The run does not belong to a job")
	}
	if job.Version != expectedJobVersion {
		return MachineJob{}, apperror.StaleWrite
	}
	active, err := q.ListActiveJobRunIDs(ctx, &job.ID)
	if err != nil {
		return MachineJob{}, err
	}
	if len(active) == 1 {
		now := s.now().UTC().Truncate(time.Second)
		start := run.FirstObservedAt.Time
		if run.StartedAt.Valid {
			start = run.StartedAt.Time
		}
		end := now
		if run.EndedAt.Valid {
			end = run.EndedAt.Time
		}
		if earliest := start.Add(time.Second); end.Before(earliest) {
			end = earliest
		}
		plan := manualRunPlan{StartsAt: start.UTC(), EndsAt: end.UTC(), Outcome: pointerAs[RunOutcome](run.Outcome)}
		if _, err = s.storeManualRun(ctx, tx, q, p, *job, plan, requestID); err != nil {
			return MachineJob{}, err
		}
	}
	if _, err = q.DetachRunFromJob(ctx, runID); err != nil {
		return MachineJob{}, databaseError(err)
	}
	if _, err = s.settleJob(ctx, q, job.ID); err != nil {
		return MachineJob{}, err
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"machine_job.run_detached",
		"machine_job",
		job.ID,
		requestID,
		[]string{"runs", "calculatedPrice", "effectivePrice"},
	); err != nil {
		return MachineJob{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MachineJob{}, err
	}
	return s.loadJob(ctx, job.ID)
}
