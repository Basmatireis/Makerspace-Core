package integration_test

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/opendays"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/roles"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/staffing"
	"github.com/google/uuid"
)

var vienna = func() *time.Location {
	location, err := time.LoadLocation("Europe/Vienna")
	if err != nil {
		panic(err)
	}
	return location
}()

// localDay is the makerspace calendar date days from now, as a UTC midnight.
func localDay(days int) time.Time {
	local := time.Now().In(vienna).AddDate(0, 0, days)
	return time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, time.UTC)
}

// nextWeekday is the first date on or after date with the weekday.
func nextWeekday(date time.Time, weekday time.Weekday) time.Time {
	for date.Weekday() != weekday {
		date = date.AddDate(0, 0, 1)
	}
	return date
}

// at is the instant of a wall-clock time on a makerspace date.
func at(date time.Time, hour, minute int) time.Time {
	return time.Date(date.Year(), date.Month(), date.Day(), hour, minute, 0, 0, vienna).UTC()
}

func places(supervisors, trainees int, supervisorRoles ...uuid.UUID) []opendays.RequirementInput {
	return []opendays.RequirementInput{
		{Kind: opendays.RequirementSupervisor, RequiredCount: supervisors, EligibleRoleIDs: supervisorRoles},
		{Kind: opendays.RequirementTrainee, RequiredCount: trainees},
	}
}

func slot(date time.Time, fromHour, toHour int, requirements []opendays.RequirementInput) opendays.TimeslotInput {
	return opendays.TimeslotInput{StartsAt: at(date, fromHour, 0), EndsAt: at(date, toHour, 0), Requirements: requirements}
}

func requirementOf(t *testing.T, slot opendays.Timeslot, kind opendays.RequirementKind) opendays.Requirement {
	t.Helper()
	for _, requirement := range slot.Requirements {
		if requirement.Kind == kind {
			return requirement
		}
	}
	t.Fatalf("timeslot %s has no %s place", slot.ID, kind)
	return opendays.Requirement{}
}

func (e *staffingEnv) periodVersion(periodID uuid.UUID) int64 {
	e.t.Helper()
	var version int64
	if err := e.pool.QueryRow(testContext(e.t), `SELECT version FROM open_day_periods WHERE id=$1`, periodID).
		Scan(&version); err != nil {
		e.t.Fatal(err)
	}
	return version
}

func (e *staffingEnv) servicePeriod(name string, start, end time.Time, target ...opendays.PeriodStatus) opendays.Period {
	e.t.Helper()
	ctx := testContext(e.t)
	period, err := e.opendays.CreatePeriod(ctx, e.master, name, start, end, nil, nil)
	if err != nil {
		e.t.Fatal(err)
	}
	for _, status := range target {
		if period, err = e.opendays.TransitionPeriod(ctx, e.master, period.ID, period.Version, status, nil); err != nil {
			e.t.Fatal(err)
		}
	}
	return period
}

func dayOn(t *testing.T, schedule opendays.Schedule, date time.Time) *opendays.OpenDay {
	t.Helper()
	for i := range schedule.Items {
		local := schedule.Items[i].StartsAt.In(vienna)
		if local.Format(time.DateOnly) == date.Format(time.DateOnly) {
			return &schedule.Items[i]
		}
	}
	return nil
}

