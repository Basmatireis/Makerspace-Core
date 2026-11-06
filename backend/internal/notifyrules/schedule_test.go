package notifyrules

import (
	"strings"
	"testing"
	"time"
)

func vienna(t *testing.T) *time.Location {
	t.Helper()
	location, err := time.LoadLocation("Europe/Vienna")
	if err != nil {
		t.Skipf("time zone data is not available: %v", err)
	}
	return location
}

func TestNextRunKeepsTheLocalClockTimeAcrossDaylightSaving(t *testing.T) {
	location := vienna(t)
	daily := Schedule{Repeat: RepeatDaily, Time: "09:00"}
	cases := []struct {
		after time.Time
		want  string
	}{
		{time.Date(2026, 3, 28, 12, 0, 0, 0, time.UTC), "2026-03-29T07:00:00Z"},
		{time.Date(2026, 3, 29, 7, 0, 0, 0, time.UTC), "2026-03-30T07:00:00Z"},
		{time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC), "2026-10-25T08:00:00Z"},
		{time.Date(2026, 6, 1, 6, 59, 0, 0, time.UTC), "2026-06-01T07:00:00Z"},
	}
	for _, tc := range cases {
		next, ok := NextRun(daily, tc.after, location)
		if !ok || next.Format(time.RFC3339) != tc.want {
			t.Errorf("after %s: got %s (%t), want %s", tc.after, next.Format(time.RFC3339), ok, tc.want)
		}
	}
}

func TestNextRunFiresOncePerDayWhenTheTimeIsSkippedOrRepeated(t *testing.T) {
	location := vienna(t)
	// 02:30 does not exist on 29 March 2026 and exists twice on 25 October 2026.
	daily := Schedule{Repeat: RepeatDaily, Time: "02:30"}
	springStart := time.Date(2026, 3, 28, 12, 0, 0, 0, time.UTC)
	if runs := RunsBetween(daily, springStart, springStart.AddDate(0, 0, 3), location); runs != 3 {
		t.Errorf("runs over the spring change = %d, want 3", runs)
	}
	autumnStart := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	if runs := RunsBetween(daily, autumnStart, autumnStart.AddDate(0, 0, 3), location); runs != 3 {
		t.Errorf("runs over the autumn change = %d, want 3", runs)
	}
	skipped, _ := NextRun(daily, springStart, location)
	if day := skipped.In(location).Format("2006-01-02"); day != "2026-03-29" {
		t.Errorf("the skipped time moved to %s", day)
	}
	again, _ := NextRun(daily, skipped, location)
	if day := again.In(location).Format("2006-01-02 15:04"); day != "2026-03-30 02:30" {
		t.Errorf("the run after the skipped time is %s", day)
	}
}

func TestNextRunRepeats(t *testing.T) {
	location := vienna(t)
	wednesday := time.Date(2026, 11, 4, 10, 0, 0, 0, location)
	local := func(next time.Time) string { return next.In(location).Format("Mon 2006-01-02 15:04") }
	cases := []struct {
		schedule Schedule
		want     string
	}{
		{Schedule{Repeat: RepeatWeekly, Weekdays: []string{"mon", "thu"}, Time: "09:00"}, "Thu 2026-11-05 09:00"},
		{Schedule{Repeat: RepeatWeekdays, Time: "08:00"}, "Thu 2026-11-05 08:00"},
		{Schedule{Repeat: RepeatWeekdays, Time: "11:00"}, "Wed 2026-11-04 11:00"},
		{Schedule{Repeat: RepeatMonthly, DayOfMonth: 1, Time: "09:00"}, "Tue 2026-12-01 09:00"},
		{Schedule{Repeat: RepeatMonthly, DayOfMonth: 4, Time: "09:00"}, "Fri 2026-12-04 09:00"},
	}
	for _, tc := range cases {
		next, ok := NextRun(tc.schedule, wednesday, location)
		if !ok || local(next) != tc.want {
			t.Errorf("%+v: got %s (%t), want %s", tc.schedule, local(next), ok, tc.want)
		}
	}
	friday := time.Date(2026, 11, 6, 20, 0, 0, 0, location)
	if next, _ := NextRun(Schedule{Repeat: RepeatWeekdays, Time: "09:00"}, friday, location); local(next) != "Mon 2026-11-09 09:00" {
		t.Errorf("weekdays skip the weekend: %s", local(next))
	}
	if _, ok := NextRun(Schedule{Repeat: RepeatBeforeOpenDay}, wednesday, location); ok {
		t.Error("a schedule relative to open days has no clock time")
	}
}

func TestSummaryPlaceholdersCountSumAndListTheMatches(t *testing.T) {
	people, _ := LookupCollection("people")
	items := []Item{
		{Name: "Ada", Fields: map[string]any{"unpaid": 12.5, "oldestUnpaid": float64(40)}},
		{Name: "Bo", Fields: map[string]any{"unpaid": 7.25, "oldestUnpaid": float64(3)}},
	}
	fields := []map[string]any{items[0].Fields, items[1].Fields}
	texts := summaryPlaceholders(people, items, SummaryContext(people, fields))
	if texts["count"] != "2" || texts["sum.unpaid"] != "19.75 €" || texts["max.oldestUnpaid"] != "40 days" {
		t.Errorf("placeholders = %v", texts)
	}
	if !strings.Contains(texts["list"], "- Ada") || !strings.Contains(texts["list"], "- Bo") {
		t.Errorf("list = %q", texts["list"])
	}
	many := make([]Item, 20)
	for i := range many {
		many[i] = Item{Name: "Person", Fields: map[string]any{}}
	}
	if list := summaryPlaceholders(people, many, Context{})["list"]; !strings.HasSuffix(list, "… and 5 more") {
		t.Errorf("long list = %q", list)
	}
}

func TestItemPlaceholdersUseTheCollectionPrefixAndReadableValues(t *testing.T) {
	people, _ := LookupCollection("people")
	item := Item{
		Name:   "Ada",
		Fields: map[string]any{"name": "Ada", "unpaid": 30.0, "hasAccount": true, "systemRole": "supervisor", "lastVisit": float64(9)},
	}
	texts := item.placeholders(people)
	if texts["person.name"] != "Ada" || texts["person.unpaid"] != "30.00 €" || texts["person.hasAccount"] != "yes" ||
		texts["person.systemRole"] != "Supervisor" || texts["person.lastVisit"] != "9 days" {
		t.Errorf("placeholders = %v", texts)
	}
}
