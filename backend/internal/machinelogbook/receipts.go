package machinelogbook

import (
	"context"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"
)

// Limits of a stock receipt.
const (
	maxReceiptPackages      = 500
	maxReceiptIdentifiers   = 20
	receiptClockSkew        = time.Minute
	maxReceiptTotalPriceEUR = 1_000_000_000_000
)

// ReceiptPlacement says where received filament goes. StorageLocation and
// TareWeightG apply to new spools only.
type ReceiptPlacement struct {
	Mode            PlacementMode
	TareWeightG     *string
	StorageLocation *string
	Identifiers     []NewSpoolIdentifier
}

// ReceiptInput books purchased stock. Exactly one of MaterialID (with
// ExpectedInventoryVersion) and Material (a new article) is set. The received
// quantity is PackageCount times the package size.
type ReceiptInput struct {
	MaterialID               *uuid.UUID
	Material                 *MaterialInput
	ExpectedInventoryVersion int64
	PackageCount             int
	PackageSize              *string
	TotalPrice               string
	Supplier, Reference      *string
	Note                     *string
	OccurredAt               time.Time
	Placement                *ReceiptPlacement
}

type ReceiptResult struct {
	Material     Material
	Spools       []FilamentSpool
	Transactions []InventoryTransaction
}

type InventorySuggestions struct {
	Variants, Manufacturers, Suppliers, StorageLocations []string
}

type validatedReceipt struct {
	count      int
	size       decimal.Decimal
	quantity   decimal.Decimal
	price      decimal.Decimal
	mode       PlacementMode
	tare       pgtype.Numeric
	location   *string
	supplier   *string
	reference  *string
	identifier []NewSpoolIdentifier
}

// splitCents divides a price into n parts of whole cents whose sum is exact;
// the last part takes the remainder.
func splitCents(total decimal.Decimal, n int) []decimal.Decimal {
	cents := total.Shift(2).IntPart()
	base, rest := cents/int64(n), cents%int64(n)
	parts := make([]decimal.Decimal, n)
	for i := range parts {
		value := base
		if i == n-1 {
			value += rest
		}
		parts[i] = decimal.New(value, -2)
	}
	return parts
}

// receiptBooking books the purchase rows of one receipt inside its transaction.
type receiptBooking struct {
	s          *Service
	ctx        context.Context
	tx         pgx.Tx
	q          *machinelogbookdb.Queries
	p          authorization.Principal
	in         ReceiptInput
	v          validatedReceipt
	materialID uuid.UUID
	detail     machinelogbookdb.GetMaterialRow
	requestID  *uuid.UUID
	result     ReceiptResult
}

func (b *receiptBooking) purchase(quantity, price decimal.Decimal, spool *spoolRef) error {
	booked, err := b.s.applyInventoryMutation(
		b.ctx,
		b.tx,
		b.q,
		b.p,
		b.materialID,
		anyInventoryVersion,
		inventoryMutation{
			Kind:             InventoryPurchase,
			QuantityDelta:    quantity,
			UnitCost:         price.Div(quantity),
			ValueDelta:       price,
			TotalPrice:       &price,
			OccurredAt:       b.in.OccurredAt,
			Supplier:         b.v.supplier,
			Reference:        b.v.reference,
			Note:             b.in.Note,
			Spool:            spool,
			KeepSpoolVersion: spool != nil,
			SkipAudit:        true,
		},
		b.requestID,
	)
	if err != nil {
		return err
	}
	b.result.Transactions = append(b.result.Transactions, booked.Transaction)
	return nil
}

// newSpools puts every package on a new spool with its own label.
func (b *receiptBooking) newSpools() error {
	prices := splitCents(b.v.price, b.v.count)
	prefix := spoolLabelPrefix(b.detail.MaterialTypeCode, b.detail.Variant, b.detail.ColorName)
	for i := range b.v.count {
		label, err := nextSpoolLabel(b.ctx, b.q, prefix)
		if err != nil {
			return err
		}
		spool, err := b.q.CreateFilamentSpool(
			b.ctx,
			machinelogbookdb.CreateFilamentSpoolParams{
				ID:                   ids.New(),
				DisplayID:            label,
				MaterialID:           b.materialID,
				InitialNetWeightG:    numericFromDecimal(b.v.size),
				TareWeightG:          b.v.tare,
				AcquiredOn:           pgDate(&b.in.OccurredAt),
				AcquisitionReference: b.v.reference,
				StorageLocation:      b.v.location,
			},
		)
		if err != nil {
			return databaseError(err)
		}
		ref := spoolRef{SpoolID: spool.ID, SpoolDisplayID: spool.DisplayID, MaterialID: spool.MaterialID}
		if err = b.purchase(b.v.size, prices[i], &ref); err != nil {
			return err
		}
		if _, err = b.q.BumpFilamentSpoolVersion(
			b.ctx,
			machinelogbookdb.BumpFilamentSpoolVersionParams{ID: spool.ID, ExpectedVersion: spool.Version},
		); err != nil {
			return err
		}
		if err = addSpoolIdentifiers(b.ctx, b.q, spool.ID, b.v.identifier); err != nil {
			return err
		}
		b.result.Spools = append(b.result.Spools, FilamentSpool{ID: spool.ID})
	}
	return nil
}

