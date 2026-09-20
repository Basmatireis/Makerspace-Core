package integration_test

import (
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/opendays"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/google/uuid"
)

func TestOpenDayPeriodBoundsContainTheWholeSlot(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	manager := seedAccount(t, pool, "period-bounds", true)
	p := authorization.Principal{AccountID: manager.accountID, PersonID: manager.personID, Master: true}
	service, err := opendays.NewService(pool, config.Config{})
	if err != nil {
		t.Fatal(err)
	}
	start := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	end := start.AddDate(0, 0, 2)
	period, err := service.CreatePeriod(ctx, p, "Overnight", start, end, nil)
	if err != nil {
		t.Fatal(err)
	}
	schedule, err := service.CreateOpenDay(ctx, p, period.ID, period.Version, opendays.ScheduleInput{
		StartsAt: start.Add(18 * time.Hour), EndsAt: start.Add(26 * time.Hour),
		Requirements: []opendays.RequirementInput{{Kind: "supervisor", RequiredCount: 1, EligibleRoleIDs: []uuid.UUID{uuid.MustParse(masterRoleID)}}, {Kind: "trainee", RequiredCount: 0}},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.UpdatePeriod(ctx, p, period.ID, schedule.Period.Version, period.Name, start, start, nil)
	expectAppCode(t, err, "validation_failed")
	_, err = service.UpdatePeriod(ctx, p, period.ID, schedule.Period.Version, period.Name, start, start.AddDate(0, 0, 1), nil)
	if err != nil {
		t.Fatal(err)
	}
}

func TestOpenDayAssignmentReturnsNameBeyondEligibilityPage(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	manager := seedAccount(t, pool, "assignment-name", true)
	p := authorization.Principal{AccountID: manager.accountID, PersonID: manager.personID, Master: true}
	// Sort the assignee after more than a full eligibility page.
	if _, err := pool.Exec(ctx, `UPDATE people SET first_name='Zelda',last_name='ZZZ' WHERE id=$1`, manager.personID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `WITH people_insert AS (
		INSERT INTO people(id,first_name,last_name,phone) SELECT uuidv7(),'Earlier','AAA','+43123456789' FROM generate_series(1,201) RETURNING id
	), accounts_insert AS (
		INSERT INTO accounts(id,person_id,status) SELECT uuidv7(),id,'enabled' FROM people_insert RETURNING id
	) INSERT INTO account_roles(account_id,role_id) SELECT id,$1 FROM accounts_insert`, masterRoleID); err != nil {
		t.Fatal(err)
	}
	service, err := opendays.NewService(pool, config.Config{})
	if err != nil {
		t.Fatal(err)
	}
	start := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	period, err := service.CreatePeriod(ctx, p, "Assignment names", start, start.AddDate(0, 0, 2), nil)
	if err != nil {
		t.Fatal(err)
	}
	schedule, err := service.CreateOpenDay(ctx, p, period.ID, period.Version, opendays.ScheduleInput{
		StartsAt: start.Add(12 * time.Hour), EndsAt: start.Add(14 * time.Hour),
		Requirements: []opendays.RequirementInput{{Kind: "supervisor", RequiredCount: 1, EligibleRoleIDs: []uuid.UUID{uuid.MustParse(masterRoleID)}}, {Kind: "trainee", RequiredCount: 0}},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.TransitionPeriod(ctx, p, period.ID, schedule.Period.Version, "staffing", nil); err != nil {
		t.Fatal(err)
	}
	day := schedule.Items[0]
	assignment, err := service.Assign(ctx, p, day.ID, day.Requirements[0].ID, manager.personID, nil)
	if err != nil {
		t.Fatal(err)
	}
	if assignment.DisplayName != "Zelda ZZZ" {
		t.Fatalf("assignment name = %q", assignment.DisplayName)
	}
}

func TestOpenDayRecurrenceRejectsDSTGapsAndOverlaps(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	actor := seedAccount(t, pool, "dst-manager", true)
	principal := authorization.Principal{AccountID: actor.accountID, PersonID: actor.personID, Master: true}
	service, err := opendays.NewService(pool, config.Config{MakerspaceTimeZone: "Europe/Vienna"})
	if err != nil {
		t.Fatal(err)
	}
	date := func(value string) time.Time { parsed, _ := time.Parse("2006-01-02", value); return parsed }
	period, err := service.CreatePeriod(ctx, principal, "DST", date("2026-01-01"), date("2026-12-31"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		date, start, end string
		valid            bool
	}{
		{"2026-02-15", "12:00", "14:00", true},
		{"2026-03-29", "02:30", "04:00", false},
		{"2026-10-25", "02:30", "04:00", false},
		{"2026-02-15", "23:00", "01:00", true},
		{"2026-03-28", "23:00", "02:30", false},
		{"2026-10-24", "23:00", "02:30", false},
	} {
		day := date(test.date)
		weekday := int(day.Weekday())
		if weekday == 0 {
			weekday = 7
		}
		occurrences, err := service.PreviewRecurrence(ctx, principal, period.ID, opendays.RecurrenceInput{Weekday: weekday, StartsOn: day, EndsOn: day, StartTime: test.start, EndTime: test.end, EveryWeeks: 1})
		if test.valid {
			if err != nil || len(occurrences) != 1 || !occurrences[0].EndsAt.After(occurrences[0].StartsAt) {
				t.Fatalf("valid recurrence: %#v %v", occurrences, err)
			}
		} else {
			expectAppCode(t, err, "validation_failed")
		}
	}
	assertCount(t, pool, `SELECT count(*) FROM open_days`, 0)
}
