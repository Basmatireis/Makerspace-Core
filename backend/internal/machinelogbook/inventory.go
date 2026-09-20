package machinelogbook

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/shopspring/decimal"
)

func validUnit(unit string) bool {
	return unit == "g" || unit == "m" || unit == "ml" || unit == "m2" || unit == "piece"
}
func stockState(quantity decimal.Decimal, threshold pgtype.Numeric) string {
	if quantity.IsZero() {
		return "empty"
	}
	if threshold.Valid && quantity.LessThanOrEqual(decimalFromNumeric(threshold)) {
		return "low_stock"
	}
	return "in_stock"
}

func materialFromGet(row machinelogbookdb.GetMaterialRow) Material {
	q := decimalFromNumeric(row.Quantity)
	return Material{ID: row.ID, Name: row.Name, Category: row.Category, Color: row.Color, Unit: row.Unit, Active: row.Active, LowStockThreshold: nullableDecimal(row.LowStockThreshold), Quantity: q.String(), InventoryValue: decimalString(row.InventoryValue), AverageUnitCost: decimalString(row.AverageUnitCost), RecentConsumption: decimalString(row.RecentConsumption), StockState: stockState(q, row.LowStockThreshold), Version: row.Version, InventoryVersion: row.InventoryVersion, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
}
func materialFromList(row machinelogbookdb.ListMaterialsRow) Material {
	q := decimalFromNumeric(row.Quantity)
	return Material{ID: row.ID, Name: row.Name, Category: row.Category, Color: row.Color, Unit: row.Unit, Active: row.Active, LowStockThreshold: nullableDecimal(row.LowStockThreshold), Quantity: q.String(), InventoryValue: decimalString(row.InventoryValue), AverageUnitCost: decimalString(row.AverageUnitCost), RecentConsumption: decimalString(row.RecentConsumption), StockState: stockState(q, row.LowStockThreshold), Version: row.Version, InventoryVersion: row.InventoryVersion, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
}

func validateMaterial(name, category, unit string, threshold *string) (string, string, pgtype.Numeric, error) {
	var err error
	name, err = validateName(name)
	if err != nil {
		return "", "", pgtype.Numeric{}, err
	}
	category = strings.ToLower(strings.TrimSpace(category))
	if category == "" || len(category) > 100 {
		return "", "", pgtype.Numeric{}, validation("category is required and limited to 100 characters")
	}
	if !validUnit(unit) {
		return "", "", pgtype.Numeric{}, validation("invalid material unit")
	}
	numeric, err := pgNullableNumeric(threshold, false)
	if err != nil {
		return "", "", pgtype.Numeric{}, err
	}
	if numeric.Valid && decimalFromNumeric(numeric).IsNegative() {
		return "", "", pgtype.Numeric{}, validation("lowStockThreshold must be non-negative")
	}
	return name, category, numeric, nil
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
func (s *Service) ListMaterials(ctx context.Context, p authorization.Principal, search, category, state string, page, pageSize int) ([]Material, int64, string, error) {
	if err := require(p, authorization.InventoryRead); err != nil {
		return nil, 0, "", err
	}
	offset, limit, err := pageBounds(page, pageSize)
	if err != nil {
		return nil, 0, "", err
	}
	if state != "" && state != "empty" && state != "low_stock" && state != "in_stock" {
		return nil, 0, "", validation("invalid stock state")
	}
	q := machinelogbookdb.New(s.pool)
	params := machinelogbookdb.ListMaterialsParams{Search: strings.TrimSpace(search), Category: strings.ToLower(strings.TrimSpace(category)), StockState: state, PageOffset: offset, PageLimit: limit}
	rows, err := q.ListMaterials(ctx, params)
	if err != nil {
		return nil, 0, "", err
	}
	total, err := q.CountMaterials(ctx, machinelogbookdb.CountMaterialsParams{Search: params.Search, Category: params.Category, StockState: params.StockState})
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

func (s *Service) CreateMaterial(ctx context.Context, p authorization.Principal, name, category string, color *string, unit string, threshold *string, requestID *uuid.UUID) (Material, error) {
	if err := require(p, authorization.InventoryManage); err != nil {
		return Material{}, err
	}
	name, category, numeric, err := validateMaterial(name, category, unit, threshold)
	if err != nil {
		return Material{}, err
	}
	color = cleanOptional(color)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Material{}, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	id := newID()
	_, err = q.CreateMaterial(ctx, machinelogbookdb.CreateMaterialParams{ID: id, Name: name, Category: category, Color: color, Unit: unit, LowStockThreshold: numeric})
	if err != nil {
		return Material{}, databaseError(err)
	}
	if _, err = q.CreateMaterialBalance(ctx, id); err != nil {
		return Material{}, err
	}
	if err = writeAudit(ctx, tx, p, "material.created", "material", id, requestID, []string{"name", "category", "color", "unit", "lowStockThreshold"}); err != nil {
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

func (s *Service) UpdateMaterial(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, name, category string, color *string, unit string, active bool, threshold *string, requestID *uuid.UUID) (Material, error) {
	if err := require(p, authorization.InventoryManage); err != nil {
		return Material{}, err
	}
	if expected < 1 {
		return Material{}, validation("expectedVersion must be positive")
	}
	name, category, numeric, err := validateMaterial(name, category, unit, threshold)
	if err != nil {
		return Material{}, err
	}
	color = cleanOptional(color)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Material{}, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	current, err := q.GetMaterialForUpdate(ctx, id)
	if err != nil {
		return Material{}, noRows(err)
	}
	if current.Version != expected {
		return Material{}, apperror.StaleWrite
	}
	if current.Unit != unit && !decimalFromNumeric(current.Quantity).IsZero() {
		return Material{}, conflict("material_unit_in_use", "Material unit cannot change while stock exists")
	}
	_, err = q.UpdateMaterial(ctx, machinelogbookdb.UpdateMaterialParams{Name: name, Category: category, Color: color, Unit: unit, Active: active, LowStockThreshold: numeric, ID: id, ExpectedVersion: expected})
	if errors.Is(err, pgx.ErrNoRows) {
		return Material{}, apperror.StaleWrite
	}
	if err != nil {
		return Material{}, databaseError(err)
	}
	if err = writeAudit(ctx, tx, p, "material.updated", "material", id, requestID, []string{"name", "category", "color", "unit", "active", "lowStockThreshold"}); err != nil {
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
	return InventoryTransaction{ID: row.ID, MaterialID: row.MaterialID, Kind: row.Kind, QuantityDelta: decimalString(row.QuantityDelta), UnitAcquisitionCost: decimalString(row.UnitAcquisitionCost), InventoryValueDelta: decimalString(row.InventoryValueDelta), TotalPurchasePrice: nullableDecimal(row.TotalPurchasePrice), OccurredAt: row.OccurredAt, Supplier: row.Supplier, Note: row.Note, AdjustmentReason: row.AdjustmentReason, CreatedAt: row.CreatedAt}
}
func transactionFromList(row machinelogbookdb.ListInventoryTransactionsRow) InventoryTransaction {
	return InventoryTransaction{ID: row.ID, MaterialID: row.MaterialID, Kind: row.Kind, QuantityDelta: decimalString(row.QuantityDelta), UnitAcquisitionCost: decimalString(row.UnitAcquisitionCost), InventoryValueDelta: decimalString(row.InventoryValueDelta), TotalPurchasePrice: nullableDecimal(row.TotalPurchasePrice), OccurredAt: row.OccurredAt, Supplier: row.Supplier, Note: row.Note, AdjustmentReason: row.AdjustmentReason, MachineJobID: row.MachineJobID, MachineJobDisplayID: row.MachineJobDisplayID, CreatedAt: row.CreatedAt}
}

func (s *Service) ListMaterialTransactions(ctx context.Context, p authorization.Principal, id uuid.UUID, page, pageSize int) ([]InventoryTransaction, int64, error) {
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
	rows, err := q.ListInventoryTransactions(ctx, machinelogbookdb.ListInventoryTransactionsParams{MaterialID: id, PageOffset: offset, PageLimit: limit})
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

type inventoryMutation struct {
	Kind                                string
	QuantityDelta, UnitCost, ValueDelta decimal.Decimal
	TotalPrice                          *decimal.Decimal
	OccurredAt                          time.Time
	Supplier, Note, Reason              *string
	UsageID                             *uuid.UUID
}

func (s *Service) applyInventoryMutation(ctx context.Context, tx pgx.Tx, q *machinelogbookdb.Queries, p authorization.Principal, id uuid.UUID, expected int64, m inventoryMutation, requestID *uuid.UUID) (InventoryMutationResult, error) {
	current, err := q.GetMaterialForUpdate(ctx, id)
	if err != nil {
		return InventoryMutationResult{}, noRows(err)
	}
	if current.InventoryVersion != expected {
		return InventoryMutationResult{}, apperror.StaleWrite
	}
	oldQuantity := decimalFromNumeric(current.Quantity)
	oldValue := decimalFromNumeric(current.InventoryValue)
	newQuantity := oldQuantity.Add(m.QuantityDelta)
	newValue := oldValue.Add(m.ValueDelta)
	if newQuantity.IsNegative() {
		return InventoryMutationResult{}, conflict("insufficient_stock", "Inventory would become negative")
	}
	if newValue.IsNegative() {
		if newValue.Abs().LessThan(decimal.RequireFromString("0.000000001")) {
			newValue = decimal.Zero
		} else {
			return InventoryMutationResult{}, conflict("invalid_inventory_value", "Inventory value would become negative")
		}
	}
	average := decimalFromNumeric(current.AverageUnitCost)
	if newQuantity.IsPositive() {
		average = newValue.Div(newQuantity)
	}
	balance, err := q.UpdateMaterialBalance(ctx, machinelogbookdb.UpdateMaterialBalanceParams{Quantity: numericFromDecimal(newQuantity), InventoryValue: numericFromDecimal(newValue), AverageUnitCost: numericFromDecimal(average), MaterialID: id, ExpectedVersion: expected})
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
	actor := p.AccountID
	ledger, err := q.InsertInventoryTransaction(ctx, machinelogbookdb.InsertInventoryTransactionParams{ID: newID(), MaterialID: id, Kind: m.Kind, QuantityDelta: numericFromDecimal(m.QuantityDelta), UnitAcquisitionCost: numericFromDecimal(m.UnitCost), InventoryValueDelta: numericFromDecimal(m.ValueDelta), TotalPurchasePrice: total, OccurredAt: m.OccurredAt.UTC(), Supplier: cleanOptional(m.Supplier), Note: cleanOptional(m.Note), AdjustmentReason: m.Reason, MachineJobUsageID: m.UsageID, ActorAccountID: &actor})
	if err != nil {
		return InventoryMutationResult{}, databaseError(err)
	}
	action := "inventory." + m.Kind
	if err = writeAudit(ctx, tx, p, action, "material", id, requestID, []string{"quantity", "inventoryValue", "inventoryVersion"}); err != nil {
		return InventoryMutationResult{}, err
	}
	row, err := q.GetMaterial(ctx, id)
	if err != nil {
		return InventoryMutationResult{}, err
	}
	material := materialFromGet(row)
	material.InventoryVersion = balance.Version
	return InventoryMutationResult{Material: material, Transaction: transactionFromRow(ledger)}, nil
}

func (s *Service) AddPurchase(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, quantity, totalPrice string, occurredAt time.Time, supplier, note *string, requestID *uuid.UUID) (InventoryMutationResult, error) {
	if err := require(p, authorization.InventoryManage); err != nil {
		return InventoryMutationResult{}, err
	}
	qty, err := parseDecimal(quantity, true)
	if err != nil {
		return InventoryMutationResult{}, err
	}
	price, err := parseDecimal(totalPrice, false)
	if err != nil || price.IsNegative() {
		return InventoryMutationResult{}, validation("totalPrice must be non-negative")
	}
	if occurredAt.IsZero() {
		return InventoryMutationResult{}, validation("occurredAt is required")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return InventoryMutationResult{}, err
	}
	defer tx.Rollback(ctx)
	result, err := s.applyInventoryMutation(ctx, tx, machinelogbookdb.New(tx), p, id, expected, inventoryMutation{Kind: "purchase", QuantityDelta: qty, UnitCost: price.Div(qty), ValueDelta: price, TotalPrice: &price, OccurredAt: occurredAt, Supplier: supplier, Note: note}, requestID)
	if err != nil {
		return InventoryMutationResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return InventoryMutationResult{}, err
	}
	return result, nil
}

func (s *Service) RecordConsumption(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, quantity string, occurredAt time.Time, disposal bool, reason, note *string, requestID *uuid.UUID) (InventoryMutationResult, error) {
	if err := require(p, authorization.InventoryManage); err != nil {
		return InventoryMutationResult{}, err
	}
	qty, err := parseDecimal(quantity, true)
	if err != nil {
		return InventoryMutationResult{}, err
	}
	if occurredAt.IsZero() {
		return InventoryMutationResult{}, validation("occurredAt is required")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return InventoryMutationResult{}, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	current, err := q.GetMaterialForUpdate(ctx, id)
	if err != nil {
		return InventoryMutationResult{}, noRows(err)
	}
	if current.InventoryVersion != expected {
		return InventoryMutationResult{}, apperror.StaleWrite
	}
	average := decimalFromNumeric(current.AverageUnitCost)
	kind := "manual_consumption"
	if disposal {
		kind = "disposal"
	}
	result, err := s.applyInventoryMutation(ctx, tx, q, p, id, expected, inventoryMutation{Kind: kind, QuantityDelta: qty.Neg(), UnitCost: average, ValueDelta: qty.Mul(average).Neg(), OccurredAt: occurredAt, Reason: cleanOptional(reason), Note: note}, requestID)
	if err != nil {
		return InventoryMutationResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return InventoryMutationResult{}, err
	}
	return result, nil
}

func (s *Service) CorrectStock(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, physicalQuantity string, acquisitionUnitCost *string, occurredAt time.Time, reason string, note *string, requestID *uuid.UUID) (InventoryMutationResult, error) {
	if err := require(p, authorization.InventoryManage); err != nil {
		return InventoryMutationResult{}, err
	}
	physical, err := parseDecimal(physicalQuantity, false)
	if err != nil || physical.IsNegative() {
		return InventoryMutationResult{}, validation("physicalQuantity must be non-negative")
	}
	if occurredAt.IsZero() {
		return InventoryMutationResult{}, validation("occurredAt is required")
	}
	reason = strings.TrimSpace(reason)
	if reason == "" {
		return InventoryMutationResult{}, validation("reason is required")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return InventoryMutationResult{}, err
	}
	defer tx.Rollback(ctx)
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
		return InventoryMutationResult{}, validation("physicalQuantity equals current stock")
	}
	average := decimalFromNumeric(current.AverageUnitCost)
	unitCost := average
	if delta.IsPositive() && average.IsZero() {
		if acquisitionUnitCost == nil {
			return InventoryMutationResult{}, validation("acquisitionUnitCost is required for positive stock without an average cost")
		}
		unitCost, err = parseDecimal(*acquisitionUnitCost, false)
		if err != nil || unitCost.IsNegative() {
			return InventoryMutationResult{}, validation("acquisitionUnitCost must be non-negative")
		}
	}
	valueDelta := delta.Mul(unitCost)
	result, err := s.applyInventoryMutation(ctx, tx, q, p, id, expected, inventoryMutation{Kind: "adjustment", QuantityDelta: delta, UnitCost: unitCost, ValueDelta: valueDelta, OccurredAt: occurredAt, Reason: &reason, Note: note}, requestID)
	if err != nil {
		return InventoryMutationResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return InventoryMutationResult{}, err
	}
	return result, nil
}

func (s *Service) MarkEmpty(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, occurredAt time.Time, note *string, requestID *uuid.UUID) (InventoryMutationResult, error) {
	if err := require(p, authorization.InventoryManage); err != nil {
		return InventoryMutationResult{}, err
	}
	if occurredAt.IsZero() {
		return InventoryMutationResult{}, validation("occurredAt is required")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return InventoryMutationResult{}, err
	}
	defer tx.Rollback(ctx)
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
		return InventoryMutationResult{}, validation("material is already empty")
	}
	value := decimalFromNumeric(current.InventoryValue)
	average := decimalFromNumeric(current.AverageUnitCost)
	reason := "mark_empty"
	result, err := s.applyInventoryMutation(ctx, tx, q, p, id, expected, inventoryMutation{Kind: "adjustment", QuantityDelta: qty.Neg(), UnitCost: average, ValueDelta: value.Neg(), OccurredAt: occurredAt, Reason: &reason, Note: note}, requestID)
	if err != nil {
		return InventoryMutationResult{}, err
	}
	if err = writeAudit(ctx, tx, p, "inventory.mark_empty", "material", id, requestID, []string{"quantity", "inventoryValue", "inventoryVersion"}); err != nil {
		return InventoryMutationResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return InventoryMutationResult{}, err
	}
	return result, nil
}
