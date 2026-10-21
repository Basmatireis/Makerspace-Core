package machinelogbook

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/optional"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"
)

func validUnit(unit MaterialUnit) bool {
	return unit == UnitGram || unit == UnitMeter || unit == UnitMilliliter || unit == UnitSquareMeter ||
		unit == UnitSquareCentimeter || unit == UnitPiece
}
func stockState(quantity decimal.Decimal, threshold pgtype.Numeric) StockState {
	if quantity.IsZero() {
		return StockEmpty
	}
	if threshold.Valid && quantity.LessThanOrEqual(decimalFromNumeric(threshold)) {
		return StockLow
	}
	return StockInStock
}

func materialFromGet(row machinelogbookdb.GetMaterialRow) Material {
	q := decimalFromNumeric(row.Quantity)
	assigned := decimalFromNumeric(row.AssignedQuantity)
	return Material{
		ID:                 row.ID,
		Name:               row.Name,
		Kind:               MaterialKind(row.MaterialKind),
		Variant:            row.Variant,
		Manufacturer:       row.Manufacturer,
		SalePrice:          nullableDecimal(row.SalePrice),
		PackageSize:        nullableDecimal(row.PackageSize),
		StorageLocation:    row.StorageLocation,
		Notes:              row.Notes,
		MaterialTypeID:     row.MaterialTypeID,
		MaterialTypeName:   row.MaterialTypeName,
		ColorName:          row.ColorName,
		ColorHex:           row.ColorHex,
		Unit:               row.Unit,
		Active:             row.Active,
		Deletable:          row.Deletable,
		LowStockThreshold:  nullableDecimal(row.LowStockThreshold),
		FilamentDiameterMM: nullableDecimal(row.DiameterMm),
		Quantity:           q.String(),
		AssignedQuantity:   assigned.String(),
		UnassignedQuantity: q.Sub(assigned).String(),
		InventoryValue:     decimalString(row.InventoryValue),
		AverageUnitCost:    decimalString(row.AverageUnitCost),
		RecentConsumption:  decimalString(row.RecentConsumption),
		StockState:         stockState(q, row.LowStockThreshold),
		Version:            row.Version,
		InventoryVersion:   row.InventoryVersion,
		CreatedAt:          row.CreatedAt,
		UpdatedAt:          row.UpdatedAt,
	}
}
func materialFromList(row machinelogbookdb.ListMaterialsRow) Material {
	return materialFromGet(machinelogbookdb.GetMaterialRow(row))
}

// MaterialInput is the editable part of an article. Unit is optional: the unit
// always is the unit of the material type, and a different value is refused.
// An empty Name is generated for filament and consumables.
type MaterialInput struct {
	Name                                          string
	MaterialTypeID                                uuid.UUID
	Unit                                          *string
	ColorName, ColorHex                           *string
	Variant, Manufacturer, StorageLocation, Notes *string
	SalePrice, PackageSize                        *string
	LowStockThreshold                             *string
	FilamentDiameterMM                            *string
	Active                                        bool
	ExpectedVersion                               int64
}

type validatedMaterial struct {
	name                                          string
	colorName, colorHex                           *string
	variant, manufacturer, storageLocation, notes *string
	threshold, salePrice, packageSize             pgtype.Numeric
}

// Length limits of the article fields, matching the database checks.
const (
	maxArticleNameLength     = 150
	maxVariantLength         = 80
	maxManufacturerLength    = 150
	maxStorageLocationLength = 200
	maxArticleNotesLength    = 2000
	maxPurchaseReference     = 200
)

// defaultFilamentDiameter is the diameter of a filament article that does not
// name one.
const defaultFilamentDiameter = "1.75"

// maxFilamentDiameterMM bounds the filament diameter in millimetres.
const maxFilamentDiameterMM = 10

