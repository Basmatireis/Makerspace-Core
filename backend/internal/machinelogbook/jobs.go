package machinelogbook

import (
	"bytes"
	"context"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"
)

type parsedUsage struct {
	MaterialID           *uuid.UUID
	SpoolID              *uuid.UUID
	Ownership            string
	ExternalMaterialName *string
	QuantityBasis        string
	Quantity             decimal.Decimal
	UsageID              uuid.UUID
	SourcePrinterEventID *uuid.UUID
	EstimationMethod     *string
	CalculationVersion   *string
	EstimateQuality      *string
	ReportRevision       *int64
	StaffCorrected       bool
	// Fill is the open fill a spool usage draws from; it is resolved inside
	// the transaction that records the usage.
	Fill *fillRef
}

// parseOutcome validates a run outcome. An empty value or "unknown" records no
// outcome yet.
func parseOutcome(value string) (*string, error) {
	switch value {
	case "", "unknown":
		return nil, nil
	case "successful", "partial_failure", "failed", "cancelled":
		return &value, nil
	}
	return nil, validation("invalid outcome")
}

func validateOptionalOutcome(value *string) (*string, error) {
	if value == nil {
		return nil, nil
	}
	if *value == "unknown" || *value == "" {
		return nil, validation("invalid outcome")
	}
	return parseOutcome(*value)
}
func validateInterval(startsAt, endsAt time.Time) error {
	if startsAt.IsZero() || endsAt.IsZero() || !endsAt.After(startsAt) {
		return validation("endsAt must be after startsAt")
	}
	return nil
}
func parseUsages(inputs []UsageInput) ([]parsedUsage, error) {
	items := make([]parsedUsage, 0, len(inputs))
	seen := map[string]bool{}
	for _, input := range inputs {
		if input.Ownership == "" {
			input.Ownership = "makerspace"
		}
		if input.QuantityBasis == "" {
			input.QuantityBasis = "actual"
		}
		if input.QuantityBasis != "actual" && input.QuantityBasis != "estimated" {
			return nil, validation("invalid quantityBasis")
		}
		if input.Ownership == "makerspace" {
			if input.MaterialID == uuid.Nil || input.ExternalMaterialName != nil {
				return nil, validation("makerspace usage requires a material")
			}
			key := "material/" + input.MaterialID.String()
			if input.SpoolID != nil {
				key = "spool/" + input.SpoolID.String()
			}
			if seen[key] {
				return nil, validation("makerspace usage sources must be unique")
			}
			seen[key] = true
		} else if input.Ownership == "external" {
			if input.SpoolID != nil || cleanOptional(input.ExternalMaterialName) == nil {
				return nil, validation("external usage requires a material description and cannot use a spool")
			}
			input.ExternalMaterialName = cleanOptional(input.ExternalMaterialName)
		} else {
			return nil, validation("invalid filament ownership")
		}
		quantity, err := parseDecimal(input.Quantity, true)
		if err != nil {
			return nil, err
		}
		var materialID *uuid.UUID
		if input.MaterialID != uuid.Nil {
			value := input.MaterialID
			materialID = &value
		}
		items = append(items, parsedUsage{MaterialID: materialID, SpoolID: input.SpoolID, Ownership: input.Ownership, ExternalMaterialName: input.ExternalMaterialName, QuantityBasis: input.QuantityBasis, Quantity: quantity, UsageID: newID()})
	}
	sort.Slice(items, func(i, j int) bool { return usageSortKey(items[i]) < usageSortKey(items[j]) })
	return items, nil
}

