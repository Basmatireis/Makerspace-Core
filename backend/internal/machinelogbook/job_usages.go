package machinelogbook

import (
	"bytes"
	"context"
	"errors"
	"sort"
	"time"
	"unicode/utf8"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/optional"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
)

type parsedUsage struct {
	MaterialID           *uuid.UUID
	SpoolID              *uuid.UUID
	Ownership            string
	ExternalMaterialName *string
	MaterialTypeID       *uuid.UUID
	QuantityBasis        string
	Quantity             decimal.Decimal
	UsageID              uuid.UUID
	SourcePrinterEventID *uuid.UUID
	EstimationMethod     *string
	CalculationVersion   *string
	EstimateQuality      *string
	ReportRevision       *int64
	StaffCorrected       bool
	// Spool is the spool a usage draws from; it is resolved inside the
	// transaction that records the usage.
	Spool *spoolRef
}

// parseOutcome validates a run outcome. An empty value or "unknown" records no
// outcome yet.
func parseOutcome(value JobOutcome) (*RunOutcome, error) {
	switch value {
	case "", JobOutcomeUnknown:
		return nil, nil
	case JobOutcomeSuccessful, JobOutcomePartialFailure, JobOutcomeFailed, JobOutcomeCancelled:
		outcome := RunOutcome(value)
		return &outcome, nil
	}
	return nil, apperror.Invalid("invalid outcome")
}

