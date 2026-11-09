package integration_test

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/attendance"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/orders"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/privacy"
	requestsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/subjectrequests/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/surveys"
	"github.com/google/uuid"
)

// The real orders service raises payment_recorded to the customer and to whoever recorded the payment.
func TestNotificationPaymentRecordedThroughTheOrdersService(t *testing.T) {
	e := newTriggerEnv(t)
	customer := e.person("paying-customer")
	bystander := e.person("payment-bystander")
	booker := authorization.Principal{
		AccountID: e.manager.AccountID, PersonID: e.manager.PersonID, Master: true,
		Assurance: authorization.AssuranceNormal, AuthenticatedAt: time.Now().UTC(),
	}
	input := eventRule("payment_recorded", "customer", "booker")
	input.CategoryID = &e.service
	input.Definition.Actions[0].Title = "Payment of {amount} on {order}"
	rule, err := e.rules.CreateRule(testContext(t), booker, input, nil)
	if err != nil {
		t.Fatalf("create rule: %v", err)
	}
	service := orders.NewService(e.pool, nil).WithNotifications(notifyrules.NewSystemEvents(nil))
	ctx := testContext(t)

	order, err := service.Create(ctx, booker, orders.OrderDraftInput{
		Customer: &orders.OrderCustomer{Kind: orders.CustomerPerson, ID: customer.PersonID},
	}, nil)
	if err != nil {
		t.Fatalf("create order: %v", err)
	}
	if order, err = service.ChangeItem(ctx, booker, order.ID, uuid.Nil, orders.OrderItemInput{
		Kind: "manual", Description: "Service", Quantity: "1", Unit: "service", UnitPrice: "12.50", ExpectedVersion: order.Version,
	}, "add", nil); err != nil {
		t.Fatalf("add item: %v", err)
	}
	if e.told(customer.PersonID, rule.ID) != 0 {
		t.Fatal("a draft order already told the customer about a payment")
	}
	if order, err = service.Command(ctx, booker, order.ID, orders.OrderCommand{OperationKey: ids.New(), ExpectedVersion: order.Version}, "finalize", nil); err != nil {
		t.Fatalf("finalize: %v", err)
	}
	if _, err = service.RecordPayment(ctx, booker, order.ID, orders.RecordOrderPayment{
		OperationKey: ids.New(), ExpectedVersion: order.Version,
		Payment: orders.PaymentInput{Method: "cash", Amount: "12.50", OccurredAt: time.Now().UTC()},
	}, nil); err != nil {
		t.Fatalf("record payment: %v", err)
	}
	if e.told(customer.PersonID, rule.ID) != 1 || e.told(booker.PersonID, rule.ID) != 1 || e.told(bystander.PersonID, rule.ID) != 0 {
		t.Fatalf("payment: customer %d, booker %d, bystander %d",
			e.told(customer.PersonID, rule.ID), e.told(booker.PersonID, rule.ID), e.told(bystander.PersonID, rule.ID))
	}
	if titles := e.titles(rule.ID); len(titles) != 1 || titles[0] != "Payment of € 12.50 on "+order.Reference {
		t.Fatalf("titles = %q", titles)
	}
}

