package integration_test

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/opendays"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/google/uuid"
)

func TestOpenDaysLifecycleAtomicScheduleAssignmentsAndPublicPrivacy(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	managerAccount := seedAccount(t, pool, "open-days-manager", true)
	manager := authorization.Principal{AccountID: managerAccount.accountID, PersonID: managerAccount.personID, Master: true}
	service, err := opendays.NewService(pool, config.Config{
		MakerspaceTimeZone: "Europe/Vienna", HolidayCountry: "AT",
		HolidaySubdivision: "AT-6", HolidayLanguage: "de",
	})
	if err != nil {
		t.Fatal(err)
	}

	startDate := time.Date(2026, time.October, 1, 0, 0, 0, 0, time.UTC)
	endDate := time.Date(2027, time.January, 31, 0, 0, 0, 0, time.UTC)
	period, err := service.CreatePeriod(ctx, manager, "Winter Semester 2026/27", startDate, endDate, nil)
	if err != nil {
		t.Fatal(err)
	}
	if period.Status != "draft" || period.Version != 1 {
		t.Fatalf("period = %#v", period)
	}

	startsAt := time.Date(2026, time.October, 7, 14, 0, 0, 0, time.UTC)
	endsAt := time.Date(2026, time.October, 7, 17, 0, 0, 0, time.UTC)
	note := "manager-only preparation note"
	input := opendays.ScheduleInput{StartsAt: startsAt, EndsAt: endsAt, InternalNote: &note, Requirements: []opendays.RequirementInput{
		{Kind: "supervisor", RequiredCount: 1, EligibleRoleIDs: []uuid.UUID{uuid.MustParse(masterRoleID)}},
		{Kind: "trainee", RequiredCount: 0, EligibleRoleIDs: []uuid.UUID{}},
	}}
	schedule, err := service.CreateOpenDay(ctx, manager, period.ID, period.Version, input, nil)
	if err != nil {
		t.Fatal(err)
	}
	if schedule.Period.Version != 2 || len(schedule.Items) != 1 {
		t.Fatalf("schedule = %#v", schedule)
	}
	day := schedule.Items[0]
	_, err = service.SaveSchedule(ctx, manager, period.ID, opendays.ScheduleDelta{
		ExpectedPeriodVersion: 2,
		Updates: []opendays.ScheduleInput{{
			ID: day.ID, ExpectedVersion: day.Version, StartsAt: startsAt, EndsAt: endsAt,
			InternalNote: &note, Requirements: input.Requirements,
		}},
		Removals: []opendays.RemovalInput{{ID: day.ID, ExpectedVersion: day.Version}},
	}, nil)
	expectAppCode(t, err, "validation_failed")

	_, err = service.SaveSchedule(ctx, manager, period.ID, opendays.ScheduleDelta{ExpectedPeriodVersion: 2, Creates: []opendays.ScheduleInput{input, input}}, nil)
	expectAppCode(t, err, "duplicate_open_day")
	assertCount(t, pool, `SELECT count(*) FROM open_days WHERE period_id = $1`, 1, period.ID)
	var version int64
	if err := pool.QueryRow(ctx, `SELECT version FROM open_day_periods WHERE id = $1`, period.ID).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version != 2 {
		t.Fatalf("period version = %d, want 2 after rolled-back bulk save", version)
	}

	staffing, err := service.TransitionPeriod(ctx, manager, period.ID, 2, "staffing", nil)
	if err != nil {
		t.Fatal(err)
	}
	assignment, err := service.Join(ctx, manager, day.ID, day.Requirements[0].ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !assignment.IsCurrentUser {
		t.Fatal("self assignment is not marked current")
	}
	readerAccount := seedAccount(t, pool, "open-days-reader", false)
	readerRoleID := uuid.Must(uuid.NewV7())
	if _, err := pool.Exec(ctx, `INSERT INTO roles (id, name) VALUES ($1, 'Open Days reader')`, readerRoleID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO role_permission_grants (id, role_id, permission_id) VALUES (uuidv7(), $1, $2)`, readerRoleID, authorization.OpenDaysRead); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO account_roles (account_id, role_id) VALUES ($1, $2)`, readerAccount.accountID, readerRoleID); err != nil {
		t.Fatal(err)
	}
	reader, err := authorization.LoadPermissionsFrom(ctx, pool, authorization.Principal{AccountID: readerAccount.accountID, PersonID: readerAccount.personID})
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.TransitionPeriod(ctx, reader, period.ID, staffing.Version, "draft", nil)
	if !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("reader transition error = %v, want permission denied", err)
	}
	draft, err := service.TransitionPeriod(ctx, manager, period.ID, staffing.Version, "draft", nil)
	if err != nil || draft.Status != "draft" {
		t.Fatalf("return to draft = %#v, err=%v", draft, err)
	}
	assertCount(t, pool, `SELECT count(*) FROM open_day_assignments WHERE open_day_id = $1`, 1, day.ID)
	readerPeriods, err := service.ListPeriods(ctx, reader)
	if err != nil || len(readerPeriods) != 0 {
		t.Fatalf("reader periods after return to draft = %#v, err=%v", readerPeriods, err)
	}
	_, err = service.GetPeriod(ctx, reader, period.ID)
	if !errors.Is(err, apperror.NotFound) {
		t.Fatalf("reader draft lookup error = %v, want not found", err)
	}
	_, err = service.Join(ctx, manager, day.ID, day.Requirements[0].ID, nil)
	expectAppCode(t, err, "assignment_closed")
	reopenedStaffing, err := service.TransitionPeriod(ctx, manager, period.ID, draft.Version, "staffing", nil)
	if err != nil || reopenedStaffing.Status != "staffing" {
		t.Fatalf("reopen for staffing = %#v, err=%v", reopenedStaffing, err)
	}
	redacted, err := service.GetOpenDay(ctx, reader, day.ID)
	if err != nil {
		t.Fatal(err)
	}
	if redacted.InternalNote != nil || redacted.InternalNoteVisible || redacted.MyAssignment != nil {
		t.Fatalf("reader saw manager or assignment fields: %#v", redacted)
	}
	for _, requirement := range redacted.Requirements {
		if requirement.Assignments != nil || requirement.EligibleRolesVisible || requirement.EligibleRoleIDs != nil {
			t.Fatalf("reader saw staffing identities or eligible roles: %#v", requirement)
		}
	}
	_, err = service.Join(ctx, manager, day.ID, day.Requirements[0].ID, nil)
	expectAppCode(t, err, "requirement_full")

	public, err := service.ListPublic(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(public) != 0 {
		t.Fatalf("staffing period leaked publicly: %#v", public)
	}
	published, err := service.TransitionPeriod(ctx, manager, period.ID, reopenedStaffing.Version, "published", nil)
	if err != nil {
		t.Fatal(err)
	}
	public, err = service.ListPublic(ctx)
	if err != nil || len(public) != 1 || public[0].Title != "Open Day" {
		t.Fatalf("public schedule = %#v, err=%v", public, err)
	}
	ics, err := service.PublicICS(ctx)
	if err != nil {
		t.Fatal(err)
	}
	calendar := string(ics)
	if !strings.Contains(calendar, "UID:urn:uuid:"+day.ID.String()) || strings.Contains(calendar, note) || strings.Contains(calendar, "open-days-manager") {
		t.Fatalf("unsafe or incomplete calendar:\n%s", calendar)
	}
	_, err = service.TransitionPeriod(ctx, manager, period.ID, published.Version, "draft", nil)
	expectAppCode(t, err, "invalid_period_transition")
	returnedStaffing, err := service.TransitionPeriod(ctx, manager, period.ID, published.Version, "staffing", nil)
	if err != nil || returnedStaffing.Status != "staffing" {
		t.Fatalf("unpublish to staffing = %#v, err=%v", returnedStaffing, err)
	}
	assertCount(t, pool, `SELECT count(*) FROM open_day_assignments WHERE open_day_id = $1`, 1, day.ID)
	public, err = service.ListPublic(ctx)
	if err != nil || len(public) != 0 {
		t.Fatalf("unpublished period leaked through public JSON: %#v, err=%v", public, err)
	}
	ics, err = service.PublicICS(ctx)
	if err != nil || strings.Contains(string(ics), "UID:urn:uuid:"+day.ID.String()) {
		t.Fatalf("unpublished period leaked through ICS: %q, err=%v", ics, err)
	}
	published, err = service.TransitionPeriod(ctx, manager, period.ID, returnedStaffing.Version, "published", nil)
	if err != nil {
		t.Fatal(err)
	}

	cancelled, err := service.CancelOpenDay(ctx, manager, day.ID, published.Version, day.Version, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(cancelled.Items) != 1 || cancelled.Items[0].Status != "cancelled" {
		t.Fatalf("cancelled schedule = %#v", cancelled)
	}
	assertCount(t, pool, `SELECT count(*) FROM open_day_assignments WHERE open_day_id = $1`, 1, day.ID)
	ics, err = service.PublicICS(ctx)
	if err != nil || !strings.Contains(string(ics), "STATUS:CANCELLED") {
		t.Fatalf("cancelled ICS = %q, err=%v", ics, err)
	}

	archived, err := service.TransitionPeriod(ctx, manager, period.ID, cancelled.Period.Version, "archived", nil)
	if err != nil || archived.Status != "archived" {
		t.Fatalf("archive = %#v, err=%v", archived, err)
	}
	_, err = service.SaveSchedule(ctx, manager, period.ID, opendays.ScheduleDelta{ExpectedPeriodVersion: archived.Version}, nil)
	expectAppCode(t, err, "period_archived")
	_, err = service.TransitionPeriod(ctx, manager, period.ID, archived.Version, "published", nil)
	expectAppCode(t, err, "invalid_period_transition")
	_, err = service.TransitionPeriod(ctx, manager, period.ID, archived.Version, "staffing", nil)
	expectAppCode(t, err, "invalid_period_transition")
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE resource_id = $1 AND action = 'open_day_period.draft'`, 1, period.ID)
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE resource_id = $1 AND action = 'open_day_period.staffing'`, 3, period.ID)
}

func TestOpenDaysConcurrentFinalSlotAssignment(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	managerAccount := seedAccount(t, pool, "open-days-capacity-manager", true)
	first := seedAccount(t, pool, "open-days-capacity-first", true)
	second := seedAccount(t, pool, "open-days-capacity-second", true)
	manager := authorization.Principal{AccountID: managerAccount.accountID, PersonID: managerAccount.personID, Master: true}
	service, err := opendays.NewService(pool, config.Config{})
	if err != nil {
		t.Fatal(err)
	}
	period, err := service.CreatePeriod(ctx, manager, "Capacity", time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC), time.Date(2026, 4, 30, 0, 0, 0, 0, time.UTC), nil)
	if err != nil {
		t.Fatal(err)
	}
	schedule, err := service.CreateOpenDay(ctx, manager, period.ID, period.Version, opendays.ScheduleInput{
		StartsAt: time.Date(2026, 4, 8, 14, 0, 0, 0, time.UTC),
		EndsAt:   time.Date(2026, 4, 8, 17, 0, 0, 0, time.UTC),
		Requirements: []opendays.RequirementInput{
			{Kind: "supervisor", RequiredCount: 1, EligibleRoleIDs: []uuid.UUID{uuid.MustParse(masterRoleID)}},
			{Kind: "trainee", RequiredCount: 0},
		},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.TransitionPeriod(ctx, manager, period.ID, schedule.Period.Version, "staffing", nil); err != nil {
		t.Fatal(err)
	}
	day := schedule.Items[0]
	requirementID := day.Requirements[0].ID
	results := make(chan error, 2)
	for _, personID := range []uuid.UUID{first.personID, second.personID} {
		go func() {
			_, assignErr := service.Assign(ctx, manager, day.ID, requirementID, personID, nil)
			results <- assignErr
		}()
	}
	succeeded, full := 0, 0
	for range 2 {
		result := <-results
		if result == nil {
			succeeded++
		} else if apperror.IsCode(result, "requirement_full") {
			full++
		} else {
			t.Fatalf("unexpected concurrent assignment error: %v", result)
		}
	}
	if succeeded != 1 || full != 1 {
		t.Fatalf("concurrent assignment results: succeeded=%d full=%d", succeeded, full)
	}
	assertCount(t, pool, `SELECT count(*) FROM open_day_assignments WHERE requirement_id = $1`, 1, requirementID)
}

func TestOpenDayPeriodSummaryCountsIndividualSupervisorVacancies(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	managerAccount := seedAccount(t, pool, "open-days-summary-manager", true)
	secondSupervisor := seedAccount(t, pool, "open-days-summary-second", true)
	manager := authorization.Principal{AccountID: managerAccount.accountID, PersonID: managerAccount.personID, Master: true}
	service, err := opendays.NewService(pool, config.Config{})
	if err != nil {
		t.Fatal(err)
	}
	period, err := service.CreatePeriod(ctx, manager, "Supervisor vacancy summary", time.Date(2026, 5, 1, 0, 0, 0, 0, time.UTC), time.Date(2026, 5, 31, 0, 0, 0, 0, time.UTC), nil)
	if err != nil {
		t.Fatal(err)
	}
	roleID := uuid.MustParse(masterRoleID)
	create := func(day int) opendays.ScheduleInput {
		return opendays.ScheduleInput{
			StartsAt: time.Date(2026, 5, day, 14, 0, 0, 0, time.UTC),
			EndsAt:   time.Date(2026, 5, day, 17, 0, 0, 0, time.UTC),
			Requirements: []opendays.RequirementInput{
				{Kind: "supervisor", RequiredCount: 2, EligibleRoleIDs: []uuid.UUID{roleID}},
				{Kind: "trainee", RequiredCount: 3, EligibleRoleIDs: []uuid.UUID{roleID}},
			},
		}
	}
	schedule, err := service.SaveSchedule(ctx, manager, period.ID, opendays.ScheduleDelta{
		ExpectedPeriodVersion: period.Version,
		Creates:               []opendays.ScheduleInput{create(6), create(13), create(20)},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.TransitionPeriod(ctx, manager, period.ID, schedule.Period.Version, "staffing", nil); err != nil {
		t.Fatal(err)
	}
	supervisorRequirement := func(day opendays.OpenDay) uuid.UUID {
		for _, requirement := range day.Requirements {
			if requirement.Kind == "supervisor" {
				return requirement.ID
			}
		}
		t.Fatalf("Open Day %s has no supervisor requirement", day.ID)
		return uuid.Nil
	}
	if _, err := service.Assign(ctx, manager, schedule.Items[0].ID, supervisorRequirement(schedule.Items[0]), managerAccount.personID, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Assign(ctx, manager, schedule.Items[2].ID, supervisorRequirement(schedule.Items[2]), managerAccount.personID, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Assign(ctx, manager, schedule.Items[2].ID, supervisorRequirement(schedule.Items[2]), secondSupervisor.personID, nil); err != nil {
		t.Fatal(err)
	}
	summary, err := service.GetPeriod(ctx, manager, period.ID)
	if err != nil {
		t.Fatal(err)
	}
	if summary.OpenSupervisorPositions != 3 {
		t.Fatalf("open supervisor positions = %d, want 3; trainee vacancies must be excluded", summary.OpenSupervisorPositions)
	}
}

func TestOpenDaysVisibilityAndValidation(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	account := seedAccount(t, pool, "open-days-visibility", true)
	manager := authorization.Principal{AccountID: account.accountID, PersonID: account.personID, Master: true}
	reader := authorization.Principal{AccountID: account.accountID, PersonID: account.personID}
	service, err := opendays.NewService(pool, config.Config{})
	if err != nil {
		t.Fatal(err)
	}
	period, err := service.CreatePeriod(ctx, manager, "Draft", time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), time.Date(2026, 1, 31, 0, 0, 0, 0, time.UTC), nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.GetPeriod(ctx, reader, period.ID)
	expectAppCode(t, err, "permission_denied")
	bad := opendays.ScheduleInput{StartsAt: time.Date(2026, 2, 1, 12, 0, 0, 0, time.UTC), EndsAt: time.Date(2026, 2, 1, 13, 0, 0, 0, time.UTC), Requirements: []opendays.RequirementInput{{Kind: "supervisor", RequiredCount: 1}, {Kind: "trainee", RequiredCount: 0}}}
	_, err = service.CreateOpenDay(ctx, manager, period.ID, period.Version, bad, nil)
	expectAppCode(t, err, "validation_failed")
}

func TestOpenDayCalendarContextUsesAustrianProviderAndDoesNotBlockManualScheduling(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	account := seedAccount(t, pool, "open-days-calendar-context", true)
	manager := authorization.Principal{AccountID: account.accountID, PersonID: account.personID, Master: true}
	service, err := opendays.NewService(pool, config.Config{
		MakerspaceTimeZone: "Europe/Vienna",
		HolidayCountry:     "AT",
		HolidaySubdivision: "AT-6",
		HolidayLanguage:    "de",
	})
	if err != nil {
		t.Fatal(err)
	}
	period, err := service.CreatePeriod(ctx, manager, "Holiday context", time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC), time.Date(2027, 1, 31, 0, 0, 0, 0, time.UTC), nil)
	if err != nil {
		t.Fatal(err)
	}
	academicBreak, err := service.CreateAcademicBreak(ctx, manager, "Christmas break", time.Date(2026, 12, 23, 0, 0, 0, 0, time.UTC), time.Date(2027, 1, 6, 0, 0, 0, 0, time.UTC), nil)
	if err != nil {
		t.Fatal(err)
	}

	calendar, err := service.CalendarContext(ctx, manager, period.ID)
	if err != nil {
		t.Fatal(err)
	}
	if calendar.CountryCode != "AT" || calendar.SubdivisionCode != "AT-6" {
		t.Fatalf("calendar jurisdiction = %s/%s", calendar.CountryCode, calendar.SubdivisionCode)
	}
	foundNationalDay := false
	foundBreak := false
	for _, entry := range calendar.Entries {
		if entry.Name == "Nationalfeiertag" && dateKeyForTest(entry.StartsOn) == "2026-10-26" {
			foundNationalDay = entry.Category == "publicHoliday" && entry.Source == "holidayLibrary"
		}
		if entry.ID != nil && *entry.ID == academicBreak.ID {
			foundBreak = entry.Category == "academicBreak" && entry.Source == "manual" && dateKeyForTest(entry.EndsOn) == "2027-01-06"
		}
	}
	if !foundNationalDay || !foundBreak {
		t.Fatalf("calendar entries did not contain typed Austrian holiday and academic break: %#v", calendar.Entries)
	}

	publicHolidayPreview, err := service.PreviewRecurrence(ctx, manager, period.ID, opendays.RecurrenceInput{
		Weekday: 1, StartsOn: time.Date(2026, 10, 26, 0, 0, 0, 0, time.UTC), EndsOn: time.Date(2026, 10, 26, 0, 0, 0, 0, time.UTC),
		StartTime: "16:00", EndTime: "19:00", EveryWeeks: 1, SkipPublicHolidays: true, SkipAcademicBreaks: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(publicHolidayPreview) != 1 || publicHolidayPreview[0].Disposition != "publicHoliday" {
		t.Fatalf("public holiday preview = %#v", publicHolidayPreview)
	}
	academicBreakPreview, err := service.PreviewRecurrence(ctx, manager, period.ID, opendays.RecurrenceInput{
		Weekday: 1, StartsOn: time.Date(2026, 12, 28, 0, 0, 0, 0, time.UTC), EndsOn: time.Date(2026, 12, 28, 0, 0, 0, 0, time.UTC),
		StartTime: "16:00", EndTime: "19:00", EveryWeeks: 1, SkipPublicHolidays: true, SkipAcademicBreaks: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(academicBreakPreview) != 1 || academicBreakPreview[0].Disposition != "academicBreak" {
		t.Fatalf("academic break preview = %#v", academicBreakPreview)
	}

	zeroRequirements := []opendays.RequirementInput{
		{Kind: "supervisor", RequiredCount: 0},
		{Kind: "trainee", RequiredCount: 0},
	}
	schedule, err := service.CreateOpenDay(ctx, manager, period.ID, period.Version, opendays.ScheduleInput{
		StartsAt: time.Date(2026, 10, 26, 15, 0, 0, 0, time.UTC), EndsAt: time.Date(2026, 10, 26, 18, 0, 0, 0, time.UTC), Requirements: zeroRequirements,
	}, nil)
	if err != nil {
		t.Fatalf("manual Open Day on public holiday: %v", err)
	}
	_, err = service.CreateOpenDay(ctx, manager, period.ID, schedule.Period.Version, opendays.ScheduleInput{
		StartsAt: time.Date(2026, 12, 28, 15, 0, 0, 0, time.UTC), EndsAt: time.Date(2026, 12, 28, 18, 0, 0, 0, time.UTC), Requirements: zeroRequirements,
	}, nil)
	if err != nil {
		t.Fatalf("manual Open Day during academic break: %v", err)
	}
}

func dateKeyForTest(value time.Time) string {
	return value.Format("2006-01-02")
}
