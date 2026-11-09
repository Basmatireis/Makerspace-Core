package integration_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
)

// TestClearingCarriedOverOpenDayRoleListsKeepsLaterRestrictions checks 00126: role lists of places that existed
// before the membership migration (00109) meant "who may fill the place" and are removed; extra roles set on places
// created afterwards stay.
func TestClearingCarriedOverOpenDayRoleListsKeepsLaterRestrictions(t *testing.T) {
	pool := emptySchemaPool(t)
	ctx := testContext(t)
	var before []string
	var migration string
	for _, path := range allMigrationFiles(t) {
		switch {
		case filepath.Base(path) < "00126_":
			before = append(before, path)
		case filepath.Base(path) == "00126_clear_carried_over_open_day_role_lists.sql":
			migration = path
		}
	}
	if migration == "" {
		t.Fatal("00126_clear_carried_over_open_day_role_lists.sql is missing")
	}
	applyMigrationFiles(t, pool, before)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, query, args...); err != nil {
			t.Fatalf("%v\n%s", err, query)
		}
	}

	role := ids.New()
	exec(`INSERT INTO roles(id,name) VALUES($1,'Workspace Manager')`, role)
	period := ids.New()
	exec(`INSERT INTO open_day_periods(id,name,starts_on,ends_on,status) VALUES($1,'P','2026-01-01','2026-02-01','staffing')`, period)
	place := func(requirement uuid.UUID, date int) {
		day, slot := ids.New(), ids.New()
		exec(`INSERT INTO open_days(id,period_id,starts_at,ends_at) VALUES($1,$2,$3,$4)`, day, period,
			time.Date(2026, 1, date, 10, 0, 0, 0, time.UTC), time.Date(2026, 1, date, 14, 0, 0, 0, time.UTC))
		exec(`INSERT INTO open_day_timeslots(id,open_day_id,starts_at,ends_at,position)
			SELECT $1,id,starts_at,ends_at,0 FROM open_days WHERE id=$2`, slot, day)
		exec(`INSERT INTO open_day_staff_requirements(id,open_day_id,timeslot_id,kind,required_count) VALUES($1,$2,$3,'supervisor',1)`,
			requirement, day, slot)
		exec(`INSERT INTO open_day_staff_requirement_roles(requirement_id,role_id) VALUES($1,$2)`, requirement, role)
	}

	// Without a goose version table nothing tells old places from new ones, so nothing changes.
	early := ids.New()
	place(early, 10)
	content, err := os.ReadFile(migration)
	if err != nil {
		t.Fatal(err)
	}
	up, _, found := strings.Cut(string(content), "-- +goose Down")
	if !found {
		t.Fatal("00126 has no Down section")
	}
	exec(up)
	assertCount(t, pool, `SELECT count(*) FROM open_day_staff_requirement_roles WHERE requirement_id=$1`, 1, early)

	time.Sleep(20 * time.Millisecond)
	exec(`CREATE TABLE goose_db_version (id serial PRIMARY KEY, version_id bigint NOT NULL, is_applied boolean NOT NULL,
		tstamp timestamp DEFAULT now())`)
	exec(`INSERT INTO goose_db_version(version_id,is_applied,tstamp) VALUES(109,true,clock_timestamp())`)
	time.Sleep(20 * time.Millisecond)
	later := ids.New()
	place(later, 11)

	exec(up)
	assertCount(t, pool, `SELECT count(*) FROM open_day_staff_requirement_roles WHERE requirement_id=$1`, 0, early)
	assertCount(t, pool, `SELECT count(*) FROM open_day_staff_requirement_roles WHERE requirement_id=$1`, 1, later)
}
