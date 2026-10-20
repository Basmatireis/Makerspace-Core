package machinelogbook

import (
	"context"
	"errors"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"
)

func validateParty(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	party PartyReference,
	anonymous bool,
) (*uuid.UUID, *uuid.UUID, error) {
	var ok bool
	var err error
	if anonymous && party.Kind == "" && party.ID == uuid.Nil {
		return nil, nil, nil
	}
	switch party.Kind {
	case PartyPerson:
		ok, err = q.BillingPersonExists(ctx, party.ID)
		if err != nil {
			return nil, nil, err
		}
		if !ok {
			return nil, nil, apperror.NotFound
		}
		return &party.ID, nil, nil
	case PartyOrganization:
		ok, err = q.ActiveOrganizationExists(ctx, party.ID)
		if err != nil {
			return nil, nil, err
		}
		if !ok {
			return nil, nil, apperror.NotFound
		}
		return nil, &party.ID, nil
	default:
		return nil, nil, apperror.Invalid("invalid billing party")
	}
}

// PricingSource is where the pricing group of a job comes from.
type PricingSource string

// The pricing group sources, in the order of precedence.
const (
	PricingSourceExplicit     PricingSource = "explicit"
	PricingSourceOrganization PricingSource = "organization"
	PricingSourceRole         PricingSource = "role"
	PricingSourceDefault      PricingSource = "default"
)

func resolvePricingGroup(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	personID, organizationID, explicit *uuid.UUID,
) (machinelogbookdb.PricingGroup, error) {
	group, _, err := resolvePricingGroupSource(ctx, q, personID, organizationID, explicit)
	return group, err
}

// resolvePricingGroupSource picks the pricing group of a job: the group set on the job, else the group
// of the organization it is billed to, else the group mapped to the highest-priority role of the
// person it is billed to, else the default group. Inactive mapped groups are skipped; an inactive
// explicit group is refused.
func resolvePricingGroupSource(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	personID, organizationID, explicit *uuid.UUID,
) (machinelogbookdb.PricingGroup, PricingSource, error) {
	if explicit != nil {
		group, err := q.GetPricingGroup(ctx, *explicit)
		if errors.Is(err, pgx.ErrNoRows) {
			return group, "", apperror.NotFound
		}
		if err != nil {
			return group, "", err
		}
		if !group.Active {
			return group, "", apperror.Conflicting("pricing_group_inactive", "Pricing group is inactive")
		}
		return group, PricingSourceExplicit, nil
	}
	if organizationID != nil {
		group, err := q.GetOrganizationPricingGroup(ctx, *organizationID)
		if err == nil {
			return group, PricingSourceOrganization, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return group, "", err
		}
	} else if personID != nil {
		group, err := q.GetPersonRolePricingGroup(ctx, *personID)
		if err == nil {
			return group, PricingSourceRole, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return group, "", err
		}
	}
	group, err := q.GetDefaultPricingGroup(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		return group, "", apperror.Invalid("pricingGroupId is required because no default pricing group resolves")
	}
	if err != nil {
		return group, "", err
	}
	return group, PricingSourceDefault, nil
}

// ResolvePricingGroup applies the pricing group precedence inside the caller's transaction, for features
// that create jobs outside this package. It returns the group and its source.
func ResolvePricingGroup(
	ctx context.Context,
	tx pgx.Tx,
	personID, organizationID, explicit *uuid.UUID,
) (uuid.UUID, string, PricingSource, error) {
	group, source, err := resolvePricingGroupSource(ctx, machinelogbookdb.New(tx), personID, organizationID, explicit)
	return group.ID, group.Name, source, err
}

func snapshotRuleFromRow(row machinelogbookdb.MachineJobPricingSnapshotRule) PricingSnapshotRule {
	return PricingSnapshotRule{
		SourceRuleID: row.SourceRuleID,
		Kind:         PricingRuleKind(row.Kind),
		Label:        row.Label,
		Selector:     row.Selector,
		Unit:         row.Unit,
		Measure:      row.Measure,
		BlockSize:    row.BlockSize,
		Rate:         nullableDecimal(row.Rate),
		Missing:      row.Missing,
	}
}

func runtimeHours(seconds int64) decimal.Decimal {
	return decimal.NewFromInt(seconds).Div(decimal.NewFromInt(3600))
}

