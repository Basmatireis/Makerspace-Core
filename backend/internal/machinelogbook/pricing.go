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
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/database"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func pricingRuleFromRow(row machinelogbookdb.PricingRule, materialTypeName, variantName *string) PricingRule {
	return PricingRule{
		ID:                      row.ID,
		PricingGroupID:          row.PricingGroupID,
		Kind:                    PricingRuleKind(row.Kind),
		ProcessID:               row.ProcessID,
		MaterialTypeID:          row.MaterialTypeID,
		MaterialTypeName:        materialTypeName,
		MaterialTypeVariantID:   row.MaterialTypeVariantID,
		MaterialTypeVariantName: variantName,
		MaterialUnit:            row.MaterialUnit,
		MaterialID:              row.MaterialID,
		Measure:                 row.Measure,
		BlockSize:               row.BlockSize,
		Rate:                    decimalString(row.Rate),
		Active:                  row.Active,
		Version:                 row.Version,
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
					ID:                    r.ID,
					PricingGroupID:        r.PricingGroupID,
					Kind:                  r.Kind,
					ProcessID:             r.ProcessID,
					MaterialUnit:          r.MaterialUnit,
					Measure:               r.Measure,
					BlockSize:             r.BlockSize,
					Rate:                  r.Rate,
					Active:                r.Active,
					Version:               r.Version,
					CreatedAt:             r.CreatedAt,
					UpdatedAt:             r.UpdatedAt,
					MaterialTypeID:        r.MaterialTypeID,
					MaterialID:            r.MaterialID,
					MaterialTypeVariantID: r.MaterialTypeVariantID,
				},
				r.MaterialTypeName,
				r.MaterialTypeVariantName,
			),
		)
		rule := &item.Rules[len(item.Rules)-1]
		rule.MaterialName, rule.MaterialDisplayID = r.MaterialName, r.MaterialDisplayID
		if rule.MaterialID != nil {
			rule.MaterialUnit = r.ArticleUnit
		}
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
	var result PricingGroup
	err := database.InTx(ctx, s.pool, func(tx pgx.Tx) (err error) {
		result, err = s.CreatePricingGroupTx(ctx, tx, p, name, description, isDefault, requestID)
		return err
	})
	return result, err
}

// CreatePricingGroupTx is CreatePricingGroup inside the caller's transaction; the configuration import uses it.
func (s *Service) CreatePricingGroupTx(
	ctx context.Context,
	tx pgx.Tx,
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
	return s.pricingGroupFromRow(ctx, q, row)
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
	var result PricingGroup
	err := database.InTx(ctx, s.pool, func(tx pgx.Tx) (err error) {
		result, err = s.UpdatePricingGroupTx(ctx, tx, p, id, expected, name, description, active, isDefault, requestID)
		return err
	})
	return result, err
}

// UpdatePricingGroupTx is UpdatePricingGroup inside the caller's transaction; the configuration import uses it.
func (s *Service) UpdatePricingGroupTx(
	ctx context.Context,
	tx pgx.Tx,
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
	return s.pricingGroupFromRow(ctx, q, row)
}

// ruleTarget is what a pricing rule prices, resolved from its kind and selectors.
type ruleTarget struct {
	MaterialUnit, MaterialTypeName  *string
	VariantName                     *string
	MaterialName, MaterialDisplayID *string
	// ArticleUnit is the unit of a stock_article rule's article; it is shown, not stored.
	ArticleUnit *string
	Measure     *string
	BlockSize   *int32
}

