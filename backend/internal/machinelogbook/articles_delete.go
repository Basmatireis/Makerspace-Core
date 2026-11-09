package machinelogbook

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/database"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
)

// errMaterialInBin refuses work on an article in the inventory recycle bin.
var errMaterialInBin = apperror.Conflicting("material_in_bin", "The article is in the recycle bin; restore it first")

// MaterialUse names one kind of record that still points at an article.
type MaterialUse struct {
	Kind  string
	Label string
	Count int64
}

// materialUses lists the kinds of use in a stable order, skipping kinds without rows.
func materialUses(c machinelogbookdb.CountMaterialUsesRow) []MaterialUse {
	all := []MaterialUse{
		{"ledger_entries", "ledger entries", c.LedgerEntries},
		{"spools", "spools", c.Spools},
		{"run_usages", "machine run usages", c.RunUsages},
		{"reported_usages", "reported printer usages", c.ReportedUsages},
		{"order_items", "order items", c.OrderItems},
	}
	uses := make([]MaterialUse, 0, len(all))
	for _, use := range all {
		if use.Count > 0 {
			uses = append(uses, use)
		}
	}
	return uses
}

func materialInUse(uses []MaterialUse) error {
	labels := ""
	listed := make([]map[string]any, 0, len(uses))
	for i, use := range uses {
		if i > 0 {
			labels += ", "
		}
		labels += use.Label
		listed = append(listed, map[string]any{"kind": use.Kind, "count": use.Count})
	}
	err := apperror.Conflicting(
		"material_in_use",
		"This article is in use ("+labels+") and cannot be removed; deactivate it instead",
	)
	err.Details["uses"] = listed
	return err
}

// RemoveUnusedMaterialTx hard-deletes an article that nothing uses yet, inside the caller's transaction; the
// configuration import uses it. A used article answers 409 material_in_use with the uses in details.
func (s *Service) RemoveUnusedMaterialTx(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) error {
	if err := require(p, authorization.InventoryArticlesManage); err != nil {
		return err
	}
	if expected < 1 {
		return apperror.Invalid("expectedVersion must be positive")
	}
	q := machinelogbookdb.New(tx)
	current, err := q.GetMaterialForUpdate(ctx, id)
	if err != nil {
		return noRows(err)
	}
	if current.Version != expected {
		return apperror.StaleWrite
	}
	counts, err := q.CountMaterialUses(ctx, id)
	if err != nil {
		return fmt.Errorf("count uses of material %s: %w", id, err)
	}
	if uses := materialUses(counts); len(uses) > 0 {
		return materialInUse(uses)
	}
	rows, err := q.DeleteMaterial(ctx, machinelogbookdb.DeleteMaterialParams{ID: id, ExpectedVersion: expected})
	if err != nil {
		return databaseError(err)
	}
	if rows == 0 {
		return apperror.StaleWrite
	}
	return writeAudit(ctx, tx, p, "material.purged", "material", id, requestID, nil)
}

// DeleteMaterial moves an article into the inventory recycle bin. Its spools go with it (mounted ones are
// unmounted); stock, ledger and history stay until the article is purged.
func (s *Service) DeleteMaterial(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) error {
	if err := require(p, authorization.InventoryDelete); err != nil {
		return err
	}
	if expected < 1 {
		return apperror.Invalid("expectedVersion must be positive")
	}
	return database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := machinelogbookdb.New(tx)
		current, err := q.GetMaterialForUpdate(ctx, id)
		if err != nil {
			return noRows(err)
		}
		if current.DeletedAt.Valid {
			return apperror.NotFound
		}
		if current.Version != expected {
			return apperror.StaleWrite
		}
		now := s.now().UTC()
		if err = q.UnmountSpoolsOfMaterial(
			ctx,
			machinelogbookdb.UnmountSpoolsOfMaterialParams{
				UnmountedAt:    now,
				ActorAccountID: accountPointer(p),
				MaterialID:     id,
			},
		); err != nil {
			return err
		}
		if _, err = q.SoftDeleteMaterial(
			ctx,
			machinelogbookdb.SoftDeleteMaterialParams{
				DeletedAt:       pgTimestamp(now),
				DeletedBy:       accountPointer(p),
				ID:              id,
				ExpectedVersion: expected,
			},
		); errors.Is(err, pgx.ErrNoRows) {
			return apperror.StaleWrite
		} else if err != nil {
			return err
		}
		return writeAudit(ctx, tx, p, "material.deleted", "material", id, requestID, []string{"deletedAt", "spools"})
	})
}

