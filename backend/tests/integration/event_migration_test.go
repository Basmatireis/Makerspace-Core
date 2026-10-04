package integration_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestEventMigrationUpDownUpAndGuardedDown(t *testing.T) {
	pool := emptySchemaPool(t)
	ctx := testContext(t)
	paths := orderedMigrationFiles(t)
	eventMigration := paths[24]
	if filepath.Base(eventMigration) != "00025_event_management.sql" {
		t.Fatalf("migration 25 = %s, want 00025_event_management.sql", filepath.Base(eventMigration))
	}
	applyMigrationFiles(t, pool, paths[:24])
	content, err := os.ReadFile(eventMigration)
	if err != nil {
		t.Fatal(err)
	}
	up, down, found := strings.Cut(string(content), "-- +goose Down")
	if !found {
		t.Fatal("00025 has no Down section")
	}
	if _, err = pool.Exec(ctx, up); err != nil {
		t.Fatalf("first up: %v", err)
	}
	assertCount(t, pool, `SELECT count(*) FROM pg_tables WHERE schemaname=current_schema() AND tablename LIKE 'event%'`, 9)
	if _, err = pool.Exec(ctx, down); err != nil {
		t.Fatalf("empty down: %v", err)
	}
	if _, err = pool.Exec(ctx, up); err != nil {
		t.Fatalf("second up: %v", err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO events(id,name,public_id) VALUES($1,'Guarded event',$2)`, uuid.Must(uuid.NewV7()), strings.Repeat("A", 43)); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, down); err == nil || !strings.Contains(err.Error(), "cannot drop Event Management tables") {
		t.Fatalf("guarded down error = %v", err)
	}
}

func TestEventBannerMigrationUpDownUpAndGuardedDown(t *testing.T) {
	pool := emptySchemaPool(t)
	ctx := testContext(t)
	paths := orderedMigrationFiles(t)
	bannerMigration := paths[25]
	if filepath.Base(bannerMigration) != "00026_event_banner.sql" {
		t.Fatalf("migration 26 = %s, want 00026_event_banner.sql", filepath.Base(bannerMigration))
	}
	applyMigrationFiles(t, pool, paths[:25])
	content, err := os.ReadFile(bannerMigration)
	if err != nil {
		t.Fatal(err)
	}
	up, down, found := strings.Cut(string(content), "-- +goose Down")
	if !found {
		t.Fatal("00026 has no Down section")
	}
	if _, err = pool.Exec(ctx, up); err != nil {
		t.Fatalf("first up: %v", err)
	}
	assertCount(t, pool, `SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='event_files' AND column_name='is_banner'`, 1)
	if _, err = pool.Exec(ctx, down); err != nil {
		t.Fatalf("empty down: %v", err)
	}
	if _, err = pool.Exec(ctx, up); err != nil {
		t.Fatalf("second up: %v", err)
	}
	eventID, fileID, eventFileID := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	if _, err = pool.Exec(ctx, `INSERT INTO events(id,name,public_id) VALUES($1,'Banner event',$2)`, eventID, strings.Repeat("B", 43)); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO files(id,storage_key,original_filename,content_type,size_bytes,sha256) VALUES($1,$2,'banner.png','image/png',8,$3)`, fileID, "event-banner-test", make([]byte, 32)); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO event_files(id,event_id,file_id,visibility,is_banner) VALUES($1,$2,$3,'public',true)`, eventFileID, eventID, fileID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, down); err == nil || !strings.Contains(err.Error(), "cannot remove Event banner support") {
		t.Fatalf("guarded down error = %v", err)
	}
}
