package machinelogbook

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"
)

// Where received filament goes.
const (
	PlacementStorage        = "storage"
	PlacementNewSpools      = "new_spools"
	PlacementReusableSpool  = "reusable_spool"
	maxReceiptPackages      = 500
	maxReceiptIdentifiers   = 20
	receiptClockSkew        = time.Minute
	maxReceiptTotalPriceEUR = 1_000_000_000_000
)

// ReceiptPlacement says where received filament goes. StorageLocation and
// TareWeightG apply to new spools only, ReusableSpool* to a reusable spool.
type ReceiptPlacement struct {
	Mode                         string
	TareWeightG                  *string
	StorageLocation              *string
	ReusableSpoolID              *uuid.UUID
	ReusableSpoolExpectedVersion int64
	Identifiers                  []NewSpoolIdentifier
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
	mode       string
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

// ReceiveStock books purchased stock for an existing or a newly described
// article in one transaction with one audit event. Filament can go to loose
// stock, onto one new single-use spool per package, or onto an empty reusable
// spool.
func (s *Service) ReceiveStock(ctx context.Context, p authorization.Principal, in ReceiptInput, requestID *uuid.UUID) (ReceiptResult, error) {
	if err := require(p, authorization.InventoryManage); err != nil {
		return ReceiptResult{}, err
	}
	if in.Placement != nil && (in.Placement.Mode == PlacementNewSpools || in.Placement.Mode == PlacementReusableSpool) {
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
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)

	// A reusable spool is locked before the material, like every other
	// operation that touches both, so concurrent changes cannot deadlock.
	var reusable *lockedReusableSpool
	if v.mode == PlacementReusableSpool {
		reusable, err = s.lockEmptyReusableSpool(ctx, q, in.Placement)
		if err != nil {
			return ReceiptResult{}, err
		}
	}

	var materialID uuid.UUID
	expected := anyInventoryVersion
	if in.MaterialID != nil {
		materialID = *in.MaterialID
		current, lockErr := q.GetMaterialForUpdate(ctx, materialID)
		if lockErr != nil {
			return ReceiptResult{}, noRows(lockErr)
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
	isFilament := detail.MaterialKind == KindFilament
	if !isFilament && v.mode != PlacementStorage {
		return ReceiptResult{}, unprocessable("placement_requires_filament", "Only filament can be placed on spools")
	}
	if v.size.IsZero() {
		if !detail.PackageSize.Valid {
			return ReceiptResult{}, validation("packageSize is required when the article has no package size")
		}
		v.size = decimalFromNumeric(detail.PackageSize)
		v.quantity = v.size.Mul(decimal.NewFromInt(int64(v.count)))
	}
	if v.location == nil {
		v.location = detail.StorageLocation
	}

	var result ReceiptResult
	purchase := func(quantity, price decimal.Decimal, fill *fillRef) (InventoryMutationResult, error) {
		return s.applyInventoryMutation(ctx, tx, q, p, materialID, expected, inventoryMutation{Kind: "purchase", QuantityDelta: quantity, UnitCost: price.Div(quantity), ValueDelta: price, TotalPrice: &price,
			OccurredAt: in.OccurredAt, Supplier: v.supplier, Reference: v.reference, Note: in.Note, Fill: fill, KeepSpoolVersion: fill != nil, SkipAudit: true}, requestID)
	}
	switch v.mode {
	case PlacementStorage:
		booked, bookErr := purchase(v.quantity, v.price, nil)
		if bookErr != nil {
			return ReceiptResult{}, bookErr
		}
		result.Transactions = append(result.Transactions, booked.Transaction)
	case PlacementNewSpools:
		prices := splitCents(v.price, v.count)
		for i := 0; i < v.count; i++ {
			sequence, seqErr := q.NextFilamentSpoolSequence(ctx)
			if seqErr != nil {
				return ReceiptResult{}, seqErr
			}
			acquired := pgDate(&in.OccurredAt)
			spool, spoolErr := q.CreateFilamentSpool(ctx, machinelogbookdb.CreateFilamentSpoolParams{ID: newID(), DisplayID: fmt.Sprintf("S-%04d-%06d", s.now().UTC().Year(), sequence), Kind: "single_use",
				TareWeightG: v.tare, AcquiredOn: acquired, AcquisitionReference: v.reference, StorageLocation: v.location})
			if spoolErr != nil {
				return ReceiptResult{}, databaseError(spoolErr)
			}
			fill, fillErr := q.InsertFilamentSpoolFill(ctx, machinelogbookdb.InsertFilamentSpoolFillParams{ID: newID(), SpoolID: spool.ID, FillNumber: 1, MaterialID: materialID,
				Manufacturer: detail.Manufacturer, InitialNetWeightG: numericFromDecimal(v.size), FilledAt: in.OccurredAt.UTC()})
			if fillErr != nil {
				return ReceiptResult{}, databaseError(fillErr)
			}
			ref := refFromFill(spool, fill)
			booked, bookErr := purchase(v.size, prices[i], &ref)
			if bookErr != nil {
				return ReceiptResult{}, bookErr
			}
			if _, err = q.BumpFilamentSpoolVersion(ctx, machinelogbookdb.BumpFilamentSpoolVersionParams{ID: spool.ID, ExpectedVersion: spool.Version}); err != nil {
				return ReceiptResult{}, err
			}
			if err = addFillIdentifiers(ctx, q, spool.ID, fill.ID, v.identifier); err != nil {
				return ReceiptResult{}, err
			}
			result.Transactions = append(result.Transactions, booked.Transaction)
			result.Spools = append(result.Spools, FilamentSpool{ID: spool.ID})
		}
	case PlacementReusableSpool:
		if !isFilament {
			return ReceiptResult{}, unprocessable("placement_requires_filament", "Only filament can be placed on spools")
		}
		number, numErr := q.NextFilamentSpoolFillNumber(ctx, reusable.spool.ID)
		if numErr != nil {
			return ReceiptResult{}, numErr
		}
		fill, fillErr := q.InsertFilamentSpoolFill(ctx, machinelogbookdb.InsertFilamentSpoolFillParams{ID: newID(), SpoolID: reusable.spool.ID, FillNumber: number, MaterialID: materialID,
			Manufacturer: detail.Manufacturer, InitialNetWeightG: numericFromDecimal(v.size), FilledAt: in.OccurredAt.UTC()})
		if fillErr != nil {
			return ReceiptResult{}, databaseError(fillErr)
		}
		ref := refFromFill(reusable.spool, fill)
		booked, bookErr := purchase(v.size, v.price, &ref)
		if bookErr != nil {
			return ReceiptResult{}, bookErr
		}
		if _, err = q.BumpFilamentSpoolVersion(ctx, machinelogbookdb.BumpFilamentSpoolVersionParams{ID: reusable.spool.ID, ExpectedVersion: reusable.spool.Version}); err != nil {
			return ReceiptResult{}, err
		}
		if err = addFillIdentifiers(ctx, q, reusable.spool.ID, fill.ID, v.identifier); err != nil {
			return ReceiptResult{}, err
		}
		result.Transactions = append(result.Transactions, booked.Transaction)
		result.Spools = append(result.Spools, FilamentSpool{ID: reusable.spool.ID})
	}

	for i := range result.Spools {
		spool, loadErr := s.loadSpool(ctx, q, result.Spools[i].ID, false)
		if loadErr != nil {
			return ReceiptResult{}, loadErr
		}
		result.Spools[i] = spool
	}
	if result.Spools == nil {
		result.Spools = []FilamentSpool{}
	}
	if err = writeAudit(ctx, tx, p, "inventory.receipt_recorded", "material", materialID, requestID, []string{"quantity", "inventoryValue", "inventoryVersion", "packageCount", "packageSize", "totalPrice", "supplier", "reference", "placement", "spools"}); err != nil {
		return ReceiptResult{}, err
	}
	row, err := q.GetMaterial(ctx, materialID)
	if err != nil {
		return ReceiptResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return ReceiptResult{}, err
	}
	result.Material = materialFromGet(row)
	return result, nil
}

func (s *Service) validateReceipt(in ReceiptInput) (validatedReceipt, error) {
	var v validatedReceipt
	var err error
	if (in.MaterialID == nil) == (in.Material == nil) {
		return v, validation("exactly one of materialId and material is required")
	}
	if in.MaterialID != nil && in.ExpectedInventoryVersion < 1 {
		return v, validation("expectedInventoryVersion is required with materialId")
	}
	if in.PackageCount < 1 || in.PackageCount > maxReceiptPackages {
		return v, validation("packageCount must be between 1 and 500")
	}
	v.count = in.PackageCount
	if in.PackageSize != nil {
		if v.size, err = parseDecimal(*in.PackageSize, true); err != nil {
			return v, validation("packageSize must be positive")
		}
		v.quantity = v.size.Mul(decimal.NewFromInt(int64(v.count)))
	}
	if v.price, err = parseDecimal(in.TotalPrice, false); err != nil || v.price.IsNegative() || !v.price.Equal(v.price.Round(2)) || v.price.GreaterThan(decimal.NewFromInt(maxReceiptTotalPriceEUR)) {
		return v, validation("totalPrice must be a non-negative amount with at most two decimals")
	}
	if in.OccurredAt.IsZero() {
		return v, validation("occurredAt is required")
	}
	if in.OccurredAt.After(s.now().Add(receiptClockSkew)) {
		return v, validation("occurredAt must not be in the future")
	}
	if v.supplier, err = validateOptionalText(in.Supplier, "supplier", 200); err != nil {
		return v, err
	}
	if v.reference, err = validateOptionalText(in.Reference, "reference", 200); err != nil {
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
	switch pl.Mode {
	case PlacementStorage:
		if pl.TareWeightG != nil || pl.StorageLocation != nil || pl.ReusableSpoolID != nil || len(pl.Identifiers) > 0 {
			return v, validation("placement storage takes no further placement fields")
		}
	case PlacementNewSpools:
		if pl.ReusableSpoolID != nil || pl.ReusableSpoolExpectedVersion != 0 {
			return v, validation("reusableSpoolId applies to the placement reusable_spool only")
		}
		if v.tare, err = pgNullableNumeric(pl.TareWeightG, false); err != nil || (v.tare.Valid && decimalFromNumeric(v.tare).IsNegative()) {
			return v, validation("tareWeightG must be non-negative")
		}
		if v.location, err = validateOptionalText(pl.StorageLocation, "storageLocation", 200); err != nil {
			return v, err
		}
		if len(pl.Identifiers) > 0 && v.count != 1 {
			return v, validation("identifiers are only valid when exactly one spool is created")
		}
	case PlacementReusableSpool:
		if v.count != 1 {
			return v, validation("a reusable spool takes exactly one package")
		}
		if pl.ReusableSpoolID == nil || pl.ReusableSpoolExpectedVersion < 1 {
			return v, validation("reusableSpoolId and reusableSpoolExpectedVersion are required")
		}
		if pl.TareWeightG != nil || pl.StorageLocation != nil {
			return v, validation("tareWeightG and storageLocation apply to new spools only")
		}
	default:
		return v, validation("invalid placement mode")
	}
	if len(pl.Identifiers) > maxReceiptIdentifiers {
		return v, validation("too many identifiers")
	}
	seen := map[string]bool{}
	for _, identifier := range pl.Identifiers {
		value := strings.TrimSpace(identifier.Value)
		if !validIdentifierKind(identifier.Kind) || value == "" || len(value) > 255 {
			return v, validation("invalid spool identifier")
		}
		key := identifier.Kind + "/" + strings.ToLower(value)
		if seen[key] {
			return v, conflict("identifier_in_use", "An identifier is used twice")
		}
		seen[key] = true
		v.identifier = append(v.identifier, NewSpoolIdentifier{Kind: identifier.Kind, Value: value})
	}
	return v, nil
}

type lockedReusableSpool struct {
	spool machinelogbookdb.FilamentSpool
}

// lockEmptyReusableSpool locks the reusable spool a receipt loads and checks it
// is active, unchanged and without an open fill.
func (s *Service) lockEmptyReusableSpool(ctx context.Context, q *machinelogbookdb.Queries, pl *ReceiptPlacement) (*lockedReusableSpool, error) {
	spool, err := q.GetFilamentSpoolForUpdate(ctx, *pl.ReusableSpoolID)
	if err != nil {
		return nil, noRows(err)
	}
	if spool.Kind != "reusable" {
		return nil, conflict("spool_not_reusable", "Only reusable spools can be refilled")
	}
	if spool.Lifecycle == "archived" {
		return nil, conflict("spool_archived", "An archived spool cannot be refilled")
	}
	if spool.Version != pl.ReusableSpoolExpectedVersion {
		return nil, apperror.StaleWrite
	}
	if _, err = q.GetOpenFilamentSpoolFill(ctx, spool.ID); err == nil {
		return nil, conflict("spool_already_loaded", "The spool already holds a fill; finish it or change its fill instead")
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	return &lockedReusableSpool{spool: spool}, nil
}

// addFillIdentifiers tags a fill; an identifier that is in use stays refused.
func addFillIdentifiers(ctx context.Context, q *machinelogbookdb.Queries, spoolID, fillID uuid.UUID, identifiers []NewSpoolIdentifier) error {
	for _, identifier := range identifiers {
		inUse, err := q.FilamentSpoolIdentifierInUse(ctx, machinelogbookdb.FilamentSpoolIdentifierInUseParams{Kind: identifier.Kind, Value: identifier.Value})
		if err != nil {
			return err
		}
		if inUse {
			return conflict("identifier_in_use", "An identifier is already assigned to a fill")
		}
		if _, err = q.AddFilamentSpoolIdentifier(ctx, machinelogbookdb.AddFilamentSpoolIdentifierParams{ID: newID(), SpoolID: spoolID, FillID: fillID, Kind: identifier.Kind, Value: identifier.Value}); err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23505" {
				return conflict("identifier_in_use", "An identifier is already assigned to a fill")
			}
			return databaseError(err)
		}
	}
	return nil
}

// ListInventorySuggestions returns the distinct values in use for article and
// receipt forms, most frequent first. Variants can be limited to one type.
func (s *Service) ListInventorySuggestions(ctx context.Context, p authorization.Principal, materialTypeID *uuid.UUID) (InventorySuggestions, error) {
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
