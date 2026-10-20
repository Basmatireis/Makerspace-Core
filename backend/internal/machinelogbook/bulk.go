package machinelogbook

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"sort"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/optional"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// bulkLimit is the most items one bulk request may name per list.
const bulkLimit = 100

// BulkItem names a job or run together with the version the caller saw.
type BulkItem struct {
	ID              uuid.UUID
	ExpectedVersion int64
}

// BulkBlocker is one item that keeps a bulk request from running. A bulk
// request is all-or-nothing: when any item is blocked nothing changes and the
// request is refused with 409 bulk_blocked listing every blocker.
type BulkBlocker struct {
	Kind      WorkItemKind
	ID        uuid.UUID
	DisplayID string
	Code      string
	Message   string
}

func bulkBlockedError(blockers []BulkBlocker) error {
	err := apperror.New(http.StatusConflict, "bulk_blocked", "Some items cannot be processed; nothing was changed")
	items := make([]map[string]any, 0, len(blockers))
	for _, b := range blockers {
		items = append(
			items,
			map[string]any{
				"kind":      b.Kind,
				"id":        b.ID.String(),
				"displayId": b.DisplayID,
				"code":      b.Code,
				"message":   b.Message,
			},
		)
	}
	err.Details["items"] = items
	return err
}

// validateBulkItems checks one list of a bulk request: bounded, positive
// versions and no repeated ID. It returns a copy sorted by ID, the order in
// which rows are locked.
func validateBulkItems(items []BulkItem, name string) ([]BulkItem, error) {
	if len(items) > bulkLimit {
		return nil, apperror.Invalid(name + " is limited to 100 items")
	}
	seen := map[uuid.UUID]bool{}
	for _, item := range items {
		if item.ExpectedVersion < 1 {
			return nil, apperror.Invalid("expectedVersion must be positive")
		}
		if seen[item.ID] {
			return nil, apperror.Invalid(name + " must not name an item twice")
		}
		seen[item.ID] = true
	}
	sorted := append([]BulkItem(nil), items...)
	sort.Slice(sorted, func(i, j int) bool { return bytes.Compare(sorted[i].ID[:], sorted[j].ID[:]) < 0 })
	return sorted, nil
}

func runStart(run machinelogbookdb.MachineRun) time.Time {
	if run.StartedAt.Valid {
		return run.StartedAt.Time
	}
	return run.FirstObservedAt.Time
}

// BulkDeleteInput deletes jobs and unassigned recorded runs together.
type BulkDeleteInput struct {
	Jobs []BulkItem
	Runs []BulkItem
	// DeleteRecordedRuns deletes the recorded runs of the listed jobs too;
	// otherwise they are detached and become unassigned runs.
	DeleteRecordedRuns bool
	// ReverseConsumption restores the consumed material of every deleted run.
	ReverseConsumption bool
}

