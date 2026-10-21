package integration_test

import (
	"path/filepath"
	"testing"

	"github.com/google/uuid"
)

// Migration 00062 moves recent automatic connector audit rows into the
// connector activity log, removes all of them from the audit log, keeps staff
// actions, and moves the rows back on rollback.
func TestConnectorActivityMigrationMovesRuntimeAuditRows(t *testing.T) {
	pool := emptySchemaPool(t)
	ctx := testContext(t)
	all, err := filepath.Glob(filepath.Join(filepath.Dir(orderedMigrationFiles(t)[0]), "*.sql"))
	if err != nil {
		t.Fatal(err)
	}
	const target = "00062_connector_activity_and_local_updates.sql"
	var before []string
	migration := ""
	for _, path := range all {
		switch {
		case filepath.Base(path) < "00062_":
			before = append(before, path)
		case filepath.Base(path) == target:
			migration = path
		}
	}
	if migration == "" {
		t.Fatalf("migration %s not found", target)
	}
	applyMigrationFiles(t, pool, before)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, query, args...); err != nil {
			t.Fatalf("%v\n%s", err, query)
		}
	}
	id := func() uuid.UUID { return uuid.Must(uuid.NewV7()) }
	machineType, machine, connector, assignment, event := id(), id(), id(), id(), id()
	exec(`INSERT INTO machine_types (id, name) VALUES ($1, 'Migration printer type')`, machineType)
	exec(`INSERT INTO machines (id, machine_type_id, name) VALUES ($1, $2, 'Migration printer')`, machine, machineType)
	exec(`INSERT INTO printer_profiles (machine_id) VALUES ($1)`, machine)
	exec(`INSERT INTO printer_connectors (id, name) VALUES ($1, 'Migration connector')`, connector)
	exec(
		`INSERT INTO printer_connector_assignments (id, connector_id, machine_id, adapter_kind) VALUES ($1, $2, $3, 'simulator')`,
		assignment,
		connector,
		machine,
	)
	exec(`INSERT INTO printer_events (id, source_id, event_key, fingerprint, protocol_version, machine_id, kind, occurred_at,
			source_sequence, connector_id, connector_assignment_id, configuration_version)
		VALUES ($1, 'connector', 'e1', repeat('a', 64), 1, $2, 'progress', now(), 1, $3, $4, 1)`,
		event, machine, connector, assignment)

	ingested, oldIngested, mounted, orphanJob, staff := id(), id(), id(), id(), id()
	exec(`INSERT INTO audit_events (id, actor_type, action, resource_type, resource_id, changed_fields, source)
		VALUES ($1, 'system', 'printer_event.ingested', 'printer_event', $2, '{kind,state}', 'http')`, ingested, event)
	exec(`INSERT INTO audit_events (id, actor_type, action, resource_type, resource_id, changed_fields, source, occurred_at)
		VALUES ($1, 'system', 'printer_event.ingested', 'printer_event', $2, '{kind,state}', 'http', now() - interval '40 days')`,
		oldIngested, event)
	exec(`INSERT INTO audit_events (id, actor_type, action, resource_type, resource_id, changed_fields, metadata, source)
		VALUES ($1, 'system', 'printer_slot.spool_auto_mounted', 'printer_slot', $2, '{assignment,spoolId}',
			jsonb_build_object('connectorId', $3::text), 'system')`, mounted, id(), connector.String())
	// The connector of this row no longer exists: it leaves the audit log without an activity entry.
	exec(`INSERT INTO audit_events (id, actor_type, action, resource_type, resource_id, changed_fields, metadata)
		VALUES ($1, 'system', 'machine_job.recorded_run_updated', 'machine_job', $2, '{runs}',
			jsonb_build_object('connectorId', $3::text))`, orphanJob, id(), id().String())
	exec(`INSERT INTO audit_events (id, actor_type, action, resource_type, resource_id, source)
		VALUES ($1, 'system', 'printer_connector.created', 'printer_connector', $2, 'admin_cli')`, staff, connector)

	applyMigrationFiles(t, pool, []string{migration})

	type entry struct {
		kind      string
		machineID *uuid.UUID
		eventKind *string
	}
	entries := map[uuid.UUID]entry{}
	rows, err := pool.Query(ctx, `SELECT id, kind, machine_id, event_kind FROM printer_connector_activity WHERE connector_id = $1`, connector)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var key uuid.UUID
		var value entry
		if err = rows.Scan(&key, &value.kind, &value.machineID, &value.eventKind); err != nil {
			t.Fatal(err)
		}
		entries[key] = value
	}
	rows.Close()
	if len(entries) != 2 {
		t.Fatalf("activity entries: %+v", entries)
	}
	if got := entries[ingested]; got.kind != "event_ingested" || got.machineID == nil || *got.machineID != machine ||
		got.eventKind == nil || *got.eventKind != "progress" {
		t.Fatalf("ingested entry: %+v", got)
	}
	if got := entries[mounted]; got.kind != "spool_auto_mounted" || got.machineID != nil {
		t.Fatalf("mounted entry: %+v", got)
	}
	var remaining []string
	if err = pool.QueryRow(ctx, `SELECT coalesce(array_agg(action ORDER BY action), '{}') FROM audit_events`).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if len(remaining) != 1 || remaining[0] != "printer_connector.created" {
		t.Fatalf("audit actions after the migration: %v", remaining)
	}

	if err = rollbackMigration(t, pool, migration); err != nil {
		t.Fatal(err)
	}
	var restored int
	if err = pool.QueryRow(
		ctx,
		`SELECT count(*) FROM audit_events WHERE (id = $1 AND action = 'printer_event.ingested' AND resource_id = $3)
			OR (id = $2 AND action = 'printer_slot.spool_auto_mounted' AND metadata->>'connectorId' = $4::text)`,
		ingested,
		mounted,
		event,
		connector.String(),
	).Scan(&restored); err != nil || restored != 2 {
		t.Fatalf("restored audit rows: %d %v", restored, err)
	}
	var tableExists bool
	if err = pool.QueryRow(ctx, `SELECT to_regclass('printer_connector_activity') IS NOT NULL`).Scan(&tableExists); err != nil ||
		tableExists {
		t.Fatalf("activity table after rollback: %v %v", tableExists, err)
	}
}
