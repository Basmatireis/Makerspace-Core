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
	ID              uuid.UUID
	Name            string
	MachineTypeName string
}

type PriceQuoteMaterial struct {
	ID               uuid.UUID
	Name, Unit       string
	MaterialTypeName *string
	SalePrice        *string
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
	Total          *string
	Complete       bool
}

type PriceQuote struct {
	Machine    *PriceQuoteMachine
	Material   *PriceQuoteMaterial
	Hours      *string
	Quantity   *string
	SaleAmount *string
	Groups     []PriceQuoteGroup
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
	var machineTypeID, materialTypeID uuid.UUID
	var unit string
	if in.MachineID != nil {
		machine, err := q.GetMachine(ctx, *in.MachineID)
		if err != nil {
			return PriceQuote{}, noRows(err)
		}
		machineTypeID = machine.MachineTypeID
		quote.Machine = &PriceQuoteMachine{ID: machine.ID, Name: machine.Name, MachineTypeName: machine.MachineTypeName}
		quote.Hours = decimalPointer(hours)
	}
	if in.MaterialID != nil {
		material, err := q.GetMaterial(ctx, *in.MaterialID)
		if err != nil {
			return PriceQuote{}, noRows(err)
		}
		materialTypeID, unit = material.MaterialTypeID, material.Unit
		typeName := material.MaterialTypeName
		quote.Material = &PriceQuoteMaterial{
			ID:               material.ID,
			Name:             material.Name,
			Unit:             material.Unit,
			MaterialTypeName: &typeName,
			SalePrice:        nullableDecimal(material.SalePrice),
		}
		quote.Quantity = decimalPointer(quantity)
		if material.SalePrice.Valid {
			amount := quantity.Mul(decimalFromNumeric(material.SalePrice)).Round(2)
			quote.SaleAmount = decimalPointer(amount)
		}
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
			if rule := runtimeRuleFor(rules, machineTypeID); rule != nil {
				rate := decimalFromNumeric(rule.Rate)
				amount := hours.Mul(rate)
				item.MachineRate, item.MachineAmount = decimalPointer(rate), decimalPointer(amount.Round(2))
				total = total.Add(amount)
			} else {
				item.Complete = false
			}
		}
		if in.MaterialID != nil {
			if rule := materialRuleFor(rules, materialTypeID, unit); rule != nil {
				rate := decimalFromNumeric(rule.Rate)
				amount := quantity.Mul(rate)
				item.MaterialRate, item.MaterialAmount = decimalPointer(rate), decimalPointer(amount.Round(2))
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

func runtimeRuleFor(rules []machinelogbookdb.PricingRule, machineTypeID uuid.UUID) *machinelogbookdb.PricingRule {
	for i := range rules {
		if PricingRuleKind(rules[i].Kind) == PricingRuleMachineRuntime && rules[i].MachineTypeID != nil &&
			*rules[i].MachineTypeID == machineTypeID {
			return &rules[i]
		}
	}
	return nil
}

// materialRuleFor matches like pricing snapshots do: by material type and unit.
func materialRuleFor(
	rules []machinelogbookdb.PricingRule,
	materialTypeID uuid.UUID,
	unit string,
) *machinelogbookdb.PricingRule {
	for i := range rules {
		if PricingRuleKind(rules[i].Kind) == PricingRuleMaterial && rules[i].MaterialTypeID != nil &&
			*rules[i].MaterialTypeID == materialTypeID && rules[i].MaterialUnit != nil && *rules[i].MaterialUnit == unit {
			return &rules[i]
		}
	}
	return nil
}

func decimalPointer(value decimal.Decimal) *string {
	text := value.String()
	return &text
}