// lockMaterialInBin locks an article that must be in the recycle bin at the expected version.
func lockMaterialInBin(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	id uuid.UUID,
	expected int64,
) (machinelogbookdb.GetMaterialForUpdateRow, error) {
	current, err := q.GetMaterialForUpdate(ctx, id)
	if err != nil {
		return current, noRows(err)
	}
	if !current.DeletedAt.Valid {
		return current, apperror.Conflicting("material_not_in_bin", "The article is not in the recycle bin")
	}
	if current.Version != expected {
		return current, apperror.StaleWrite
	}
	return current, nil
}

// RestoreMaterial brings an article back from the recycle bin with its spools, stock and ledger.
func (s *Service) RestoreMaterial(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) (Material, error) {
	if err := require(p, authorization.InventoryDelete); err != nil {
		return Material{}, err
	}
	if expected < 1 {
		return Material{}, apperror.Invalid("expectedVersion must be positive")
	}
	var result Material
	err := database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := machinelogbookdb.New(tx)
		if _, err := lockMaterialInBin(ctx, q, id, expected); err != nil {
			return err
		}
		if _, err := q.RestoreMaterial(
			ctx,
			machinelogbookdb.RestoreMaterialParams{ID: id, ExpectedVersion: expected},
		); err != nil {
			return databaseError(err)
		}
		if err := writeAudit(ctx, tx, p, "material.restored", "material", id, requestID, []string{"deletedAt"}); err != nil {
			return err
		}
		var err error
		result, err = s.loadMaterial(ctx, q, id)
		return err
	})
	return result, err
}

// PurgeMaterial deletes an article in the recycle bin for good: its balance, spools, stock_article rules and
// every ledger entry go with it. Run usages keep the article's name and unit; usages and order items lose the link.
func (s *Service) PurgeMaterial(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) error {
	if err := require(p, authorization.InventoryDelete); err != nil {
		return err
	}
	if expected < 1 {
		return apperror.Invalid("expectedVersion must be positive")
	}
	return database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := machinelogbookdb.New(tx)
		if _, err := lockMaterialInBin(ctx, q, id, expected); err != nil {
			return err
		}
		if err := q.SnapshotRunUsagesOfMaterial(ctx, &id); err != nil {
			return err
		}
		if err := q.EnableInventoryPurge(ctx); err != nil {
			return err
		}
		if _, err := q.PurgeMaterial(ctx, id); err != nil {
			return databaseError(err)
		}
		return writeAudit(ctx, tx, p, "material.purged", "material", id, requestID, nil)
	})
}

// DeletedMaterial is an article in the inventory recycle bin.
type DeletedMaterial struct {
	ID                                uuid.UUID
	DisplayID, Name, MaterialTypeName string
	Kind                              MaterialKind
	Unit, Quantity                    string
	SpoolCount                        int64
	DeletedAt                         time.Time
	DeletedByName                     *string
	Version                           int64
}

// DeletedInventoryTransaction is a ledger entry in the inventory recycle bin.
type DeletedInventoryTransaction struct {
	Transaction                   InventoryTransaction
	MaterialName, MaterialDisplay string
	Unit                          string
	DeletedAt                     time.Time
	DeletedByName                 *string
}

// InventoryRecycleBin holds deleted articles, retired spools and deleted ledger entries.
type InventoryRecycleBin struct {
	Materials     []DeletedMaterial
	Spools        []FilamentSpool
	LedgerEntries []DeletedInventoryTransaction
}

