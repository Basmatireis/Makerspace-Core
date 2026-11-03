package machinelogbook

import (
	"context"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

// PriceQuoteInput asks what a machine run and/or an amount of an inventory
// article costs. Hours belong to MachineID and Quantity to MaterialID.
type PriceQuoteInput struct {
	MachineID, MaterialID *uuid.UUID
	Hours, Quantity       *string
}

type PriceQuoteMachine struct {
	ID          uuid.UUID
	Name        string
	ProcessName string
}

type PriceQuoteMaterial struct {
	ID                    uuid.UUID
	DisplayID, Name, Unit string
	MaterialTypeName      *string
	// Variant is the name of the article's variant, whose rate a group uses before the type's.
	Variant *string
}

// PriceQuoteGroup prices the request with one pricing group's active rules. A
// part that was not requested stays nil; total is nil unless every requested
// part has a rate.
type PriceQuoteGroup struct {
	PricingGroupID uuid.UUID
	Name           string
	IsDefault      bool
	MachineRate    *string
	MachineAmount  *string
	MaterialRate   *string
	MaterialAmount *string
	// MaterialPriceSource says which rule MaterialRate comes from.
	MaterialPriceSource *MaterialPriceSource
	Total               *string
	Complete            bool
}

type PriceQuote struct {
	Machine  *PriceQuoteMachine
	Material *PriceQuoteMaterial
	Hours    *string
	Quantity *string
	Groups   []PriceQuoteGroup
}

// QuotePrice is a read-only lookup with the rates and rounding of job pricing.
func (s *Service) QuotePrice(ctx context.Context, p authorization.Principal, in PriceQuoteInput) (PriceQuote, error) {
	if err := require(p, authorization.PricingRead); err != nil {
		return PriceQuote{}, err
	}
	if in.MachineID != nil {
		if err := require(p, authorization.MachinesRead); err != nil {
			return PriceQuote{}, err
		}
	}
	if in.MaterialID != nil {
		if err := require(p, authorization.InventoryRead); err != nil {
			return PriceQuote{}, err
		}
	}
	hours, quantity, err := validatePriceQuoteInput(in)
	if err != nil {
		return PriceQuote{}, err
	}
	q := machinelogbookdb.New(s.pool)
	quote := PriceQuote{}
	var processID, materialTypeID uuid.UUID
	var variantID *uuid.UUID
	var unit string
	var machineUse bool
	if in.MachineID != nil {
		machine, err := q.GetMachine(ctx, *in.MachineID)
		if err != nil {
			return PriceQuote{}, noRows(err)
		}
		processID = machine.ProcessID
		quote.Machine = &PriceQuoteMachine{ID: machine.ID, Name: machine.Name, ProcessName: machine.ProcessName}
		quote.Hours = decimalPointer(hours)
	}
	if in.MaterialID != nil {
		material, err := q.GetMaterial(ctx, *in.MaterialID)
		if err != nil {
			return PriceQuote{}, noRows(err)
		}
		if material.DeletedAt.Valid {
			return PriceQuote{}, apperror.NotFound
		}
		materialTypeID, unit, machineUse = material.MaterialTypeID, material.Unit, material.MachineUse
		variantID = material.VariantID
		typeName := material.MaterialTypeName
		quote.Material = &PriceQuoteMaterial{
			ID:               material.ID,
			DisplayID:        material.DisplayID,
			Name:             material.Name,
			Unit:             material.Unit,
			MaterialTypeName: &typeName,
			Variant:          material.Variant,
		}
		quote.Quantity = decimalPointer(quantity)
	}
	groups, err := q.ListPricingGroups(ctx)
	if err != nil {
		return PriceQuote{}, err
	}
	quote.Groups = make([]PriceQuoteGroup, 0, len(groups))
	for _, group := range groups {
		if !group.Active {
			continue
		}
		rules, err := q.GetActivePricingRulesByGroup(ctx, group.ID)
		if err != nil {
			return PriceQuote{}, err
		}
		item := PriceQuoteGroup{PricingGroupID: group.ID, Name: group.Name, IsDefault: group.IsDefault, Complete: true}
		total := decimal.Zero
		if in.MachineID != nil {
			if rule := runtimeRuleFor(rules, processID); rule != nil {
				rate := decimalFromNumeric(rule.Rate)
				amount := hours.Mul(rate)
				item.MachineRate, item.MachineAmount = decimalPointer(rate), decimalPointer(amount.Round(2))
				total = total.Add(amount)
			} else {
				item.Complete = false
			}
		}
		if in.MaterialID != nil {
			// Run usages and sales from stock are priced alike, so the machine does not change the article's rate.
			rule, source := articleRuleFor(rules, in.MaterialID, &materialTypeID, variantID, unit, machineUse)
			if rule != nil {
				rate := decimalFromNumeric(rule.Rate)
				amount := quantity.Mul(rate)
				item.MaterialRate, item.MaterialAmount = decimalPointer(rate), decimalPointer(amount.Round(2))
				item.MaterialPriceSource = &source
				total = total.Add(amount)
			} else {
				item.Complete = false
			}
		}
		if item.Complete {
			item.Total = decimalPointer(total.Round(2))
		}
		quote.Groups = append(quote.Groups, item)
	}
	return quote, nil
}

func validatePriceQuoteInput(in PriceQuoteInput) (hours, quantity decimal.Decimal, err error) {
	if in.MachineID == nil && in.MaterialID == nil {
		return hours, quantity, apperror.Invalid("a machine or an article is required")
	}
	if (in.MachineID == nil) != (in.Hours == nil) {
		return hours, quantity, apperror.Invalid("hours are required with a machine and only with a machine")
	}
	if (in.MaterialID == nil) != (in.Quantity == nil) {
		return hours, quantity, apperror.Invalid("quantity is required with an article and only with an article")
	}
	if in.Hours != nil {
		if hours, err = parseNonNegativeDecimal(*in.Hours); err != nil {
			return hours, quantity, apperror.Invalid("hours must be a non-negative decimal")
		}
	}
	if in.Quantity != nil {
		if quantity, err = parseNonNegativeDecimal(*in.Quantity); err != nil {
			return hours, quantity, apperror.Invalid("quantity must be a non-negative decimal")
		}
	}
	return hours, quantity, nil
}

func parseNonNegativeDecimal(value string) (decimal.Decimal, error) {
	d, err := parseDecimal(strings.TrimSpace(value), false)
	if err != nil {
		return decimal.Zero, err
	}
	if d.IsNegative() {
		return decimal.Zero, apperror.Invalid("invalid decimal value")
	}
	return d, nil
}

func runtimeRuleFor(rules []machinelogbookdb.PricingRule, processID uuid.UUID) *machinelogbookdb.PricingRule {
	for i := range rules {
		if PricingRuleKind(rules[i].Kind) == PricingRuleMachineRuntime && rules[i].ProcessID != nil &&
			*rules[i].ProcessID == processID {
			return &rules[i]
		}
	}
	return nil
}

// articleRuleFor picks the active rule of a group that prices an article, in a sale, a run usage and a quote alike:
// the article's own stock_article rule, else the material rule of its variant, else the material rule of its type.
// Variant and type rates apply to machine-use types only, and match by unit as well. Without an article id (a
// purged article) only the type's rates apply.
func articleRuleFor(
	rules []machinelogbookdb.PricingRule,
	materialID, materialTypeID, variantID *uuid.UUID,
	unit string,
	machineUse bool,
) (*machinelogbookdb.PricingRule, MaterialPriceSource) {
	var variantRule, typeRule *machinelogbookdb.PricingRule
	for i := range rules {
		rule := &rules[i]
		switch PricingRuleKind(rule.Kind) {
		case PricingRuleStockArticle:
			if materialID != nil && rule.MaterialID != nil && *rule.MaterialID == *materialID {
				return rule, PriceFromStockArticle
			}
		case PricingRuleMaterial:
			if !machineUse || materialTypeID == nil || rule.MaterialTypeID == nil || *rule.MaterialTypeID != *materialTypeID ||
				rule.MaterialUnit == nil || *rule.MaterialUnit != unit {
				continue
			}
			switch {
			case rule.MaterialTypeVariantID == nil:
				if typeRule == nil {
					typeRule = rule
				}
			case variantID != nil && *rule.MaterialTypeVariantID == *variantID:
				if variantRule == nil {
					variantRule = rule
				}
			}
		}
	}
	if variantRule != nil {
		return variantRule, PriceFromMaterialTypeVariant
	}
	if typeRule != nil {
		return typeRule, PriceFromMaterialType
	}
	return nil, ""
}

func decimalPointer(value decimal.Decimal) *string {
	text := value.String()
	return &text
}
