package notifyrules

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestDedupePeopleKeepsFirstAppearanceAndDropsNil(t *testing.T) {
	a, b, c := uuid.New(), uuid.New(), uuid.New()
	got := dedupePeople([]uuid.UUID{a, b, uuid.Nil}, []uuid.UUID{b, c, a}, nil)
	if want := []uuid.UUID{a, b, c}; !reflect.DeepEqual(got, want) {
		t.Fatalf("dedupePeople = %v, want %v", got, want)
	}
}

func TestChannelDecision(t *testing.T) {
	both, off, mailOnly := &Preference{InApp: true, Email: true}, &Preference{}, &Preference{Email: true}
	cases := []struct {
		name      string
		consent   bool
		granted   bool
		pref      *Preference
		mandatory bool
		channel   Channel
		deliver   bool
		status    string
	}{
		{"no preference", false, false, nil, false, ChannelInApp, true, statusSent},
		{"consent missing", true, false, nil, false, ChannelInApp, false, statusSkippedConsent},
		{"consent given", true, true, nil, false, ChannelEmail, true, statusSent},
		{"consent beats preference", true, false, both, false, ChannelInApp, false, statusSkippedConsent},
		{"both channels off mutes", false, false, off, false, ChannelInApp, false, statusSkippedMuted},
		{"mandatory ignores muting", false, false, off, true, ChannelInApp, true, statusSent},
		{"channel switched off", false, false, mailOnly, false, ChannelInApp, false, statusSkippedMuted},
		{"channel switched off but mandatory", false, false, mailOnly, true, ChannelInApp, false, statusSkippedMuted},
		{"other channel stays", false, false, mailOnly, false, ChannelEmail, true, statusSent},
	}
	for _, c := range cases {
		deliver, status := channelDecision(c.consent, c.granted, c.pref, c.mandatory, c.channel)
		if deliver != c.deliver || status != c.status {
			t.Errorf("%s: got (%v, %s), want (%v, %s)", c.name, deliver, status, c.deliver, c.status)
		}
	}
}

func TestAddedChannelsOnlyAddWhatTheRuleDoesNotUse(t *testing.T) {
	inAppOnly := map[Channel]bool{ChannelInApp: true}
	if got := addedChannels(nil, false, ChannelInApp, inAppOnly); got != nil {
		t.Fatalf("no preference added %v", got)
	}
	if got := addedChannels(&Preference{InApp: true, Email: true}, false, ChannelInApp, inAppOnly); !reflect.DeepEqual(got, []Channel{ChannelEmail}) {
		t.Fatalf("added = %v, want e-mail", got)
	}
	both := map[Channel]bool{ChannelInApp: true, ChannelEmail: true}
	if got := addedChannels(&Preference{InApp: true, Email: true}, false, ChannelInApp, both); got != nil {
		t.Fatalf("a channel the rule uses was added: %v", got)
	}
	if got := addedChannels(&Preference{}, true, ChannelEmail, map[Channel]bool{ChannelEmail: true}); !reflect.DeepEqual(got, []Channel{ChannelInApp}) {
		t.Fatalf("a mandatory rule keeps its channels: %v", got)
	}
}

func TestThrottleKeyUsesTheSubjectOrTheWholeRule(t *testing.T) {
	subjects := map[string]string{"machine": "m-1"}
	if got := throttleKey("machine", subjects); got != "subject:machine:m-1" {
		t.Fatalf("key = %q", got)
	}
	for _, per := range []string{"rule", "item", "code"} {
		if got := throttleKey(per, subjects); got != "rule" {
			t.Fatalf("%s key = %q, want rule", per, got)
		}
	}
}

func TestFillActionFillsLimitsAndFallsBack(t *testing.T) {
	ev := Event{Placeholders: map[string]string{"machine": "Printer 7"}, Link: "/machines/1"}
	action, link := fillAction(Action{Title: "  {machine}\n broke ", Body: "{machine} {unknown}"}, ev, "Rule")
	if action.Title != "Printer 7 broke" || action.Body != "Printer 7 {unknown}" || link != "/machines/1" {
		t.Fatalf("filled = %+v, link %q", action, link)
	}
	empty, _ := fillAction(Action{Title: "{missing}"}, Event{Placeholders: map[string]string{"missing": " "}}, "Rule name")
	if empty.Title != "Rule name" || empty.Body != "Rule name" {
		t.Fatalf("fallbacks = %+v", empty)
	}
	button := Action{Title: "t", InApp: &InAppOptions{Button: &Button{Kind: ButtonLink, Link: "{link}"}}}
	if _, got := fillAction(button, Event{}, "r"); got != "" {
		t.Fatalf("a button link without an event link resolved to %q", got)
	}
	button.InApp.Button.Link = "https://example.org/x"
	if _, got := fillAction(button, Event{Link: "/a"}, "r"); got != "https://example.org/x" {
		t.Fatalf("button link = %q", got)
	}
	long := Action{Title: "x", Body: ""}
	for len([]rune(long.Body)) < MaxBodyLength+50 {
		long.Body += "word "
	}
	if filled, _ := fillAction(long, Event{}, "r"); len([]rune(filled.Body)) > MaxBodyLength {
		t.Fatalf("body has %d characters", len([]rune(filled.Body)))
	}
}

func TestDecodeFieldsRestoresStringLists(t *testing.T) {
	got := decodeFields(map[string]any{"roles": []any{"a", "b"}, "level": "fatal", "n": 3.0})
	want := map[string]any{"roles": []string{"a", "b"}, "level": "fatal", "n": 3.0}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("decodeFields = %#v", got)
	}
}

func TestNowContextUsesTheMakerspaceTimeZone(t *testing.T) {
	vienna, err := time.LoadLocation("Europe/Vienna")
	if err != nil {
		t.Fatal(err)
	}
	d := NewDispatcher(nil, vienna)
	// 22:30 UTC on a Friday is already Saturday 00:30 in Vienna (summer time).
	got, err := d.nowContext(context.Background(), nil, map[string]bool{}, time.Date(2026, 7, 10, 22, 30, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if got["n.weekday"] != "sat" || got["n.hour"] != 0.0 {
		t.Fatalf("now context = %v", got)
	}
}

func TestStopsOnReading(t *testing.T) {
	for stop, want := range map[string]bool{"opened": true, "acknowledged": true, "seen": true, "error_cleared": false} {
		if stopsOnReading(stop) != want {
			t.Errorf("stopsOnReading(%q) = %v", stop, !want)
		}
	}
}