func validateMaterial(in MaterialInput) (validatedMaterial, error) {
	var v validatedMaterial
	var err error
	v.name = strings.TrimSpace(in.Name)
	if utf8.RuneCountInString(v.name) > maxArticleNameLength {
		return v, apperror.Invalid("name is limited to 150 characters")
	}
	if in.MaterialTypeID == uuid.Nil {
		return v, apperror.Invalid("materialTypeId is required")
	}
	if v.colorName, v.colorHex, err = validateColor(in.ColorName, in.ColorHex); err != nil {
		return v, err
	}
	if v.variant, err = validateOptionalText(in.Variant, "variant", maxVariantLength); err != nil {
		return v, err
	}
	if v.manufacturer, err = validateOptionalText(in.Manufacturer, "manufacturer", maxManufacturerLength); err != nil {
		return v, err
	}
	if v.storageLocation, err = validateOptionalText(
		in.StorageLocation,
		"storageLocation",
		maxStorageLocationLength,
	); err != nil {
		return v, err
	}
	if v.notes, err = validateOptionalText(in.Notes, "notes", maxArticleNotesLength); err != nil {
		return v, err
	}
	if v.threshold, err = pgNullableNumeric(in.LowStockThreshold, false); err != nil {
		return v, err
	}
	if v.threshold.Valid && decimalFromNumeric(v.threshold).IsNegative() {
		return v, apperror.Invalid("lowStockThreshold must be non-negative")
	}
	if v.salePrice, err = pgNullableNumeric(in.SalePrice, false); err != nil {
		return v, err
	}
	if v.salePrice.Valid && decimalFromNumeric(v.salePrice).IsNegative() {
		return v, apperror.Invalid("salePrice must be non-negative")
	}
	if v.packageSize, err = pgNullableNumeric(in.PackageSize, true); err != nil {
		return v, apperror.Invalid("packageSize must be positive")
	}
	return v, nil
}

// articleName is the name entered by staff or, for filament and consumables,
// "<Type> <Variant> · <Colour> · <Manufacturer>" without the missing parts.
func articleName(kind MaterialKind, typeName string, v validatedMaterial) (string, error) {
	name := v.name
	if name == "" {
		if kind == KindPart {
			return "", apperror.Invalid("name is required for parts")
		}
		head := typeName
		if v.variant != nil {
			head += " " + *v.variant
		}
		parts := []string{head}
		if v.colorName != nil {
			parts = append(parts, *v.colorName)
		}
		if v.manufacturer != nil {
			parts = append(parts, *v.manufacturer)
		}
		name = strings.Join(parts, " · ")
	}
	if utf8.RuneCountInString(name) > maxArticleNameLength {
		return "", apperror.Invalid("the article name is limited to 150 characters")
	}
	return name, nil
}

func materialNameTaken(id uuid.UUID) error {
	e := apperror.Conflicting("material_name_conflict", "An article with this name already exists")
	if id != uuid.Nil {
		e.Details["materialId"] = id.String()
	}
	return e
}

// ensureMaterialNameFree refuses a name another article already uses (ignoring
// case) and points at that article.
func ensureMaterialNameFree(ctx context.Context, q *machinelogbookdb.Queries, name string, self uuid.UUID) error {
	id, err := q.FindMaterialByName(ctx, name)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if id == self {
		return nil
	}
	return materialNameTaken(id)
}

func materialWriteError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "materials_name_ci_idx" {
		return materialNameTaken(uuid.Nil)
	}
	return databaseError(err)
}

// resolveDiameter decides the stored filament diameter: filament articles
// always have one (1.75 mm by default), other kinds none. An unchanged diameter
// of a legacy non-filament article is tolerated and dropped.
func resolveDiameter(kind MaterialKind, requested, legacy *string) (pgtype.Numeric, error) {
	if kind != KindFilament {
		if requested == nil {
			return pgtype.Numeric{}, nil
		}
		given, err := parseDecimal(*requested, true)
		if err != nil || legacy == nil || !given.Equal(decimal.RequireFromString(*legacy)) {
			return pgtype.Numeric{}, apperror.Invalid("filamentDiameterMm is only valid for filament articles")
		}
		return pgtype.Numeric{}, nil
	}
	value := defaultFilamentDiameter
	if requested != nil {
		value = *requested
	}
	diameter, err := parseDecimal(value, true)
	if err != nil || diameter.GreaterThan(decimal.NewFromInt(maxFilamentDiameterMM)) {
		return pgtype.Numeric{}, apperror.Invalid("filamentDiameterMm must be positive and at most 10")
	}
	return numericFromDecimal(diameter), nil
}

// materialUnit is the unit of the type; an explicitly given other unit is refused.
func materialUnit(materialType machinelogbookdb.MaterialType, requested *string) (string, error) {
	if requested != nil && *requested != materialType.Unit {
		return "", apperror.New(
			http.StatusUnprocessableEntity,
			"material_unit_mismatch",
			"The material unit must equal the unit of its material type",
		)
	}
	return materialType.Unit, nil
}

func (s *Service) GetMaterial(ctx context.Context, p authorization.Principal, id uuid.UUID) (Material, error) {
	if err := require(p, authorization.InventoryRead); err != nil {
		return Material{}, err
	}
	row, err := machinelogbookdb.New(s.pool).GetMaterial(ctx, id)
	if err != nil {
		return Material{}, noRows(err)
	}
	return materialFromGet(row), nil
}

