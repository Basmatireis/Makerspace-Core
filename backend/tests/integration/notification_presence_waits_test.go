package integration_test

import (
	"bytes"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
)

// waitingAction is an online-only toast that waits two hours for everybody who is not online.
func waitingAction(mutate func(*notifyrules.InAppOptions)) notifyrules.Action {
	later := 120
	action := inAppAction("operator")
	action.InApp = appearance(notifyrules.AppearanceToast, func(o *notifyrules.InAppOptions) {
		o.ToastSeconds = 10
		o.OnlineOnly, o.LaterMinutes = true, &later
		if mutate != nil {
			mutate(o)
		}
	})
	return action
}

func errorWithToken(token string, operators ...uuid.UUID) notifyrules.Event {
	event := printerError("fatal", operators...)
	event.ResolveToken = token
	return event
}

// device registers a managed device of the type and returns the principal signed in on it.
func (e *deliveryEnv) onDevice(p authorization.Principal, deviceType uuid.UUID, name string) (authorization.Principal, uuid.UUID) {
	e.t.Helper()
	id := ids.New()
	e.exec(`INSERT INTO managed_devices(id,name,device_type_id,token_digest) VALUES($1,$2,$3,$4)`,
		id, name, deviceType, bytes.Repeat([]byte{id[15]}, 32))
	p.Device = &authorization.ManagedDevice{ID: id, Name: name, DeviceTypeID: deviceType}
	return p, id
}

func (e *deliveryEnv) deviceType(name string) uuid.UUID {
	e.t.Helper()
	id := ids.New()
	e.exec(`INSERT INTO device_types(id,name) VALUES($1,$2)`, id, name)
	return id
}

func (e *deliveryEnv) waits(p authorization.Principal) int {
	e.t.Helper()
	var n int
	if err := e.pool.QueryRow(testContext(e.t), `SELECT count(*) FROM notification_presence_waits WHERE person_id=$1`,
		p.PersonID).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n
}

func (e *deliveryEnv) expireWaiting() {
	e.t.Helper()
	if _, err := e.dispatcher.ExpireWaiting(testContext(e.t)); err != nil {
		e.t.Fatal(err)
	}
}

func TestWaitingNotificationReachesPeopleWhoOpenTheAppLater(t *testing.T) {
	e := newDeliveryEnv(t)
	online, later := e.person("wait-online"), e.person("wait-later")
	e.poll(online)
	rule := e.newRule(e.service, nil, waitingAction(nil))

	e.emit(errorWithToken("printer_error:wait-later", online.PersonID, later.PersonID))
	if e.notifications(online, rule.ID) != 1 || e.notifications(later, rule.ID) != 0 {
		t.Fatalf("online %d, later %d", e.notifications(online, rule.ID), e.notifications(later, rule.ID))
	}
	if e.statuses(later, rule.ID, "waiting") != 1 || e.waits(later) != 1 || e.waits(online) != 0 {
		t.Fatal("the person who was not online does not wait for the notification")
	}

	// Opening the application delivers it in the same poll, as a pop-up.
	poll := e.poll(later)
	found := false
	for _, alert := range poll.Fresh {
		found = found || alert.Title == "Printer 7 reports 0300-0100"
	}
	if !found || e.notifications(later, rule.ID) != 1 {
		t.Fatalf("the waiting notification was not handed over on opening the app: %+v", poll.Fresh)
	}
	if e.statuses(later, rule.ID, "sent") != 1 || e.statuses(later, rule.ID, "waiting") != 0 || e.waits(later) != 0 {
		t.Fatal("the delivery log still says waiting after the late delivery")
	}
	// It comes once.
	e.poll(later)
	if e.notifications(later, rule.ID) != 1 {
		t.Fatal("a waiting notification was delivered twice")
	}
}

func TestWaitingNotificationEndsWhenTheFiringIsResolvedOrExpires(t *testing.T) {
	e := newDeliveryEnv(t)
	resolved, expired := e.person("wait-resolved"), e.person("wait-expired")
	rule := e.newRule(e.service, nil, waitingAction(nil))

	e.emit(errorWithToken("printer_error:resolved", resolved.PersonID))
	e.emit(errorWithToken("printer_error:expired", expired.PersonID))
	e.resolve("printer_error:resolved")
	e.exec(`UPDATE notification_presence_waits SET expires_at = now() - interval '1 minute' WHERE person_id=$1`, expired.PersonID)

	e.poll(resolved)
	e.poll(expired)
	if e.notifications(resolved, rule.ID) != 0 || e.notifications(expired, rule.ID) != 0 {
		t.Fatal("a resolved or expired wait was still delivered")
	}
	e.expireWaiting()
	if e.waits(resolved) != 0 || e.waits(expired) != 0 {
		t.Fatal("ended waits were kept")
	}
	if e.statuses(resolved, rule.ID, "skipped_offline") != 1 || e.statuses(expired, rule.ID, "skipped_offline") != 1 {
		t.Fatal("the delivery log does not say the people were not online")
	}
}

func TestWaitingNotificationEndsWhenTheRuleIsSwitchedOff(t *testing.T) {
	e := newDeliveryEnv(t)
	person := e.person("wait-switched-off")
	rule := e.newRule(e.service, nil, waitingAction(nil))
	e.emit(errorWithToken("printer_error:off", person.PersonID))
	e.exec(`UPDATE notification_rules SET enabled=false WHERE id=$1`, rule.ID)

	e.poll(person)
	if e.notifications(person, rule.ID) != 0 || e.waits(person) != 0 || e.statuses(person, rule.ID, "skipped_offline") != 1 {
		t.Fatal("the wait of a switched-off rule was delivered or kept")
	}
}

