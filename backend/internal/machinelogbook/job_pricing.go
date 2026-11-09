package machinelogbook

import (
	"context"
	"errors"
	"unicode/utf8"

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
	processMeasures, err := loadProcessMeasures(ctx, q, []uuid.UUID{machine.ProcessID})
	if err != nil {
		return job, err
	}
	definitions := map[string]ProcessMeasure{}
	for _, m := range processMeasures[machine.ProcessID] {
		definitions[m.Key] = m
	}
	complete := true
	total := decimal.Zero
	snapshotRules := make([]machinelogbookdb.InsertPricingSnapshotRuleParams, 0, len(usages)+2)
	var runtime *machinelogbookdb.PricingRule
	for i := range rules {
		if PricingRuleKind(rules[i].Kind) == PricingRuleMachineRuntime && rules[i].ProcessID != nil &&
			*rules[i].ProcessID == machine.ProcessID {
			r := rules[i]
			runtime = &r
			break
		}
	}
	runtimeEntry := machinelogbookdb.InsertPricingSnapshotRuleParams{
		ID:       ids.New(),
		Kind:     string(PricingRuleMachineRuntime),
		Label:    "Machine runtime",
		Selector: machine.ProcessID.String(),
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
	for key := range definitions {
		measureSet[key] = 0
	}
	for key, value := range inputs.Measures {
		if value > 0 {
			measureSet[key] = value
		}
	}
	for _, key := range sortedMeasureKeys(measureSet) {
		definition, defined := definitions[key]
		if !defined {
			// A measure of an older version of the process: keep its value, with the stored rule's block size.
			definition = ProcessMeasure{Key: key, Label: key, Unit: key, BlockSize: 1}
		}
		block := definition.BlockSize
		measureKey := definition.Key
		entry := machinelogbookdb.InsertPricingSnapshotRuleParams{
			ID:        ids.New(),
			Kind:      string(PricingRuleMachineMeasure),
			Label:     definition.Label,
			Selector:  key,
			Measure:   &measureKey,
			BlockSize: &block,
			Unit:      definition.Unit,
		}
		var matched *machinelogbookdb.PricingRule
		for i := range rules {
			if PricingRuleKind(rules[i].Kind) == PricingRuleMachineMeasure && rules[i].ProcessID != nil &&
				*rules[i].ProcessID == machine.ProcessID &&
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
		// Run usages are priced like sales from stock: the article's own rate, else its variant's, else its type's.
		matched, source := articleRuleFor(rules, usage.MaterialID, usage.MaterialTypeID, usage.VariantID, usage.Unit, true)
		entry := machinelogbookdb.InsertPricingSnapshotRuleParams{
			ID:             ids.New(),
			Kind:           string(PricingRuleMaterial),
			Label:          usage.MaterialNameText,
			Selector:       usage.MaterialTypeName,
			MaterialTypeID: usage.MaterialTypeID,
			Unit:           usage.Unit,
		}
		switch source {
		case PriceFromStockArticle:
			entry.Kind = string(PricingRuleStockArticle)
			entry.MaterialID = usage.MaterialID
			entry.Selector = snapshotSelectorText(usage.MaterialNameText)
		case PriceFromMaterialTypeVariant:
			entry.MaterialTypeVariantID = matched.MaterialTypeVariantID
			if usage.VariantName != nil {
				entry.Selector = snapshotSelectorText(usage.MaterialTypeName + " " + *usage.VariantName)
			}
		}
		if matched == nil {
			complete = false
			entry.Missing = true
		} else {
			// The entry keeps the rate per unit of the usage, so rate * quantity stays consistent.
			rate := ruleRateIn(matched, usage.Unit)
			entry.SourceRuleID = &matched.ID
			entry.Rate = numericFromDecimal(rate)
			total = total.Add(decimalFromNumeric(usage.Quantity).Mul(rate))
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

// maxSnapshotSelectorLength matches the check on machine_job_pricing_snapshot_rules.selector.
const maxSnapshotSelectorLength = 200

func snapshotSelectorText(text string) string {
	if utf8.RuneCountInString(text) <= maxSnapshotSelectorLength {
		return text
	}
	return string([]rune(text)[:maxSnapshotSelectorLength])
}

// isMaterialSnapshotRule reports whether a snapshot entry prices run material rather than runtime or a measure.
func isMaterialSnapshotRule(rule machinelogbookdb.MachineJobPricingSnapshotRule) bool {
	kind := PricingRuleKind(rule.Kind)
	return kind == PricingRuleMaterial || kind == PricingRuleStockArticle
}

// snapshotRuleFor finds the snapshot entry that prices a usage, the most specific first: the entry of the usage's
// article (its own rate), else the entry of its variant, else the entry of its material type, each of the usage's
// dimension (snapshotRateIn converts the rate when the article's unit changed since). A snapshot never changes, so a
// missing entry still covers the usage: it records that the material had no price at capture time. Nil means the
// snapshot has no entry for the usage.
func snapshotRuleFor(
	rules []machinelogbookdb.MachineJobPricingSnapshotRule,
	usage machinelogbookdb.ListRunUsagesForRunsRow,
) *machinelogbookdb.MachineJobPricingSnapshotRule {
	var variantRule, typeRule *machinelogbookdb.MachineJobPricingSnapshotRule
	for i := range rules {
		rule := &rules[i]
		if !isMaterialSnapshotRule(*rule) || !sameDimension(rule.Unit, usage.Unit) {
			continue
		}
		switch {
		case rule.MaterialID != nil:
			if usage.MaterialID != nil && *rule.MaterialID == *usage.MaterialID {
				return rule
			}
		case rule.MaterialTypeID == nil || usage.MaterialTypeID == nil || *rule.MaterialTypeID != *usage.MaterialTypeID:
			continue
		case rule.MaterialTypeVariantID != nil:
			if variantRule == nil && usage.VariantID != nil && *rule.MaterialTypeVariantID == *usage.VariantID {
				variantRule = rule
			}
		case typeRule == nil:
			typeRule = rule
		}
	}
	if variantRule != nil {
		return variantRule
	}
	return typeRule
}

// snapshotRateIn is the rate of a snapshot entry per unit of the usage it prices. The entry was captured in the unit
// of the article at the time, which may have changed since.
func snapshotRateIn(rule *machinelogbookdb.MachineJobPricingSnapshotRule, unit string) decimal.Decimal {
	rate := decimalFromNumeric(rule.Rate)
	if sameDimension(rule.Unit, unit) {
		return convertRate(rate, rule.Unit, unit)
	}
	return rate
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
		if isMaterialSnapshotRule(rule) {
			// Material is priced per usage below, by the entry that covers it.
			continue
		}
		key := rule.Kind + "/" + rule.Selector + "/" + rule.Unit
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
			continue
		}
		if PricingRuleKind(rule.Kind) == PricingRuleMachineRuntime {
			runtimeFound = true
			total = total.Add(runtimeHours(runtimeSeconds).Mul(decimalFromNumeric(rule.Rate)))
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
		rule := snapshotRuleFor(rules, usage)
		if rule == nil || rule.Missing {
			complete = false
			continue
		}
		total = total.Add(decimalFromNumeric(usage.Quantity).Mul(snapshotRateIn(rule, usage.Unit)))
	}
	if !complete {
		return PricingIncomplete, pgtype.Numeric{}, nil
	}
	return PricingComplete, numericFromDecimal(total.Round(2)), nil
}

// recalculateFromSnapshot reprices the job and bumps its version. The billing revision advances when
// billingChange says runs or usages changed, or when the charge itself changes.
func (s *Service) recalculateFromSnapshot(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	job machinelogbookdb.MachineJob,
	billingChange bool,
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
			BillingChange:   billingChange,
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
		covered = covered && snapshotRuleFor(rules, usage) != nil
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
	return s.recalculateFromSnapshot(ctx, q, job, true)
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

// RepriceMachineJob captures a fresh pricing snapshot from the current rules of the group the job is
// priced with, so changed or newly added rates take effect. The active snapshot's group is kept; a job
// without a snapshot, or whose group was deactivated, falls back to the group resolved as on creation.
// Running jobs and jobs charged on an order are allowed: the version advances, so the order shows the
// charge as outdated until it is refreshed.
func (s *Service) RepriceMachineJob(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expectedVersion int64,
	requestID *uuid.UUID,
) (MachineJob, error) {
	if err := require(p, authorization.MachineJobsEdit); err != nil {
		return MachineJob{}, err
	}
	if expectedVersion < 1 {
		return MachineJob{}, apperror.Invalid("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MachineJob{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	job, err := q.GetMachineJobForUpdate(ctx, id)
	if err != nil {
		return MachineJob{}, noRows(err)
	}
	if job.Version != expectedVersion {
		return MachineJob{}, apperror.StaleWrite
	}
	group, found, err := activeSnapshotGroup(ctx, q, job)
	if err != nil {
		return MachineJob{}, err
	}
	if !found {
		group, err = resolvePricingGroup(ctx, q, job.CustomerPersonID, job.CustomerOrganizationID, nil)
		if err != nil {
			return MachineJob{}, err
		}
	}
	if _, err = s.capturePricingSnapshot(ctx, q, p, job, group, SnapshotManualReprice); err != nil {
		return MachineJob{}, err
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"machine_job.repriced",
		"machine_job",
		id,
		requestID,
		[]string{"pricing"},
	); err != nil {
		return MachineJob{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MachineJob{}, err
	}
	return s.loadJob(ctx, id)
}

// activeSnapshotGroup returns the pricing group of the job's active snapshot when it still exists and is
// active.
func activeSnapshotGroup(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	job machinelogbookdb.MachineJob,
) (machinelogbookdb.PricingGroup, bool, error) {
	if job.ActivePricingSnapshotID == nil {
		return machinelogbookdb.PricingGroup{}, false, nil
	}
	snapshot, err := q.GetPricingSnapshot(ctx, *job.ActivePricingSnapshotID)
	if err != nil {
		return machinelogbookdb.PricingGroup{}, false, err
	}
	if snapshot.PricingGroupID == nil {
		return machinelogbookdb.PricingGroup{}, false, nil
	}
	group, err := q.GetPricingGroup(ctx, *snapshot.PricingGroupID)
	if errors.Is(err, pgx.ErrNoRows) {
		return group, false, nil
	}
	if err != nil {
		return group, false, err
	}
	return group, group.Active, nil
}
