package integration_test

import (
	"errors"
	"path/filepath"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/jackc/pgx/v5/pgconn"
)

// Migration 00103 turns the free-text variants of articles into variants of their material types, lets material
// pricing rules price one variant, and rolls back while no rule or job snapshot uses a variant.
func TestMaterialTypeVariantsMigrationBackfillsArticleVariants(t *testing.T) {
	pool := emptySchemaPool(t)
	ctx := testContext(t)
	paths, err := filepath.Glob(filepath.Join(filepath.Dir(orderedMigrationFiles(t)[0]), "*.sql"))
	if err != nil {
		t.Fatal(err)
	}
	index := -1
	for i, path := range paths {
		if filepath.Base(path) == "00103_material_type_variants.sql" {
			index = i
		}
	}
	if index < 0 {
		t.Fatal("migration 00103 not found")
	}
	applyMigrationFiles(t, pool, paths[:index])
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
	sqlState := func(err error) string {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) {
			return pgErr.Code
		}
		return errorString(err)
	}

	pla, bolts := ids.New(), ids.New()
	exec(`INSERT INTO material_types (id, name, unit, kind, code) VALUES ($1, 'PLA', 'g', 'filament', 'PLA'),
		($2, 'Bolts', 'piece', 'part', 'BOLT')`, pla, bolts)
	basic, basicLower, silk, plain, insert, matte := ids.New(), ids.New(), ids.New(), ids.New(), ids.New(), ids.New()
	exec(`INSERT INTO materials (id, display_id, name, unit, material_type_id, variant, created_at, deleted_at) VALUES
		($1, 'A-0001', 'PLA Basic Red', 'g', $7, 'Basic', now() - interval '5 hours', NULL),
		($2, 'A-0002', 'PLA basic Blue', 'g', $7, 'basic', now() - interval '4 hours', NULL),
		($3, 'A-0003', 'PLA Silk Gold', 'g', $7, 'Silk', now() - interval '3 hours', NULL),
		($4, 'A-0004', 'PLA Grey', 'g', $7, NULL, now() - interval '2 hours', NULL),
		($5, 'A-0005', 'M3 bolt', 'piece', $8, 'M3', now() - interval '1 hour', NULL),
		($6, 'A-0006', 'PLA Matte Black', 'g', $7, 'Matte', now() - interval '30 minutes', now())`,
		basic, basicLower, silk, plain, insert, matte, pla, bolts)
	group := ids.New()
	exec(`INSERT INTO pricing_groups (id, name) VALUES ($1, 'Members')`, group)
	exec(`INSERT INTO pricing_rules (id, pricing_group_id, kind, material_type_id, material_unit, rate)
		VALUES ($1, $2, 'material', $3, 'g', 0.05)`, ids.New(), group, pla)

	applyMigrationFiles(t, pool, paths[index:index+1])

	// One variant per type and name ignoring case, spelled like its earliest article; parts get none.
	count(`SELECT count(*) FROM material_type_variants WHERE material_type_id = $1`, 3, pla)
	count(`SELECT count(*) FROM material_type_variants WHERE material_type_id = $1 AND name IN ('Basic', 'Silk', 'Matte')`, 3, pla)
	count(`SELECT count(*) FROM material_type_variants WHERE material_type_id = $1`, 0, bolts)
	count(`SELECT count(*) FROM materials a JOIN materials b ON a.variant_id = b.variant_id
		WHERE a.id = $1 AND b.id = $2 AND b.variant = 'Basic'`, 1, basic, basicLower)
	count(`SELECT count(*) FROM materials WHERE id = $1 AND variant_id IS NOT NULL`, 1, matte)
	count(`SELECT count(*) FROM materials WHERE id IN ($1, $2) AND variant IS NULL AND variant_id IS NULL`, 2, plain, insert)
	count(`SELECT count(*) FROM materials WHERE name = 'PLA basic Blue'`, 1)

	// The type rule stays; a variant rule coexists with it and is unique per group, type and variant.
	var basicVariant string
	if err := pool.QueryRow(ctx, `SELECT variant_id::text FROM materials WHERE id = $1`, basic).Scan(&basicVariant); err != nil {
		t.Fatal(err)
	}
	variantRule := ids.New()
	exec(`INSERT INTO pricing_rules (id, pricing_group_id, kind, material_type_id, material_unit, material_type_variant_id, rate)
		VALUES ($1, $2, 'material', $3, 'g', $4, 0.07)`, variantRule, group, pla, basicVariant)
	_, err = pool.Exec(ctx, `INSERT INTO pricing_rules (id, pricing_group_id, kind, material_type_id, material_unit,
		material_type_variant_id, rate) VALUES ($1, $2, 'material', $3, 'g', $4, 0.08)`, ids.New(), group, pla, basicVariant)
	if sqlState(err) != "23505" {
		t.Fatalf("second active rule of a variant: %v", err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO pricing_rules (id, pricing_group_id, kind, material_type_id, material_unit, rate)
		VALUES ($1, $2, 'material', $3, 'g', 0.08)`, ids.New(), group, pla)
	if sqlState(err) != "23505" {
		t.Fatalf("second active type rule: %v", err)
	}
	// An article's variant belongs to its type.
	_, err = pool.Exec(ctx, `UPDATE materials SET variant_id = $1, variant = 'Basic' WHERE id = $2`, basicVariant, insert)
	if sqlState(err) != "23503" {
		t.Fatalf("variant of another type: %v", err)
	}

	if err = rollbackMigration(t, pool, paths[index]); err == nil {
		t.Fatal("rolled back while a pricing rule prices a variant")
	}
	exec(`DELETE FROM pricing_rules WHERE id = $1`, variantRule)
	if err = rollbackMigration(t, pool, paths[index]); err != nil {
		t.Fatalf("roll back: %v", err)
	}
	count(`SELECT count(*) FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'material_type_variants'`, 0)
	count(`SELECT count(*) FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'pricing_rules_active_material_idx'`, 1)
	count(`SELECT count(*) FROM materials WHERE variant = 'Basic'`, 2)
	applyMigrationFiles(t, pool, paths[index:index+1])
	count(`SELECT count(*) FROM material_type_variants`, 3)
}
