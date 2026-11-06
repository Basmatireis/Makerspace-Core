package integration_test

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/inbox"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

type deliveryEnv struct {
	*dispatchEnv
	inbox *inbox.Service
}

func newDeliveryEnv(t *testing.T) *deliveryEnv {
	t.Helper()
	env := newDispatchEnv(t)
	return &deliveryEnv{dispatchEnv: env, inbox: inbox.NewService(env.pool)}
}

func (e *deliveryEnv) poll(p authorization.Principal) inbox.Poll {
	e.t.Helper()
	poll, err := e.inbox.Poll(testContext(e.t), p)
	if err != nil {
		e.t.Fatal(err)
	}
	return poll
}

// notificationOf returns the account's notification of the rule (the newest one).
func (e *deliveryEnv) notificationOf(p authorization.Principal, rule uuid.UUID) uuid.UUID {
	e.t.Helper()
	var id uuid.UUID
	if err := e.pool.QueryRow(testContext(e.t), `SELECT n.id FROM inbox_recipients r
		JOIN inbox_notifications n ON n.id = r.notification_id
		WHERE r.account_id=$1 AND n.rule_id=$2 ORDER BY n.created_at DESC LIMIT 1`, p.AccountID, rule).Scan(&id); err != nil {
		e.t.Fatal(err)
	}
	return id
}

func appearance(kind notifyrules.Appearance, mutate func(*notifyrules.InAppOptions)) *notifyrules.InAppOptions {
	options := &notifyrules.InAppOptions{
		Appearance: kind, Level: notifyrules.LevelInfo, Button: &notifyrules.Button{Kind: notifyrules.ButtonNone},
	}
	if mutate != nil {
		mutate(options)
	}
	return options
}

func TestInboxPollHandsOverFreshNotificationsOnceAndRecordsPresence(t *testing.T) {
	e := newDeliveryEnv(t)
	operator := e.person("poll-operator")
	toast := inAppAction("operator")
	toast.InApp = appearance(notifyrules.AppearanceToast, func(o *notifyrules.InAppOptions) { o.ToastSeconds = 10 })
	bell := inAppAction("operator")
	bell.InApp = appearance(notifyrules.AppearanceBell, nil)
	banner := inAppAction("operator")
	banner.Title, banner.Body = "Banner for {machine}", "Needs a click."
	banner.InApp = appearance(notifyrules.AppearanceBanner, func(o *notifyrules.InAppOptions) {
		o.Level = notifyrules.LevelError
		o.OnlyButtonCloses, o.AllowLater = true, true
		o.Button = &notifyrules.Button{Kind: notifyrules.ButtonLink, Label: "Open machine", Link: "{link}"}
	})
	rule := e.newRule(e.service, nil, toast, bell, banner)
	assertCount(t, e.pool, `SELECT count(*) FROM account_presence WHERE account_id=$1`, 0, operator.AccountID)

	e.emit(printerError("fatal", operator.PersonID))
	first := e.poll(operator)
	// The seeded printer rule notifies the operator too (bell only), so the count is at least the rule's three.
	if first.UnreadCount < 3 || len(first.Fresh) != 2 {
		t.Fatalf("first poll: %d unread, %d fresh (the bell-only one is delivered but not handed over)", first.UnreadCount, len(first.Fresh))
	}
	byAppearance := map[inbox.Appearance]inbox.Alert{}
	for _, alert := range first.Fresh {
		byAppearance[alert.Appearance] = alert
	}
	if got := byAppearance[inbox.AppearanceToast]; got.ToastSeconds == nil || *got.ToastSeconds != 10 || got.Level != "info" {
		t.Fatalf("toast = %+v", got)
	}
	got := byAppearance[inbox.AppearanceBanner]
	if got.Level != "error" || !got.OnlyButtonCloses || !got.AllowLater || got.Button.Kind != "link" ||
		got.Button.Link == nil || *got.Button.Link != "/machines/7" || got.Button.Label == nil || *got.Button.Label != "Open machine" {
		t.Fatalf("banner = %+v", got)
	}
	if len(first.Pinned) != 1 || first.Pinned[0].ID != got.ID {
		t.Fatalf("pinned = %+v", first.Pinned)
	}
	assertCount(t, e.pool, `SELECT count(*) FROM account_presence WHERE account_id=$1 AND last_visible_at > now() - interval '1 minute'`, 1, operator.AccountID)
	assertCount(t, e.pool, `SELECT count(*) FROM inbox_recipients WHERE account_id=$1 AND delivered_at IS NULL`, 0, operator.AccountID)

	again := e.poll(operator)
	if len(again.Fresh) != 0 || len(again.Pinned) != 1 {
		t.Fatalf("second poll: %d fresh, %d pinned; fresh notifications come once, pinned ones stay", len(again.Fresh), len(again.Pinned))
	}
	_ = rule

	// Reading the banner takes it off the pinned list.
	if err := e.inbox.MarkRead(testContext(t), operator, got.ID); err != nil {
		t.Fatal(err)
	}
	if len(e.poll(operator).Pinned) != 0 {
		t.Fatal("a read banner stayed pinned")
	}
}

