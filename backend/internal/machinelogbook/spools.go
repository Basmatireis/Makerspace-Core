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
	"github.com/jackc/pgx/v5/pgtype"
)

func spoolDate(value pgtype.Date) *time.Time {
	if !value.Valid {
		return nil
	}
	v := value.Time
	return &v
}

func pgDate(value *time.Time) pgtype.Date {
	if value == nil {
		return pgtype.Date{}
	}
	return pgtype.Date{Time: value.UTC(), Valid: true}
}

func spoolFromGet(row machinelogbookdb.GetFilamentSpoolRow) FilamentSpool {
	return FilamentSpool{ID: row.ID, DisplayID: row.DisplayID, MaterialID: row.MaterialID, MaterialName: row.MaterialName,
		Category: row.Category, Color: row.Color, Unit: row.Unit, Manufacturer: row.Manufacturer, ProductName: row.ProductName,
		InitialNetWeightG: decimalString(row.InitialNetWeightG), RemainingQuantity: decimalString(row.RemainingQuantity),
		TareWeightG: nullableDecimal(row.TareWeightG), AcquiredOn: spoolDate(row.AcquiredOn), AcquisitionReference: row.AcquisitionReference,
		StorageLocation: row.StorageLocation, Notes: row.Notes, Lifecycle: row.Lifecycle, Mounted: row.Mounted,
		Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
}

func spoolFromList(row machinelogbookdb.ListFilamentSpoolsRow) FilamentSpool {
	return FilamentSpool{ID: row.ID, DisplayID: row.DisplayID, MaterialID: row.MaterialID, MaterialName: row.MaterialName,
		Category: row.Category, Color: row.Color, Unit: row.Unit, Manufacturer: row.Manufacturer, ProductName: row.ProductName,
		InitialNetWeightG: decimalString(row.InitialNetWeightG), RemainingQuantity: decimalString(row.RemainingQuantity),
		TareWeightG: nullableDecimal(row.TareWeightG), AcquiredOn: spoolDate(row.AcquiredOn), AcquisitionReference: row.AcquisitionReference,
		StorageLocation: row.StorageLocation, Notes: row.Notes, Lifecycle: row.Lifecycle, Mounted: row.Mounted,
		Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
}

func identifierFromRow(row machinelogbookdb.FilamentSpoolIdentifier) FilamentSpoolIdentifier {
	return FilamentSpoolIdentifier{ID: row.ID, Kind: row.Kind, Value: row.Value, CreatedAt: row.CreatedAt}
}

func (s *Service) loadSpool(ctx context.Context, q *machinelogbookdb.Queries, id uuid.UUID) (FilamentSpool, error) {
	row, err := q.GetFilamentSpool(ctx, id)
	if err != nil {
		return FilamentSpool{}, noRows(err)
	}
	item := spoolFromGet(row)
	identifiers, err := q.ListFilamentSpoolIdentifiers(ctx, id)
	if err != nil {
		return FilamentSpool{}, err
	}
	item.Identifiers = make([]FilamentSpoolIdentifier, 0, len(identifiers))
	for _, identifier := range identifiers {
		item.Identifiers = append(item.Identifiers, identifierFromRow(identifier))
	}
	return item, nil
}

func (s *Service) GetFilamentSpool(ctx context.Context, p authorization.Principal, id uuid.UUID) (FilamentSpool, error) {
	if err := require(p, authorization.InventoryRead); err != nil {
		return FilamentSpool{}, err
	}
	return s.loadSpool(ctx, machinelogbookdb.New(s.pool), id)
}

func (s *Service) ListFilamentSpools(ctx context.Context, p authorization.Principal, search string, materialID *uuid.UUID, lifecycle, location string, page, pageSize int) ([]FilamentSpool, int64, error) {
	if err := require(p, authorization.InventoryRead); err != nil {
		return nil, 0, err
	}
	if lifecycle != "" && lifecycle != "active" && lifecycle != "retired" {
		return nil, 0, validation("invalid spool lifecycle")
	}
	offset, limit, err := pageBounds(page, pageSize)
	if err != nil {
		return nil, 0, err
	}
	q := machinelogbookdb.New(s.pool)
	params := machinelogbookdb.ListFilamentSpoolsParams{Search: strings.TrimSpace(search), MaterialID: materialID, Lifecycle: lifecycle, Location: strings.TrimSpace(location), PageOffset: offset, PageLimit: limit}
	rows, err := q.ListFilamentSpools(ctx, params)
	if err != nil {
		return nil, 0, err
	}
	total, err := q.CountFilamentSpools(ctx, machinelogbookdb.CountFilamentSpoolsParams{Search: params.Search, MaterialID: materialID, Lifecycle: lifecycle, Location: params.Location})
	if err != nil {
		return nil, 0, err
	}
	items := make([]FilamentSpool, 0, len(rows))
	for _, row := range rows {
		item := spoolFromList(row)
		identifiers, listErr := q.ListFilamentSpoolIdentifiers(ctx, item.ID)
		if listErr != nil {
			return nil, 0, listErr
		}
		item.Identifiers = make([]FilamentSpoolIdentifier, 0, len(identifiers))
		for _, identifier := range identifiers {
			item.Identifiers = append(item.Identifiers, identifierFromRow(identifier))
		}
		items = append(items, item)
	}
	return items, total, nil
}

func (s *Service) LookupFilamentSpool(ctx context.Context, p authorization.Principal, kind, value string) (FilamentSpool, error) {
	if err := require(p, authorization.InventoryRead); err != nil {
		return FilamentSpool{}, err
	}
	if kind != "barcode" && kind != "qr" && kind != "nfc" {
		return FilamentSpool{}, validation("invalid identifier kind")
	}
	id, err := machinelogbookdb.New(s.pool).FindFilamentSpoolByIdentifier(ctx, machinelogbookdb.FindFilamentSpoolByIdentifierParams{Kind: kind, Value: strings.TrimSpace(value)})
	if err != nil {
		return FilamentSpool{}, noRows(err)
	}
	return s.loadSpool(ctx, machinelogbookdb.New(s.pool), id)
}

func (s *Service) CreateFilamentSpool(ctx context.Context, p authorization.Principal, input FilamentSpoolInput, requestID *uuid.UUID) (FilamentSpool, error) {
	if err := require(p, authorization.FilamentSpoolsManage); err != nil {
		return FilamentSpool{}, err
	}
	if err := require(p, authorization.InventoryManage); err != nil {
		return FilamentSpool{}, err
	}
	weight, err := parseDecimal(input.InitialNetWeightG, true)
	if err != nil {
		return FilamentSpool{}, err
	}
	if input.StockMode != "new_acquisition" && input.StockMode != "existing_stock" {
		return FilamentSpool{}, validation("invalid stockMode")
	}
	if input.OccurredAt.IsZero() || input.ExpectedInventoryVersion < 1 {
		return FilamentSpool{}, validation("occurredAt and expectedInventoryVersion are required")
	}
	tare, err := pgNullableNumeric(input.TareWeightG, false)
	if err != nil || (tare.Valid && decimalFromNumeric(tare).IsNegative()) {
		return FilamentSpool{}, validation("tareWeightG must be non-negative")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return FilamentSpool{}, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	material, err := q.GetMaterialForUpdate(ctx, input.MaterialID)
	if err != nil {
		return FilamentSpool{}, noRows(err)
	}
	if material.InventoryVersion != input.ExpectedInventoryVersion {
		return FilamentSpool{}, apperror.StaleWrite
	}
	detail, err := q.GetMaterial(ctx, input.MaterialID)
	if err != nil {
		return FilamentSpool{}, err
	}
	if detail.Unit != "g" || !detail.DiameterMm.Valid {
		return FilamentSpool{}, conflict("material_not_filament", "Spools require a gram-denominated material with filament properties")
	}
	sequence, err := q.NextFilamentSpoolSequence(ctx)
	if err != nil {
		return FilamentSpool{}, err
	}
	id := newID()
	_, err = q.CreateFilamentSpool(ctx, machinelogbookdb.CreateFilamentSpoolParams{ID: id, DisplayID: fmt.Sprintf("S-%04d-%06d", time.Now().UTC().Year(), sequence), MaterialID: input.MaterialID,
		Manufacturer: cleanOptional(input.Manufacturer), ProductName: cleanOptional(input.ProductName), InitialNetWeightG: numericFromDecimal(weight), TareWeightG: tare,
		AcquiredOn: pgDate(input.AcquiredOn), AcquisitionReference: cleanOptional(input.AcquisitionReference), StorageLocation: cleanOptional(input.StorageLocation), Notes: cleanOptional(input.Notes)})
	if err != nil {
		return FilamentSpool{}, databaseError(err)
	}
	if input.StockMode == "new_acquisition" {
		if input.TotalPrice == nil {
			return FilamentSpool{}, validation("totalPrice is required for a new acquisition")
		}
		price, parseErr := parseDecimal(*input.TotalPrice, false)
		if parseErr != nil || price.IsNegative() {
			return FilamentSpool{}, validation("totalPrice must be non-negative")
		}
		_, err = s.applyInventoryMutation(ctx, tx, q, p, input.MaterialID, input.ExpectedInventoryVersion, inventoryMutation{Kind: "purchase", QuantityDelta: weight, UnitCost: price.Div(weight), ValueDelta: price, TotalPrice: &price, OccurredAt: input.OccurredAt, Note: input.Notes, SpoolID: &id}, requestID)
	} else {
		unassigned := decimalFromNumeric(material.Quantity).Sub(decimalFromNumeric(detail.AssignedQuantity))
		if unassigned.LessThan(weight) {
			return FilamentSpool{}, conflict("insufficient_unassigned_stock", "Not enough unassigned material stock")
		}
		if _, err = q.UpdateMaterialBalance(ctx, machinelogbookdb.UpdateMaterialBalanceParams{Quantity: material.Quantity, InventoryValue: material.InventoryValue, AverageUnitCost: material.AverageUnitCost, MaterialID: input.MaterialID, ExpectedVersion: input.ExpectedInventoryVersion}); err == nil {
			actor := p.AccountID
			_, err = q.InsertSpoolTransfer(ctx, machinelogbookdb.InsertSpoolTransferParams{ID: newID(), MaterialID: input.MaterialID, OccurredAt: input.OccurredAt.UTC(), Note: cleanOptional(input.Notes), ActorAccountID: &actor, ToSpoolID: &id, TransferQuantity: numericFromDecimal(weight)})
		}
		if err == nil {
			_, err = q.BumpFilamentSpoolVersion(ctx, machinelogbookdb.BumpFilamentSpoolVersionParams{ID: id, ExpectedVersion: 1})
		}
	}
	if err != nil {
		return FilamentSpool{}, databaseError(err)
	}
	if err = writeAudit(ctx, tx, p, "filament_spool.created", "filament_spool", id, requestID, []string{"materialId", "stockMode", "inventory", "metadata"}); err != nil {
		return FilamentSpool{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return FilamentSpool{}, err
	}
	return s.loadSpool(ctx, machinelogbookdb.New(s.pool), id)
}

func (s *Service) UpdateFilamentSpool(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, manufacturer, productName, tareWeight *string, acquiredOn *time.Time, acquisitionReference, location, notes *string, lifecycle string, requestID *uuid.UUID) (FilamentSpool, error) {
	if err := require(p, authorization.FilamentSpoolsManage); err != nil {
		return FilamentSpool{}, err
	}
	if expected < 1 || (lifecycle != "active" && lifecycle != "retired") {
		return FilamentSpool{}, validation("invalid spool update")
	}
	tare, err := pgNullableNumeric(tareWeight, false)
	if err != nil || (tare.Valid && decimalFromNumeric(tare).IsNegative()) {
		return FilamentSpool{}, validation("tareWeightG must be non-negative")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return FilamentSpool{}, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	current, err := q.GetFilamentSpoolForUpdate(ctx, id)
	if err != nil {
		return FilamentSpool{}, noRows(err)
	}
	if current.Version != expected {
		return FilamentSpool{}, apperror.StaleWrite
	}
	if lifecycle == "retired" {
		if !decimalFromNumeric(current.RemainingQuantity).IsZero() {
			return FilamentSpool{}, conflict("spool_has_stock", "A spool must be empty before retirement")
		}
		mounted, mountedErr := q.FilamentSpoolMounted(ctx, id)
		if mountedErr != nil {
			return FilamentSpool{}, mountedErr
		}
		if mounted {
			return FilamentSpool{}, conflict("spool_mounted", "A mounted spool cannot be retired")
		}
	}
	_, err = q.UpdateFilamentSpool(ctx, machinelogbookdb.UpdateFilamentSpoolParams{Manufacturer: cleanOptional(manufacturer), ProductName: cleanOptional(productName), TareWeightG: tare, AcquiredOn: pgDate(acquiredOn), AcquisitionReference: cleanOptional(acquisitionReference), StorageLocation: cleanOptional(location), Notes: cleanOptional(notes), Lifecycle: lifecycle, ID: id, ExpectedVersion: expected})
	if errors.Is(err, pgx.ErrNoRows) {
		return FilamentSpool{}, apperror.StaleWrite
	}
	if err != nil {
		return FilamentSpool{}, databaseError(err)
	}
	if err = writeAudit(ctx, tx, p, "filament_spool.updated", "filament_spool", id, requestID, []string{"manufacturer", "productName", "tareWeightG", "storageLocation", "lifecycle"}); err != nil {
		return FilamentSpool{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return FilamentSpool{}, err
	}
	return s.loadSpool(ctx, machinelogbookdb.New(s.pool), id)
}

func (s *Service) AddFilamentSpoolIdentifier(ctx context.Context, p authorization.Principal, spoolID uuid.UUID, kind, value string, requestID *uuid.UUID) (FilamentSpoolIdentifier, error) {
	if err := require(p, authorization.FilamentSpoolsManage); err != nil {
		return FilamentSpoolIdentifier{}, err
	}
	value = strings.TrimSpace(value)
	if (kind != "barcode" && kind != "qr" && kind != "nfc") || value == "" || len(value) > 255 {
		return FilamentSpoolIdentifier{}, validation("invalid spool identifier")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return FilamentSpoolIdentifier{}, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	if _, err = q.GetFilamentSpoolForUpdate(ctx, spoolID); err != nil {
		return FilamentSpoolIdentifier{}, noRows(err)
	}
	row, err := q.AddFilamentSpoolIdentifier(ctx, machinelogbookdb.AddFilamentSpoolIdentifierParams{ID: newID(), SpoolID: spoolID, Kind: kind, Value: value})
	if err != nil {
		return FilamentSpoolIdentifier{}, databaseError(err)
	}
	if err = writeAudit(ctx, tx, p, "filament_spool.identifier_added", "filament_spool", spoolID, requestID, []string{"identifiers"}); err != nil {
		return FilamentSpoolIdentifier{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return FilamentSpoolIdentifier{}, err
	}
	return identifierFromRow(row), nil
}

func (s *Service) DeleteFilamentSpoolIdentifier(ctx context.Context, p authorization.Principal, spoolID, identifierID uuid.UUID, requestID *uuid.UUID) error {
	if err := require(p, authorization.FilamentSpoolsManage); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	rows, err := q.DeleteFilamentSpoolIdentifier(ctx, machinelogbookdb.DeleteFilamentSpoolIdentifierParams{ID: identifierID, SpoolID: spoolID})
	if err != nil {
		return err
	}
	if rows == 0 {
		return apperror.NotFound
	}
	if err = writeAudit(ctx, tx, p, "filament_spool.identifier_removed", "filament_spool", spoolID, requestID, []string{"identifiers"}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) TransferSpoolStock(ctx context.Context, p authorization.Principal, materialID uuid.UUID, expected int64, fromID, toID *uuid.UUID, quantity string, occurredAt time.Time, note *string, requestID *uuid.UUID) (InventoryTransaction, error) {
	if err := require(p, authorization.InventoryManage); err != nil {
		return InventoryTransaction{}, err
	}
	qty, err := parseDecimal(quantity, true)
	if err != nil {
		return InventoryTransaction{}, err
	}
	if (fromID == nil && toID == nil) || (fromID != nil && toID != nil && *fromID == *toID) || occurredAt.IsZero() {
		return InventoryTransaction{}, validation("invalid spool transfer")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return InventoryTransaction{}, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	material, err := q.GetMaterialForUpdate(ctx, materialID)
	if err != nil {
		return InventoryTransaction{}, noRows(err)
	}
	if material.InventoryVersion != expected {
		return InventoryTransaction{}, apperror.StaleWrite
	}
	detail, err := q.GetMaterial(ctx, materialID)
	if err != nil {
		return InventoryTransaction{}, err
	}
	versions := map[uuid.UUID]int64{}
	for _, spoolID := range []*uuid.UUID{fromID, toID} {
		if spoolID == nil {
			continue
		}
		spool, spoolErr := q.GetFilamentSpoolForUpdate(ctx, *spoolID)
		if spoolErr != nil {
			return InventoryTransaction{}, noRows(spoolErr)
		}
		if spool.MaterialID != materialID {
			return InventoryTransaction{}, conflict("spool_material_mismatch", "Spools must belong to the selected material")
		}
		versions[*spoolID] = spool.Version
		if fromID != nil && *spoolID == *fromID && decimalFromNumeric(spool.RemainingQuantity).LessThan(qty) {
			return InventoryTransaction{}, conflict("insufficient_spool_stock", "Source spool does not contain enough stock")
		}
	}
	if fromID == nil && decimalFromNumeric(material.Quantity).Sub(decimalFromNumeric(detail.AssignedQuantity)).LessThan(qty) {
		return InventoryTransaction{}, conflict("insufficient_unassigned_stock", "Not enough unassigned stock")
	}
	if _, err = q.UpdateMaterialBalance(ctx, machinelogbookdb.UpdateMaterialBalanceParams{Quantity: material.Quantity, InventoryValue: material.InventoryValue, AverageUnitCost: material.AverageUnitCost, MaterialID: materialID, ExpectedVersion: expected}); err != nil {
		return InventoryTransaction{}, err
	}
	actor := p.AccountID
	row, err := q.InsertSpoolTransfer(ctx, machinelogbookdb.InsertSpoolTransferParams{ID: newID(), MaterialID: materialID, OccurredAt: occurredAt.UTC(), Note: cleanOptional(note), ActorAccountID: &actor, FromSpoolID: fromID, ToSpoolID: toID, TransferQuantity: numericFromDecimal(qty)})
	if err != nil {
		return InventoryTransaction{}, databaseError(err)
	}
	for id, version := range versions {
		if _, err = q.BumpFilamentSpoolVersion(ctx, machinelogbookdb.BumpFilamentSpoolVersionParams{ID: id, ExpectedVersion: version}); err != nil {
			return InventoryTransaction{}, err
		}
	}
	if err = writeAudit(ctx, tx, p, "inventory.spool_transfer", "material", materialID, requestID, []string{"attribution", "inventoryVersion"}); err != nil {
		return InventoryTransaction{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return InventoryTransaction{}, err
	}
	return transactionFromRow(row), nil
}

func (s *Service) ConsumeFilamentSpool(ctx context.Context, p authorization.Principal, spoolID uuid.UUID, expectedInventory, expectedSpool int64, quantity string, occurredAt time.Time, disposal bool, reason, note *string, requestID *uuid.UUID) (InventoryMutationResult, error) {
	if err := require(p, authorization.InventoryManage); err != nil {
		return InventoryMutationResult{}, err
	}
	qty, err := parseDecimal(quantity, true)
	if err != nil || occurredAt.IsZero() {
		return InventoryMutationResult{}, validation("valid quantity and occurredAt are required")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return InventoryMutationResult{}, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	spool, err := q.GetFilamentSpoolForUpdate(ctx, spoolID)
	if err != nil {
		return InventoryMutationResult{}, noRows(err)
	}
	if spool.Version != expectedSpool {
		return InventoryMutationResult{}, apperror.StaleWrite
	}
	material, err := q.GetMaterialForUpdate(ctx, spool.MaterialID)
	if err != nil {
		return InventoryMutationResult{}, err
	}
	if material.InventoryVersion != expectedInventory {
		return InventoryMutationResult{}, apperror.StaleWrite
	}
	kind := "manual_consumption"
	if disposal {
		kind = "disposal"
	}
	average := decimalFromNumeric(material.AverageUnitCost)
	result, err := s.applyInventoryMutation(ctx, tx, q, p, spool.MaterialID, expectedInventory, inventoryMutation{Kind: kind, QuantityDelta: qty.Neg(), UnitCost: average, ValueDelta: qty.Mul(average).Neg(), OccurredAt: occurredAt, Reason: cleanOptional(reason), Note: note, SpoolID: &spoolID}, requestID)
	if err != nil {
		return InventoryMutationResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return InventoryMutationResult{}, err
	}
	return result, nil
}

func (s *Service) CorrectFilamentSpoolStock(ctx context.Context, p authorization.Principal, spoolID uuid.UUID, expectedInventory, expectedSpool int64, physical string, acquisitionCost *string, occurredAt time.Time, reason string, note *string, requestID *uuid.UUID) (InventoryMutationResult, error) {
	if err := require(p, authorization.InventoryManage); err != nil {
		return InventoryMutationResult{}, err
	}
	physicalQty, err := parseDecimal(physical, false)
	if err != nil || physicalQty.IsNegative() || strings.TrimSpace(reason) == "" || occurredAt.IsZero() {
		return InventoryMutationResult{}, validation("invalid spool correction")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return InventoryMutationResult{}, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	spool, err := q.GetFilamentSpoolForUpdate(ctx, spoolID)
	if err != nil {
		return InventoryMutationResult{}, noRows(err)
	}
	if spool.Version != expectedSpool {
		return InventoryMutationResult{}, apperror.StaleWrite
	}
	material, err := q.GetMaterialForUpdate(ctx, spool.MaterialID)
	if err != nil {
		return InventoryMutationResult{}, err
	}
	if material.InventoryVersion != expectedInventory {
		return InventoryMutationResult{}, apperror.StaleWrite
	}
	delta := physicalQty.Sub(decimalFromNumeric(spool.RemainingQuantity))
	if delta.IsZero() {
		return InventoryMutationResult{}, validation("physicalQuantity equals current spool stock")
	}
	unitCost := decimalFromNumeric(material.AverageUnitCost)
	if delta.IsPositive() && unitCost.IsZero() {
		if acquisitionCost == nil {
			return InventoryMutationResult{}, validation("acquisitionUnitCost is required without an average cost")
		}
		unitCost, err = parseDecimal(*acquisitionCost, false)
		if err != nil || unitCost.IsNegative() {
			return InventoryMutationResult{}, validation("invalid acquisitionUnitCost")
		}
	}
	reason = strings.TrimSpace(reason)
	result, err := s.applyInventoryMutation(ctx, tx, q, p, spool.MaterialID, expectedInventory, inventoryMutation{Kind: "adjustment", QuantityDelta: delta, UnitCost: unitCost, ValueDelta: delta.Mul(unitCost), OccurredAt: occurredAt, Reason: &reason, Note: note, SpoolID: &spoolID}, requestID)
	if err != nil {
		return InventoryMutationResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return InventoryMutationResult{}, err
	}
	return result, nil
}

func transactionFromSpoolList(row machinelogbookdb.ListFilamentSpoolTransactionsRow) InventoryTransaction {
	return InventoryTransaction{ID: row.ID, MaterialID: row.MaterialID, Kind: row.Kind, QuantityDelta: decimalString(row.QuantityDelta), UnitAcquisitionCost: decimalString(row.UnitAcquisitionCost), InventoryValueDelta: decimalString(row.InventoryValueDelta), TotalPurchasePrice: nullableDecimal(row.TotalPurchasePrice), OccurredAt: row.OccurredAt, Supplier: row.Supplier, Note: row.Note, AdjustmentReason: row.AdjustmentReason, MachineJobID: row.MachineJobID, MachineJobDisplayID: row.MachineJobDisplayID, SpoolID: row.SpoolID, FromSpoolID: row.FromSpoolID, ToSpoolID: row.ToSpoolID, TransferQuantity: nullableDecimal(row.TransferQuantity), CreatedAt: row.CreatedAt}
}

func (s *Service) ListFilamentSpoolTransactions(ctx context.Context, p authorization.Principal, id uuid.UUID, page, pageSize int) ([]InventoryTransaction, int64, error) {
	if err := require(p, authorization.InventoryRead); err != nil {
		return nil, 0, err
	}
	offset, limit, err := pageBounds(page, pageSize)
	if err != nil {
		return nil, 0, err
	}
	q := machinelogbookdb.New(s.pool)
	if _, err = q.GetFilamentSpool(ctx, id); err != nil {
		return nil, 0, noRows(err)
	}
	rows, err := q.ListFilamentSpoolTransactions(ctx, machinelogbookdb.ListFilamentSpoolTransactionsParams{SpoolID: &id, PageOffset: offset, PageLimit: limit})
	if err != nil {
		return nil, 0, err
	}
	total, err := q.CountFilamentSpoolTransactions(ctx, &id)
	if err != nil {
		return nil, 0, err
	}
	items := make([]InventoryTransaction, 0, len(rows))
	for _, row := range rows {
		items = append(items, transactionFromSpoolList(row))
	}
	return items, total, nil
}
