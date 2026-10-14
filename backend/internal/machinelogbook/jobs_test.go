package machinelogbook

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// jobsClock is far from any real data so month-based reports only see the
// jobs these tests create.
var jobsClock = time.Date(2031, time.March, 10, 12, 0, 0, 500_000_000, time.UTC)

type jobFixture struct {
	pool        *pgxpool.Pool
	s           *Service
	p           authorization.Principal
	person      uuid.UUID
	machine     Machine
	bareMachine Machine // machine type without a runtime rule: pricing stays incomplete
	group       PricingGroup
	material    Material
	request     uuid.UUID
	now         time.Time
}

func newJobFixture(t *testing.T) *jobFixture {
	t.Helper()
	pool := integrationPool(t)
	ctx := t.Context()
	f := &jobFixture{pool: pool, person: uuid.Must(uuid.NewV7()), request: uuid.Must(uuid.NewV7()), now: jobsClock}
	f.s = NewService(pool, WithClock(func() time.Time { return f.now }))
	accountID := uuid.Must(uuid.NewV7())
	suffix := strings.ReplaceAll(f.person.String(), "-", "")[:12]
	f.p = authorization.Principal{AccountID: accountID, PersonID: f.person, Master: true}
	if _, err := pool.Exec(ctx, `INSERT INTO people (id, first_name, last_name, email) VALUES ($1, 'Job', 'Tester', $2)`, f.person, "jobs-"+suffix+"@example.test"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO accounts (id, person_id, status) VALUES ($1, $2, 'enabled')`, accountID, f.person); err != nil {
		t.Fatal(err)
	}
	var machineIDs, typeIDs []uuid.UUID
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, _ = pool.Exec(cleanup, `DELETE FROM audit_events WHERE request_id = $1`, f.request)
		if f.material.ID != uuid.Nil {
			_, _ = pool.Exec(cleanup, `DELETE FROM inventory_transactions WHERE material_id = $1`, f.material.ID)
		}
		for _, id := range machineIDs {
			_, _ = pool.Exec(cleanup, `DELETE FROM machine_jobs WHERE machine_id = $1`, id)
		}
		if f.group.ID != uuid.Nil {
			_, _ = pool.Exec(cleanup, `DELETE FROM pricing_groups WHERE id = $1`, f.group.ID)
		}
		for _, id := range machineIDs {
			_, _ = pool.Exec(cleanup, `DELETE FROM machines WHERE id = $1`, id)
		}
		if f.material.ID != uuid.Nil {
			_, _ = pool.Exec(cleanup, `DELETE FROM materials WHERE id = $1`, f.material.ID)
		}
		for _, id := range typeIDs {
			_, _ = pool.Exec(cleanup, `DELETE FROM machine_types WHERE id = $1`, id)
		}
		_, _ = pool.Exec(cleanup, `DELETE FROM accounts WHERE id = $1`, accountID)
		_, _ = pool.Exec(cleanup, `DELETE FROM people WHERE id = $1`, f.person)
	})
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	typ, err := f.s.CreateMachineType(ctx, f.p, "Jobs printer "+suffix, &f.request)
	must(err)
	typeIDs = append(typeIDs, typ.ID)
	f.machine, err = f.s.CreateMachine(ctx, f.p, typ.ID, "Jobs machine "+suffix, "active", nil, false, &f.request)
	must(err)
	machineIDs = append(machineIDs, f.machine.ID)
	bareType, err := f.s.CreateMachineType(ctx, f.p, "Jobs bare "+suffix, &f.request)
	must(err)
	typeIDs = append(typeIDs, bareType.ID)
	f.bareMachine, err = f.s.CreateMachine(ctx, f.p, bareType.ID, "Jobs bare machine "+suffix, "active", nil, false, &f.request)
	must(err)
	machineIDs = append(machineIDs, f.bareMachine.ID)
	f.material, err = f.s.CreateMaterial(ctx, f.p, "Jobs PLA "+suffix, "pla", nil, "g", nil, &f.request)
	must(err)
	purchase, err := f.s.AddPurchase(ctx, f.p, f.material.ID, f.material.InventoryVersion, "1000", "20", f.now, nil, nil, &f.request)
	must(err)
	f.material = purchase.Material
	f.group, err = f.s.CreatePricingGroup(ctx, f.p, "Jobs pricing "+suffix, nil, false, &f.request)
	must(err)
	_, err = f.s.CreatePricingRule(ctx, f.p, f.group.ID, "machine_runtime", &typ.ID, nil, nil, "10", &f.request)
	must(err)
	category, unit := "pla", "g"
	_, err = f.s.CreatePricingRule(ctx, f.p, f.group.ID, "material", nil, &category, &unit, "0.1", &f.request)
	must(err)
	return f
}

func (f *jobFixture) input(startOffset, duration time.Duration, outcome string) JobInput {
	start := f.now.Truncate(time.Second).Add(startOffset)
	return JobInput{MachineID: f.machine.ID, StartsAt: start, EndsAt: start.Add(duration), Customer: PartyReference{Kind: "person", ID: f.person}, OperatorPersonID: f.person, Outcome: outcome, PricingGroupID: &f.group.ID}
}

func (f *jobFixture) create(t *testing.T, input JobInput) MachineJob {
	t.Helper()
	job, err := f.s.CreateManualJob(t.Context(), f.p, input, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	return job
}

func (f *jobFixture) update(t *testing.T, job MachineJob, input JobInput) MachineJob {
	t.Helper()
	updated, err := f.s.UpdateJobFacts(t.Context(), f.p, job.ID, job.Version, input, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	return updated
}

func (f *jobFixture) adjust(t *testing.T, job MachineJob, kind, value string) MachineJob {
	t.Helper()
	adjusted, err := f.s.SetJobPriceAdjustment(t.Context(), f.p, job.ID, job.Version, kind, value, "test adjustment", &f.request)
	if err != nil {
		t.Fatal(err)
	}
	return adjusted
}

func price(value *string) string {
	if value == nil {
		return "<nil>"
	}
	return *value
}

func TestJobStatusAndOutcomeGuard(t *testing.T) {
	f := newJobFixture(t)
	ctx := t.Context()

	if _, err := f.s.CreateManualJob(ctx, f.p, f.input(-time.Hour, 3*time.Hour, "successful"), &f.request); !apperror.IsCode(err, "outcome_before_run_end") {
		t.Fatalf("future end with outcome: %v", err)
	}
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.s.CreateManualJobInTransaction(ctx, tx, true, f.p, f.input(-time.Hour, 3*time.Hour, "failed"), &f.request)
	_ = tx.Rollback(ctx)
	if !apperror.IsCode(err, "outcome_before_run_end") {
		t.Fatalf("counter-sale path allowed an outcome before the run end: %v", err)
	}

	running := f.create(t, f.input(-time.Hour, 3*time.Hour, "unknown"))
	if running.Status != "running" {
		t.Fatalf("running status = %s", running.Status)
	}
	if _, err = f.s.UpdateJobFacts(ctx, f.p, running.ID, running.Version, f.input(-time.Hour, 3*time.Hour, "successful"), &f.request); !apperror.IsCode(err, "outcome_before_run_end") {
		t.Fatalf("update of running job with outcome: %v", err)
	}
	finished := f.update(t, running, f.input(-3*time.Hour, 2*time.Hour, "unknown"))
	if finished.Status != "needs_outcome" {
		t.Fatalf("past end without outcome status = %s", finished.Status)
	}
	recorded := f.update(t, finished, f.input(-3*time.Hour, 2*time.Hour, "partial_failure"))
	if recorded.Status != "partial_failure" {
		t.Fatalf("recorded status = %s", recorded.Status)
	}
	if past := f.create(t, f.input(-3*time.Hour, time.Hour, "unknown")); past.Status != "needs_outcome" {
		t.Fatalf("past unknown status = %s", past.Status)
	}

	stillRunning := f.create(t, f.input(-time.Hour, 3*time.Hour, "unknown"))
	f.now = f.now.Add(4 * time.Hour)
	reread, err := f.s.GetJob(ctx, f.p, stillRunning.ID)
	if err != nil || reread.Status != "needs_outcome" {
		t.Fatalf("status is not derived at read time: %v %s", err, reread.Status)
	}
}

func TestCancelJobRun(t *testing.T) {
	f := newJobFixture(t)
	ctx := t.Context()
	// 4 hours at 10/h from one hour ago until three hours from now.
	job := f.create(t, f.input(-time.Hour, 4*time.Hour, "unknown"))
	if job.CalculatedPrice == nil || *job.CalculatedPrice != "40" {
		t.Fatalf("calculated = %s", price(job.CalculatedPrice))
	}
	job = f.adjust(t, job, "discount_percent", "50")
	if price(job.EffectivePrice) != "20" {
		t.Fatalf("discounted effective = %s", price(job.EffectivePrice))
	}

	if _, err := f.s.CancelJobRun(ctx, authorization.Principal{AccountID: f.p.AccountID}, job.ID, job.Version, &f.request); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("cancel without edit: %v", err)
	}
	if _, err := f.s.CancelJobRun(ctx, f.p, job.ID, job.Version-1, &f.request); !apperror.IsCode(err, "stale_write") {
		t.Fatalf("stale cancel: %v", err)
	}
	cancelled, err := f.s.CancelJobRun(ctx, f.p, job.ID, job.Version, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	if want := f.now.Truncate(time.Second); !cancelled.EndsAt.Equal(want) || cancelled.Outcome != "cancelled" || cancelled.Status != "cancelled" {
		t.Fatalf("cancelled job: ends=%s want=%s outcome=%s status=%s", cancelled.EndsAt, want, cancelled.Outcome, cancelled.Status)
	}
	// One hour of runtime now: 10, halved by the retained discount.
	if price(cancelled.CalculatedPrice) != "10" || price(cancelled.EffectivePrice) != "5" {
		t.Fatalf("repriced calculated=%s effective=%s", price(cancelled.CalculatedPrice), price(cancelled.EffectivePrice))
	}
	var audited int
	if err = f.pool.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE action = 'machine_job.run_cancelled' AND resource_id = $1 AND request_id = $2`, job.ID, f.request).Scan(&audited); err != nil || audited != 1 {
		t.Fatalf("cancel audit rows = %d err=%v", audited, err)
	}
	if _, err = f.s.CancelJobRun(ctx, f.p, job.ID, cancelled.Version, &f.request); !apperror.IsCode(err, "run_not_running") {
		t.Fatalf("second cancel: %v", err)
	}

	finished := f.create(t, f.input(-3*time.Hour, time.Hour, "unknown"))
	if _, err = f.s.CancelJobRun(ctx, f.p, finished.ID, finished.Version, &f.request); !apperror.IsCode(err, "run_not_running") {
		t.Fatalf("cancel of finished job: %v", err)
	}
	// A run that starts within the current second keeps a positive duration.
	f.now = jobsClock.Truncate(time.Second).Add(100 * time.Millisecond)
	fresh := f.create(t, f.input(0, time.Hour, "unknown"))
	freshCancelled, err := f.s.CancelJobRun(ctx, f.p, fresh.ID, fresh.Version, &f.request)
	if err != nil || !freshCancelled.EndsAt.Equal(fresh.StartsAt.Add(time.Second)) {
		t.Fatalf("minimum duration: %v ends=%s starts=%s", err, freshCancelled.EndsAt, fresh.StartsAt)
	}
}