// ReceiveStock books purchased stock for an existing or a newly described
// article in one transaction with one audit event. Filament can go to loose
// stock or onto one new spool per package.
func (s *Service) ReceiveStock(
	ctx context.Context,
	p authorization.Principal,
	in ReceiptInput,
	requestID *uuid.UUID,
) (ReceiptResult, error) {
	if err := require(p, authorization.InventoryReceive); err != nil {
		return ReceiptResult{}, err
	}
	if in.Placement != nil && in.Placement.Mode == PlacementNewSpools {
		if err := require(p, authorization.FilamentSpoolsManage); err != nil {
			return ReceiptResult{}, err
		}
	}
	v, err := s.validateReceipt(in)
	if err != nil {
		return ReceiptResult{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ReceiptResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)

	var materialID uuid.UUID
	if in.MaterialID != nil {
		materialID = *in.MaterialID
		current, lockErr := q.GetMaterialForUpdate(ctx, materialID)
		if lockErr != nil {
			return ReceiptResult{}, noRows(lockErr)
		}
		if current.DeletedAt.Valid {
			return ReceiptResult{}, errMaterialInBin
		}
		if current.InventoryVersion != in.ExpectedInventoryVersion {
			return ReceiptResult{}, apperror.StaleWrite
		}
	} else if materialID, err = s.createMaterialTx(ctx, tx, p, *in.Material, requestID); err != nil {
		return ReceiptResult{}, err
	}
	detail, err := q.GetMaterial(ctx, materialID)
	if err != nil {
		return ReceiptResult{}, noRows(err)
	}
	if MaterialKind(detail.MaterialKind) != KindFilament && v.mode != PlacementStorage {
		return ReceiptResult{}, unprocessable("placement_requires_filament", "Only filament can be placed on spools")
	}
	if v.size.IsZero() {
		if !detail.PackageSize.Valid {
			return ReceiptResult{}, apperror.Invalid("packageSize is required when the article has no package size")
		}
		v.size = decimalFromNumeric(detail.PackageSize)
		v.quantity = v.size.Mul(decimal.NewFromInt(int64(v.count)))
	}
	if v.location == nil {
		v.location = detail.StorageLocation
	}

	b := &receiptBooking{
		s:          s,
		ctx:        ctx,
		tx:         tx,
		q:          q,
		p:          p,
		in:         in,
		v:          v,
		materialID: materialID,
		detail:     detail,
		requestID:  requestID,
	}
	switch v.mode {
	case PlacementStorage:
		err = b.purchase(v.quantity, v.price, nil)
	case PlacementNewSpools:
		err = b.newSpools()
	}
	if err != nil {
		return ReceiptResult{}, err
	}
	result := b.result
	for i := range result.Spools {
		spool, loadErr := s.loadSpool(ctx, q, result.Spools[i].ID)
		if loadErr != nil {
			return ReceiptResult{}, loadErr
		}
		result.Spools[i] = spool
	}
	if result.Spools == nil {
		result.Spools = []FilamentSpool{}
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"inventory.receipt_recorded",
		"material",
		materialID,
		requestID,
		[]string{
			"quantity", "inventoryValue", "inventoryVersion", "packageCount", "packageSize",
			"totalPrice", "supplier", "reference", "placement", "spools",
		},
	); err != nil {
		return ReceiptResult{}, err
	}
	material, err := s.loadMaterial(ctx, q, materialID)
	if err != nil {
		return ReceiptResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return ReceiptResult{}, err
	}
	result.Material = material
	return result, nil
}

func (s *Service) validateReceipt(in ReceiptInput) (validatedReceipt, error) {
	var v validatedReceipt
	var err error
	if (in.MaterialID == nil) == (in.Material == nil) {
		return v, apperror.Invalid("exactly one of materialId and material is required")
	}
	if in.MaterialID != nil && in.ExpectedInventoryVersion < 1 {
		return v, apperror.Invalid("expectedInventoryVersion is required with materialId")
	}
	if in.PackageCount < 1 || in.PackageCount > maxReceiptPackages {
		return v, apperror.Invalid("packageCount must be between 1 and 500")
	}
	v.count = in.PackageCount
	if in.PackageSize != nil {
		if v.size, err = parseDecimal(*in.PackageSize, true); err != nil {
			return v, apperror.Invalid("packageSize must be positive")
		}
		v.quantity = v.size.Mul(decimal.NewFromInt(int64(v.count)))
	}
	v.price, err = parseDecimal(in.TotalPrice, false)
	if err != nil || v.price.IsNegative() || !v.price.Equal(v.price.Round(2)) ||
		v.price.GreaterThan(decimal.NewFromInt(maxReceiptTotalPriceEUR)) {
		return v, apperror.Invalid("totalPrice must be a non-negative amount with at most two decimals")
	}
	if in.OccurredAt.IsZero() {
		return v, apperror.Invalid("occurredAt is required")
	}
	if in.OccurredAt.After(s.now().Add(receiptClockSkew)) {
		return v, apperror.Invalid("occurredAt must not be in the future")
	}
	if v.supplier, err = validateOptionalText(in.Supplier, "supplier", 200); err != nil {
		return v, err
	}
	if v.reference, err = validateOptionalText(in.Reference, "reference", maxPurchaseReference); err != nil {
		return v, err
	}
	if _, err = validateOptionalText(in.Note, "note", 1000); err != nil {
		return v, err
	}
	v.mode = PlacementStorage
	if in.Placement == nil {
		return v, nil
	}
	pl := in.Placement
	v.mode = pl.Mode
	if err = v.validatePlacement(pl); err != nil {
		return v, err
	}
	v.identifier, err = validateNewIdentifiers(pl.Identifiers)
	return v, err
}

// validateNewIdentifiers trims the identifiers for a new fill and refuses invalid or repeated ones.
func validateNewIdentifiers(in []NewSpoolIdentifier) ([]NewSpoolIdentifier, error) {
	if len(in) > maxReceiptIdentifiers {
		return nil, apperror.Invalid("too many identifiers")
	}
	var out []NewSpoolIdentifier
	seen := map[string]bool{}
	for _, identifier := range in {
		value := strings.TrimSpace(identifier.Value)
		if !validIdentifierKind(identifier.Kind) || value == "" || len(value) > 255 {
			return nil, apperror.Invalid("invalid spool identifier")
		}
		key := string(identifier.Kind) + "/" + strings.ToLower(value)
		if seen[key] {
			return nil, apperror.Conflicting("identifier_in_use", "An identifier is used twice")
		}
		seen[key] = true
		out = append(out, NewSpoolIdentifier{Kind: identifier.Kind, Value: value})
	}
	return out, nil
}

// validatePlacement checks the fields of a placement against its mode.
func (v *validatedReceipt) validatePlacement(pl *ReceiptPlacement) error {
	var err error
	switch pl.Mode {
	case PlacementStorage:
		if pl.TareWeightG != nil || pl.StorageLocation != nil || len(pl.Identifiers) > 0 {
			return apperror.Invalid("placement storage takes no further placement fields")
		}
	case PlacementNewSpools:
		v.tare, err = pgNullableNumeric(pl.TareWeightG, false)
		if err != nil || (v.tare.Valid && decimalFromNumeric(v.tare).IsNegative()) {
			return apperror.Invalid("tareWeightG must be non-negative")
		}
		if v.location, err = validateOptionalText(pl.StorageLocation, "storageLocation", 200); err != nil {
			return err
		}
		if len(pl.Identifiers) > 0 && v.count != 1 {
			return apperror.Invalid("identifiers are only valid when exactly one spool is created")
		}
	default:
		return apperror.Invalid("invalid placement mode")
	}
	return nil
}

// ListInventorySuggestions returns the distinct values in use for article and
// receipt forms, most frequent first. Variants can be limited to one type.
func (s *Service) ListInventorySuggestions(
	ctx context.Context,
	p authorization.Principal,
	materialTypeID *uuid.UUID,
) (InventorySuggestions, error) {
	if err := require(p, authorization.InventoryRead); err != nil {
		return InventorySuggestions{}, err
	}
	q := machinelogbookdb.New(s.pool)
	var out InventorySuggestions
	var err error
	if out.Variants, err = q.ListInventoryVariantSuggestions(ctx, materialTypeID); err != nil {
		return out, err
	}
	if out.Manufacturers, err = q.ListInventoryManufacturerSuggestions(ctx); err != nil {
		return out, err
	}
	if out.Suppliers, err = q.ListInventorySupplierSuggestions(ctx); err != nil {
		return out, err
	}
	if out.StorageLocations, err = q.ListInventoryStorageLocationSuggestions(ctx); err != nil {
		return out, err
	}
	return out, nil
}
