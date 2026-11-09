package integration_test

import (
	"errors"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/roles"
	"github.com/google/uuid"
)

type scheduleEnv struct {
	*dispatchEnv
	author authorization.Principal
}

func newScheduleEnv(t *testing.T) *scheduleEnv {
	t.Helper()
	env := &scheduleEnv{dispatchEnv: newDispatchEnv(t)}
	env.rules.WithDispatcher(env.dispatcher, time.UTC)
	env.author = env.person("schedule-author", env.grant(
		authorization.NotificationRulesManage, authorization.PeopleReadAll, authorization.OrdersRead,
		authorization.OpenDaysRead, authorization.OpenDaysReadAssignments, authorization.MachinesRead,
	))
	env.manager = env.author
	env.exec(`UPDATE mail_configuration SET enabled=true`)
	return env
}

func (e *scheduleEnv) withEmail(p authorization.Principal) authorization.Principal {
	e.exec(`UPDATE people SET email=$2 WHERE id=$1`, p.PersonID, p.PersonID.String()+"@example.test")
	return p
}

func (e *scheduleEnv) unpaidOrder(p authorization.Principal, status string, amount float64) {
	e.t.Helper()
	e.counter++
	order := ids.New()
	e.exec(`INSERT INTO orders(id,reference,customer_kind,customer_person_id)
		VALUES($1,$2,'person',$3)`, order, "O-2026-"+padded(900000+e.counter), p.PersonID)
	if status != "finalized" {
		return
	}
	e.exec(`INSERT INTO order_items(id,order_id,position,kind,description,quantity,unit,unit_price,amount)
		VALUES($1,$2,1,'manual','Fixture',1,'piece',$3,$3)`, ids.New(), order, amount)
	e.exec(`UPDATE orders SET status='finalized', total_amount=$2, finalized_at=now() - interval '10 days' WHERE id=$1`, order, amount)
}

func padded(n int) string {
	digits := []byte("000000")
	for i := len(digits) - 1; i >= 0 && n > 0; i-- {
		digits[i] = byte('0' + n%10)
		n /= 10
	}
	return string(digits)
}

func (e *scheduleEnv) due(rule uuid.UUID) {
	e.t.Helper()
	e.exec(`UPDATE notification_rules SET next_run_at=$2 WHERE id=$1`, rule, e.clock.Add(-time.Minute))
}

func (e *scheduleEnv) runSchedules() int {
	e.t.Helper()
	handled, err := e.dispatcher.RunSchedules(testContext(e.t), 50)
	if err != nil {
		e.t.Fatal(err)
	}
	return handled
}

func (e *scheduleEnv) scheduleRule(name string, mutate func(*notifyrules.RuleInput), actions ...notifyrules.Action) notifyrules.Rule {
	return e.newRule(e.service, func(in *notifyrules.RuleInput) {
		in.Name = name
		in.Definition.Trigger = notifyrules.TriggerDef{Type: notifyrules.TriggerSchedule, Schedule: &notifyrules.Schedule{
			Repeat: notifyrules.RepeatMonthly, DayOfMonth: 1, Time: "09:00",
		}}
		if mutate != nil {
			mutate(in)
		}
	}, actions...)
}

func gtZero(field string) notifyrules.ConditionSet {
	return notifyrules.ConditionSet{Mode: notifyrules.ModeAll, Items: []notifyrules.ConditionItem{
		{Condition: &notifyrules.Condition{Field: field, Op: notifyrules.OpGt, Value: float64(0)}},
	}}
}

