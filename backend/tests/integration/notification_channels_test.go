package integration_test

import (
	"bytes"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
)

func noticeEvent(token string, self ...uuid.UUID) notifyrules.Event {
	event := printerError("error")
	event.ResolveToken = token
	if len(self) > 0 {
		event.Recipients = map[string][]uuid.UUID{"self": self}
	}
	return event
}

func signageAction(tone notifyrules.Tone, minutes int) notifyrules.Action {
	return notifyrules.Action{
		Channel: notifyrules.ChannelSignage, Recipients: []string{}, Title: "{machine} reports {code}", Body: "Please have a look.",
		Signage: &notifyrules.SignageTarget{DurationMinutes: minutes, Tone: tone},
	}
}

func tabletAction(mode notifyrules.TabletMode, mustTap bool, devices ...uuid.UUID) notifyrules.Action {
	return notifyrules.Action{
		Channel: notifyrules.ChannelTablet, Recipients: []string{}, Title: "Hello from {machine}", Body: "Mind the soldering iron.",
		Tablet: &notifyrules.TabletTarget{DeviceIDs: devices, Mode: mode, MustTap: mustTap},
	}
}

func liveRuleNotices(env *signageEnv, player *http.Client) []any {
	env.t.Helper()
	live := env.expect(env.do(player, "", http.MethodGet, "/signage/player/live", nil), http.StatusOK)
	notices, _ := live["ruleNotices"].([]any)
	return notices
}

func TestSignageRuleNoticesReachOnlyTheChosenDisplayAndEnd(t *testing.T) {
	env := newSignageEnv(t)
	staff := env.allStaff()
	author := env.staff("rule-author", authorization.NotificationRulesManage, authorization.SignageRead, authorization.MachinesRead)
	_, list := env.seedContent("Notice")
	chosen, chosenPlayer := env.pair(staff, "Chosen display", list)
	_, otherPlayer := env.pair(staff, "Other display", list)

	var category uuid.UUID
	if err := env.pool.QueryRow(testContext(t), `SELECT id FROM notification_categories WHERE key='service'`).Scan(&category); err != nil {
		t.Fatal(err)
	}
	rules := notifyrules.NewService(env.pool)
	rule, err := rules.CreateRule(testContext(t), author.principal, notifyrules.RuleInput{
		Name: "Printer error on the wall", Enabled: true, CategoryID: &category,
		Definition: notifyrules.Definition{
			Trigger:    notifyrules.TriggerDef{Type: notifyrules.TriggerEvent, Event: "printer_error"},
			Conditions: notifyrules.ConditionSet{Mode: notifyrules.ModeAll},
			Actions:    []notifyrules.Action{signageAction(notifyrules.ToneCritical, 5)},
		},
	}, nil)
	if err != nil {
		t.Fatalf("create rule: %v (%#v)", err, err)
	}
	// The chosen display opts in to the rule; the rule names no display.
	env.expect(env.as(staff, http.MethodPut, "/signage/displays/"+chosen["id"].(string)+"/notices", map[string]any{
		"allRules": false, "ruleIds": []string{rule.ID.String()},
	}), http.StatusOK)
	dispatcher := notifyrules.NewDispatcher(env.pool, time.UTC)
	emit := func(ev notifyrules.Event) {
		t.Helper()
		ev.OccurredAt = time.Now().UTC()
		ctx := testContext(t)
		tx, err := env.pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		if err = dispatcher.Emit(ctx, tx, ev); err != nil {
			t.Fatal(err)
		}
		if err = tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}

	emit(noticeEvent("wall:1"))
	notices := liveRuleNotices(env, chosenPlayer)
	if len(notices) != 1 {
		t.Fatalf("chosen display notices = %v, want one", notices)
	}
	notice := notices[0].(map[string]any)
	if notice["title"] != "Printer 7 reports 0300-0100" || notice["tone"] != "critical" || notice["body"] != "Please have a look." {
		t.Fatalf("notice = %v", notice)
	}
	if other := liveRuleNotices(env, otherPlayer); len(other) != 0 {
		t.Fatalf("other display notices = %v, want none", other)
	}

	// A tablet endpoint does not accept a display's credential.
	if response := env.do(chosenPlayer, "", http.MethodGet, "/terminal/context", nil); response.StatusCode == http.StatusOK {
		t.Fatal("a signage display read the tablet context")
	} else {
		response.Body.Close()
	}

	// Resolving the firing's token takes the notice down at once.
	ctx := testContext(t)
	tx, err := env.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err = dispatcher.Resolve(ctx, tx, "wall:1", "error_cleared"); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if after := liveRuleNotices(env, chosenPlayer); len(after) != 0 {
		t.Fatalf("notices after resolve = %v, want none", after)
	}

	// A notice disappears by itself at its end.
	emit(noticeEvent("wall:2"))
	if len(liveRuleNotices(env, chosenPlayer)) != 1 {
		t.Fatal("second notice missing")
	}
	if _, err = env.pool.Exec(ctx, `UPDATE signage_rule_notices SET starts_at = now() - interval '10 minutes', ends_at = now() - interval '1 minute'`); err != nil {
		t.Fatal(err)
	}
	if expired := liveRuleNotices(env, chosenPlayer); len(expired) != 0 {
		t.Fatalf("expired notices = %v, want none", expired)
	}
	var logged int
	if err = env.pool.QueryRow(ctx, `SELECT count(*) FROM notification_firing_recipients WHERE channel='signage' AND person_id IS NULL AND status='sent'`).Scan(&logged); err != nil || logged != 2 {
		t.Fatalf("signage delivery log = %d (%v), want 2", logged, err)
	}
}

