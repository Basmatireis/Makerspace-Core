package integration_test

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
)

// TestAnonymizingVisitsMigrationRollsUpAndDeletes checks 00131: completed and voided visits are rolled into the daily
// statistics and deleted, people keep the date of their last completed visit, open visits and their offers stay with
// the person, and audit events of ordinary check-ins and check-outs are deleted while corrections lose the visit ID.
func TestAnonymizingVisitsMigrationRollsUpAndDeletes(t *testing.T) {
	pool := emptySchemaPool(t)
	ctx := testContext(t)
	const name = "00131_anonymize_visits_at_checkout.sql"
	var before []string
	var migration string
	for _, path := range allMigrationFiles(t) {
		switch {
		case filepath.Base(path) < "00131_":
			before = append(before, path)
		case filepath.Base(path) == name:
			migration = path
		}
	}
	if migration == "" {
		t.Fatal(name + " is missing")
	}
	applyMigrationFiles(t, pool, before)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, query, args...); err != nil {
			t.Fatalf("%v\n%s", err, query)
		}
	}

	ada := seedAccount(t, pool, "migration-ada", false)
	grace := seedAccount(t, pool, "migration-grace", false)
	never := seedAccount(t, pool, "migration-never", false)
	visit := func(person, status, checkedIn, checkedOut string) string {
		id := ids.New().String()
		exec(`INSERT INTO visits(id,person_id,checked_in_at,status,check_in_method,check_in_assurance,admission_decision)
			VALUES($1,$2,$3::timestamptz,'checked_in','supervisor','normal','admitted')`, id, person, checkedIn)
		switch status {
		case "checked_out":
			exec(`UPDATE visits SET status='checked_out', checked_out_at=$2::timestamptz, check_out_method='supervisor' WHERE id=$1`,
				id, checkedOut)
		case "voided":
			exec(`UPDATE visits SET status='voided', correction_reason='duplicate entry' WHERE id=$1`, id)
		}
		return id
	}
	// Ada: two visits on 2026-03-02 (one unique visitor) and one spanning midnight into 2026-03-03.
	first := visit(ada.personID.String(), "checked_out", "2026-03-02T09:00:00Z", "2026-03-02T10:00:00Z")
	visit(ada.personID.String(), "checked_out", "2026-03-02T11:00:00Z", "2026-03-02T11:30:00Z")
	visit(ada.personID.String(), "checked_out", "2026-03-03T23:00:00Z", "2026-03-04T01:00:00Z")
	// Grace: a voided visit and an open one with an unconsumed tablet offer and an invitation of a former check-out.
	voided := visit(grace.personID.String(), "voided", "2026-03-02T09:30:00Z", "")
	open := visit(grace.personID.String(), "checked_in", "2026-03-05T08:00:00Z", "")

	survey, version, device, deviceType := ids.New(), ids.New(), ids.New(), ids.New()
	exec(`INSERT INTO surveys(id,name,anonymous) VALUES($1,'Feedback',false)`, survey)
	exec(`INSERT INTO survey_versions(id,survey_id,revision,title) VALUES($1,$2,1,'Feedback')`, version, survey)
	exec(`INSERT INTO device_types(id,name) VALUES($1,'Tablet')`, deviceType)
	exec(`INSERT INTO managed_devices(id,name,device_type_id,token_digest) VALUES($1,'Tablet',$2,$3)`,
		device, deviceType, bytes.Repeat([]byte{3}, 32))
	offer := ids.New()
	exec(`INSERT INTO survey_offers(id,token_digest,visit_id,device_id,survey_id,survey_version_id,expires_at)
		VALUES($1,$2,$3,$4,$5,$6,now()+interval '10 minutes')`, offer, bytes.Repeat([]byte{4}, 32), open, device, survey, version)
	invitation := ids.New()
	exec(`INSERT INTO survey_invitations(id,survey_version_id,person_id,visit_id,token_digest,due_at,expires_at)
		VALUES($1,$2,$3,$4,$5,now(),now()+interval '14 days')`, invitation, version, ada.personID, first, bytes.Repeat([]byte{5}, 32))

	audit := func(action, resource string) {
		exec(`INSERT INTO audit_events(id,actor_account_id,action,resource_type,resource_id) VALUES($1,$2,$3,'visit',$4)`,
			ids.New(), ada.accountID, action, resource)
	}
	for _, action := range []string{"visit.checked_in", "visit.checked_out", "visit.public_checkout", "visit.supervised_check_in"} {
		audit(action, first)
	}
	audit("visit.supervised_check_out", first)
	audit("survey_offer.email_requested", first)
	audit("visit.voided", voided)
	exec(`INSERT INTO attendance_daily_statistics(day,visitor_count,daily_unique_visitors,visitor_seconds,peak_occupancy)
		VALUES('2026-03-02',4,2,100,3)`)

	content, err := os.ReadFile(migration)
	if err != nil {
		t.Fatal(err)
	}
	up, _, found := strings.Cut(string(content), "-- +goose Down")
	if !found {
		t.Fatal(name + " has no Down section")
	}
	exec(up)

	assertCount(t, pool, `SELECT count(*) FROM visits`, 1)
	assertCount(t, pool, `SELECT count(*) FROM visits WHERE id=$1 AND person_id=$2`, 1, open, grace.personID)
	assertCount(t, pool, `SELECT count(*) FROM people WHERE id=$1 AND last_visit_on='2026-03-03'`, 1, ada.personID)
	assertCount(t, pool, `SELECT count(*) FROM people WHERE id=$1 AND last_visit_on IS NULL`, 1, grace.personID)
	assertCount(t, pool, `SELECT count(*) FROM people WHERE id=$1 AND last_visit_on IS NULL`, 1, never.personID)
	// 2026-03-02: the existing row plus Ada's two visits (one unique visitor, 5400 s, two completed).
	assertCount(t, pool, `SELECT count(*) FROM attendance_daily_statistics WHERE day='2026-03-02' AND visitor_count=6
		AND daily_unique_visitors=3 AND visitor_seconds=5500 AND completed_visit_count=2 AND completed_visit_seconds=5400
		AND peak_occupancy=3`, 1)
	// The visit across midnight: one hour on each day, counted on its check-in and its check-out day.
	assertCount(t, pool, `SELECT count(*) FROM attendance_daily_statistics WHERE day='2026-03-03' AND visitor_count=1
		AND daily_unique_visitors=1 AND visitor_seconds=3600 AND completed_visit_count=0`, 1)
	assertCount(t, pool, `SELECT count(*) FROM attendance_daily_statistics WHERE day='2026-03-04' AND visitor_count=0
		AND visitor_seconds=3600 AND completed_visit_count=1 AND completed_visit_seconds=7200`, 1)

	assertCount(t, pool, `SELECT count(*) FROM survey_offers WHERE id=$1 AND person_id=$2 AND visit_id=$3`, 1,
		offer, grace.personID, open)
	assertCount(t, pool, `SELECT count(*) FROM survey_invitations WHERE id=$1 AND visit_id=$2 AND person_id=$3`, 1,
		invitation, first, ada.personID)

	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action IN
		('visit.checked_in','visit.checked_out','visit.public_checkout','visit.supervised_check_in')`, 0)
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action IN
		('visit.supervised_check_out','visit.voided','survey_offer.email_requested') AND resource_id IS NULL`, 3)

	// An open offer without its person is refused from now on.
	_, err = pool.Exec(ctx, `INSERT INTO survey_offers(id,token_digest,visit_id,device_id,survey_id,survey_version_id,expires_at)
		VALUES($1,$2,$3,$4,$5,$6,now()+interval '10 minutes')`, ids.New(), bytes.Repeat([]byte{6}, 32), open, device, survey, version)
	expectPostgresCode(t, err, "23514")
}