func TestPriceAdjustmentKinds(t *testing.T) {
	f := newJobFixture(t)
	ctx := t.Context()
	// 20 minutes at 10/h is 3.333..., calculated as 3.33.
	job := f.create(t, f.input(-time.Hour, 20*time.Minute, "successful"))
	if price(job.CalculatedPrice) != "3.33" || price(job.EffectivePrice) != "3.33" || job.PriceAdjustment != nil {
		t.Fatalf("unadjusted job: %+v", job)
	}
	cases := []struct{ kind, value, want string }{
		{"fixed", "7.5", "7.5"},
		{"fixed", "0", "0"},
		{"discount_percent", "15", "2.83"},  // 3.33 * 0.85 = 2.8305
		{"discount_percent", "100", "0"},    // free
		{"discount_amount", "1", "2.33"},    // 3.33 - 1
		{"discount_amount", "100", "0"},     // clamped at zero
		{"multiplier", "1.5", "5"},          // 4.995 rounds half up
		{"multiplier", "0.5", "1.67"},       // 1.665 rounds half up
		{"multiplier", "100", "333"},        // upper bound
		{"discount_percent", "0.5", "3.31"}, // 3.31335
	}
	for _, c := range cases {
		job = f.adjust(t, job, c.kind, c.value)
		if price(job.EffectivePrice) != c.want || job.PriceAdjustment == nil || job.PriceAdjustment.Kind != c.kind {
			t.Fatalf("%s %s: effective = %s want %s", c.kind, c.value, price(job.EffectivePrice), c.want)
		}
		if price(job.CalculatedPrice) != "3.33" {
			t.Fatalf("adjustment changed the calculated price: %s", price(job.CalculatedPrice))
		}
		if job.PriceAdjustment.Reason != "test adjustment" || job.PriceAdjustment.AdjustedAt.IsZero() {
			t.Fatalf("adjustment metadata: %+v", job.PriceAdjustment)
		}
	}
	var stored string
	if err := f.pool.QueryRow(ctx, `SELECT effective_price::text FROM machine_jobs WHERE id = $1`, job.ID).Scan(&stored); err != nil || stored != "3.31" {
		t.Fatalf("stored effective price = %q err=%v", stored, err)
	}

	for _, invalid := range []struct{ kind, value, reason string }{
		{"fixed", "-1", "r"}, {"discount_percent", "0", "r"}, {"discount_percent", "100.01", "r"}, {"discount_amount", "0", "r"},
		{"multiplier", "0", "r"}, {"multiplier", "100.01", "r"}, {"bogus", "1", "r"}, {"fixed", "abc", "r"},
		{"fixed", "1", "   "}, {"fixed", "1", strings.Repeat("x", 501)},
	} {
		if _, err := f.s.SetJobPriceAdjustment(ctx, f.p, job.ID, job.Version, invalid.kind, invalid.value, invalid.reason, &f.request); !apperror.IsCode(err, "validation_failed") {
			t.Fatalf("%+v accepted: %v", invalid, err)
		}
	}
	if _, err := f.s.SetJobPriceAdjustment(ctx, f.p, job.ID, job.Version-1, "fixed", "1", "r", &f.request); !apperror.IsCode(err, "stale_write") {
		t.Fatalf("stale adjustment: %v", err)
	}
	if _, err := f.s.SetJobPriceAdjustment(ctx, authorization.Principal{AccountID: f.p.AccountID}, job.ID, job.Version, "fixed", "1", "r", &f.request); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("adjustment without permission: %v", err)
	}

	cleared, err := f.s.ClearJobPriceAdjustment(ctx, f.p, job.ID, job.Version, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	if price(cleared.EffectivePrice) != "3.33" || cleared.PriceAdjustment != nil {
		t.Fatalf("cleared job: %+v", cleared)
	}
	for _, action := range []string{"machine_job.price_adjusted", "machine_job.price_adjustment_cleared"} {
		var fields []string
		if err = f.pool.QueryRow(ctx, `SELECT changed_fields FROM audit_events WHERE action = $1 AND resource_id = $2 AND request_id = $3 LIMIT 1`, action, job.ID, f.request).Scan(&fields); err != nil || len(fields) != 2 || fields[0] != "priceAdjustment" || fields[1] != "effectivePrice" {
			t.Fatalf("%s audit fields = %v err=%v", action, fields, err)
		}
	}
}

