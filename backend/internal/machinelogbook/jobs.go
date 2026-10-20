package machinelogbook

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/optional"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

// manualRunPlan is a validated manual run that is ready to be stored.
type manualRunPlan struct {
	StartsAt, EndsAt time.Time
	Outcome          *RunOutcome
	Usages           []parsedUsage
	Measures         RunMeasures
}

func planManualRun(input ManualRunInput, now time.Time) (manualRunPlan, error) {
	if err := validateInterval(input.StartsAt, input.EndsAt); err != nil {
		return manualRunPlan{}, err
	}
	outcome, err := validateOptionalOutcome(input.Outcome)
	if err != nil {
		return manualRunPlan{}, err
	}
	if err = validateOutcomeTiming(input.EndsAt, outcome, now); err != nil {
		return manualRunPlan{}, err
	}
	parsed, err := parseUsages(input.Usages)
	if err != nil {
		return manualRunPlan{}, err
	}
	return manualRunPlan{
		StartsAt: input.StartsAt.UTC(),
		EndsAt:   input.EndsAt.UTC(),
		Outcome:  outcome,
		Usages:   parsed,
		Measures: input.Measures,
	}, nil
}

// storeManualRun inserts a manual run on the job's machine together with its
// material usage, consuming inventory for it.
func (s *Service) storeManualRun(
	ctx context.Context,
	tx pgx.Tx,
	q *machinelogbookdb.Queries,
	p authorization.Principal,
	job machinelogbookdb.MachineJob,
	plan manualRunPlan,
	requestID *uuid.UUID,
) (machinelogbookdb.MachineRun, error) {
	process, err := machineProcess(ctx, q, job.MachineID)
	if err != nil {
		return machinelogbookdb.MachineRun{}, err
	}
	if err = validateMeasures(process, plan.Measures); err != nil {
		return machinelogbookdb.MachineRun{}, err
	}
	if err = requireMaterialsForProcess(ctx, q, process, plan.Usages, nil); err != nil {
		return machinelogbookdb.MachineRun{}, err
	}
	sequence, err := q.NextMachineRunSequence(ctx)
	if err != nil {
		return machinelogbookdb.MachineRun{}, err
	}
	run, err := q.InsertManualRun(
		ctx,
		machinelogbookdb.InsertManualRunParams{
			ID:        ids.New(),
			DisplayID: formatRunDisplayID(sequence, s.now()),
			MachineID: job.MachineID,
			JobID:     &job.ID,
			StartedAt: pgTime(&plan.StartsAt),
			EndedAt:   pgTime(&plan.EndsAt),
			Outcome:   pointerAs[string](plan.Outcome),
		},
	)
	if err != nil {
		return run, databaseError(err)
	}
	if err = storeRunMeasures(ctx, q, run.ID, plan.Measures); err != nil {
		return run, err
	}
	if err = s.resolveUsageFills(ctx, q, plan.Usages); err != nil {
		return run, err
	}
	if err = s.insertUsages(ctx, q, run.ID, plan.Usages); err != nil {
		return run, err
	}
	if err = s.consumeUsages(ctx, tx, q, p, plan.Usages, plan.EndsAt, requestID); err != nil {
		return run, err
	}
	return run, nil
}