// resolveRuleTarget checks which selector a rule needs for its kind. For
// material rules it loads the material type whose unit the rule takes over; for
// measure rules it checks the process records the measure and takes its block size.
func resolveRuleTarget(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	kind PricingRuleKind,
	processID, materialTypeID *uuid.UUID,
	measure *string,
	requireActiveType bool,
	materialID, variantID *uuid.UUID,
) (ruleTarget, error) {
	if kind != PricingRuleStockArticle && materialID != nil {
		return ruleTarget{}, apperror.Invalid("materialId applies to stock_article rules only")
	}
	if kind != PricingRuleMaterial && variantID != nil {
		return ruleTarget{}, apperror.Invalid("materialTypeVariantId applies to material rules only")
	}
	switch kind {
	case PricingRuleStockArticle:
		if processID != nil || materialTypeID != nil || measure != nil || materialID == nil {
			return ruleTarget{}, apperror.Invalid("stock_article rules require only materialId")
		}
		material, err := q.GetMaterial(ctx, *materialID)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && material.DeletedAt.Valid) {
			return ruleTarget{}, apperror.Invalid("materialId does not refer to an article")
		}
		if err != nil {
			return ruleTarget{}, err
		}
		name, displayID, unit := material.Name, material.DisplayID, material.Unit
		return ruleTarget{MaterialName: &name, MaterialDisplayID: &displayID, ArticleUnit: &unit}, nil
	case PricingRuleMachineRuntime:
		if processID == nil || materialTypeID != nil || measure != nil {
			return ruleTarget{}, apperror.Invalid("machine runtime rules require only processId")
		}
		return ruleTarget{}, nil
	case PricingRuleMaterial:
		if processID != nil || materialTypeID == nil || measure != nil {
			return ruleTarget{}, apperror.Invalid("material rules require only materialTypeId")
		}
		materialType, err := resolveMaterialType(ctx, q, *materialTypeID, requireActiveType)
		if err != nil {
			return ruleTarget{}, err
		}
		if MaterialKind(materialType.Kind) == KindPart || !materialType.MachineUse {
			return ruleTarget{}, unprocessable(
				"material_type_not_priced",
				"Only material types used in machine runs have material rates; price the articles with stock_article rules",
			)
		}
		unit, name := materialType.Unit, materialType.Name
		target := ruleTarget{MaterialUnit: &unit, MaterialTypeName: &name}
		if variantID != nil {
			variant, err := q.GetMaterialTypeVariant(ctx, *variantID)
			if errors.Is(err, pgx.ErrNoRows) {
				return ruleTarget{}, apperror.Invalid("materialTypeVariantId does not refer to a variant")
			}
			if err != nil {
				return ruleTarget{}, err
			}
			if variant.MaterialTypeID != materialType.ID {
				return ruleTarget{}, unprocessable(
					"material_type_variant_mismatch",
					"The variant belongs to another material type",
				)
			}
			target.VariantName = &variant.Name
		}
		return target, nil
	case PricingRuleMachineMeasure:
		if processID == nil || materialTypeID != nil || measure == nil {
			return ruleTarget{}, apperror.Invalid("machine measure rules require processId and measure")
		}
		if !measureKeyPattern.MatchString(*measure) {
			return ruleTarget{}, apperror.Invalid("unknown measure")
		}
		process, err := q.GetProcess(ctx, *processID)
		if errors.Is(err, pgx.ErrNoRows) {
			return ruleTarget{}, apperror.Invalid("processId does not refer to a process")
		}
		if err != nil {
			return ruleTarget{}, err
		}
		measures, err := processMeasureMap(ctx, q, process.ID)
		if err != nil {
			return ruleTarget{}, err
		}
		definition, supported := measures[*measure]
		if !supported {
			return ruleTarget{}, unprocessable("run_measure_unsupported", "The process does not record this measure")
		}
		block := definition.BlockSize
		key := definition.Key
		return ruleTarget{Measure: &key, BlockSize: &block}, nil
	}
	return ruleTarget{}, apperror.Invalid("invalid pricing rule kind")
}

func (s *Service) CreatePricingRule(
	ctx context.Context,
	p authorization.Principal,
	groupID uuid.UUID,
	kind PricingRuleKind,
	processID, materialTypeID *uuid.UUID,
	measure *string,
	rate string,
	requestID *uuid.UUID,
) (PricingRule, error) {
	if err := require(p, authorization.PricingManage); err != nil {
		return PricingRule{}, err
	}
	return s.CreatePricingRuleWithVariant(ctx, p, groupID, kind, processID, materialTypeID, nil, measure, rate, requestID)
}

