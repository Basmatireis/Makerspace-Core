package machinelogbook

import (
	"context"
	"errors"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *Service) ListMachineTypes(ctx context.Context, p authorization.Principal) ([]MachineType, error) {
	if err := require(p, authorization.MachinesRead); err != nil {
		return nil, err
	}
	rows, err := machinelogbookdb.New(s.pool).ListMachineTypes(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]MachineType, 0, len(rows))
	for _, row := range rows {
		items = append(items, machineTypeFromRow(row))
	}
	return items, nil
}

func (s *Service) CreateMachineType(ctx context.Context, p authorization.Principal, name string, requestID *uuid.UUID) (MachineType, error) {
	if err := require(p, authorization.MachinesManage); err != nil {
		return MachineType{}, err
	}
	name, err := validateName(name)
	if err != nil {
		return MachineType{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MachineType{}, err
	}
	defer tx.Rollback(ctx)
	id := newID()
	row, err := machinelogbookdb.New(tx).CreateMachineType(ctx, machinelogbookdb.CreateMachineTypeParams{ID: id, Name: name})
	if err != nil {
		return MachineType{}, databaseError(err)
	}
	if err = writeAudit(ctx, tx, p, "machine_type.created", "machine_type", id, requestID, []string{"name"}); err != nil {
		return MachineType{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MachineType{}, err
	}
	return machineTypeFromRow(row), nil
}

func (s *Service) UpdateMachineType(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, name *string, active *bool, requestID *uuid.UUID) (MachineType, error) {
	if err := require(p, authorization.MachinesManage); err != nil {
		return MachineType{}, err
	}
	if expected < 1 {
		return MachineType{}, validation("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MachineType{}, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	current, err := q.GetMachineTypeForUpdate(ctx, id)
	if err != nil {
		return MachineType{}, noRows(err)
	}
	if current.Version != expected {
		return MachineType{}, apperror.StaleWrite
	}
	if name != nil {
		current.Name, err = validateName(*name)
		if err != nil {
			return MachineType{}, err
		}
	}
	if active != nil {
		current.Active = *active
	}
	row, err := q.UpdateMachineType(ctx, machinelogbookdb.UpdateMachineTypeParams{Name: current.Name, Active: current.Active, ID: id, ExpectedVersion: expected})
	if errors.Is(err, pgx.ErrNoRows) {
		return MachineType{}, apperror.StaleWrite
	}
	if err != nil {
		return MachineType{}, databaseError(err)
	}
	if err = writeAudit(ctx, tx, p, "machine_type.updated", "machine_type", id, requestID, []string{"name", "active"}); err != nil {
		return MachineType{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MachineType{}, err
	}
	return machineTypeFromRow(row), nil
}

func validateMachine(status string, automatic bool, external *string) error {
	if status != "active" && status != "maintenance" && status != "retired" {
		return validation("invalid machine status")
	}
	if cleanOptional(external) != nil && !automatic {
		return validation("externalIdentifier requires automatic collection")
	}
	return nil
}

func machineFromGet(row machinelogbookdb.GetMachineRow) Machine {
	return Machine{ID: row.ID, MachineType: MachineType{ID: row.MachineTypeID, Name: row.MachineTypeName, Active: row.MachineTypeActive, Version: row.MachineTypeVersion, CreatedAt: row.MachineTypeCreatedAt, UpdatedAt: row.MachineTypeUpdatedAt}, Name: row.Name, Status: row.Status, ExternalIdentifier: row.ExternalIdentifier, AutomaticCollectionEnabled: row.AutomaticCollectionEnabled, LastIngestedAt: nullableTime(row.LastIngestedAt), Version: row.Version, JobCount: row.JobCount, RuntimeSeconds: row.RuntimeSeconds, FailureRate: decimalString(row.FailureRate), CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
}

func machineFromList(row machinelogbookdb.ListMachinesRow) Machine {
	return Machine{ID: row.ID, MachineType: MachineType{ID: row.MachineTypeID, Name: row.MachineTypeName, Active: row.MachineTypeActive, Version: row.MachineTypeVersion, CreatedAt: row.MachineTypeCreatedAt, UpdatedAt: row.MachineTypeUpdatedAt}, Name: row.Name, Status: row.Status, ExternalIdentifier: row.ExternalIdentifier, AutomaticCollectionEnabled: row.AutomaticCollectionEnabled, LastIngestedAt: nullableTime(row.LastIngestedAt), Version: row.Version, JobCount: row.JobCount, RuntimeSeconds: row.RuntimeSeconds, FailureRate: decimalString(row.FailureRate), CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
}

func (s *Service) GetMachine(ctx context.Context, p authorization.Principal, id uuid.UUID) (Machine, error) {
	if err := require(p, authorization.MachinesRead); err != nil {
		return Machine{}, err
	}
	return s.loadMachine(ctx, id)
}

func (s *Service) loadMachine(ctx context.Context, id uuid.UUID) (Machine, error) {
	row, err := machinelogbookdb.New(s.pool).GetMachine(ctx, id)
	if err != nil {
		return Machine{}, noRows(err)
	}
	return machineFromGet(row), nil
}

func (s *Service) ListMachines(ctx context.Context, p authorization.Principal, search string, status *string, page, pageSize int) ([]Machine, int64, error) {
	if err := require(p, authorization.MachinesRead); err != nil {
		return nil, 0, err
	}
	offset, limit, err := pageBounds(page, pageSize)
	if err != nil {
		return nil, 0, err
	}
	q := machinelogbookdb.New(s.pool)
	rows, err := q.ListMachines(ctx, machinelogbookdb.ListMachinesParams{Search: strings.TrimSpace(search), Status: status, PageOffset: offset, PageLimit: limit})
	if err != nil {
		return nil, 0, err
	}
	total, err := q.CountMachines(ctx, machinelogbookdb.CountMachinesParams{Search: strings.TrimSpace(search), Status: status})
	if err != nil {
		return nil, 0, err
	}
	items := make([]Machine, 0, len(rows))
	for _, row := range rows {
		items = append(items, machineFromList(row))
	}
	return items, total, nil
}

func (s *Service) CreateMachine(ctx context.Context, p authorization.Principal, machineTypeID uuid.UUID, name, status string, external *string, automatic bool, requestID *uuid.UUID) (Machine, error) {
	if err := require(p, authorization.MachinesManage); err != nil {
		return Machine{}, err
	}
	var err error
	name, err = validateName(name)
	if err != nil {
		return Machine{}, err
	}
	external = cleanOptional(external)
	if err = validateMachine(status, automatic, external); err != nil {
		return Machine{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Machine{}, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	typeRow, err := q.GetMachineType(ctx, machineTypeID)
	if err != nil {
		return Machine{}, noRows(err)
	}
	if !typeRow.Active {
		return Machine{}, conflict("machine_type_inactive", "Machine type is inactive")
	}
	id := newID()
	_, err = q.CreateMachine(ctx, machinelogbookdb.CreateMachineParams{ID: id, MachineTypeID: machineTypeID, Name: name, Status: status, ExternalIdentifier: external, AutomaticCollectionEnabled: automatic})
	if err != nil {
		return Machine{}, databaseError(err)
	}
	if err = writeAudit(ctx, tx, p, "machine.created", "machine", id, requestID, []string{"machineTypeId", "name", "status", "externalIdentifier", "automaticCollectionEnabled"}); err != nil {
		return Machine{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Machine{}, err
	}
	return s.loadMachine(ctx, id)
}

func (s *Service) UpdateMachine(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, machineTypeID uuid.UUID, name, status string, external *string, automatic bool, requestID *uuid.UUID) (Machine, error) {
	if err := require(p, authorization.MachinesManage); err != nil {
		return Machine{}, err
	}
	if expected < 1 {
		return Machine{}, validation("expectedVersion must be positive")
	}
	var err error
	name, err = validateName(name)
	if err != nil {
		return Machine{}, err
	}
	external = cleanOptional(external)
	if err = validateMachine(status, automatic, external); err != nil {
		return Machine{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Machine{}, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	current, err := q.GetMachineForUpdate(ctx, id)
	if err != nil {
		return Machine{}, noRows(err)
	}
	if current.Version != expected {
		return Machine{}, apperror.StaleWrite
	}
	typeRow, err := q.GetMachineType(ctx, machineTypeID)
	if err != nil {
		return Machine{}, noRows(err)
	}
	if !typeRow.Active && machineTypeID != current.MachineTypeID {
		return Machine{}, conflict("machine_type_inactive", "Machine type is inactive")
	}
	_, err = q.UpdateMachine(ctx, machinelogbookdb.UpdateMachineParams{MachineTypeID: machineTypeID, Name: name, Status: status, ExternalIdentifier: external, AutomaticCollectionEnabled: automatic, ID: id, ExpectedVersion: expected})
	if errors.Is(err, pgx.ErrNoRows) {
		return Machine{}, apperror.StaleWrite
	}
	if err != nil {
		return Machine{}, databaseError(err)
	}
	if err = writeAudit(ctx, tx, p, "machine.updated", "machine", id, requestID, []string{"machineTypeId", "name", "status", "externalIdentifier", "automaticCollectionEnabled"}); err != nil {
		return Machine{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Machine{}, err
	}
	return s.loadMachine(ctx, id)
}

func organizationFromRow(row machinelogbookdb.Organization) Organization {
	return Organization{ID: row.ID, Name: row.Name, Kind: row.Kind, Active: row.Active, Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
}
func validateOrganizationKind(kind string) error {
	if kind != "company" && kind != "institute" && kind != "association" && kind != "other" {
		return validation("invalid organization kind")
	}
	return nil
}

func (s *Service) ListOrganizations(ctx context.Context, p authorization.Principal, search string, active *bool, page, pageSize int) ([]Organization, int64, error) {
	if err := require(p, authorization.OrganizationsRead); err != nil {
		return nil, 0, err
	}
	offset, limit, err := pageBounds(page, pageSize)
	if err != nil {
		return nil, 0, err
	}
	q := machinelogbookdb.New(s.pool)
	params := machinelogbookdb.ListOrganizationsParams{Search: strings.TrimSpace(search), Active: active, PageOffset: offset, PageLimit: limit}
	rows, err := q.ListOrganizations(ctx, params)
	if err != nil {
		return nil, 0, err
	}
	total, err := q.CountOrganizations(ctx, machinelogbookdb.CountOrganizationsParams{Search: params.Search, Active: active})
	if err != nil {
		return nil, 0, err
	}
	items := make([]Organization, 0, len(rows))
	for _, row := range rows {
		item := Organization{ID: row.ID, Name: row.Name, Kind: row.Kind, Active: row.Active, PricingGroupAssignmentVersion: row.PricingGroupAssignmentVersion, Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
		if row.PricingGroupID != nil && row.PricingGroupName != nil {
			item.PricingGroup = &PricingGroupSummary{ID: *row.PricingGroupID, Name: *row.PricingGroupName}
		}
		items = append(items, item)
	}
	return items, total, nil
}

func (s *Service) CreateOrganization(ctx context.Context, p authorization.Principal, name, kind string, requestID *uuid.UUID) (Organization, error) {
	if err := require(p, authorization.OrganizationsManage); err != nil {
		return Organization{}, err
	}
	var err error
	name, err = validateName(name)
	if err != nil {
		return Organization{}, err
	}
	if err = validateOrganizationKind(kind); err != nil {
		return Organization{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Organization{}, err
	}
	defer tx.Rollback(ctx)
	id := newID()
	row, err := machinelogbookdb.New(tx).CreateOrganization(ctx, machinelogbookdb.CreateOrganizationParams{ID: id, Name: name, Kind: kind})
	if err != nil {
		return Organization{}, databaseError(err)
	}
	if err = writeAudit(ctx, tx, p, "organization.created", "organization", id, requestID, []string{"name", "kind"}); err != nil {
		return Organization{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Organization{}, err
	}
	return organizationFromRow(row), nil
}

func (s *Service) UpdateOrganization(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, name, kind string, active bool, requestID *uuid.UUID) (Organization, error) {
	if err := require(p, authorization.OrganizationsManage); err != nil {
		return Organization{}, err
	}
	if expected < 1 {
		return Organization{}, validation("expectedVersion must be positive")
	}
	var err error
	name, err = validateName(name)
	if err != nil {
		return Organization{}, err
	}
	if err = validateOrganizationKind(kind); err != nil {
		return Organization{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Organization{}, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	current, err := q.GetOrganizationForUpdate(ctx, id)
	if err != nil {
		return Organization{}, noRows(err)
	}
	if current.Version != expected {
		return Organization{}, apperror.StaleWrite
	}
	row, err := q.UpdateOrganization(ctx, machinelogbookdb.UpdateOrganizationParams{Name: name, Kind: kind, Active: active, ID: id, ExpectedVersion: expected})
	if errors.Is(err, pgx.ErrNoRows) {
		return Organization{}, apperror.StaleWrite
	}
	if err != nil {
		return Organization{}, databaseError(err)
	}
	if err = writeAudit(ctx, tx, p, "organization.updated", "organization", id, requestID, []string{"name", "kind", "active"}); err != nil {
		return Organization{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Organization{}, err
	}
	return organizationFromRow(row), nil
}

func canLookupParties(p authorization.Principal) bool {
	return p.Has(authorization.MachineJobsCreate) || p.Has(authorization.MachineJobsReview) || p.Has(authorization.OrganizationsRead)
}
func (s *Service) SearchBillingParties(ctx context.Context, p authorization.Principal, search string, limit int) ([]BillingParty, error) {
	if !canLookupParties(p) {
		return nil, apperror.PermissionDenied
	}
	if limit < 1 || limit > 50 {
		return nil, validation("limit must be between 1 and 50")
	}
	rows, err := machinelogbookdb.New(s.pool).SearchBillingParties(ctx, machinelogbookdb.SearchBillingPartiesParams{Search: strings.TrimSpace(search), PageLimit: int32(limit)})
	if err != nil {
		return nil, err
	}
	items := make([]BillingParty, 0, len(rows))
	for _, row := range rows {
		item := BillingParty{ID: row.PartyID, Kind: row.PartyKind, DisplayName: row.DisplayName, OrganizationKind: row.OrganizationKind, PricingGroupAssignmentVersion: row.PricingGroupAssignmentVersion}
		if row.PricingGroupID != nil && row.PricingGroupName != nil {
			item.PricingGroup = &PricingGroupSummary{ID: *row.PricingGroupID, Name: *row.PricingGroupName}
		}
		items = append(items, item)
	}
	return items, nil
}
func (s *Service) SearchOperators(ctx context.Context, p authorization.Principal, search string, limit int) ([]Operator, error) {
	if !canLookupParties(p) {
		return nil, apperror.PermissionDenied
	}
	if limit < 1 || limit > 50 {
		return nil, validation("limit must be between 1 and 50")
	}
	rows, err := machinelogbookdb.New(s.pool).SearchMachineJobOperators(ctx, machinelogbookdb.SearchMachineJobOperatorsParams{Search: strings.TrimSpace(search), PageLimit: int32(limit)})
	if err != nil {
		return nil, err
	}
	items := make([]Operator, 0, len(rows))
	for _, row := range rows {
		items = append(items, Operator{PersonID: row.PersonID, DisplayName: row.DisplayName})
	}
	return items, nil
}

func pricingRuleFromRow(row machinelogbookdb.PricingRule) PricingRule {
	return PricingRule{ID: row.ID, PricingGroupID: row.PricingGroupID, Kind: row.Kind, MachineTypeID: row.MachineTypeID, MaterialCategory: row.MaterialCategory, MaterialUnit: row.MaterialUnit, Rate: decimalString(row.Rate), Active: row.Active, Version: row.Version}
}
func (s *Service) pricingGroupFromRow(ctx context.Context, q *machinelogbookdb.Queries, row machinelogbookdb.PricingGroup) (PricingGroup, error) {
	rules, err := q.ListPricingRulesByGroup(ctx, row.ID)
	if err != nil {
		return PricingGroup{}, err
	}
	item := PricingGroup{ID: row.ID, Name: row.Name, Description: row.Description, Active: row.Active, IsDefault: row.IsDefault, Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt, Rules: make([]PricingRule, 0, len(rules))}
	for _, r := range rules {
		item.Rules = append(item.Rules, pricingRuleFromRow(r))
	}
	return item, nil
}

func (s *Service) ListPricingGroups(ctx context.Context, p authorization.Principal) ([]PricingGroup, error) {
	if err := require(p, authorization.PricingRead); err != nil {
		return nil, err
	}
	q := machinelogbookdb.New(s.pool)
	rows, err := q.ListPricingGroups(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]PricingGroup, 0, len(rows))
	for _, row := range rows {
		item, err := s.pricingGroupFromRow(ctx, q, row)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, nil
}

func (s *Service) CreatePricingGroup(ctx context.Context, p authorization.Principal, name string, description *string, isDefault bool, requestID *uuid.UUID) (PricingGroup, error) {
	if err := require(p, authorization.PricingManage); err != nil {
		return PricingGroup{}, err
	}
	var err error
	name, err = validateName(name)
	if err != nil {
		return PricingGroup{}, err
	}
	description = cleanOptional(description)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return PricingGroup{}, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	id := newID()
	if isDefault {
		if err = q.ClearDefaultPricingGroup(ctx, id); err != nil {
			return PricingGroup{}, err
		}
	}
	row, err := q.CreatePricingGroup(ctx, machinelogbookdb.CreatePricingGroupParams{ID: id, Name: name, Description: description, IsDefault: isDefault})
	if err != nil {
		return PricingGroup{}, databaseError(err)
	}
	if err = writeAudit(ctx, tx, p, "pricing_group.created", "pricing_group", id, requestID, []string{"name", "description", "isDefault"}); err != nil {
		return PricingGroup{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return PricingGroup{}, err
	}
	return s.pricingGroupFromRow(ctx, machinelogbookdb.New(s.pool), row)
}

func (s *Service) UpdatePricingGroup(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, name string, description *string, active, isDefault bool, requestID *uuid.UUID) (PricingGroup, error) {
	if err := require(p, authorization.PricingManage); err != nil {
		return PricingGroup{}, err
	}
	if expected < 1 {
		return PricingGroup{}, validation("expectedVersion must be positive")
	}
	var err error
	name, err = validateName(name)
	if err != nil {
		return PricingGroup{}, err
	}
	description = cleanOptional(description)
	if isDefault && !active {
		return PricingGroup{}, validation("default pricing group must be active")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return PricingGroup{}, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	current, err := q.GetPricingGroupForUpdate(ctx, id)
	if err != nil {
		return PricingGroup{}, noRows(err)
	}
	if current.Version != expected {
		return PricingGroup{}, apperror.StaleWrite
	}
	if isDefault {
		if err = q.ClearDefaultPricingGroup(ctx, id); err != nil {
			return PricingGroup{}, err
		}
	}
	row, err := q.UpdatePricingGroup(ctx, machinelogbookdb.UpdatePricingGroupParams{Name: name, Description: description, Active: active, IsDefault: isDefault, ID: id, ExpectedVersion: expected})
	if errors.Is(err, pgx.ErrNoRows) {
		return PricingGroup{}, apperror.StaleWrite
	}
	if err != nil {
		return PricingGroup{}, databaseError(err)
	}
	if err = writeAudit(ctx, tx, p, "pricing_group.updated", "pricing_group", id, requestID, []string{"name", "description", "active", "isDefault"}); err != nil {
		return PricingGroup{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return PricingGroup{}, err
	}
	return s.pricingGroupFromRow(ctx, machinelogbookdb.New(s.pool), row)
}

func validateRule(kind string, machineTypeID *uuid.UUID, category, unit *string) (*string, *string, error) {
	if kind == "machine_runtime" {
		if machineTypeID == nil || category != nil || unit != nil {
			return nil, nil, validation("machine runtime rules require only machineTypeId")
		}
		return nil, nil, nil
	}
	if kind == "material" {
		if machineTypeID != nil || category == nil || unit == nil {
			return nil, nil, validation("material rules require category and unit")
		}
		c := strings.ToLower(strings.TrimSpace(*category))
		u := strings.TrimSpace(*unit)
		if c == "" {
			return nil, nil, validation("material category is required")
		}
		if u != "g" && u != "m" && u != "ml" && u != "m2" && u != "piece" {
			return nil, nil, validation("invalid material unit")
		}
		return &c, &u, nil
	}
	return nil, nil, validation("invalid pricing rule kind")
}

func (s *Service) CreatePricingRule(ctx context.Context, p authorization.Principal, groupID uuid.UUID, kind string, machineTypeID *uuid.UUID, category, unit *string, rate string, requestID *uuid.UUID) (PricingRule, error) {
	if err := require(p, authorization.PricingManage); err != nil {
		return PricingRule{}, err
	}
	category, unit, err := validateRule(kind, machineTypeID, category, unit)
	if err != nil {
		return PricingRule{}, err
	}
	numeric, err := numericFromString(rate, false)
	if err != nil || decimalFromNumeric(numeric).IsNegative() {
		return PricingRule{}, validation("rate must be non-negative")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return PricingRule{}, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	group, err := q.GetPricingGroup(ctx, groupID)
	if err != nil {
		return PricingRule{}, noRows(err)
	}
	if !group.Active {
		return PricingRule{}, conflict("pricing_group_inactive", "Pricing group is inactive")
	}
	id := newID()
	row, err := q.CreatePricingRule(ctx, machinelogbookdb.CreatePricingRuleParams{ID: id, PricingGroupID: groupID, Kind: kind, MachineTypeID: machineTypeID, MaterialCategory: category, MaterialUnit: unit, Rate: numeric})
	if err != nil {
		return PricingRule{}, databaseError(err)
	}
	if err = writeAudit(ctx, tx, p, "pricing_rule.created", "pricing_rule", id, requestID, []string{"kind", "selector", "rate"}); err != nil {
		return PricingRule{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return PricingRule{}, err
	}
	return pricingRuleFromRow(row), nil
}

func (s *Service) UpdatePricingRule(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, kind string, machineTypeID *uuid.UUID, category, unit *string, rate string, active bool, requestID *uuid.UUID) (PricingRule, error) {
	if err := require(p, authorization.PricingManage); err != nil {
		return PricingRule{}, err
	}
	if expected < 1 {
		return PricingRule{}, validation("expectedVersion must be positive")
	}
	category, unit, err := validateRule(kind, machineTypeID, category, unit)
	if err != nil {
		return PricingRule{}, err
	}
	numeric, err := numericFromString(rate, false)
	if err != nil || decimalFromNumeric(numeric).IsNegative() {
		return PricingRule{}, validation("rate must be non-negative")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return PricingRule{}, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	current, err := q.GetPricingRuleForUpdate(ctx, id)
	if err != nil {
		return PricingRule{}, noRows(err)
	}
	if current.Version != expected {
		return PricingRule{}, apperror.StaleWrite
	}
	row, err := q.UpdatePricingRule(ctx, machinelogbookdb.UpdatePricingRuleParams{Kind: kind, MachineTypeID: machineTypeID, MaterialCategory: category, MaterialUnit: unit, Rate: numeric, Active: active, ID: id, ExpectedVersion: expected})
	if errors.Is(err, pgx.ErrNoRows) {
		return PricingRule{}, apperror.StaleWrite
	}
	if err != nil {
		return PricingRule{}, databaseError(err)
	}
	if err = writeAudit(ctx, tx, p, "pricing_rule.updated", "pricing_rule", id, requestID, []string{"kind", "selector", "rate", "active"}); err != nil {
		return PricingRule{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return PricingRule{}, err
	}
	return pricingRuleFromRow(row), nil
}

func (s *Service) SetPartyPricingGroup(ctx context.Context, p authorization.Principal, party PartyReference, groupID *uuid.UUID, expected int64, requestID *uuid.UUID) (BillingParty, error) {
	if err := require(p, authorization.PricingManage); err != nil {
		return BillingParty{}, err
	}
	if party.Kind != "person" && party.Kind != "organization" {
		return BillingParty{}, validation("invalid party kind")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return BillingParty{}, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	if groupID != nil {
		group, err := q.GetPricingGroup(ctx, *groupID)
		if err != nil {
			return BillingParty{}, noRows(err)
		}
		if !group.Active {
			return BillingParty{}, conflict("pricing_group_inactive", "Pricing group is inactive")
		}
		actor := p.AccountID
		if party.Kind == "person" {
			_, err = q.UpsertPersonPricingAssignment(ctx, machinelogbookdb.UpsertPersonPricingAssignmentParams{PersonID: party.ID, PricingGroupID: *groupID, AssignedByAccountID: &actor, ExpectedVersion: expected})
		} else {
			_, err = q.UpsertOrganizationPricingAssignment(ctx, machinelogbookdb.UpsertOrganizationPricingAssignmentParams{OrganizationID: party.ID, PricingGroupID: *groupID, AssignedByAccountID: &actor, ExpectedVersion: expected})
		}
		if errors.Is(err, pgx.ErrNoRows) {
			return BillingParty{}, apperror.StaleWrite
		}
		if err != nil {
			return BillingParty{}, databaseError(err)
		}
	} else {
		if party.Kind == "person" {
			_, err = q.DeletePersonPricingAssignment(ctx, machinelogbookdb.DeletePersonPricingAssignmentParams{PersonID: party.ID, ExpectedVersion: expected})
		} else {
			_, err = q.DeleteOrganizationPricingAssignment(ctx, machinelogbookdb.DeleteOrganizationPricingAssignmentParams{OrganizationID: party.ID, ExpectedVersion: expected})
		}
		if errors.Is(err, pgx.ErrNoRows) {
			return BillingParty{}, apperror.StaleWrite
		}
		if err != nil {
			return BillingParty{}, err
		}
	}
	var item BillingParty
	if party.Kind == "person" {
		row, loadErr := q.GetBillingPerson(ctx, party.ID)
		if loadErr != nil {
			return BillingParty{}, noRows(loadErr)
		}
		item = BillingParty{ID: row.ID, Kind: "person", DisplayName: row.DisplayName, PricingGroupAssignmentVersion: row.PricingGroupAssignmentVersion}
		if row.PricingGroupID != nil && row.PricingGroupName != nil {
			item.PricingGroup = &PricingGroupSummary{ID: *row.PricingGroupID, Name: *row.PricingGroupName}
		}
	} else {
		row, loadErr := q.GetBillingOrganization(ctx, party.ID)
		if loadErr != nil {
			return BillingParty{}, noRows(loadErr)
		}
		item = BillingParty{ID: row.ID, Kind: "organization", DisplayName: row.DisplayName, OrganizationKind: &row.OrganizationKind, PricingGroupAssignmentVersion: row.PricingGroupAssignmentVersion}
		if row.PricingGroupID != nil && row.PricingGroupName != nil {
			item.PricingGroup = &PricingGroupSummary{ID: *row.PricingGroupID, Name: *row.PricingGroupName}
		}
	}
	if err = writeAudit(ctx, tx, p, "billing_party.pricing_group_updated", "billing_party", party.ID, requestID, []string{"pricingGroupId"}); err != nil {
		return BillingParty{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return BillingParty{}, err
	}
	return item, nil
}
