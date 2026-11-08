package integration_test

import (
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/inbox"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/opendays"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/people"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/roles"
	"github.com/google/uuid"
)

// noticeEnv is an inbox environment with a manager and three supervisors.
type noticeEnv struct {
	*inboxEnv
	manager, alice, bob, carol authorization.Principal
}

func newNoticeEnv(t *testing.T) *noticeEnv {
	t.Helper()
	e := &noticeEnv{inboxEnv: newInboxEnv(t)}
	supervisorRole := e.role("", level(roles.MembershipSupervisor),
		authorization.OpenDaysRead, authorization.OpenDaysSignup)
	e.manager = e.person("manager", supervisorRole.ID,
		e.role("Open day managers", nil, authorization.OpenDaysManage, authorization.OpenDaysAssign).ID)
	e.alice = e.person("alice", supervisorRole.ID)
	e.bob = e.person("bob", supervisorRole.ID)
	e.carol = e.person("carol", supervisorRole.ID)
	e.exec(`UPDATE mail_configuration SET enabled=true`)
	return e
}

// morningIn is 08:00 UTC the given number of days after now, so an Open Day and the timeslots the tests add or move
// after it stay on one date in the makerspace's time zone whatever time of day the suite runs.
func morningIn(now time.Time, days int) time.Time {
	return time.Date(now.Year(), now.Month(), now.Day()+days, 8, 0, 0, 0, time.UTC)
}

type slotFixture struct{ id, supervisorRequirement uuid.UUID }

// addSlot adds a second timeslot with places to a fixture day.
func (e *noticeEnv) addSlot(day openDayFixture, startsAt time.Time, length time.Duration) slotFixture {
	e.t.Helper()
	slot := slotFixture{id: ids.New(), supervisorRequirement: ids.New()}
	e.exec(`INSERT INTO open_day_timeslots(id,open_day_id,starts_at,ends_at,position) VALUES($1,$2,$3,$4,1)`,
		slot.id, day.id, startsAt, startsAt.Add(length))
	e.exec(`INSERT INTO open_day_staff_requirements(id,open_day_id,timeslot_id,kind,required_count)
		VALUES($1,$2,$3,'supervisor',3),($4,$2,$3,'trainee',0)`, slot.supervisorRequirement, day.id, slot.id, ids.New())
	e.exec(`UPDATE open_days SET ends_at=$2 WHERE id=$1`, day.id, startsAt.Add(length))
	return slot
}

func (e *noticeEnv) holdSlot(day openDayFixture, timeslot, requirement uuid.UUID, p authorization.Principal) {
	e.t.Helper()
	e.exec(`INSERT INTO open_day_assignments(id,open_day_id,timeslot_id,requirement_id,person_id) VALUES($1,$2,$3,$4,$5)`,
		ids.New(), day.id, timeslot, requirement, p.PersonID)
}

func (e *noticeEnv) versions(dayID uuid.UUID) (period, day int64) {
	e.t.Helper()
	if err := e.pool.QueryRow(testContext(e.t),
		`SELECT p.version, d.version FROM open_days d JOIN open_day_periods p ON p.id=d.period_id WHERE d.id=$1`, dayID,
	).Scan(&period, &day); err != nil {
		e.t.Fatal(err)
	}
	return period, day
}

func supervisorPlaces(count int) []opendays.RequirementInput {
	return []opendays.RequirementInput{
		{Kind: opendays.RequirementSupervisor, RequiredCount: count},
		{Kind: opendays.RequirementTrainee, RequiredCount: 0},
	}
}

func (e *noticeEnv) save(delta opendays.ScheduleDelta) {
	e.t.Helper()
	if _, err := e.opendays.SaveSchedule(testContext(e.t), e.manager, e.period, delta, nil); err != nil {
		e.t.Fatal(err)
	}
}