func (s *Service) ListMaterials(
	ctx context.Context,
	p authorization.Principal,
	search string,
	materialTypeID *uuid.UUID,
	kind MaterialKind,
	state StockState,
	page, pageSize int,
) ([]Material, int64, string, error) {
	if err := require(p, authorization.InventoryRead); err != nil {
		return nil, 0, "", err
	}
	offset, limit, err := pageBounds(page, pageSize)
	if err != nil {
		return nil, 0, "", err
	}
	if state != "" && state != StockEmpty && state != StockLow && state != StockInStock {
		return nil, 0, "", apperror.Invalid("invalid stock state")
	}
	if kind != "" && !validMaterialKind(kind) {
		return nil, 0, "", apperror.Invalid("invalid material kind")
	}
	q := machinelogbookdb.New(s.pool)
	params := machinelogbookdb.ListMaterialsParams{
		Search:         strings.TrimSpace(search),
		MaterialTypeID: materialTypeID,
		Kind:           string(kind),
		StockState:     string(state),
		PageOffset:     offset,
		PageLimit:      limit,
	}
	rows, err := q.ListMaterials(ctx, params)
	if err != nil {
		return nil, 0, "", err
	}
	total, err := q.CountMaterials(
		ctx,
		machinelogbookdb.CountMaterialsParams{
			Search:         params.Search,
			MaterialTypeID: params.MaterialTypeID,
			Kind:           params.Kind,
			StockState:     params.StockState,
		},
	)
	if err != nil {
		return nil, 0, "", err
	}
	value, err := q.TotalInventoryValue(ctx)
	if err != nil {
		return nil, 0, "", err
	}
	items := make([]Material, 0, len(rows))
	for _, row := range rows {
		items = append(items, materialFromList(row))
	}
	return items, total, decimalString(value), nil
}

