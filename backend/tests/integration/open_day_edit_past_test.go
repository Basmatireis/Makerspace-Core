package integration_test

import (
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/inbox"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/opendays"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/roles"
	"github.com/google/uuid"
)

// editPastEnv is a notice environment with people who hold different parts of what a correction of the past needs.
type editPastEnv struct {
	*noticeEnv
	// assigner may assign but not edit the past; corrector may both; pastOnly may edit the past but not assign;
	// leader may manage the schedule and edit the past.
	assigner, corrector, pastOnly, leader authorization.Principal
}

func newEditPastEnv(t *testing.T) *editPastEnv {
	t.Helper()
	e := &editPastEnv{noticeEnv: newNoticeEnv(t)}
	supervisorRole := e.membershipRole(roles.MembershipSupervisor)
	e.assigner = e.person("assigner", supervisorRole.ID,
		e.role("Assigners", nil, authorization.OpenDaysRead, authorization.OpenDaysAssign).ID)
	e.corrector = e.person("corrector", supervisorRole.ID,
		e.role("Correctors", nil, authorization.OpenDaysRead, authorization.OpenDaysAssign, authorization.OpenDaysEditPast).ID)
	e.pastOnly = e.person("past-only", supervisorRole.ID,
		e.role("Past only", nil, authorization.OpenDaysRead, authorization.OpenDaysEditPast).ID)
	e.leader = e.person("leader", supervisorRole.ID,
		e.role("Leitung", nil, authorization.OpenDaysRead, authorization.OpenDaysManage, authorization.OpenDaysEditPast).ID)
	return e
}

func (e *editPastEnv) count(query string, args ...any) int {
	e.t.Helper()
	var n int
	if err := e.pool.QueryRow(testContext(e.t), query, args...).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n
}

func (e *editPastEnv) firings() int {
	e.t.Helper()
	return e.count(`SELECT count(*) FROM notification_firings`)
}

func (e *editPastEnv) assignmentID(day openDayFixture, p authorization.Principal) uuid.UUID {
	e.t.Helper()
	var id uuid.UUID
	if err := e.pool.QueryRow(testContext(e.t),
		`SELECT id FROM open_day_assignments WHERE open_day_id=$1 AND person_id=$2`, day.id, p.PersonID,
	).Scan(&id); err != nil {
		e.t.Fatal(err)
	}
	return id
}

func (e *editPastEnv) staffed(p authorization.Principal) int {
	e.t.Helper()
	result, err := e.supervise.Get(testContext(e.t), e.master, &e.period)
	if err != nil {
		e.t.Fatal(err)
	}
	for _, row := range result.Supervisors {
		if row.PersonID == p.PersonID {
			return row.Counts.Staffed
		}
	}
	e.t.Fatal("person missing from the supervisor dashboard")
	return 0
}

func TestPastOpenDayAssignmentsNeedEditPastAndNotifyNobody(t *testing.T) {
	e := newEditPastEnv(t)
	ctx := testContext(t)
	day := e.openDay(morningIn(e.now, -2), 2*time.Hour, 2, 0)
	e.holdSlot(day, day.timeslot, day.supervisorRequirement, e.bob)
	bobsPlace := e.assignmentID(day, e.bob)
	firings := e.firings()

	// Assigning alone does not reach an ended timeslot, nor does editing the past without open_days.assign.
	for name, p := range map[string]authorization.Principal{"assigner": e.assigner, "past only": e.pastOnly} {
		if _, err := e.opendays.Assign(ctx, p, day.id, day.supervisorRequirement, e.alice.PersonID, nil); !errors.Is(err, apperror.PermissionDenied) {
			t.Fatalf("%s assigning on an ended day: %v", name, err)
		}
		if err := e.opendays.RemoveAssignment(ctx, p, day.id, bobsPlace, nil); !errors.Is(err, apperror.PermissionDenied) {
			t.Fatalf("%s removing on an ended day: %v", name, err)
		}
	}
	// Nobody joins or leaves an ended timeslot themselves, not even with open_days.edit_past.
	_, err := e.opendays.Join(ctx, e.alice, day.id, day.supervisorRequirement, nil)
	requireAppError(t, err, http.StatusConflict, "timeslot_ended")
	requireAppError(t, e.opendays.Leave(ctx, e.bob, day.id, day.timeslot, nil), http.StatusConflict, "timeslot_ended")
	_, err = e.opendays.Join(ctx, e.corrector, day.id, day.supervisorRequirement, nil)
	requireAppError(t, err, http.StatusConflict, "timeslot_ended")

	// The corrector fixes who staffed the day: Alice was there, Bob was not.
	if _, err := e.opendays.Assign(ctx, e.corrector, day.id, day.supervisorRequirement, e.alice.PersonID, nil); err != nil {
		t.Fatal(err)
	}
	if err := e.opendays.RemoveAssignment(ctx, e.corrector, day.id, bobsPlace, nil); err != nil {
		t.Fatal(err)
	}
	if got := e.count(`SELECT count(*) FROM audit_events WHERE action IN ('open_day.person_assigned','open_day.person_unassigned')
		AND metadata->>'openDayId'=$1 AND metadata->>'retroactive'='true'`, day.id.String()); got != 2 {
		t.Fatalf("retroactive audit events = %d, want 2", got)
	}
	if got := e.firings(); got != firings {
		t.Fatalf("a correction of the past raised %d notification firings", got-firings)
	}
	e.expectCount(e.alice, inbox.KindOpenDayAssignedByOther, 0, "alice")
	e.expectCount(e.bob, inbox.KindOpenDayUnassignedByOther, 0, "bob")
	if alice, bob := e.staffed(e.alice), e.staffed(e.bob); alice != 1 || bob != 0 {
		t.Fatalf("staffed after the correction: alice %d, bob %d", alice, bob)
	}

	// An upcoming day still needs only open_days.assign and still tells the person.
	upcoming := e.openDay(morningIn(e.now, 3), 2*time.Hour, 2, 0)
	if _, err := e.opendays.Assign(ctx, e.assigner, upcoming.id, upcoming.supervisorRequirement, e.carol.PersonID, nil); err != nil {
		t.Fatal(err)
	}
	e.expectCount(e.carol, inbox.KindOpenDayAssignedByOther, 1, "carol on an upcoming day")
}

