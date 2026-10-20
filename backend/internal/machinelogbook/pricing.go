package machinelogbook

import (
	"context"
	"errors"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/optional"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func pricingRuleFromRow(row machinelogbookdb.PricingRule, materialTypeName *string) PricingRule {
	return PricingRule{
		ID:               row.ID,
		PricingGroupID:   row.PricingGroupID,
		Kind:             row.Kind,
		MachineTypeID:    row.MachineTypeID,
		MaterialTypeID:   row.MaterialTypeID,
		MaterialTypeName: materialTypeName,
		MaterialUnit:     row.MaterialUnit,
		Measure:          row.Measure,
		BlockSize:        row.BlockSize,
		Rate:             decimalString(row.Rate),
		Active:           row.Active,
		Version:          row.Version,
	}
}

func (s *Service) pricingGroupFromRow(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	row machinelogbookdb.PricingGroup,
) (PricingGroup, error) {
	rules, err := q.ListPricingRulesByGroup(ctx, row.ID)
	if err != nil {
		return PricingGroup{}, err
	}
	item := PricingGroup{
		ID:          row.ID,
		Name:        row.Name,
		Description: row.Description,
		Active:      row.Active,
		IsDefault:   row.IsDefault,
		Version:     row.Version,
		CreatedAt:   row.CreatedAt,
		UpdatedAt:   row.UpdatedAt,
		Rules:       make([]PricingRule, 0, len(rules)),
	}
	for _, r := range rules {
		item.Rules = append(
			item.Rules,
			pricingRuleFromRow(
				machinelogbookdb.PricingRule{
					ID:             r.ID,
					PricingGroupID: r.PricingGroupID,
					Kind:           r.Kind,
					MachineTypeID:  r.MachineTypeID,
					MaterialUnit:   r.MaterialUnit,
					Measure:        r.Measure,
					BlockSize:      r.BlockSize,
					Rate:           r.Rate,
					Active:         r.Active,
					Version:        r.Version,
					CreatedAt:      r.CreatedAt,
					UpdatedAt:      r.UpdatedAt,
					MaterialTypeID: r.MaterialTypeID,
				},
				r.MaterialTypeName,
			),
		)
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

func (s *Service) CreatePricingGroup(
	ctx context.Context,
	p authorization.Principal,
	name string,
	description *string,
	isDefault bool,
	requestID *uuid.UUID,
) (PricingGroup, error) {
	if err := require(p, authorization.PricingManage); err != nil {
		return PricingGroup{}, err
	}
	var err error
	name, err = validateName(name)
	if err != nil {
		return PricingGroup{}, err
	}
	description = optional.Trimmed(description)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return PricingGroup{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	id := ids.New()
	if isDefault {
		if err = q.ClearDefaultPricingGroup(ctx, id); err != nil {
			return PricingGroup{}, err
		}
	}
	row, err := q.CreatePricingGroup(
		ctx,
		machinelogbookdb.CreatePricingGroupParams{ID: id, Name: name, Description: description, IsDefault: isDefault},
	)
	if err != nil {
		return PricingGroup{}, databaseError(err)
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"pricing_group.created",
		"pricing_group",
		id,
		requestID,
		[]string{"name", "description", "isDefault"},
	); err != nil {
		return PricingGroup{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return PricingGroup{}, err
	}
	return s.pricingGroupFromRow(ctx, machinelogbookdb.New(s.pool), row)
}

func (s *Service) UpdatePricingGroup(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	name string,
	description *string,
	active, isDefault bool,
	requestID *uuid.UUID,
) (PricingGroup, error) {
	if err := require(p, authorization.PricingManage); err != nil {
		return PricingGroup{}, err
	}
	if expected < 1 {
		return PricingGroup{}, apperror.Invalid("expectedVersion must be positive")
	}
	var err error
	name, err = validateName(name)
	if err != nil {
		return PricingGroup{}, err
	}
	description = optional.Trimmed(description)
	if isDefault && !active {
		return PricingGroup{}, apperror.Invalid("default pricing group must be active")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return PricingGroup{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
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
	row, err := q.UpdatePricingGroup(
		ctx,
		machinelogbookdb.UpdatePricingGroupParams{
			Name:            name,
			Description:     description,
			Active:          active,
			IsDefault:       isDefault,
			ID:              id,
			ExpectedVersion: expected,
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return PricingGroup{}, apperror.StaleWrite
	}
	if err != nil {
		return PricingGroup{}, databaseError(err)
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"pricing_group.updated",
		"pricing_group",
		id,
		requestID,
		[]string{"name", "description", "active", "isDefault"},
	); err != nil {
		return PricingGroup{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return PricingGroup{}, err
	}
	return s.pricingGroupFromRow(ctx, machinelogbookdb.New(s.pool), row)
}

// ruleTarget is what a pricing rule prices, resolved from its kind and selectors.
type ruleTarget struct {
	MaterialUnit, MaterialTypeName *string
	Measure                        *string
	BlockSize                      *int32
}

// resolveRuleTarget checks which selector a rule needs for its kind. For
// material rules it loads the material type whose unit the rule takes over; for
// measure rules it checks the machine type's process supports the measure and
// takes the block size of the measure.
func resolveRuleTarget(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	kind string,
	machineTypeID, materialTypeID *uuid.UUID,
	measure *string,
	requireActiveType bool,
) (ruleTarget, error) {
	switch kind {
	case "machine_runtime":
		if machineTypeID == nil || materialTypeID != nil || measure != nil {
			return ruleTarget{}, apperror.Invalid("machine runtime rules require only machineTypeId")
		}
		return ruleTarget{}, nil
	case "material":
		if machineTypeID != nil || materialTypeID == nil || measure != nil {
			return ruleTarget{}, apperror.Invalid("material rules require only materialTypeId")
		}
		materialType, err := resolveMaterialType(ctx, q, *materialTypeID, requireActiveType)
		if err != nil {
			return ruleTarget{}, err
		}
		unit, name := materialType.Unit, materialType.Name
		return ruleTarget{MaterialUnit: &unit, MaterialTypeName: &name}, nil
	case "machine_measure":
		if machineTypeID == nil || materialTypeID != nil || measure == nil {
			return ruleTarget{}, apperror.Invalid("machine measure rules require machineTypeId and measure")
		}
		definition, known := measureDefinitions[*measure]
		if !known {
			return ruleTarget{}, apperror.Invalid("unknown measure")
		}
		machineType, err := q.GetMachineType(ctx, *machineTypeID)
		if errors.Is(err, pgx.ErrNoRows) {
			return ruleTarget{}, apperror.Invalid("machineTypeId does not refer to a machine type")
		}
		if err != nil {
			return ruleTarget{}, err
		}
		if !processSupportsMeasure(machineType.Process, definition.Key) {
			return ruleTarget{}, apperror.New(
				422,
				"run_measure_unsupported",
				"The machine type's process does not record this measure",
			)
		}
		block := definition.BlockSize
		return ruleTarget{Measure: &definition.Key, BlockSize: &block}, nil
	}
	return ruleTarget{}, apperror.Invalid("invalid pricing rule kind")
}

func (s *Service) CreatePricingRule(
	ctx context.Context,
	p authorization.Principal,
	groupID uuid.UUID,
	kind string,
	machineTypeID, materialTypeID *uuid.UUID,
	measure *string,
	rate string,
	requestID *uuid.UUID,
) (PricingRule, error) {
	if err := require(p, authorization.PricingManage); err != nil {
		return PricingRule{}, err
	}
	numeric, err := numericFromString(rate, false)
	if err != nil || decimalFromNumeric(numeric).IsNegative() {
		return PricingRule{}, apperror.Invalid("rate must be non-negative")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return PricingRule{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	target, err := resolveRuleTarget(ctx, q, kind, machineTypeID, materialTypeID, measure, true)
	if err != nil {
		return PricingRule{}, err
	}
	group, err := q.GetPricingGroup(ctx, groupID)
	if err != nil {
		return PricingRule{}, noRows(err)
	}
	if !group.Active {
		return PricingRule{}, apperror.Conflicting("pricing_group_inactive", "Pricing group is inactive")
	}
	id := ids.New()
	row, err := q.CreatePricingRule(
		ctx,
		machinelogbookdb.CreatePricingRuleParams{
			ID:             id,
			PricingGroupID: groupID,
			Kind:           kind,
			MachineTypeID:  machineTypeID,
			MaterialTypeID: materialTypeID,
			MaterialUnit:   target.MaterialUnit,
			Measure:        target.Measure,
			BlockSize:      target.BlockSize,
			Rate:           numeric,
		},
	)
	if err != nil {
		return PricingRule{}, databaseError(err)
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"pricing_rule.created",
		"pricing_rule",
		id,
		requestID,
		[]string{"kind", "selector", "measure", "rate"},
	); err != nil {
		return PricingRule{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return PricingRule{}, err
	}
	return pricingRuleFromRow(row, target.MaterialTypeName), nil
}

func (s *Service) UpdatePricingRule(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	kind string,
	machineTypeID, materialTypeID *uuid.UUID,
	measure *string,
	rate string,
	active bool,
	requestID *uuid.UUID,
) (PricingRule, error) {
	if err := require(p, authorization.PricingManage); err != nil {
		return PricingRule{}, err
	}
	if expected < 1 {
		return PricingRule{}, apperror.Invalid("expectedVersion must be positive")
	}
	numeric, err := numericFromString(rate, false)
	if err != nil || decimalFromNumeric(numeric).IsNegative() {
		return PricingRule{}, apperror.Invalid("rate must be non-negative")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return PricingRule{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	current, err := q.GetPricingRuleForUpdate(ctx, id)
	if err != nil {
		return PricingRule{}, noRows(err)
	}
	if current.Version != expected {
		return PricingRule{}, apperror.StaleWrite
	}
	// A rule may keep its deactivated type; choosing another type needs an active one.
	target, err := resolveRuleTarget(
		ctx,
		q,
		kind,
		machineTypeID,
		materialTypeID,
		measure,
		!sameUUID(current.MaterialTypeID, materialTypeID),
	)
	if err != nil {
		return PricingRule{}, err
	}
	row, err := q.UpdatePricingRule(
		ctx,
		machinelogbookdb.UpdatePricingRuleParams{
			Kind:            kind,
			MachineTypeID:   machineTypeID,
			MaterialTypeID:  materialTypeID,
			MaterialUnit:    target.MaterialUnit,
			Measure:         target.Measure,
			BlockSize:       target.BlockSize,
			Rate:            numeric,
			Active:          active,
			ID:              id,
			ExpectedVersion: expected,
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return PricingRule{}, apperror.StaleWrite
	}
	if err != nil {
		return PricingRule{}, databaseError(err)
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"pricing_rule.updated",
		"pricing_rule",
		id,
		requestID,
		[]string{"kind", "selector", "measure", "rate", "active"},
	); err != nil {
		return PricingRule{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return PricingRule{}, err
	}
	return pricingRuleFromRow(row, target.MaterialTypeName), nil
}

// SetPartyPricingGroup sets or clears the pricing group of an organization. People have no group of their own;
// they are priced through the role mapping (see SetRolePricingGroups).
func (s *Service) SetPartyPricingGroup(
	ctx context.Context,
	p authorization.Principal,
	party PartyReference,
	groupID *uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) (BillingParty, error) {
	if err := require(p, authorization.PricingManage); err != nil {
		return BillingParty{}, err
	}
	if party.Kind != "organization" {
		return BillingParty{}, apperror.Invalid(
			"pricing groups are assigned to organizations; people are priced through their roles",
		)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return BillingParty{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	if groupID != nil {
		group, err := q.GetPricingGroup(ctx, *groupID)
		if err != nil {
			return BillingParty{}, noRows(err)
		}
		if !group.Active {
			return BillingParty{}, apperror.Conflicting("pricing_group_inactive", "Pricing group is inactive")
		}
		actor := p.AccountID
		_, err = q.UpsertOrganizationPricingAssignment(
			ctx,
			machinelogbookdb.UpsertOrganizationPricingAssignmentParams{
				OrganizationID:      party.ID,
				PricingGroupID:      *groupID,
				AssignedByAccountID: &actor,
				ExpectedVersion:     expected,
			},
		)
		if errors.Is(err, pgx.ErrNoRows) {
			return BillingParty{}, apperror.StaleWrite
		}
		if err != nil {
			return BillingParty{}, databaseError(err)
		}
	} else {
		_, err = q.DeleteOrganizationPricingAssignment(
			ctx,
			machinelogbookdb.DeleteOrganizationPricingAssignmentParams{
				OrganizationID:  party.ID,
				ExpectedVersion: expected,
			},
		)
		if errors.Is(err, pgx.ErrNoRows) {
			return BillingParty{}, apperror.StaleWrite
		}
		if err != nil {
			return BillingParty{}, err
		}
	}
	row, loadErr := q.GetBillingOrganization(ctx, party.ID)
	if loadErr != nil {
		return BillingParty{}, noRows(loadErr)
	}
	item := BillingParty{
		ID:                            row.ID,
		Kind:                          "organization",
		DisplayName:                   row.DisplayName,
		OrganizationKind:              &row.OrganizationKind,
		PricingGroupAssignmentVersion: row.PricingGroupAssignmentVersion,
	}
	if row.PricingGroupID != nil && row.PricingGroupName != nil {
		item.PricingGroup = &PricingGroupSummary{ID: *row.PricingGroupID, Name: *row.PricingGroupName}
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"billing_party.pricing_group_updated",
		"billing_party",
		party.ID,
		requestID,
		[]string{"pricingGroupId"},
	); err != nil {
		return BillingParty{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return BillingParty{}, err
	}
	return item, nil
}

// RolePricingGroup maps an account role to a pricing group. A larger priority wins when a person holds several mapped roles.
type RolePricingGroup struct {
	RoleID           uuid.UUID
	RoleName         string
	PricingGroupID   uuid.UUID
	PricingGroupName string
	Priority         int32
}

type RolePricingGroupInput struct {
	RoleID         uuid.UUID
	PricingGroupID uuid.UUID
	Priority       int32
}

const maxRolePriority = 1_000_000

func (s *Service) ListRolePricingGroups(ctx context.Context, p authorization.Principal) ([]RolePricingGroup, error) {
	if err := require(p, authorization.PricingRead); err != nil {
		return nil, err
	}
	return listRolePricingGroups(ctx, machinelogbookdb.New(s.pool))
}

func listRolePricingGroups(ctx context.Context, q *machinelogbookdb.Queries) ([]RolePricingGroup, error) {
	rows, err := q.ListRolePricingGroups(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]RolePricingGroup, 0, len(rows))
	for _, row := range rows {
		items = append(
			items,
			RolePricingGroup{
				RoleID:           row.RoleID,
				RoleName:         row.RoleName,
				PricingGroupID:   row.PricingGroupID,
				PricingGroupName: row.PricingGroupName,
				Priority:         row.Priority,
			},
		)
	}
	return items, nil
}

// SetRolePricingGroups replaces the whole role mapping atomically. Every role appears at most once, priorities are
// unique, and every group must exist and be active.
func (s *Service) SetRolePricingGroups(
	ctx context.Context,
	p authorization.Principal,
	input []RolePricingGroupInput,
	requestID *uuid.UUID,
) ([]RolePricingGroup, error) {
	if err := require(p, authorization.PricingManage); err != nil {
		return nil, err
	}
	if len(input) > 200 {
		return nil, apperror.Invalid("at most 200 role mappings")
	}
	roles := map[uuid.UUID]bool{}
	priorities := map[int32]bool{}
	for _, item := range input {
		if item.Priority < 1 || item.Priority > maxRolePriority {
			return nil, apperror.Invalid("priority must be between 1 and 1000000")
		}
		if roles[item.RoleID] {
			return nil, apperror.Invalid("each role can be mapped once")
		}
		if priorities[item.Priority] {
			return nil, apperror.Invalid("priorities must be unique")
		}
		roles[item.RoleID], priorities[item.Priority] = true, true
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	if err = q.LockRolePricingGroups(ctx); err != nil {
		return nil, err
	}
	for _, item := range input {
		ok, err := q.RoleExists(ctx, item.RoleID)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, apperror.NotFound
		}
		group, err := q.GetPricingGroup(ctx, item.PricingGroupID)
		if err != nil {
			return nil, noRows(err)
		}
		if !group.Active {
			return nil, apperror.Conflicting("pricing_group_inactive", "Pricing group is inactive")
		}
	}
	if err = q.DeleteRolePricingGroups(ctx); err != nil {
		return nil, err
	}
	actor := p.AccountID
	for _, item := range input {
		if err = q.InsertRolePricingGroup(
			ctx,
			machinelogbookdb.InsertRolePricingGroupParams{
				RoleID:             item.RoleID,
				PricingGroupID:     item.PricingGroupID,
				Priority:           item.Priority,
				UpdatedByAccountID: &actor,
			},
		); err != nil {
			return nil, databaseError(err)
		}
	}
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: accountPointer(p),
			Action:         "pricing.role_groups_updated",
			ResourceType:   "pricing_role_groups",
			RequestID:      requestID,
			ChangedFields:  []string{"roleMapping"},
		},
	); err != nil {
		return nil, err
	}
	items, err := listRolePricingGroups(ctx, q)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return items, nil
}