func TestOnlineOnlyNotificationLimitedToDevices(t *testing.T) {
	e := newDeliveryEnv(t)
	terminals, laptops := e.deviceType("Workshop terminal"), e.deviceType("Laptop")
	atTerminal, terminalID := e.onDevice(e.person("at-terminal"), terminals, "Terminal 1")
	atOther, _ := e.onDevice(e.person("at-other"), laptops, "Laptop 1")
	inBrowser := e.person("in-browser")
	byType, _ := e.onDevice(e.person("by-type"), terminals, "Terminal 2")
	for _, p := range []authorization.Principal{atTerminal, atOther, inBrowser, byType} {
		e.poll(p)
	}

	byDevice := inAppAction("operator")
	byDevice.InApp = appearance(notifyrules.AppearanceToast, func(o *notifyrules.InAppOptions) {
		o.OnlineOnly = true
		o.Devices = &notifyrules.DeviceFilter{DeviceIDs: []uuid.UUID{terminalID}, DeviceTypeIDs: []uuid.UUID{}}
	})
	deviceRule := e.newRule(e.service, nil, byDevice)
	byKind := inAppAction("operator")
	byKind.InApp = appearance(notifyrules.AppearanceToast, func(o *notifyrules.InAppOptions) {
		o.OnlineOnly = true
		o.Devices = &notifyrules.DeviceFilter{DeviceIDs: []uuid.UUID{}, DeviceTypeIDs: []uuid.UUID{terminals}}
	})
	typeRule := e.newRule(e.service, nil, byKind)

	e.emit(printerError("fatal", atTerminal.PersonID, atOther.PersonID, inBrowser.PersonID, byType.PersonID))
	want := map[string][2]int{"at-terminal": {1, 1}, "at-other": {0, 0}, "in-browser": {0, 0}, "by-type": {0, 1}}
	for name, p := range map[string]authorization.Principal{
		"at-terminal": atTerminal, "at-other": atOther, "in-browser": inBrowser, "by-type": byType,
	} {
		got := [2]int{e.notifications(p, deviceRule.ID), e.notifications(p, typeRule.ID)}
		if got != want[name] {
			t.Errorf("%s: device rule %d, type rule %d; want %v", name, got[0], got[1], want[name])
		}
	}
	if e.statuses(atOther, deviceRule.ID, "skipped_offline") != 1 || e.statuses(inBrowser, typeRule.ID, "skipped_offline") != 1 {
		t.Fatal("people on other devices are not logged as not online")
	}
}

func TestWaitingNotificationForDevicesWaitsForThatDevice(t *testing.T) {
	e := newDeliveryEnv(t)
	terminals := e.deviceType("Lab terminal")
	person := e.person("wait-device")
	atTerminal, terminalID := e.onDevice(person, terminals, "Lab terminal 1")
	rule := e.newRule(e.service, nil, waitingAction(func(o *notifyrules.InAppOptions) {
		o.Devices = &notifyrules.DeviceFilter{DeviceIDs: []uuid.UUID{terminalID}, DeviceTypeIDs: []uuid.UUID{}}
	}))

	// Online in the browser, not on the terminal: the notification waits.
	e.poll(person)
	e.emit(errorWithToken("printer_error:device", person.PersonID))
	if e.notifications(person, rule.ID) != 0 || e.waits(person) != 1 {
		t.Fatal("a device-limited notification reached a browser session")
	}
	e.poll(person)
	if e.notifications(person, rule.ID) != 0 || e.waits(person) != 1 {
		t.Fatal("polling from another device delivered or dropped the wait")
	}
	e.poll(atTerminal)
	if e.notifications(person, rule.ID) != 1 || e.waits(person) != 0 || e.statuses(person, rule.ID, "sent") != 1 {
		t.Fatal("signing in on the terminal did not deliver the waiting notification")
	}
}

func TestInAppAudienceValidation(t *testing.T) {
	e := newDeliveryEnv(t)
	later, zero := 60, 0
	cases := map[string]func(*notifyrules.InAppOptions){
		"later without online only": func(o *notifyrules.InAppOptions) { o.LaterMinutes = &later },
		"devices without online only": func(o *notifyrules.InAppOptions) {
			o.Devices = &notifyrules.DeviceFilter{DeviceIDs: []uuid.UUID{ids.New()}}
		},
		"zero minutes": func(o *notifyrules.InAppOptions) { o.OnlineOnly, o.LaterMinutes = true, &zero },
		"empty device filter": func(o *notifyrules.InAppOptions) {
			o.OnlineOnly, o.Devices = true, &notifyrules.DeviceFilter{}
		},
		"unknown device": func(o *notifyrules.InAppOptions) {
			o.OnlineOnly, o.Devices = true, &notifyrules.DeviceFilter{DeviceIDs: []uuid.UUID{ids.New()}}
		},
		"unknown device type": func(o *notifyrules.InAppOptions) {
			o.OnlineOnly, o.Devices = true, &notifyrules.DeviceFilter{DeviceTypeIDs: []uuid.UUID{ids.New()}}
		},
	}
	for name, mutate := range cases {
		action := inAppAction("operator")
		action.InApp = appearance(notifyrules.AppearanceToast, mutate)
		input := notifyrules.RuleInput{
			Name: "Invalid audience", Enabled: true, CategoryID: &e.service,
			Definition: notifyrules.Definition{
				Trigger:    notifyrules.TriggerDef{Type: notifyrules.TriggerEvent, Event: "printer_error"},
				Conditions: notifyrules.ConditionSet{Mode: notifyrules.ModeAll},
				Actions:    []notifyrules.Action{action},
			},
		}
		if _, err := e.rules.CreateRule(testContext(t), e.manager, input, nil); err == nil {
			t.Errorf("%s: saved", name)
		}
	}
}
