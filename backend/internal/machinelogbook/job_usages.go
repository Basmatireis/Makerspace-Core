package machinelogbook

import (
	"bytes"
	"context"
	"errors"
	"sort"
	"time"

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
			if input.MaterialID == uuid.Nil || input.ExternalMaterialName != nil {
				return nil, apperror.Invalid("makerspace usage requires a material")
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
			if input.SpoolID != nil || optional.Trimmed(input.ExternalMaterialName) == nil {
				return nil, apperror.Invalid("external usage requires a material description and cannot use a spool")
			}
			input.ExternalMaterialName = optional.Trimmed(input.ExternalMaterialName)
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

// resolveUsageFills attaches the open fill of every spool usage, locking the
// spools in id order. Archived spools and spools without an open fill cannot be
// used.
func (s *Service) resolveUsageFills(ctx context.Context, q *machinelogbookdb.Queries, items []parsedUsage) error {
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
		_, ref, _, err := s.lockConsumableFill(ctx, q, *items[i].SpoolID)
		if err != nil {
			return err
		}
		if items[i].MaterialID == nil || ref.MaterialID != *items[i].MaterialID {
			return apperror.Conflicting("spool_material_mismatch", "Spool does not belong to the selected material")
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
	return &fillRef{
		SpoolID:        *u.SpoolID,
		FillID:         *u.FillID,
		SpoolDisplayID: *u.SpoolDisplayID,
		FillNumber:     *u.FillNumber,
		MaterialID:     *u.MaterialID,
	}
}

// reversalFill returns the fill a usage correction goes back to. A usage whose
// fill was closed in the meantime, or whose spool was deleted, returns to loose
// stock instead.
func (s *Service) reversalFill(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	u machinelogbookdb.MachineRunUsage,
) (*fillRef, error) {
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

func (s *Service) insertUsages(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	runID uuid.UUID,
	items []parsedUsage,
) error {
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
				Fill:          item.Fill,
			},
			requestID,
		)
		if err != nil {
			return err
		}
	}
	return nil
}