// CreatePricingRuleWithVariant is CreatePricingRule that can price one variant of the material type of a material
// rule.
func (s *Service) CreatePricingRuleWithVariant(
	ctx context.Context,
	p authorization.Principal,
	groupID uuid.UUID,
	kind PricingRuleKind,
	processID, materialTypeID, variantID *uuid.UUID,
	measure *string,
	rate string,
	requestID *uuid.UUID,
) (PricingRule, error) {
	if err := require(p, authorization.PricingManage); err != nil {
		return PricingRule{}, err
	}
	var result PricingRule
	err := database.InTx(ctx, s.pool, func(tx pgx.Tx) (err error) {
		result, err = s.CreatePricingRuleTx(
			ctx, tx, p, groupID, kind, processID, materialTypeID, variantID, measure, rate, requestID,
		)
		return err
	})
	return result, err
}

// CreatePricingRuleTx is CreatePricingRuleWithVariant inside the caller's transaction; the configuration import
// uses it.
func (s *Service) CreatePricingRuleTx(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	groupID uuid.UUID,
	kind PricingRuleKind,
	processID, materialTypeID, variantID *uuid.UUID,
	measure *string,
	rate string,
	requestID *uuid.UUID,
) (PricingRule, error) {
	if err := require(p, authorization.PricingManage); err != nil {
		return PricingRule{}, err
	}
	return s.createPricingRuleTx(
		ctx, tx, p, groupID, kind, processID, materialTypeID, nil, variantID, measure, rate, requestID,
	)
}

// CreateStockArticlePricingRule prices one article sold from stock in a pricing group (kind stock_article).
func (s *Service) CreateStockArticlePricingRule(
	ctx context.Context,
	p authorization.Principal,
	groupID, materialID uuid.UUID,
	rate string,
	requestID *uuid.UUID,
) (PricingRule, error) {
	if err := require(p, authorization.PricingManage); err != nil {
		return PricingRule{}, err
	}
	var result PricingRule
	err := database.InTx(ctx, s.pool, func(tx pgx.Tx) (err error) {
		result, err = s.createPricingRuleTx(
			ctx, tx, p, groupID, PricingRuleStockArticle, nil, nil, &materialID, nil, nil, rate, requestID,
		)
		return err
	})
	return result, err
}

func (s *Service) createPricingRuleTx(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	groupID uuid.UUID,
	kind PricingRuleKind,
	processID, materialTypeID, materialID, variantID *uuid.UUID,
	measure *string,
	rate string,
	requestID *uuid.UUID,
) (PricingRule, error) {
	numeric, err := numericFromString(rate, false)
	if err != nil || decimalFromNumeric(numeric).IsNegative() {
		return PricingRule{}, apperror.Invalid("rate must be non-negative")
	}
	q := machinelogbookdb.New(tx)
	target, err := resolveRuleTarget(ctx, q, kind, processID, materialTypeID, measure, true, materialID, variantID)
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
			ID:                    id,
			PricingGroupID:        groupID,
			Kind:                  string(kind),
			ProcessID:             processID,
			MaterialTypeID:        materialTypeID,
			MaterialUnit:          target.MaterialUnit,
			Measure:               target.Measure,
			BlockSize:             target.BlockSize,
			Rate:                  numeric,
			MaterialID:            materialID,
			MaterialTypeVariantID: variantID,
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
	rule := pricingRuleFromRow(row, target.MaterialTypeName, target.VariantName)
	rule.MaterialName, rule.MaterialDisplayID = target.MaterialName, target.MaterialDisplayID
	if target.ArticleUnit != nil {
		rule.MaterialUnit = target.ArticleUnit
	}
	return rule, nil
}

func (s *Service) UpdatePricingRule(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	kind PricingRuleKind,
	processID, materialTypeID *uuid.UUID,
	measure *string,
	rate string,
	active bool,
	requestID *uuid.UUID,
) (PricingRule, error) {
	if err := require(p, authorization.PricingManage); err != nil {
		return PricingRule{}, err
	}
	return s.UpdatePricingRuleWithVariant(
		ctx, p, id, expected, kind, processID, materialTypeID, nil, measure, rate, active, requestID,
	)
}

// UpdatePricingRuleWithVariant is UpdatePricingRule that can price one variant of the material type of a material
// rule; a nil variant prices the whole type.
func (s *Service) UpdatePricingRuleWithVariant(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	kind PricingRuleKind,
	processID, materialTypeID, variantID *uuid.UUID,
	measure *string,
	rate string,
	active bool,
	requestID *uuid.UUID,
) (PricingRule, error) {
	if err := require(p, authorization.PricingManage); err != nil {
		return PricingRule{}, err
	}
	var result PricingRule
	err := database.InTx(ctx, s.pool, func(tx pgx.Tx) (err error) {
		result, err = s.UpdatePricingRuleTx(
			ctx, tx, p, id, expected, kind, processID, materialTypeID, variantID, measure, rate, active, requestID,
		)
		return err
	})
	return result, err
}