func (e *dispatchEnv) device(name string) uuid.UUID {
	e.t.Helper()
	ctx := testContext(e.t)
	typeID, deviceID := ids.New(), ids.New()
	if _, err := e.pool.Exec(ctx, `INSERT INTO device_types(id,name) VALUES($1,$2)`, typeID, name+" type"); err != nil {
		e.t.Fatal(err)
	}
	e.counter++
	digest := bytes.Repeat([]byte{byte(e.counter)}, 32)
	copy(digest, deviceID[:])
	if _, err := e.pool.Exec(ctx, `
		INSERT INTO managed_devices(id,name,device_type_id,token_digest,terminal_enabled,session_policy_id,allowed_app_modes)
		VALUES($1,$2,$3,$4,true,(SELECT id FROM session_policies WHERE is_default),ARRAY['visitor_terminal'])`,
		deviceID, name, typeID, digest); err != nil {
		e.t.Fatal(err)
	}
	return deviceID
}

func TestTabletRuleNoticesByMode(t *testing.T) {
	env := newDispatchEnv(t)
	entrance, workshop, other := env.device("Entrance tablet"), env.device("Workshop tablet"), env.device("Other tablet")
	alice, bob := env.person("alice"), env.person("bob")
	notices := notifyrules.NewNotices(env.pool).WithClock(func() time.Time { return env.clock })
	titles := func(items []notifyrules.KioskNotice) []string {
		var result []string
		for _, item := range items {
			result = append(result, string(item.Mode))
		}
		return result
	}
	same := func(got []string, want ...string) {
		t.Helper()
		if fmt.Sprint(got) != fmt.Sprint(want) {
			t.Fatalf("modes = %v, want %v", got, want)
		}
	}
	forDevice := func(device uuid.UUID) []string {
		t.Helper()
		items, err := notices.ForDevice(testContext(t), device)
		if err != nil {
			t.Fatal(err)
		}
		return titles(items)
	}
	take := func(device uuid.UUID, person authorization.Principal) []string {
		t.Helper()
		items, err := notices.TakeForCheckIn(testContext(t), device, person.PersonID)
		if err != nil {
			t.Fatal(err)
		}
		return titles(items)
	}

	env.newRule(env.service, nil,
		tabletAction(notifyrules.TabletBanner, false, entrance),
		tabletAction(notifyrules.TabletEveryoneToday, true, entrance),
		tabletAction(notifyrules.TabletPersonCheckIn, true, entrance),
		tabletAction(notifyrules.TabletNextCheckIn, false, entrance, workshop),
	)
	env.emit(noticeEvent("tablet:1", alice.PersonID))

	same(forDevice(entrance), "banner", "everyone_today")
	same(forDevice(workshop))
	same(forDevice(other))
	items, _ := notices.ForDevice(testContext(t), entrance)
	if !items[1].MustTap || items[0].MustTap || items[0].Title != "Hello from Printer 7" {
		t.Fatalf("notices = %+v", items)
	}

	// Other people and other tablets get nothing; the person gets theirs once, on the first check-in.
	same(take(entrance, bob))
	same(take(other, alice))
	same(take(entrance, alice), "person_checkin", "next_checkin")
	same(take(entrance, alice))
	// The copy of the next-check-in notice for the other chosen tablet was used up with it.
	same(take(workshop, alice))
	// Notices for everybody stay until the end of the day.
	same(forDevice(entrance), "banner", "everyone_today")

	// A next-check-in notice is also shown at the other chosen tablet, and only once there.
	env.emit(noticeEvent("tablet:2", bob.PersonID))
	same(take(workshop, bob), "next_checkin")
	same(take(entrance, bob), "person_checkin")

	// Resolving the token takes the banner down; a person's notice that was never shown expires after ten minutes.
	env.clock = env.clock.Add(time.Second)
	env.resolve("tablet:1")
	same(forDevice(entrance), "banner", "everyone_today") // only the notices of the second event are left
	env.emit(noticeEvent("tablet:3", alice.PersonID))
	late := notifyrules.NewNotices(env.pool).WithClock(func() time.Time { return env.clock.Add(11 * time.Minute) })
	items, err := late.TakeForCheckIn(testContext(t), entrance, alice.PersonID)
	if err != nil {
		t.Fatal(err)
	}
	same(titles(items), "next_checkin")

	// Notices addressed to one person need that person: an event without one leaves them out.
	env.emit(noticeEvent("tablet:4"))
	var rows int
	if err = env.pool.QueryRow(testContext(t), `SELECT count(*) FROM kiosk_rule_notices WHERE firing_id IN (SELECT id FROM notification_firings WHERE resolve_token='tablet:4') AND person_id IS NULL AND mode IN ('person_checkin','next_checkin')`).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("person notices without a person = %d (%v)", rows, err)
	}
	var banners int
	if err = env.pool.QueryRow(testContext(t), `SELECT count(*) FROM notification_firing_recipients WHERE channel='tablet'`).Scan(&banners); err != nil || banners == 0 {
		t.Fatalf("tablet delivery log = %d (%v)", banners, err)
	}
}
