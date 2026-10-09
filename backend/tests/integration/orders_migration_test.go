package integration_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestOrdersMigrationRoundTripAndPopulatedDowngradeGuard(t *testing.T) {
	pool := emptySchemaPool(t)
	ctx := testContext(t)
	paths := orderedMigrationFiles(t)
	migration := paths[26]
	if filepath.Base(migration) != "00027_orders.sql" {
		t.Fatal(migration)
	}
	applyMigrationFiles(t, pool, paths[:26])
	raw, e := os.ReadFile(migration)
	if e != nil {
		t.Fatal(e)
	}
	up, down, found := strings.Cut(string(raw), "-- +goose Down")
	if !found {
		t.Fatal("missing financial downgrade guard")
	}
	if _, e = pool.Exec(ctx, up); e != nil {
		t.Fatal(e)
	}
	if _, e = pool.Exec(ctx, down); e != nil {
		t.Fatal(e)
	}
	if _, e = pool.Exec(ctx, up); e != nil {
		t.Fatal(e)
	}
	if _, e = pool.Exec(ctx, "INSERT INTO orders(id,reference,customer_kind,fulfillment_mode) VALUES($1,'O-2026-000001','anonymous','immediate')", uuid.Must(uuid.NewV7())); e != nil {
		t.Fatal(e)
	}
	if _, e = pool.Exec(ctx, down); e == nil || !strings.Contains(e.Error(), "cannot downgrade while financial history exists") {
		t.Fatal("populated financial history could be dropped", e)
	}
	applyMigrationFiles(t, pool, paths[27:])
	assertCount(t, pool, "SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='machine_jobs' AND column_name IN ('billing_status','billing_reference')", 0)
	assertCount(t, pool, "SELECT count(*) FROM orders", 1)
}
