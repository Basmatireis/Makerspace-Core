package integration_test

import (
	"errors"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/attendance"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

type dailyStatistics struct {
	visitors, unique, seconds, completed, completedSeconds, peak int64
}

func (e *checkoutEnv) today() dailyStatistics {
	e.t.Helper()
	var s dailyStatistics
	err := e.pool.QueryRow(e.ctx, `
		SELECT COALESCE(sum(visitor_count), 0), COALESCE(sum(daily_unique_visitors), 0), COALESCE(sum(visitor_seconds), 0),
		       COALESCE(sum(completed_visit_count), 0), COALESCE(sum(completed_visit_seconds), 0), COALESCE(max(peak_occupancy), 0)
		FROM attendance_daily_statistics WHERE day = (now() AT TIME ZONE 'UTC')::date`).
		Scan(&s.visitors, &s.unique, &s.seconds, &s.completed, &s.completedSeconds, &s.peak)
	if err != nil {
		e.t.Fatal(err)
	}
	return s
}

// expectNoTrace asserts that nothing about the person's visits is left: no visit row and no audit event that names
// the visit, the person or one of the person's accounts.
func (e *checkoutEnv) expectNoTrace(label string, account seededAccount, visitIDs ...uuid.UUID) {
	e.t.Helper()
	if n := e.count(`SELECT count(*) FROM visits WHERE person_id = $1`, account.personID); n != 0 {
		e.t.Fatalf("%s: %d visit rows left for the person", label, n)
	}
	for _, id := range visitIDs {
		if n := e.count(`SELECT count(*) FROM visits WHERE id = $1`, id); n != 0 {
			e.t.Fatalf("%s: visit %s still exists", label, id)
		}
	}
	ids := make([]string, len(visitIDs))
	for i, id := range visitIDs {
		ids[i] = id.String()
	}
	if n := e.count(`
		SELECT count(*) FROM audit_events
		WHERE (resource_type = 'visit' AND resource_id IS NOT NULL)
		   OR resource_id::text = ANY($1::text[]) OR resource_id = $2
		   OR (action LIKE 'visit.%' AND actor_account_id = $3)
		   OR metadata::text LIKE '%' || $2::text || '%'`,
		ids, account.personID, account.accountID); n != 0 {
		var actions []string
		rows, _ := e.pool.Query(e.ctx, `SELECT action FROM audit_events ORDER BY occurred_at`)
		for rows.Next() {
			var action string
			_ = rows.Scan(&action)
			actions = append(actions, action)
		}
		rows.Close()
		e.t.Fatalf("%s: %d audit events refer to the visit or the person (all actions: %v)", label, n, actions)
	}
}

func (e *checkoutEnv) lastVisitIsToday(account seededAccount) bool {
	e.t.Helper()
	return e.count(`SELECT count(*) FROM people WHERE id = $1 AND last_visit_on = (now() AT TIME ZONE 'UTC')::date`,
		account.personID) == 1
}

// Check-out keeps nothing personal: the visit is rolled into the daily statistics and deleted in the same
// transaction, the person keeps only the date of the last visit, and ordinary check-ins and check-outs write no
// audit event. Only corrections by the team are audited, without the visit or the person.
func TestCheckOutAnonymizesTheVisit(t *testing.T) {
	e := newCheckoutEnv(t, false)
	tap := e.newDevice("Tap tablet", false, true)
	before := e.today()

	// Self check-out at the kiosk, with a survey offer that must keep working after the visit is gone.
	a, aVisit := e.person("anon-a", true, e.device.Device.ID)
	if e.count(`SELECT count(*) FROM people WHERE id = $1 AND last_visit_on IS NULL`, a.personID) != 1 {
		t.Fatal("a new person already has a last visit date")
	}
	visit := e.selfCheckOut(a, e.device)
	if visit.ID != aVisit || visit.Status != attendance.VisitCheckedOut || visit.CheckedOutAt == nil {
		t.Fatalf("check-out answer = %+v", visit)
	}
	e.expectNoTrace("self check-out", a, aVisit)
	if !e.lastVisitIsToday(a) {
		t.Fatal("last_visit_on was not set to the check-in day")
	}
	after := e.today()
	if after.visitors != before.visitors+1 || after.unique != before.unique+1 || after.completed != before.completed+1 ||
		after.seconds < before.seconds+59 || after.completedSeconds < before.completedSeconds+59 || after.peak < 1 {
		t.Fatalf("daily statistics after the first check-out: before %+v, after %+v", before, after)
	}
	if visit.SurveyOffer == nil {
		t.Fatal("the survey offer needs the person, not the visit")
	}
	if e.count(`SELECT count(*) FROM survey_offers WHERE person_id = $1 AND consumed_at IS NULL`, a.personID) != 1 {
		t.Fatal("the open offer does not carry the person")
	}
	// Sending the survey by e-mail needs the person behind the offer after the visit is gone.
	if err := e.svc.SendOfferedByEmail(e.ctx, e.device.Device.ID, visit.SurveyOffer.Token, nil); err != nil {
		t.Fatalf("sending the offer by e-mail after the visit was deleted: %v", err)
	}
	if e.count(`SELECT count(*) FROM survey_invitations WHERE person_id = $1 AND recipient_email IS NOT NULL
		AND status = 'pending' AND due_at <= now()`, a.personID) != 1 ||
		e.count(`SELECT count(*) FROM survey_offers WHERE person_id IS NOT NULL`) != 0 {
		t.Fatal("the offer did not reach the person or kept the person after it was consumed")
	}

	// A second visit on the same day counts as a visit, not as another unique visitor.
	second := e.checkIn(a, e.device.Device.ID)
	e.selfCheckOut(a, e.device)
	e.expectNoTrace("second check-out", a, aVisit, second)
	again := e.today()
	if again.visitors != after.visitors+1 || again.unique != after.unique || again.completed != after.completed+1 {
		t.Fatalf("daily statistics after the second check-out: before %+v, after %+v", after, again)
	}

	// Tapping a name and a supervisor's check-out anonymize the same way; the supervisor's is audited as a
	// correction without the visit.
	b, bVisit := e.person("anon-b", false, tap.Device.ID)
	if _, err := e.attendance.PublicCheckOut(e.ctx, e.deviceContext(tap), bVisit, nil); err != nil {
		t.Fatal(err)
	}
	e.expectNoTrace("tap check-out", b, bVisit)
	if !e.lastVisitIsToday(b) {
		t.Fatal("tap check-out did not set last_visit_on")
	}
	supervisor := e.supervisor()
	c, cVisit := e.person("anon-c", false, e.device.Device.ID)
	if _, err := e.attendance.SupervisedCheckOut(e.ctx, supervisor, cVisit, nil); err != nil {
		t.Fatal(err)
	}
	e.expectNoTrace("supervised check-out", c, cVisit)
	if n := e.count(`SELECT count(*) FROM audit_events WHERE action = 'visit.supervised_check_out'
		AND actor_account_id = $1 AND resource_id IS NULL AND metadata = '{}'::jsonb`, supervisor.AccountID); n != 1 {
		t.Fatalf("supervised check-out audit events without the visit = %d, want 1", n)
	}
	if n := e.count(`SELECT count(*) FROM audit_events WHERE action IN
		('visit.checked_in', 'visit.checked_out', 'visit.public_checkout', 'visit.supervised_check_in')`); n != 0 {
		t.Fatalf("%d ordinary check-in or check-out audit events", n)
	}

	// Voiding deletes an open visit; it adds nothing to the statistics and its audit event names no visit.
	d, dVisit := e.person("anon-d", false, e.device.Device.ID)
	beforeVoid := e.today()
	voided, err := e.attendance.Void(e.ctx, supervisor, dVisit, 1, "Checked in by mistake", nil)
	if err != nil || voided.Status != attendance.VisitVoided {
		t.Fatalf("void = %+v, %v", voided, err)
	}
	e.expectNoTrace("void", d, dVisit)
	if e.count(`SELECT count(*) FROM people WHERE id = $1 AND last_visit_on IS NULL`, d.personID) != 1 {
		t.Fatal("a voided visit set last_visit_on")
	}
	if afterVoid := e.today(); afterVoid.visitors != beforeVoid.visitors || afterVoid.completed != beforeVoid.completed {
		t.Fatalf("voiding changed the statistics: %+v -> %+v", beforeVoid, afterVoid)
	}
	if n := e.count(`SELECT count(*) FROM audit_events WHERE action = 'visit.voided' AND resource_id IS NULL
		AND actor_account_id = $1 AND metadata = '{}'::jsonb AND changed_fields = '{}'`, supervisor.AccountID); n != 1 {
		t.Fatalf("void audit events without the visit = %d, want 1", n)
	}
	if _, err := e.attendance.Void(e.ctx, supervisor, aVisit, 1, "Too late", nil); !errors.Is(err, apperror.NotFound) {
		t.Fatalf("voiding a completed visit: %v, want not found", err)
	}

	// Reading attendance does not allow voiding, and nothing else allows listing.
	reader, _ := principalWithPermissions(t, e.pool, "attendance-reader", string(authorization.AttendanceRead))
	_, open := e.person("anon-f", false, e.device.Device.ID)
	if _, err := e.attendance.Void(e.ctx, reader, open, 1, "No", nil); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("void with attendance.read only: %v", err)
	}
	if _, err := e.attendance.List(e.ctx, authorization.Principal{AccountID: d.accountID, PersonID: d.personID}); !errors.Is(
		err, apperror.PermissionDenied) {
		t.Fatalf("list without attendance.read: %v", err)
	}
	if _, err := e.attendance.Void(e.ctx, supervisor, open, 1, "Mistake", nil); err != nil {
		t.Fatal(err)
	}

	// The staff list and the statistics show open visits only, and the statistics include today's completed ones.
	if _, open := e.person("anon-e", false, e.device.Device.ID); open == uuid.Nil {
		t.Fatal("no open visit")
	}
	listed, err := e.attendance.List(e.ctx, supervisor)
	if err != nil || len(listed) != 1 || listed[0].Status != attendance.VisitCheckedIn {
		t.Fatalf("list = %+v, %v", listed, err)
	}
}
