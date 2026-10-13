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
	// Fill is the open fill a spool usage draws from; it is resolved inside
	// the transaction that records the usage.
	Fill *fillRef
}

func validateOutcome(value string) error {
	switch value {
	case "successful", "partial_failure", "failed", "cancelled", "unknown":
		return nil
	}
	return validation("invalid outcome")
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
func usageFillRef(u machinelogbookdb.MachineJobMaterialUsage) *fillRef {
	if u.MaterialID == nil || u.SpoolID == nil || u.FillID == nil || u.SpoolDisplayID == nil || u.FillNumber == nil {
		return nil
	}
	return &fillRef{SpoolID: *u.SpoolID, FillID: *u.FillID, SpoolDisplayID: *u.SpoolDisplayID, FillNumber: *u.FillNumber, MaterialID: *u.MaterialID}
}

// reversalFill returns the fill a usage correction goes back to. A usage whose
// fill was closed in the meantime, or whose spool was deleted, returns to loose
// stock instead.
func (s *Service) reversalFill(ctx context.Context, q *machinelogbookdb.Queries, u machinelogbookdb.MachineJobMaterialUsage) (*fillRef, error) {
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

func (s *Service) insertUsages(ctx context.Context, q *machinelogbookdb.Queries, jobID uuid.UUID, items []parsedUsage) error {
	for i := range items {
		params := machinelogbookdb.InsertMachineJobUsageParams{ID: items[i].UsageID, MachineJobID: jobID, MaterialID: items[i].MaterialID, SpoolID: items[i].SpoolID, Ownership: items[i].Ownership, ExternalMaterialName: items[i].ExternalMaterialName, QuantityBasis: items[i].QuantityBasis, Quantity: numericFromDecimal(items[i].Quantity), SourcePrinterEventID: items[i].SourcePrinterEventID}
		if fill := items[i].Fill; fill != nil && items[i].SpoolID != nil {
			params.FillID, params.SpoolDisplayID, params.FillNumber = &fill.FillID, &fill.SpoolDisplayID, &fill.FillNumber
		}
		row, err := q.InsertMachineJobUsage(ctx, params)
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
		_, err = s.applyInventoryMutation(ctx, tx, q, p, *item.MaterialID, current.InventoryVersion, inventoryMutation{Kind: "machine_job_consumption", QuantityDelta: item.Quantity.Neg(), UnitCost: average, ValueDelta: item.Quantity.Mul(average).Neg(), OccurredAt: occurredAt, UsageID: &item.UsageID, Fill: item.Fill}, requestID)
		if err != nil {
			return err
		}
	}
	return nil
}

func snapshotRuleFromRow(row machinelogbookdb.MachineJobPricingSnapshotRule) PricingSnapshotRule {
	return PricingSnapshotRule{SourceRuleID: row.SourceRuleID, Kind: row.Kind, Label: row.Label, Selector: row.Selector, Unit: row.Unit, Rate: nullableDecimal(row.Rate), Missing: row.Missing}
}

func runtimeHours(startsAt, endsAt time.Time) decimal.Decimal {
	nanoseconds := decimal.NewFromInt(endsAt.Sub(startsAt).Nanoseconds())
	return nanoseconds.Div(decimal.NewFromInt(int64(time.Hour)))
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
	usages, err := q.ListMachineJobUsages(ctx, job.ID)
	if err != nil {
		return job, err
	}
	complete := true
	total := decimal.Zero
	snapshotRules := make([]machinelogbookdb.InsertPricingSnapshotRuleParams, 0, len(usages)+1)
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
		hours := runtimeHours(job.StartsAt, job.EndsAt)
		total = total.Add(hours.Mul(decimalFromNumeric(runtime.Rate)))
	}
	snapshotRules = append(snapshotRules, runtimeEntry)
	for _, usage := range usages {
		if usage.Ownership == "external" {
			continue
		}
		var matched *machinelogbookdb.PricingRule
		for i := range rules {
			if rules[i].Kind == "material" && rules[i].MaterialCategory != nil && rules[i].MaterialUnit != nil && *rules[i].MaterialCategory == usage.Category && *rules[i].MaterialUnit == usage.Unit {
				r := rules[i]
				matched = &r
				break
			}
		}
		entry := machinelogbookdb.InsertPricingSnapshotRuleParams{ID: newID(), Kind: "material", Label: usage.MaterialName, Selector: usage.Category, Unit: usage.Unit}
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
	actor := p.AccountID
	_, err = q.CreatePricingSnapshot(ctx, machinelogbookdb.CreatePricingSnapshotParams{ID: snapshotID, MachineJobID: job.ID, Revision: revision, PricingGroupID: &group.ID, PricingGroupName: group.Name, Reason: reason, Complete: complete, CalculatedAmount: calculated, CapturedByAccountID: &actor})
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
	return job, nil
}
func (s *Service) CreateManualJobInTransaction(ctx context.Context, tx pgx.Tx, anonymous bool, p authorization.Principal, input JobInput, requestID *uuid.UUID) (MachineJob, error) {
	if err := require(p, authorization.MachineJobsCreate); err != nil {
		return MachineJob{}, err
	}
	if err := validateInterval(input.StartsAt, input.EndsAt); err != nil {
		return MachineJob{}, err
	}
	if err := validateOutcome(input.Outcome); err != nil {
		return MachineJob{}, err
	}
	now := s.now()
	if err := validateOutcomeTiming(input.EndsAt, input.Outcome, now); err != nil {
		return MachineJob{}, err
	}
	title, err := cleanTitle(input.Title)
	if err != nil {
		return MachineJob{}, err
	}
	parsed, err := parseUsages(input.Usages)
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
	sequence, err := q.NextMachineJobSequence(ctx)
	if err != nil {
		return MachineJob{}, err
	}
	id := newID()
	job, err := q.CreateMachineJob(ctx, machinelogbookdb.CreateMachineJobParams{ID: id, DisplayID: formatDisplayID(sequence, now), MachineID: input.MachineID, StartsAt: input.StartsAt.UTC(), EndsAt: input.EndsAt.UTC(), Source: "manual", ReviewState: "confirmed", CustomerPersonID: personID, CustomerOrganizationID: organizationID, OperatorPersonID: &input.OperatorPersonID, Outcome: input.Outcome, Title: title, Notes: cleanOptional(input.Notes), ExternalMetadata: []byte("{}")})
	if err != nil {
		return MachineJob{}, databaseError(err)
	}
	if err = s.resolveUsageFills(ctx, q, parsed); err != nil {
		return MachineJob{}, err
	}
	if err = s.insertUsages(ctx, q, id, parsed); err != nil {
		return MachineJob{}, err
	}
	if err = s.consumeUsages(ctx, tx, q, p, parsed, input.EndsAt.UTC(), requestID); err != nil {
		return MachineJob{}, err
	}
	job, err = s.capturePricingSnapshot(ctx, q, p, job, group, "initial")
	if err != nil {
		return MachineJob{}, err
	}
	if err = writeAudit(ctx, tx, p, "machine_job.created", "machine_job", id, requestID, []string{"machineId", "title", "startsAt", "endsAt", "customer", "operatorPersonId", "outcome", "notes", "usages", "pricingSnapshot"}); err != nil {
		return MachineJob{}, err
	}
	return s.jobFromRow(ctx, q, job)
}

func (s *Service) ConfirmJob(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, party PartyReference, operator uuid.UUID, outcome string, notes *string, pricingGroupID *uuid.UUID, requestID *uuid.UUID) (MachineJob, error) {
	if err := require(p, authorization.MachineJobsReview); err != nil {
		return MachineJob{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MachineJob{}, err
	}
	defer tx.Rollback(ctx)
	job, err := s.ConfirmJobInTransaction(ctx, tx, false, p, id, expected, party, operator, outcome, notes, pricingGroupID, requestID)
	if err != nil {
		return MachineJob{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MachineJob{}, err
	}
	return job, nil
}
func (s *Service) ConfirmJobInTransaction(ctx context.Context, tx pgx.Tx, anonymous bool, p authorization.Principal, id uuid.UUID, expected int64, party PartyReference, operator uuid.UUID, outcome string, notes *string, pricingGroupID *uuid.UUID, requestID *uuid.UUID) (MachineJob, error) {
	if err := require(p, authorization.MachineJobsReview); err != nil {
		return MachineJob{}, err
	}
	if expected < 1 {
		return MachineJob{}, validation("expectedVersion must be positive")
	}
	if err := validateOutcome(outcome); err != nil {
		return MachineJob{}, err
	}
	var err error
	q := machinelogbookdb.New(tx)
	current, err := q.GetMachineJobForUpdate(ctx, id)
	if err != nil {
		return MachineJob{}, noRows(err)
	}
	if current.Version != expected {
		return MachineJob{}, apperror.StaleWrite
	}
	if current.ReviewState != "needs_review" {
		return MachineJob{}, conflict("job_not_pending_review", "Job is not awaiting review")
	}
	personID, organizationID, err := validateJobAssignments(ctx, q, party, operator, anonymous)
	if err != nil {
		return MachineJob{}, err
	}
	group, err := resolvePricingGroup(ctx, q, personID, organizationID, pricingGroupID)
	if err != nil {
		return MachineJob{}, err
	}
	job, err := s.confirmReviewedJob(ctx, tx, q, p, current, machinelogbookdb.ConfirmMachineJobParams{CustomerPersonID: personID, CustomerOrganizationID: organizationID, OperatorPersonID: &operator, Outcome: outcome, Notes: cleanOptional(notes)}, group, requestID, []string{"customer", "operatorPersonId", "outcome", "notes", "reviewState", "pricingSnapshot", "inventory"})
	if err != nil {
		return MachineJob{}, err
	}
	return s.jobFromRow(ctx, q, job)
}

// confirmReviewedJob moves a locked needs_review job to confirmed: it records
// the reviewed facts, consumes the job's material usage, captures the initial
// pricing snapshot and writes the audit event. Review confirmation and the
// legacy confirm-by-edit path share it so both behave identically.
func (s *Service) confirmReviewedJob(ctx context.Context, tx pgx.Tx, q *machinelogbookdb.Queries, p authorization.Principal, current machinelogbookdb.MachineJob, facts machinelogbookdb.ConfirmMachineJobParams, group machinelogbookdb.PricingGroup, requestID *uuid.UUID, auditFields []string) (machinelogbookdb.MachineJob, error) {
	facts.ID = current.ID
	facts.ExpectedVersion = current.Version
	job, err := q.ConfirmMachineJob(ctx, facts)
	if errors.Is(err, pgx.ErrNoRows) {
		return job, apperror.StaleWrite
	}
	if err != nil {
		return job, err
	}
	rows, err := q.ListAllMachineJobUsagesForUpdate(ctx, current.ID)
	if err != nil {
		return job, err
	}
	parsed := make([]parsedUsage, 0, len(rows))
	for _, row := range rows {
		parsed = append(parsed, parsedUsage{MaterialID: row.MaterialID, SpoolID: row.SpoolID, Ownership: row.Ownership, ExternalMaterialName: row.ExternalMaterialName, QuantityBasis: row.QuantityBasis, Quantity: decimalFromNumeric(row.Quantity), UsageID: row.ID, SourcePrinterEventID: row.SourcePrinterEventID, Fill: usageFillRef(row)})
	}
	sort.Slice(parsed, func(i, j int) bool { return usageSortKey(parsed[i]) < usageSortKey(parsed[j]) })
	if err = s.consumeUsages(ctx, tx, q, p, parsed, current.EndsAt, requestID); err != nil {
		return job, err
	}
	job, err = s.capturePricingSnapshot(ctx, q, p, job, group, "initial")
	if err != nil {
		return job, err
	}
	if err = writeAudit(ctx, tx, p, "machine_job.confirmed", "machine_job", current.ID, requestID, auditFields); err != nil {
		return job, err
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

func (s *Service) jobFromRow(ctx context.Context, q *machinelogbookdb.Queries, row machinelogbookdb.MachineJob) (MachineJob, error) {
	machineRow, err := q.GetMachine(ctx, row.MachineID)
	if err != nil {
		return MachineJob{}, err
	}
	usages, err := q.ListMachineJobUsages(ctx, row.ID)
	if err != nil {
		return MachineJob{}, err
	}
	item := MachineJob{ID: row.ID, DisplayID: row.DisplayID, Title: row.Title, Status: jobStatus(row.Outcome, row.EndsAt, s.now()), Machine: machineFromGet(machineRow), StartsAt: row.StartsAt, EndsAt: row.EndsAt, DurationSeconds: int64(row.EndsAt.Sub(row.StartsAt).Seconds()), Source: row.Source, ExternalID: row.ExternalID, ReviewState: row.ReviewState, Outcome: row.Outcome, Notes: row.Notes, PricingStatus: row.PricingStatus, CalculatedPrice: nullableDecimal(row.CalculatedPrice), EffectivePrice: nullableDecimal(row.EffectivePrice), Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt, Usages: make([]MachineJobUsage, 0, len(usages))}
	item.Run = "manual"
	if row.PrintID != nil {
		item.Run = "automatic"
		item.Print, err = s.loadPrintReference(ctx, q, *row.PrintID)
		if err != nil {
			return MachineJob{}, err
		}
	}
	if row.PriceAdjustmentKind != nil {
		item.PriceAdjustment = &PriceAdjustment{Kind: *row.PriceAdjustmentKind, Value: decimalString(row.PriceAdjustmentValue), Reason: stringValue(row.PriceAdjustmentReason), AdjustedAt: row.PriceAdjustedAt.Time}
	}
	for _, u := range usages {
		item.Usages = append(item.Usages, MachineJobUsage{ID: u.ID, MaterialID: u.MaterialID, SpoolID: u.SpoolID, Ownership: u.Ownership, MaterialName: u.MaterialName, Category: u.Category, Unit: u.Unit, Quantity: decimalString(u.Quantity), QuantityBasis: u.QuantityBasis, SpoolDisplayID: u.SpoolDisplayID, FillNumber: u.FillNumber})
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
	params := machinelogbookdb.ListMachineJobIDsParams{Search: strings.TrimSpace(filters.Search), MachineID: filters.MachineID, CustomerID: filters.CustomerID, OperatorID: filters.OperatorID, MaterialID: filters.MaterialID, Outcome: filters.Outcome, Source: filters.Source, ReviewState: filters.ReviewState, FromTime: pgTime(filters.From), ToTime: pgTime(filters.To), PageOffset: offset, PageLimit: limit}
	q := machinelogbookdb.New(s.pool)
	rows, err := q.ListMachineJobIDs(ctx, params)
	if err != nil {
		return nil, 0, err
	}
	total, err := q.CountMachineJobs(ctx, machinelogbookdb.CountMachineJobsParams{Search: params.Search, MachineID: params.MachineID, CustomerID: params.CustomerID, OperatorID: params.OperatorID, MaterialID: params.MaterialID, Outcome: params.Outcome, Source: params.Source, ReviewState: params.ReviewState, FromTime: params.FromTime, ToTime: params.ToTime})
	if err != nil {
		return nil, 0, err
	}
	items := make([]MachineJob, 0, len(rows))
	for _, row := range rows {
		base, err := q.GetMachineJobBase(ctx, row.ID)
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

func (s *Service) ReviewQueue(ctx context.Context, p authorization.Principal) ([]MachineJob, error) {
	if err := require(p, authorization.MachineJobsReview); err != nil {
		return nil, err
	}
	q := machinelogbookdb.New(s.pool)
	ids, err := q.ListReviewQueueIDs(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]MachineJob, 0, len(ids))
	for _, id := range ids {
		row, err := q.GetMachineJobBase(ctx, id)
		if err != nil {
			return nil, err
		}
		item, err := s.jobFromRow(ctx, q, row)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, nil
}

func (s *Service) UpdateJobFacts(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, input JobInput, requestID *uuid.UUID) (MachineJob, error) {
	if err := require(p, authorization.MachineJobsEdit); err != nil {
		return MachineJob{}, err
	}
	if expected < 1 {
		return MachineJob{}, validation("expectedVersion must be positive")
	}
	if err := validateInterval(input.StartsAt, input.EndsAt); err != nil {
		return MachineJob{}, err
	}
	if err := validateOutcome(input.Outcome); err != nil {
		return MachineJob{}, err
	}
	if err := validateOutcomeTiming(input.EndsAt, input.Outcome, s.now()); err != nil {
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
	legacyReview := current.ReviewState == "needs_review"
	if current.ReviewState != "confirmed" && !legacyReview {
		return MachineJob{}, conflict("job_not_confirmed", "Only confirmed jobs can be edited")
	}
	if legacyReview {
		if input.Outcome == "unknown" {
			return MachineJob{}, apperror.New(422, "outcome_required", "An outcome is required to confirm a job awaiting review")
		}
		if input.Customer.Kind == "" {
			return MachineJob{}, apperror.New(422, "customer_required", "A customer is required to confirm a job awaiting review")
		}
	}
	oldMachine, err := q.GetMachineForUpdate(ctx, current.MachineID)
	if err != nil {
		return MachineJob{}, err
	}
	newMachine, err := q.GetMachineForUpdate(ctx, input.MachineID)
	if err != nil {
		return MachineJob{}, noRows(err)
	}
	if newMachine.Status == "retired" && newMachine.ID != oldMachine.ID {
		return MachineJob{}, conflict("machine_retired", "Retired machines cannot receive jobs")
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
	updated, err := q.UpdateMachineJobFacts(ctx, machinelogbookdb.UpdateMachineJobFactsParams{MachineID: input.MachineID, StartsAt: input.StartsAt.UTC(), EndsAt: input.EndsAt.UTC(), CustomerPersonID: personID, CustomerOrganizationID: organizationID, OperatorPersonID: &input.OperatorPersonID, Outcome: input.Outcome, Title: title, Notes: cleanOptional(input.Notes), ID: id, ExpectedVersion: expected})
	if errors.Is(err, pgx.ErrNoRows) {
		return MachineJob{}, apperror.StaleWrite
	}
	if err != nil {
		return MachineJob{}, err
	}
	if legacyReview {
		group, err := resolvePricingGroup(ctx, q, personID, organizationID, input.PricingGroupID)
		if err != nil {
			return MachineJob{}, err
		}
		if _, err = s.confirmReviewedJob(ctx, tx, q, p, updated, machinelogbookdb.ConfirmMachineJobParams{CustomerPersonID: personID, CustomerOrganizationID: organizationID, OperatorPersonID: &input.OperatorPersonID, Outcome: input.Outcome, Notes: cleanOptional(input.Notes)}, group, requestID, []string{"machineId", "title", "startsAt", "endsAt", "customer", "operatorPersonId", "outcome", "notes", "reviewState", "pricingSnapshot", "inventory"}); err != nil {
			return MachineJob{}, err
		}
		if err = tx.Commit(ctx); err != nil {
			return MachineJob{}, err
		}
		return s.loadJob(ctx, id)
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
	if err = writeAudit(ctx, tx, p, "machine_job.updated", "machine_job", id, requestID, []string{"machineId", "title", "startsAt", "endsAt", "customer", "operatorPersonId", "outcome", "notes", "pricing"}); err != nil {
		return MachineJob{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MachineJob{}, err
	}
	return s.loadJob(ctx, id)
}

func sameUUID(a, b *uuid.UUID) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func (s *Service) recalculateFromSnapshot(ctx context.Context, q *machinelogbookdb.Queries, job machinelogbookdb.MachineJob) (machinelogbookdb.MachineJob, error) {
	if job.ActivePricingSnapshotID == nil {
		return job, nil
	}
	rules, err := q.ListPricingSnapshotRules(ctx, *job.ActivePricingSnapshotID)
	if err != nil {
		return job, err
	}
	usages, err := q.ListMachineJobUsages(ctx, job.ID)
	if err != nil {
		return job, err
	}
	complete := true
	total := decimal.Zero
	var runtimeFound bool
	seenRules := map[string]bool{}
	for _, rule := range rules {
		key := rule.Kind + "/" + rule.Selector + "/" + rule.Unit
		if seenRules[key] {
			continue
		}
		seenRules[key] = true
		if rule.Missing {
			if rule.Kind == "machine_runtime" {
				complete = false
			}
			if rule.Kind == "material" {
				for _, usage := range usages {
					if usage.Ownership == "makerspace" && rule.Selector == usage.Category && rule.Unit == usage.Unit {
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
			hours := runtimeHours(job.StartsAt, job.EndsAt)
			total = total.Add(hours.Mul(rate))
			continue
		}
		matched := false
		for _, usage := range usages {
			if usage.Ownership == "makerspace" && rule.Kind == "material" && rule.Selector == usage.Category && rule.Unit == usage.Unit {
				matched = true
				total = total.Add(decimalFromNumeric(usage.Quantity).Mul(rate))
			}
		}
		_ = matched
	}
	if !runtimeFound {
		complete = false
	}
	for _, usage := range usages {
		if usage.Ownership == "external" {
			continue
		}
		found := false
		for _, rule := range rules {
			if rule.Kind == "material" && rule.Selector == usage.Category && rule.Unit == usage.Unit && !rule.Missing {
				found = true
				break
			}
		}
		if !found {
			complete = false
		}
	}
	status := "incomplete"
	amount := pgtype.Numeric{}
	if complete {
		status = "complete"
		amount = numericFromDecimal(total.Round(2))
	}
	updated, err := q.RecalculateMachineJobPrice(ctx, machinelogbookdb.RecalculateMachineJobPriceParams{PricingStatus: status, CalculatedPrice: amount, EffectivePrice: effectivePriceForRow(job, amount), ID: job.ID, ExpectedVersion: job.Version})
	if errors.Is(err, pgx.ErrNoRows) {
		return job, apperror.StaleWrite
	}
	return updated, err
}

func (s *Service) ReplaceJobUsages(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, inputs []UsageInput, requestID *uuid.UUID) (MachineJob, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MachineJob{}, err
	}
	defer tx.Rollback(ctx)
	if _, err = s.ReplaceJobUsagesInTransaction(ctx, tx, p, id, expected, inputs, nil, requestID); err != nil {
		return MachineJob{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MachineJob{}, err
	}
	return s.loadJob(ctx, id)
}

// ReplaceJobUsagesInTransaction applies a reviewed usage correction inside the
// caller's transaction. Printing reconciliation uses this entry point so the
// source event, inventory movements, job update, and audit records commit as a
// single unit.
func (s *Service) ReplaceJobUsagesInTransaction(ctx context.Context, tx pgx.Tx, p authorization.Principal, id uuid.UUID, expected int64, inputs []UsageInput, sourcePrinterEventID *uuid.UUID, requestID *uuid.UUID) (MachineJob, error) {
	if err := require(p, authorization.MachineJobsEdit); err != nil {
		return MachineJob{}, err
	}
	if expected < 1 {
		return MachineJob{}, validation("expectedVersion must be positive")
	}
	parsed, err := parseUsages(inputs)
	if err != nil {
		return MachineJob{}, err
	}
	for i := range parsed {
		parsed[i].SourcePrinterEventID = sourcePrinterEventID
	}
	q := machinelogbookdb.New(tx)
	job, err := q.GetMachineJobForUpdate(ctx, id)
	if err != nil {
		return MachineJob{}, noRows(err)
	}
	if job.Version != expected {
		return MachineJob{}, apperror.StaleWrite
	}
	if job.ReviewState != "confirmed" {
		return MachineJob{}, conflict("job_not_confirmed", "Only confirmed jobs can be edited")
	}
	old, err := q.ListAllMachineJobUsagesForUpdate(ctx, id)
	if err != nil {
		return MachineJob{}, err
	}
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
			return MachineJob{}, noRows(err)
		}
		versions[materialID] = row.InventoryVersion
	}
	for _, u := range old {
		if u.Ownership == "external" {
			continue
		}
		row, err := q.GetMaterialForUpdate(ctx, *u.MaterialID)
		if err != nil {
			return MachineJob{}, err
		}
		average := decimalFromNumeric(row.AverageUnitCost)
		quantity := decimalFromNumeric(u.Quantity)
		reversal, err := s.reversalFill(ctx, q, u)
		if err != nil {
			return MachineJob{}, err
		}
		_, err = s.applyInventoryMutation(ctx, tx, q, p, *u.MaterialID, versions[*u.MaterialID], inventoryMutation{Kind: "adjustment", QuantityDelta: quantity, UnitCost: average, ValueDelta: quantity.Mul(average), OccurredAt: time.Now().UTC(), Reason: stringPointer("job_corrected"), UsageID: &u.ID, Fill: reversal}, requestID)
		if err != nil {
			return MachineJob{}, err
		}
		versions[*u.MaterialID]++
	}
	if err = q.DeactivateMachineJobUsages(ctx, id); err != nil {
		return MachineJob{}, err
	}
	if err = s.resolveUsageFills(ctx, q, parsed); err != nil {
		return MachineJob{}, err
	}
	if err = s.insertUsages(ctx, q, id, parsed); err != nil {
		return MachineJob{}, err
	}
	for _, u := range parsed {
		if u.Ownership == "external" {
			continue
		}
		row, err := q.GetMaterialForUpdate(ctx, *u.MaterialID)
		if err != nil {
			return MachineJob{}, err
		}
		average := decimalFromNumeric(row.AverageUnitCost)
		_, err = s.applyInventoryMutation(ctx, tx, q, p, *u.MaterialID, versions[*u.MaterialID], inventoryMutation{Kind: "machine_job_consumption", QuantityDelta: u.Quantity.Neg(), UnitCost: average, ValueDelta: u.Quantity.Mul(average).Neg(), OccurredAt: time.Now().UTC(), UsageID: &u.UsageID, Fill: u.Fill}, requestID)
		if err != nil {
			return MachineJob{}, err
		}
		versions[*u.MaterialID]++
	}
	job, err = q.BumpMachineJobVersion(ctx, machinelogbookdb.BumpMachineJobVersionParams{ID: id, ExpectedVersion: expected})
	if errors.Is(err, pgx.ErrNoRows) {
		return MachineJob{}, apperror.StaleWrite
	}
	if err != nil {
		return MachineJob{}, err
	}
	job, err = s.recalculateFromSnapshot(ctx, q, job)
	if err != nil {
		return MachineJob{}, err
	}
	if err = writeAudit(ctx, tx, p, "machine_job.usages_replaced", "machine_job", id, requestID, []string{"usages", "inventory", "calculatedPrice"}); err != nil {
		return MachineJob{}, err
	}
	return s.jobFromRow(ctx, q, job)
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
	return s.jobFromRow(ctx, q, row)
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