func TestPastOpenDayScheduleChangesNeedEditPast(t *testing.T) {
	e := newEditPastEnv(t)
	ctx := testContext(t)
	start := morningIn(e.now, -2)
	day := e.openDay(start, 2*time.Hour, 2, 0)
	e.holdSlot(day, day.timeslot, day.supervisorRequirement, e.alice)
	slot := day.timeslot
	moved := func() opendays.ScheduleDelta {
		periodVersion, dayVersion := e.versions(day.id)
		return opendays.ScheduleDelta{ExpectedPeriodVersion: periodVersion, Updates: []opendays.ScheduleInput{{
			ID: day.id, ExpectedVersion: dayVersion, Timeslots: []opendays.TimeslotInput{
				{ID: &slot, StartsAt: start.Add(time.Hour), EndsAt: start.Add(3 * time.Hour), Requirements: supervisorPlaces(3)},
			},
		}}}
	}
	created := func() opendays.ScheduleDelta {
		periodVersion, _ := e.versions(day.id)
		other := morningIn(e.now, -5)
		return opendays.ScheduleDelta{ExpectedPeriodVersion: periodVersion, Creates: []opendays.ScheduleInput{{
			Timeslots: []opendays.TimeslotInput{{StartsAt: other, EndsAt: other.Add(2 * time.Hour), Requirements: supervisorPlaces(1)}},
		}}}
	}

	// open_days.manage alone may neither change an ended day nor add one in the past.
	if _, err := e.opendays.SaveSchedule(ctx, e.manager, e.period, moved(), nil); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("manager changing an ended day: %v", err)
	}
	if _, err := e.opendays.SaveSchedule(ctx, e.manager, e.period, created(), nil); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("manager creating a past day: %v", err)
	}
	// open_days.edit_past does not replace open_days.manage.
	if _, err := e.opendays.SaveSchedule(ctx, e.pastOnly, e.period, moved(), nil); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("edit_past without manage: %v", err)
	}

	firings := e.firings()
	if _, err := e.opendays.SaveSchedule(ctx, e.leader, e.period, moved(), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := e.opendays.SaveSchedule(ctx, e.leader, e.period, created(), nil); err != nil {
		t.Fatal(err)
	}
	if got := e.firings(); got != firings {
		t.Fatalf("correcting past days raised %d notification firings", got-firings)
	}
	var startsAt time.Time
	if err := e.pool.QueryRow(ctx, `SELECT starts_at FROM open_days WHERE id=$1`, day.id).Scan(&startsAt); err != nil {
		t.Fatal(err)
	}
	if !startsAt.Equal(start.Add(time.Hour)) {
		t.Fatalf("starts_at = %v", startsAt)
	}
	// The assignment survives the correction and still counts.
	if got := e.staffed(e.alice); got != 1 {
		t.Fatalf("alice staffed = %d", got)
	}
	if got := e.count(`SELECT count(*) FROM audit_events WHERE action='open_day.updated' AND resource_id=$1`, day.id); got != 1 {
		t.Fatalf("open_day.updated audit events = %d", got)
	}

	// Upcoming days stay with open_days.manage alone.
	upcoming := morningIn(e.now, 4)
	periodVersion, _ := e.versions(day.id)
	if _, err := e.opendays.SaveSchedule(ctx, e.manager, e.period, opendays.ScheduleDelta{
		ExpectedPeriodVersion: periodVersion,
		Creates: []opendays.ScheduleInput{{Timeslots: []opendays.TimeslotInput{
			{StartsAt: upcoming, EndsAt: upcoming.Add(2 * time.Hour), Requirements: supervisorPlaces(1)},
		}}},
	}, nil); err != nil {
		t.Fatal(err)
	}
}
