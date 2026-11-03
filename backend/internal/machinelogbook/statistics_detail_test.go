package machinelogbook

import (
	"testing"
	"time"
)

func TestStatisticsShowWhenMachinesRunAndHowJobsEnded(t *testing.T) {
	f := newJobFixture(t)
	f.s = NewService(f.pool, nil, WithClock(func() time.Time { return f.now }), WithTimeZone("Etc/GMT-2"))
	y := uniqueYear()
	f.now = time.Date(y, time.June, 30, 12, 0, 0, 0, time.UTC)
	// 10 June, 08:30 to 10:00 UTC = 10:30 to 12:00 at UTC+2, a zone without daylight saving in any year.
	start := time.Date(y, time.June, 10, 8, 30, 0, 0, time.UTC)
	ok := f.input(0, 0, JobOutcomeSuccessful)
	ok.StartsAt, ok.EndsAt = start, start.Add(90*time.Minute)
	f.create(t, ok)
	failed := f.input(0, 0, JobOutcomeFailed)
	failed.StartsAt, failed.EndsAt = start.AddDate(0, 0, 7), start.AddDate(0, 0, 7).Add(30*time.Minute)
	f.create(t, failed)
	from := time.Date(y, time.June, 1, 0, 0, 0, 0, time.UTC)
	stats, err := f.s.Statistics(t.Context(), f.p, from, from.AddDate(0, 1, 0))
	if err != nil {
		t.Fatal(err)
	}
	weekday := (int(start.In(mustLocation(t, "Etc/GMT-2")).Weekday()) + 6) % 7
	cells := map[int]StatisticWeekdayHour{}
	for _, cell := range stats.UsageByWeekdayHour {
		if cell.Weekday == weekday {
			cells[cell.Hour] = cell
		}
	}
	// Both jobs ran on the same weekday; only these runs exist in this year.
	if cells[10].Runs != 2 || cells[11].Runs != 1 || len(cells) != 2 {
		t.Fatalf("cells = %+v", stats.UsageByWeekdayHour)
	}
	assertDecimal(t, "10:00 minutes", cells[10].Minutes, "60")
	assertDecimal(t, "11:00 minutes", cells[11].Minutes, "60")
	outcomes := map[string]int64{}
	for _, row := range stats.JobsByOutcome {
		outcomes[row.Outcome] = row.Jobs
	}
	if outcomes["successful"] != 1 || outcomes["failed"] != 1 || len(outcomes) != 2 {
		t.Fatalf("outcomes = %+v", stats.JobsByOutcome)
	}
	var weekJobs int64
	for _, week := range stats.JobsByWeek {
		weekJobs += week.Jobs
	}
	if weekJobs != 2 || len(stats.JobsByWeek) < 4 {
		t.Fatalf("weeks = %+v", stats.JobsByWeek)
	}
	if len(stats.PricingGroups) != 1 || stats.PricingGroups[0].PricingGroupName != f.group.Name ||
		stats.PricingGroups[0].Jobs != 2 {
		t.Fatalf("pricing groups = %+v", stats.PricingGroups)
	}
	if len(stats.PricingGroupMonths) != 1 || stats.PricingGroupMonths[0].Month == "" {
		t.Fatalf("pricing group months = %+v", stats.PricingGroupMonths)
	}
	// 1.5 h and 0.5 h at 10 EUR an hour, neither on an order.
	assertDecimal(t, "not billed", stats.Totals.NotBilled, "20")
	assertDecimal(t, "discounts", stats.Totals.Discounts, "0")
	if len(stats.Machines) != 1 {
		t.Fatalf("machines = %+v", stats.Machines)
	}
	// 2 h of the 708 hours that have passed of the period.
	assertDecimal(t, "utilization", stats.Machines[0].Utilization, "0.28")
	assertDecimal(t, "open-day utilization", stats.Machines[0].OpenDayUtilization, "0")
}

func mustLocation(t *testing.T, name string) *time.Location {
	t.Helper()
	location, err := time.LoadLocation(name)
	if err != nil {
		t.Fatal(err)
	}
	return location
}