func TestPriceAdjustmentIsReappliedWhenThePriceIsRecalculated(t *testing.T) {
	f := newJobFixture(t)
	input := f.input(-3*time.Hour, time.Hour, "successful")
	input.Usages = []UsageInput{{MaterialID: f.material.ID, Quantity: "50"}}
	job := f.create(t, input)
	// 1 h at 10 plus 50 g at 0.1.
	if price(job.CalculatedPrice) != "15" {
		t.Fatalf("calculated = %s", price(job.CalculatedPrice))
	}
	// Edits without a pricing group recalculate from the active snapshot.
	edit := input
	edit.PricingGroupID = nil
	edit.Usages = nil
	longer := edit
	longer.EndsAt = input.StartsAt.Add(2 * time.Hour)

	discounted := f.adjust(t, job, "discount_percent", "50")
	if price(discounted.EffectivePrice) != "7.5" {
		t.Fatalf("discounted = %s", price(discounted.EffectivePrice))
	}
	discounted = f.update(t, discounted, longer)
	if discounted.PricingSnapshot.Revision != 1 || price(discounted.CalculatedPrice) != "25" || price(discounted.EffectivePrice) != "12.5" {
		t.Fatalf("percent after runtime change: calculated=%s effective=%s", price(discounted.CalculatedPrice), price(discounted.EffectivePrice))
	}
	discounted = f.update(t, discounted, edit)
	if price(discounted.EffectivePrice) != "7.5" {
		t.Fatalf("percent after shortening: %s", price(discounted.EffectivePrice))
	}

	fixed := f.adjust(t, discounted, "fixed", "7")
	fixed = f.update(t, fixed, longer)
	if price(fixed.CalculatedPrice) != "25" || price(fixed.EffectivePrice) != "7" {
		t.Fatalf("fixed after runtime change: calculated=%s effective=%s", price(fixed.CalculatedPrice), price(fixed.EffectivePrice))
	}

	// Usage replacement recalculates as well: 2 h at 10 plus 100 g at 0.1.
	multiplied := f.adjust(t, fixed, "multiplier", "2")
	replaced, err := f.s.ReplaceJobUsages(t.Context(), f.p, multiplied.ID, multiplied.Version, []UsageInput{{MaterialID: f.material.ID, Quantity: "100"}}, &f.request)
	if err != nil || price(replaced.CalculatedPrice) != "30" || price(replaced.EffectivePrice) != "60" {
		t.Fatalf("multiplier after usage change: %v calculated=%s effective=%s", err, price(replaced.CalculatedPrice), price(replaced.EffectivePrice))
	}

	// An explicit pricing group captures a new snapshot and keeps the adjustment.
	reprice := longer
	reprice.PricingGroupID = &f.group.ID
	repriced := f.update(t, replaced, reprice)
	if repriced.PricingSnapshot.Revision != 2 || price(repriced.CalculatedPrice) != "30" || price(repriced.EffectivePrice) != "60" {
		t.Fatalf("multiplier after new snapshot: revision=%d calculated=%s effective=%s", repriced.PricingSnapshot.Revision, price(repriced.CalculatedPrice), price(repriced.EffectivePrice))
	}

	cleared, err := f.s.ClearJobPriceAdjustment(t.Context(), f.p, repriced.ID, repriced.Version, &f.request)
	if err != nil || price(cleared.EffectivePrice) != "30" {
		t.Fatalf("clear: %v %s", err, price(cleared.EffectivePrice))
	}
}