// BulkDelete deletes several jobs and unassigned recorded runs in one
// transaction with the rules of DeleteJob and DeleteRun: a job on an order
// cannot be deleted. Standalone runs must be unassigned; delete the job or use
// DeleteRun for a run that belongs to one. Rows are locked jobs first, then
// the runs of those jobs, then the listed runs, each in ID order, and the
// consumed materials are locked in ID order before any is restored. If any
// item is blocked, nothing is deleted (409 bulk_blocked).
func (s *Service) BulkDelete(
	ctx context.Context,
	p authorization.Principal,
	input BulkDeleteInput,
	requestID *uuid.UUID,
) error {
	if err := require(p, authorization.MachineJobsDelete); err != nil {
		return err
	}
	if len(input.Jobs)+len(input.Runs) == 0 {
		return apperror.Invalid("name at least one job or run")
	}
	jobItems, err := validateBulkItems(input.Jobs, "jobs")
	if err != nil {
		return err
	}
	runItems, err := validateBulkItems(input.Runs, "runs")
	if err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)

	type lockedJob struct {
		job  machinelogbookdb.MachineJob
		runs []machinelogbookdb.MachineRun
	}
	var blockers []BulkBlocker
	var jobs []lockedJob
	for _, item := range jobItems {
		job, err := q.GetMachineJobForUpdate(ctx, item.ID)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				blockers = append(
					blockers,
					BulkBlocker{Kind: "job", ID: item.ID, Code: "not_found", Message: "The job no longer exists"},
				)
				continue
			}
			return err
		}
		if job.Version != item.ExpectedVersion {
			blockers = append(
				blockers,
				BulkBlocker{
					Kind:      WorkItemJob,
					ID:        item.ID,
					DisplayID: job.DisplayID,
					Code:      "stale_write",
					Message:   job.DisplayID + " changed; reload the list and try again",
				},
			)
			continue
		}
		onOrder, err := q.JobIsOnOrder(ctx, item.ID)
		if err != nil {
			return err
		}
		if onOrder {
			blockers = append(
				blockers,
				BulkBlocker{
					Kind:      WorkItemJob,
					ID:        item.ID,
					DisplayID: job.DisplayID,
					Code:      "job_on_order",
					Message:   job.DisplayID + " is on an order and cannot be deleted",
				},
			)
			continue
		}
		runs, err := q.ListJobRunsForUpdate(ctx, &item.ID)
		if err != nil {
			return err
		}
		jobs = append(jobs, lockedJob{job: job, runs: runs})
	}
	var standalone []machinelogbookdb.MachineRun
	for _, item := range runItems {
		run, err := q.GetRunForUpdate(ctx, item.ID)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				blockers = append(
					blockers,
					BulkBlocker{Kind: "run", ID: item.ID, Code: "not_found", Message: "The run no longer exists"},
				)
				continue
			}
			return err
		}
		switch {
		case run.JobID != nil:
			blockers = append(
				blockers,
				BulkBlocker{
					Kind:      WorkItemRun,
					ID:        item.ID,
					DisplayID: run.DisplayID,
					Code:      "run_assigned",
					Message:   run.DisplayID + " belongs to a job; delete or edit the job instead",
				},
			)
		case run.Version != item.ExpectedVersion:
			blockers = append(
				blockers,
				BulkBlocker{
					Kind:      WorkItemRun,
					ID:        item.ID,
					DisplayID: run.DisplayID,
					Code:      "stale_write",
					Message:   run.DisplayID + " changed; reload the list and try again",
				},
			)
		default:
			standalone = append(standalone, run)
		}
	}
	if len(blockers) > 0 {
		return bulkBlockedError(blockers)
	}

	if input.ReverseConsumption {
		var deleting []machinelogbookdb.MachineRun
		for _, entry := range jobs {
			for _, run := range entry.runs {
				if RunSource(run.Source) == RunSourceManual || input.DeleteRecordedRuns {
					deleting = append(deleting, run)
				}
			}
		}
		deleting = append(deleting, standalone...)
		if err = s.lockRunMaterials(ctx, q, deleting); err != nil {
			return err
		}
	}
	for _, entry := range jobs {
		if err = s.deleteJobRows(
			ctx,
			tx,
			q,
			p,
			entry.job,
			entry.runs,
			input.DeleteRecordedRuns,
			input.ReverseConsumption,
			requestID,
		); err != nil {
			return err
		}
	}
	for _, run := range standalone {
		if err = s.deleteRunRows(ctx, tx, q, p, run, input.ReverseConsumption, requestID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// lockRunMaterials locks every material the active usages of the runs
// consumed, in ID order, so concurrent bulk operations restore material in one
// consistent lock order.
func (s *Service) lockRunMaterials(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	runs []machinelogbookdb.MachineRun,
) error {
	materialIDs := map[uuid.UUID]bool{}
	for _, run := range runs {
		active, err := q.ListActiveRunUsagesForUpdate(ctx, run.ID)
		if err != nil {
			return err
		}
		for _, u := range active {
			if UsageOwnership(u.Ownership) != OwnershipExternal && u.MaterialID != nil {
				materialIDs[*u.MaterialID] = true
			}
		}
	}
	ids := make([]uuid.UUID, 0, len(materialIDs))
	for id := range materialIDs {
		ids = append(ids, id)
	}
	return lockMaterials(ctx, q, ids...)
}

// BulkRunJobInput is what staff supply to turn several unassigned runs into
// jobs. Title is only used when the runs are combined into one job; separate
// jobs are named after their run's file.
type BulkRunJobInput struct {
	Runs             []BulkItem
	Title            *string
	Customer         PartyReference
	OperatorPersonID uuid.UUID
	Notes            *string
	PricingGroupID   *uuid.UUID
}

// CreatedJob identifies a job a bulk operation created.
type CreatedJob struct {
	ID        uuid.UUID
	DisplayID string
	Title     *string
}

// lockUnassignedRuns locks the runs in ID order. It reports runs that are gone, changed or already assigned as
// blockers.
func (s *Service) lockUnassignedRuns(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	items []BulkItem,
) ([]machinelogbookdb.MachineRun, []BulkBlocker, error) {
	var runs []machinelogbookdb.MachineRun
	var blockers []BulkBlocker
	for _, item := range items {
		run, err := q.GetRunForUpdate(ctx, item.ID)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				blockers = append(
					blockers,
					BulkBlocker{Kind: "run", ID: item.ID, Code: "not_found", Message: "The run no longer exists"},
				)
				continue
			}
			return nil, nil, err
		}
		switch {
		case run.JobID != nil:
			blockers = append(
				blockers,
				BulkBlocker{
					Kind:      WorkItemRun,
					ID:        item.ID,
					DisplayID: run.DisplayID,
					Code:      "run_already_assigned",
					Message:   run.DisplayID + " already belongs to a job",
				},
			)
		case run.Version != item.ExpectedVersion:
			blockers = append(
				blockers,
				BulkBlocker{
					Kind:      WorkItemRun,
					ID:        item.ID,
					DisplayID: run.DisplayID,
					Code:      "stale_write",
					Message:   run.DisplayID + " changed; reload the list and try again",
				},
			)
		default:
			runs = append(runs, run)
		}
	}
	return runs, blockers, nil
}