// pricingInputs is what a job is priced from: the sum of its runs' runtime, the
// active usages and the measures of its runs that are not replaced.
type pricingInputs struct {
	RuntimeSeconds int64
	Usages         []machinelogbookdb.ListRunUsagesForRunsRow
	Measures       RunMeasures
}

func (s *Service) jobPricingInputs(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	jobID uuid.UUID,
) (pricingInputs, error) {
	runIDs, err := q.ListActiveJobRunIDs(ctx, &jobID)
	if err != nil {
		return pricingInputs{}, err
	}
	inputs := pricingInputs{Measures: RunMeasures{}}
	summary, err := q.GetMachineJobRunSummary(ctx, &jobID)
	if err == nil {
		inputs.RuntimeSeconds = summary.RuntimeSeconds
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return pricingInputs{}, err
	}
	inputs.Usages, err = q.ListRunUsagesForRuns(ctx, runIDs)
	if err != nil {
		return pricingInputs{}, err
	}
	measures, err := q.ListRunMeasuresForRuns(ctx, runIDs)
	if err != nil {
		return pricingInputs{}, err
	}
	for _, m := range measures {
		inputs.Measures[m.Measure] += m.Value
	}
	return inputs, nil
}

// measureAmount prices value units of a measure: value / blockSize * rate.
// Multiplying first keeps the division exact for whole blocks.
func measureAmount(value int64, blockSize int32, rate decimal.Decimal) decimal.Decimal {
	return decimal.NewFromInt(value).Mul(rate).Div(decimal.NewFromInt32(blockSize))
}

