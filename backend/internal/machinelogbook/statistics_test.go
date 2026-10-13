package machinelogbook

import (
	"fmt"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

// uniqueYear picks a far-away year per test run. Inventory history is immutable, so rows
// written by a run cannot be cleaned up and must never be seen by the next run's reports.
func uniqueYear() int {
	id := uuid.Must(uuid.NewV7())
	return 3000 + (int(id[14])<<8|int(id[15]))%6000
}

func dec(t *testing.T, value string) decimal.Decimal {
	t.Helper()
	d, err := decimal.NewFromString(value)
	if err != nil {
		t.Fatalf("%q is not a decimal: %v", value, err)
	}
	return d
}

func assertDecimal(t *testing.T, label, got, want string) {
	t.Helper()
	if !dec(t, got).Equal(dec(t, want)) {
		t.Fatalf("%s = %s, want %s", label, got, want)
	}
}

func (f *jobFixture) insertTransaction(t *testing.T, kind, reason string, quantity, value string, at time.Time) {
	t.Helper()
	var adjustment any
	if reason != "" {
		adjustment = reason
	}
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO inventory_transactions (id, material_id, kind, quantity_delta, unit_acquisition_cost, inventory_value_delta, occurred_at, adjustment_reason)
		VALUES ($1, $2, $3, $4::numeric, 0.5, $5::numeric, $6, $7)`, uuid.Must(uuid.NewV7()), f.material.ID, kind, quantity, value, at, adjustment); err != nil {
		t.Fatal(err)
	}
}

func TestStatisticsTotalsRuntimeAndCostSplit(t *testing.T) {
	f := newJobFixture(t)
	y := uniqueYear()
	statsClock := time.Date(y, time.June, 15, 12, 0, 0, 0, time.UTC)
	f.now = statsClock
	ctx := t.Context()
	day := func(d, hour int) time.Time { return time.Date(y, time.June, d, hour, 0, 0, 0, time.UTC) }
	job := func(machine Machine, start time.Time, duration time.Duration, outcome string) MachineJob {
		input := JobInput{MachineID: machine.ID, StartsAt: start, EndsAt: start.Add(duration), Customer: PartyReference{Kind: "person", ID: f.person}, OperatorPersonID: f.person, Outcome: outcome, PricingGroupID: &f.group.ID}
		return f.create(t, input)
	}
	a := job(f.machine, day(2, 10), 2*time.Hour, "successful")
	b := job(f.machine, day(10, 10), 3*time.Hour, "failed")
	c := job(f.machine, day(12, 9), time.Hour, "partial_failure")
	running := job(f.machine, statsClock.Add(-time.Hour), 4*time.Hour, "unknown") // one hour has elapsed
	e := job(f.bareMachine, day(3, 8), 2*time.Hour, "successful")
	previous := job(f.machine, time.Date(y, time.May, 20, 10, 0, 0, 0, time.UTC), time.Hour, "successful")
	outside := job(f.machine, time.Date(y, time.July, 1, 0, 0, 0, 0, time.UTC), time.Hour, "unknown") // starts at the exclusive end
	_ = outside

	f.insertTransaction(t, "manual_consumption", "", "-10", "-5.00", day(5, 9))
	f.insertTransaction(t, "adjustment", "job_corrected", "2", "1.00", day(6, 9))
	f.insertTransaction(t, "disposal", "damaged", "-4", "-2.00", day(7, 9))
	f.insertTransaction(t, "adjustment", "inventory_count", "-3", "-1.50", day(8, 9))
	f.insertTransaction(t, "adjustment", "inventory_count", "2", "1.00", day(8, 10)) // gains are not losses
	f.insertTransaction(t, "manual_consumption", "", "-1", "-0.75", time.Date(y, time.May, 25, 9, 0, 0, 0, time.UTC))

	from, to := time.Date(y, time.June, 1, 0, 0, 0, 0, time.UTC), time.Date(y, time.July, 1, 0, 0, 0, 0, time.UTC)
	stats, err := f.s.Statistics(ctx, f.p, from, to)
	if err != nil {
		t.Fatal(err)
	}
	charges := decimal.Zero
	for _, j := range []MachineJob{a, b, c, running} {
		charges = charges.Add(dec(t, price(j.EffectivePrice)))
	}
	if e.EffectivePrice != nil {
		t.Fatalf("the machine without a runtime rule has an effective price %s", *e.EffectivePrice)
	}
	totals := stats.Totals
	if totals.Jobs != 5 {
		t.Fatalf("jobs = %d", totals.Jobs)
	}
	assertDecimal(t, "runtimeHours (running job clamped to now)", totals.RuntimeHours, "9")
	assertDecimal(t, "charges", totals.Charges, charges.String())
	assertDecimal(t, "materialCost", totals.MaterialCost, "4")
	assertDecimal(t, "failureRate", totals.FailureRate, "50")

	prev := stats.PreviousTotals
	assertDecimal(t, "previous runtime", prev.RuntimeHours, "1")
	assertDecimal(t, "previous charges", prev.Charges, price(previous.EffectivePrice))
	assertDecimal(t, "previous materialCost", prev.MaterialCost, "0.75")
	assertDecimal(t, "previous failureRate", prev.FailureRate, "0")
	if prev.Jobs != 1 {
		t.Fatalf("previous jobs = %d", prev.Jobs)
	}

	if len(stats.Months) != 1 || stats.Months[0].Month != fmt.Sprintf("%d-06", y) {
		t.Fatalf("months = %+v", stats.Months)
	}
	assertDecimal(t, "month charges", stats.Months[0].Charges, charges.String())
	assertDecimal(t, "month materialCost", stats.Months[0].MaterialCost, "4")
	assertDecimal(t, "month losses", stats.Months[0].Losses, "3.5")

	if len(stats.MaterialCostByCategory) != 1 || stats.MaterialCostByCategory[0].Key != "pla" {
		t.Fatalf("material cost by category = %+v", stats.MaterialCostByCategory)
	}
	assertDecimal(t, "pla cost", stats.MaterialCostByCategory[0].Value, "4")

	if len(stats.Machines) != 2 {
		t.Fatalf("machines = %+v", stats.Machines)
	}
	shares := map[uuid.UUID]StatisticMachine{}
	for _, m := range stats.Machines {
		shares[m.MachineID] = m
	}
	main, bare := shares[f.machine.ID], shares[f.bareMachine.ID]
	assertDecimal(t, "main runtime", main.RuntimeHours, "7")
	assertDecimal(t, "main share", main.RuntimeShare, "77.78")
	assertDecimal(t, "bare share", bare.RuntimeShare, "22.22")
	assertDecimal(t, "main failure rate", main.FailureRate, "66.67")
	assertDecimal(t, "bare failure rate", bare.FailureRate, "0")
	if main.Jobs != 4 || bare.Jobs != 1 || main.MachineTypeName != f.machine.MachineType.Name {
		t.Fatalf("machine summaries = %+v / %+v", main, bare)
	}
	assertDecimal(t, "bare charges", bare.Charges, "0")

	if stats.RuntimeGranularity != "week" {
		t.Fatalf("granularity = %s", stats.RuntimeGranularity)
	}
	monday := func(d time.Time) time.Time {
		d = time.Date(d.Year(), d.Month(), d.Day(), 0, 0, 0, 0, time.UTC)
		return d.AddDate(0, 0, -((int(d.Weekday()) + 6) % 7))
	}
	hours := map[string]string{}
	for _, point := range stats.Runtime {
		hours[point.BucketStart.Format("2006-01-02")+"/"+point.MachineID.String()] = point.Hours
	}
	if len(hours) != len(stats.Runtime) {
		t.Fatalf("duplicate runtime buckets: %+v", stats.Runtime)
	}
	want := map[string]decimal.Decimal{}
	for _, item := range []struct {
		machine uuid.UUID
		start   time.Time
		hours   int64
	}{{f.machine.ID, a.StartsAt, 2}, {f.machine.ID, b.StartsAt, 3}, {f.machine.ID, c.StartsAt, 1}, {f.machine.ID, running.StartsAt, 1}, {f.bareMachine.ID, e.StartsAt, 2}} {
		key := monday(item.start).Format("2006-01-02") + "/" + item.machine.String()
		want[key] = want[key].Add(decimal.NewFromInt(item.hours))
	}
	if len(want) != len(hours) {
		t.Fatalf("runtime buckets = %v, want %v", hours, want)
	}
	for key, value := range want {
		assertDecimal(t, "runtime "+key, hours[key], value.String())
	}
}

func TestStatisticsGranularityBoundaryAndMonths(t *testing.T) {
	f := newJobFixture(t)
	y := uniqueYear()
	statsClock := time.Date(y, time.June, 15, 12, 0, 0, 0, time.UTC)
	f.now = statsClock
	start := time.Date(y, time.June, 10, 10, 0, 0, 0, time.UTC)
	weekStart := start.AddDate(0, 0, -((int(start.Weekday()) + 6) % 7)).Format("2006-01-02")
	input := f.input(0, 0, "successful")
	input.StartsAt, input.EndsAt = start, start.Add(2*time.Hour)
	f.create(t, input)
	from := time.Date(y, time.June, 1, 0, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		days        int
		granularity string
		months      []string
		bucket      string
	}{
		{92, "week", []string{"06", "07", "08"}, ""},
		{93, "month", []string{"06", "07", "08", "09"}, fmt.Sprintf("%d-06-01", y)},
	} {
		if test.bucket == "" {
			test.bucket = weekStart
		}
		stats, err := f.s.Statistics(t.Context(), f.p, from, from.AddDate(0, 0, test.days))
		if err != nil {
			t.Fatal(err)
		}
		if stats.RuntimeGranularity != test.granularity {
			t.Fatalf("%d days: granularity = %s", test.days, stats.RuntimeGranularity)
		}
		var months []string
		for _, m := range stats.Months {
			months = append(months, m.Month)
		}
		for i := range test.months {
			test.months[i] = fmt.Sprintf("%d-%s", y, test.months[i])
		}
		if len(months) != len(test.months) {
			t.Fatalf("%d days: months = %v, want %v", test.days, months, test.months)
		}
		for i := range months {
			if months[i] != test.months[i] {
				t.Fatalf("%d days: months = %v, want %v", test.days, months, test.months)
			}
		}
		if len(stats.Runtime) != 1 || stats.Runtime[0].BucketStart.Format("2006-01-02") != test.bucket || stats.Runtime[0].MachineID != f.machine.ID {
			t.Fatalf("%d days: runtime = %+v, want bucket %s", test.days, stats.Runtime, test.bucket)
		}
		assertDecimal(t, "bucket hours", stats.Runtime[0].Hours, "2")
		if stats.Months[1].Charges != "0" || stats.Months[1].MaterialCost != "0" || stats.Months[1].Losses != "0" {
			t.Fatalf("an empty month must be zero: %+v", stats.Months[1])
		}
	}
	empty, err := f.s.Statistics(t.Context(), f.p, time.Date(y+1, 1, 1, 0, 0, 0, 0, time.UTC), time.Date(y+1, 1, 8, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if empty.Totals.Jobs != 0 || empty.Totals.FailureRate != "0" || len(empty.Machines) != 0 || len(empty.Runtime) != 0 || empty.Months == nil {
		t.Fatalf("empty period = %+v", empty)
	}
}

func TestStatisticsNewFieldsKeepTheirPermission(t *testing.T) {
	f := newJobFixture(t)
	statsClock := time.Date(2033, time.June, 15, 12, 0, 0, 0, time.UTC)
	jobsOnly := restrictedPrincipal(t, f.pool, authorization.MachineJobsRead)
	if _, err := f.s.Statistics(t.Context(), jobsOnly, statsClock.AddDate(0, 0, -7), statsClock); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("statistics without statistics.read: %v", err)
	}
}