func (s *Service) CreateMaterial(
	ctx context.Context,
	p authorization.Principal,
	in MaterialInput,
	requestID *uuid.UUID,
) (Material, error) {
	if err := require(p, authorization.InventoryManage); err != nil {
		return Material{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Material{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	id, err := s.createMaterialTx(ctx, tx, p, in, requestID)
	if err != nil {
		return Material{}, err
	}
	row, err := machinelogbookdb.New(tx).GetMaterial(ctx, id)
	if err != nil {
		return Material{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Material{}, err
	}
	return materialFromGet(row), nil
}

// createMaterialTx creates an article with its balance inside the caller's
// transaction. The caller checked the permission.
func (s *Service) createMaterialTx(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	in MaterialInput,
	requestID *uuid.UUID,
) (uuid.UUID, error) {
	v, err := validateMaterial(in)
	if err != nil {
		return uuid.Nil, err
	}
	q := machinelogbookdb.New(tx)
	materialType, err := resolveMaterialType(ctx, q, in.MaterialTypeID, true)
	if err != nil {
		return uuid.Nil, err
	}
	unit, err := materialUnit(materialType, in.Unit)
	if err != nil {
		return uuid.Nil, err
	}
	kind := MaterialKind(materialType.Kind)
	name, err := articleName(kind, materialType.Name, v)
	if err != nil {
		return uuid.Nil, err
	}
	diameter, err := resolveDiameter(kind, in.FilamentDiameterMM, nil)
	if err != nil {
		return uuid.Nil, err
	}
	if err = ensureMaterialNameFree(ctx, q, name, uuid.Nil); err != nil {
		return uuid.Nil, err
	}
	id := ids.New()
	_, err = q.CreateMaterial(
		ctx,
		machinelogbookdb.CreateMaterialParams{
			ID:                id,
			Name:              name,
			MaterialTypeID:    materialType.ID,
			ColorName:         v.colorName,
			ColorHex:          v.colorHex,
			Unit:              unit,
			LowStockThreshold: v.threshold,
			Variant:           v.variant,
			Manufacturer:      v.manufacturer,
			SalePrice:         v.salePrice,
			PackageSize:       v.packageSize,
			StorageLocation:   v.storageLocation,
			Notes:             v.notes,
		},
	)
	if err != nil {
		return uuid.Nil, materialWriteError(err)
	}
	if _, err = q.CreateMaterialBalance(ctx, id); err != nil {
		return uuid.Nil, err
	}
	if diameter.Valid {
		if _, err = q.UpsertMaterialFilamentProperties(
			ctx,
			machinelogbookdb.UpsertMaterialFilamentPropertiesParams{MaterialID: id, DiameterMm: diameter},
		); err != nil {
			return uuid.Nil, err
		}
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"material.created",
		"material",
		id,
		requestID,
		[]string{
			"name", "materialTypeId", "colorName", "colorHex", "unit", "lowStockThreshold",
			"variant", "manufacturer", "salePrice", "packageSize", "storageLocation", "notes",
		},
	); err != nil {
		return uuid.Nil, err
	}
	return id, nil
}

func (s *Service) UpdateMaterial(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	in MaterialInput,
	requestID *uuid.UUID,
) (Material, error) {
	if err := require(p, authorization.InventoryManage); err != nil {
		return Material{}, err
	}
	if in.ExpectedVersion < 1 {
		return Material{}, apperror.Invalid("expectedVersion must be positive")
	}
	v, err := validateMaterial(in)
	if err != nil {
		return Material{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Material{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	current, err := q.GetMaterialForUpdate(ctx, id)
	if err != nil {
		return Material{}, noRows(err)
	}
	if current.Version != in.ExpectedVersion {
		return Material{}, apperror.StaleWrite
	}
	// A deactivated type stays valid for the materials that already use it.
	materialType, err := resolveMaterialType(ctx, q, in.MaterialTypeID, in.MaterialTypeID != current.MaterialTypeID)
	if err != nil {
		return Material{}, err
	}
	if in.MaterialTypeID != current.MaterialTypeID {
		oldType, typeErr := resolveMaterialType(ctx, q, current.MaterialTypeID, false)
		if typeErr != nil {
			return Material{}, typeErr
		}
		if oldType.Kind != materialType.Kind {
			return Material{}, apperror.Conflicting(
				"material_kind_change",
				"An article cannot move to a material type of another kind",
			)
		}
	}
	unit, err := materialUnit(materialType, in.Unit)
	if err != nil {
		return Material{}, err
	}
	if current.Unit != unit && !decimalFromNumeric(current.Quantity).IsZero() {
		return Material{}, apperror.Conflicting(
			"material_unit_in_use",
			"Material unit cannot change while stock exists",
		)
	}
	if current.Unit != unit {
		fillCount, fillErr := q.CountMaterialFills(ctx, id)
		if fillErr != nil {
			return Material{}, fillErr
		}
		if fillCount > 0 {
			return Material{}, apperror.Conflicting(
				"material_unit_in_use",
				"Material unit cannot change while filament spools exist",
			)
		}
	}
	kind := MaterialKind(materialType.Kind)
	name, err := articleName(kind, materialType.Name, v)
	if err != nil {
		return Material{}, err
	}
	detail, err := q.GetMaterial(ctx, id)
	if err != nil {
		return Material{}, err
	}
	diameter, err := resolveDiameter(kind, in.FilamentDiameterMM, nullableDecimal(detail.DiameterMm))
	if err != nil {
		return Material{}, err
	}
	if err = ensureMaterialNameFree(ctx, q, name, id); err != nil {
		return Material{}, err
	}
	_, err = q.UpdateMaterial(
		ctx,
		machinelogbookdb.UpdateMaterialParams{
			Name:              name,
			MaterialTypeID:    materialType.ID,
			ColorName:         v.colorName,
			ColorHex:          v.colorHex,
			Unit:              unit,
			Active:            in.Active,
			LowStockThreshold: v.threshold,
			Variant:           v.variant,
			Manufacturer:      v.manufacturer,
			SalePrice:         v.salePrice,
			PackageSize:       v.packageSize,
			StorageLocation:   v.storageLocation,
			Notes:             v.notes,
			ID:                id,
			ExpectedVersion:   in.ExpectedVersion,
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Material{}, apperror.StaleWrite
	}
	if err != nil {
		return Material{}, materialWriteError(err)
	}
	if diameter.Valid {
		if _, err = q.UpsertMaterialFilamentProperties(
			ctx,
			machinelogbookdb.UpsertMaterialFilamentPropertiesParams{MaterialID: id, DiameterMm: diameter},
		); err != nil {
			return Material{}, err
		}
	} else if err = q.DeleteMaterialFilamentProperties(ctx, id); err != nil {
		return Material{}, err
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"material.updated",
		"material",
		id,
		requestID,
		[]string{
			"name", "materialTypeId", "colorName", "colorHex", "unit", "active", "lowStockThreshold",
			"variant", "manufacturer", "salePrice", "packageSize", "storageLocation", "notes",
		},
	); err != nil {
		return Material{}, err
	}
	row, err := q.GetMaterial(ctx, id)
	if err != nil {
		return Material{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Material{}, err
	}
	return materialFromGet(row), nil
}

func transactionFromRow(row machinelogbookdb.InventoryTransaction) InventoryTransaction {
	return InventoryTransaction{
		ID:                  row.ID,
		MaterialID:          row.MaterialID,
		Kind:                InventoryKind(row.Kind),
		QuantityDelta:       decimalString(row.QuantityDelta),
		UnitAcquisitionCost: decimalString(row.UnitAcquisitionCost),
		InventoryValueDelta: decimalString(row.InventoryValueDelta),
		TotalPurchasePrice:  nullableDecimal(row.TotalPurchasePrice),
		OccurredAt:          row.OccurredAt,
		Supplier:            row.Supplier,
		Note:                row.Note,
		AdjustmentReason:    row.AdjustmentReason,
		Reference:           row.PurchaseReference,
		SpoolID:             row.SpoolID,
		SpoolDisplayID:      row.SpoolDisplayID,
		FillNumber:          row.FillNumber,
		FromSpoolID:         row.FromSpoolID,
		FromSpoolDisplayID:  row.FromSpoolDisplayID,
		FromFillNumber:      row.FromFillNumber,
		ToSpoolID:           row.ToSpoolID,
		ToSpoolDisplayID:    row.ToSpoolDisplayID,
		ToFillNumber:        row.ToFillNumber,
		TransferQuantity:    nullableDecimal(row.TransferQuantity),
		CreatedAt:           row.CreatedAt,
	}
}
func transactionFromList(row machinelogbookdb.ListInventoryTransactionsRow) InventoryTransaction {
	item := transactionFromRow(
		machinelogbookdb.InventoryTransaction{
			ID:                  row.ID,
			MaterialID:          row.MaterialID,
			Kind:                row.Kind,
			QuantityDelta:       row.QuantityDelta,
			UnitAcquisitionCost: row.UnitAcquisitionCost,
			InventoryValueDelta: row.InventoryValueDelta,
			TotalPurchasePrice:  row.TotalPurchasePrice,
			OccurredAt:          row.OccurredAt,
			Supplier:            row.Supplier,
			Note:                row.Note,
			AdjustmentReason:    row.AdjustmentReason,
			PurchaseReference:   row.PurchaseReference,
			SpoolID:             row.SpoolID,
			SpoolDisplayID:      row.SpoolDisplayID,
			FillNumber:          row.FillNumber,
			FromSpoolID:         row.FromSpoolID,
			FromSpoolDisplayID:  row.FromSpoolDisplayID,
			FromFillNumber:      row.FromFillNumber,
			ToSpoolID:           row.ToSpoolID,
			ToSpoolDisplayID:    row.ToSpoolDisplayID,
			ToFillNumber:        row.ToFillNumber,
			TransferQuantity:    row.TransferQuantity,
			CreatedAt:           row.CreatedAt,
		},
	)
	item.MachineJobID, item.MachineJobDisplayID = row.MachineJobID, row.MachineJobDisplayID
	item.OrderID, item.OrderReference = row.OrderID, row.OrderReference
	if row.ActorFirstName != nil && row.ActorLastName != nil {
		name := *row.ActorFirstName + " " + *row.ActorLastName
		item.ActorName = &name
	}
	return item
}

func (s *Service) ListMaterialTransactions(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	page, pageSize int,
) ([]InventoryTransaction, int64, error) {
	if err := require(p, authorization.InventoryRead); err != nil {
		return nil, 0, err
	}
	offset, limit, err := pageBounds(page, pageSize)
	if err != nil {
		return nil, 0, err
	}
	q := machinelogbookdb.New(s.pool)
	if _, err = q.GetMaterial(ctx, id); err != nil {
		return nil, 0, noRows(err)
	}
	rows, err := q.ListInventoryTransactions(
		ctx,
		machinelogbookdb.ListInventoryTransactionsParams{MaterialID: id, PageOffset: offset, PageLimit: limit},
	)
	if err != nil {
		return nil, 0, err
	}
	total, err := q.CountInventoryTransactions(ctx, id)
	if err != nil {
		return nil, 0, err
	}
	items := make([]InventoryTransaction, 0, len(rows))
	for _, row := range rows {
		items = append(items, transactionFromList(row))
	}
	return items, total, nil
}

// anyInventoryVersion skips the optimistic inventory-version check. Compound
// operations that already hold the balance lock use it for their follow-up
// ledger rows.
const anyInventoryVersion int64 = -1

type inventoryMutation struct {
	Kind                                InventoryKind
	QuantityDelta, UnitCost, ValueDelta decimal.Decimal
	TotalPrice                          *decimal.Decimal
	OccurredAt                          time.Time
	Supplier, Note, Reason              *string
	// Reference is the order or invoice number of a purchase.
	Reference *string
	// SkipAudit leaves the per-movement audit event out; compound operations
	// such as stock receipts write their own single event.
	SkipAudit bool
	UsageID   *uuid.UUID
	// OrderItemID attributes an order sale or its reversal to the sold item.
	OrderItemID *uuid.UUID
	// Fill attributes the movement to a spool's open fill.
	Fill *fillRef
	// KeepSpoolVersion leaves the spool version alone; the caller bumps it once.
	KeepSpoolVersion bool
}

func (s *Service) applyInventoryMutation(
	ctx context.Context,
	tx pgx.Tx,
	q *machinelogbookdb.Queries,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	m inventoryMutation,
	requestID *uuid.UUID,
) (InventoryMutationResult, error) {
	current, err := q.GetMaterialForUpdate(ctx, id)
	if err != nil {
		return InventoryMutationResult{}, noRows(err)
	}
	if expected != anyInventoryVersion && current.InventoryVersion != expected {
		return InventoryMutationResult{}, apperror.StaleWrite
	}
	expected = current.InventoryVersion
	oldQuantity := decimalFromNumeric(current.Quantity)
	oldValue := decimalFromNumeric(current.InventoryValue)
	newQuantity := oldQuantity.Add(m.QuantityDelta)
	newValue := oldValue.Add(m.ValueDelta)
	if newQuantity.IsNegative() {
		return InventoryMutationResult{}, apperror.Conflicting("insufficient_stock", "Inventory would become negative")
	}
	var spoolVersion int64
	if m.Fill != nil {
		spool, spoolErr := q.GetFilamentSpoolForUpdate(ctx, m.Fill.SpoolID)
		if spoolErr != nil {
			return InventoryMutationResult{}, noRows(spoolErr)
		}
		fill, fillErr := q.GetFilamentSpoolFill(ctx, m.Fill.FillID)
		if fillErr != nil {
			return InventoryMutationResult{}, noRows(fillErr)
		}
		if fill.MaterialID != id {
			return InventoryMutationResult{}, apperror.Conflicting(
				"spool_material_mismatch",
				"Spool does not belong to the selected material",
			)
		}
		if fill.ClosedAt.Valid {
			return InventoryMutationResult{}, apperror.Conflicting("spool_not_consumable", "The spool has no open fill")
		}
		if decimalFromNumeric(fill.RemainingQuantity).Add(m.QuantityDelta).IsNegative() {
			return InventoryMutationResult{}, apperror.Conflicting(
				"insufficient_spool_stock",
				"Spool inventory would become negative",
			)
		}
		spoolVersion = spool.Version
	} else if m.QuantityDelta.IsNegative() {
		allocated, allocationErr := q.AllocatedMaterialQuantity(ctx, id)
		if allocationErr != nil {
			return InventoryMutationResult{}, allocationErr
		}
		if newQuantity.LessThan(decimalFromNumeric(allocated)) {
			return InventoryMutationResult{}, apperror.Conflicting(
				"insufficient_unassigned_stock",
				"Unassigned material inventory would become negative",
			)
		}
	}
	if newValue.IsNegative() {
		if newValue.Abs().LessThan(decimal.RequireFromString("0.000000001")) {
			newValue = decimal.Zero
		} else {
			return InventoryMutationResult{}, apperror.Conflicting(
				"invalid_inventory_value",
				"Inventory value would become negative",
			)
		}
	}
	average := decimalFromNumeric(current.AverageUnitCost)
	if newQuantity.IsPositive() {
		average = newValue.Div(newQuantity)
	}
	balance, err := q.UpdateMaterialBalance(
		ctx,
		machinelogbookdb.UpdateMaterialBalanceParams{
			Quantity:        numericFromDecimal(newQuantity),
			InventoryValue:  numericFromDecimal(newValue),
			AverageUnitCost: numericFromDecimal(average),
			MaterialID:      id,
			ExpectedVersion: expected,
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return InventoryMutationResult{}, apperror.StaleWrite
	}
	if err != nil {
		return InventoryMutationResult{}, err
	}
	total := pgtype.Numeric{}
	if m.TotalPrice != nil {
		total = numericFromDecimal(*m.TotalPrice)
	}
	actor := accountPointer(p)
	var ledger machinelogbookdb.InventoryTransaction
	if m.Fill != nil {
		ledger, err = q.InsertSpoolInventoryTransaction(
			ctx,
			machinelogbookdb.InsertSpoolInventoryTransactionParams{
				ID:                  ids.New(),
				MaterialID:          id,
				Kind:                string(m.Kind),
				QuantityDelta:       numericFromDecimal(m.QuantityDelta),
				UnitAcquisitionCost: numericFromDecimal(m.UnitCost),
				InventoryValueDelta: numericFromDecimal(m.ValueDelta),
				TotalPurchasePrice:  total,
				OccurredAt:          m.OccurredAt.UTC(),
				Supplier:            optional.Trimmed(m.Supplier),
				Note:                optional.Trimmed(m.Note),
				AdjustmentReason:    m.Reason,
				RunUsageID:          m.UsageID,
				ActorAccountID:      actor,
				PurchaseReference:   optional.Trimmed(m.Reference),
				SpoolID:             &m.Fill.SpoolID,
				FillID:              &m.Fill.FillID,
				SpoolDisplayID:      &m.Fill.SpoolDisplayID,
				FillNumber:          &m.Fill.FillNumber,
			},
		)
	} else {
		ledger, err = q.InsertInventoryTransaction(
			ctx,
			machinelogbookdb.InsertInventoryTransactionParams{
				ID:                  ids.New(),
				MaterialID:          id,
				Kind:                string(m.Kind),
				QuantityDelta:       numericFromDecimal(m.QuantityDelta),
				UnitAcquisitionCost: numericFromDecimal(m.UnitCost),
				InventoryValueDelta: numericFromDecimal(m.ValueDelta),
				TotalPurchasePrice:  total,
				OccurredAt:          m.OccurredAt.UTC(),
				Supplier:            optional.Trimmed(m.Supplier),
				Note:                optional.Trimmed(m.Note),
				AdjustmentReason:    m.Reason,
				RunUsageID:          m.UsageID,
				ActorAccountID:      actor,
				PurchaseReference:   optional.Trimmed(m.Reference),
				OrderItemID:         m.OrderItemID,
			},
		)
	}
	if err != nil {
		return InventoryMutationResult{}, databaseError(err)
	}
	if m.Fill != nil && !m.KeepSpoolVersion {
		if _, err = q.BumpFilamentSpoolVersion(
			ctx,
			machinelogbookdb.BumpFilamentSpoolVersionParams{ID: m.Fill.SpoolID, ExpectedVersion: spoolVersion},
		); err != nil {
			return InventoryMutationResult{}, err
		}
	}
	if !m.SkipAudit {
		if err = writeAudit(
			ctx,
			tx,
			p,
			"inventory."+string(m.Kind),
			"material",
			id,
			requestID,
			[]string{"quantity", "inventoryValue", "inventoryVersion"},
		); err != nil {
			return InventoryMutationResult{}, err
		}
	}
	row, err := q.GetMaterial(ctx, id)
	if err != nil {
		return InventoryMutationResult{}, err
	}
	material := materialFromGet(row)
	material.InventoryVersion = balance.Version
	return InventoryMutationResult{Material: material, Transaction: transactionFromRow(ledger)}, nil
}

func (s *Service) AddPurchase(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	quantity, totalPrice string,
	occurredAt time.Time,
	supplier, reference, note *string,
	requestID *uuid.UUID,
) (InventoryMutationResult, error) {
	if err := require(p, authorization.InventoryManage); err != nil {
		return InventoryMutationResult{}, err
	}
	qty, err := parseDecimal(quantity, true)
	if err != nil {
		return InventoryMutationResult{}, err
	}
	price, err := parseDecimal(totalPrice, false)
	if err != nil || price.IsNegative() {
		return InventoryMutationResult{}, apperror.Invalid("totalPrice must be non-negative")
	}
	if occurredAt.IsZero() {
		return InventoryMutationResult{}, apperror.Invalid("occurredAt is required")
	}
	reference, err = validateOptionalText(reference, "reference", maxPurchaseReference)
	if err != nil {
		return InventoryMutationResult{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return InventoryMutationResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	result, err := s.applyInventoryMutation(
		ctx,
		tx,
		machinelogbookdb.New(tx),
		p,
		id,
		expected,
		inventoryMutation{
			Kind:          InventoryPurchase,
			QuantityDelta: qty,
			UnitCost:      price.Div(qty),
			ValueDelta:    price,
			TotalPrice:    &price,
			OccurredAt:    occurredAt,
			Supplier:      supplier,
			Reference:     reference,
			Note:          note,
		},
		requestID,
	)
	if err != nil {
		return InventoryMutationResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return InventoryMutationResult{}, err
	}
	return result, nil
}

func (s *Service) RecordConsumption(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	quantity string,
	occurredAt time.Time,
	disposal bool,
	reason, note *string,
	requestID *uuid.UUID,
) (InventoryMutationResult, error) {
	if err := require(p, authorization.InventoryManage); err != nil {
		return InventoryMutationResult{}, err
	}
	qty, err := parseDecimal(quantity, true)
	if err != nil {
		return InventoryMutationResult{}, err
	}
	if occurredAt.IsZero() {
		return InventoryMutationResult{}, apperror.Invalid("occurredAt is required")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return InventoryMutationResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	current, err := q.GetMaterialForUpdate(ctx, id)
	if err != nil {
		return InventoryMutationResult{}, noRows(err)
	}
	if current.InventoryVersion != expected {
		return InventoryMutationResult{}, apperror.StaleWrite
	}
	average := decimalFromNumeric(current.AverageUnitCost)
	kind := InventoryManualConsumption
	if disposal {
		kind = InventoryDisposal
	}
	result, err := s.applyInventoryMutation(
		ctx,
		tx,
		q,
		p,
		id,
		expected,
		inventoryMutation{
			Kind:          kind,
			QuantityDelta: qty.Neg(),
			UnitCost:      average,
			ValueDelta:    qty.Mul(average).Neg(),
			OccurredAt:    occurredAt,
			Reason:        optional.Trimmed(reason),
			Note:          note,
		},
		requestID,
	)
	if err != nil {
		return InventoryMutationResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return InventoryMutationResult{}, err
	}
	return result, nil
}

func (s *Service) CorrectStock(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	physicalQuantity string,
	acquisitionUnitCost *string,
	occurredAt time.Time,
	reason string,
	note *string,
	requestID *uuid.UUID,
) (InventoryMutationResult, error) {
	if err := require(p, authorization.InventoryManage); err != nil {
		return InventoryMutationResult{}, err
	}
	physical, err := parseDecimal(physicalQuantity, false)
	if err != nil || physical.IsNegative() {
		return InventoryMutationResult{}, apperror.Invalid("physicalQuantity must be non-negative")
	}
	if occurredAt.IsZero() {
		return InventoryMutationResult{}, apperror.Invalid("occurredAt is required")
	}
	reason = strings.TrimSpace(reason)
	if reason == "" {
		return InventoryMutationResult{}, apperror.Invalid("reason is required")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return InventoryMutationResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	current, err := q.GetMaterialForUpdate(ctx, id)
	if err != nil {
		return InventoryMutationResult{}, noRows(err)
	}
	if current.InventoryVersion != expected {
		return InventoryMutationResult{}, apperror.StaleWrite
	}
	old := decimalFromNumeric(current.Quantity)
	delta := physical.Sub(old)
	if delta.IsZero() {
		return InventoryMutationResult{}, apperror.Invalid("physicalQuantity equals current stock")
	}
	average := decimalFromNumeric(current.AverageUnitCost)
	unitCost := average
	if delta.IsPositive() && average.IsZero() {
		if acquisitionUnitCost == nil {
			return InventoryMutationResult{}, apperror.Invalid(
				"acquisitionUnitCost is required for positive stock without an average cost",
			)
		}
		unitCost, err = parseDecimal(*acquisitionUnitCost, false)
		if err != nil || unitCost.IsNegative() {
			return InventoryMutationResult{}, apperror.Invalid("acquisitionUnitCost must be non-negative")
		}
	}
	valueDelta := delta.Mul(unitCost)
	result, err := s.applyInventoryMutation(
		ctx,
		tx,
		q,
		p,
		id,
		expected,
		inventoryMutation{
			Kind:          InventoryAdjustment,
			QuantityDelta: delta,
			UnitCost:      unitCost,
			ValueDelta:    valueDelta,
			OccurredAt:    occurredAt,
			Reason:        &reason,
			Note:          note,
		},
		requestID,
	)
	if err != nil {
		return InventoryMutationResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return InventoryMutationResult{}, err
	}
	return result, nil
}

func (s *Service) MarkEmpty(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	occurredAt time.Time,
	note *string,
	requestID *uuid.UUID,
) (InventoryMutationResult, error) {
	if err := require(p, authorization.InventoryManage); err != nil {
		return InventoryMutationResult{}, err
	}
	if occurredAt.IsZero() {
		return InventoryMutationResult{}, apperror.Invalid("occurredAt is required")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return InventoryMutationResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := machinelogbookdb.New(tx)
	current, err := q.GetMaterialForUpdate(ctx, id)
	if err != nil {
		return InventoryMutationResult{}, noRows(err)
	}
	if current.InventoryVersion != expected {
		return InventoryMutationResult{}, apperror.StaleWrite
	}
	qty := decimalFromNumeric(current.Quantity)
	if qty.IsZero() {
		return InventoryMutationResult{}, apperror.Invalid("material is already empty")
	}
	value := decimalFromNumeric(current.InventoryValue)
	average := decimalFromNumeric(current.AverageUnitCost)
	reason := "mark_empty"
	result, err := s.applyInventoryMutation(
		ctx,
		tx,
		q,
		p,
		id,
		expected,
		inventoryMutation{
			Kind:          InventoryAdjustment,
			QuantityDelta: qty.Neg(),
			UnitCost:      average,
			ValueDelta:    value.Neg(),
			OccurredAt:    occurredAt,
			Reason:        &reason,
			Note:          note,
		},
		requestID,
	)
	if err != nil {
		return InventoryMutationResult{}, err
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"inventory.mark_empty",
		"material",
		id,
		requestID,
		[]string{"quantity", "inventoryValue", "inventoryVersion"},
	); err != nil {
		return InventoryMutationResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return InventoryMutationResult{}, err
	}
	return result, nil
}