func (s *Service) CreateManualJob(
	ctx context.Context,
	p authorization.Principal,
	input JobInput,
	requestID *uuid.UUID,
) (MachineJob, error) {
	if err := require(p, authorization.MachineJobsCreate); err != nil {
		return MachineJob{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MachineJob{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	job, err := s.CreateManualJobInTransaction(ctx, tx, p, input, requestID)
	if err != nil {
		return MachineJob{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MachineJob{}, err
	}
	return s.loadJob(ctx, job.ID)
}

// CreateManualJobInTransaction creates a job with one manual run.
func (s *Service) CreateManualJobInTransaction(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	input JobInput,
	requestID *uuid.UUID,
) (MachineJob, error) {
	if err := require(p, authorization.MachineJobsCreate); err != nil {
		return MachineJob{}, err
	}
	now := s.now()
	outcome, err := parseOutcome(input.Outcome)
	if err != nil {
		return MachineJob{}, err
	}
	plan, err := planManualRun(
		ManualRunInput{
			StartsAt: input.StartsAt,
			EndsAt:   input.EndsAt,
			Outcome:  outcome,
			Usages:   input.Usages,
			Measures: input.Measures,
		},
		now,
	)
	if err != nil {
		return MachineJob{}, err
	}
	title, err := cleanTitle(input.Title)
	if err != nil {
		return MachineJob{}, err
	}
	q := machinelogbookdb.New(tx)
	machine, err := q.GetMachineForUpdate(ctx, input.MachineID)
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
		now,
		input.MachineID,
		personID,
		organizationID,
		input.OperatorPersonID,
		title,
		optional.Trimmed(input.Notes),
	)
	if err != nil {
		return MachineJob{}, err
	}
	if _, err = s.storeManualRun(ctx, tx, q, p, job, plan, requestID); err != nil {
		return MachineJob{}, err
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
		[]string{"machineId", "title", "customer", "operatorPersonId", "notes", "runs", "usages", "pricingSnapshot"},
	); err != nil {
		return MachineJob{}, err
	}
	return s.jobFromRow(ctx, q, job)
}

func (s *Service) insertJob(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	now time.Time,
	machineID uuid.UUID,
	personID, organizationID *uuid.UUID,
	operatorID uuid.UUID,
	title, notes *string,
) (machinelogbookdb.MachineJob, error) {
	sequence, err := q.NextMachineJobSequence(ctx)
	if err != nil {
		return machinelogbookdb.MachineJob{}, err
	}
	job, err := q.CreateMachineJob(
		ctx,
		machinelogbookdb.CreateMachineJobParams{
			ID:                     ids.New(),
			DisplayID:              formatDisplayID(sequence, now),
			MachineID:              machineID,
			CustomerPersonID:       personID,
			CustomerOrganizationID: organizationID,
			OperatorPersonID:       &operatorID,
			Title:                  title,
			Notes:                  notes,
		},
	)
	if err != nil {
		return job, databaseError(err)
	}
	return job, nil
}

func (s *Service) loadBillingParty(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	job machinelogbookdb.MachineJob,
) (*BillingParty, error) {
	if job.CustomerPersonID != nil {
		row, err := q.GetBillingPerson(ctx, *job.CustomerPersonID)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		return &BillingParty{ID: row.ID, Kind: PartyPerson, DisplayName: row.DisplayName}, nil
	}
	if job.CustomerOrganizationID != nil {
		row, err := q.GetBillingOrganization(ctx, *job.CustomerOrganizationID)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		item := &BillingParty{
			ID:                            row.ID,
			Kind:                          PartyOrganization,
			DisplayName:                   row.DisplayName,
			OrganizationKind:              pointerAs[OrganizationKind](&row.OrganizationKind),
			PricingGroupAssignmentVersion: row.PricingGroupAssignmentVersion,
		}
		if row.PricingGroupID != nil && row.PricingGroupName != nil {
			item.PricingGroup = &PricingGroupSummary{ID: *row.PricingGroupID, Name: *row.PricingGroupName}
		}
		return item, nil
	}
	return nil, nil
}

// anyTime reads a timestamp from a view column that sqlc cannot type.
func anyTime(value any) *time.Time {
	if t, ok := value.(time.Time); ok {
		t = t.UTC()
		return &t
	}
	return nil
}

func (s *Service) jobFromRow(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	row machinelogbookdb.MachineJob,
) (MachineJob, error) {
	machineRow, err := q.GetMachine(ctx, row.MachineID)
	if err != nil {
		return MachineJob{}, err
	}
	runs, err := s.runsForJob(ctx, q, row.ID)
	if err != nil {
		return MachineJob{}, err
	}
	item := MachineJob{
		ID:                row.ID,
		DisplayID:         row.DisplayID,
		Title:             row.Title,
		Machine:           machineFromGet(machineRow),
		Runs:              runs,
		Outcome:           JobOutcomeUnknown,
		OutcomeOverridden: row.OutcomeOverride != nil,
		Notes:             row.Notes,
		PricingStatus:     PricingStatus(row.PricingStatus),
		CalculatedPrice:   nullableDecimal(row.CalculatedPrice),
		EffectivePrice:    nullableDecimal(row.EffectivePrice),
		Version:           row.Version,
		CreatedAt:         row.CreatedAt,
		UpdatedAt:         row.UpdatedAt,
		Usages:            []MachineJobUsage{},
	}
	if row.ArtifactID != nil {
		artifact, artifactErr := q.GetArtifactReference(ctx, *row.ArtifactID)
		if artifactErr != nil {
			return MachineJob{}, artifactErr
		}
		item.Artifact = &ArtifactReference{
			ID:           artifact.ID,
			SHA256:       artifact.Sha256,
			ParserStatus: artifact.ParserStatus,
		}
	}
	item.Measures = RunMeasures{}
	for _, run := range runs {
		if run.State != RunStateReplaced {
			item.Usages = append(item.Usages, run.Usages...)
			item.Measures.add(run.Measures)
		}
	}
	summary, err := q.GetMachineJobRunSummary(ctx, &row.ID)
	hasSummary := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return MachineJob{}, err
	}
	derived := JobOutcomeUnknown
	if hasSummary {
		item.StartedAt, item.EndedAt, item.ExpectedEndAt = anyTime(
			summary.StartedAt,
		), anyTime(
			summary.EndedAt,
		), anyTime(
			summary.ExpectedEndAt,
		)
		item.DurationSeconds = summary.RuntimeSeconds
		derived = JobOutcome(summary.DerivedOutcome)
	}
	effective := derived
	if row.OutcomeOverride != nil {
		effective = JobOutcome(*row.OutcomeOverride)
	}
	switch {
	case !hasSummary && row.ArtifactID != nil:
		item.Status = JobStatusPlanned
	case hasSummary && summary.Running:
		item.Status = JobStatusRunning
	case effective == JobOutcomeUnknown:
		item.Status, item.Outcome = JobStatusNeedsOutcome, JobOutcomeUnknown
	default:
		item.Status, item.Outcome = JobStatus(effective), effective
	}
	if row.PriceAdjustmentKind != nil {
		item.PriceAdjustment = &PriceAdjustment{
			Kind:       PriceAdjustmentKind(*row.PriceAdjustmentKind),
			Value:      decimalString(row.PriceAdjustmentValue),
			Reason:     optional.Value(row.PriceAdjustmentReason),
			AdjustedAt: row.PriceAdjustedAt.Time,
		}
	}
	item.Customer, err = s.loadBillingParty(ctx, q, row)
	if err != nil {
		return MachineJob{}, err
	}
	if row.OperatorPersonID != nil {
		operator, opErr := q.GetMachineJobOperator(ctx, *row.OperatorPersonID)
		if opErr == nil {
			item.Operator = &Operator{PersonID: operator.PersonID, DisplayName: operator.DisplayName}
		} else if !errors.Is(opErr, pgx.ErrNoRows) {
			return MachineJob{}, opErr
		}
	}
	if row.ActivePricingSnapshotID != nil {
		snapshot, err := q.GetPricingSnapshot(ctx, *row.ActivePricingSnapshotID)
		if err != nil {
			return MachineJob{}, err
		}
		snapshotRules, err := q.ListPricingSnapshotRules(ctx, snapshot.ID)
		if err != nil {
			return MachineJob{}, err
		}
		domain := PricingSnapshot{
			ID:               snapshot.ID,
			Revision:         int(snapshot.Revision),
			PricingGroupName: snapshot.PricingGroupName,
			Currency:         snapshot.Currency,
			Reason:           SnapshotReason(snapshot.Reason),
			Complete:         snapshot.Complete,
			CalculatedAmount: nullableDecimal(snapshot.CalculatedAmount),
			CapturedAt:       snapshot.CapturedAt,
			Rules:            make([]PricingSnapshotRule, 0, len(snapshotRules)),
		}
		for _, r := range snapshotRules {
			domain.Rules = append(domain.Rules, snapshotRuleFromRow(r))
		}
		item.PricingSnapshot = &domain
	}
	return item, nil
}

func (s *Service) GetJob(ctx context.Context, p authorization.Principal, id uuid.UUID) (MachineJob, error) {
	if err := require(p, authorization.MachineJobsRead); err != nil {
		return MachineJob{}, err
	}
	return s.loadJob(ctx, id)
}

func (s *Service) loadJob(ctx context.Context, id uuid.UUID) (MachineJob, error) {
	q := machinelogbookdb.New(s.pool)
	row, err := q.GetMachineJobBase(ctx, id)
	if err != nil {
		return MachineJob{}, noRows(err)
	}
	return s.jobFromRow(ctx, q, row)
}

func pgTime(value *time.Time) pgtype.Timestamptz {
	if value == nil {
		return pgtype.Timestamptz{}
	}
	return pgtype.Timestamptz{Time: value.UTC(), Valid: true}
}

func (s *Service) ListJobs(
	ctx context.Context,
	p authorization.Principal,
	filters JobFilters,
) ([]MachineJob, int64, error) {
	if err := require(p, authorization.MachineJobsRead); err != nil {
		return nil, 0, err
	}
	offset, limit, err := pageBounds(filters.Page, filters.PageSize)
	if err != nil {
		return nil, 0, err
	}
	if filters.From != nil && filters.To != nil && !filters.To.After(*filters.From) {
		return nil, 0, apperror.Invalid("to must be after from")
	}
	params := machinelogbookdb.ListMachineJobIDsParams{
		Search:     strings.TrimSpace(filters.Search),
		MachineID:  filters.MachineID,
		CustomerID: filters.CustomerID,
		OperatorID: filters.OperatorID,
		MaterialID: filters.MaterialID,
		Outcome:    pointerAs[string](filters.Outcome),
		FromTime:   pgTime(filters.From),
		ToTime:     pgTime(filters.To),
		PageOffset: offset,
		PageLimit:  limit,
	}
	q := machinelogbookdb.New(s.pool)
	ids, err := q.ListMachineJobIDs(ctx, params)
	if err != nil {
		return nil, 0, err
	}
	total, err := q.CountMachineJobs(
		ctx,
		machinelogbookdb.CountMachineJobsParams{
			Search:     params.Search,
			MachineID:  params.MachineID,
			CustomerID: params.CustomerID,
			OperatorID: params.OperatorID,
			MaterialID: params.MaterialID,
			Outcome:    params.Outcome,
			FromTime:   params.FromTime,
			ToTime:     params.ToTime,
		},
	)
	if err != nil {
		return nil, 0, err
	}
	items := make([]MachineJob, 0, len(ids))
	for _, id := range ids {
		base, err := q.GetMachineJobBase(ctx, id)
		if err != nil {
			return nil, 0, err
		}
		item, err := s.jobFromRow(ctx, q, base)
		if err != nil {
			return nil, 0, err
		}
		items = append(items, item)
	}
	return items, total, nil
}

// UpdateJobFacts changes the facts staff own: machine, customer, operator,
// title, notes, the pricing group and the outcome override. Times, material and
// the derived outcome come from the job's runs.
func (s *Service) UpdateJobFacts(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	input JobUpdate,
	requestID *uuid.UUID,
) (MachineJob, error) {
	if err := require(p, authorization.MachineJobsEdit); err != nil {
		return MachineJob{}, err
	}
	if expected < 1 {
		return MachineJob{}, apperror.Invalid("expectedVersion must be positive")
	}
	override, err := validateOptionalOutcome(input.OutcomeOverride)
	if err != nil {
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
	current, err := q.GetMachineJobForUpdate(ctx, id)
	if err != nil {
		return MachineJob{}, noRows(err)
	}
	if current.Version != expected {
		return MachineJob{}, apperror.StaleWrite
	}
	oldMachine, err := q.GetMachineForUpdate(ctx, current.MachineID)
	if err != nil {
		return MachineJob{}, err
	}
	newMachine, err := q.GetMachineForUpdate(ctx, input.MachineID)
	if err != nil {
		return MachineJob{}, noRows(err)
	}
	if newMachine.ID != oldMachine.ID {
		if MachineStatus(newMachine.Status) == MachineStatusRetired {
			return MachineJob{}, apperror.Conflicting("machine_retired", "Retired machines cannot receive jobs")
		}
		recorded, err := q.CountJobRecordedRuns(ctx, &id)
		if err != nil {
			return MachineJob{}, err
		}
		if recorded > 0 {
			return MachineJob{}, apperror.Conflicting(
				"machine_change_not_allowed",
				"The machine of a job with recorded runs cannot change",
			)
		}
		if oldMachine.MachineTypeID != newMachine.MachineTypeID {
			process, processErr := machineProcess(ctx, q, newMachine.ID)
			if processErr != nil {
				return MachineJob{}, processErr
			}
			runs, runsErr := q.ListJobRunsForUpdate(ctx, &id)
			if runsErr != nil {
				return MachineJob{}, runsErr
			}
			runIDs := make([]uuid.UUID, 0, len(runs))
			for _, run := range runs {
				runIDs = append(runIDs, run.ID)
			}
			measures, measuresErr := q.ListRunMeasuresForRuns(ctx, runIDs)
			if measuresErr != nil {
				return MachineJob{}, measuresErr
			}
			for _, m := range measures {
				if m.Value > 0 && !processSupportsMeasure(process, m.Measure) {
					return MachineJob{}, apperror.New(
						422,
						"run_measure_unsupported",
						"The new machine's process does not record the measures of this job's runs",
					)
				}
			}
		}
	}
	if override != nil {
		summary, err := q.GetMachineJobRunSummary(ctx, &id)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return MachineJob{}, err
		}
		if err == nil && summary.Running {
			return MachineJob{}, apperror.New(
				422,
				"outcome_before_run_end",
				"An outcome cannot be recorded before the runs have ended",
			)
		}
	}
	if input.Customer.Kind == "" {
		if current.CustomerPersonID != nil {
			input.Customer = PartyReference{Kind: PartyPerson, ID: *current.CustomerPersonID}
		} else if current.CustomerOrganizationID != nil {
			input.Customer = PartyReference{Kind: PartyOrganization, ID: *current.CustomerOrganizationID}
		}
	}
	personID, organizationID, err := validateJobAssignments(
		ctx,
		q,
		input.Customer,
		input.OperatorPersonID,
		current.CustomerPersonID == nil && current.CustomerOrganizationID == nil,
	)
	if err != nil {
		return MachineJob{}, err
	}
	updated, err := q.UpdateMachineJobFacts(
		ctx,
		machinelogbookdb.UpdateMachineJobFactsParams{
			MachineID:              input.MachineID,
			CustomerPersonID:       personID,
			CustomerOrganizationID: organizationID,
			OperatorPersonID:       &input.OperatorPersonID,
			OutcomeOverride:        pointerAs[string](override),
			Title:                  title,
			Notes:                  optional.Trimmed(input.Notes),
			ID:                     id,
			ExpectedVersion:        expected,
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return MachineJob{}, apperror.StaleWrite
	}
	if err != nil {
		return MachineJob{}, databaseError(err)
	}
	partyChanged := !sameUUID(current.CustomerPersonID, personID) ||
		!sameUUID(current.CustomerOrganizationID, organizationID)
	if partyChanged || oldMachine.MachineTypeID != newMachine.MachineTypeID || input.PricingGroupID != nil {
		group, err := resolvePricingGroup(ctx, q, personID, organizationID, input.PricingGroupID)
		if err != nil {
			return MachineJob{}, err
		}
		reason := SnapshotMachineChanged
		if partyChanged {
			reason = SnapshotCustomerChanged
		}
		if input.PricingGroupID != nil {
			reason = SnapshotManualReprice
		}
		_, err = s.capturePricingSnapshot(ctx, q, p, updated, group, reason)
		if err != nil {
			return MachineJob{}, err
		}
	} else {
		_, err = s.recalculateFromSnapshot(ctx, q, updated)
		if err != nil {
			return MachineJob{}, err
		}
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"machine_job.updated",
		"machine_job",
		id,
		requestID,
		[]string{"machineId", "title", "customer", "operatorPersonId", "outcomeOverride", "notes", "pricing"},
	); err != nil {
		return MachineJob{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MachineJob{}, err
	}
	return s.loadJob(ctx, id)
}

func stringPointer(value string) *string { return &value }

func validateJobAssignments(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	party PartyReference,
	operator uuid.UUID,
	anonymous bool,
) (*uuid.UUID, *uuid.UUID, error) {
	if operator == uuid.Nil {
		return nil, nil, apperror.Invalid("operatorPersonId is required")
	}
	ok, err := q.OperatorExists(ctx, operator)
	if err != nil {
		return nil, nil, err
	}
	if !ok {
		return nil, nil, apperror.Invalid("operator must have an enabled account")
	}
	return validateParty(ctx, q, party, anonymous)
}