func TestOpenDayScheduleSaveTellsAffectedPeopleOncePerDayAndNeverTheActor(t *testing.T) {
	e := newNoticeEnv(t)
	start := morningIn(e.now, 3)
	day := e.openDay(start, 2*time.Hour, 3, 0)
	second := e.addSlot(day, start.Add(3*time.Hour), 2*time.Hour)
	for _, p := range []authorization.Principal{e.alice, e.bob, e.manager} {
		e.holdSlot(day, day.timeslot, day.supervisorRequirement, p)
	}
	e.holdSlot(day, second.id, second.supervisorRequirement, e.alice)

	// Both timeslots move by an hour: Alice holds both and still gets one notification for the day.
	periodVersion, dayVersion := e.versions(day.id)
	first, last := day.timeslot, second.id
	e.save(opendays.ScheduleDelta{ExpectedPeriodVersion: periodVersion, Updates: []opendays.ScheduleInput{{
		ID: day.id, ExpectedVersion: dayVersion,
		Timeslots: []opendays.TimeslotInput{
			{ID: &first, StartsAt: start.Add(time.Hour), EndsAt: start.Add(3 * time.Hour), Requirements: supervisorPlaces(3)},
			{ID: &last, StartsAt: start.Add(4 * time.Hour), EndsAt: start.Add(6 * time.Hour), Requirements: supervisorPlaces(3)},
		},
	}}})
	e.expectCount(e.alice, inbox.KindOpenDayTimeslotChanged, 1, "alice")
	e.expectCount(e.bob, inbox.KindOpenDayTimeslotChanged, 1, "bob")
	e.expectCount(e.carol, inbox.KindOpenDayTimeslotChanged, 0, "carol, who holds no place")
	e.expectCount(e.manager, inbox.KindOpenDayTimeslotChanged, 0, "the manager who saved")
	item := e.kinds(e.alice, inbox.KindOpenDayTimeslotChanged)[0]
	if item.Link == nil || *item.Link != "/open-days/"+e.period.String()+"/days/"+day.id.String() ||
		strings.Count(item.Body, "was ") != 2 {
		t.Fatalf("notification = %+v", item)
	}
	assertCount(t, e.pool, `SELECT count(*) FROM notification_mail_outbox m JOIN notification_firings f ON f.id = m.firing_id JOIN notification_rules r ON r.id = f.rule_id
		WHERE r.system_key='open_day_timeslot_changed' AND m.person_id=$1`, 1, e.alice.PersonID)

	// A save that changes nothing about the times stays quiet.
	periodVersion, dayVersion = e.versions(day.id)
	note := "Bring snacks"
	e.save(opendays.ScheduleDelta{ExpectedPeriodVersion: periodVersion, Updates: []opendays.ScheduleInput{{
		ID: day.id, ExpectedVersion: dayVersion, InternalNote: &note,
		Timeslots: []opendays.TimeslotInput{
			{ID: &first, StartsAt: start.Add(time.Hour), EndsAt: start.Add(3 * time.Hour), Requirements: supervisorPlaces(3)},
			{ID: &last, StartsAt: start.Add(4 * time.Hour), EndsAt: start.Add(6 * time.Hour), Requirements: supervisorPlaces(3)},
		},
	}}})
	e.expectCount(e.alice, inbox.KindOpenDayTimeslotChanged, 1, "alice after a note-only save")

	// Dropping the second timeslot removes Alice's place in it; Bob and the manager keep theirs.
	periodVersion, dayVersion = e.versions(day.id)
	e.save(opendays.ScheduleDelta{ExpectedPeriodVersion: periodVersion, Updates: []opendays.ScheduleInput{{
		ID: day.id, ExpectedVersion: dayVersion,
		Timeslots: []opendays.TimeslotInput{
			{ID: &first, StartsAt: start.Add(time.Hour), EndsAt: start.Add(3 * time.Hour), Requirements: supervisorPlaces(3)},
		},
	}}})
	e.expectCount(e.alice, inbox.KindOpenDayTimeslotRemoved, 1, "alice")
	e.expectCount(e.bob, inbox.KindOpenDayTimeslotRemoved, 0, "bob")
	e.expectCount(e.manager, inbox.KindOpenDayTimeslotRemoved, 0, "the manager who saved")
	assertCount(t, e.pool, `SELECT count(*) FROM open_day_assignments WHERE open_day_id=$1`, 3, day.id)
}

