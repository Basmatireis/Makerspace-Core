package integration_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// Migration 00047 replaces the printer flag of machine types with a process,
// gives every material type the processes it was used with, adds cm2, run
// measures and measure pricing rules, and can be rolled back.
func TestMachineProcessMigrationMapsPrinterFlagAndMaterialTypes(t *testing.T) {
	pool := emptySchemaPool(t)
	ctx := testContext(t)
	all, err := filepath.Glob(filepath.Join(filepath.Dir(orderedMigrationFiles(t)[0]), "*.sql"))
	if err != nil {
		t.Fatal(err)
	}
	var before, from []string
	for _, path := range all {
		if filepath.Base(path) < "00047_" {
			before = append(before, path)
		} else {
			from = append(from, path)
		}
	}
	if len(from) == 0 || filepath.Base(from[0]) != "00047_machine_processes.sql" {
		t.Fatalf("migrations from 47: %v", from)
	}
	applyMigrationFiles(t, pool, before)

	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, query, args...); err != nil {
			t.Fatalf("%v\n%s", err, query)
		}
	}
	id := func() uuid.UUID { return uuid.Must(uuid.NewV7()) }

	// Machine types: flagged as printer, unflagged but owning a printer profile, plain, and a laser.
	flagged, profiled, plain, laserType := id(), id(), id(), id()
	exec(
		`INSERT INTO machine_types (id, name, printer) VALUES ($1, 'Flagged printer', true), ($2, 'Profiled', false), ($3, 'Plain', false), ($4, 'Laser', false)`,
		flagged,
		profiled,
		plain,
		laserType,
	)
	profiledMachine, laserMachine, fdmMachine := id(), id(), id()
	exec(
		`INSERT INTO machines (id, machine_type_id, name) VALUES ($1, $2, 'Profiled machine'), ($3, $4, 'Laser machine'), ($5, $6, 'Flagged machine')`,
		profiledMachine,
		profiled,
		laserMachine,
		laserType,
		fdmMachine,
		flagged,
	)
	exec(`INSERT INTO printer_profiles (machine_id) VALUES ($1)`, profiledMachine)

	// Material types: one per case the process mapping distinguishes.
	filament, sheet, resin, gramsOnLaser, shared := id(), id(), id(), id(), id()
	for _, m := range []struct {
		id         uuid.UUID
		name, unit string
	}{{filament, "Filament", "g"}, {sheet, "Sheet", "m2"}, {resin, "Resin", "ml"}, {gramsOnLaser, "Powder", "g"}, {shared, "Shared", "g"}} {
		exec(`INSERT INTO material_types (id, name, unit) VALUES ($1, $2, $3)`, m.id, m.name, m.unit)
	}
	material := func(typeID uuid.UUID, name, unit string, diameter bool) uuid.UUID {
		materialID := id()
		exec(
			`INSERT INTO materials (id, name, material_type_id, unit) VALUES ($1, $2, $3, $4)`,
			materialID,
			name,
			typeID,
			unit,
		)
		exec(`INSERT INTO material_balances (material_id) VALUES ($1)`, materialID)
		if diameter {
			exec(`INSERT INTO material_filament_properties (material_id, diameter_mm) VALUES ($1, 1.75)`, materialID)
		}
		return materialID
	}
	material(filament, "PLA", "g", true)
	sheetMaterial := material(sheet, "Birch", "m2", false)
	material(resin, "Clear resin", "ml", false)
	powder := material(gramsOnLaser, "Powder", "g", false)
	sharedMaterial := material(shared, "Shared PLA", "g", true)

	customer, job := id(), id()
	exec(
		`INSERT INTO people (id, first_name, last_name, email) VALUES ($1, 'Process', 'Customer', 'process-customer@example.test')`,
		customer,
	)
	exec(
		`INSERT INTO machine_jobs (id, display_id, machine_id, customer_person_id) VALUES ($1, 'J-2026-900047', $2, $3)`,
		job,
		laserMachine,
		customer,
	)
	usage := func(runDisplay string, machineID, materialID uuid.UUID) {
		runID := id()
		exec(
			`INSERT INTO machine_runs (id, display_id, machine_id, source, job_id, started_at, ended_at, history_complete) VALUES ($1, $2, $3, 'manual', $4, now() - interval '2 hours', now() - interval '1 hour', true)`,
			runID,
			runDisplay,
			machineID,
			job,
		)
		exec(
			`INSERT INTO machine_run_usages (id, run_id, material_id, quantity) VALUES ($1, $2, $3, 1)`,
			id(),
			runID,
			materialID,
		)
	}
	usage("R-2026-900001", laserMachine, sheetMaterial)
	usage("R-2026-900002", laserMachine, powder)
	usage("R-2026-900003", laserMachine, sharedMaterial)

	applyMigrationFiles(t, pool, from)

	process := func(typeID uuid.UUID) string {
		var value string
		if err := pool.QueryRow(
			ctx,
			`SELECT process FROM machine_types WHERE id = $1`,
			typeID,
		).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	for typeID, want := range map[uuid.UUID]string{
		flagged:   "fdm_printing",
		profiled:  "fdm_printing",
		plain:     "other",
		laserType: "other",
	} {
		if got := process(typeID); got != want {
			t.Fatalf("process of %s = %s, want %s", typeID, got, want)
		}
	}
	processes := func(typeID uuid.UUID) string {
		var value string
		if err := pool.QueryRow(
			ctx,
			`SELECT COALESCE(string_agg(process, ',' ORDER BY process), '') FROM material_type_processes WHERE material_type_id = $1`,
			typeID,
		).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	for typeID, want := range map[uuid.UUID]string{
		filament:     "fdm_printing", // grams with a filament diameter
		sheet:        "other",        // used on the laser type, which is now "other"
		resin:        "other",        // no sign of use
		gramsOnLaser: "other",
		shared:       "fdm_printing,other",
	} {
		if got := processes(typeID); got != want {
			t.Fatalf("processes of %s = %q, want %q", typeID, got, want)
		}
	}
	assertCount(
		t,
		pool,
		`SELECT count(*) FROM information_schema.columns WHERE table_name = 'machine_types' AND column_name = 'printer'`,
		0,
	)

	// cm2, measures and measure rules exist now; the database enforces their shape.
	cmType := id()
	exec(`INSERT INTO material_types (id, name, unit) VALUES ($1, 'Sticker paper', 'cm2')`, cmType)
	runID := id()
	exec(
		`INSERT INTO machine_runs (id, display_id, machine_id, source, job_id, started_at, ended_at, history_complete) VALUES ($1, 'R-2026-900010', $2, 'manual', $3, now() - interval '2 hours', now() - interval '1 hour', true)`,
		runID,
		laserMachine,
		job,
	)
	exec(`INSERT INTO machine_run_measures (run_id, measure, value) VALUES ($1, 'stitches', 12400)`, runID)
	if _, err = pool.Exec(
		ctx,
		`INSERT INTO machine_run_measures (run_id, measure, value) VALUES ($1, 'stitches', -1)`,
		runID,
	); err == nil {
		t.Fatal("negative measure accepted")
	}
	if _, err = pool.Exec(
		ctx,
		`INSERT INTO machine_run_measures (run_id, measure, value) VALUES ($1, 'colour_changes', 1)`,
		runID,
	); err == nil {
		t.Fatal("unknown measure accepted")
	}
	group := id()
	exec(`INSERT INTO pricing_groups (id, name) VALUES ($1, 'Process group')`, group)
	exec(
		`INSERT INTO pricing_rules (id, pricing_group_id, kind, machine_type_id, measure, block_size, rate) VALUES ($1, $2, 'machine_measure', $3, 'stitches', 1000, 0.5)`,
		id(),
		group,
		laserType,
	)
	if _, err = pool.Exec(
		ctx,
		`INSERT INTO pricing_rules (id, pricing_group_id, kind, machine_type_id, measure, block_size, rate) VALUES ($1, $2, 'machine_measure', $3, 'stitches', 1000, 0.7)`,
		id(),
		group,
		laserType,
	); err == nil {
		t.Fatal("second active rule for the same measure accepted")
	}
	if _, err = pool.Exec(
		ctx,
		`INSERT INTO pricing_rules (id, pricing_group_id, kind, machine_type_id, rate) VALUES ($1, $2, 'machine_measure', $3, 1)`,
		id(),
		group,
		laserType,
	); err == nil {
		t.Fatal("measure rule without measure accepted")
	}

	// Rolling back restores the flag; cm2 data blocks it.
	down, err := os.ReadFile(from[0])
	if err != nil {
		t.Fatal(err)
	}
	_, downSQL, _ := strings.Cut(string(down), "-- +goose Down")
	downSQL = strings.NewReplacer("-- +goose StatementBegin", "", "-- +goose StatementEnd", "").Replace(downSQL)
	if _, err = pool.Exec(ctx, downSQL); err == nil {
		t.Fatal("downgrade succeeded although a cm2 material type exists")
	}
	exec(`DELETE FROM material_types WHERE id = $1`, cmType)
	if _, err = pool.Exec(ctx, downSQL); err != nil {
		t.Fatalf("down: %v", err)
	}
	assertCount(t, pool, `SELECT count(*) FROM machine_types WHERE printer AND id IN ($1, $2)`, 2, flagged, profiled)
	assertCount(t, pool, `SELECT count(*) FROM machine_types WHERE printer AND id IN ($1, $2)`, 0, plain, laserType)
	assertCount(t, pool, `SELECT count(*) FROM pricing_rules WHERE pricing_group_id = $1`, 0, group)
}