func usageSortKey(item parsedUsage) string {
	if item.MaterialID == nil {
		return "z/" + stringValue(item.ExternalMaterialName) + "/" + item.UsageID.String()
	}
	spool := ""
	if item.SpoolID != nil {
		spool = item.SpoolID.String()
	}
	return item.MaterialID.String() + "/" + spool
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func validatePartyAndOperator(ctx context.Context, q *machinelogbookdb.Queries, party PartyReference, operator uuid.UUID) (*uuid.UUID, *uuid.UUID, error) {
	if operator == uuid.Nil {
		return nil, nil, validation("operatorPersonId is required")
	}
	ok, err := q.OperatorExists(ctx, operator)
	if err != nil {
		return nil, nil, err
	}
	if !ok {
		return nil, nil, validation("operator must have an enabled account")
	}
	return validateParty(ctx, q, party, false)
}

func validateParty(ctx context.Context, q *machinelogbookdb.Queries, party PartyReference, anonymous bool) (*uuid.UUID, *uuid.UUID, error) {
	var ok bool
	var err error
	if anonymous && party.Kind == "" && party.ID == uuid.Nil {
		return nil, nil, nil
	}
	switch party.Kind {
	case "person":
		ok, err = q.BillingPersonExists(ctx, party.ID)
		if err != nil {
			return nil, nil, err
		}
		if !ok {
			return nil, nil, apperror.NotFound
		}
		return &party.ID, nil, nil
	case "organization":
		ok, err = q.ActiveOrganizationExists(ctx, party.ID)
		if err != nil {
			return nil, nil, err
		}
		if !ok {
			return nil, nil, apperror.NotFound
		}
		return nil, &party.ID, nil
	default:
		return nil, nil, validation("invalid billing party")
	}
}

func resolvePricingGroup(ctx context.Context, q *machinelogbookdb.Queries, personID, organizationID, explicit *uuid.UUID) (machinelogbookdb.PricingGroup, error) {
	var group machinelogbookdb.PricingGroup
	var err error
	if explicit != nil {
		group, err = q.GetPricingGroup(ctx, *explicit)
		if errors.Is(err, pgx.ErrNoRows) {
			return group, apperror.NotFound
		}
		if err != nil {
			return group, err
		}
	} else if personID != nil {
		group, err = q.GetPersonPricingGroup(ctx, *personID)
	} else if organizationID != nil {
		group, err = q.GetOrganizationPricingGroup(ctx, *organizationID)
	}
	if explicit == nil && (errors.Is(err, pgx.ErrNoRows) || (err == nil && group.ID == uuid.Nil)) {
		group, err = q.GetDefaultPricingGroup(ctx)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return group, validation("pricingGroupId is required because no default pricing group resolves")
	}
	if err != nil {
		return group, err
	}
	if !group.Active {
		return group, conflict("pricing_group_inactive", "Pricing group is inactive")
	}
	return group, nil
}

// resolveUsageFills attaches the open fill of every spool usage, locking the
// spools in id order. Archived spools and spools without an open fill cannot be
// used.
func (s *Service) resolveUsageFills(ctx context.Context, q *machinelogbookdb.Queries, items []parsedUsage) error {
	order := make([]int, 0, len(items))
	for i := range items {
		if items[i].Ownership != "external" && items[i].SpoolID != nil {
			order = append(order, i)
		}
	}
	sort.Slice(order, func(a, b int) bool {
		return bytes.Compare(items[order[a]].SpoolID[:], items[order[b]].SpoolID[:]) < 0
	})
	for _, i := range order {
		_, ref, _, err := s.lockConsumableFill(ctx, q, *items[i].SpoolID)
		if err != nil {
			return err
		}
		if items[i].MaterialID == nil || ref.MaterialID != *items[i].MaterialID {
			return conflict("spool_material_mismatch", "Spool does not belong to the selected material")
		}
		items[i].Fill = &ref
	}
	return nil
}

// usageFillRef rebuilds the fill reference stored on a recorded usage.
func usageFillRef(u machinelogbookdb.MachineRunUsage) *fillRef {
	if u.MaterialID == nil || u.SpoolID == nil || u.FillID == nil || u.SpoolDisplayID == nil || u.FillNumber == nil {
		return nil
	}
	return &fillRef{SpoolID: *u.SpoolID, FillID: *u.FillID, SpoolDisplayID: *u.SpoolDisplayID, FillNumber: *u.FillNumber, MaterialID: *u.MaterialID}
}

// reversalFill returns the fill a usage correction goes back to. A usage whose
// fill was closed in the meantime, or whose spool was deleted, returns to loose
// stock instead.
func (s *Service) reversalFill(ctx context.Context, q *machinelogbookdb.Queries, u machinelogbookdb.MachineRunUsage) (*fillRef, error) {
	ref := usageFillRef(u)
	if ref == nil {
		return nil, nil
	}
	if _, err := q.GetFilamentSpoolForUpdate(ctx, ref.SpoolID); errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	} else if err != nil {
		return nil, err
	}
	open, err := q.GetOpenFilamentSpoolFill(ctx, ref.SpoolID)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && open.ID != ref.FillID) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return ref, nil
}