func TestMonthlyOpenBalanceReachesOnlyPeopleWithUnpaidOrders(t *testing.T) {
	e := newScheduleEnv(t)
	owing, paid, draft := e.withEmail(e.person("owing")), e.withEmail(e.person("paid")), e.withEmail(e.person("draft"))
	e.unpaidOrder(owing, "finalized", 30)
	e.unpaidOrder(draft, "draft", 15)
	rule := e.scheduleRule("Monthly open balance", func(in *notifyrules.RuleInput) {
		in.Definition.Loop = &notifyrules.Loop{Collection: "people", Mode: notifyrules.ModeEach, Filter: gtZero("i.unpaid")}
	}, notifyrules.Action{
		Channel: notifyrules.ChannelEmail, Recipients: []string{"item:item"},
		Title: "Your open balance", Body: "{person.name}, you owe {person.unpaid} for {person.unpaidOrders} order(s).",
	})
	assertCount(t, e.pool, `SELECT count(*) FROM notification_rules WHERE id=$1 AND next_run_at > now()`, 1, rule.ID)

	result, err := e.rules.RunRule(testContext(t), e.author, rule.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.SentEmail != 1 || result.Fired != 1 || result.Examined < 3 {
		t.Fatalf("run result = %+v", result)
	}
	if e.mails(owing, rule.ID) != 1 || e.mails(paid, rule.ID) != 0 || e.mails(draft, rule.ID) != 0 {
		t.Fatalf("mails: owing %d, paid %d, draft %d", e.mails(owing, rule.ID), e.mails(paid, rule.ID), e.mails(draft, rule.ID))
	}
	var body string
	if err = e.pool.QueryRow(testContext(t), `SELECT m.body FROM notification_mail_outbox m
		JOIN notification_firings f ON f.id=m.firing_id WHERE f.rule_id=$1 AND m.person_id=$2`, rule.ID, owing.PersonID).Scan(&body); err != nil {
		t.Fatal(err)
	}
	if want := "30.00 € for 1 order(s)."; len(body) < len(want) || body[len(body)-len(want):] != want {
		t.Fatalf("body = %q", body)
	}

	// The scheduler runs it when due and plans the next month.
	e.due(rule.ID)
	if e.runSchedules() != 1 || e.mails(owing, rule.ID) != 2 {
		t.Fatalf("scheduled run: %d mails", e.mails(owing, rule.ID))
	}
	assertCount(t, e.pool, `SELECT count(*) FROM notification_rules WHERE id=$1 AND next_run_at > $2`, 1, rule.ID, e.clock)
	if e.runSchedules() != 0 {
		t.Fatal("a rule that already ran was claimed again")
	}
}

func TestSummaryOfOpenDaysWithFreePlacesReachesOnlyPeopleBelowTheirMinimum(t *testing.T) {
	e := newScheduleEnv(t)
	e.exec(`UPDATE staffing_rules SET supervisor_minimum=2`)
	supervisor := e.membershipRole(roles.MembershipSupervisor).ID
	reader := e.grant(authorization.OpenDaysRead)
	behind, ahead := e.person("behind", supervisor, reader), e.person("ahead", supervisor, reader)
	start := e.now.AddDate(0, 0, 3).Truncate(time.Hour)
	e.openDay(start, 4*time.Hour, 2, 0)
	for i := 1; i <= 2; i++ {
		full := e.openDay(start.AddDate(0, 0, i), 4*time.Hour, 1, 0)
		e.join(full, full.supervisorRequirement, ahead)
	}
	input := func() notifyrules.RuleInput {
		return notifyrules.RuleInput{
			Name: "Open days need people", Enabled: true,
			Definition: notifyrules.Definition{
				Trigger: notifyrules.TriggerDef{Type: notifyrules.TriggerSchedule, Schedule: &notifyrules.Schedule{
					Repeat: notifyrules.RepeatDaily, Time: "09:00",
				}},
				Loop: &notifyrules.Loop{Collection: "open_days", Mode: notifyrules.ModeSummary, Filter: gtZero("i.free")},
				Conditions: notifyrules.ConditionSet{Mode: notifyrules.ModeAll, Items: []notifyrules.ConditionItem{
					{Condition: &notifyrules.Condition{Field: "s.count", Op: notifyrules.OpGt, Value: float64(0)}},
					{Condition: &notifyrules.Condition{Field: "r.openDays", Op: notifyrules.OpLt, Ref: "r.minimum"}},
				}},
				Actions: []notifyrules.Action{{
					Channel: notifyrules.ChannelInApp, Recipients: []string{"me"},
					Title: "{count} open day(s) still need supervisors", Body: "{list}",
				}},
			},
		}
	}
	behindRule, err := e.rules.CreateSubscription(testContext(t), behind, input(), nil)
	if err != nil {
		t.Fatalf("create subscription: %v", err)
	}
	aheadRule, err := e.rules.CreateSubscription(testContext(t), ahead, input(), nil)
	if err != nil {
		t.Fatal(err)
	}
	e.due(behindRule.ID)
	e.due(aheadRule.ID)
	e.runSchedules()
	if e.notifications(behind, behindRule.ID) != 1 || e.notifications(ahead, aheadRule.ID) != 0 {
		t.Fatalf("behind %d, ahead %d", e.notifications(behind, behindRule.ID), e.notifications(ahead, aheadRule.ID))
	}
	var title string
	if err = e.pool.QueryRow(testContext(t), `SELECT title FROM inbox_notifications WHERE rule_id=$1`, behindRule.ID).Scan(&title); err != nil {
		t.Fatal(err)
	}
	if title != "1 open day(s) still need supervisors" {
		t.Fatalf("title = %q", title)
	}
}

func TestRunDryRunTestAndActivityEnforcePermissions(t *testing.T) {
	e := newScheduleEnv(t)
	owing, bystander := e.withEmail(e.person("owing")), e.withEmail(e.person("bystander"))
	e.unpaidOrder(owing, "finalized", 12)
	reader := e.person("reader", e.grant(authorization.NotificationRulesRead))
	rule := e.scheduleRule("Balance", func(in *notifyrules.RuleInput) {
		in.Definition.Loop = &notifyrules.Loop{Collection: "people", Mode: notifyrules.ModeEach, Filter: gtZero("i.unpaid")}
	}, notifyrules.Action{
		Channel: notifyrules.ChannelEmail, Recipients: []string{"item:item"}, Title: "Balance {person.unpaid}", Body: "Please pay.",
	})
	denied := func(err error, what string) {
		t.Helper()
		if !errors.Is(err, apperror.PermissionDenied) {
			t.Fatalf("%s: %v, want permission denied", what, err)
		}
	}
	_, err := e.rules.RunRule(testContext(t), reader, rule.ID, nil)
	denied(err, "run without manage")
	_, err = e.rules.DryRun(testContext(t), reader, notifyrules.RuleInput{Name: "x", Enabled: true, Definition: rule.Definition}, false)
	denied(err, "central dry run without manage")
	_, err = e.rules.TestRule(testContext(t), reader, rule.ID, nil)
	denied(err, "test without manage")
	_, err = e.rules.Activity(testContext(t), bystander, nil, 1, 10)
	denied(err, "activity without read")

	firingsBefore := e.count(`SELECT count(*) FROM notification_firings`)
	mailsBefore := e.count(`SELECT count(*) FROM notification_mail_outbox`)
	dry, err := e.rules.DryRun(testContext(t), e.author, notifyrules.RuleInput{
		Name: "Draft", Enabled: true, CategoryID: &e.service, Definition: rule.Definition,
	}, false)
	if err != nil {
		t.Fatal(err)
	}
	if dry.MatchedItems != 1 || dry.TotalItems < 2 || dry.Estimate30 == nil || *dry.Estimate30 < 1 {
		t.Fatalf("dry run = %+v", dry)
	}
	if len(dry.Items) == 0 || !dry.Items[0].Matched || dry.Items[0].Values["unpaid"] != "12.00 €" {
		t.Fatalf("dry run items = %+v", dry.Items)
	}
	if len(dry.Previews) != 1 || dry.Previews[0].Title != "Balance 12.00 €" || dry.Previews[0].RecipientCount != 1 {
		t.Fatalf("previews = %+v", dry.Previews)
	}
	if e.count(`SELECT count(*) FROM notification_firings`) != firingsBefore ||
		e.count(`SELECT count(*) FROM notification_mail_outbox`) != mailsBefore {
		t.Fatal("a dry run wrote something")
	}

	sent, err := e.rules.TestRule(testContext(t), e.author, rule.ID, nil)
	if err != nil || sent.SentEmail != 1 {
		t.Fatalf("test run: %+v, %v", sent, err)
	}
	if e.mails(owing, rule.ID) != 0 || e.count(`SELECT count(*) FROM notification_firings WHERE rule_id=$1 AND test`, rule.ID) != 1 {
		t.Fatal("the test reached somebody else or was not marked as a test")
	}
	if _, err = e.rules.RunRule(testContext(t), e.author, rule.ID, nil); err != nil {
		t.Fatal(err)
	}
	page, err := e.rules.Activity(testContext(t), reader, &rule.ID, 1, 10)
	if err != nil || page.Total != 2 || len(page.Items) != 2 {
		t.Fatalf("activity = %+v, %v", page, err)
	}
	results := map[string]bool{}
	for _, item := range page.Items {
		results[item.Result] = true
		if item.Result == "delivered" && (len(item.Recipients) != 1 || item.Recipients[0].Name == "") {
			t.Fatalf("recipients = %+v", item.Recipients)
		}
	}
	if !results["test"] || !results["delivered"] {
		t.Fatalf("results = %v", results)
	}
	if _, err = e.rules.RunRule(testContext(t), e.author, uuid.New(), nil); !errors.Is(err, apperror.NotFound) {
		t.Fatalf("unknown rule: %v", err)
	}
	event := e.newRule(e.service, nil, inAppAction("operator"))
	if _, err = e.rules.RunRule(testContext(t), e.author, event.ID, nil); err == nil {
		t.Fatal("an event rule could be run")
	}
}

func TestBeforeOpenDayRuleFiresOncePerOpenDayEvenWithTwoSchedulerRuns(t *testing.T) {
	e := newScheduleEnv(t)
	member, cancelledMember := e.person("member"), e.person("cancelled-member")
	start := e.now.Add(4 * time.Hour).Truncate(time.Minute)
	day := e.openDay(start, 3*time.Hour, 2, 0)
	e.join(day, day.supervisorRequirement, member)
	cancelled := e.openDay(start, 3*time.Hour, 2, 0)
	e.join(cancelled, cancelled.supervisorRequirement, cancelledMember)
	e.exec(`UPDATE open_days SET status='cancelled' WHERE id=$1`, cancelled.id)

	hours := 2
	rule := e.newRule(e.service, func(in *notifyrules.RuleInput) {
		in.Name = "Before open day"
		in.Definition.Trigger = notifyrules.TriggerDef{Type: notifyrules.TriggerSchedule, Schedule: &notifyrules.Schedule{
			Repeat: notifyrules.RepeatBeforeOpenDay, Hours: &hours,
		}}
	}, notifyrules.Action{
		Channel: notifyrules.ChannelInApp, Recipients: []string{"day_team"}, Title: "Open day on {day}", Body: "{supervisors} supervisor(s), {free} free",
	})
	// Two hours before the start: after the rule was saved, before the open day.
	e.clock = start.Add(-90 * time.Minute)
	e.runSchedules()
	e.exec(`UPDATE notification_rules SET next_run_at=NULL WHERE id=$1`, rule.ID)
	e.runSchedules()
	if e.notifications(member, rule.ID) != 1 || e.notifications(cancelledMember, rule.ID) != 0 {
		t.Fatalf("member %d, member of the cancelled day %d", e.notifications(member, rule.ID), e.notifications(cancelledMember, rule.ID))
	}
	assertCount(t, e.pool, `SELECT count(*) FROM notification_rule_runs WHERE rule_id=$1`, 1, rule.ID)
	var body string
	if err := e.pool.QueryRow(testContext(t), `SELECT body FROM inbox_notifications WHERE rule_id=$1`, rule.ID).Scan(&body); err != nil {
		t.Fatal(err)
	}
	if body != "1 supervisor(s), 1 free" {
		t.Fatalf("body = %q", body)
	}
}

func TestEscalationStopsWhenTheItemNoLongerMatches(t *testing.T) {
	e := newScheduleEnv(t)
	owing := e.person("owing")
	var fullName string
	if err := e.pool.QueryRow(testContext(t), `SELECT first_name||' '||last_name FROM people WHERE id=$1`, owing.PersonID).Scan(&fullName); err != nil {
		t.Fatal(err)
	}
	filter := notifyrules.ConditionSet{Mode: notifyrules.ModeAll, Items: []notifyrules.ConditionItem{
		{Condition: &notifyrules.Condition{Field: "i.name", Op: notifyrules.OpEq, Value: fullName}},
		{Condition: &notifyrules.Condition{Field: "i.hasAccount", Op: notifyrules.OpYes}},
	}}
	rule := e.scheduleRule("Escalating balance", func(in *notifyrules.RuleInput) {
		in.Definition.Loop = &notifyrules.Loop{Collection: "people", Mode: notifyrules.ModeEach, Filter: filter}
		in.Definition.Escalation = &notifyrules.Escalation{
			StopWhen: notifyrules.ResolutionItemNoLongerMatches,
			Steps: []notifyrules.EscalationStep{{
				After:  notifyrules.Duration{Value: 20, Unit: notifyrules.UnitMinutes},
				Action: notifyrules.Action{Channel: notifyrules.ChannelInApp, Recipients: []string{"item:item"}, Title: "Still unpaid", Body: "Please pay."},
			}},
		}
	}, notifyrules.Action{Channel: notifyrules.ChannelInApp, Recipients: []string{"item:item"}, Title: "Balance", Body: "Please pay."})
	// Test accounts share their names, so other people match the filter too; look at this person's waiting step only.
	ownPending := func() int {
		return e.count(`SELECT count(*) FROM notification_pending_actions p JOIN notification_firings f ON f.id=p.firing_id
			WHERE f.rule_id=$1 AND p.recipients @> jsonb_build_array($2::text)`, rule.ID, owing.PersonID.String())
	}
	if _, err := e.rules.RunRule(testContext(t), e.author, rule.ID, nil); err != nil {
		t.Fatal(err)
	}
	if e.notifications(owing, rule.ID) != 1 || ownPending() != 1 {
		t.Fatalf("notifications %d, pending %d", e.notifications(owing, rule.ID), ownPending())
	}
	// The item stops matching in the meantime: the escalation step is dropped instead of sent.
	e.exec(`UPDATE accounts SET status='disabled' WHERE person_id=$1`, owing.PersonID)
	e.clock = e.clock.Add(30 * time.Minute)
	e.runPending()
	if e.notifications(owing, rule.ID) != 1 || ownPending() != 0 {
		t.Fatalf("after the item stopped matching: notifications %d, pending %d", e.notifications(owing, rule.ID), ownPending())
	}
	assertCount(t, e.pool, `SELECT count(*) FROM notification_firings WHERE rule_id=$1 AND resolved_reason='item_no_longer_matches'`, 1, rule.ID)
}

func TestEveryCollectionCanBeLoadedByARule(t *testing.T) {
	e := newScheduleEnv(t)
	loader := e.person("collections", e.grant(
		authorization.NotificationRulesManage, authorization.PeopleReadAll, authorization.OrdersRead,
		authorization.OpenDaysRead, authorization.OpenDaysReadAssignments, authorization.MachinesRead,
		authorization.MachineJobsRead, authorization.InventoryRead, authorization.TrainingRecordsReadAll,
		authorization.ExternalInvoiceRequestsRead, authorization.AttendanceRead, authorization.LaborordnungConfirmationsRead,
	))
	e.unpaidOrder(loader, "finalized", 20)
	for _, collection := range notifyrules.Collections() {
		for _, mode := range []notifyrules.Mode{notifyrules.ModeEach, notifyrules.ModeSummary} {
			input := notifyrules.RuleInput{
				Name: collection.Key, Enabled: true,
				Definition: notifyrules.Definition{
					Trigger:    notifyrules.TriggerDef{Type: notifyrules.TriggerManual},
					Loop:       &notifyrules.Loop{Collection: collection.Key, Mode: mode, Filter: notifyrules.ConditionSet{Mode: notifyrules.ModeAll}},
					Conditions: notifyrules.ConditionSet{Mode: notifyrules.ModeAll},
					Actions: []notifyrules.Action{{
						Channel: notifyrules.ChannelInApp, Recipients: []string{"person:" + loader.PersonID.String()}, Title: "Hello", Body: "World",
					}},
				},
			}
			result, err := e.rules.DryRun(testContext(t), loader, input, false)
			if err != nil {
				t.Fatalf("%s (%s): %v", collection.Key, mode, err)
			}
			if mode == notifyrules.ModeSummary && result.Summary == nil {
				t.Fatalf("%s: no summary", collection.Key)
			}
			if collection.Key == "people" && mode == notifyrules.ModeEach && result.TotalItems == 0 {
				t.Fatal("no people were loaded")
			}
			if collection.Key == "orders" && mode == notifyrules.ModeEach && (result.TotalItems != 1 || result.Items[0].Values["outstanding"] != "20.00 €" ||
				result.Items[0].Values["status"] != "Open") {
				t.Fatalf("orders = %+v", result.Items)
			}
		}
	}
}