// GetInventoryRecycleBin lists the inventory recycle bin, newest first, at most 500 of each.
func (s *Service) GetInventoryRecycleBin(ctx context.Context, p authorization.Principal) (InventoryRecycleBin, error) {
	if err := require(p, authorization.InventoryRead); err != nil {
		return InventoryRecycleBin{}, err
	}
	q := machinelogbookdb.New(s.pool)
	bin := InventoryRecycleBin{
		Materials:     []DeletedMaterial{},
		Spools:        []FilamentSpool{},
		LedgerEntries: []DeletedInventoryTransaction{},
	}
	materials, err := q.ListDeletedMaterials(ctx)
	if err != nil {
		return bin, err
	}
	for _, row := range materials {
		bin.Materials = append(bin.Materials, DeletedMaterial{
			ID:               row.ID,
			DisplayID:        row.DisplayID,
			Name:             row.Name,
			MaterialTypeName: row.MaterialTypeName,
			Kind:             MaterialKind(row.MaterialKind),
			Unit:             row.Unit,
			Quantity:         decimalString(row.Quantity),
			SpoolCount:       row.SpoolCount,
			DeletedAt:        row.DeletedAt.Time,
			DeletedByName:    personName(row.DeletedByFirstName, row.DeletedByLastName),
			Version:          row.Version,
		})
	}
	spoolIDs, err := q.ListRetiredSpoolIDs(ctx)
	if err != nil {
		return bin, err
	}
	for _, id := range spoolIDs {
		spool, loadErr := s.loadSpool(ctx, q, id)
		if loadErr != nil {
			return bin, loadErr
		}
		bin.Spools = append(bin.Spools, spool)
	}
	entries, err := q.ListDeletedInventoryTransactions(ctx)
	if err != nil {
		return bin, err
	}
	for _, row := range entries {
		item := transactionFromList(machinelogbookdb.ListInventoryTransactionsRow{
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
			RunUsageID:          row.RunUsageID,
			ActorAccountID:      row.ActorAccountID,
			CreatedAt:           row.CreatedAt,
			SpoolID:             row.SpoolID,
			FromSpoolID:         row.FromSpoolID,
			ToSpoolID:           row.ToSpoolID,
			TransferQuantity:    row.TransferQuantity,
			SpoolDisplayID:      row.SpoolDisplayID,
			FromSpoolDisplayID:  row.FromSpoolDisplayID,
			ToSpoolDisplayID:    row.ToSpoolDisplayID,
			PurchaseReference:   row.PurchaseReference,
			OrderItemID:         row.OrderItemID,
			DeletedAt:           row.DeletedAt,
			DeletedBy:           row.DeletedBy,
			MachineJobID:        row.MachineJobID,
			MachineJobDisplayID: row.MachineJobDisplayID,
			OrderID:             row.OrderID,
			OrderReference:      row.OrderReference,
			ActorFirstName:      row.ActorFirstName,
			ActorLastName:       row.ActorLastName,
		})
		bin.LedgerEntries = append(bin.LedgerEntries, DeletedInventoryTransaction{
			Transaction:     item,
			MaterialName:    row.MaterialName,
			MaterialDisplay: row.MaterialDisplayID,
			Unit:            row.MaterialUnit,
			DeletedAt:       row.DeletedAt.Time,
			DeletedByName:   personName(row.DeletedByFirstName, row.DeletedByLastName),
		})
	}
	return bin, nil
}

// toggleLedgerEntry removes a ledger entry's effect from (sign -1, delete) or adds it back to (sign +1,
// restore) the article's balance and its spools, and refuses a change that would make stock negative.
func (s *Service) toggleLedgerEntry(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	p authorization.Principal,
	entry machinelogbookdb.InventoryTransaction,
	expectedInventory int64,
	restore bool,
) error {
	current, err := q.GetMaterialForUpdate(ctx, entry.MaterialID)
	if err != nil {
		return noRows(err)
	}
	if current.DeletedAt.Valid {
		return errMaterialInBin
	}
	if expectedInventory != anyInventoryVersion && current.InventoryVersion != expectedInventory {
		return apperror.StaleWrite
	}
	spools := []uuid.UUID{}
	for _, id := range []*uuid.UUID{entry.SpoolID, entry.FromSpoolID, entry.ToSpoolID} {
		if id != nil {
			spools = append(spools, *id)
		}
	}
	versions := map[uuid.UUID]int64{}
	for _, id := range spools {
		spool, spoolErr := q.GetFilamentSpoolForUpdate(ctx, id)
		if spoolErr != nil {
			return noRows(spoolErr)
		}
		versions[id] = spool.Version
	}
	sign := decimal.NewFromInt(-1)
	if restore {
		sign = decimal.NewFromInt(1)
	}
	quantity := decimalFromNumeric(current.Quantity).Add(decimalFromNumeric(entry.QuantityDelta).Mul(sign))
	value := decimalFromNumeric(current.InventoryValue).Add(decimalFromNumeric(entry.InventoryValueDelta).Mul(sign))
	if quantity.IsNegative() {
		return apperror.Conflicting("insufficient_stock", "Inventory would become negative")
	}
	if value.IsNegative() {
		if value.Abs().LessThan(decimal.RequireFromString("0.000001")) {
			value = decimal.Zero
		} else {
			return apperror.Conflicting("invalid_inventory_value", "Inventory value would become negative")
		}
	}
	average := decimalFromNumeric(current.AverageUnitCost)
	if quantity.IsPositive() {
		average = value.Div(quantity)
	}
	if _, err = q.UpdateMaterialBalance(
		ctx,
		machinelogbookdb.UpdateMaterialBalanceParams{
			Quantity:        numericFromDecimal(quantity),
			InventoryValue:  numericFromDecimal(value),
			AverageUnitCost: numericFromDecimal(average),
			MaterialID:      entry.MaterialID,
			ExpectedVersion: current.InventoryVersion,
		},
	); err != nil {
		return err
	}
	params := machinelogbookdb.SetInventoryTransactionDeletedParams{ID: entry.ID}
	if !restore {
		params.DeletedAt = pgTimestamp(s.now())
		params.DeletedBy = accountPointer(p)
	}
	rows, err := q.SetInventoryTransactionDeleted(ctx, params)
	if err != nil {
		return err
	}
	if rows == 0 {
		return apperror.NotFound
	}
	for _, id := range spools {
		remaining, remainingErr := q.GetSpoolRemaining(ctx, id)
		if remainingErr != nil {
			return remainingErr
		}
		if decimalFromNumeric(remaining).IsNegative() {
			return apperror.Conflicting("insufficient_spool_stock", "Spool inventory would become negative")
		}
		if _, err = q.BumpFilamentSpoolVersion(
			ctx,
			machinelogbookdb.BumpFilamentSpoolVersionParams{ID: id, ExpectedVersion: versions[id]},
		); err != nil {
			return err
		}
	}
	allocated, err := q.AllocatedMaterialQuantity(ctx, entry.MaterialID)
	if err != nil {
		return err
	}
	if quantity.LessThan(decimalFromNumeric(allocated)) {
		return apperror.Conflicting(
			"insufficient_unassigned_stock",
			"Unassigned material inventory would become negative",
		)
	}
	return nil
}