func validateOptionalOutcome(value *RunOutcome) (*RunOutcome, error) {
	if value == nil {
		return nil, nil
	}
	if JobOutcome(*value) == JobOutcomeUnknown || *value == "" {
		return nil, apperror.Invalid("invalid outcome")
	}
	return parseOutcome(JobOutcome(*value))
}
func validateInterval(startsAt, endsAt time.Time) error {
	if startsAt.IsZero() || endsAt.IsZero() || !endsAt.After(startsAt) {
		return apperror.Invalid("endsAt must be after startsAt")
	}
	return nil
}
func parseUsages(inputs []UsageInput) ([]parsedUsage, error) {
	items := make([]parsedUsage, 0, len(inputs))
	seen := map[string]bool{}
	for _, input := range inputs {
		if input.Ownership == "" {
			input.Ownership = OwnershipMakerspace
		}
		if input.QuantityBasis == "" {
			input.QuantityBasis = QuantityBasisActual
		}
		if input.QuantityBasis != QuantityBasisActual && input.QuantityBasis != QuantityBasisEstimated {
			return nil, apperror.Invalid("invalid quantityBasis")
		}
		switch input.Ownership {
		case OwnershipMakerspace:
			if input.MaterialID == uuid.Nil || input.ExternalMaterialName != nil || input.Label != nil || input.MaterialTypeID != nil {
				return nil, apperror.Invalid("makerspace usage requires a material and takes no label or material type")
			}
			key := "material/" + input.MaterialID.String()
			if input.SpoolID != nil {
				key = "spool/" + input.SpoolID.String()
			}
			if seen[key] {
				return nil, apperror.Invalid("makerspace usage sources must be unique")
			}
			seen[key] = true
		case OwnershipExternal:
			if input.SpoolID != nil {
				return nil, apperror.Invalid("material the recipient brought cannot use a spool")
			}
			label := optional.Trimmed(input.ExternalMaterialName)
			if input.Label != nil {
				label = optional.Trimmed(input.Label)
				if label == nil || utf8.RuneCountInString(*label) > MaxUsageLabelLength {
					return nil, apperror.Invalid("label must be 1 to 120 characters")
				}
			}
			if label != nil && utf8.RuneCountInString(*label) > maxExternalMaterialNameLength {
				return nil, apperror.Invalid("externalMaterialName must be at most 200 characters")
			}
			input.ExternalMaterialName = label
		default:
			return nil, apperror.Invalid("invalid filament ownership")
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
		items = append(
			items,
			parsedUsage{
				MaterialID:           materialID,
				SpoolID:              input.SpoolID,
				Ownership:            string(input.Ownership),
				ExternalMaterialName: input.ExternalMaterialName,
				MaterialTypeID:       input.MaterialTypeID,
				QuantityBasis:        string(input.QuantityBasis),
				Quantity:             quantity,
				UsageID:              ids.New(),
			},
		)
	}
	sort.Slice(items, func(i, j int) bool { return usageSortKey(items[i]) < usageSortKey(items[j]) })
	return items, nil
}

func usageSortKey(item parsedUsage) string {
	if item.MaterialID == nil {
		return "z/" + optional.Value(item.ExternalMaterialName) + "/" + item.UsageID.String()
	}
	spool := ""
	if item.SpoolID != nil {
		spool = item.SpoolID.String()
	}
	return item.MaterialID.String() + "/" + spool
}

// resolveUsageSpools locks the spool of every spool usage in id order.
// Archived spools cannot be used.
func (s *Service) resolveUsageSpools(ctx context.Context, q *machinelogbookdb.Queries, items []parsedUsage) error {
	order := make([]int, 0, len(items))
	for i := range items {
		if UsageOwnership(items[i].Ownership) != OwnershipExternal && items[i].SpoolID != nil {
			order = append(order, i)
		}
	}
	sort.Slice(order, func(a, b int) bool {
		return bytes.Compare(items[order[a]].SpoolID[:], items[order[b]].SpoolID[:]) < 0
	})
	for _, i := range order {
		_, ref, _, err := s.lockConsumableSpool(ctx, q, *items[i].SpoolID)
		if err != nil {
			return err
		}
		if items[i].MaterialID == nil || ref.MaterialID != *items[i].MaterialID {
			return apperror.Conflicting("spool_material_mismatch", "Spool does not belong to the selected material")
		}
		items[i].Spool = &ref
	}
	return nil
}

// usageSpoolRef rebuilds the spool reference stored on a recorded usage.
func usageSpoolRef(u machinelogbookdb.MachineRunUsage) *spoolRef {
	if u.MaterialID == nil || u.SpoolID == nil || u.SpoolDisplayID == nil {
		return nil
	}
	return &spoolRef{SpoolID: *u.SpoolID, SpoolDisplayID: *u.SpoolDisplayID, MaterialID: *u.MaterialID}
}

// reversalSpool returns the spool a usage correction goes back to. A usage
// whose spool was retired or deleted in the meantime returns to loose stock.
func (s *Service) reversalSpool(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	u machinelogbookdb.MachineRunUsage,
) (*spoolRef, error) {
	ref := usageSpoolRef(u)
	if ref == nil {
		return nil, nil
	}
	spool, err := q.GetFilamentSpoolForUpdate(ctx, ref.SpoolID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if SpoolLifecycle(spool.Lifecycle) != SpoolActive || spool.MaterialID != ref.MaterialID {
		return nil, nil
	}
	return ref, nil
}

func (s *Service) insertUsages(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	runID uuid.UUID,
	items []parsedUsage,
) error {
	if err := validateOwnMaterial(ctx, q, items); err != nil {
		return err
	}
	for i := range items {
		params := machinelogbookdb.InsertRunUsageParams{
			ID:                   items[i].UsageID,
			RunID:                runID,
			MaterialID:           items[i].MaterialID,
			SpoolID:              items[i].SpoolID,
			Ownership:            items[i].Ownership,
			ExternalMaterialName: items[i].ExternalMaterialName,
			QuantityBasis:        items[i].QuantityBasis,
			Quantity:             numericFromDecimal(items[i].Quantity),
			SourcePrinterEventID: items[i].SourcePrinterEventID,
			EstimationMethod:     items[i].EstimationMethod,
			CalculationVersion:   items[i].CalculationVersion,
			EstimateQuality:      items[i].EstimateQuality,
			ReportRevision:       items[i].ReportRevision,
			StaffCorrected:       items[i].StaffCorrected,
		}
		if spool := items[i].Spool; spool != nil && items[i].SpoolID != nil {
			params.SpoolDisplayID = &spool.SpoolDisplayID
		}
		row, err := q.InsertRunUsage(ctx, params)
		if err != nil {
			return databaseError(err)
		}
		items[i].UsageID = row.ID
		if items[i].MaterialTypeID != nil {
			if err = q.SetRunUsageMaterialType(
				ctx,
				machinelogbookdb.SetRunUsageMaterialTypeParams{ID: row.ID, MaterialTypeID: items[i].MaterialTypeID},
			); err != nil {
				return databaseError(err)
			}
		}
	}
	return nil
}

func (s *Service) consumeUsages(
	ctx context.Context,
	tx pgx.Tx,
	q *machinelogbookdb.Queries,
	p authorization.Principal,
	items []parsedUsage,
	occurredAt time.Time,
	requestID *uuid.UUID,
) error {
	for _, item := range items {
		if UsageOwnership(item.Ownership) == OwnershipExternal {
			continue
		}
		current, err := q.GetMaterialForUpdate(ctx, *item.MaterialID)
		if err != nil {
			return noRows(err)
		}
		if !current.Active {
			return apperror.Conflicting("material_inactive", "An inactive material cannot be consumed")
		}
		average := decimalFromNumeric(current.AverageUnitCost)
		_, err = s.applyInventoryMutation(
			ctx,
			tx,
			q,
			p,
			*item.MaterialID,
			current.InventoryVersion,
			inventoryMutation{
				Kind:          InventoryMachineConsumption,
				QuantityDelta: item.Quantity.Neg(),
				UnitCost:      average,
				ValueDelta:    item.Quantity.Mul(average).Neg(),
				OccurredAt:    occurredAt,
				UsageID:       &item.UsageID,
				Spool:         item.Spool,
			},
			requestID,
		)
		if err != nil {
			return err
		}
	}
	return nil
}

// MaxUsageLabelLength is the longest label of material the recipient brought; the older externalMaterialName field
// keeps its limit of maxExternalMaterialNameLength.
const (
	MaxUsageLabelLength           = 120
	maxExternalMaterialNameLength = 200
)

// validateOwnMaterial checks material the recipient brought: a named material type must exist, and an article given
// as well must be of that type.
func validateOwnMaterial(ctx context.Context, q *machinelogbookdb.Queries, items []parsedUsage) error {
	for _, item := range items {
		if UsageOwnership(item.Ownership) != OwnershipExternal || item.MaterialTypeID == nil {
			continue
		}
		exists, err := q.MaterialTypeExists(ctx, *item.MaterialTypeID)
		if err != nil {
			return err
		}
		if !exists {
			return apperror.Invalid("unknown material type")
		}
		if item.MaterialID != nil {
			typeID, err := q.GetMaterialTypeOfMaterial(ctx, *item.MaterialID)
			if errors.Is(err, pgx.ErrNoRows) {
				return apperror.Invalid("unknown material")
			}
			if err != nil {
				return err
			}
			if typeID != *item.MaterialTypeID {
				return apperror.Invalid("the material is not of the given material type")
			}
		}
	}
	return nil
}

// forceActualBasis marks the material of a manual run as measured: staff enter what was used, never an estimate.
func forceActualBasis(items []parsedUsage) {
	for i := range items {
		items[i].QuantityBasis = string(QuantityBasisActual)
	}
}