// lockActiveMachines locks the machines of the runs in ID order and reports
// the runs of retired machines as blockers.
func (s *Service) lockActiveMachines(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	runs []machinelogbookdb.MachineRun,
	retiredMessage string,
) ([]BulkBlocker, error) {
	machineIDs := map[uuid.UUID]bool{}
	for _, run := range runs {
		machineIDs[run.MachineID] = true
	}
	ordered := make([]uuid.UUID, 0, len(machineIDs))
	for id := range machineIDs {
		ordered = append(ordered, id)
	}
	sort.Slice(ordered, func(i, j int) bool { return bytes.Compare(ordered[i][:], ordered[j][:]) < 0 })
	retired := map[uuid.UUID]bool{}
	for _, id := range ordered {
		machine, err := q.GetMachineForUpdate(ctx, id)
		if err != nil {
			return nil, noRows(err)
		}
		retired[id] = MachineStatus(machine.Status) == MachineStatusRetired
	}
	var blockers []BulkBlocker
	for _, run := range runs {
		if retired[run.MachineID] {
			blockers = append(
				blockers,
				BulkBlocker{
					Kind:      WorkItemRun,
					ID:        run.ID,
					DisplayID: run.DisplayID,
					Code:      "machine_retired",
					Message:   run.DisplayID + ": " + retiredMessage,
				},
			)
		}
	}
	return blockers, nil
}

func auditRunAssigned(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	run machinelogbookdb.MachineRun,
	jobID uuid.UUID,
	requestID *uuid.UUID,
) error {
	event := audit.Event{
		ActorAccountID: accountPointer(p),
		Action:         "machine_run.assigned",
		ResourceType:   "machine_run",
		ResourceID:     &run.ID,
		RequestID:      requestID,
		ChangedFields:  []string{"jobId"},
		Metadata:       map[string]any{"jobId": jobID.String()},
	}
	if event.ActorAccountID == nil {
		event.ActorType = "system"
	}
	return audit.Write(ctx, tx, event)
}

// bulkJobSettings validates the shared customer, operator and pricing group of
// a bulk job creation once.
func (s *Service) bulkJobSettings(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	input BulkRunJobInput,
) (personID, organizationID *uuid.UUID, group machinelogbookdb.PricingGroup, err error) {
	personID, organizationID, err = validateJobAssignments(ctx, q, input.Customer, input.OperatorPersonID, false)
	if err != nil {
		return nil, nil, group, err
	}
	group, err = resolvePricingGroup(ctx, q, personID, organizationID, input.PricingGroupID)
	return personID, organizationID, group, err
}

