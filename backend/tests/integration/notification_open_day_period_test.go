package integration_test

import (
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/opendays"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/roles"
)

func TestNotificationTriggerOpenDayPeriodChangedTellsStaffingPeopleWhenPublishedOrChanged(t *testing.T) {
	e := newTriggerEnv(t)
	supervisor := e.role("", level(roles.MembershipSupervisor), authorization.OpenDaysRead, authorization.OpenDaysSignup)
	alice := e.person("period-alice", supervisor.ID)
	outsider := e.person("period-outsider")
	planner := e.person("period-planner", e.role("Planners", nil, authorization.OpenDaysManage, authorization.OpenDaysRead).ID)
	dayStart := morningIn(e.now, 10)
	day := e.openDay(dayStart, 2*time.Hour, 2, 0)
	var dayVersion int64
	if err := e.pool.QueryRow(testContext(t), `SELECT version FROM open_days WHERE id=$1`, day.id).Scan(&dayVersion); err != nil {
		t.Fatal(err)
	}
	rule := e.rule("open_day_period_changed", "{period}: {change}, {days} days", "staffing_people")

	periodVersion := func(periodID string) int64 {
		var version int64
		if err := e.pool.QueryRow(testContext(t), `SELECT version FROM open_day_periods WHERE id=$1`, periodID).Scan(&version); err != nil {
			t.Fatal(err)
		}
		return version
	}

	// A save in a period people can see is news.
	note := "Bring snacks"
	if _, err := e.opendays.SaveSchedule(testContext(t), planner, e.period, opendays.ScheduleDelta{
		ExpectedPeriodVersion: periodVersion(e.period.String()),
		Updates: []opendays.ScheduleInput{{
			ID: day.id, ExpectedVersion: dayVersion, InternalNote: &note,
			StartsAt: dayStart, EndsAt: dayStart.Add(2 * time.Hour), Requirements: supervisorPlaces(2),
		}},
	}, nil); err != nil {
		t.Fatalf("save: %v", err)
	}
	if e.told(alice.PersonID, rule.ID) != 1 || e.told(outsider.PersonID, rule.ID) != 0 {
		t.Fatalf("after a save: alice %d, outsider %d", e.told(alice.PersonID, rule.ID), e.told(outsider.PersonID, rule.ID))
	}
	if titles := e.titles(rule.ID); len(titles) != 1 || titles[0] != "Current semester: changed, 1 days" {
		t.Fatalf("titles = %q", titles)
	}

	// Publishing raises it with the other change kind, and a condition can tell them apart.
	published := e.rule("open_day_period_changed", "Published!", "staffing_people")
	input, err := e.rules.GetRule(testContext(t), e.manager, published.ID)
	if err != nil {
		t.Fatal(err)
	}
	input.Definition.Conditions = notifyrules.ConditionSet{Mode: notifyrules.ModeAll, Items: []notifyrules.ConditionItem{
		{Condition: &notifyrules.Condition{Field: "e.change", Op: notifyrules.OpIs, Value: "published"}},
	}}
	if _, err = e.rules.UpdateRule(testContext(t), e.manager, published.ID, input.Version, notifyrules.RuleInput{
		Name: input.Name, Enabled: true, CategoryID: &e.service, Definition: input.Definition,
	}, nil); err != nil {
		t.Fatalf("update rule: %v", err)
	}
	if _, err = e.opendays.TransitionPeriod(
		testContext(t), planner, e.period, periodVersion(e.period.String()), opendays.PeriodPublished, nil,
	); err != nil {
		t.Fatal(err)
	}
	if e.told(alice.PersonID, rule.ID) != 2 || e.told(alice.PersonID, published.ID) != 1 {
		t.Fatalf("after publishing: unconditional %d, published-only %d", e.told(alice.PersonID, rule.ID), e.told(alice.PersonID, published.ID))
	}

	// A draft is still being prepared: saving it stays quiet.
	draft := e.newPeriod("Next term", "draft", e.now.AddDate(0, 6, 0), e.now.AddDate(0, 9, 0))
	if _, err = e.opendays.SaveSchedule(testContext(t), planner, draft, opendays.ScheduleDelta{
		ExpectedPeriodVersion: periodVersion(draft.String()),
		Creates: []opendays.ScheduleInput{{
			ID:           ids.New(),
			StartsAt:     morningIn(e.now, 190),
			EndsAt:       morningIn(e.now, 190).Add(4 * time.Hour),
			Requirements: supervisorPlaces(1),
		}},
	}, nil); err != nil {
		t.Fatalf("draft save: %v", err)
	}
	if e.told(alice.PersonID, rule.ID) != 2 {
		t.Fatalf("a draft save told people: %d", e.told(alice.PersonID, rule.ID))
	}
}

func TestOpenDayReminderRuleReachesOnlyTheAssignedPersonTheSetDaysBefore(t *testing.T) {
	e := newScheduleEnv(t)
	supervisor := e.role("", level(roles.MembershipSupervisor), authorization.OpenDaysRead, authorization.OpenDaysSignup)
	assigned, other := e.person("reminder-assigned", supervisor.ID), e.person("reminder-other", supervisor.ID)
	// The open day starts two days and two hours from now, so "48 hours before" is two hours from now.
	start := e.now.Add(50 * time.Hour).Truncate(time.Minute)
	day := e.openDay(start, 3*time.Hour, 2, 0)
	e.join(day, day.supervisorRequirement, assigned)

	hours := 48
	rule, err := e.rules.CreateSubscription(testContext(t), assigned, notifyrules.RuleInput{
		Name: "Open day in 2 days", Enabled: true,
		Definition: notifyrules.Definition{
			Trigger: notifyrules.TriggerDef{Type: notifyrules.TriggerSchedule, Schedule: &notifyrules.Schedule{
				Repeat: notifyrules.RepeatBeforeOpenDay, Hours: &hours,
			}},
			Conditions: notifyrules.ConditionSet{Mode: notifyrules.ModeAll, Items: []notifyrules.ConditionItem{
				{Condition: &notifyrules.Condition{Field: "e.mine", Op: notifyrules.OpYes}},
			}},
			Actions: []notifyrules.Action{{
				Channel: notifyrules.ChannelInApp, Recipients: []string{"me"}, Title: "Open day on {day}", Body: "Your slot is {time}.",
			}},
		},
	}, nil)
	if err != nil {
		t.Fatalf("create subscription: %v", err)
	}
	// Before the moment (49 hours ahead) nothing is sent; once 48 hours remain it is, once.
	e.clock = start.Add(-49 * time.Hour)
	e.runSchedules()
	if e.notifications(assigned, rule.ID) != 0 {
		t.Fatal("reminder sent before the set number of days")
	}
	e.clock = start.Add(-48*time.Hour + 10*time.Minute)
	e.exec(`UPDATE notification_rules SET next_run_at=NULL WHERE id=$1`, rule.ID)
	e.runSchedules()
	e.exec(`UPDATE notification_rules SET next_run_at=NULL WHERE id=$1`, rule.ID)
	e.runSchedules()
	if e.notifications(assigned, rule.ID) != 1 || e.notifications(other, rule.ID) != 0 {
		t.Fatalf("assigned %d, other %d", e.notifications(assigned, rule.ID), e.notifications(other, rule.ID))
	}
}
