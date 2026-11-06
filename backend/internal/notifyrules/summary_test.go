package notifyrules

import "testing"

func TestTriggerSummaryReadsLikeTheRulesList(t *testing.T) {
	two := 2
	event, _ := LookupTrigger("printer_error")
	cases := map[string]struct {
		definition Definition
		want       string
	}{
		"event": {Definition{Trigger: TriggerDef{Type: TriggerEvent, Event: "printer_error"}}, event.Label},
		"manual": {
			Definition{Trigger: TriggerDef{Type: TriggerManual}}, "When someone presses Run now",
		},
		"manual loop": {
			Definition{Trigger: TriggerDef{Type: TriggerManual}, Loop: &Loop{Collection: "people", Mode: ModeEach}},
			"When someone presses Run now · For each " + mustCollection(t, "people").One,
		},
		"weekly": {
			Definition{Trigger: TriggerDef{Type: TriggerSchedule, Schedule: &Schedule{Repeat: RepeatWeekly, Weekdays: []string{"mon", "thu"}, Time: "08:30"}}},
			"Every Mon, Thu at 08:30",
		},
		"weekdays": {
			Definition{Trigger: TriggerDef{Type: TriggerSchedule, Schedule: &Schedule{Repeat: RepeatWeekdays}}}, "Weekdays",
		},
		"monthly": {
			Definition{Trigger: TriggerDef{Type: TriggerSchedule, Schedule: &Schedule{Repeat: RepeatMonthly, DayOfMonth: 3, Time: "09:00"}}},
			"Monthly on day 3 at 09:00",
		},
		"before open day summary": {
			Definition{
				Trigger: TriggerDef{Type: TriggerSchedule, Schedule: &Schedule{Repeat: RepeatBeforeOpenDay, Hours: &two}},
				Loop:    &Loop{Collection: "people", Mode: ModeSummary},
			},
			"2 h before each open day · Summary of " + mustCollection(t, "people").Plural,
		},
	}
	for name, tc := range cases {
		if got := TriggerSummary(tc.definition); got != tc.want {
			t.Errorf("%s: got %q, want %q", name, got, tc.want)
		}
	}
}

func mustCollection(t *testing.T, key string) Collection {
	t.Helper()
	collection, ok := LookupCollection(key)
	if !ok {
		t.Fatalf("collection %s missing", key)
	}
	return collection
}