func TestOpenDayTimeslotsHoldPlacesPerTimeslotWithEligibilityAndCanJoin(t *testing.T) {
	e := newStaffingEnv(t)
	ctx := testContext(t)
	supervisorRole := e.role("", level(roles.MembershipSupervisor), authorization.OpenDaysSignup, authorization.OpenDaysRead)
	woodwork := e.role("Woodwork", nil)
	readers := e.role("Readers", nil, authorization.OpenDaysRead)
	alice := e.person("alice", supervisorRole.ID, woodwork.ID)
	bob := e.person("bob", supervisorRole.ID)
	carol := e.person("carol", readers.ID)
	date := localDay(10)

	// Membership decides the kind of place, so a membership role cannot restrict one.
	_, err := e.opendays.SaveSchedule(ctx, e.master, e.period, opendays.ScheduleDelta{
		ExpectedPeriodVersion: 1,
		Creates: []opendays.ScheduleInput{{Timeslots: []opendays.TimeslotInput{
			slot(date, 10, 12, places(1, 0, supervisorRole.ID)),
		}}},
	}, nil)
	expectAppCode(t, err, "validation_failed")
	// Timeslots of one day must not overlap.
	_, err = e.opendays.SaveSchedule(ctx, e.master, e.period, opendays.ScheduleDelta{
		ExpectedPeriodVersion: 1,
		Creates: []opendays.ScheduleInput{{Timeslots: []opendays.TimeslotInput{
			slot(date, 10, 12, places(1, 0)), slot(date, 11, 14, places(1, 0)),
		}}},
	}, nil)
	expectAppCode(t, err, "validation_failed")

	schedule, err := e.opendays.SaveSchedule(ctx, e.master, e.period, opendays.ScheduleDelta{
		ExpectedPeriodVersion: 1,
		Creates: []opendays.ScheduleInput{{Timeslots: []opendays.TimeslotInput{
			slot(date, 10, 12, places(1, 1)), slot(date, 12, 14, places(1, 0, woodwork.ID)),
		}}},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	day := schedule.Items[0]
	if len(day.Timeslots) != 2 || !day.StartsAt.Equal(at(date, 10, 0)) || !day.EndsAt.Equal(at(date, 14, 0)) {
		t.Fatalf("day = %#v", day)
	}
	first, second := day.Timeslots[0], day.Timeslots[1]

	view := func(p authorization.Principal) opendays.OpenDay {
		t.Helper()
		item, err := e.opendays.GetOpenDay(ctx, p, day.ID)
		if err != nil {
			t.Fatal(err)
		}
		return item
	}
	aliceView := view(alice)
	if r := requirementOf(t, aliceView.Timeslots[1], opendays.RequirementSupervisor); !r.Eligible || !r.CanJoin {
		t.Fatalf("alice on the woodwork place = %#v", r)
	}
	if r := requirementOf(t, aliceView.Timeslots[0], opendays.RequirementTrainee); r.Eligible || r.CanJoin {
		t.Fatalf("a supervisor is eligible for a trainee place: %#v", r)
	}
	bobView := view(bob)
	if r := requirementOf(t, bobView.Timeslots[1], opendays.RequirementSupervisor); r.Eligible || r.CanJoin {
		t.Fatalf("bob without the extra role on the woodwork place = %#v", r)
	}
	if r := requirementOf(t, bobView.Timeslots[0], opendays.RequirementSupervisor); !r.Eligible || !r.CanJoin {
		t.Fatalf("bob on the open place = %#v", r)
	}
	carolView := view(carol)
	for _, r := range carolView.Requirements {
		if r.Eligible || r.CanJoin || r.EligibleRolesVisible || r.EligibleRoleIDs != nil || r.Assignments != nil {
			t.Fatalf("visitor reader sees %#v", r)
		}
	}
	managerView := view(e.master)
	if r := requirementOf(t, managerView.Timeslots[1], opendays.RequirementSupervisor); !r.EligibleRolesVisible ||
		len(r.EligibleRoleIDs) != 1 || r.EligibleRoleIDs[0] != woodwork.ID {
		t.Fatalf("manager restriction = %#v", r)
	}

	// One person may hold several timeslots of a day but only one place per timeslot.
	firstSupervisor := requirementOf(t, first, opendays.RequirementSupervisor)
	secondSupervisor := requirementOf(t, second, opendays.RequirementSupervisor)
	if _, err := e.opendays.Join(ctx, alice, day.ID, firstSupervisor.ID, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := e.opendays.Join(ctx, alice, day.ID, secondSupervisor.ID, nil); err != nil {
		t.Fatal(err)
	}
	_, err = e.opendays.Join(ctx, alice, day.ID, requirementOf(t, first, opendays.RequirementTrainee).ID, nil)
	expectAppCode(t, err, "already_in_timeslot")
	_, err = e.opendays.Join(ctx, bob, day.ID, firstSupervisor.ID, nil)
	expectAppCode(t, err, "requirement_full")
	_, err = e.opendays.Join(ctx, bob, day.ID, secondSupervisor.ID, nil)
	expectAppCode(t, err, "person_not_eligible")
	_, err = e.opendays.Join(ctx, carol, day.ID, firstSupervisor.ID, nil)
	if !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("reader join = %v, want permission denied", err)
	}
	aliceView = view(alice)
	if aliceView.Timeslots[0].MyAssignment == nil || aliceView.Timeslots[1].MyAssignment == nil ||
		requirementOf(t, aliceView.Timeslots[0], opendays.RequirementSupervisor).CanJoin {
		t.Fatalf("alice after joining both timeslots = %#v", aliceView.Timeslots)
	}

	// Leaving frees one timeslot only.
	if err := e.opendays.Leave(ctx, alice, uuid.New(), first.ID, nil); !errors.Is(err, apperror.NotFound) {
		t.Fatalf("leave with another day = %v, want not found", err)
	}
	if err := e.opendays.Leave(ctx, bob, day.ID, first.ID, nil); !errors.Is(err, apperror.NotFound) {
		t.Fatalf("leave without an assignment = %v, want not found", err)
	}
	if err := e.opendays.Leave(ctx, alice, day.ID, first.ID, nil); err != nil {
		t.Fatal(err)
	}
	assertCount(t, e.pool, `SELECT count(*) FROM open_day_assignments WHERE person_id=$1 AND timeslot_id=$2`, 0,
		alice.PersonID, first.ID)
	assertCount(t, e.pool, `SELECT count(*) FROM open_day_assignments WHERE person_id=$1 AND timeslot_id=$2`, 1,
		alice.PersonID, second.ID)

	// An update that names the kept timeslot keeps its assignment; the dropped timeslot goes.
	schedule, err = e.opendays.GetSchedule(ctx, e.master, e.period)
	if err != nil {
		t.Fatal(err)
	}
	keep := second.ID
	_, err = e.opendays.SaveSchedule(ctx, e.master, e.period, opendays.ScheduleDelta{
		ExpectedPeriodVersion: schedule.Period.Version,
		Updates: []opendays.ScheduleInput{{
			ID: day.ID, ExpectedVersion: schedule.Items[0].Version,
			Timeslots: []opendays.TimeslotInput{{
				ID: &keep, StartsAt: at(date, 12, 0), EndsAt: at(date, 15, 0), Requirements: places(1, 0, woodwork.ID),
			}},
		}},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	updated := view(e.master)
	if len(updated.Timeslots) != 1 || updated.Timeslots[0].ID != second.ID || !updated.StartsAt.Equal(at(date, 12, 0)) ||
		!updated.EndsAt.Equal(at(date, 15, 0)) {
		t.Fatalf("updated day = %#v", updated)
	}
	assertCount(t, e.pool, `SELECT count(*) FROM open_day_assignments WHERE open_day_id=$1`, 1, day.ID)
}

func TestOpenDayScheduleRejectsOverlappingDaysAndNeedsManagePermission(t *testing.T) {
	e := newStaffingEnv(t)
	ctx := testContext(t)
	readers := e.role("Readers", nil, authorization.OpenDaysRead)
	reader := e.person("reader", readers.ID)
	date := localDay(12)
	one := func(from, to int) opendays.ScheduleInput {
		return opendays.ScheduleInput{Timeslots: []opendays.TimeslotInput{slot(date, from, to, places(1, 0))}}
	}

	_, err := e.opendays.SaveSchedule(ctx, reader, e.period, opendays.ScheduleDelta{
		ExpectedPeriodVersion: 1, Creates: []opendays.ScheduleInput{one(10, 12)},
	}, nil)
	if !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("reader save = %v, want permission denied", err)
	}
	if _, err := e.opendays.ListSeries(ctx, reader, e.period); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("reader series list = %v, want permission denied", err)
	}
	_, err = e.opendays.SaveSchedule(ctx, e.master, e.period, opendays.ScheduleDelta{
		ExpectedPeriodVersion: 1, Creates: []opendays.ScheduleInput{one(10, 14), one(13, 15)},
	}, nil)
	expectAppCode(t, err, "open_day_overlap")
	if version := e.periodVersion(e.period); version != 1 {
		t.Fatalf("period version after a rejected save = %d", version)
	}
	// Adjacent days do not overlap.
	schedule, err := e.opendays.SaveSchedule(ctx, e.master, e.period, opendays.ScheduleDelta{
		ExpectedPeriodVersion: 1, Creates: []opendays.ScheduleInput{one(10, 14), one(14, 16)},
	}, nil)
	if err != nil || len(schedule.Items) != 2 {
		t.Fatalf("adjacent days = %#v, %v", schedule.Items, err)
	}
	later := schedule.Items[1]
	_, err = e.opendays.SaveSchedule(ctx, e.master, e.period, opendays.ScheduleDelta{
		ExpectedPeriodVersion: schedule.Period.Version,
		Updates: []opendays.ScheduleInput{{
			ID: later.ID, ExpectedVersion: later.Version,
			Timeslots: []opendays.TimeslotInput{slot(date, 13, 16, places(1, 0))},
		}},
	}, nil)
	expectAppCode(t, err, "open_day_overlap")
	// A cancelled day frees its time.
	if _, err := e.opendays.SaveSchedule(ctx, e.master, e.period, opendays.ScheduleDelta{
		ExpectedPeriodVersion: schedule.Period.Version,
		Removals:              []opendays.RemovalInput{{ID: later.ID, ExpectedVersion: later.Version}},
		Creates:               []opendays.ScheduleInput{one(15, 18)},
	}, nil); err != nil {
		t.Fatal(err)
	}
	assertCount(t, e.pool, `SELECT count(*) FROM open_days WHERE id=$1 AND status='cancelled'`, 1, later.ID)
}

func TestOpenDaySeriesCreateUpdateDetachRejoinAndShrink(t *testing.T) {
	e := newStaffingEnv(t)
	ctx := testContext(t)
	base := nextWeekday(localDay(14), time.Tuesday)
	period := e.servicePeriod("Series period", localDay(7), base.AddDate(0, 0, 50))
	breakDate := base.AddDate(0, 0, 7)
	if _, err := e.opendays.CreateAcademicBreak(ctx, e.master, "Short break", breakDate, breakDate, nil); err != nil {
		t.Fatal(err)
	}
	twoSlots := []opendays.ClockRange{{Start: "16:00", End: "18:00"}, {Start: "18:00", End: "20:00"}}
	until := base.AddDate(0, 0, 28)

	preview, err := e.opendays.PreviewRecurrence(ctx, e.master, period.ID, opendays.RecurrenceInput{
		Weekday: 2, StartsOn: base, EndsOn: until, EveryWeeks: 1, SkipPublicHolidays: true, SkipAcademicBreaks: true,
		Timeslots: twoSlots, ForcedDates: []time.Time{breakDate},
	})
	if err != nil {
		t.Fatal(err)
	}
	expected := 0
	for _, item := range preview {
		if item.Date.Equal(breakDate) && item.Disposition != opendays.DispositionForced {
			t.Fatalf("forced break date = %#v", item)
		}
		if len(item.Timeslots) != 2 {
			t.Fatalf("preview timeslots = %#v", item)
		}
		if item.Disposition == opendays.DispositionCreate || item.Disposition == opendays.DispositionForced {
			expected++
		}
	}

	schedule, err := e.opendays.SaveSchedule(ctx, e.master, period.ID, opendays.ScheduleDelta{
		ExpectedPeriodVersion: period.Version,
		SeriesCreates: []opendays.SeriesCreate{{
			Weekday: 2, FromDate: base, UntilDate: until,
			SeriesTemplate: opendays.SeriesTemplate{
				Timeslots: twoSlots, SupervisorPlaces: 2, TraineePlaces: 1, ForcedDates: []time.Time{breakDate},
			},
		}},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	series, err := e.opendays.ListSeries(ctx, e.master, period.ID)
	if err != nil || len(series) != 1 {
		t.Fatalf("series = %#v, %v", series, err)
	}
	sr := series[0]
	if len(schedule.Items) != expected || sr.DayCount != expected || len(sr.Timeslots) != 2 ||
		len(sr.ForcedDates) != 1 {
		t.Fatalf("series days = %d, series = %#v, want %d", len(schedule.Items), sr, expected)
	}
	if day := dayOn(t, schedule, breakDate); day == nil || day.SeriesID == nil || *day.SeriesID != sr.ID ||
		len(day.Timeslots) != 2 {
		t.Fatalf("forced break day = %#v", day)
	}

	// A note-only edit keeps the day in its series; a time change takes it out.
	noted := dayOn(t, schedule, base)
	note := "bring the clamps"
	thirdDate := base.AddDate(0, 0, 14)
	third := dayOn(t, schedule, thirdDate)
	if noted == nil || third == nil {
		t.Skip("a public holiday removed a series date this test edits")
	}
	keepSlots := make([]opendays.TimeslotInput, 0, len(noted.Timeslots))
	for _, item := range noted.Timeslots {
		id := item.ID
		keepSlots = append(keepSlots, opendays.TimeslotInput{
			ID: &id, StartsAt: item.StartsAt, EndsAt: item.EndsAt, Requirements: places(2, 1),
		})
	}
	schedule, err = e.opendays.SaveSchedule(ctx, e.master, period.ID, opendays.ScheduleDelta{
		ExpectedPeriodVersion: schedule.Period.Version,
		Updates: []opendays.ScheduleInput{
			{ID: noted.ID, ExpectedVersion: noted.Version, InternalNote: &note, Timeslots: keepSlots},
			{
				ID: third.ID, ExpectedVersion: third.Version,
				Timeslots: []opendays.TimeslotInput{slot(thirdDate, 15, 19, places(2, 1))},
			},
		},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if day := dayOn(t, schedule, base); day.SeriesID == nil || day.DetachedFromSeriesID != nil {
		t.Fatalf("note-only edit left the series: %#v", day)
	}
	detached := dayOn(t, schedule, thirdDate)
	if detached.SeriesID != nil || detached.DetachedFromSeriesID == nil || *detached.DetachedFromSeriesID != sr.ID {
		t.Fatalf("edited day still follows the series: %#v", detached)
	}

	// Edit series from the fourth date on and end it there: the fifth date goes (draft), earlier days stay.
	fourthDate, fifthDate := base.AddDate(0, 0, 21), base.AddDate(0, 0, 28)
	oneSlot := []opendays.ClockRange{{Start: "17:00", End: "20:00"}}
	_, err = e.opendays.SaveSchedule(ctx, e.master, period.ID, opendays.ScheduleDelta{
		ExpectedPeriodVersion: schedule.Period.Version,
		SeriesUpdates: []opendays.SeriesUpdate{{
			ID: sr.ID, ExpectedVersion: sr.Version + 1, ApplyFrom: fourthDate, UntilDate: fourthDate,
			SeriesTemplate: opendays.SeriesTemplate{Timeslots: oneSlot, SupervisorPlaces: 1, TraineePlaces: 1},
		}},
	}, nil)
	expectAppCode(t, err, "stale_write")
	schedule, err = e.opendays.SaveSchedule(ctx, e.master, period.ID, opendays.ScheduleDelta{
		ExpectedPeriodVersion: schedule.Period.Version,
		SeriesUpdates: []opendays.SeriesUpdate{{
			ID: sr.ID, ExpectedVersion: sr.Version, ApplyFrom: fourthDate, UntilDate: fourthDate,
			SeriesTemplate: opendays.SeriesTemplate{Timeslots: oneSlot, SupervisorPlaces: 1, TraineePlaces: 1},
		}},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if day := dayOn(t, schedule, fifthDate); day != nil {
		t.Fatalf("day after the new end survives in a draft period: %#v", day)
	}
	if day := dayOn(t, schedule, fourthDate); day == nil || len(day.Timeslots) != 1 ||
		!day.StartsAt.Equal(at(fourthDate, 17, 0)) {
		t.Fatalf("day from apply-from = %#v", day)
	}
	if day := dayOn(t, schedule, breakDate); len(day.Timeslots) != 2 {
		t.Fatalf("day before apply-from changed: %#v", day)
	}

	// The detached day follows the series again.
	detached = dayOn(t, schedule, thirdDate)
	schedule, err = e.opendays.SaveSchedule(ctx, e.master, period.ID, opendays.ScheduleDelta{
		ExpectedPeriodVersion: schedule.Period.Version,
		SeriesRejoins:         []opendays.SeriesRejoin{{OpenDayID: detached.ID, ExpectedVersion: detached.Version}},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if day := dayOn(t, schedule, thirdDate); day.SeriesID == nil || *day.SeriesID != sr.ID ||
		day.DetachedFromSeriesID != nil || len(day.Timeslots) != 1 || !day.StartsAt.Equal(at(thirdDate, 17, 0)) {
		t.Fatalf("rejoined day = %#v", day)
	}

	// Outside draft a shrink cancels; assignments keep their timeslot by position when the template changes.
	if _, err := e.opendays.TransitionPeriod(ctx, e.master, period.ID, schedule.Period.Version, "staffing", nil); err != nil {
		t.Fatal(err)
	}
	makeMasterHoldersSupervisors(t, e.pool)
	fourth := dayOn(t, schedule, fourthDate)
	if _, err := e.opendays.Assign(ctx, e.master, fourth.ID, requirementOf(t, fourth.Timeslots[0],
		opendays.RequirementSupervisor).ID, e.master.PersonID, nil); err != nil {
		t.Fatal(err)
	}
	series, err = e.opendays.ListSeries(ctx, e.master, period.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.opendays.SaveSchedule(ctx, e.master, period.ID, opendays.ScheduleDelta{
		ExpectedPeriodVersion: e.periodVersion(period.ID),
		SeriesUpdates: []opendays.SeriesUpdate{{
			ID: sr.ID, ExpectedVersion: series[0].Version, ApplyFrom: fourthDate, UntilDate: fourthDate,
			SeriesTemplate: opendays.SeriesTemplate{
				Timeslots: []opendays.ClockRange{{Start: "16:00", End: "20:00"}}, SupervisorPlaces: 1, TraineePlaces: 1,
			},
		}},
	}, nil); err != nil {
		t.Fatal(err)
	}
	assertCount(t, e.pool, `SELECT count(*) FROM open_day_assignments WHERE open_day_id=$1`, 1, fourth.ID)
	series, _ = e.opendays.ListSeries(ctx, e.master, period.ID)
	schedule, err = e.opendays.SaveSchedule(ctx, e.master, period.ID, opendays.ScheduleDelta{
		ExpectedPeriodVersion: e.periodVersion(period.ID),
		SeriesUpdates: []opendays.SeriesUpdate{{
			ID: sr.ID, ExpectedVersion: series[0].Version, ApplyFrom: fourthDate, UntilDate: thirdDate,
			SeriesTemplate: opendays.SeriesTemplate{Timeslots: oneSlot, SupervisorPlaces: 1, TraineePlaces: 1},
		}},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if day := dayOn(t, schedule, fourthDate); day == nil || day.Status != opendays.DayCancelled {
		t.Fatalf("shrunk day in a staffing period = %#v", day)
	}
	// Extending again adds the dates the series has no day for; the cancelled one stays cancelled.
	series, _ = e.opendays.ListSeries(ctx, e.master, period.ID)
	schedule, err = e.opendays.SaveSchedule(ctx, e.master, period.ID, opendays.ScheduleDelta{
		ExpectedPeriodVersion: e.periodVersion(period.ID),
		SeriesUpdates: []opendays.SeriesUpdate{{
			ID: sr.ID, ExpectedVersion: series[0].Version, ApplyFrom: fourthDate, UntilDate: fifthDate,
			SeriesTemplate: opendays.SeriesTemplate{Timeslots: oneSlot, SupervisorPlaces: 1, TraineePlaces: 1},
		}},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if day := dayOn(t, schedule, fourthDate); day.Status != opendays.DayCancelled {
		t.Fatalf("cancelled day = %#v", day)
	}
	if day := dayOn(t, schedule, fifthDate); day == nil && preview[len(preview)-1].Disposition == opendays.DispositionCreate {
		t.Fatal("extended series did not add its last date")
	}
	assertCount(t, e.pool, `SELECT count(*) FROM audit_events WHERE action='open_day_series.updated' AND resource_id=$1`,
		4, sr.ID)
}

func TestOpenDayPeriodCopiesSeriesFromAnEarlierPeriod(t *testing.T) {
	e := newStaffingEnv(t)
	ctx := testContext(t)
	first := e.servicePeriod("Earlier", localDay(7), localDay(40))
	base := nextWeekday(localDay(7), time.Thursday)
	woodwork := e.role("Woodwork", nil)
	if _, err := e.opendays.SaveSchedule(ctx, e.master, first.ID, opendays.ScheduleDelta{
		ExpectedPeriodVersion: first.Version,
		SeriesCreates: []opendays.SeriesCreate{{
			Weekday: 4, FromDate: base, UntilDate: localDay(40),
			SeriesTemplate: opendays.SeriesTemplate{
				Timeslots:        []opendays.ClockRange{{Start: "10:00", End: "12:00"}, {Start: "13:00", End: "15:00"}},
				SupervisorPlaces: 2, TraineePlaces: 0, SupervisorRoleIDs: []uuid.UUID{woodwork.ID},
			},
		}},
	}, nil); err != nil {
		t.Fatal(err)
	}
	readers := e.role("Readers", nil, authorization.OpenDaysRead)
	reader := e.person("reader", readers.ID)
	if _, err := e.opendays.CreatePeriodCopyingSeries(
		ctx, reader, "Copy", localDay(50), localDay(90), nil, &first.ID, nil,
	); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("reader copy = %v, want permission denied", err)
	}
	second, err := e.opendays.CreatePeriodCopyingSeries(
		ctx, e.master, "Later", localDay(50), localDay(90), nil, &first.ID, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	series, err := e.opendays.ListSeries(ctx, e.master, second.ID)
	if err != nil || len(series) != 1 {
		t.Fatalf("copied series = %#v, %v", series, err)
	}
	copied := series[0]
	firstThursday := nextWeekday(localDay(50), time.Thursday)
	if copied.Weekday != 4 || !copied.FromDate.Equal(firstThursday) || !copied.UntilDate.Equal(localDay(90)) ||
		len(copied.Timeslots) != 2 || len(copied.SupervisorRoleIDs) != 1 || copied.SupervisorRoleIDs[0] != woodwork.ID {
		t.Fatalf("copied series = %#v", copied)
	}
	preview, err := e.opendays.PreviewRecurrence(ctx, e.master, second.ID, opendays.RecurrenceInput{
		Weekday: 4, StartsOn: firstThursday, EndsOn: localDay(90), EveryWeeks: 1, SkipPublicHolidays: true,
		SkipAcademicBreaks: true, Timeslots: copied.Timeslots,
	})
	if err != nil {
		t.Fatal(err)
	}
	// The copied days are in the period already, so the preview reports them as conflicts.
	expected := 0
	for _, item := range preview {
		if item.Disposition == opendays.DispositionConflict {
			expected++
		}
	}
	schedule, err := e.opendays.GetSchedule(ctx, e.master, second.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(schedule.Items) != expected || copied.DayCount != expected {
		t.Fatalf("copied days = %d (series says %d), want %d", len(schedule.Items), copied.DayCount, expected)
	}
	for _, day := range schedule.Items {
		if day.SeriesID == nil || *day.SeriesID != copied.ID || len(day.Timeslots) != 2 {
			t.Fatalf("copied day = %#v", day)
		}
	}
}

func TestStaffingCountsFollowTheCountByRule(t *testing.T) {
	e := newStaffingEnv(t)
	ctx := testContext(t)
	supervisorRole := e.role("", level(roles.MembershipSupervisor), authorization.OpenDaysRead)
	viewers := e.role("Viewers", nil, authorization.SupervisorDashboardRead)
	viewer := e.person("viewer", viewers.ID)
	person := e.person("double", supervisorRole.ID)
	// An ended day with two timeslots the person both staffed, and an upcoming day with one.
	ended := e.openDay(e.now.AddDate(0, 0, -3), 2*time.Hour, 1, 0)
	secondSlot, secondPlace := ids.New(), ids.New()
	start := e.now.AddDate(0, 0, -3).Add(2 * time.Hour)
	e.exec(`UPDATE open_days SET ends_at=$2 WHERE id=$1`, ended.id, start.Add(2*time.Hour))
	e.exec(`INSERT INTO open_day_timeslots(id,open_day_id,starts_at,ends_at,position) VALUES($1,$2,$3,$4,1)`,
		secondSlot, ended.id, start, start.Add(2*time.Hour))
	e.exec(`INSERT INTO open_day_staff_requirements(id,open_day_id,timeslot_id,kind,required_count)
		VALUES($1,$2,$3,'supervisor',1)`, secondPlace, ended.id, secondSlot)
	e.join(ended, ended.supervisorRequirement, person)
	e.exec(`INSERT INTO open_day_assignments(id,open_day_id,timeslot_id,requirement_id,person_id) VALUES($1,$2,$3,$4,$5)`,
		ids.New(), ended.id, secondSlot, secondPlace, person.PersonID)
	upcoming := e.openDay(e.now.AddDate(0, 0, 3), 2*time.Hour, 1, 0)
	e.join(upcoming, upcoming.supervisorRequirement, person)

	rules, err := e.staffing.Settings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	semester := &staffing.Semester{ID: e.period}
	for countBy, want := range map[staffing.CountBy]staffing.Counts{
		staffing.CountByTimeslot: {Staffed: 2, Booked: 1},
		staffing.CountByOpenDay:  {Staffed: 1, Booked: 1},
	} {
		rules.CountBy = countBy
		counts, err := e.staffing.Counts(ctx, rules, semester, e.now, &person.PersonID)
		if err != nil {
			t.Fatal(err)
		}
		if counts[person.PersonID] != want {
			t.Fatalf("%s counts = %#v, want %#v", countBy, counts[person.PersonID], want)
		}
	}

	staffedOnDashboard := func() int {
		t.Helper()
		result, err := e.supervise.Get(ctx, viewer, &e.period)
		if err != nil {
			t.Fatal(err)
		}
		for _, row := range result.Supervisors {
			if row.PersonID == person.PersonID {
				return row.Counts.Staffed
			}
		}
		t.Fatal("person missing from the supervisor dashboard")
		return 0
	}
	if got := staffedOnDashboard(); got != 2 {
		t.Fatalf("dashboard per timeslot = %d", got)
	}
	update := defaultRulesInput(rules.Version)
	update.CountBy = staffing.CountByOpenDay
	if _, err := e.staffing.UpdateRules(ctx, e.master, update, nil); err != nil {
		t.Fatal(err)
	}
	if got := staffedOnDashboard(); got != 1 {
		t.Fatalf("dashboard per open day = %d", got)
	}
}

func TestPublicOpenDaysListTimeslotsWithoutStaffing(t *testing.T) {
	e := newStaffingEnv(t)
	ctx := testContext(t)
	date := nextWeekday(localDay(20), time.Wednesday)
	period := e.servicePeriod("Public", localDay(10), localDay(40))
	schedule, err := e.opendays.SaveSchedule(ctx, e.master, period.ID, opendays.ScheduleDelta{
		ExpectedPeriodVersion: period.Version,
		Creates: []opendays.ScheduleInput{{Timeslots: []opendays.TimeslotInput{
			slot(date, 16, 18, places(1, 0)), slot(date, 18, 20, places(1, 0)),
		}}},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, status := range []opendays.PeriodStatus{opendays.PeriodStaffing, opendays.PeriodPublished} {
		current, err := e.opendays.GetPeriod(ctx, e.master, period.ID)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := e.opendays.TransitionPeriod(ctx, e.master, period.ID, current.Version, status, nil); err != nil {
			t.Fatal(err)
		}
	}
	public, err := e.opendays.ListPublic(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var found *opendays.PublicOpenDay
	for i := range public {
		if public[i].ID == schedule.Items[0].ID {
			found = &public[i]
		}
	}
	if found == nil || len(found.Timeslots) != 2 || !found.StartsAt.Equal(at(date, 16, 0)) ||
		!found.EndsAt.Equal(at(date, 20, 0)) || !found.Timeslots[1].StartsAt.Equal(at(date, 18, 0)) {
		t.Fatalf("public day = %#v", found)
	}
	body, err := e.opendays.PublicICS(ctx)
	if err != nil {
		t.Fatal(err)
	}
	unfolded := strings.ReplaceAll(string(body), "\r\n ", "")
	if strings.Count(unfolded, "BEGIN:VEVENT") != len(public) ||
		!strings.Contains(unfolded, `DESCRIPTION:Timeslots: 16:00–18:00\, 18:00–20:00`) {
		t.Fatalf("ICS = %s", unfolded)
	}
}
