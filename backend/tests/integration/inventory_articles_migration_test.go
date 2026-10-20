package integration_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// rollbackMigration runs the Down section of a migration file.
func rollbackMigration(t *testing.T, pool *pgxpool.Pool, path string) error {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	_, down, found := strings.Cut(string(content), "-- +goose Down")
	if !found {
		t.Fatal("migration has no Down section")
	}
	_, err = pool.Exec(testContext(t), down)
	return err
}

// Migration 00056 gives material types a kind, folds the filament product
// catalog into the articles and drops it, and can be rolled back.
func TestInventoryArticlesMigrationFoldsProducts(t *testing.T) {
	pool := emptySchemaPool(t)
	ctx := testContext(t)
	all, err := filepath.Glob(filepath.Join(filepath.Dir(orderedMigrationFiles(t)[0]), "*.sql"))
	if err != nil {
		t.Fatal(err)
	}
	var before, from []string
	for _, path := range all {
		if filepath.Base(path) < "00056_" {
			before = append(before, path)
		} else {
			from = append(from, path)
		}
	}
	if len(from) == 0 || filepath.Base(from[0]) != "00056_inventory_articles.sql" {
		t.Fatalf("migrations from 56: %v", from)
	}
	applyMigrationFiles(t, pool, before)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, query, args...); err != nil {
			t.Fatalf("%v\n%s", err, query)
		}
	}
	id := func() uuid.UUID { return uuid.Must(uuid.NewV7()) }

	pla, mixed, sheet := id(), id(), id()
	for _, ty := range []struct {
		id         uuid.UUID
		name, unit string
		processes  []string
	}{{pla, "PLA", "g", []string{"fdm_printing"}}, {mixed, "Mixed", "g", []string{"fdm_printing", "other"}}, {sheet, "Sheet", "m2", []string{"laser_cutting"}}} {
		exec(`INSERT INTO material_types (id, name, unit) VALUES ($1, $2, $3)`, ty.id, ty.name, ty.unit)
		for _, process := range ty.processes {
			exec(`INSERT INTO material_type_processes (material_type_id, process) VALUES ($1, $2)`, ty.id, process)
		}
	}
	material := func(typeID uuid.UUID, name, unit string) uuid.UUID {
		materialID := id()
		exec(`INSERT INTO materials (id, name, material_type_id, unit) VALUES ($1, $2, $3, $4)`, materialID, name, typeID, unit)
		exec(`INSERT INTO material_balances (material_id) VALUES ($1)`, materialID)
		return materialID
	}
	one, two, fromFill, none, sheetMaterial := material(pla, "PLA one maker", "g"), material(pla, "PLA two makers", "g"), material(pla, "PLA fill only", "g"), material(pla, "PLA nothing", "g"), material(sheet, "Birch", "m2")
	product := func(materialID uuid.UUID, maker, name, weight string) uuid.UUID {
		productID := id()
		exec(`INSERT INTO filament_products (id, manufacturer, name, material_id, net_weight_g, packaging) VALUES ($1, $2, $3, $4, $5::numeric, 'spool')`, productID, maker, name, materialID, weight)
		return productID
	}
	product(one, "Prusa", "P1", "1000")
	product(one, "prusa", "P2", "1000")
	product(two, "Prusa", "P3", "1000")
	product(two, "Extrudr", "E1", "500")
	spool := id()
	exec(`INSERT INTO filament_spools (id, display_id, kind) VALUES ($1, 'S-2031-000001', 'single_use')`, spool)
	exec(`INSERT INTO filament_spool_fills (id, spool_id, fill_number, material_id, manufacturer, initial_net_weight_g, filled_at) VALUES ($1, $2, 1, $3, 'Polymaker', 750, now())`, id(), spool, fromFill)

	applyMigrationFiles(t, pool, from)

	text := func(query string, args ...any) string {
		t.Helper()
		var value *string
		if err := pool.QueryRow(ctx, query, args...).Scan(&value); err != nil {
			t.Fatal(err)
		}
		if value == nil {
			return "<null>"
		}
		return *value
	}
	for typeID, want := range map[uuid.UUID]string{pla: "filament", mixed: "filament", sheet: "consumable"} {
		if got := text(`SELECT kind FROM material_types WHERE id = $1`, typeID); got != want {
			t.Errorf("kind of %s = %s, want %s", typeID, got, want)
		}
	}
	for materialID, want := range map[uuid.UUID]string{one: "Prusa", two: "<null>", fromFill: "Polymaker", none: "<null>"} {
		if got := text(`SELECT manufacturer FROM materials WHERE id = $1`, materialID); got != want {
			t.Errorf("manufacturer of %s = %s, want %s", materialID, got, want)
		}
	}
	for materialID, want := range map[uuid.UUID]string{one: "1000.000000", two: "<null>", none: "<null>"} {
		if got := text(`SELECT package_size::text FROM materials WHERE id = $1`, materialID); got != want {
			t.Errorf("package size of %s = %s, want %s", materialID, got, want)
		}
	}
	if got := text(`SELECT diameter_mm::text FROM material_filament_properties WHERE material_id = $1`, none); got != "1.750" {
		t.Errorf("default diameter = %s", got)
	}
	assertCount(t, pool, `SELECT count(*) FROM information_schema.tables WHERE table_name = 'filament_products'`, 0)
	assertCount(t, pool, `SELECT count(*) FROM information_schema.columns WHERE table_name = 'filament_spool_fills' AND column_name = 'product_id'`, 0)
	assertCount(t, pool, `SELECT count(*) FROM filament_spool_fills WHERE manufacturer = 'Polymaker'`, 1)
	_ = sheetMaterial

	// A part type cannot be downgraded; without parts the migration rolls back.
	exec(`INSERT INTO material_types (id, name, unit, kind) VALUES ($1, 'Fasteners', 'piece', 'part')`, id())
	err = rollbackMigration(t, pool, from[0])
	if err == nil || !strings.Contains(err.Error(), "cannot be downgraded") {
		t.Fatalf("downgrade with parts: %v", err)
	}
	exec(`DELETE FROM material_types WHERE kind = 'part'`)
	if err = rollbackMigration(t, pool, from[0]); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `SELECT count(*) FROM filament_products WHERE material_id = $1`, 1, one)
}