// DeleteInventoryTransaction moves a ledger entry into the recycle bin: it stops counting for the article and
// its spools. Run usages and order items are not touched.
func (s *Service) DeleteInventoryTransaction(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expectedInventory int64,
	requestID *uuid.UUID,
) error {
	if err := require(p, authorization.InventoryLedgerDelete); err != nil {
		return err
	}
	if expectedInventory < 1 {
		return apperror.Invalid("expectedInventoryVersion must be positive")
	}
	return database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := machinelogbookdb.New(tx)
		entry, err := q.GetInventoryTransaction(ctx, id)
		if err != nil {
			return noRows(err)
		}
		if entry.DeletedAt.Valid {
			return apperror.NotFound
		}
		if err = s.toggleLedgerEntry(ctx, q, p, entry, expectedInventory, false); err != nil {
			return err
		}
		return writeAudit(
			ctx,
			tx,
			p,
			"inventory.transaction_deleted",
			"material",
			entry.MaterialID,
			requestID,
			[]string{"quantity", "inventoryValue", "inventoryVersion", "ledger"},
		)
	})
}

// RestoreInventoryTransaction brings a deleted ledger entry back; it counts again.
func (s *Service) RestoreInventoryTransaction(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	requestID *uuid.UUID,
) error {
	if err := require(p, authorization.InventoryLedgerDelete); err != nil {
		return err
	}
	return database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := machinelogbookdb.New(tx)
		entry, err := q.GetInventoryTransaction(ctx, id)
		if err != nil {
			return noRows(err)
		}
		if !entry.DeletedAt.Valid {
			return apperror.NotFound
		}
		if err = s.toggleLedgerEntry(ctx, q, p, entry, anyInventoryVersion, true); err != nil {
			return err
		}
		return writeAudit(
			ctx,
			tx,
			p,
			"inventory.transaction_restored",
			"material",
			entry.MaterialID,
			requestID,
			[]string{"quantity", "inventoryValue", "inventoryVersion", "ledger"},
		)
	})
}

// PurgeInventoryTransaction deletes a ledger entry in the recycle bin for good.
func (s *Service) PurgeInventoryTransaction(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	requestID *uuid.UUID,
) error {
	if err := require(p, authorization.InventoryLedgerDelete); err != nil {
		return err
	}
	return database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := machinelogbookdb.New(tx)
		entry, err := q.GetInventoryTransaction(ctx, id)
		if err != nil {
			return noRows(err)
		}
		if !entry.DeletedAt.Valid {
			return apperror.NotFound
		}
		if err = q.EnableInventoryPurge(ctx); err != nil {
			return err
		}
		rows, err := q.PurgeInventoryTransaction(ctx, id)
		if err != nil {
			return databaseError(err)
		}
		if rows == 0 {
			return apperror.NotFound
		}
		return writeAudit(
			ctx,
			tx,
			p,
			"inventory.transaction_purged",
			"material",
			entry.MaterialID,
			requestID,
			[]string{"ledger"},
		)
	})
}