// A PIN check-in at a kiosk and an identified check-out raise check_in and check_out through the attendance service.
func TestNotificationCheckInAndCheckOutThroughTheAttendanceService(t *testing.T) {
	f := newCheckInFixture(t, "not_required")
	f.attendance.WithNotifications(notifyrules.NewSystemEvents(nil))
	ctx := testContext(t)
	rules := notifyrules.NewService(f.pool)
	var service uuid.UUID
	if err := f.pool.QueryRow(ctx, `SELECT id FROM notification_categories WHERE key='service'`).Scan(&service); err != nil {
		t.Fatal(err)
	}
	create := func(event, title string) notifyrules.Rule {
		input := eventRule(event, "self")
		input.CategoryID = &service
		input.Definition.Actions[0].Title = title
		rule, err := rules.CreateRule(ctx, f.master, input, nil)
		if err != nil {
			t.Fatalf("create %s rule: %v", event, err)
		}
		return rule
	}
	told := func(rule uuid.UUID) int {
		var n int
		if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM inbox_recipients r JOIN inbox_notifications n ON n.id=r.notification_id
			JOIN accounts a ON a.id=r.account_id WHERE a.person_id=$1 AND n.rule_id=$2`, f.visitor.personID, rule).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	checkIn, checkOut := create("check_in", "{person} arrived {method}"), create("check_out", "{person} left")

	visit, err := f.pinCheckIn(t, attendance.LabRulesChoice{})
	if err != nil {
		t.Fatalf("pin check-in: %v", err)
	}
	if told(checkIn.ID) != 1 || told(checkOut.ID) != 0 {
		t.Fatalf("after check-in: check_in %d, check_out %d", told(checkIn.ID), told(checkOut.ID))
	}
	if _, err = f.attendance.PINCheckOut(ctx, f.device, "kiosk.visitor", "123456", "kiosk-test", nil); err != nil {
		t.Fatalf("pin check-out for visit %s: %v", visit.ID, err)
	}
	if told(checkIn.ID) != 1 || told(checkOut.ID) != 1 {
		t.Fatalf("after check-out: check_in %d, check_out %d", told(checkIn.ID), told(checkOut.ID))
	}
}

// Withdrawing a granted consent stamps the withdrawal; the retention handler deletes it three years later and keeps
// declines and fresh withdrawals.
func TestNotificationConsentWithdrawalIsStampedAndRetained(t *testing.T) {
	e := newRulesEnv(t)
	ctx := testContext(t)
	person := e.person("withdrawer")
	decliner := e.person("decliner")
	answer := func(p authorization.Principal, granted bool) {
		t.Helper()
		if _, err := e.rules.AnswerConsents(ctx, p, []notifyrules.ConsentAnswer{{CategoryID: e.news, Granted: granted}}, notifyrules.PlaceApp, nil, nil); err != nil {
			t.Fatal(err)
		}
	}
	withdrawn := func(p authorization.Principal) (stamp *time.Time, rows int) {
		t.Helper()
		err := e.pool.QueryRow(ctx, `SELECT max(withdrawn_at), count(*) FROM notification_consents WHERE person_id=$1`, p.PersonID).Scan(&stamp, &rows)
		if err != nil {
			t.Fatal(err)
		}
		return stamp, rows
	}
	answer(decliner, false)
	if stamp, rows := withdrawn(decliner); stamp != nil || rows != 1 {
		t.Fatalf("a first decline is no withdrawal: %v, %d rows", stamp, rows)
	}
	answer(person, true)
	if stamp, _ := withdrawn(person); stamp != nil {
		t.Fatal("a granted consent has a withdrawal time")
	}
	answer(person, false)
	stamp, _ := withdrawn(person)
	if stamp == nil || time.Since(*stamp) > time.Minute {
		t.Fatalf("withdrawal not stamped: %v", stamp)
	}
	answer(person, true)
	if stamp, _ = withdrawn(person); stamp != nil {
		t.Fatal("granting again kept the withdrawal time")
	}
	answer(person, false)

	run := func(cutoff time.Time) int64 {
		t.Helper()
		var deleted int64
		tx, err := e.pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		if deleted, err = notifyrules.ConsentRetention().Apply(ctx, tx, privacy.ActionDelete, cutoff, 0); err != nil {
			t.Fatal(err)
		}
		if err = tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		return deleted
	}
	three := time.Now().AddDate(-3, 0, 0)
	if run(three) != 0 {
		t.Fatal("a fresh withdrawal was deleted")
	}
	e.exec(`UPDATE notification_consents SET withdrawn_at = now() - interval '1200 days' WHERE person_id=$1`, person.PersonID)
	e.exec(`UPDATE notification_consents SET answered_at = now() - interval '1200 days' WHERE person_id=$1`, decliner.PersonID)
	if run(three) != 1 {
		t.Fatal("the old withdrawal was not deleted exactly once")
	}
	if _, rows := withdrawn(person); rows != 0 {
		t.Fatal("withdrawn consent survived")
	}
	if _, rows := withdrawn(decliner); rows != 1 {
		t.Fatal("a decline that was never granted was deleted")
	}
}

// Expired tablet offers are deleted a day after their expiry; the data-subject export lists the ask dates only.
func TestNotificationOfferRetentionAndAskCooldownExport(t *testing.T) {
	e := newCheckoutEnv(t, true)
	a, _ := e.person("retained", true, e.device.Device.ID)
	if e.selfCheckOut(a, e.device).SurveyOffer == nil {
		t.Fatal("no survey was offered")
	}
	run := func(cutoff time.Time) int64 {
		t.Helper()
		tx, err := e.pool.Begin(e.ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(e.ctx) }()
		deleted, err := surveys.OfferRetention().Apply(e.ctx, tx, privacy.ActionDelete, cutoff, 0)
		if err != nil {
			t.Fatal(err)
		}
		if err = tx.Commit(e.ctx); err != nil {
			t.Fatal(err)
		}
		return deleted
	}
	if _, err := e.pool.Exec(e.ctx, `UPDATE survey_offers SET expires_at = now() - interval '2 hours'`); err != nil {
		t.Fatal(err)
	}
	if run(time.Now().Add(-24*time.Hour)) != 0 || e.count(`SELECT count(*) FROM survey_offers`) != 1 {
		t.Fatal("an offer that expired two hours ago was deleted")
	}
	if _, err := e.pool.Exec(e.ctx, `UPDATE survey_offers SET expires_at = now() - interval '2 days'`); err != nil {
		t.Fatal(err)
	}
	if run(time.Now().Add(-24*time.Hour)) != 1 || e.count(`SELECT count(*) FROM survey_offers`) != 0 {
		t.Fatal("an offer that expired two days ago was kept")
	}

	raw, err := requestsdb.New(e.pool).ExportSurveyInvitations(e.ctx, a.personID)
	if err != nil {
		t.Fatal(err)
	}
	var document struct {
		Invitations  []json.RawMessage `json:"invitations"`
		AskCooldowns []map[string]any  `json:"askCooldowns"`
	}
	if err = json.Unmarshal(raw, &document); err != nil {
		t.Fatalf("export is not JSON: %v", err)
	}
	if len(document.AskCooldowns) != 1 {
		t.Fatalf("ask cooldowns = %v", document.AskCooldowns)
	}
	asked, _ := document.AskCooldowns[0]["askedOn"].(string)
	if _, err = time.Parse("2006-01-02", asked); err != nil || len(document.AskCooldowns[0]) != 2 {
		t.Fatalf("ask cooldown must hold the survey and a date only: %v", document.AskCooldowns[0])
	}
	count, err := requestsdb.New(e.pool).CountSurveyInvitations(e.ctx, a.personID)
	if err != nil || count != int64(len(document.Invitations))+1 {
		t.Fatalf("count = %d, %v", count, err)
	}
}

// r.appOpen and n.supervisorsOnline read the presence table with the two-minute window.
func TestNotificationPresenceFactsFilterRecipientsAndTheMoment(t *testing.T) {
	e := newDispatchEnv(t)
	open := e.person("app-open")
	closed := e.person("app-closed")
	supervisor := e.person("supervisor-online", e.membershipRole("supervisor").ID)
	seen := func(p authorization.Principal, ago time.Duration) {
		e.exec(`INSERT INTO account_presence(account_id,last_visible_at) VALUES($1,$2)
			ON CONFLICT (account_id) DO UPDATE SET last_visible_at=EXCLUDED.last_visible_at`, p.AccountID, e.clock.Add(-ago))
	}
	seen(open, 30*time.Second)
	seen(closed, 5*time.Minute)

	appOpen := e.newRule(e.service, func(in *notifyrules.RuleInput) {
		in.Definition.Conditions.Items = []notifyrules.ConditionItem{{Condition: &notifyrules.Condition{Field: "r.appOpen", Op: notifyrules.OpYes}}}
	}, inAppAction("operator"))
	nobodyOnline := e.newRule(e.service, func(in *notifyrules.RuleInput) {
		in.Definition.Conditions.Items = []notifyrules.ConditionItem{{Condition: &notifyrules.Condition{Field: "n.supervisorsOnline", Op: notifyrules.OpGte, Value: 1.0}}}
	}, inAppAction("operator"))
	e.emit(printerError("fatal", open.PersonID, closed.PersonID))
	if e.notifications(open, appOpen.ID) != 1 || e.notifications(closed, appOpen.ID) != 0 || e.statuses(closed, appOpen.ID, "skipped_condition") != 1 {
		t.Fatal("r.appOpen did not filter by the presence window")
	}
	if e.firings(nobodyOnline.ID) != 0 {
		t.Fatal("n.supervisorsOnline counted a supervisor who never opened the app, or a non-supervisor")
	}

	seen(open, 10*time.Second) // a visitor with the app open is no supervisor
	e.emit(printerError("fatal", open.PersonID))
	if e.firings(nobodyOnline.ID) != 0 {
		t.Fatal("n.supervisorsOnline counted a visitor")
	}
	seen(supervisor, 90*time.Second)
	e.emit(printerError("fatal", open.PersonID))
	if e.notifications(open, nobodyOnline.ID) != 1 {
		t.Fatal("n.supervisorsOnline did not see the supervisor with the app open")
	}
	seen(supervisor, 3*time.Minute)
	e.emit(printerError("fatal", open.PersonID))
	if e.notifications(open, nobodyOnline.ID) != 1 {
		t.Fatal("n.supervisorsOnline counted a supervisor outside the window")
	}
}

// The activity log carries when each in-app copy was delivered, seen and acknowledged.
func TestNotificationActivityReportsDeliveredSeenAndAcknowledged(t *testing.T) {
	e := newDispatchEnv(t)
	ctx := testContext(t)
	recipient := e.person("activity-recipient")
	rule := e.newRule(e.service, nil, inAppAction("operator"))
	e.emit(printerError("fatal", recipient.PersonID))

	find := func() notifyrules.ActivityRecipient {
		t.Helper()
		page, err := e.rules.Activity(ctx, e.manager, &rule.ID, 1, 10)
		if err != nil || len(page.Items) != 1 || len(page.Items[0].Recipients) != 1 {
			t.Fatalf("activity: %+v, %v", page, err)
		}
		return page.Items[0].Recipients[0]
	}
	before := find()
	if before.SeenAt != nil || before.AcknowledgedAt != nil || before.ReadAt != nil {
		t.Fatalf("fresh delivery already seen: %+v", before)
	}
	e.exec(`UPDATE inbox_recipients SET delivered_at = now() - interval '3 minutes', seen_at = now() - interval '2 minutes',
		acknowledged_at = now() - interval '1 minute', read_at = now() WHERE account_id=$1`, recipient.AccountID)
	after := find()
	if after.DeliveredAt == nil || after.SeenAt == nil || after.AcknowledgedAt == nil || after.ReadAt == nil {
		t.Fatalf("timestamps missing: %+v", after)
	}
	if !after.DeliveredAt.Before(*after.SeenAt) || !after.SeenAt.Before(*after.AcknowledgedAt) {
		t.Fatalf("timestamps out of order: %+v", after)
	}
}

// Each reaching rule carries the "When" line of the rules list.
func TestNotificationSettingsCarryTheTriggerSummary(t *testing.T) {
	e := newDispatchEnv(t)
	person := e.person("summary-reader")
	rule := e.newRule(e.service, nil, inAppAction("operator"))
	settings, err := e.rules.Settings(testContext(t), person)
	if err != nil {
		t.Fatal(err)
	}
	trigger, _ := notifyrules.LookupTrigger("printer_error")
	for _, reaching := range settings.Rules {
		if reaching.RuleID == rule.ID {
			if reaching.TriggerSummary != trigger.Label || reaching.TriggerSummary == "" {
				t.Fatalf("trigger summary = %q, want %q", reaching.TriggerSummary, trigger.Label)
			}
			return
		}
	}
	t.Fatal("the rule does not reach the person")
}

// Testing a personal subscription sends it to the owner only; central rules and other accounts' rules are not found.
func TestNotificationSubscriptionTestSendsToTheOwnerOnly(t *testing.T) {
	e := newDispatchEnv(t)
	e.rules.WithDispatcher(e.dispatcher, time.UTC)
	ctx := testContext(t)
	roleID := e.grant(authorization.MachinesRead)
	owner := e.person("test-owner", roleID)
	other := e.person("test-other", roleID)
	central := e.newRule(e.service, nil, inAppAction("operator"))
	subscription, err := e.rules.CreateSubscription(ctx, owner, notifyrules.RuleInput{
		Name: "My printer errors", Enabled: true,
		Definition: notifyrules.Definition{
			Trigger:    notifyrules.TriggerDef{Type: notifyrules.TriggerEvent, Event: "printer_error"},
			Conditions: notifyrules.ConditionSet{Mode: notifyrules.ModeAll},
			Actions:    []notifyrules.Action{inAppAction("me")},
		},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = e.rules.TestSubscription(ctx, other, subscription.ID, nil); !errors.Is(err, apperror.NotFound) {
		t.Fatalf("another account's subscription: %v", err)
	}
	if _, err = e.rules.TestSubscription(ctx, e.manager, central.ID, nil); !errors.Is(err, apperror.NotFound) {
		t.Fatalf("a central rule through the subscription endpoint: %v", err)
	}
	if _, err = e.rules.TestSubscription(ctx, owner, subscription.ID, nil); err != nil {
		t.Fatalf("test subscription: %v", err)
	}
	if e.notifications(owner, subscription.ID) != 1 || e.notifications(other, subscription.ID) != 0 {
		t.Fatalf("test notification: owner %d, other %d", e.notifications(owner, subscription.ID), e.notifications(other, subscription.ID))
	}
	if e.count(`SELECT count(*) FROM notification_firings WHERE rule_id=$1 AND test`, subscription.ID) != 1 {
		t.Fatal("the test was not logged as a test firing")
	}
}