func (s *Service) insertUsages(ctx context.Context, q *machinelogbookdb.Queries, runID uuid.UUID, items []parsedUsage) error {
	for i := range items {
		params := machinelogbookdb.InsertRunUsageParams{ID: items[i].UsageID, RunID: runID, MaterialID: items[i].MaterialID, SpoolID: items[i].SpoolID, Ownership: items[i].Ownership, ExternalMaterialName: items[i].ExternalMaterialName, QuantityBasis: items[i].QuantityBasis, Quantity: numericFromDecimal(items[i].Quantity), SourcePrinterEventID: items[i].SourcePrinterEventID, EstimationMethod: items[i].EstimationMethod, CalculationVersion: items[i].CalculationVersion, EstimateQuality: items[i].EstimateQuality, ReportRevision: items[i].ReportRevision, StaffCorrected: items[i].StaffCorrected}
		if fill := items[i].Fill; fill != nil && items[i].SpoolID != nil {
			params.FillID, params.SpoolDisplayID, params.FillNumber = &fill.FillID, &fill.SpoolDisplayID, &fill.FillNumber
		}
		row, err := q.InsertRunUsage(ctx, params)
		if err != nil {
			return databaseError(err)
		}
		items[i].UsageID = row.ID
	}
	return nil
}

func (s *Service) consumeUsages(ctx context.Context, tx pgx.Tx, q *machinelogbookdb.Queries, p authorization.Principal, items []parsedUsage, occurredAt time.Time, requestID *uuid.UUID) error {
	for _, item := range items {
		if item.Ownership == "external" {
			continue
		}
		current, err := q.GetMaterialForUpdate(ctx, *item.MaterialID)
		if err != nil {
			return noRows(err)
		}
		if !current.Active {
			return conflict("material_inactive", "An inactive material cannot be consumed")
		}
		average := decimalFromNumeric(current.AverageUnitCost)
		_, err = s.applyInventoryMutation(ctx, tx, q, p, *item.MaterialID, current.InventoryVersion, inventoryMutation{Kind: "machine_run_consumption", QuantityDelta: item.Quantity.Neg(), UnitCost: average, ValueDelta: item.Quantity.Mul(average).Neg(), OccurredAt: occurredAt, UsageID: &item.UsageID, Fill: item.Fill}, requestID)
		if err != nil {
			return err
		}
	}
	return nil
}