func TestRelativeAdjustmentWithIncompletePricingHasNoEffectivePrice(t *testing.T) {
	f := newJobFixture(t)
	input := f.input(-2*time.Hour, time.Hour, "successful")
	input.MachineID = f.bareMachine.ID
	job := f.create(t, input)
	if job.CalculatedPrice != nil || job.EffectivePrice != nil || job.PricingStatus != "incomplete" {
		t.Fatalf("incomplete job: %+v", job)
	}
	for _, kind := range []struct{ kind, value string }{{"discount_percent", "10"}, {"discount_amount", "1"}, {"multiplier", "2"}} {
		job = f.adjust(t, job, kind.kind, kind.value)
		if job.EffectivePrice != nil {
			t.Fatalf("%s produced %s without a calculated price", kind.kind, price(job.EffectivePrice))
		}
	}
	job = f.adjust(t, job, "fixed", "12.34")
	if price(job.EffectivePrice) != "12.34" || job.CalculatedPrice != nil {
		t.Fatalf("fixed on incomplete pricing: %+v", job)
	}
}

func TestJobTitleRoundTrip(t *testing.T) {
	f := newJobFixture(t)
	input := f.input(-2*time.Hour, time.Hour, "successful")
	title := "  Bracket batch  "
	input.Title = &title
	job := f.create(t, input)
	if job.Title == nil || *job.Title != "Bracket batch" {
		t.Fatalf("created title = %v", job.Title)
	}
	loaded, err := f.s.GetJob(t.Context(), f.p, job.ID)
	if err != nil || loaded.Title == nil || *loaded.Title != "Bracket batch" {
		t.Fatalf("loaded title: %v %v", err, loaded.Title)
	}
	renamed := "Gears"
	input.Title = &renamed
	job = f.update(t, job, input)
	if job.Title == nil || *job.Title != "Gears" {
		t.Fatalf("updated title = %v", job.Title)
	}
	blank := "   "
	input.Title = &blank
	job = f.update(t, job, input)
	if job.Title != nil {
		t.Fatalf("blank title stored as %q", *job.Title)
	}
	tooLong := strings.Repeat("x", 201)
	input.Title = &tooLong
	if _, err = f.s.UpdateJobFacts(t.Context(), f.p, job.ID, job.Version, input, &f.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("long title: %v", err)
	}
	if _, err = f.s.CreateManualJob(t.Context(), f.p, input, &f.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("long title on create: %v", err)
	}
	var fields []string
	if err = f.pool.QueryRow(t.Context(), `SELECT changed_fields FROM audit_events WHERE action = 'machine_job.updated' AND resource_id = $1 AND request_id = $2 LIMIT 1`, job.ID, f.request).Scan(&fields); err != nil || !strings.Contains(strings.Join(fields, ","), "title") {
		t.Fatalf("update audit fields = %v err=%v", fields, err)
	}
}