// UpdatePricingRuleTx is UpdatePricingRuleWithVariant inside the caller's transaction; the configuration import
// uses it.
func (s *Service) UpdatePricingRuleTx(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	kind PricingRuleKind,
	processID, materialTypeID, variantID *uuid.UUID,
	measure *string,
	rate string,
	active bool,
	requestID *uuid.UUID,
) (PricingRule, error) {
	if err := require(p, authorization.PricingManage); err != nil {
		return PricingRule{}, err
	}
	return s.updatePricingRuleTx(
		ctx, tx, p, id, expected, kind, processID, materialTypeID, nil, variantID, measure, rate, active, requestID,
	)
}

// UpdateStockArticlePricingRule changes the article, rate or active state of a stock_article rule.
func (s *Service) UpdateStockArticlePricingRule(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	materialID uuid.UUID,
	rate string,
	active bool,
	requestID *uuid.UUID,
) (PricingRule, error) {
	if err := require(p, authorization.PricingManage); err != nil {
		return PricingRule{}, err
	}
	var result PricingRule
	err := database.InTx(ctx, s.pool, func(tx pgx.Tx) (err error) {
		result, err = s.updatePricingRuleTx(
			ctx, tx, p, id, expected, PricingRuleStockArticle, nil, nil, &materialID, nil, nil, rate, active, requestID,
		)
		return err
	})
	return result, err
}

func (s *Service) updatePricingRuleTx(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	kind PricingRuleKind,
	processID, materialTypeID, materialID, variantID *uuid.UUID,
	measure *string,
	rate string,
	active bool,
	requestID *uuid.UUID,
) (PricingRule, error) {
	if expected < 1 {
		return PricingRule{}, apperror.Invalid("expectedVersion must be positive")
	}
	numeric, err := numericFromString(rate, false)
	if err != nil || decimalFromNumeric(numeric).IsNegative() {
		return PricingRule{}, apperror.Invalid("rate must be non-negative")
	}
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
		processID,
		materialTypeID,
		measure,
		!sameUUID(current.MaterialTypeID, materialTypeID),
		materialID,
		variantID,
	)
	if err != nil {
		return PricingRule{}, err
	}
	row, err := q.UpdatePricingRule(
		ctx,
		machinelogbookdb.UpdatePricingRuleParams{
			Kind:                  string(kind),
			ProcessID:             processID,
			MaterialTypeID:        materialTypeID,
			MaterialUnit:          target.MaterialUnit,
			Measure:               target.Measure,
			BlockSize:             target.BlockSize,
			Rate:                  numeric,
			MaterialID:            materialID,
			MaterialTypeVariantID: variantID,
			Active:                active,
			ID:                    id,
			ExpectedVersion:       expected,
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
	rule := pricingRuleFromRow(row, target.MaterialTypeName, target.VariantName)
	rule.MaterialName, rule.MaterialDisplayID = target.MaterialName, target.MaterialDisplayID
	if target.ArticleUnit != nil {
		rule.MaterialUnit = target.ArticleUnit
	}
	return rule, nil
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
	if party.Kind != PartyOrganization {
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
		Kind:                          PartyOrganization,
		DisplayName:                   row.DisplayName,
		OrganizationKind:              optional.Convert[OrganizationKind](&row.OrganizationKind),
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
	var result []RolePricingGroup
	err := database.InTx(ctx, s.pool, func(tx pgx.Tx) (err error) {
		result, err = s.SetRolePricingGroupsTx(ctx, tx, p, input, requestID)
		return err
	})
	return result, err
}

// SetRolePricingGroupsTx is SetRolePricingGroups inside the caller's transaction; the configuration import uses it.
func (s *Service) SetRolePricingGroupsTx(
	ctx context.Context,
	tx pgx.Tx,
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
	q := machinelogbookdb.New(tx)
	var err error
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
	return items, nil
}