func TestInboxPollSkipsPopUpsAlreadyReadInTheList(t *testing.T) {
	e := newDeliveryEnv(t)
	operator := e.person("read-first")
	toast := inAppAction("operator")
	toast.InApp = appearance(notifyrules.AppearanceToast, nil)
	rule := e.newRule(e.service, nil, toast)

	e.emit(printerError("fatal", operator.PersonID))
	// The person opens it from the bell list before the next poll comes round.
	if err := e.inbox.MarkRead(testContext(t), operator, e.notificationOf(operator, rule.ID)); err != nil {
		t.Fatal(err)
	}
	if fresh := e.poll(operator).Fresh; len(fresh) != 0 {
		t.Fatalf("a notification read in the list still popped up: %+v", fresh)
	}
	assertCount(t, e.pool, `SELECT count(*) FROM inbox_recipients WHERE account_id=$1 AND delivered_at IS NULL`, 0, operator.AccountID)
}

func TestInboxOnlineOnlyNotificationsSkipOfflineAccounts(t *testing.T) {
	e := newDeliveryEnv(t)
	online, offline, stale := e.person("online"), e.person("offline"), e.person("stale")
	e.poll(online)
	e.poll(stale)
	e.exec(`UPDATE account_presence SET last_visible_at = now() - interval '3 minutes' WHERE account_id=$1`, stale.AccountID)
	action := inAppAction("operator")
	action.InApp = appearance(notifyrules.AppearanceToast, func(o *notifyrules.InAppOptions) { o.OnlineOnly = true })
	rule := e.newRule(e.service, nil, action)

	e.emit(printerError("fatal", online.PersonID, offline.PersonID, stale.PersonID))
	if e.notifications(online, rule.ID) != 1 || e.notifications(offline, rule.ID) != 0 || e.notifications(stale, rule.ID) != 0 {
		t.Fatalf("online %d, never seen %d, stale %d", e.notifications(online, rule.ID), e.notifications(offline, rule.ID), e.notifications(stale, rule.ID))
	}
	if e.statuses(offline, rule.ID, "skipped_offline") != 1 || e.statuses(stale, rule.ID, "skipped_offline") != 1 ||
		e.statuses(online, rule.ID, "sent") != 1 {
		t.Fatal("the delivery log does not say who was skipped for being offline")
	}
}

func TestInboxEmailFallbackGoesOnlyToAccountsThatNeverGotTheNotification(t *testing.T) {
	e := newDeliveryEnv(t)
	e.exec(`UPDATE mail_configuration SET enabled=true`)
	reached, missed := e.person("reached"), e.person("missed")
	five := 5
	action := inAppAction("operator")
	action.InApp = appearance(notifyrules.AppearanceBell, func(o *notifyrules.InAppOptions) { o.EmailFallbackMinutes = &five })
	rule := e.newRule(e.service, nil, action)

	e.emit(printerError("fatal", reached.PersonID, missed.PersonID))
	e.poll(reached)
	e.clock = e.clock.Add(6 * time.Minute)
	e.runPending()
	if e.mails(reached, rule.ID) != 0 || e.mails(missed, rule.ID) != 1 {
		t.Fatalf("fallback mails: reached %d, missed %d", e.mails(reached, rule.ID), e.mails(missed, rule.ID))
	}
}

