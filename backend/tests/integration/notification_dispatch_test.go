package integration_test

import (
	"fmt"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type dispatchEnv struct {
	*rulesEnv
	dispatcher *notifyrules.Dispatcher
	manager    authorization.Principal
	clock      time.Time
}

func newDispatchEnv(t *testing.T) *dispatchEnv {
	t.Helper()
	env := &dispatchEnv{rulesEnv: newRulesEnv(t), clock: time.Now().UTC().Truncate(time.Second)}
	env.dispatcher = notifyrules.NewDispatcher(env.pool, time.UTC).WithClock(func() time.Time { return env.clock })
	env.manager = env.person("dispatch-manager", env.grant(authorization.NotificationRulesManage, authorization.MachinesRead))
	return env
}

func (e *dispatchEnv) tx(fn func(tx pgx.Tx) error) {
	e.t.Helper()
	ctx := testContext(e.t)
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		e.t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := fn(tx); err != nil {
		e.t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		e.t.Fatal(err)
	}
}

func (e *dispatchEnv) emit(ev notifyrules.Event) {
	e.t.Helper()
	ev.OccurredAt = e.clock
	e.tx(func(tx pgx.Tx) error { return e.dispatcher.Emit(testContext(e.t), tx, ev) })
}

func (e *dispatchEnv) resolve(token string) {
	e.t.Helper()
	e.tx(func(tx pgx.Tx) error { return e.dispatcher.Resolve(testContext(e.t), tx, token, "error_cleared") })
}

func (e *dispatchEnv) runPending() int {
	e.t.Helper()
	handled, err := e.dispatcher.RunPending(testContext(e.t), 50)
	if err != nil {
		e.t.Fatal(err)
	}
	return handled
}

func printerError(level string, operators ...uuid.UUID) notifyrules.Event {
	return notifyrules.Event{
		Trigger:      "printer_error",
		Fields:       map[string]any{"level": level, "printing": true},
		Placeholders: map[string]string{"machine": "Printer 7", "code": "0300-0100"},
		Recipients:   map[string][]uuid.UUID{"operator": operators},
		Link:         "/machines/7",
	}
}

func inAppAction(recipients ...string) notifyrules.Action {
	return notifyrules.Action{
		Channel: notifyrules.ChannelInApp, Recipients: recipients, Title: "{machine} reports {code}", Body: "Please have a look.",
	}
}

func emailAction(recipients ...string) notifyrules.Action {
	return notifyrules.Action{
		Channel: notifyrules.ChannelEmail, Recipients: recipients, Title: "{machine} reports {code}", Body: "Please have a look.",
	}
}

func (e *dispatchEnv) newRule(category uuid.UUID, mutate func(*notifyrules.RuleInput), actions ...notifyrules.Action) notifyrules.Rule {
	e.t.Helper()
	e.counter++
	input := notifyrules.RuleInput{
		Name: fmt.Sprintf("Dispatch rule %d", e.counter), Enabled: true, CategoryID: &category,
		Definition: notifyrules.Definition{
			Trigger:    notifyrules.TriggerDef{Type: notifyrules.TriggerEvent, Event: "printer_error"},
			Conditions: notifyrules.ConditionSet{Mode: notifyrules.ModeAll},
			Actions:    actions,
		},
	}
	if mutate != nil {
		mutate(&input)
	}
	rule, err := e.rules.CreateRule(testContext(e.t), e.manager, input, nil)
	if err != nil {
		e.t.Fatalf("create rule: %v (%+v)", err, err)
	}
	return rule
}

func (e *dispatchEnv) notifications(p authorization.Principal, rule uuid.UUID) int {
	e.t.Helper()
	var n int
	if err := e.pool.QueryRow(testContext(e.t), `SELECT count(*) FROM inbox_recipients r
		JOIN inbox_notifications n ON n.id = r.notification_id
		WHERE r.account_id=$1 AND n.kind='rule' AND n.rule_id=$2`, p.AccountID, rule).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n
}

func (e *dispatchEnv) mails(p authorization.Principal, rule uuid.UUID) int {
	e.t.Helper()
	var n int
	if err := e.pool.QueryRow(testContext(e.t), `SELECT count(*) FROM notification_mail_outbox m
		JOIN notification_firings f ON f.id = m.firing_id
		WHERE m.kind='rule' AND m.person_id=$1 AND f.rule_id=$2`, p.PersonID, rule).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n
}

func (e *dispatchEnv) statuses(p authorization.Principal, rule uuid.UUID, status string) int {
	e.t.Helper()
	var n int
	if err := e.pool.QueryRow(testContext(e.t), `SELECT count(*) FROM notification_firing_recipients fr
		JOIN notification_firings f ON f.id = fr.firing_id
		WHERE f.rule_id=$1 AND fr.person_id=$2 AND fr.status=$3`, rule, p.PersonID, status).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n
}

func (e *dispatchEnv) count(query string, args ...any) int {
	e.t.Helper()
	var n int
	if err := e.pool.QueryRow(testContext(e.t), query, args...).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n
}

func (e *dispatchEnv) firings(rule uuid.UUID) int {
	e.t.Helper()
	return e.count(`SELECT count(*) FROM notification_firings WHERE rule_id=$1`, rule)
}

func (e *dispatchEnv) pending(rule uuid.UUID) int {
	e.t.Helper()
	return e.count(`SELECT count(*) FROM notification_pending_actions p JOIN notification_firings f ON f.id=p.firing_id WHERE f.rule_id=$1`, rule)
}

func TestDispatchDeliversInAppAndMailForMatchingEventsOnly(t *testing.T) {
	e := newDispatchEnv(t)
	operator, bystander := e.person("operator"), e.person("bystander")
	rule := e.newRule(e.service, func(in *notifyrules.RuleInput) {
		in.Definition.Conditions.Items = []notifyrules.ConditionItem{
			{Condition: &notifyrules.Condition{Field: "e.level", Op: notifyrules.OpGte, Value: "serious"}},
		}
	}, inAppAction("operator"), emailAction("operator"))

	// Mail delivery is off: only the in-app notification is written.
	e.emit(printerError("fatal", operator.PersonID))
	if e.notifications(operator, rule.ID) != 1 || e.mails(operator, rule.ID) != 0 {
		t.Fatalf("with mail off: %d notifications, %d mails", e.notifications(operator, rule.ID), e.mails(operator, rule.ID))
	}
	var title, link string
	if err := e.pool.QueryRow(testContext(t), `SELECT n.title, COALESCE(n.link,'') FROM inbox_notifications n WHERE n.rule_id=$1`, rule.ID).Scan(&title, &link); err != nil {
		t.Fatal(err)
	}
	if title != "Printer 7 reports 0300-0100" || link != "/machines/7" {
		t.Fatalf("notification = %q, %q", title, link)
	}

	e.exec(`UPDATE mail_configuration SET enabled=true`)
	e.emit(printerError("serious", operator.PersonID))
	if e.notifications(operator, rule.ID) != 2 || e.mails(operator, rule.ID) != 1 {
		t.Fatalf("with mail on: %d notifications, %d mails", e.notifications(operator, rule.ID), e.mails(operator, rule.ID))
	}
	if e.notifications(bystander, rule.ID) != 0 {
		t.Fatal("a person the event does not concern was notified")
	}
	// A level below the condition and an event nobody is addressed by write nothing.
	e.emit(printerError("common", operator.PersonID))
	e.emit(printerError("fatal"))
	if e.firings(rule.ID) != 2 || e.statuses(operator, rule.ID, "sent") != 3 {
		t.Fatalf("firings %d, sent rows %d", e.firings(rule.ID), e.statuses(operator, rule.ID, "sent"))
	}
	assertCount(t, e.pool, `SELECT count(*) FROM notification_rules WHERE id=$1 AND last_fired_at IS NOT NULL`, 1, rule.ID)
}

func TestDispatchOnlyReachesConsentingPeopleInConsentCategories(t *testing.T) {
	e := newDispatchEnv(t)
	yes, no := e.person("consenting"), e.person("silent")
	if _, err := e.rules.AnswerConsents(testContext(t), yes, []notifyrules.ConsentAnswer{{CategoryID: e.news, Granted: true}}, notifyrules.PlaceApp, nil, nil); err != nil {
		t.Fatal(err)
	}
	news := e.newRule(e.news, nil, inAppAction("operator"))
	service := e.newRule(e.service, nil, inAppAction("operator"))
	e.emit(printerError("fatal", yes.PersonID, no.PersonID, yes.PersonID))

	if e.notifications(yes, news.ID) != 1 || e.notifications(no, news.ID) != 0 || e.statuses(no, news.ID, "skipped_consent") != 1 {
		t.Fatalf("consent category: yes=%d no=%d skipped=%d", e.notifications(yes, news.ID), e.notifications(no, news.ID), e.statuses(no, news.ID, "skipped_consent"))
	}
	if e.notifications(yes, service.ID) != 1 || e.notifications(no, service.ID) != 1 {
		t.Fatal("a required category must reach everybody")
	}
	// An answer given to an older text no longer counts.
	e.exec(`UPDATE notification_categories SET text_version = text_version + 1 WHERE id=$1`, e.news)
	e.emit(printerError("fatal", yes.PersonID))
	e.exec(`UPDATE notification_categories SET text_version = text_version - 1 WHERE id=$1`, e.news)
	if e.notifications(yes, news.ID) != 1 || e.statuses(yes, news.ID, "skipped_consent") != 1 {
		t.Fatal("an answer to an outdated text still delivered")
	}
}

func TestDispatchHonoursChannelChoicesAndMandatoryRules(t *testing.T) {
	e := newDispatchEnv(t)
	e.exec(`UPDATE mail_configuration SET enabled=true`)
	muted, mailOnly, plain := e.person("muted"), e.person("mailonly"), e.person("plain")
	optional := e.newRule(e.service, nil, inAppAction("operator"))
	mandatory := e.newRule(e.service, func(in *notifyrules.RuleInput) { in.Mandatory = true }, inAppAction("operator"))
	ctx := testContext(t)
	if err := e.rules.SetRulePreference(ctx, muted, optional.ID, notifyrules.Preference{}); err != nil {
		t.Fatal(err)
	}
	if err := e.rules.SetRulePreference(ctx, mailOnly, optional.ID, notifyrules.Preference{Email: true}); err != nil {
		t.Fatal(err)
	}
	if err := e.rules.SetRulePreference(ctx, mailOnly, mandatory.ID, notifyrules.Preference{Email: true}); err != nil {
		t.Fatal(err)
	}
	// The service refuses to mute a mandatory rule; even a row that got there some other way keeps the defaults.
	e.exec(`INSERT INTO notification_rule_preferences(account_id, rule_id, in_app, email) VALUES ($1,$2,false,false)`, muted.AccountID, mandatory.ID)

	e.emit(printerError("fatal", muted.PersonID, mailOnly.PersonID, plain.PersonID))

	if e.notifications(muted, optional.ID) != 0 || e.statuses(muted, optional.ID, "skipped_muted") != 1 || e.mails(muted, optional.ID) != 0 {
		t.Fatal("a muted rule was delivered")
	}
	if e.notifications(muted, mandatory.ID) != 1 {
		t.Fatal("a mandatory rule must keep its channel")
	}
	if e.notifications(mailOnly, optional.ID) != 0 || e.mails(mailOnly, optional.ID) != 1 {
		t.Fatalf("mail-only choice: %d notifications, %d mails", e.notifications(mailOnly, optional.ID), e.mails(mailOnly, optional.ID))
	}
	if e.notifications(mailOnly, mandatory.ID) != 0 || e.mails(mailOnly, mandatory.ID) != 1 {
		t.Fatal("a mandatory rule must still reach somebody who chose mail only")
	}
	if e.notifications(plain, optional.ID) != 1 || e.mails(plain, optional.ID) != 0 {
		t.Fatal("defaults changed for somebody without a choice")
	}
}

func TestDispatchThrottlesPerSubject(t *testing.T) {
	e := newDispatchEnv(t)
	operator := e.person("throttled")
	rule := e.newRule(e.service, func(in *notifyrules.RuleInput) {
		in.Definition.Throttle = &notifyrules.Throttle{Per: "machine", Every: notifyrules.Duration{Value: 30, Unit: notifyrules.UnitMinutes}}
	}, inAppAction("operator"))
	withMachine := func(machine string) notifyrules.Event {
		ev := printerError("fatal", operator.PersonID)
		ev.Subjects = map[string]string{"machine": machine}
		return ev
	}
	e.emit(withMachine("m1"))
	e.emit(withMachine("m1"))
	if e.firings(rule.ID) != 1 || e.notifications(operator, rule.ID) != 1 {
		t.Fatalf("a second event within the window fired: %d firings", e.firings(rule.ID))
	}
	e.emit(withMachine("m2"))
	if e.firings(rule.ID) != 2 {
		t.Fatal("another machine was throttled")
	}
	e.exec(`UPDATE notification_throttle SET last_at = last_at - interval '1 hour' WHERE rule_id=$1`, rule.ID)
	e.emit(withMachine("m1"))
	if e.firings(rule.ID) != 3 {
		t.Fatal("the window never ended")
	}

	perPerson := e.newRule(e.service, func(in *notifyrules.RuleInput) {
		in.Definition.Throttle = &notifyrules.Throttle{Per: "person", Every: notifyrules.Duration{Value: 1, Unit: notifyrules.UnitHours}}
	}, inAppAction("operator"))
	other := e.person("other")
	e.emit(printerError("fatal", operator.PersonID))
	e.emit(printerError("fatal", operator.PersonID, other.PersonID))
	if e.notifications(operator, perPerson.ID) != 1 || e.notifications(other, perPerson.ID) != 1 || e.statuses(operator, perPerson.ID, "throttled") != 1 {
		t.Fatalf("per-person throttle: operator %d, other %d", e.notifications(operator, perPerson.ID), e.notifications(other, perPerson.ID))
	}
}

func TestDispatchFiltersRecipientsByTheirOwnFacts(t *testing.T) {
	e := newDispatchEnv(t)
	supervisor := e.person("sup", e.membershipRole("supervisor").ID)
	trainee := e.person("trainee", e.membershipRole("trainee").ID)
	rule := e.newRule(e.service, func(in *notifyrules.RuleInput) {
		in.Definition.Conditions.Items = []notifyrules.ConditionItem{
			{Condition: &notifyrules.Condition{Field: "r.systemRole", Op: notifyrules.OpIs, Value: "supervisor"}},
		}
	}, inAppAction("operator"))
	e.emit(printerError("fatal", supervisor.PersonID, trainee.PersonID))
	if e.notifications(supervisor, rule.ID) != 1 || e.notifications(trainee, rule.ID) != 0 || e.statuses(trainee, rule.ID, "skipped_condition") != 1 {
		t.Fatal("r.systemRole did not filter the recipients")
	}

	// Nobody passes: no firing at all.
	onlyTrainees := e.newRule(e.service, func(in *notifyrules.RuleInput) {
		in.Definition.Conditions.Items = []notifyrules.ConditionItem{
			{Condition: &notifyrules.Condition{Field: "r.systemRole", Op: notifyrules.OpIs, Value: "visitor"}},
		}
	}, inAppAction("operator"))
	e.emit(printerError("fatal", supervisor.PersonID, trainee.PersonID))
	if e.firings(onlyTrainees.ID) != 0 {
		t.Fatal("a rule nobody passes still fired")
	}

	// A fact the engine cannot load never widens the audience.
	unpaid := e.newRule(e.service, func(in *notifyrules.RuleInput) {
		in.Definition.Conditions.Items = []notifyrules.ConditionItem{
			{Condition: &notifyrules.Condition{Field: "r.unpaid", Op: notifyrules.OpGt, Value: 0.0}},
		}
	}, inAppAction("operator"))
	e.emit(printerError("fatal", supervisor.PersonID))
	if e.firings(unpaid.ID) != 0 || e.notifications(supervisor, unpaid.ID) != 0 {
		t.Fatal("an unloadable recipient fact let the rule through")
	}
}

func TestDispatchDeliversPersonalSubscriptionsToTheirOwnerOnly(t *testing.T) {
	e := newDispatchEnv(t)
	roleID := e.grant(authorization.MachinesRead)
	owner := e.person("subscriber", roleID)
	other := e.person("other-subscriber", roleID)
	input := notifyrules.RuleInput{
		Name: "My printer errors", Enabled: true,
		Definition: notifyrules.Definition{
			Trigger:    notifyrules.TriggerDef{Type: notifyrules.TriggerEvent, Event: "printer_error"},
			Conditions: notifyrules.ConditionSet{Mode: notifyrules.ModeAll},
			Actions:    []notifyrules.Action{inAppAction("me")},
		},
	}
	rule, err := e.rules.CreateSubscription(testContext(t), owner, input, nil)
	if err != nil {
		t.Fatalf("create subscription: %v", err)
	}
	// The owner is not among the event's recipients: a subscription follows the lab.
	e.emit(printerError("fatal", other.PersonID))
	if e.notifications(owner, rule.ID) != 1 || e.notifications(other, rule.ID) != 0 {
		t.Fatalf("subscription: owner %d, other %d", e.notifications(owner, rule.ID), e.notifications(other, rule.ID))
	}
	// Losing the permission silences the subscription.
	e.exec(`DELETE FROM person_roles WHERE person_id=$1 AND role_id=$2`, owner.PersonID, roleID)
	e.emit(printerError("fatal", other.PersonID))
	if e.notifications(owner, rule.ID) != 1 {
		t.Fatal("a subscription kept delivering data its owner may no longer see")
	}
}

func TestDispatchWaitsForDelaysFallbacksAndEscalations(t *testing.T) {
	e := newDispatchEnv(t)
	e.exec(`UPDATE mail_configuration SET enabled=true`)
	operator, lead := e.person("waiting-operator"), e.person("waiting-lead")
	five := 5
	delayed := inAppAction("operator")
	delayed.DelayMinutes = 10
	fallback := inAppAction("operator")
	fallback.InApp = &notifyrules.InAppOptions{
		Appearance: notifyrules.AppearanceBell, Level: notifyrules.LevelWarning, EmailFallbackMinutes: &five,
	}
	rule := e.newRule(e.service, func(in *notifyrules.RuleInput) {
		in.Definition.Escalation = &notifyrules.Escalation{
			StopWhen: "error_cleared",
			Steps: []notifyrules.EscalationStep{{
				After: notifyrules.Duration{Value: 20, Unit: notifyrules.UnitMinutes}, Action: inAppAction(fmt.Sprintf("person:%s", lead.PersonID)),
			}},
		}
	}, delayed, fallback)

	ev := printerError("fatal", operator.PersonID)
	ev.ResolveToken = "printer:7:0300"
	e.emit(ev)
	// Immediate: one notification. Waiting: the delayed action, the e-mail fallback and the escalation step.
	if e.notifications(operator, rule.ID) != 1 || e.pending(rule.ID) != 3 {
		t.Fatalf("after the event: %d notifications, %d waiting", e.notifications(operator, rule.ID), e.pending(rule.ID))
	}
	if e.runPending() != 0 {
		t.Fatal("nothing is due yet")
	}

	// Resolving stops the escalation and the fallback but not the delayed first action.
	e.resolve("printer:7:0300")
	if e.pending(rule.ID) != 1 {
		t.Fatalf("after resolving %d actions wait, want the delayed one", e.pending(rule.ID))
	}
	e.clock = e.clock.Add(11 * time.Minute)
	if e.runPending() != 1 || e.notifications(operator, rule.ID) != 2 || e.pending(rule.ID) != 0 {
		t.Fatalf("delayed action: %d notifications, %d waiting", e.notifications(operator, rule.ID), e.pending(rule.ID))
	}
	if e.notifications(lead, rule.ID) != 0 || e.mails(operator, rule.ID) != 0 {
		t.Fatal("a resolved firing escalated")
	}

	// An unresolved firing escalates and mails the people who did not read.
	ev.ResolveToken = "printer:7:0301"
	e.emit(ev)
	e.clock = e.clock.Add(6 * time.Minute)
	if e.runPending() != 1 || e.mails(operator, rule.ID) != 1 || e.statuses(operator, rule.ID, "fallback") != 1 {
		t.Fatalf("fallback: %d mails, %d fallback rows", e.mails(operator, rule.ID), e.statuses(operator, rule.ID, "fallback"))
	}
	e.clock = e.clock.Add(15 * time.Minute)
	if e.runPending() != 2 || e.notifications(lead, rule.ID) != 1 {
		t.Fatalf("escalation: lead has %d notifications", e.notifications(lead, rule.ID))
	}
}

func TestDispatchFallbackMailSkipsReadNotificationsAndReadingStopsEscalation(t *testing.T) {
	e := newDispatchEnv(t)
	e.exec(`UPDATE mail_configuration SET enabled=true`)
	operator, lead := e.person("reader"), e.person("lead")
	five := 5
	notify := inAppAction("operator")
	notify.InApp = &notifyrules.InAppOptions{
		Appearance: notifyrules.AppearanceBell, Level: notifyrules.LevelInfo, EmailFallbackMinutes: &five,
	}
	rule := e.newRule(e.service, func(in *notifyrules.RuleInput) {
		in.Definition.Escalation = &notifyrules.Escalation{
			StopWhen: "opened",
			Steps: []notifyrules.EscalationStep{{
				After: notifyrules.Duration{Value: 10, Unit: notifyrules.UnitMinutes}, Action: inAppAction(fmt.Sprintf("person:%s", lead.PersonID)),
			}},
		}
	}, notify)
	e.emit(printerError("fatal", operator.PersonID))
	e.exec(`UPDATE inbox_recipients SET read_at=now() WHERE account_id=$1`, operator.AccountID)

	e.clock = e.clock.Add(30 * time.Minute)
	e.runPending()
	if e.mails(operator, rule.ID) != 0 || e.notifications(lead, rule.ID) != 0 || e.pending(rule.ID) != 0 {
		t.Fatalf("reading did not stop the follow-ups: %d mails, %d lead notifications, %d waiting",
			e.mails(operator, rule.ID), e.notifications(lead, rule.ID), e.pending(rule.ID))
	}
	assertCount(t, e.pool, `SELECT count(*) FROM notification_firings WHERE rule_id=$1 AND resolved_reason='opened'`, 1, rule.ID)
}

func TestDispatchContainsBrokenRules(t *testing.T) {
	e := newDispatchEnv(t)
	operator := e.person("survivor")
	good := e.newRule(e.service, nil, inAppAction("operator"))
	broken := e.newRule(e.service, nil, inAppAction("operator"))
	e.exec(`UPDATE notification_rules SET definition = '{"trigger": 5}'::jsonb WHERE id=$1`, broken.ID)
	// A definition that parses but whose delivery fails inside the database is rolled back to its savepoint.
	failing := e.newRule(e.service, nil, inAppAction("operator"))
	e.exec(`UPDATE notification_rules SET definition = jsonb_set(definition, '{actions,0,recipients}', to_jsonb(ARRAY['person:00000000-0000-7000-8000-000000000001'])) WHERE id=$1`, failing.ID)

	e.emit(printerError("fatal", operator.PersonID))
	if e.notifications(operator, good.ID) != 1 || e.firings(broken.ID) != 0 {
		t.Fatal("one broken rule stopped the others")
	}
}

func TestDispatchLeavesOutExcludedPeopleAndMailsOrganizationsOnly(t *testing.T) {
	e := newDispatchEnv(t)
	operator, actor := e.person("operator"), e.person("actor")
	organization := uuid.Must(uuid.NewV7())
	e.exec(`INSERT INTO organizations (id, name, kind, contact_email) VALUES ($1, 'Dispatch Org', 'other', 'org-dispatch@example.test')`, organization)
	e.exec(`UPDATE mail_configuration SET enabled=true`)
	rule := e.newRule(e.service, nil, inAppAction("operator", "recipient"), emailAction("operator", "recipient"))

	event := printerError("serious", operator.PersonID, actor.PersonID)
	event.Recipients["recipient"] = []uuid.UUID{actor.PersonID}
	event.Organizations = map[string][]uuid.UUID{"recipient": {organization}}
	event.ExcludedPeople = []uuid.UUID{actor.PersonID}
	e.emit(event)

	if e.notifications(operator, rule.ID) != 1 || e.mails(operator, rule.ID) != 1 {
		t.Fatalf("operator: %d notifications, %d mails", e.notifications(operator, rule.ID), e.mails(operator, rule.ID))
	}
	if e.notifications(actor, rule.ID) != 0 || e.mails(actor, rule.ID) != 0 {
		t.Fatal("an excluded person was notified")
	}
	// The organization gets the e-mail only, with no in-app notification and no account.
	assertCount(t, e.pool, `SELECT count(*) FROM notification_mail_outbox m JOIN notification_firings f ON f.id = m.firing_id
		WHERE f.rule_id=$1 AND m.organization_id=$2`, 1, rule.ID, organization)
}