func decimalMinus(quantity, amount string) string {
	left, _ := parseDecimal(quantity, false)
	right, _ := parseDecimal(amount, false)
	return left.Sub(right).String()
}

func TestReportsUseTheEffectivePrice(t *testing.T) {
	f := newJobFixture(t)
	ctx := t.Context()
	from, to := time.Date(2031, time.March, 1, 0, 0, 0, 0, time.UTC), time.Date(2031, time.April, 1, 0, 0, 0, 0, time.UTC)
	charges := func() string {
		stats, err := f.s.Statistics(ctx, f.p, from, to)
		if err != nil {
			t.Fatal(err)
		}
		for _, point := range stats.CustomerCharges {
			if point.Label == "2031-03" {
				return point.Value
			}
		}
		return "0"
	}
	overview := func() string {
		item, err := f.s.Overview(ctx, f.p)
		if err != nil {
			t.Fatal(err)
		}
		return item.UnassignedEstimatedAmount
	}
	baseCharges, baseOverview := charges(), overview()
	job := f.create(t, f.input(-3*time.Hour, 2*time.Hour, "successful")) // calculated 20
	delta := func(base, current string) string {
		a, _ := parseDecimal(base, false)
		b, _ := parseDecimal(current, false)
		return b.Sub(a).String()
	}
	if got := delta(baseCharges, charges()); got != "20" {
		t.Fatalf("charges before discount = %s", got)
	}
	f.adjust(t, job, "discount_percent", "25")
	if got := delta(baseCharges, charges()); got != "15" {
		t.Fatalf("charges after discount = %s", got)
	}
	if got := delta(baseOverview, overview()); got != "15" {
		t.Fatalf("overview after discount = %s", got)
	}
}