func TestInboxAcknowledgingOrSeeingStopsTheMatchingEscalation(t *testing.T) {
	for _, stop := range []string{"seen", "acknowledged"} {
		t.Run(stop, func(t *testing.T) {
			e := newDeliveryEnv(t)
			operator, lead := e.person("esc-operator"), e.person("esc-lead")
			rule := e.newRule(e.service, func(in *notifyrules.RuleInput) {
				in.Definition.Escalation = &notifyrules.Escalation{
					StopWhen: stop,
					Steps: []notifyrules.EscalationStep{{
						After:  notifyrules.Duration{Value: 10, Unit: notifyrules.UnitMinutes},
						Action: inAppAction(fmt.Sprintf("person:%s", lead.PersonID)),
					}},
				}
			}, inAppAction("operator"))

			// Being delivered, and for "acknowledged" being seen, does not stop it.
			e.emit(printerError("fatal", operator.PersonID))
			e.poll(operator)
			if stop == "acknowledged" {
				if err := e.inbox.MarkSeen(testContext(t), operator, e.notificationOf(operator, rule.ID)); err != nil {
					t.Fatal(err)
				}
			}
			e.clock = e.clock.Add(11 * time.Minute)
			if stop == "seen" {
				if err := e.inbox.MarkSeen(testContext(t), operator, e.notificationOf(operator, rule.ID)); err != nil {
					t.Fatal(err)
				}
			}
			e.runPending()
			if stop == "seen" && e.notifications(lead, rule.ID) != 0 {
				t.Fatal("seeing the notification did not stop the escalation")
			}
			if stop == "acknowledged" {
				if e.notifications(lead, rule.ID) != 1 {
					t.Fatal("a notification that was only seen stopped an acknowledge escalation")
				}
				// A second firing is acknowledged in time.
				e.emit(printerError("fatal", operator.PersonID))
				if err := e.inbox.Acknowledge(testContext(t), operator, e.notificationOf(operator, rule.ID)); err != nil {
					t.Fatal(err)
				}
				e.clock = e.clock.Add(11 * time.Minute)
				e.runPending()
				if e.notifications(lead, rule.ID) != 1 {
					t.Fatalf("acknowledging did not stop the escalation: lead has %d", e.notifications(lead, rule.ID))
				}
				assertCount(t, e.pool, `SELECT count(*) FROM inbox_recipients WHERE account_id=$1 AND acknowledged_at IS NOT NULL AND read_at IS NOT NULL`, 1, operator.AccountID)
			}
		})
	}
}

func TestInboxPostponedBannersReturnAfterAnHour(t *testing.T) {
	e := newDeliveryEnv(t)
	operator := e.person("later")
	action := inAppAction("operator")
	action.InApp = appearance(notifyrules.AppearanceDialog, func(o *notifyrules.InAppOptions) {
		o.AllowLater = true
		o.Button = &notifyrules.Button{Kind: notifyrules.ButtonAcknowledge}
	})
	rule := e.newRule(e.service, nil, action)
	e.emit(printerError("fatal", operator.PersonID))
	before := e.poll(operator)
	if len(before.Pinned) != 1 || before.Pinned[0].Appearance != inbox.AppearanceDialog {
		t.Fatalf("pinned = %+v", before.Pinned)
	}
	id := e.notificationOf(operator, rule.ID)
	if err := e.inbox.Postpone(testContext(t), operator, id); err != nil {
		t.Fatal(err)
	}
	if poll := e.poll(operator); len(poll.Pinned) != 0 || poll.UnreadCount != before.UnreadCount {
		t.Fatalf("postponed: %d pinned, %d unread, was %d (it stays unread)", len(poll.Pinned), poll.UnreadCount, before.UnreadCount)
	}
	assertCount(t, e.pool, `SELECT count(*) FROM inbox_recipients WHERE account_id=$1 AND snoozed_until > now() + interval '50 minutes' AND snoozed_until < now() + interval '70 minutes'`, 1, operator.AccountID)
	e.exec(`UPDATE inbox_recipients SET snoozed_until = now() - interval '1 second' WHERE account_id=$1`, operator.AccountID)
	if len(e.poll(operator).Pinned) != 1 {
		t.Fatal("the postponed dialog did not come back")
	}
}

func TestInboxDeliveryTrackingIsScopedToTheSessionAccount(t *testing.T) {
	e := newDeliveryEnv(t)
	owner, other := e.person("owner"), e.person("other")
	rule := e.newRule(e.service, nil, inAppAction("operator"))
	e.emit(printerError("fatal", owner.PersonID))
	id := e.notificationOf(owner, rule.ID)
	ctx := testContext(t)
	for name, call := range map[string]func() error{
		"seen":        func() error { return e.inbox.MarkSeen(ctx, other, id) },
		"acknowledge": func() error { return e.inbox.Acknowledge(ctx, other, id) },
		"later":       func() error { return e.inbox.Postpone(ctx, other, id) },
		"unknown":     func() error { return e.inbox.Acknowledge(ctx, owner, uuid.New()) },
	} {
		if err := call(); !errors.Is(err, apperror.NotFound) {
			t.Errorf("%s: err = %v, want not found", name, err)
		}
	}
	assertCount(t, e.pool, `SELECT count(*) FROM inbox_recipients WHERE seen_at IS NOT NULL OR acknowledged_at IS NOT NULL OR snoozed_until IS NOT NULL`, 0)
	if poll := e.poll(other); len(poll.Fresh) != 0 || len(poll.Pinned) != 0 {
		t.Fatal("another account's notification was handed over")
	}
}
