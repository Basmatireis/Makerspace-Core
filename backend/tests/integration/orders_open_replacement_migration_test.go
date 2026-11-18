package integration_test

import (
	"path/filepath"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
)

// TestOpenReplacementMigrationKeepsNewestDraft checks 00143: of several open replacement drafts of one original only
// the newest stays a draft, older ones are cancelled, other drafts are untouched, and a second open draft is refused.
func TestOpenReplacementMigrationKeepsNewestDraft(t *testing.T) {
	pool := emptySchemaPool(t)
	ctx := testContext(t)
	const name = "00143_one_open_replacement_draft.sql"
	var before []string
	var migration string
	for _, path := range allMigrationFiles(t) {
		switch {
		case filepath.Base(path) < "00143_":
			before = append(before, path)
		case filepath.Base(path) == name:
			migration = path
		}
	}
	if migration == "" {
		t.Fatal(name + " is missing")
	}
	applyMigrationFiles(t, pool, before)
	original, older, newest, other := ids.New(), ids.New(), ids.New(), ids.New()
	if _, e := pool.Exec(
		ctx,
		`INSERT INTO orders(id,reference,customer_kind) VALUES($1,'O-2026-000001','anonymous');
		INSERT INTO orders(id,reference,customer_kind,replaces_order_id,replaces_order_reference,created_at)
		VALUES($2,'O-2026-000002','anonymous',$1,'O-2026-000001',now()-interval '1 day'),
		($3,'O-2026-000003','anonymous',$1,'O-2026-000001',now()),
		($4,'O-2026-000004','anonymous',NULL,NULL,now()-interval '2 days')`,
		original,
		older,
		newest,
		other,
	); e != nil {
		t.Fatal(e)
	}
	applyMigrationFiles(t, pool, []string{migration})
	assertCount(t, pool, "SELECT count(*) FROM orders WHERE id=$1 AND status='cancelled' AND cancelled_at IS NOT NULL AND version=2", 1, older)
	assertCount(
		t,
		pool,
		"SELECT count(*) FROM orders WHERE id IN ($1,$2,$3) AND status='draft'",
		3,
		original,
		newest,
		other,
	)
	if _, e := pool.Exec(
		ctx,
		`INSERT INTO orders(id,reference,customer_kind,replaces_order_id,replaces_order_reference)
		VALUES($1,'O-2026-000005','anonymous',$2,'O-2026-000001')`,
		ids.New(),
		original,
	); e == nil {
		t.Fatal("second open replacement draft accepted")
	}
}
