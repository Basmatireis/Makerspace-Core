package machinelogbook

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"reflect"
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
	MaterialID uuid.UUID
	Quantity   decimal.Decimal
	UsageID    uuid.UUID
}

func metadataEqual(left, right []byte) bool {
	var leftValue, rightValue any
	leftDecoder := json.NewDecoder(bytes.NewReader(left))
	leftDecoder.UseNumber()
	rightDecoder := json.NewDecoder(bytes.NewReader(right))
	rightDecoder.UseNumber()
	if leftDecoder.Decode(&leftValue) != nil || rightDecoder.Decode(&rightValue) != nil {
		return false
	}
	return reflect.DeepEqual(leftValue, rightValue)
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
	seen := map[uuid.UUID]bool{}
	for _, input := range inputs {
		if input.MaterialID == uuid.Nil || seen[input.MaterialID] {
			return nil, validation("usages must contain unique material IDs")
		}
		seen[input.MaterialID] = true
		quantity, err := parseDecimal(input.Quantity, true)
		if err != nil {
			return nil, err
		}
		items = append(items, parsedUsage{MaterialID: input.MaterialID, Quantity: quantity, UsageID: newID()})
	}
	sort.Slice(items, func(i, j int) bool { return bytes.Compare(items[i].MaterialID[:], items[j].MaterialID[:]) < 0 })
	return items, nil
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

func (s *Service) insertUsages(ctx context.Context, q *machinelogbookdb.Queries, jobID uuid.UUID, items []parsedUsage) error {
	for i := range items {
		row, err := q.InsertMachineJobUsage(ctx, machinelogbookdb.InsertMachineJobUsageParams{ID: items[i].UsageID, MachineJobID: jobID, MaterialID: items[i].MaterialID, Quantity: numericFromDecimal(items[i].Quantity)})
		if err != nil {
			return databaseError(err)
		}
		items[i].UsageID = row.ID
	}
	return nil
}

func (s *Service) consumeUsages(ctx context.Context, tx pgx.Tx, q *machinelogbookdb.Queries, p authorization.Principal, items []parsedUsage, occurredAt time.Time, requestID *uuid.UUID) error {
	for _, item := range items {
		current, err := q.GetMaterialForUpdate(ctx, item.MaterialID)
		if err != nil {
			return noRows(err)
		}
		if !current.Active {
			return conflict("material_inactive", "An inactive material cannot be consumed")
		}
		average := decimalFromNumeric(current.AverageUnitCost)
		_, err = s.applyInventoryMutation(ctx, tx, q, p, item.MaterialID, current.InventoryVersion, inventoryMutation{Kind: "machine_job_consumption", QuantityDelta: item.Quantity.Neg(), UnitCost: average, ValueDelta: item.Quantity.Mul(average).Neg(), OccurredAt: occurredAt, UsageID: &item.UsageID}, requestID)
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
	updated, err := q.ActivatePricingSnapshot(ctx, machinelogbookdb.ActivatePricingSnapshotParams{SnapshotID: &snapshotID, PricingStatus: status, CalculatedPrice: calculated, ID: job.ID, ExpectedVersion: job.Version})
	if errors.Is(err, pgx.ErrNoRows) {
		return job, apperror.StaleWrite
	}
	return updated, err
}

func (s *Service) CreateManualJob(ctx context.Context, p authorization.Principal, input JobInput, requestID *uuid.UUID) (MachineJob, error) {
	if err := require(p, authorization.MachineJobsCreate); err != nil {
		return MachineJob{}, err
	}
	if err := validateInterval(input.StartsAt, input.EndsAt); err != nil {
		return MachineJob{}, err
	}
	if err := validateOutcome(input.Outcome); err != nil {
		return MachineJob{}, err
	}
	parsed, err := parseUsages(input.Usages)
	if err != nil {
		return MachineJob{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MachineJob{}, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	machine, err := q.GetMachineForUpdate(ctx, input.MachineID)
	if err != nil {
		return MachineJob{}, noRows(err)
	}
	if machine.Status == "retired" {
		return MachineJob{}, conflict("machine_retired", "Retired machines cannot receive new jobs")
	}
	personID, organizationID, err := validatePartyAndOperator(ctx, q, input.Customer, input.OperatorPersonID)
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
	job, err := q.CreateMachineJob(ctx, machinelogbookdb.CreateMachineJobParams{ID: id, DisplayID: formatDisplayID(sequence, time.Now()), MachineID: input.MachineID, StartsAt: input.StartsAt.UTC(), EndsAt: input.EndsAt.UTC(), Source: "manual", ReviewState: "confirmed", CustomerPersonID: personID, CustomerOrganizationID: organizationID, OperatorPersonID: &input.OperatorPersonID, Outcome: input.Outcome, Notes: cleanOptional(input.Notes), ExternalMetadata: []byte("{}")})
	if err != nil {
		return MachineJob{}, databaseError(err)
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
	if err = writeAudit(ctx, tx, p, "machine_job.created", "machine_job", id, requestID, []string{"machineId", "startsAt", "endsAt", "customer", "operatorPersonId", "outcome", "notes", "usages", "pricingSnapshot"}); err != nil {
		return MachineJob{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MachineJob{}, err
	}
	return s.loadJob(ctx, id)
}

func automaticMatches(ctx context.Context, q *machinelogbookdb.Queries, job machinelogbookdb.MachineJob, input AutomaticJobInput, parsed []parsedUsage) (bool, error) {
	if !job.StartsAt.Equal(input.StartsAt.UTC()) || !job.EndsAt.Equal(input.EndsAt.UTC()) || !metadataEqual(job.ExternalMetadata, input.ExternalMetadata) {
		return false, nil
	}
	existing, err := q.ListMachineJobUsages(ctx, job.ID)
	if err != nil {
		return false, err
	}
	if len(existing) != len(parsed) {
		return false, nil
	}
	sort.Slice(existing, func(i, j int) bool { return bytes.Compare(existing[i].MaterialID[:], existing[j].MaterialID[:]) < 0 })
	for i := range parsed {
		if existing[i].MaterialID != parsed[i].MaterialID || !decimalFromNumeric(existing[i].Quantity).Equal(parsed[i].Quantity) {
			return false, nil
		}
	}
	return true, nil
}

func (s *Service) IngestAutomaticJob(ctx context.Context, p authorization.Principal, input AutomaticJobInput, requestID *uuid.UUID) (MachineJob, bool, error) {
	if err := require(p, authorization.MachineJobsCreate); err != nil {
		return MachineJob{}, false, err
	}
	if err := validateInterval(input.StartsAt, input.EndsAt); err != nil {
		return MachineJob{}, false, err
	}
	input.ExternalID = strings.TrimSpace(input.ExternalID)
	if input.ExternalID == "" || len(input.ExternalID) > 200 {
		return MachineJob{}, false, validation("externalId is required and limited to 200 characters")
	}
	if len(input.ExternalMetadata) == 0 {
		input.ExternalMetadata = []byte("{}")
	}
	parsed, err := parseUsages(input.Usages)
	if err != nil {
		return MachineJob{}, false, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MachineJob{}, false, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	existing, err := q.GetAutomaticMachineJob(ctx, machinelogbookdb.GetAutomaticMachineJobParams{MachineID: input.MachineID, ExternalID: &input.ExternalID})
	if err == nil {
		same, matchErr := automaticMatches(ctx, q, existing, input, parsed)
		if matchErr != nil {
			return MachineJob{}, false, matchErr
		}
		if !same {
			return MachineJob{}, false, conflict("external_job_mismatch", "The external job ID was already used with different facts")
		}
		if err = tx.Commit(ctx); err != nil {
			return MachineJob{}, false, err
		}
		job, err := s.loadJob(ctx, existing.ID)
		return job, false, err
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return MachineJob{}, false, err
	}
	machine, err := q.GetMachineForUpdate(ctx, input.MachineID)
	if err != nil {
		return MachineJob{}, false, noRows(err)
	}
	if machine.Status == "retired" || !machine.AutomaticCollectionEnabled {
		return MachineJob{}, false, conflict("automatic_collection_disabled", "Automatic collection is not enabled for this machine")
	}
	sequence, err := q.NextMachineJobSequence(ctx)
	if err != nil {
		return MachineJob{}, false, err
	}
	id := newID()
	_, err = q.CreateMachineJob(ctx, machinelogbookdb.CreateMachineJobParams{ID: id, DisplayID: formatDisplayID(sequence, time.Now()), MachineID: input.MachineID, StartsAt: input.StartsAt.UTC(), EndsAt: input.EndsAt.UTC(), Source: "automatic", ExternalID: &input.ExternalID, ExternalMetadata: input.ExternalMetadata, ReviewState: "needs_review", Outcome: "unknown"})
	if err != nil {
		return MachineJob{}, false, databaseError(err)
	}
	if err = s.insertUsages(ctx, q, id, parsed); err != nil {
		return MachineJob{}, false, err
	}
	if err = q.TouchMachineIngest(ctx, machinelogbookdb.TouchMachineIngestParams{IngestedAt: pgtype.Timestamptz{Time: input.EndsAt.UTC(), Valid: true}, ID: input.MachineID}); err != nil {
		return MachineJob{}, false, err
	}
	if err = writeAudit(ctx, tx, p, "machine_job.ingested", "machine_job", id, requestID, []string{"machineId", "startsAt", "endsAt", "source", "externalId", "usages"}); err != nil {
		return MachineJob{}, false, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MachineJob{}, false, err
	}
	job, err := s.loadJob(ctx, id)
	return job, true, err
}

func (s *Service) ConfirmJob(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, party PartyReference, operator uuid.UUID, outcome string, notes *string, pricingGroupID *uuid.UUID, requestID *uuid.UUID) (MachineJob, error) {
	if err := require(p, authorization.MachineJobsReview); err != nil {
		return MachineJob{}, err
	}
	if expected < 1 {
		return MachineJob{}, validation("expectedVersion must be positive")
	}
	if err := validateOutcome(outcome); err != nil {
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
	if current.ReviewState != "needs_review" {
		return MachineJob{}, conflict("job_not_pending_review", "Job is not awaiting review")
	}
	personID, organizationID, err := validatePartyAndOperator(ctx, q, party, operator)
	if err != nil {
		return MachineJob{}, err
	}
	group, err := resolvePricingGroup(ctx, q, personID, organizationID, pricingGroupID)
	if err != nil {
		return MachineJob{}, err
	}
	job, err := q.ConfirmMachineJob(ctx, machinelogbookdb.ConfirmMachineJobParams{CustomerPersonID: personID, CustomerOrganizationID: organizationID, OperatorPersonID: &operator, Outcome: outcome, Notes: cleanOptional(notes), ID: id, ExpectedVersion: expected})
	if errors.Is(err, pgx.ErrNoRows) {
		return MachineJob{}, apperror.StaleWrite
	}
	if err != nil {
		return MachineJob{}, err
	}
	rows, err := q.ListAllMachineJobUsagesForUpdate(ctx, id)
	if err != nil {
		return MachineJob{}, err
	}
	parsed := make([]parsedUsage, 0, len(rows))
	for _, row := range rows {
		parsed = append(parsed, parsedUsage{MaterialID: row.MaterialID, Quantity: decimalFromNumeric(row.Quantity), UsageID: row.ID})
	}
	sort.Slice(parsed, func(i, j int) bool { return bytes.Compare(parsed[i].MaterialID[:], parsed[j].MaterialID[:]) < 0 })
	if err = s.consumeUsages(ctx, tx, q, p, parsed, current.EndsAt, requestID); err != nil {
		return MachineJob{}, err
	}
	job, err = s.capturePricingSnapshot(ctx, q, p, job, group, "initial")
	if err != nil {
		return MachineJob{}, err
	}
	if err = writeAudit(ctx, tx, p, "machine_job.confirmed", "machine_job", id, requestID, []string{"customer", "operatorPersonId", "outcome", "notes", "reviewState", "pricingSnapshot", "inventory"}); err != nil {
		return MachineJob{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MachineJob{}, err
	}
	return s.loadJob(ctx, id)
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
	item := MachineJob{ID: row.ID, DisplayID: row.DisplayID, Machine: machineFromGet(machineRow), StartsAt: row.StartsAt, EndsAt: row.EndsAt, DurationSeconds: int64(row.EndsAt.Sub(row.StartsAt).Seconds()), Source: row.Source, ExternalID: row.ExternalID, ReviewState: row.ReviewState, Outcome: row.Outcome, Notes: row.Notes, PricingStatus: row.PricingStatus, CalculatedPrice: nullableDecimal(row.CalculatedPrice), FinalPrice: nullableDecimal(row.FinalPrice), PriceOverrideReason: row.PriceOverrideReason, PriceOverriddenAt: nullableTime(row.PriceOverriddenAt), BillingStatus: row.BillingStatus, BillingReference: row.BillingReference, Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt, Usages: make([]MachineJobUsage, 0, len(usages))}
	if item.FinalPrice != nil {
		item.EffectivePrice = item.FinalPrice
	} else {
		item.EffectivePrice = item.CalculatedPrice
	}
	for _, u := range usages {
		item.Usages = append(item.Usages, MachineJobUsage{ID: u.ID, MaterialID: u.MaterialID, MaterialName: u.MaterialName, Category: u.Category, Unit: u.Unit, Quantity: decimalString(u.Quantity)})
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
	params := machinelogbookdb.ListMachineJobIDsParams{Search: strings.TrimSpace(filters.Search), MachineID: filters.MachineID, CustomerID: filters.CustomerID, OperatorID: filters.OperatorID, MaterialID: filters.MaterialID, Outcome: filters.Outcome, BillingStatus: filters.BillingStatus, Source: filters.Source, ReviewState: filters.ReviewState, FromTime: pgTime(filters.From), ToTime: pgTime(filters.To), PageOffset: offset, PageLimit: limit}
	q := machinelogbookdb.New(s.pool)
	rows, err := q.ListMachineJobIDs(ctx, params)
	if err != nil {
		return nil, 0, err
	}
	total, err := q.CountMachineJobs(ctx, machinelogbookdb.CountMachineJobsParams{Search: params.Search, MachineID: params.MachineID, CustomerID: params.CustomerID, OperatorID: params.OperatorID, MaterialID: params.MaterialID, Outcome: params.Outcome, BillingStatus: params.BillingStatus, Source: params.Source, ReviewState: params.ReviewState, FromTime: params.FromTime, ToTime: params.ToTime})
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
	if current.BillingStatus == "billed" {
		return MachineJob{}, conflict("job_billed", "Return the job to unbilled before editing it")
	}
	if current.ReviewState != "confirmed" {
		return MachineJob{}, conflict("job_not_confirmed", "Only confirmed jobs can be edited")
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
	personID, organizationID, err := validatePartyAndOperator(ctx, q, input.Customer, input.OperatorPersonID)
	if err != nil {
		return MachineJob{}, err
	}
	updated, err := q.UpdateMachineJobFacts(ctx, machinelogbookdb.UpdateMachineJobFactsParams{MachineID: input.MachineID, StartsAt: input.StartsAt.UTC(), EndsAt: input.EndsAt.UTC(), CustomerPersonID: personID, CustomerOrganizationID: organizationID, OperatorPersonID: &input.OperatorPersonID, Outcome: input.Outcome, Notes: cleanOptional(input.Notes), ID: id, ExpectedVersion: expected})
	if errors.Is(err, pgx.ErrNoRows) {
		return MachineJob{}, apperror.StaleWrite
	}
	if err != nil {
		return MachineJob{}, err
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
	if err = writeAudit(ctx, tx, p, "machine_job.updated", "machine_job", id, requestID, []string{"machineId", "startsAt", "endsAt", "customer", "operatorPersonId", "outcome", "notes", "pricing"}); err != nil {
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
	for _, rule := range rules {
		if rule.Missing {
			complete = false
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
			if rule.Kind == "material" && rule.Selector == usage.Category && rule.Unit == usage.Unit {
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
	updated, err := q.RecalculateMachineJobPrice(ctx, machinelogbookdb.RecalculateMachineJobPriceParams{PricingStatus: status, CalculatedPrice: amount, ID: job.ID, ExpectedVersion: job.Version})
	if errors.Is(err, pgx.ErrNoRows) {
		return job, apperror.StaleWrite
	}
	return updated, err
}

func (s *Service) ReplaceJobUsages(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, inputs []UsageInput, requestID *uuid.UUID) (MachineJob, error) {
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
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MachineJob{}, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	job, err := q.GetMachineJobForUpdate(ctx, id)
	if err != nil {
		return MachineJob{}, noRows(err)
	}
	if job.Version != expected {
		return MachineJob{}, apperror.StaleWrite
	}
	if job.BillingStatus == "billed" {
		return MachineJob{}, conflict("job_billed", "Return the job to unbilled before editing it")
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
		materialIDs[u.MaterialID] = true
	}
	for _, u := range parsed {
		materialIDs[u.MaterialID] = true
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
		row, err := q.GetMaterialForUpdate(ctx, u.MaterialID)
		if err != nil {
			return MachineJob{}, err
		}
		average := decimalFromNumeric(row.AverageUnitCost)
		quantity := decimalFromNumeric(u.Quantity)
		_, err = s.applyInventoryMutation(ctx, tx, q, p, u.MaterialID, versions[u.MaterialID], inventoryMutation{Kind: "adjustment", QuantityDelta: quantity, UnitCost: average, ValueDelta: quantity.Mul(average), OccurredAt: time.Now().UTC(), Reason: stringPointer("job_corrected"), UsageID: &u.ID}, requestID)
		if err != nil {
			return MachineJob{}, err
		}
		versions[u.MaterialID]++
	}
	if err = q.DeactivateMachineJobUsages(ctx, id); err != nil {
		return MachineJob{}, err
	}
	if err = s.insertUsages(ctx, q, id, parsed); err != nil {
		return MachineJob{}, err
	}
	for _, u := range parsed {
		row, err := q.GetMaterialForUpdate(ctx, u.MaterialID)
		if err != nil {
			return MachineJob{}, err
		}
		average := decimalFromNumeric(row.AverageUnitCost)
		_, err = s.applyInventoryMutation(ctx, tx, q, p, u.MaterialID, versions[u.MaterialID], inventoryMutation{Kind: "machine_job_consumption", QuantityDelta: u.Quantity.Neg(), UnitCost: average, ValueDelta: u.Quantity.Mul(average).Neg(), OccurredAt: time.Now().UTC(), UsageID: &u.UsageID}, requestID)
		if err != nil {
			return MachineJob{}, err
		}
		versions[u.MaterialID]++
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
	if err = tx.Commit(ctx); err != nil {
		return MachineJob{}, err
	}
	return s.loadJob(ctx, id)
}

func stringPointer(value string) *string { return &value }

func (s *Service) OverrideJobPrice(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, finalPrice, reason string, requestID *uuid.UUID) (MachineJob, error) {
	if err := require(p, authorization.MachineJobsOverridePrice); err != nil {
		return MachineJob{}, err
	}
	if expected < 1 {
		return MachineJob{}, validation("expectedVersion must be positive")
	}
	amount, err := numericFromString(finalPrice, false)
	if err != nil || decimalFromNumeric(amount).IsNegative() {
		return MachineJob{}, validation("finalPrice must be non-negative")
	}
	reason = strings.TrimSpace(reason)
	if reason == "" {
		return MachineJob{}, validation("reason is required")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MachineJob{}, err
	}
	defer tx.Rollback(ctx)
	actor := p.AccountID
	_, err = machinelogbookdb.New(tx).SetMachineJobPriceOverride(ctx, machinelogbookdb.SetMachineJobPriceOverrideParams{FinalPrice: amount, Reason: &reason, ActorAccountID: &actor, ID: id, ExpectedVersion: expected})
	if errors.Is(err, pgx.ErrNoRows) {
		return MachineJob{}, apperror.StaleWrite
	}
	if err != nil {
		return MachineJob{}, databaseError(err)
	}
	if err = writeAudit(ctx, tx, p, "machine_job.price_overridden", "machine_job", id, requestID, []string{"finalPrice", "priceOverrideReason"}); err != nil {
		return MachineJob{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MachineJob{}, err
	}
	return s.loadJob(ctx, id)
}

func (s *Service) ClearJobPriceOverride(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, requestID *uuid.UUID) (MachineJob, error) {
	if err := require(p, authorization.MachineJobsOverridePrice); err != nil {
		return MachineJob{}, err
	}
	if expected < 1 {
		return MachineJob{}, validation("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MachineJob{}, err
	}
	defer tx.Rollback(ctx)
	_, err = machinelogbookdb.New(tx).ClearMachineJobPriceOverride(ctx, machinelogbookdb.ClearMachineJobPriceOverrideParams{ID: id, ExpectedVersion: expected})
	if errors.Is(err, pgx.ErrNoRows) {
		return MachineJob{}, apperror.StaleWrite
	}
	if err != nil {
		return MachineJob{}, err
	}
	if err = writeAudit(ctx, tx, p, "machine_job.price_override_cleared", "machine_job", id, requestID, []string{"finalPrice", "priceOverrideReason"}); err != nil {
		return MachineJob{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MachineJob{}, err
	}
	return s.loadJob(ctx, id)
}

func (s *Service) UpdateJobBilling(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, status string, reference, waiverReason *string, requestID *uuid.UUID) (MachineJob, error) {
	if err := require(p, authorization.MachineJobsEdit); err != nil {
		return MachineJob{}, err
	}
	if expected < 1 {
		return MachineJob{}, validation("expectedVersion must be positive")
	}
	reference = cleanOptional(reference)
	waiverReason = cleanOptional(waiverReason)
	if status != "unbilled" && status != "billed" && status != "waived" {
		return MachineJob{}, validation("invalid billing status")
	}
	if status == "billed" && reference == nil {
		return MachineJob{}, validation("billingReference is required for billed jobs")
	}
	if status == "waived" && waiverReason == nil {
		return MachineJob{}, validation("waiverReason is required for waived jobs")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MachineJob{}, err
	}
	defer tx.Rollback(ctx)
	actor := p.AccountID
	_, err = machinelogbookdb.New(tx).UpdateMachineJobBilling(ctx, machinelogbookdb.UpdateMachineJobBillingParams{BillingStatus: status, BillingReference: reference, WaiverReason: waiverReason, ActorAccountID: &actor, ID: id, ExpectedVersion: expected})
	if errors.Is(err, pgx.ErrNoRows) {
		return MachineJob{}, apperror.StaleWrite
	}
	if err != nil {
		return MachineJob{}, databaseError(err)
	}
	if err = writeAudit(ctx, tx, p, "machine_job.billing_updated", "machine_job", id, requestID, []string{"billingStatus", "billingReference", "finalPrice"}); err != nil {
		return MachineJob{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MachineJob{}, err
	}
	return s.loadJob(ctx, id)
}