// BulkCreateJobsFromRuns creates one job per unassigned recorded run with the
// rules of CreateJobFromRun. Customer, operator, notes and pricing group are
// shared; every job is named after its run's file. Jobs are created in the
// order the runs started. All-or-nothing.
func (s *Service) BulkCreateJobsFromRuns(
	ctx context.Context,
	p authorization.Principal,
	input BulkRunJobInput,
	requestID *uuid.UUID,
) ([]CreatedJob, error) {
	if err := require(p, authorization.MachineJobsCreate); err != nil {
		return nil, err
	}
	if len(input.Runs) == 0 {
		return nil, apperror.Invalid("name at least one run")
	}
	items, err := validateBulkItems(input.Runs, "runs")
	if err != nil {
		return nil, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	runs, blockers, err := s.lockUnassignedRuns(ctx, q, items)
	if err != nil {
		return nil, err
	}
	more, err := s.lockActiveMachines(ctx, q, runs, "retired machines cannot receive new jobs")
	if err != nil {
		return nil, err
	}
	if blockers = append(blockers, more...); len(blockers) > 0 {
		return nil, bulkBlockedError(blockers)
	}
	personID, organizationID, group, err := s.bulkJobSettings(ctx, q, input)
	if err != nil {
		return nil, err
	}
	notes := optional.Trimmed(input.Notes)
	sort.SliceStable(runs, func(i, j int) bool {
		if a, b := runStart(runs[i]), runStart(runs[j]); !a.Equal(b) {
			return a.Before(b)
		}
		return bytes.Compare(runs[i].ID[:], runs[j].ID[:]) < 0
	})
	created := make([]CreatedJob, 0, len(runs))
	for _, run := range runs {
		job, err := s.insertJob(
			ctx,
			q,
			s.now(),
			run.MachineID,
			personID,
			organizationID,
			input.OperatorPersonID,
			nil,
			notes,
		)
		if err != nil {
			return nil, err
		}
		if _, err = q.AssignRunToJob(
			ctx,
			machinelogbookdb.AssignRunToJobParams{JobID: &job.ID, ID: run.ID, MachineID: run.MachineID},
		); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, apperror.Conflicting("run_already_assigned", "The run already belongs to a job")
			}
			return nil, databaseError(err)
		}
		if job, err = s.capturePricingSnapshot(ctx, q, p, job, group, SnapshotInitial); err != nil {
			return nil, err
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
			return nil, err
		}
		if err = auditRunAssigned(ctx, tx, p, run, job.ID, requestID); err != nil {
			return nil, err
		}
		created = append(created, CreatedJob{ID: job.ID, DisplayID: job.DisplayID, Title: job.Title})
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return created, nil
}