func snapshotRuleFromRow(row machinelogbookdb.MachineJobPricingSnapshotRule) PricingSnapshotRule {
	return PricingSnapshotRule{SourceRuleID: row.SourceRuleID, Kind: row.Kind, Label: row.Label, Selector: row.Selector, Unit: row.Unit, Measure: row.Measure, BlockSize: row.BlockSize, Rate: nullableDecimal(row.Rate), Missing: row.Missing}
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

func (s *Service) jobPricingInputs(ctx context.Context, q *machinelogbookdb.Queries, jobID uuid.UUID) (pricingInputs, error) {
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

func (s *Service) capturePricingSnapshot(ctx context.Context, q *machinelogbookdb.Queries, p authorization.Principal, job machinelogbookdb.MachineJob, group machinelogbookdb.PricingGroup, reason string) (machinelogbookdb.MachineJob, error) {
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
		if rules[i].Kind == "machine_runtime" && rules[i].MachineTypeID != nil && *rules[i].MachineTypeID == machine.MachineTypeID {
			r := rules[i]
			runtime = &r
			break
		}
	}
	runtimeEntry := machinelogbookdb.InsertPricingSnapshotRuleParams{ID: newID(), Kind: "machine_runtime", Label: "Machine runtime", Selector: machine.MachineTypeID.String(), Unit: "hour"}
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
		entry := machinelogbookdb.InsertPricingSnapshotRuleParams{ID: newID(), Kind: "machine_measure", Label: definition.Label, Selector: key, Measure: &definition.Key, BlockSize: &block, Unit: definition.Unit}
		var matched *machinelogbookdb.PricingRule
		for i := range rules {
			if rules[i].Kind == "machine_measure" && rules[i].MachineTypeID != nil && *rules[i].MachineTypeID == machine.MachineTypeID && rules[i].Measure != nil && *rules[i].Measure == key {
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
		if usage.Ownership == "external" {
			continue
		}
		var matched *machinelogbookdb.PricingRule
		for i := range rules {
			if rules[i].Kind == "material" && rules[i].MaterialTypeID != nil && usage.MaterialTypeID != nil && *rules[i].MaterialTypeID == *usage.MaterialTypeID && rules[i].MaterialUnit != nil && *rules[i].MaterialUnit == usage.Unit {
				r := rules[i]
				matched = &r
				break
			}
		}
		entry := machinelogbookdb.InsertPricingSnapshotRuleParams{ID: newID(), Kind: "material", Label: usage.MaterialName, Selector: usage.MaterialTypeName, MaterialTypeID: usage.MaterialTypeID, Unit: usage.Unit}
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
	snapshotID := newID()
	calculated := pgtype.Numeric{}
	status := "incomplete"
	if complete {
		total = total.Round(2)
		calculated = numericFromDecimal(total)
		status = "complete"
	}
	_, err = q.CreatePricingSnapshot(ctx, machinelogbookdb.CreatePricingSnapshotParams{ID: snapshotID, MachineJobID: job.ID, Revision: revision, PricingGroupID: &group.ID, PricingGroupName: group.Name, Reason: reason, Complete: complete, CalculatedAmount: calculated, CapturedByAccountID: accountPointer(p)})
	if err != nil {
		return job, err
	}
	for _, entry := range snapshotRules {
		entry.SnapshotID = snapshotID
		if _, err = q.InsertPricingSnapshotRule(ctx, entry); err != nil {
			return job, err
		}
	}
	updated, err := q.ActivatePricingSnapshot(ctx, machinelogbookdb.ActivatePricingSnapshotParams{SnapshotID: &snapshotID, PricingStatus: status, CalculatedPrice: calculated, EffectivePrice: effectivePriceForRow(job, calculated), ID: job.ID, ExpectedVersion: job.Version})
	if errors.Is(err, pgx.ErrNoRows) {
		return job, apperror.StaleWrite
	}
	return updated, err
}

// manualRunPlan is a validated manual run that is ready to be stored.
type manualRunPlan struct {
	StartsAt, EndsAt time.Time
	Outcome          *string
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
	return manualRunPlan{StartsAt: input.StartsAt.UTC(), EndsAt: input.EndsAt.UTC(), Outcome: outcome, Usages: parsed, Measures: input.Measures}, nil
}

// storeManualRun inserts a manual run on the job's machine together with its
// material usage, consuming inventory for it.
func (s *Service) storeManualRun(ctx context.Context, tx pgx.Tx, q *machinelogbookdb.Queries, p authorization.Principal, job machinelogbookdb.MachineJob, plan manualRunPlan, requestID *uuid.UUID) (machinelogbookdb.MachineRun, error) {
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
	run, err := q.InsertManualRun(ctx, machinelogbookdb.InsertManualRunParams{ID: newID(), DisplayID: formatRunDisplayID(sequence, s.now()), MachineID: job.MachineID, JobID: &job.ID, StartedAt: pgTime(&plan.StartsAt), EndedAt: pgTime(&plan.EndsAt), Outcome: plan.Outcome})
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

func (s *Service) CreateManualJob(ctx context.Context, p authorization.Principal, input JobInput, requestID *uuid.UUID) (MachineJob, error) {
	if err := require(p, authorization.MachineJobsCreate); err != nil {
		return MachineJob{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MachineJob{}, err
	}
	defer tx.Rollback(ctx)
	job, err := s.CreateManualJobInTransaction(ctx, tx, false, p, input, requestID)
	if err != nil {
		return MachineJob{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MachineJob{}, err
	}
	return s.loadJob(ctx, job.ID)
}

// CreateManualJobInTransaction creates a job with one manual run.
func (s *Service) CreateManualJobInTransaction(ctx context.Context, tx pgx.Tx, anonymous bool, p authorization.Principal, input JobInput, requestID *uuid.UUID) (MachineJob, error) {
	if err := require(p, authorization.MachineJobsCreate); err != nil {
		return MachineJob{}, err
	}
	now := s.now()
	outcome, err := parseOutcome(input.Outcome)
	if err != nil {
		return MachineJob{}, err
	}
	plan, err := planManualRun(ManualRunInput{StartsAt: input.StartsAt, EndsAt: input.EndsAt, Outcome: outcome, Usages: input.Usages, Measures: input.Measures}, now)
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
	if machine.Status == "retired" {
		return MachineJob{}, conflict("machine_retired", "Retired machines cannot receive new jobs")
	}
	personID, organizationID, err := validateJobAssignments(ctx, q, input.Customer, input.OperatorPersonID, anonymous)
	if err != nil {
		return MachineJob{}, err
	}
	group, err := resolvePricingGroup(ctx, q, personID, organizationID, input.PricingGroupID)
	if err != nil {
		return MachineJob{}, err
	}
	job, err := s.insertJob(ctx, q, now, input.MachineID, personID, organizationID, input.OperatorPersonID, title, cleanOptional(input.Notes))
	if err != nil {
		return MachineJob{}, err
	}
	if _, err = s.storeManualRun(ctx, tx, q, p, job, plan, requestID); err != nil {
		return MachineJob{}, err
	}
	job, err = s.capturePricingSnapshot(ctx, q, p, job, group, "initial")
	if err != nil {
		return MachineJob{}, err
	}
	if err = writeAudit(ctx, tx, p, "machine_job.created", "machine_job", job.ID, requestID, []string{"machineId", "title", "customer", "operatorPersonId", "notes", "runs", "usages", "pricingSnapshot"}); err != nil {
		return MachineJob{}, err
	}
	return s.jobFromRow(ctx, q, job)
}

func (s *Service) insertJob(ctx context.Context, q *machinelogbookdb.Queries, now time.Time, machineID uuid.UUID, personID, organizationID *uuid.UUID, operatorID uuid.UUID, title, notes *string) (machinelogbookdb.MachineJob, error) {
	sequence, err := q.NextMachineJobSequence(ctx)
	if err != nil {
		return machinelogbookdb.MachineJob{}, err
	}
	job, err := q.CreateMachineJob(ctx, machinelogbookdb.CreateMachineJobParams{ID: newID(), DisplayID: formatDisplayID(sequence, now), MachineID: machineID, CustomerPersonID: personID, CustomerOrganizationID: organizationID, OperatorPersonID: &operatorID, Title: title, Notes: notes})
	if err != nil {
		return job, databaseError(err)
	}
	return job, nil
}

func (s *Service) loadBillingParty(ctx context.Context, q *machinelogbookdb.Queries, job machinelogbookdb.MachineJob) (*BillingParty, error) {
	if job.CustomerPersonID != nil {
		row, err := q.GetBillingPerson(ctx, *job.CustomerPersonID)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		item := &BillingParty{ID: row.ID, Kind: "person", DisplayName: row.DisplayName, PricingGroupAssignmentVersion: row.PricingGroupAssignmentVersion}
		if row.PricingGroupID != nil && row.PricingGroupName != nil {
			item.PricingGroup = &PricingGroupSummary{ID: *row.PricingGroupID, Name: *row.PricingGroupName}
		}
		return item, nil
	}
	if job.CustomerOrganizationID != nil {
		row, err := q.GetBillingOrganization(ctx, *job.CustomerOrganizationID)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		item := &BillingParty{ID: row.ID, Kind: "organization", DisplayName: row.DisplayName, OrganizationKind: &row.OrganizationKind, PricingGroupAssignmentVersion: row.PricingGroupAssignmentVersion}
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

func (s *Service) jobFromRow(ctx context.Context, q *machinelogbookdb.Queries, row machinelogbookdb.MachineJob) (MachineJob, error) {
	machineRow, err := q.GetMachine(ctx, row.MachineID)
	if err != nil {
		return MachineJob{}, err
	}
	runs, err := s.runsForJob(ctx, q, row.ID)
	if err != nil {
		return MachineJob{}, err
	}
	item := MachineJob{ID: row.ID, DisplayID: row.DisplayID, Title: row.Title, Machine: machineFromGet(machineRow), Runs: runs, Outcome: "unknown", OutcomeOverridden: row.OutcomeOverride != nil, Notes: row.Notes, PricingStatus: row.PricingStatus, CalculatedPrice: nullableDecimal(row.CalculatedPrice), EffectivePrice: nullableDecimal(row.EffectivePrice), Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt, Usages: []MachineJobUsage{}}
	if row.ArtifactID != nil {
		artifact, artifactErr := q.GetArtifactReference(ctx, *row.ArtifactID)
		if artifactErr != nil {
			return MachineJob{}, artifactErr
		}
		item.Artifact = &ArtifactReference{ID: artifact.ID, SHA256: artifact.Sha256, ParserStatus: artifact.ParserStatus}
	}
	item.Measures = RunMeasures{}
	for _, run := range runs {
		if run.State != "replaced" {
			item.Usages = append(item.Usages, run.Usages...)
			item.Measures.add(run.Measures)
		}
	}
	summary, err := q.GetMachineJobRunSummary(ctx, &row.ID)
	hasSummary := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return MachineJob{}, err
	}
	derived := "unknown"
	if hasSummary {
		item.StartedAt, item.EndedAt, item.ExpectedEndAt = anyTime(summary.StartedAt), anyTime(summary.EndedAt), anyTime(summary.ExpectedEndAt)
		item.DurationSeconds = summary.RuntimeSeconds
		derived = summary.DerivedOutcome
	}
	effective := derived
	if row.OutcomeOverride != nil {
		effective = *row.OutcomeOverride
	}
	switch {
	case !hasSummary && row.ArtifactID != nil:
		item.Status = "planned"
	case hasSummary && summary.Running:
		item.Status = "running"
	case effective == "unknown":
		item.Status, item.Outcome = "needs_outcome", "unknown"
	default:
		item.Status, item.Outcome = effective, effective
	}
	if row.PriceAdjustmentKind != nil {
		item.PriceAdjustment = &PriceAdjustment{Kind: *row.PriceAdjustmentKind, Value: decimalString(row.PriceAdjustmentValue), Reason: stringValue(row.PriceAdjustmentReason), AdjustedAt: row.PriceAdjustedAt.Time}
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
		domain := PricingSnapshot{ID: snapshot.ID, Revision: int(snapshot.Revision), PricingGroupName: snapshot.PricingGroupName, Currency: snapshot.Currency, Reason: snapshot.Reason, Complete: snapshot.Complete, CalculatedAmount: nullableDecimal(snapshot.CalculatedAmount), CapturedAt: snapshot.CapturedAt, Rules: make([]PricingSnapshotRule, 0, len(snapshotRules))}
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

func (s *Service) ListJobs(ctx context.Context, p authorization.Principal, filters JobFilters) ([]MachineJob, int64, error) {
	if err := require(p, authorization.MachineJobsRead); err != nil {
		return nil, 0, err
	}
	offset, limit, err := pageBounds(filters.Page, filters.PageSize)
	if err != nil {
		return nil, 0, err
	}
	if filters.From != nil && filters.To != nil && !filters.To.After(*filters.From) {
		return nil, 0, validation("to must be after from")
	}
	params := machinelogbookdb.ListMachineJobIDsParams{Search: strings.TrimSpace(filters.Search), MachineID: filters.MachineID, CustomerID: filters.CustomerID, OperatorID: filters.OperatorID, MaterialID: filters.MaterialID, Outcome: filters.Outcome, FromTime: pgTime(filters.From), ToTime: pgTime(filters.To), PageOffset: offset, PageLimit: limit}
	q := machinelogbookdb.New(s.pool)
	ids, err := q.ListMachineJobIDs(ctx, params)
	if err != nil {
		return nil, 0, err
	}
	total, err := q.CountMachineJobs(ctx, machinelogbookdb.CountMachineJobsParams{Search: params.Search, MachineID: params.MachineID, CustomerID: params.CustomerID, OperatorID: params.OperatorID, MaterialID: params.MaterialID, Outcome: params.Outcome, FromTime: params.FromTime, ToTime: params.ToTime})
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
func (s *Service) UpdateJobFacts(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, input JobUpdate, requestID *uuid.UUID) (MachineJob, error) {
	if err := require(p, authorization.MachineJobsEdit); err != nil {
		return MachineJob{}, err
	}
	if expected < 1 {
		return MachineJob{}, validation("expectedVersion must be positive")
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
	defer tx.Rollback(ctx)
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
		if newMachine.Status == "retired" {
			return MachineJob{}, conflict("machine_retired", "Retired machines cannot receive jobs")
		}
		recorded, err := q.CountJobRecordedRuns(ctx, &id)
		if err != nil {
			return MachineJob{}, err
		}
		if recorded > 0 {
			return MachineJob{}, conflict("machine_change_not_allowed", "The machine of a job with recorded runs cannot change")
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
					return MachineJob{}, apperror.New(422, "run_measure_unsupported", "The new machine's process does not record the measures of this job's runs")
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
			return MachineJob{}, apperror.New(422, "outcome_before_run_end", "An outcome cannot be recorded before the runs have ended")
		}
	}
	if input.Customer.Kind == "" {
		if current.CustomerPersonID != nil {
			input.Customer = PartyReference{Kind: "person", ID: *current.CustomerPersonID}
		} else if current.CustomerOrganizationID != nil {
			input.Customer = PartyReference{Kind: "organization", ID: *current.CustomerOrganizationID}
		}
	}
	personID, organizationID, err := validateJobAssignments(ctx, q, input.Customer, input.OperatorPersonID, current.CustomerPersonID == nil && current.CustomerOrganizationID == nil)
	if err != nil {
		return MachineJob{}, err
	}
	updated, err := q.UpdateMachineJobFacts(ctx, machinelogbookdb.UpdateMachineJobFactsParams{MachineID: input.MachineID, CustomerPersonID: personID, CustomerOrganizationID: organizationID, OperatorPersonID: &input.OperatorPersonID, OutcomeOverride: override, Title: title, Notes: cleanOptional(input.Notes), ID: id, ExpectedVersion: expected})
	if errors.Is(err, pgx.ErrNoRows) {
		return MachineJob{}, apperror.StaleWrite
	}
	if err != nil {
		return MachineJob{}, databaseError(err)
	}
	partyChanged := !sameUUID(current.CustomerPersonID, personID) || !sameUUID(current.CustomerOrganizationID, organizationID)
	if partyChanged || oldMachine.MachineTypeID != newMachine.MachineTypeID || input.PricingGroupID != nil {
		group, err := resolvePricingGroup(ctx, q, personID, organizationID, input.PricingGroupID)
		if err != nil {
			return MachineJob{}, err
		}
		reason := "machine_changed"
		if partyChanged {
			reason = "customer_changed"
		}
		if input.PricingGroupID != nil {
			reason = "manual_reprice"
		}
		updated, err = s.capturePricingSnapshot(ctx, q, p, updated, group, reason)
		if err != nil {
			return MachineJob{}, err
		}
	} else {
		updated, err = s.recalculateFromSnapshot(ctx, q, updated)
		if err != nil {
			return MachineJob{}, err
		}
	}
	if err = writeAudit(ctx, tx, p, "machine_job.updated", "machine_job", id, requestID, []string{"machineId", "title", "customer", "operatorPersonId", "outcomeOverride", "notes", "pricing"}); err != nil {
		return MachineJob{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MachineJob{}, err
	}
	return s.loadJob(ctx, id)
}

// snapshotRuleSelector identifies what a snapshot rule prices: the material type
// for material rules (older rows were backfilled with it), else the stored text.
func snapshotRuleSelector(rule machinelogbookdb.MachineJobPricingSnapshotRule) string {
	if rule.Kind == "material" && rule.MaterialTypeID != nil {
		return rule.MaterialTypeID.String()
	}
	return rule.Selector
}

// snapshotRuleCovers reports whether a material snapshot rule is the one for the
// usage's material type and unit. A snapshot never changes, so a missing rule
// still covers the usage: it records that this type had no price at capture time.
func snapshotRuleCovers(rule machinelogbookdb.MachineJobPricingSnapshotRule, usage machinelogbookdb.ListRunUsagesForRunsRow) bool {
	return rule.Kind == "material" && rule.MaterialTypeID != nil && usage.MaterialTypeID != nil && *rule.MaterialTypeID == *usage.MaterialTypeID && rule.Unit == usage.Unit
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
func (s *Service) computeFromSnapshot(ctx context.Context, q *machinelogbookdb.Queries, job machinelogbookdb.MachineJob) (string, pgtype.Numeric, error) {
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
		if rule.Kind == "machine_measure" && rule.Measure != nil {
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
			if rule.Kind == "machine_runtime" {
				complete = false
			}
			if rule.Kind == "material" {
				for _, usage := range usages {
					if usage.Ownership == "makerspace" && snapshotRuleCovers(rule, usage) {
						complete = false
						break
					}
				}
			}
			continue
		}
		rate := decimalFromNumeric(rule.Rate)
		if rule.Kind == "machine_runtime" {
			runtimeFound = true
			total = total.Add(runtimeHours(runtimeSeconds).Mul(rate))
			continue
		}
		for _, usage := range usages {
			if usage.Ownership == "makerspace" && snapshotRuleCovers(rule, usage) {
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
		if usage.Ownership == "external" {
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
		return "incomplete", pgtype.Numeric{}, nil
	}
	return "complete", numericFromDecimal(total.Round(2)), nil
}

// recalculateFromSnapshot reprices the job and bumps its version.
func (s *Service) recalculateFromSnapshot(ctx context.Context, q *machinelogbookdb.Queries, job machinelogbookdb.MachineJob) (machinelogbookdb.MachineJob, error) {
	if job.ActivePricingSnapshotID == nil {
		return job, nil
	}
	status, amount, err := s.computeFromSnapshot(ctx, q, job)
	if err != nil {
		return job, err
	}
	updated, err := q.RecalculateMachineJobPrice(ctx, machinelogbookdb.RecalculateMachineJobPriceParams{PricingStatus: status, CalculatedPrice: amount, EffectivePrice: effectivePriceForRow(job, amount), ID: job.ID, ExpectedVersion: job.Version})
	if errors.Is(err, pgx.ErrNoRows) {
		return job, apperror.StaleWrite
	}
	return updated, err
}

// refreshPriceKeepingVersion reprices the job without a new version; connector
// progress keeps the price of a running job current this way.
func (s *Service) refreshPriceKeepingVersion(ctx context.Context, q *machinelogbookdb.Queries, job machinelogbookdb.MachineJob) (machinelogbookdb.MachineJob, error) {
	if job.ActivePricingSnapshotID == nil {
		return job, nil
	}
	status, amount, err := s.computeFromSnapshot(ctx, q, job)
	if err != nil {
		return job, err
	}
	return q.RefreshMachineJobPrice(ctx, machinelogbookdb.RefreshMachineJobPriceParams{PricingStatus: status, CalculatedPrice: amount, EffectivePrice: effectivePriceForRow(job, amount), ID: job.ID})
}

// coverUsages captures a new snapshot of the job's pricing group when a run
// brought material of a category the active snapshot has no rule for, for
// example material a machine reported after the job was created.
func (s *Service) coverUsages(ctx context.Context, q *machinelogbookdb.Queries, job machinelogbookdb.MachineJob) (machinelogbookdb.MachineJob, error) {
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
			if rule.Kind == "machine_measure" && rule.Measure != nil && *rule.Measure == key {
				found = true
				break
			}
		}
		covered = covered && found
	}
	for _, usage := range usages {
		if usage.Ownership == "external" {
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
	return s.capturePricingSnapshot(ctx, q, authorization.Principal{}, job, group, "manual_reprice")
}

// settleJob reprices a locked job after its runs or their material changed.
// The job version always advances so orders notice the change.
func (s *Service) settleJob(ctx context.Context, q *machinelogbookdb.Queries, jobID uuid.UUID) (machinelogbookdb.MachineJob, error) {
	job, err := q.GetMachineJobForUpdate(ctx, jobID)
	if err != nil {
		return job, noRows(err)
	}
	if job, err = s.coverUsages(ctx, q, job); err != nil {
		return job, err
	}
	if job.ActivePricingSnapshotID == nil {
		return q.BumpMachineJobVersion(ctx, machinelogbookdb.BumpMachineJobVersionParams{ID: jobID, ExpectedVersion: job.Version})
	}
	return s.recalculateFromSnapshot(ctx, q, job)
}

func stringPointer(value string) *string { return &value }

// ChargeSource locks a job and returns domain data using the caller's transaction.
func (s *Service) ChargeSource(ctx context.Context, tx pgx.Tx, p authorization.Principal, id uuid.UUID) (MachineJob, error) {
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
	if job.Status == "running" {
		return MachineJob{}, conflict("job_running", "A job with a running run cannot be ordered until its runs have ended")
	}
	if job.Status == "planned" {
		return MachineJob{}, conflict("job_planned", "A planned job cannot be ordered until it has a run")
	}
	return job, nil
}

func validateJobAssignments(ctx context.Context, q *machinelogbookdb.Queries, party PartyReference, operator uuid.UUID, anonymous bool) (*uuid.UUID, *uuid.UUID, error) {
	if operator == uuid.Nil {
		return nil, nil, validation("operatorPersonId is required")
	}
	ok, err := q.OperatorExists(ctx, operator)
	if err != nil {
		return nil, nil, err
	}
	if !ok {
		return nil, nil, validation("operator must have an enabled account")
	}
	return validateParty(ctx, q, party, anonymous)
}