func (s *Service) capturePricingSnapshot(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	p authorization.Principal,
	job machinelogbookdb.MachineJob,
	group machinelogbookdb.PricingGroup,
	reason SnapshotReason,
) (machinelogbookdb.MachineJob, error) {
	rules, err := q.GetActivePricingRulesByGroup(ctx, group.ID)
	if err != nil {
		return job, err
	}
	machine, err := q.GetMachineForUpdate(ctx, job.MachineID)
	if err != nil {
		return job, noRows(err)
	}
	inputs, err := s.jobPricingInputs(ctx, q, job.ID)
	if err != nil {
		return job, err
	}
	runtimeSeconds, usages := inputs.RuntimeSeconds, inputs.Usages
	machineType, err := q.GetMachineType(ctx, machine.MachineTypeID)
	if err != nil {
		return job, noRows(err)
	}
	complete := true
	total := decimal.Zero
	snapshotRules := make([]machinelogbookdb.InsertPricingSnapshotRuleParams, 0, len(usages)+2)
	var runtime *machinelogbookdb.PricingRule
	for i := range rules {
		if PricingRuleKind(rules[i].Kind) == PricingRuleMachineRuntime && rules[i].MachineTypeID != nil &&
			*rules[i].MachineTypeID == machine.MachineTypeID {
			r := rules[i]
			runtime = &r
			break
		}
	}
	runtimeEntry := machinelogbookdb.InsertPricingSnapshotRuleParams{
		ID:       ids.New(),
		Kind:     string(PricingRuleMachineRuntime),
		Label:    "Machine runtime",
		Selector: machine.MachineTypeID.String(),
		Unit:     "hour",
	}
	if runtime == nil {
		complete = false
		runtimeEntry.Missing = true
	} else {
		runtimeEntry.SourceRuleID = &runtime.ID
		runtimeEntry.Rate = runtime.Rate
		hours := runtimeHours(runtimeSeconds)
		total = total.Add(hours.Mul(decimalFromNumeric(runtime.Rate)))
	}
	snapshotRules = append(snapshotRules, runtimeEntry)
	// Every measure the machine's process records gets an entry so the rate is
	// fixed with the snapshot, plus any measure that already has a value.
	measureSet := RunMeasures{}
	for _, key := range processMeasures[machineType.Process] {
		measureSet[key] = 0
	}
	for key, value := range inputs.Measures {
		if value > 0 {
			measureSet[key] = value
		}
	}
	for _, key := range sortedMeasureKeys(measureSet) {
		definition := measureDefinitions[key]
		block := definition.BlockSize
		entry := machinelogbookdb.InsertPricingSnapshotRuleParams{
			ID:        ids.New(),
			Kind:      string(PricingRuleMachineMeasure),
			Label:     definition.Label,
			Selector:  key,
			Measure:   &definition.Key,
			BlockSize: &block,
			Unit:      definition.Unit,
		}
		var matched *machinelogbookdb.PricingRule
		for i := range rules {
			if PricingRuleKind(rules[i].Kind) == PricingRuleMachineMeasure && rules[i].MachineTypeID != nil &&
				*rules[i].MachineTypeID == machine.MachineTypeID &&
				rules[i].Measure != nil &&
				*rules[i].Measure == key {
				r := rules[i]
				matched = &r
				break
			}
		}
		if matched == nil {
			entry.Missing = true
			if inputs.Measures[key] > 0 {
				complete = false
			}
		} else {
			entry.SourceRuleID = &matched.ID
			entry.Rate = matched.Rate
			if matched.BlockSize != nil {
				entry.BlockSize = matched.BlockSize
			}
			total = total.Add(measureAmount(inputs.Measures[key], *entry.BlockSize, decimalFromNumeric(matched.Rate)))
		}
		snapshotRules = append(snapshotRules, entry)
	}
	for _, usage := range usages {
		if UsageOwnership(usage.Ownership) == OwnershipExternal {
			continue
		}
		var matched *machinelogbookdb.PricingRule
		for i := range rules {
			if PricingRuleKind(rules[i].Kind) == PricingRuleMaterial && rules[i].MaterialTypeID != nil && usage.MaterialTypeID != nil &&
				*rules[i].MaterialTypeID == *usage.MaterialTypeID &&
				rules[i].MaterialUnit != nil &&
				*rules[i].MaterialUnit == usage.Unit {
				r := rules[i]
				matched = &r
				break
			}
		}
		entry := machinelogbookdb.InsertPricingSnapshotRuleParams{
			ID:             ids.New(),
			Kind:           string(PricingRuleMaterial),
			Label:          usage.MaterialName,
			Selector:       usage.MaterialTypeName,
			MaterialTypeID: usage.MaterialTypeID,
			Unit:           usage.Unit,
		}
		if matched == nil {
			complete = false
			entry.Missing = true
		} else {
			entry.SourceRuleID = &matched.ID
			entry.Rate = matched.Rate
			total = total.Add(decimalFromNumeric(usage.Quantity).Mul(decimalFromNumeric(matched.Rate)))
		}
		snapshotRules = append(snapshotRules, entry)
	}
	revision, err := q.NextPricingSnapshotRevision(ctx, job.ID)
	if err != nil {
		return job, err
	}
	snapshotID := ids.New()
	calculated := pgtype.Numeric{}
	status := PricingIncomplete
	if complete {
		total = total.Round(2)
		calculated = numericFromDecimal(total)
		status = PricingComplete
	}
	_, err = q.CreatePricingSnapshot(
		ctx,
		machinelogbookdb.CreatePricingSnapshotParams{
			ID:                  snapshotID,
			MachineJobID:        job.ID,
			Revision:            revision,
			PricingGroupID:      &group.ID,
			PricingGroupName:    group.Name,
			Reason:              string(reason),
			Complete:            complete,
			CalculatedAmount:    calculated,
			CapturedByAccountID: accountPointer(p),
		},
	)
	if err != nil {
		return job, err
	}
	for _, entry := range snapshotRules {
		entry.SnapshotID = snapshotID
		if _, err = q.InsertPricingSnapshotRule(ctx, entry); err != nil {
			return job, err
		}
	}
	updated, err := q.ActivatePricingSnapshot(
		ctx,
		machinelogbookdb.ActivatePricingSnapshotParams{
			SnapshotID:      &snapshotID,
			PricingStatus:   string(status),
			CalculatedPrice: calculated,
			EffectivePrice:  effectivePriceForRow(job, calculated),
			ID:              job.ID,
			ExpectedVersion: job.Version,
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return job, apperror.StaleWrite
	}
	return updated, err
}

// snapshotRuleSelector identifies what a snapshot rule prices: the material type
// for material rules (older rows were backfilled with it), else the stored text.
func snapshotRuleSelector(rule machinelogbookdb.MachineJobPricingSnapshotRule) string {
	if PricingRuleKind(rule.Kind) == PricingRuleMaterial && rule.MaterialTypeID != nil {
		return rule.MaterialTypeID.String()
	}
	return rule.Selector
}

// snapshotRuleCovers reports whether a material snapshot rule is the one for the
// usage's material type and unit. A snapshot never changes, so a missing rule
// still covers the usage: it records that this type had no price at capture time.
func snapshotRuleCovers(
	rule machinelogbookdb.MachineJobPricingSnapshotRule,
	usage machinelogbookdb.ListRunUsagesForRunsRow,
) bool {
	return PricingRuleKind(rule.Kind) == PricingRuleMaterial && rule.MaterialTypeID != nil && usage.MaterialTypeID != nil &&
		*rule.MaterialTypeID == *usage.MaterialTypeID &&
		rule.Unit == usage.Unit
}

func sameUUID(a, b *uuid.UUID) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// computeFromSnapshot prices the job from its active snapshot's rates, its
// runs' runtime and its runs' current material, re-applying the price
// adjustment.
func (s *Service) computeFromSnapshot(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	job machinelogbookdb.MachineJob,
) (PricingStatus, pgtype.Numeric, error) {
	rules, err := q.ListPricingSnapshotRules(ctx, *job.ActivePricingSnapshotID)
	if err != nil {
		return "", pgtype.Numeric{}, err
	}
	inputs, err := s.jobPricingInputs(ctx, q, job.ID)
	if err != nil {
		return "", pgtype.Numeric{}, err
	}
	runtimeSeconds, usages := inputs.RuntimeSeconds, inputs.Usages
	complete := true
	total := decimal.Zero
	var runtimeFound bool
	coveredMeasures := map[string]bool{}
	seenRules := map[string]bool{}
	for _, rule := range rules {
		key := rule.Kind + "/" + snapshotRuleSelector(rule) + "/" + rule.Unit
		if seenRules[key] {
			continue
		}
		seenRules[key] = true
		if PricingRuleKind(rule.Kind) == PricingRuleMachineMeasure && rule.Measure != nil {
			coveredMeasures[*rule.Measure] = true
			value := inputs.Measures[*rule.Measure]
			if rule.Missing {
				// No rate was configured when the snapshot was taken: a value cannot be priced.
				if value > 0 {
					complete = false
				}
			} else if rule.BlockSize != nil {
				total = total.Add(measureAmount(value, *rule.BlockSize, decimalFromNumeric(rule.Rate)))
			}
			continue
		}
		if rule.Missing {
			if PricingRuleKind(rule.Kind) == PricingRuleMachineRuntime {
				complete = false
			}
			if PricingRuleKind(rule.Kind) == PricingRuleMaterial {
				for _, usage := range usages {
					if UsageOwnership(usage.Ownership) == OwnershipMakerspace && snapshotRuleCovers(rule, usage) {
						complete = false
						break
					}
				}
			}
			continue
		}
		rate := decimalFromNumeric(rule.Rate)
		if PricingRuleKind(rule.Kind) == PricingRuleMachineRuntime {
			runtimeFound = true
			total = total.Add(runtimeHours(runtimeSeconds).Mul(rate))
			continue
		}
		for _, usage := range usages {
			if UsageOwnership(usage.Ownership) == OwnershipMakerspace && snapshotRuleCovers(rule, usage) {
				total = total.Add(decimalFromNumeric(usage.Quantity).Mul(rate))
			}
		}
	}
	if !runtimeFound {
		complete = false
	}
	for key, value := range inputs.Measures {
		if value > 0 && !coveredMeasures[key] {
			complete = false
		}
	}
	for _, usage := range usages {
		if UsageOwnership(usage.Ownership) == OwnershipExternal {
			continue
		}
		found := false
		for _, rule := range rules {
			if snapshotRuleCovers(rule, usage) && !rule.Missing {
				found = true
				break
			}
		}
		if !found {
			complete = false
		}
	}
	if !complete {
		return PricingIncomplete, pgtype.Numeric{}, nil
	}
	return PricingComplete, numericFromDecimal(total.Round(2)), nil
}

// recalculateFromSnapshot reprices the job and bumps its version.
func (s *Service) recalculateFromSnapshot(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	job machinelogbookdb.MachineJob,
) (machinelogbookdb.MachineJob, error) {
	if job.ActivePricingSnapshotID == nil {
		return job, nil
	}
	status, amount, err := s.computeFromSnapshot(ctx, q, job)
	if err != nil {
		return job, err
	}
	updated, err := q.RecalculateMachineJobPrice(
		ctx,
		machinelogbookdb.RecalculateMachineJobPriceParams{
			PricingStatus:   string(status),
			CalculatedPrice: amount,
			EffectivePrice:  effectivePriceForRow(job, amount),
			ID:              job.ID,
			ExpectedVersion: job.Version,
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return job, apperror.StaleWrite
	}
	return updated, err
}

// refreshPriceKeepingVersion reprices the job without a new version; connector
// progress keeps the price of a running job current this way.
func (s *Service) refreshPriceKeepingVersion(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	job machinelogbookdb.MachineJob,
) (machinelogbookdb.MachineJob, error) {
	if job.ActivePricingSnapshotID == nil {
		return job, nil
	}
	status, amount, err := s.computeFromSnapshot(ctx, q, job)
	if err != nil {
		return job, err
	}
	return q.RefreshMachineJobPrice(
		ctx,
		machinelogbookdb.RefreshMachineJobPriceParams{
			PricingStatus:   string(status),
			CalculatedPrice: amount,
			EffectivePrice:  effectivePriceForRow(job, amount),
			ID:              job.ID,
		},
	)
}

// coverUsages captures a new snapshot of the job's pricing group when a run
// brought material of a category the active snapshot has no rule for, for
// example material a machine reported after the job was created.
func (s *Service) coverUsages(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	job machinelogbookdb.MachineJob,
) (machinelogbookdb.MachineJob, error) {
	if job.ActivePricingSnapshotID == nil {
		return job, nil
	}
	rules, err := q.ListPricingSnapshotRules(ctx, *job.ActivePricingSnapshotID)
	if err != nil {
		return job, err
	}
	inputs, err := s.jobPricingInputs(ctx, q, job.ID)
	if err != nil {
		return job, err
	}
	usages := inputs.Usages
	covered := true
	for key, value := range inputs.Measures {
		if value <= 0 {
			continue
		}
		found := false
		for _, rule := range rules {
			if PricingRuleKind(rule.Kind) == PricingRuleMachineMeasure && rule.Measure != nil && *rule.Measure == key {
				found = true
				break
			}
		}
		covered = covered && found
	}
	for _, usage := range usages {
		if UsageOwnership(usage.Ownership) == OwnershipExternal {
			continue
		}
		found := false
		for _, rule := range rules {
			if snapshotRuleCovers(rule, usage) {
				found = true
				break
			}
		}
		covered = covered && found
	}
	if covered {
		return job, nil
	}
	snapshot, err := q.GetPricingSnapshot(ctx, *job.ActivePricingSnapshotID)
	if err != nil || snapshot.PricingGroupID == nil {
		return job, err
	}
	group, err := q.GetPricingGroup(ctx, *snapshot.PricingGroupID)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !group.Active) {
		return job, nil
	}
	if err != nil {
		return job, err
	}
	return s.capturePricingSnapshot(ctx, q, authorization.Principal{}, job, group, SnapshotManualReprice)
}

// settleJob reprices a locked job after its runs or their material changed.
// The job version always advances so orders notice the change.
func (s *Service) settleJob(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	jobID uuid.UUID,
) (machinelogbookdb.MachineJob, error) {
	job, err := q.GetMachineJobForUpdate(ctx, jobID)
	if err != nil {
		return job, noRows(err)
	}
	if job, err = s.coverUsages(ctx, q, job); err != nil {
		return job, err
	}
	if job.ActivePricingSnapshotID == nil {
		return q.BumpMachineJobVersion(
			ctx,
			machinelogbookdb.BumpMachineJobVersionParams{ID: jobID, ExpectedVersion: job.Version},
		)
	}
	return s.recalculateFromSnapshot(ctx, q, job)
}

// ChargeSource locks a job and returns domain data using the caller's transaction.
func (s *Service) ChargeSource(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	id uuid.UUID,
) (MachineJob, error) {
	if !p.Has(authorization.OrdersRead) {
		return MachineJob{}, apperror.PermissionDenied
	}
	q := machinelogbookdb.New(tx)
	row, err := q.GetMachineJobForUpdate(ctx, id)
	if err != nil {
		return MachineJob{}, noRows(err)
	}
	job, err := s.jobFromRow(ctx, q, row)
	if err != nil {
		return MachineJob{}, err
	}
	// Progress events reprice a running job without a version bump, so a
	// charge snapshot of it could not be kept in step.
	if job.Status == JobStatusRunning {
		return MachineJob{}, apperror.Conflicting(
			"job_running",
			"A job with a running run cannot be ordered until its runs have ended",
		)
	}
	if job.Status == JobStatusPlanned {
		return MachineJob{}, apperror.Conflicting("job_planned", "A planned job cannot be ordered until it has a run")
	}
	return job, nil
}