func TestOpenDayCancellationTellsAssignedPeopleExceptTheActor(t *testing.T) {
	e := newNoticeEnv(t)
	start := morningIn(e.now, 4)
	day := e.openDay(start, 2*time.Hour, 3, 0)
	second := e.addSlot(day, start.Add(3*time.Hour), time.Hour)
	for _, p := range []authorization.Principal{e.alice, e.manager} {
		e.holdSlot(day, day.timeslot, day.supervisorRequirement, p)
	}
	e.holdSlot(day, second.id, second.supervisorRequirement, e.alice)
	periodVersion, dayVersion := e.versions(day.id)

	if _, err := e.opendays.CancelOpenDay(testContext(t), e.manager, day.id, periodVersion, dayVersion, nil); err != nil {
		t.Fatal(err)
	}
	e.expectCount(e.alice, inbox.KindOpenDayCancelled, 1, "alice")
	e.expectCount(e.manager, inbox.KindOpenDayCancelled, 0, "the manager who cancelled")
	e.expectCount(e.carol, inbox.KindOpenDayCancelled, 0, "carol")
	e.expectCount(e.alice, inbox.KindOpenDayTimeslotRemoved, 0, "alice, who is told of the cancellation only")

	// A day deleted from a draft period no longer has a page: the notice links to the period.
	draft := e.newPeriod("Draft", "draft", e.now.AddDate(0, 2, 0), e.now.AddDate(0, 3, 0))
	draftDay, draftSlot, draftRequirement := ids.New(), ids.New(), ids.New()
	draftStart := morningIn(e.now.AddDate(0, 2, 0), 5)
	e.exec(`INSERT INTO open_days(id,period_id,starts_at,ends_at) VALUES($1,$2,$3,$4)`,
		draftDay, draft, draftStart, draftStart.Add(time.Hour))
	e.exec(`INSERT INTO open_day_timeslots(id,open_day_id,starts_at,ends_at,position) VALUES($1,$2,$3,$4,0)`,
		draftSlot, draftDay, draftStart, draftStart.Add(time.Hour))
	e.exec(`INSERT INTO open_day_staff_requirements(id,open_day_id,timeslot_id,kind,required_count)
		VALUES($1,$2,$3,'supervisor',1),($4,$2,$3,'trainee',0)`, draftRequirement, draftDay, draftSlot, ids.New())
	e.exec(`INSERT INTO open_day_assignments(id,open_day_id,timeslot_id,requirement_id,person_id) VALUES($1,$2,$3,$4,$5)`,
		ids.New(), draftDay, draftSlot, draftRequirement, e.bob.PersonID)
	var draftVersion, dayVersionDraft int64
	if err := e.pool.QueryRow(testContext(t),
		`SELECT p.version, d.version FROM open_days d JOIN open_day_periods p ON p.id=d.period_id WHERE d.id=$1`, draftDay,
	).Scan(&draftVersion, &dayVersionDraft); err != nil {
		t.Fatal(err)
	}
	if _, err := e.opendays.SaveSchedule(testContext(t), e.manager, draft, opendays.ScheduleDelta{
		ExpectedPeriodVersion: draftVersion, Removals: []opendays.RemovalInput{{ID: draftDay, ExpectedVersion: dayVersionDraft}},
	}, nil); err != nil {
		t.Fatal(err)
	}
	items := e.kinds(e.bob, inbox.KindOpenDayCancelled)
	if len(items) != 1 || items[0].Link == nil || *items[0].Link != "/open-days/"+draft.String() {
		t.Fatalf("bob's notifications = %+v", items)
	}
}

