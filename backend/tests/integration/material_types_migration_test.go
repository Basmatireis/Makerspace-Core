package integration_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// Migration 00046 turns every distinct legacy (category, unit) into a material
// type, points materials, pricing rules and old pricing snapshots at it, keeps
// the colour text as colour name, and can be rolled back.
func TestMaterialTypesMigrationMapsCategoriesAndKeepsPricing(t *testing.T) {
	pool := emptySchemaPool(t)
	ctx := testContext(t)
	all, err := filepath.Glob(filepath.Join(filepath.Dir(orderedMigrationFiles(t)[0]), "*.sql"))
	if err != nil {
		t.Fatal(err)
	}
	var before, from []string
	for _, path := range all {
		if filepath.Base(path) < "00046_" {
			before = append(before, path)
		} else {
			from = append(from, path)
		}
	}
	if len(from) == 0 || filepath.Base(from[0]) != "00046_material_types.sql" {
		t.Fatalf("migrations from 46: %v", from)
	}
	applyMigrationFiles(t, pool, before)

	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, query, args...); err != nil {
			t.Fatalf("%v\n%s", err, query)
		}
	}
	id := func() uuid.UUID { return uuid.Must(uuid.NewV7()) }
	pla, petg, longName, sheetM2, sheetPiece, unusedRule := id(), id(), id(), id(), id(), id()
	for _, m := range []struct {
		id                          uuid.UUID
		name, category, color, unit string
	}{
		{pla, "PLA Black", "pla", "Black", "g"},
		{petg, "PETG Clear", "petg", "", "g"},
		{longName, "Silk", "filament", "Gold", "g"},
		{sheetM2, "Birch", "sheet", "", "m2"},
		{sheetPiece, "Offcut", "sheet", "", "piece"},
	} {
		var color any
		if m.color != "" {
			color = m.color
		}
		exec(
			`INSERT INTO materials (id, name, category, color, unit) VALUES ($1, $2, $3, $4, $5)`,
			m.id,
			m.name,
			m.category,
			color,
			m.unit,
		)
		exec(`INSERT INTO material_balances (material_id) VALUES ($1)`, m.id)
	}
	group, machineType, machine, job, snapshot := id(), id(), id(), id(), id()
	exec(`INSERT INTO pricing_groups (id, name) VALUES ($1, 'Legacy group')`, group)
	exec(`INSERT INTO machine_types (id, name) VALUES ($1, 'Legacy type')`, machineType)
	exec(`INSERT INTO machines (id, machine_type_id, name) VALUES ($1, $2, 'Legacy machine')`, machine, machineType)
	rule := func(ruleID uuid.UUID, category, unit, rate string) {
		exec(
			`INSERT INTO pricing_rules (id, pricing_group_id, kind, material_category, material_unit, rate) VALUES ($1, $2, 'material', $3, $4, $5::numeric)`,
			ruleID,
			group,
			category,
			unit,
			rate,
		)
	}
	plaRule := id()
	rule(plaRule, "pla", "g", "0.04")
	rule(id(), "petg", "g", "0.05")
	rule(unusedRule, "tpu", "g", "0.08") // no material uses this category yet
	customer := id()
	exec(
		`INSERT INTO people (id, first_name, last_name, email) VALUES ($1, 'Legacy', 'Customer', 'legacy-customer@example.test')`,
		customer,
	)
	exec(
		`INSERT INTO machine_jobs (id, display_id, machine_id, customer_person_id) VALUES ($1, 'J-2026-900046', $2, $3)`,
		job,
		machine,
		customer,
	)
	exec(
		`INSERT INTO machine_job_pricing_snapshots (id, machine_job_id, revision, pricing_group_name, reason, complete, calculated_amount) VALUES ($1, $2, 1, 'Legacy group', 'initial', true, 4)`,
		snapshot,
		job,
	)
	exec(
		`INSERT INTO machine_job_pricing_snapshot_rules (id, snapshot_id, source_rule_id, kind, label, selector, unit, rate, missing) VALUES ($1, $2, $3, 'material', 'PLA Black', 'pla', 'g', 0.04, false)`,
		id(),
		snapshot,
		plaRule,
	)
	exec(
		`INSERT INTO machine_job_pricing_snapshot_rules (id, snapshot_id, kind, label, selector, unit, rate, missing) VALUES ($1, $2, 'machine_runtime', 'Machine runtime', 'Legacy type', 'hour', 1, false)`,
		id(),
		snapshot,
	)

	applyMigrationFiles(t, pool, from[:1])

	// Types: up to four characters upper-case, longer ones initcap, a category
	// with several units gets the unit appended, rule-only categories count too.
	names := map[string]string{}
	rows, err := pool.Query(ctx, `SELECT name, unit FROM material_types`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var name, unit string
		if err = rows.Scan(&name, &unit); err != nil {
			t.Fatal(err)
		}
		names[name] = unit
	}
	rows.Close()
	want := map[string]string{
		"PLA":           "g",
		"PETG":          "g",
		"Filament":      "g",
		"TPU":           "g",
		"Sheet (m2)":    "m2",
		"Sheet (piece)": "piece",
	}
	if len(names) != len(want) {
		t.Fatalf("types = %v, want %v", names, want)
	}
	for name, unit := range want {
		if names[name] != unit {
			t.Fatalf("types = %v, want %v", names, want)
		}
	}
	assertCount(
		t,
		pool,
		`SELECT count(*) FROM materials m JOIN material_types t ON t.id = m.material_type_id AND t.unit = m.unit WHERE (m.id, t.name) IN (($1, 'PLA'), ($2, 'PETG'), ($3, 'Filament'), ($4, 'Sheet (m2)'), ($5, 'Sheet (piece)'))`,
		5,
		pla,
		petg,
		longName,
		sheetM2,
		sheetPiece,
	)
	assertCount(
		t,
		pool,
		`SELECT count(*) FROM materials WHERE (id = $1 AND color_name = 'Black') OR (id = $2 AND color_name = 'Gold')`,
		2,
		pla,
		longName,
	)
	assertCount(
		t,
		pool,
		`SELECT count(*) FROM materials WHERE color_hex IS NOT NULL OR (id = $1 AND color_name IS NOT NULL)`,
		0,
		petg,
	)
	// Pricing keeps its rates and now points at the types.
	assertCount(
		t,
		pool,
		`SELECT count(*) FROM pricing_rules r JOIN material_types t ON t.id = r.material_type_id WHERE (t.name, r.rate, r.material_unit) IN (('PLA', 0.04, 'g'), ('PETG', 0.05, 'g'), ('TPU', 0.08, 'g'))`,
		3,
	)
	// The old snapshot keeps its text and gains the type link; the runtime rule is untouched.
	assertCount(
		t,
		pool,
		`SELECT count(*) FROM machine_job_pricing_snapshot_rules r JOIN material_types t ON t.id = r.material_type_id WHERE r.snapshot_id = $1 AND r.selector = 'pla' AND r.label = 'PLA Black' AND r.unit = 'g' AND t.name = 'PLA'`,
		1,
		snapshot,
	)
	assertCount(
		t,
		pool,
		`SELECT count(*) FROM machine_job_pricing_snapshot_rules WHERE snapshot_id = $1 AND kind = 'machine_runtime' AND material_type_id IS NULL`,
		1,
		snapshot,
	)

	// The database refuses a material whose unit differs from its type's unit.
	var plaType uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT id FROM material_types WHERE name = 'PLA'`).Scan(&plaType); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO materials (id, name, material_type_id, unit) VALUES ($1, 'Wrong unit', $2, 'ml')`, id(), plaType); err == nil {
		t.Fatal("unit differing from the type unit was accepted")
	}

	// Rolling back restores the category text, colour and rules.
	down, err := os.ReadFile(from[0])
	if err != nil {
		t.Fatal(err)
	}
	_, downSQL, _ := strings.Cut(string(down), "-- +goose Down")
	if _, err = pool.Exec(ctx, downSQL); err != nil {
		t.Fatalf("down: %v", err)
	}
	assertCount(
		t,
		pool,
		`SELECT count(*) FROM materials WHERE (id = $1 AND category = 'pla' AND color = 'Black') OR (id = $2 AND category = 'petg') OR (id = $3 AND category = 'filament' AND color = 'Gold') OR (id IN ($4, $5) AND category = 'sheet')`,
		5,
		pla,
		petg,
		longName,
		sheetM2,
		sheetPiece,
	)
	assertCount(
		t,
		pool,
		`SELECT count(*) FROM pricing_rules WHERE (material_category, material_unit, rate) IN (('pla', 'g', 0.04), ('petg', 'g', 0.05), ('tpu', 'g', 0.08))`,
		3,
	)
	assertCount(t, pool, `SELECT count(*) FROM machine_job_pricing_snapshot_rules WHERE snapshot_id = $1`, 2, snapshot)
}
