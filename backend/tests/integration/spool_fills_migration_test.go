package integration_test

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Spools created before spool fills become fill 1 without changing a single
// remaining quantity or material total, and the migrated spools keep working.
func TestSpoolFillsMigrationKeepsStockAndHistory(t *testing.T) {
	schemaPool := emptySchemaPool(t)
	ctx := testContext(t)
	paths := orderedMigrationFiles(t)
	if filepath.Base(paths[37]) != "00038_spool_fills_products.sql" {
		t.Fatalf("migration 38 = %s", filepath.Base(paths[37]))
	}
	applyMigrationFiles(t, schemaPool, paths[:37])

	material, active, retired := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	occurred := time.Date(2030, 1, 2, 10, 0, 0, 0, time.UTC)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := schemaPool.Exec(ctx, query, args...); err != nil {
			t.Fatalf("%v\n%s", err, query)
		}
	}
	exec(`INSERT INTO materials (id, name, category, unit) VALUES ($1, 'Legacy PLA', 'pla', 'g')`, material)
	exec(`INSERT INTO material_filament_properties (material_id, diameter_mm) VALUES ($1, 1.75)`, material)
	exec(
		`INSERT INTO material_balances (material_id, quantity, inventory_value, average_unit_cost) VALUES ($1, 800, 16, 0.02)`,
		material,
	)
	exec(
		`INSERT INTO filament_spools (id, display_id, material_id, manufacturer, product_name, initial_net_weight_g, tare_weight_g, acquired_on, lifecycle)
		VALUES ($1, 'S-2030-000001', $3, 'Prusa', 'Galaxy', 500, 200, '2030-01-01', 'active'), ($2, 'S-2030-000002', $3, NULL, NULL, 100, NULL, NULL, 'retired')`,
		active,
		retired,
		material,
	)
	exec(
		`INSERT INTO filament_spool_identifiers (id, spool_id, kind, value) VALUES ($1, $2, 'barcode', 'LEGACY-1')`,
		uuid.Must(uuid.NewV7()),
		active,
	)
	type row struct {
		kind                          string
		delta, value, price, transfer any
		spool, to                     any
	}
	for _, r := range []row{
		{"purchase", 1000, 20, 20, nil, nil, nil},
		{"spool_transfer", 0, 0, nil, 500, nil, active},
		{"manual_consumption", -200, -4, nil, nil, active, nil},
		{"purchase", 100, 2, 2, nil, retired, nil},
		{"manual_consumption", -100, -2, nil, nil, retired, nil},
	} {
		exec(
			`INSERT INTO inventory_transactions (id, material_id, kind, quantity_delta, unit_acquisition_cost, inventory_value_delta, total_purchase_price, occurred_at, spool_id, to_spool_id, transfer_quantity)
			VALUES ($1, $2, $3::text, $4, CASE WHEN $3::text = 'spool_transfer' THEN 0 ELSE 0.02 END, $5, $6, $7, $8, $9, $10)`,
			uuid.Must(uuid.NewV7()),
			material,
			r.kind,
			r.delta,
			r.value,
			r.price,
			occurred,
			r.spool,
			r.to,
			r.transfer,
		)
	}

	applyMigrationFiles(t, schemaPool, paths[37:])
	// The queries below read the current schema, so the newer migrations apply too.
	later, globErr := filepath.Glob(filepath.Join(filepath.Dir(paths[0]), "*.sql"))
	if globErr != nil {
		t.Fatal(globErr)
	}
	var newer []string
	for _, path := range later {
		if filepath.Base(path) > "00041_"+strings.Repeat("z", 200) {
			newer = append(newer, path)
		}
	}
	applyMigrationFiles(t, schemaPool, newer)

	assertCount(
		t,
		schemaPool,
		`SELECT count(*) FROM filament_spool_fills WHERE fill_number = 1 AND closed_at IS NULL`,
		2,
	)
	assertCount(
		t,
		schemaPool,
		`SELECT count(*) FROM inventory_transactions WHERE fill_id IS NOT NULL AND spool_display_id = 'S-2030-000001' AND fill_number = 1`,
		1,
	)
	assertCount(
		t,
		schemaPool,
		`SELECT count(*) FROM inventory_transactions WHERE to_fill_id IS NOT NULL AND to_spool_display_id = 'S-2030-000001' AND to_fill_number = 1`,
		1,
	)
	assertCount(
		t,
		schemaPool,
		`SELECT count(*) FROM filament_spool_identifiers WHERE fill_id IS NOT NULL AND retired_at IS NULL`,
		1,
	)
	assertCount(t, schemaPool, `SELECT count(*) FROM filament_spools WHERE kind = 'single_use'`, 2)

	config := schemaPool.Config().Copy()
	config.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeCacheStatement
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	service := machinelogbook.NewService(pool)
	master := authorization.Principal{
		AccountID: uuid.Must(uuid.NewV7()),
		PersonID:  uuid.Must(uuid.NewV7()),
		Master:    true,
	}
	exec(
		`INSERT INTO people (id, first_name, last_name, email) VALUES ($1, 'Mig', 'Rator', 'migrator@example.test')`,
		master.PersonID,
	)
	exec(`INSERT INTO accounts (id, person_id, status) VALUES ($1, $2, 'enabled')`, master.AccountID, master.PersonID)

	spool, err := service.GetFilamentSpool(ctx, master, active)
	if err != nil {
		t.Fatal(err)
	}
	if spool.FillNumber != 1 || spool.FillID == nil || spool.RemainingQuantity != "300" || spool.Status != "active" || spool.Kind != "single_use" || spool.Lifecycle != "active" ||
		spool.InitialNetWeightG == nil || *spool.InitialNetWeightG != "500" || spool.Manufacturer == nil || *spool.Manufacturer != "Prusa" || spool.MaterialID == nil || *spool.MaterialID != material ||
		len(spool.Identifiers) != 1 ||
		spool.Identifiers[0].Value != "LEGACY-1" ||
		spool.AcquiredOn == nil ||
		len(spool.Fills) != 0 {
		t.Fatalf("migrated active spool: %+v", spool)
	}
	old, err := service.GetFilamentSpool(ctx, master, retired)
	if err != nil {
		t.Fatal(err)
	}
	if old.Lifecycle != "archived" || old.Status != "archived" || old.ArchivedAt == nil ||
		old.RemainingQuantity != "0" ||
		old.FillID == nil {
		t.Fatalf("migrated retired spool: %+v", old)
	}
	mat, err := service.GetMaterial(ctx, master, material)
	if err != nil {
		t.Fatal(err)
	}
	if mat.Quantity != "800" || mat.AssignedQuantity != "300" || mat.UnassignedQuantity != "500" {
		t.Fatalf("material totals changed: %+v", mat)
	}
	found, err := service.LookupFilamentSpool(ctx, master, "barcode", "legacy-1")
	if err != nil || found.ID != active {
		t.Fatalf("lookup: %+v %v", found, err)
	}
	history, _, err := service.ListFilamentSpoolTransactions(ctx, master, active, 1, 25)
	if err != nil || len(history) != 2 {
		t.Fatalf("spool history: %d %v", len(history), err)
	}

	// Migrated spools keep working; the archived one holds an open fill but takes no movements.
	if _, err = service.ConsumeFilamentSpool(ctx, master, retired, mat.InventoryVersion, old.Version, "1", occurred, false, nil, nil, nil); !apperror.IsCode(
		err,
		"spool_not_consumable",
	) {
		t.Fatalf("archived spool consumption: %v", err)
	}
	consumed, err := service.ConsumeFilamentSpool(
		ctx,
		master,
		active,
		mat.InventoryVersion,
		spool.Version,
		"50",
		occurred,
		false,
		nil,
		nil,
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if consumed.Transaction.SpoolDisplayID == nil || *consumed.Transaction.SpoolDisplayID != "S-2030-000001" ||
		consumed.Transaction.FillNumber == nil ||
		*consumed.Transaction.FillNumber != 1 ||
		consumed.Material.AssignedQuantity != "250" {
		t.Fatalf("consumption on migrated spool: %+v", consumed)
	}
}