func TestOpenDaySeriesShrinkCancelsLaterDaysAndTellsTheirStaff(t *testing.T) {
	e := newNoticeEnv(t)
	first := e.now.AddDate(0, 0, 14)
	firstDate := time.Date(first.Year(), first.Month(), first.Day(), 0, 0, 0, 0, time.UTC)
	lastDate := firstDate.AddDate(0, 0, 7)
	template := opendays.SeriesTemplate{
		Timeslots:        []opendays.ClockRange{{Start: "10:00", End: "12:00"}},
		SupervisorPlaces: 2,
		// Forced so that a public holiday on either date cannot make the test depend on the calendar.
		ForcedDates: []time.Time{firstDate, lastDate},
	}
	weekday := int(firstDate.Weekday())
	if weekday == 0 {
		weekday = 7
	}
	periodVersion, _ := e.versions(e.openDay(morningIn(e.now, 2), time.Hour, 1, 0).id)
	e.save(opendays.ScheduleDelta{ExpectedPeriodVersion: periodVersion, SeriesCreates: []opendays.SeriesCreate{{
		Weekday: weekday, FromDate: firstDate, UntilDate: lastDate, SeriesTemplate: template,
	}}})
	var seriesID uuid.UUID
	var seriesVersion int64
	if err := e.pool.QueryRow(testContext(t), `SELECT id, version FROM open_day_series WHERE period_id=$1`, e.period).
		Scan(&seriesID, &seriesVersion); err != nil {
		t.Fatal(err)
	}
	var laterDay, laterSlot, laterRequirement uuid.UUID
	if err := e.pool.QueryRow(testContext(t), `
		SELECT d.id, t.id, r.id FROM open_days d
		JOIN open_day_timeslots t ON t.open_day_id=d.id
		JOIN open_day_staff_requirements r ON r.timeslot_id=t.id AND r.kind='supervisor'
		WHERE d.series_id=$1 ORDER BY d.starts_at DESC LIMIT 1`, seriesID).Scan(&laterDay, &laterSlot, &laterRequirement); err != nil {
		t.Fatal(err)
	}
	e.holdSlot(openDayFixture{id: laterDay}, laterSlot, laterRequirement, e.alice)
	e.holdSlot(openDayFixture{id: laterDay}, laterSlot, laterRequirement, e.manager)

	template.ForcedDates = []time.Time{firstDate}
	periodVersion, _ = e.versions(laterDay)
	e.save(opendays.ScheduleDelta{ExpectedPeriodVersion: periodVersion, SeriesUpdates: []opendays.SeriesUpdate{{
		ID: seriesID, ExpectedVersion: seriesVersion, ApplyFrom: firstDate, UntilDate: firstDate, SeriesTemplate: template,
	}}})
	assertCount(t, e.pool, `SELECT count(*) FROM open_days WHERE id=$1 AND status='cancelled'`, 1, laterDay)
	e.expectCount(e.alice, inbox.KindOpenDayCancelled, 1, "alice")
	e.expectCount(e.manager, inbox.KindOpenDayCancelled, 0, "the manager who saved")
}