// BulkCombineRuns creates one job that contains all the unassigned recorded
// runs. A job has one machine, so the runs must all be on the same machine
// (422 runs_on_different_machines).
func (s *Service) BulkCombineRuns(
	ctx context.Context,
	p authorization.Principal,
	input BulkRunJobInput,
	requestID *uuid.UUID,
) (MachineJob, error) {
	if err := require(p, authorization.MachineJobsCreate); err != nil {
		return MachineJob{}, err
	}
	if len(input.Runs) < 2 {
		return MachineJob{}, apperror.Invalid("name at least two runs to combine")
	}
	title, err := cleanTitle(input.Title)
	if err != nil {
		return MachineJob{}, err
	}
	items, err := validateBulkItems(input.Runs, "runs")
	if err != nil {
		return MachineJob{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MachineJob{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	runs, blockers, err := s.lockUnassignedRuns(ctx, q, items)
	if err != nil {
		return MachineJob{}, err
	}
	more, err := s.lockActiveMachines(ctx, q, runs, "retired machines cannot receive new jobs")
	if err != nil {
		return MachineJob{}, err
	}
	if blockers = append(blockers, more...); len(blockers) > 0 {
		return MachineJob{}, bulkBlockedError(blockers)
	}
	for _, run := range runs[1:] {
		if run.MachineID != runs[0].MachineID {
			return MachineJob{}, apperror.New(
				http.StatusUnprocessableEntity,
				"runs_on_different_machines",
				"A job has one machine; the runs were recorded on different machines",
			)
		}
	}
	personID, organizationID, group, err := s.bulkJobSettings(ctx, q, input)
	if err != nil {
		return MachineJob{}, err
	}
	job, err := s.insertJob(
		ctx,
		q,
		s.now(),
		runs[0].MachineID,
		personID,
		organizationID,
		input.OperatorPersonID,
		title,
		optional.Trimmed(input.Notes),
	)
	if err != nil {
		return MachineJob{}, err
	}
	for _, run := range runs {
		if _, err = q.AssignRunToJob(
			ctx,
			machinelogbookdb.AssignRunToJobParams{JobID: &job.ID, ID: run.ID, MachineID: job.MachineID},
		); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return MachineJob{}, apperror.Conflicting("run_already_assigned", "The run already belongs to a job")
			}
			return MachineJob{}, databaseError(err)
		}
	}
	if job, err = s.capturePricingSnapshot(ctx, q, p, job, group, SnapshotInitial); err != nil {
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
	for _, run := range runs {
		if err = auditRunAssigned(ctx, tx, p, run, job.ID, requestID); err != nil {
			return MachineJob{}, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return MachineJob{}, err
	}
	return s.loadJob(ctx, job.ID)
}

// BulkAttachInput attaches several unassigned recorded runs to one job.
type BulkAttachInput struct {
	JobID              uuid.UUID
	ExpectedJobVersion int64
	Runs               []BulkItem
	ReplaceManualRuns  bool
}

// BulkAttachRuns attaches the runs to a job on the same machine with the rules
// of AttachRun: one version check of the job, the job is repriced once.
func (s *Service) BulkAttachRuns(
	ctx context.Context,
	p authorization.Principal,
	input BulkAttachInput,
	requestID *uuid.UUID,
) (MachineJob, error) {
	if err := require(p, authorization.MachineJobsEdit); err != nil {
		return MachineJob{}, err
	}
	if input.ExpectedJobVersion < 1 {
		return MachineJob{}, apperror.Invalid("expectedJobVersion must be positive")
	}
	if len(input.Runs) == 0 {
		return MachineJob{}, apperror.Invalid("name at least one run")
	}
	items, err := validateBulkItems(input.Runs, "runs")
	if err != nil {
		return MachineJob{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MachineJob{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	job, err := q.GetMachineJobForUpdate(ctx, input.JobID)
	if err != nil {
		return MachineJob{}, noRows(err)
	}
	if job.Version != input.ExpectedJobVersion {
		return MachineJob{}, apperror.StaleWrite
	}
	runs, blockers, err := s.lockUnassignedRuns(ctx, q, items)
	if err != nil {
		return MachineJob{}, err
	}
	for _, run := range runs {
		switch {
		case job.MachineID != run.MachineID:
			blockers = append(
				blockers,
				BulkBlocker{
					Kind:      WorkItemRun,
					ID:        run.ID,
					DisplayID: run.DisplayID,
					Code:      "run_machine_mismatch",
					Message:   run.DisplayID + " was recorded on another machine than " + job.DisplayID,
				},
			)
		case job.ArtifactID != nil && run.ArtifactID != nil && *job.ArtifactID != *run.ArtifactID:
			blockers = append(
				blockers,
				BulkBlocker{
					Kind:      WorkItemRun,
					ID:        run.ID,
					DisplayID: run.DisplayID,
					Code:      "artifact_mismatch",
					Message:   run.DisplayID + " and " + job.DisplayID + " reference different print artifacts",
				},
			)
		}
	}
	if len(blockers) > 0 {
		return MachineJob{}, bulkBlockedError(blockers)
	}
	fields := []string{"runs", "calculatedPrice", "effectivePrice"}
	if input.ReplaceManualRuns {
		replaced, err := s.replaceManualRuns(ctx, tx, q, p, job.ID, requestID)
		if err != nil {
			return MachineJob{}, err
		}
		fields = append(fields, replaced...)
	}
	for _, run := range runs {
		if _, err = q.AssignRunToJob(
			ctx,
			machinelogbookdb.AssignRunToJobParams{JobID: &job.ID, ID: run.ID, MachineID: job.MachineID},
		); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return MachineJob{}, apperror.Conflicting("run_already_assigned", "The run already belongs to a job")
			}
			return MachineJob{}, databaseError(err)
		}
	}
	if _, err = s.settleJob(ctx, q, job.ID); err != nil {
		return MachineJob{}, err
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"machine_job.run_attached",
		"machine_job",
		job.ID,
		requestID,
		dedupe(fields),
	); err != nil {
		return MachineJob{}, err
	}
	for _, run := range runs {
		if err = auditRunAssigned(ctx, tx, p, run, job.ID, requestID); err != nil {
			return MachineJob{}, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return MachineJob{}, err
	}
	return s.loadJob(ctx, job.ID)
}
