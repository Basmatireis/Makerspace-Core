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

// Migration 00060 folds the six event statuses into four, reduces tasks to open/done with an importance flag and
// grants the new self-signup and helper-name permissions to the roles that already have their Open Day or staffing
// counterparts. Its Down restores the old constraints and columns.
func TestEventsRedesignMigrationMapsOldValuesAndGrants(t *testing.T) {
	pool := emptySchemaPool(t)
	ctx := testContext(t)
	var before []string
	var migration string
	for _, path := range allMigrationFiles(t) {
		switch {
		case filepath.Base(path) < "00060_":
			before = append(before, path)
		case filepath.Base(path) == "00060_events_redesign.sql":
			migration = path
		}
	}
	if migration == "" {
		t.Fatal("00060_events_redesign.sql is missing")
	}
	applyMigrationFiles(t, pool, before)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, query, args...); err != nil {
			t.Fatalf("%v\n%s", err, query)
		}
	}
	publicID := func(letter string) string { return strings.Repeat(letter, 43) }

	planning, archived, confirmed, cancelled := ids.New(), ids.New(), ids.New(), ids.New()
	closedAt := time.Date(2026, time.March, 3, 18, 0, 0, 0, time.UTC)
	exec(`INSERT INTO events(id,name,public_id,status) VALUES($1,'Planned',$2,'planning')`, planning, publicID("P"))
	exec(
		`INSERT INTO events(id,name,public_id,status,closed_at) VALUES($1,'Archived',$2,'archived',$3)`,
		archived, publicID("A"), closedAt,
	)
	exec(`INSERT INTO events(id,name,public_id,status,is_public) VALUES($1,'Confirmed',$2,'confirmed',true)`,
		confirmed, publicID("C"))
	exec(`INSERT INTO events(id,name,public_id,status,closed_at) VALUES($1,'Cancelled',$2,'cancelled',$3)`,
		cancelled, publicID("X"), closedAt)

	inProgress, blocked, cancelledTask, done, low := ids.New(), ids.New(), ids.New(), ids.New(), ids.New()
	taskUpdatedAt := time.Date(2026, time.February, 1, 10, 0, 0, 0, time.UTC)
	exec(`INSERT INTO event_tasks(id,event_id,title,status,priority) VALUES($1,$2,'Posters','in_progress','high')`,
		inProgress, planning)
	exec(`INSERT INTO event_tasks(id,event_id,title,status,priority) VALUES($1,$2,'Permit','blocked','urgent')`,
		blocked, planning)
	exec(
		`INSERT INTO event_tasks(id,event_id,title,status,priority,updated_at) VALUES($1,$2,'Flyers','cancelled','low',$3)`,
		cancelledTask, planning, taskUpdatedAt,
	)
	exec(
		`INSERT INTO event_tasks(id,event_id,title,status,priority,completed_at) VALUES($1,$2,'Budget','done','normal',now())`,
		done, planning,
	)
	exec(`INSERT INTO event_tasks(id,event_id,title,status,priority) VALUES($1,$2,'Snacks','open','low')`,
		low, planning)

	// Grants: Open Day signup and helper names (the latter restricted to one device type and strong assurance),
	// two staffing permissions on one role (one new grant), and a role that has nothing to do with events.
	members, coordinators, finance, deviceType := ids.New(), ids.New(), ids.New(), ids.New()
	exec(`INSERT INTO roles(id,name) VALUES($1,'Members'),($2,'Coordinators'),($3,'Finance')`,
		members, coordinators, finance)
	exec(`INSERT INTO device_types(id,name) VALUES($1,'Front terminal')`, deviceType)
	restricted := ids.New()
	exec(`INSERT INTO role_permission_grants(id,role_id,permission_id) VALUES(uuidv7(),$1,'open_days.signup')`, members)
	exec(
		`INSERT INTO role_permission_grants(id,role_id,permission_id,scope,minimum_assurance)
		 VALUES($1,$2,'open_days.read_assignments','device_type','strong')`,
		restricted, members,
	)
	exec(`INSERT INTO role_permission_grant_device_types(grant_id,device_type_id) VALUES($1,$2)`, restricted, deviceType)
	exec(`INSERT INTO role_permission_grants(id,role_id,permission_id) VALUES(uuidv7(),$1,'events.staffing.manage'),
		(uuidv7(),$1,'events.assign')`, coordinators)
	exec(`INSERT INTO role_permission_grants(id,role_id,permission_id) VALUES(uuidv7(),$1,'payments.read')`, finance)

	content, err := os.ReadFile(migration)
	if err != nil {
		t.Fatal(err)
	}
	up, down, found := strings.Cut(string(content), "-- +goose Down")
	if !found {
		t.Fatal("00060 has no Down section")
	}
	exec(up)

	statusOf := func(id uuid.UUID) (string, *time.Time, bool) {
		t.Helper()
		var status string
		var closed *time.Time
		var public bool
		if err := pool.QueryRow(ctx, `SELECT status,closed_at,is_public FROM events WHERE id=$1`, id).
			Scan(&status, &closed, &public); err != nil {
			t.Fatal(err)
		}
		return status, closed, public
	}
	if status, closed, _ := statusOf(planning); status != "draft" || closed != nil {
		t.Fatalf("planning event = %s closed=%v", status, closed)
	}
	if status, closed, public := statusOf(archived); status != "completed" || closed == nil ||
		!closed.Equal(closedAt) || public {
		t.Fatalf("archived event = %s closed=%v public=%v", status, closed, public)
	}
	if status, _, public := statusOf(confirmed); status != "confirmed" || !public {
		t.Fatalf("confirmed event = %s public=%v", status, public)
	}
	if status, _, _ := statusOf(cancelled); status != "cancelled" {
		t.Fatalf("cancelled event = %s", status)
	}
	// closed_at is set exactly for closed events.
	if _, err := pool.Exec(ctx, `UPDATE events SET closed_at=now() WHERE id=$1`, planning); err == nil {
		t.Fatal("a draft accepted closed_at")
	}
	if _, err := pool.Exec(ctx, `UPDATE events SET status='planning' WHERE id=$1`, planning); err == nil {
		t.Fatal("the removed planning status is still accepted")
	}

	taskOf := func(id uuid.UUID) (string, bool, *time.Time) {
		t.Helper()
		var status string
		var important bool
		var completed *time.Time
		if err := pool.QueryRow(ctx, `SELECT status,important,completed_at FROM event_tasks WHERE id=$1`, id).
			Scan(&status, &important, &completed); err != nil {
			t.Fatal(err)
		}
		return status, important, completed
	}
	if status, important, completed := taskOf(inProgress); status != "open" || !important || completed != nil {
		t.Fatalf("in-progress task = %s important=%v completed=%v", status, important, completed)
	}
	if status, important, _ := taskOf(blocked); status != "open" || !important {
		t.Fatalf("blocked task = %s important=%v", status, important)
	}
	if status, important, completed := taskOf(cancelledTask); status != "done" || important || completed == nil ||
		!completed.Equal(taskUpdatedAt) {
		t.Fatalf("cancelled task = %s important=%v completed=%v", status, important, completed)
	}
	if status, important, completed := taskOf(done); status != "done" || important || completed == nil {
		t.Fatalf("done task = %s important=%v completed=%v", status, important, completed)
	}
	if status, important, _ := taskOf(low); status != "open" || important {
		t.Fatalf("open task = %s important=%v", status, important)
	}
	if _, err := pool.Exec(ctx, `UPDATE event_tasks SET status='done' WHERE id=$1`, low); err == nil {
		t.Fatal("a done task without completion time was accepted")
	}

	assertCount(t, pool, `SELECT count(*) FROM role_permission_grants WHERE role_id=$1 AND permission_id='events.signup'
		AND scope='global'`, 1, members)
	assertCount(t, pool, `SELECT count(*) FROM role_permission_grants g
		JOIN role_permission_grant_device_types d ON d.grant_id=g.id
		WHERE g.role_id=$1 AND g.permission_id='events.read_assignments' AND g.scope='device_type'
		  AND g.minimum_assurance='strong' AND d.device_type_id=$2`, 1, members, deviceType)
	assertCount(t, pool, `SELECT count(*) FROM role_permission_grants WHERE role_id=$1
		AND permission_id='events.read_assignments'`, 1, coordinators)
	assertCount(t, pool, `SELECT count(*) FROM role_permission_grants WHERE role_id=$1
		AND permission_id IN ('events.signup','events.read_assignments')`, 0, finance)
	assertCount(t, pool, `SELECT count(*) FROM role_permission_grants WHERE role_id=$1
		AND permission_id='events.signup'`, 0, coordinators)

	exec(down)
	if status, _, _ := statusOf(archived); status != "completed" {
		t.Fatalf("archived event after Down = %s", status)
	}
	var priority string
	if err := pool.QueryRow(ctx, `SELECT priority FROM event_tasks WHERE id=$1`, inProgress).Scan(&priority); err != nil {
		t.Fatal(err)
	}
	if priority != "high" {
		t.Fatalf("important task priority after Down = %s", priority)
	}
	assertCount(t, pool, `SELECT count(*) FROM role_permission_grants
		WHERE permission_id IN ('events.signup','events.read_assignments')`, 0)
	exec(`UPDATE events SET status='planning' WHERE id=$1`, planning)
	exec(`UPDATE event_tasks SET status='blocked' WHERE id=$1`, low)

	exec(`UPDATE event_tasks SET status='open' WHERE id=$1`, low)
	exec(up)
	if status, _, _ := statusOf(planning); status != "draft" {
		t.Fatalf("planning event after second Up = %s", status)
	}
}