func TestOpenDayAssignmentsByOthersNotifyButOwnActionsDoNot(t *testing.T) {
	e := newNoticeEnv(t)
	day := e.openDay(morningIn(e.now, 5), 2*time.Hour, 5, 0)
	ctx := testContext(t)

	// Self sign-up is the person's own action.
	if _, err := e.opendays.Join(ctx, e.bob, day.id, day.supervisorRequirement, nil); err != nil {
		t.Fatal(err)
	}
	e.expectCount(e.bob, inbox.KindOpenDayAssignedByOther, 0, "bob after joining himself")
	// A manager who assigns themselves is not told either.
	if _, err := e.opendays.Assign(ctx, e.manager, day.id, day.supervisorRequirement, e.manager.PersonID, nil); err != nil {
		t.Fatal(err)
	}
	e.expectCount(e.manager, inbox.KindOpenDayAssignedByOther, 0, "the manager who assigned themselves")

	if _, err := e.opendays.Assign(ctx, e.manager, day.id, day.supervisorRequirement, e.alice.PersonID, nil); err != nil {
		t.Fatal(err)
	}
	e.expectCount(e.alice, inbox.KindOpenDayAssignedByOther, 1, "alice")
	item := e.kinds(e.alice, inbox.KindOpenDayAssignedByOther)[0]
	if item.Link == nil || *item.Link != "/open-days/"+e.period.String()+"/days/"+day.id.String() {
		t.Fatalf("link = %v", item.Link)
	}
	assertCount(t, e.pool, `SELECT count(*) FROM notification_mail_outbox m JOIN notification_firings f ON f.id = m.firing_id JOIN notification_rules r ON r.id = f.rule_id WHERE r.system_key='open_day_assigned_by_other'`, 1)
	// A person without an enabled account is skipped without failing the assignment.
	e.disable(e.carol)
	if _, err := e.opendays.Assign(ctx, e.manager, day.id, day.supervisorRequirement, e.carol.PersonID, nil); err != nil {
		t.Fatal(err)
	}
	e.expectCount(e.carol, inbox.KindOpenDayAssignedByOther, 0, "carol with a disabled account")

	var aliceAssignment, bobAssignment uuid.UUID
	e.assignmentOf(day.id, e.alice, &aliceAssignment)
	e.assignmentOf(day.id, e.bob, &bobAssignment)
	if err := e.opendays.RemoveAssignment(ctx, e.manager, day.id, aliceAssignment, nil); err != nil {
		t.Fatal(err)
	}
	e.expectCount(e.alice, inbox.KindOpenDayUnassignedByOther, 1, "alice")
	// Leaving on one's own is not "by other".
	if err := e.opendays.Leave(ctx, e.bob, day.id, day.timeslot, nil); err != nil {
		t.Fatal(err)
	}
	e.expectCount(e.bob, inbox.KindOpenDayUnassignedByOther, 0, "bob after leaving himself")
	// A manager removing their own place is not told.
	var managerAssignment uuid.UUID
	e.assignmentOf(day.id, e.manager, &managerAssignment)
	if err := e.opendays.RemoveAssignment(ctx, e.manager, day.id, managerAssignment, nil); err != nil {
		t.Fatal(err)
	}
	e.expectCount(e.manager, inbox.KindOpenDayUnassignedByOther, 0, "the manager who removed themselves")
	_ = bobAssignment
}

func (e *noticeEnv) assignmentOf(dayID uuid.UUID, p authorization.Principal, target *uuid.UUID) {
	e.t.Helper()
	if err := e.pool.QueryRow(testContext(e.t),
		`SELECT id FROM open_day_assignments WHERE open_day_id=$1 AND person_id=$2`, dayID, p.PersonID).Scan(target); err != nil {
		e.t.Fatal(err)
	}
}

func TestMembershipChangeToVisitorTellsThePersonOncePerFreedOpenDay(t *testing.T) {
	e := newNoticeEnv(t)
	ctx := testContext(t)
	start := morningIn(e.now, 3)
	busy := e.openDay(start, 2*time.Hour, 3, 0)
	second := e.addSlot(busy, start.Add(3*time.Hour), time.Hour)
	other := e.openDay(morningIn(e.now, 6), 2*time.Hour, 3, 0)
	e.holdSlot(busy, busy.timeslot, busy.supervisorRequirement, e.alice)
	e.holdSlot(busy, second.id, second.supervisorRequirement, e.alice)
	e.holdSlot(other, other.timeslot, other.supervisorRequirement, e.alice)
	e.holdSlot(other, other.timeslot, other.supervisorRequirement, e.bob)

	service := people.NewService(e.pool, nil).WithMembershipNotices(notifyrules.NewSystemEvents(nil), time.UTC)
	var version int64
	if err := e.pool.QueryRow(ctx, `SELECT version FROM people WHERE id=$1`, e.alice.PersonID).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ChangeMembership(ctx, e.master, e.alice.PersonID, roles.MembershipVisitor, version, nil); err != nil {
		t.Fatal(err)
	}
	assertCount(t, e.pool, `SELECT count(*) FROM open_day_assignments WHERE person_id=$1`, 0, e.alice.PersonID)
	e.expectCount(e.alice, inbox.KindOpenDayUnassignedByOther, 2, "alice, one per freed open day")
	e.expectCount(e.bob, inbox.KindOpenDayUnassignedByOther, 0, "bob, whose places stay")
	assertCount(t, e.pool, `SELECT count(*) FROM notification_mail_outbox m JOIN notification_firings f ON f.id = m.firing_id JOIN notification_rules r ON r.id = f.rule_id
		WHERE r.system_key='open_day_unassigned_by_other' AND m.person_id=$1`, 2, e.alice.PersonID)
}
