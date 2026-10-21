package machinelogbook

import (
	"context"
	"fmt"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/database"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

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
		{"spool_fills", "spool fills", c.SpoolFills},
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

// DeleteMaterial hard-deletes an article that nothing uses yet. A used article
// answers 409 material_in_use; its details carry "uses", a list of
// {"kind": <stable key>, "count": <rows>} objects, and the message names the
// kinds. Those articles are deactivated instead. The balance and filament
// properties are owned rows that go with the article.
func (s *Service) DeleteMaterial(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) error {
	if err := require(p, authorization.InventoryManage); err != nil {
		return err
	}
	return database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		return s.DeleteMaterialTx(ctx, tx, p, id, expected, requestID)
	})
}

// DeleteMaterialTx is DeleteMaterial inside the caller's transaction; the configuration import uses it.
func (s *Service) DeleteMaterialTx(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) error {
	if err := require(p, authorization.InventoryManage); err != nil {
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
	if err = writeAudit(ctx, tx, p, "material.deleted", "material", id, requestID, nil); err != nil {
		return err
	}
	return nil
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
		"This article is in use ("+labels+") and cannot be deleted; deactivate it instead",
	)
	err.Details["uses"] = listed
	return err
}
