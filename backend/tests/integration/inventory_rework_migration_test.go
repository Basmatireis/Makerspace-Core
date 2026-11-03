package integration_test

import (
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

// Migrations 00094 to 00096 turn fill-based spools into plain spools, give material types a code and machine-use
// flag, give articles a display ID and stock pricing rules, and add the inventory recycle bin. This runs them over
// legacy rows from version 93 and then proves that they roll back and apply again.
func TestInventoryReworkMigrationsConvertLegacyData(t *testing.T) {
	pool := emptySchemaPool(t)
	ctx := testContext(t)
	all := orderedMigrationFiles(t)
	paths, err := filepath.Glob(filepath.Join(filepath.Dir(all[0]), "*.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) < 96 ||
		filepath.Base(paths[93]) != "00094_spools_without_fills.sql" ||
		filepath.Base(paths[94]) != "00095_article_codes_and_stock_prices.sql" ||
		filepath.Base(paths[95]) != "00096_inventory_recycle_bin.sql" {
		t.Fatalf("unexpected migration order around 94 to 96 (%d files)", len(paths))
	}
	applyMigrationFiles(t, pool, paths[:93])

	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, query, args...); err != nil {
			t.Fatalf("%v\n%s", err, query)
		}
	}
	count := func(query string, want int, args ...any) {
		t.Helper()
		assertCount(t, pool, query, want, args...)
	}
	text := func(query string, args ...any) string {
		t.Helper()
		var value string
		if err := pool.QueryRow(ctx, query, args...).Scan(&value); err != nil {
			t.Fatalf("%v\n%s", err, query)
		}
		return value
	}
	sqlState := func(err error) string {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) {
			return pgErr.Code
		}
		return errorString(err)
	}
	id := func() uuid.UUID { return ids.New() }

	// Material types: two share the first word "PLA"; the third is only referenced by a pricing rule.
	plaType, partType, sheetType := id(), id(), id()
	exec(`INSERT INTO material_types (id, name, unit, kind, created_at) VALUES
		($1, 'PLA Basic', 'g', 'filament', now() - interval '3 days'),
		($2, 'PLA Printed Part', 'piece', 'part', now() - interval '2 days'),
		($3, 'Sheet goods', 'm2', 'consumable', now() - interval '1 day')`, plaType, partType, sheetType)

	// Materials in creation order: two filament articles and one part with a sale price.
	basicBlue, basicRed, bracket := id(), id(), id()
	for _, m := range []struct {
		id                    uuid.UUID
		typeID                uuid.UUID
		name, unit, variant   string
		colour                string
		salePrice             any
		createdHoursBeforeNow int
	}{
		{basicBlue, plaType, "PLA Basic Dark Blue", "g", "Basic", "Dark Blue", nil, 30},
		{basicRed, plaType, "PLA Basic Red", "g", "Basic", "Red", nil, 20},
		{bracket, partType, "Bracket", "piece", "", "", 12.5, 10},
	} {
		exec(
			`INSERT INTO materials (id, name, unit, material_type_id, variant, color_name, sale_price, created_at)
			VALUES ($1, $2, $3, $4, NULLIF($5, ''), NULLIF($6, ''), $7, now() - make_interval(hours => $8))`,
			m.id, m.name, m.unit, m.typeID, m.variant, m.colour, m.salePrice, m.createdHoursBeforeNow,
		)
		exec(`INSERT INTO material_balances (material_id, quantity, inventory_value, average_unit_cost) VALUES ($1, 0, 0, 0)`, m.id)
	}

	// Pricing groups, one default, and material pricing rules for the filament and the sheet type.
	defaultGroup, otherGroup := id(), id()
	exec(`INSERT INTO pricing_groups (id, name, is_default) VALUES ($1, 'Members', true), ($2, 'External', false)`, defaultGroup, otherGroup)
	exec(`INSERT INTO pricing_rules (id, pricing_group_id, kind, material_type_id, material_unit, rate)
		VALUES ($1, $3, 'material', $4, 'g', 0.05), ($2, $3, 'material', $5, 'm2', 3)`,
		id(), id(), defaultGroup, plaType, sheetType)

	// Spools. The first is reusable with a closed fill 1 and an open fill 2 (another material and weight), the
	// second is single-use with a closed fill only and is mounted on a printer, the third never held a fill.
	reusable, singleUse, empty := id(), id(), id()
	fill1, fill2, fillSingle := id(), id(), id()
	exec(`INSERT INTO filament_spools (id, display_id, kind, label, lifecycle, tare_weight_g, created_at) VALUES
		($1, 'S-2026-000001', 'reusable', 'Shelf spool', 'active', 210, now() - interval '5 days'),
		($2, 'S-2026-000002', 'single_use', NULL, 'active', NULL, now() - interval '4 days'),
		($3, 'S-2026-000003', 'single_use', NULL, 'active', NULL, now() - interval '3 days')`, reusable, singleUse, empty)
	exec(`INSERT INTO filament_spool_fills (id, spool_id, fill_number, material_id, initial_net_weight_g, filled_at, closed_at, leftover_g, leftover_outcome)
		VALUES ($1, $2, 1, $4, 1000, now() - interval '5 days', now() - interval '3 days', 0, 'used_up'),
		       ($3, $5, 1, $4, 800, now() - interval '4 days', now() - interval '2 days', 0, 'used_up')`,
		fill1, reusable, fillSingle, basicBlue, singleUse)
	exec(`INSERT INTO filament_spool_fills (id, spool_id, fill_number, material_id, initial_net_weight_g, filled_at)
		VALUES ($1, $2, 2, $3, 750, now() - interval '2 days')`, fill2, reusable, basicRed)
	exec(`INSERT INTO filament_spool_identifiers (id, spool_id, fill_id, kind, value) VALUES
		($1, $2, $3, 'barcode', 'BC-REUSABLE'), ($4, $5, $6, 'qr', 'QR-SINGLE')`,
		id(), reusable, fill2, id(), singleUse, fillSingle)

	// Mounted single-use spool on a printer slot.
	process, machine, unit, slot := id(), id(), id(), id()
	exec(`INSERT INTO processes (id, name, integration) VALUES ($1, 'FDM printing', 'fdm_printer')`, process)
	exec(`INSERT INTO machines (id, process_id, name) VALUES ($1, $2, 'Migration printer')`, machine, process)
	exec(`INSERT INTO printer_profiles (machine_id) VALUES ($1)`, machine)
	exec(`INSERT INTO printer_input_units (id, machine_id, name, position) VALUES ($1, $2, 'AMS', 0)`, unit, machine)
	exec(`INSERT INTO printer_slots (id, input_unit_id, name, position) VALUES ($1, $2, 'Slot 1', 0)`, slot, unit)
	exec(`INSERT INTO printer_spool_assignments (id, slot_id, spool_id, mounted_at, source)
		VALUES ($1, $2, $3, now() - interval '1 hour', 'manual')`, id(), slot, singleUse)

	// Ledger: a purchase, a transfer of 500 g into the reusable spool and 200 g consumed from it.
	occurred := time.Date(2030, 1, 2, 10, 0, 0, 0, time.UTC)
	exec(`INSERT INTO inventory_transactions (id, material_id, kind, quantity_delta, unit_acquisition_cost, inventory_value_delta, total_purchase_price, occurred_at)
		VALUES ($1, $2, 'purchase', 1000, 0.02, 20, 20, $3)`, id(), basicRed, occurred)
	exec(`INSERT INTO inventory_transactions (id, material_id, kind, quantity_delta, unit_acquisition_cost, inventory_value_delta, occurred_at,
			to_spool_id, to_fill_id, to_spool_display_id, to_fill_number, transfer_quantity)
		VALUES ($1, $2, 'spool_transfer', 0, 0, 0, $3, $4, $5, 'S-2026-000001', 2, 500)`, id(), basicRed, occurred, reusable, fill2)
	consumption := id()
	exec(`INSERT INTO inventory_transactions (id, material_id, kind, quantity_delta, unit_acquisition_cost, inventory_value_delta, occurred_at,
			spool_id, fill_id, spool_display_id, fill_number)
		VALUES ($1, $2, 'manual_consumption', -200, 0.02, -4, $3, $4, $5, 'S-2026-000001', 2)`, consumption, basicRed, occurred, reusable, fill2)

	// A run usage that references the open fill.
	run, usage, customer, job := id(), id(), id(), id()
	exec(`INSERT INTO people (id, first_name, last_name, email) VALUES ($1, 'Spool', 'Customer', 'spool-customer@example.test')`, customer)
	exec(`INSERT INTO machine_jobs (id, display_id, machine_id, customer_person_id) VALUES ($1, 'J-2030-900001', $2, $3)`, job, machine, customer)
	exec(`INSERT INTO machine_runs (id, display_id, machine_id, source, job_id, started_at, ended_at, history_complete)
		VALUES ($1, 'R-2030-900001', $2, 'manual', $3, now() - interval '2 hours', now() - interval '1 hour', true)`, run, machine, job)
	exec(`INSERT INTO machine_run_usages (id, run_id, material_id, quantity, spool_id, fill_id, spool_display_id, fill_number)
		VALUES ($1, $2, $3, 120, $4, $5, 'S-2026-000001', 2)`, usage, run, basicRed, reusable, fill2)

	applyMigrationFiles(t, pool, paths[93:96])

	// 00094: spools keep the open fill's material and weight; the fill tables and columns are gone.
	if got := text(`SELECT material_id::text || '/' || initial_net_weight_g::text FROM filament_spools WHERE id = $1`, reusable); got != basicRed.String()+"/750.000000" {
		t.Fatalf("reusable spool = %s, want open fill 2 data", got)
	}
	if got := text(`SELECT material_id::text || '/' || initial_net_weight_g::text FROM filament_spools WHERE id = $1`, singleUse); got != basicBlue.String()+"/800.000000" {
		t.Fatalf("single-use spool = %s, want its closed fill data", got)
	}
	count(`SELECT count(*) FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'filament_spool_fills'`, 0)
	count(`SELECT count(*) FROM information_schema.columns WHERE table_schema = current_schema()
		AND ((table_name = 'inventory_transactions' AND column_name IN ('fill_id', 'from_fill_id', 'to_fill_id', 'fill_number', 'from_fill_number', 'to_fill_number'))
		  OR (table_name = 'machine_run_usages' AND column_name IN ('fill_id', 'fill_number'))
		  OR (table_name = 'filament_spool_identifiers' AND column_name = 'fill_id')
		  OR (table_name = 'filament_spools' AND column_name IN ('kind', 'label')))`, 0)
	count(`SELECT count(*) FROM filament_spools WHERE id = $1`, 0, empty)
	count(`SELECT count(*) FROM filament_spools`, 2)
	count(`SELECT count(*) FROM filament_spools WHERE id = $1 AND lifecycle = 'active' AND archived_at IS NULL`, 1, reusable)
	count(`SELECT count(*) FROM filament_spools WHERE id = $1 AND lifecycle = 'archived' AND archived_at IS NOT NULL`, 1, singleUse)
	count(`SELECT count(*) FROM printer_spool_assignments WHERE spool_id = $1 AND unmounted_at IS NOT NULL AND unmounted_at > mounted_at`, 1, singleUse)
	count(`SELECT count(*) FROM filament_spool_identifiers WHERE value = 'BC-REUSABLE' AND retired_at IS NULL`, 1)
	count(`SELECT count(*) FROM filament_spool_identifiers WHERE value = 'QR-SINGLE' AND retired_at IS NOT NULL`, 1)
	if got := text(`SELECT string_agg(display_id, ',' ORDER BY display_id) FROM filament_spools`); got != "S-2026-000001,S-2026-000002" {
		t.Fatalf("spool display IDs = %s, want the old ones kept", got)
	}
	// The ledger and the usage keep their display-id snapshots; the remaining quantity is 500 - 200.
	count(`SELECT count(*) FROM inventory_transactions WHERE spool_display_id = 'S-2026-000001' OR to_spool_display_id = 'S-2026-000001'`, 2)
	count(`SELECT count(*) FROM machine_run_usages WHERE id = $1 AND spool_id = $2 AND spool_display_id = 'S-2026-000001'`, 1, usage, reusable)
	if got := text(`SELECT filament_spool_remaining($1)::text`, reusable); got != "300.000000" {
		t.Fatalf("remaining quantity = %s, want 300", got)
	}

	// Labels: both formats pass, an active duplicate is refused, an archived spool may reuse a label.
	newSpool := func(displayID, lifecycle string) error {
		archivedAt := any(nil)
		if lifecycle == "archived" {
			archivedAt = time.Now().UTC()
		}
		_, err := pool.Exec(ctx,
			`INSERT INTO filament_spools (id, display_id, material_id, initial_net_weight_g, lifecycle, archived_at) VALUES ($1, $2, $3, 1000, $4, $5)`,
			id(), displayID, basicBlue, lifecycle, archivedAt)
		return err
	}
	for _, label := range []string{"S-2027-000004", "S-PLA-BASIC-DARK BLUE-01"} {
		if err := newSpool(label, "active"); err != nil {
			t.Fatalf("label %q refused: %v", label, err)
		}
	}
	if err := newSpool("S-PLA-BASIC-DARK BLUE-01", "active"); sqlState(err) != "23505" {
		t.Fatalf("duplicate active label error = %v, want unique violation", err)
	}
	if err := newSpool("S-PLA-BASIC-DARK BLUE-01", "archived"); err != nil {
		t.Fatalf("archived spool with a used label refused: %v", err)
	}
	for _, label := range []string{"X-PLA-01", "S-PLA-BASIC", "S--01"} {
		if err := newSpool(label, "active"); sqlState(err) != "23514" {
			t.Fatalf("label %q error = %v, want check violation", label, err)
		}
	}
	exec(`DELETE FROM filament_spools WHERE id NOT IN ($1, $2)`, reusable, singleUse)

	// 00095: material type codes, machine use, article display IDs, stock-article rules.
	if got := text(`SELECT string_agg(code, ',' ORDER BY created_at) FROM material_types`); got != "PLA,PLA2,SHEET" {
		t.Fatalf("material type codes = %s, want PLA,PLA2,SHEET", got)
	}
	if got := text(`SELECT string_agg(machine_use::text, ',' ORDER BY created_at) FROM material_types`); got != "true,false,true" {
		t.Fatalf("machine_use = %s, want true (filament), false (part), true (rule reference)", got)
	}
	if got := text(`SELECT string_agg(display_id, ',' ORDER BY created_at, id) FROM materials`); got != "A-0001,A-0002,A-0003" {
		t.Fatalf("article display IDs = %s", got)
	}
	if got := text(`SELECT display_id FROM materials WHERE id = $1`, bracket); got != "A-0003" {
		t.Fatalf("bracket display ID = %s", got)
	}
	count(`SELECT count(*) FROM pricing_rules WHERE kind = 'stock_article' AND material_id = $1 AND rate = 12.5 AND active
		AND pricing_group_id IN ($2, $3)`, 2, bracket, defaultGroup, otherGroup)
	count(`SELECT count(*) FROM pricing_rules WHERE kind = 'stock_article'`, 2)
	count(`SELECT count(*) FROM pricing_rules WHERE kind = 'material'`, 2)
	count(`SELECT count(*) FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'materials' AND column_name = 'sale_price'`, 0)
	if got := text(`SELECT nextval('material_display_sequence')::text`); got != "4" {
		t.Fatalf("next article sequence value = %s, want 4", got)
	}

	// 00096: soft-delete columns and the purge-only ledger deletion.
	count(`SELECT count(*) FROM information_schema.columns WHERE table_schema = current_schema() AND column_name IN ('deleted_at', 'deleted_by')
		AND table_name IN ('materials', 'inventory_transactions')`, 4)
	if _, err := pool.Exec(ctx, `DELETE FROM inventory_transactions WHERE id = $1`, consumption); sqlState(err) != "23514" {
		t.Fatalf("plain ledger delete error = %v, want immutability check violation", err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('makerspace.inventory_purge', 'on', true)`); err != nil {
		t.Fatal(err)
	}
	tag, err := tx.Exec(ctx, `DELETE FROM inventory_transactions WHERE id = $1`, consumption)
	if err != nil || tag.RowsAffected() != 1 {
		t.Fatalf("purge delete = %v, %v", tag, err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	count(`SELECT count(*) FROM inventory_transactions WHERE id = $1`, 1, consumption)
	// Soft-deleted entries leave the spool remainder.
	exec(`UPDATE inventory_transactions SET deleted_at = now() WHERE id = $1`, consumption)
	if got := text(`SELECT filament_spool_remaining($1)::text`, reusable); got != "500.000000" {
		t.Fatalf("remaining quantity after soft delete = %s, want 500", got)
	}
	exec(`UPDATE inventory_transactions SET deleted_at = NULL WHERE id = $1`, consumption)

	// Round trip: down to 93 and up to 96 again.
	for i := 95; i >= 93; i-- {
		if err := rollbackMigration(t, pool, paths[i]); err != nil {
			t.Fatalf("roll back %s: %v", filepath.Base(paths[i]), err)
		}
	}
	count(`SELECT count(*) FROM filament_spool_fills`, 2)
	count(`SELECT count(*) FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'materials' AND column_name IN ('sale_price')`, 1)
	count(`SELECT count(*) FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'deleted_at'
		AND table_name IN ('materials', 'inventory_transactions')`, 0)
	applyMigrationFiles(t, pool, paths[93:96])
	count(`SELECT count(*) FROM filament_spools`, 2)
	count(`SELECT count(*) FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'filament_spool_fills'`, 0)
}
