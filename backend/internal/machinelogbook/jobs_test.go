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
	"github.com/shopspring/decimal"
)

// jobsClock lies in the past and far from any real data, so month-based reports
// only see the jobs these tests create and no manual run is running. Tests that
// need running runs use newLiveJobFixture: job aggregates come from a database
// view that compares with the database clock.
var jobsClock = time.Date(2020, time.March, 10, 12, 0, 0, 500_000_000, time.UTC)

type jobFixture struct {
	pool         *pgxpool.Pool
	s            *Service
	p            authorization.Principal
	person       uuid.UUID
	machine      Machine
	bareMachine  Machine // machine type without a runtime rule: pricing stays incomplete
	group        PricingGroup
	materialType MaterialType
	material     Material
	request      uuid.UUID
	now          time.Time
}

func newJobFixture(t *testing.T) *jobFixture { return newJobFixtureAt(t, jobsClock) }

// newLiveJobFixture runs on the real clock, so runs ending in the future are
// running for the service and the database alike.
func newLiveJobFixture(t *testing.T) *jobFixture {
	return newJobFixtureAt(t, time.Now().UTC().Truncate(time.Second))
}

func newJobFixtureAt(t *testing.T, now time.Time) *jobFixture {
	t.Helper()
	pool := integrationPool(t)
	ctx := t.Context()
	f := &jobFixture{pool: pool, person: uuid.Must(uuid.NewV7()), request: uuid.Must(uuid.NewV7()), now: now}
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
			_, _ = pool.Exec(cleanup, `DELETE FROM machine_runs WHERE machine_id = $1`, id)
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
		if f.materialType.ID != uuid.Nil {
			_, _ = pool.Exec(cleanup, `DELETE FROM material_types WHERE id = $1`, f.materialType.ID)
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
	typ, err := f.s.CreateMachineType(ctx, f.p, "Jobs printer "+suffix, "other", &f.request)
	must(err)
	typeIDs = append(typeIDs, typ.ID)
	f.machine, err = f.s.CreateMachine(ctx, f.p, typ.ID, "Jobs machine "+suffix, "active", nil, false, &f.request)
	must(err)
	machineIDs = append(machineIDs, f.machine.ID)
	bareType, err := f.s.CreateMachineType(ctx, f.p, "Jobs bare "+suffix, "other", &f.request)
	must(err)
	typeIDs = append(typeIDs, bareType.ID)
	f.bareMachine, err = f.s.CreateMachine(ctx, f.p, bareType.ID, "Jobs bare machine "+suffix, "active", nil, false, &f.request)
	must(err)
	machineIDs = append(machineIDs, f.bareMachine.ID)
	f.materialType, err = f.s.CreateMaterialType(ctx, f.p, "Jobs PLA "+suffix, "g", []string{"fdm_printing", "other"}, &f.request)
	must(err)
	f.material, err = f.s.CreateMaterial(ctx, f.p, MaterialInput{Name: "Jobs PLA " + suffix, MaterialTypeID: f.materialType.ID}, &f.request)
	must(err)
	purchase, err := f.s.AddPurchase(ctx, f.p, f.material.ID, f.material.InventoryVersion, "1000", "20", f.now, nil, nil, &f.request)
	must(err)
	f.material = purchase.Material
	f.group, err = f.s.CreatePricingGroup(ctx, f.p, "Jobs pricing "+suffix, nil, false, &f.request)
	must(err)
	_, err = f.s.CreatePricingRule(ctx, f.p, f.group.ID, "machine_runtime", &typ.ID, nil, nil, "10", &f.request)
	must(err)
	_, err = f.s.CreatePricingRule(ctx, f.p, f.group.ID, "material", nil, &f.materialType.ID, nil, "0.1", &f.request)
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

// edit changes the staff-editable facts of a job; every field not given keeps
// its value.
func (f *jobFixture) edit(t *testing.T, job MachineJob, change func(*JobUpdate)) MachineJob {
	t.Helper()
	update := JobUpdate{MachineID: job.Machine.ID, Title: job.Title, OperatorPersonID: f.person, Notes: job.Notes}
	if job.Customer != nil {
		update.Customer = PartyReference{Kind: job.Customer.Kind, ID: job.Customer.ID}
	}
	if job.OutcomeOverridden {
		outcome := job.Outcome
		update.OutcomeOverride = &outcome
	}
	if change != nil {
		change(&update)
	}
	updated, err := f.s.UpdateJobFacts(t.Context(), f.p, job.ID, job.Version, update, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	return updated
}

// retime moves the first run of the job and returns the updated job.
func (f *jobFixture) retime(t *testing.T, job MachineJob, startsAt, endsAt time.Time, outcome *string) MachineJob {
	t.Helper()
	run := job.Runs[0]
	result, err := f.s.UpdateRun(t.Context(), f.p, run.ID, run.Version, RunUpdate{StartsAt: &startsAt, EndsAt: &endsAt, Outcome: outcome}, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	return *result.Job
}

func (f *jobFixture) adjust(t *testing.T, job MachineJob, kind, value string) MachineJob {
	t.Helper()
	adjusted, err := f.s.SetJobPriceAdjustment(t.Context(), f.p, job.ID, job.Version, kind, value, "test adjustment", &f.request)
	if err != nil {
		t.Fatal(err)
	}
	return adjusted
}

// addRun adds a manual run starting offset from the fixture clock.
func (f *jobFixture) addRun(t *testing.T, job MachineJob, offset, duration time.Duration, outcome *string, usages ...UsageInput) MachineJob {
	t.Helper()
	start := f.now.Truncate(time.Second).Add(offset)
	added, err := f.s.AddManualRun(t.Context(), f.p, job.ID, job.Version, ManualRunInput{StartsAt: start, EndsAt: start.Add(duration), Outcome: outcome, Usages: usages}, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	return added
}

func outcomePtr(value string) *string { return &value }

func price(value *string) string {
	if value == nil {
		return "<nil>"
	}
	return *value
}

func TestJobStatusAndOutcomeGuard(t *testing.T) {
	f := newLiveJobFixture(t)
	ctx := t.Context()

	if _, err := f.s.CreateManualJob(ctx, f.p, f.input(-time.Hour, 3*time.Hour, "successful"), &f.request); !apperror.IsCode(err, "outcome_before_run_end") {
		t.Fatalf("future end with outcome: %v", err)
	}
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.s.CreateManualJobInTransaction(ctx, tx, f.p, f.input(-time.Hour, 3*time.Hour, "failed"), &f.request)
	_ = tx.Rollback(ctx)
	if !apperror.IsCode(err, "outcome_before_run_end") {
		t.Fatalf("transactional path allowed an outcome before the run end: %v", err)
	}
	if _, err = f.s.CreateManualJob(ctx, f.p, f.input(-time.Hour, time.Hour, "bogus"), &f.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("invalid outcome: %v", err)
	}

	running := f.create(t, f.input(-time.Hour, 3*time.Hour, "unknown"))
	if running.Status != "running" || running.Outcome != "unknown" || running.EndedAt != nil || running.ExpectedEndAt == nil || len(running.Runs) != 1 || running.Runs[0].State != "running" || running.Runs[0].Outcome != nil {
		t.Fatalf("running job: status=%s outcome=%s ended=%v expected=%v runs=%+v", running.Status, running.Outcome, running.EndedAt, running.ExpectedEndAt, running.Runs)
	}
	run := running.Runs[0]
	if _, err = f.s.UpdateRun(ctx, f.p, run.ID, run.Version, RunUpdate{Outcome: outcomePtr("successful")}, &f.request); !apperror.IsCode(err, "outcome_before_run_end") {
		t.Fatalf("outcome of a running run: %v", err)
	}
	if _, err = f.s.UpdateJobFacts(ctx, f.p, running.ID, running.Version, JobUpdate{MachineID: f.machine.ID, Customer: PartyReference{Kind: "person", ID: f.person}, OperatorPersonID: f.person, OutcomeOverride: outcomePtr("failed")}, &f.request); !apperror.IsCode(err, "outcome_before_run_end") {
		t.Fatalf("override of a running job: %v", err)
	}
	finished := f.retime(t, running, f.now.Add(-3*time.Hour), f.now.Add(-2*time.Hour), nil)
	if finished.Status != "needs_outcome" || finished.Outcome != "unknown" || finished.EndedAt == nil {
		t.Fatalf("past end without outcome: status=%s outcome=%s", finished.Status, finished.Outcome)
	}
	recorded := f.retime(t, finished, f.now.Add(-3*time.Hour), f.now.Add(-2*time.Hour), outcomePtr("partial_failure"))
	if recorded.Status != "partial_failure" || recorded.Outcome != "partial_failure" || recorded.OutcomeOverridden {
		t.Fatalf("recorded job: status=%s outcome=%s", recorded.Status, recorded.Outcome)
	}
	if past := f.create(t, f.input(-3*time.Hour, time.Hour, "unknown")); past.Status != "needs_outcome" {
		t.Fatalf("past unknown status = %s", past.Status)
	}

	// The status is derived at read time: a run that ends within the second
	// is running at first and waiting for its outcome afterwards.
	soon := f.input(-time.Hour, time.Hour, "unknown")
	soon.EndsAt = time.Now().UTC().Add(1500 * time.Millisecond)
	stillRunning := f.create(t, soon)
	if stillRunning.Status != "running" {
		t.Fatalf("status before the end = %s", stillRunning.Status)
	}
	time.Sleep(1700 * time.Millisecond)
	f.now = time.Now().UTC()
	reread, err := f.s.GetJob(ctx, f.p, stillRunning.ID)
	if err != nil || reread.Status != "needs_outcome" {
		t.Fatalf("status is not derived at read time: %v %s", err, reread.Status)
	}
}

func TestCancelManualRun(t *testing.T) {
	f := newLiveJobFixture(t)
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
	run := job.Runs[0]

	if _, err := f.s.CancelRun(ctx, authorization.Principal{AccountID: f.p.AccountID}, run.ID, run.Version, &f.request); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("cancel without edit: %v", err)
	}
	if _, err := f.s.CancelRun(ctx, f.p, run.ID, run.Version+1, &f.request); !apperror.IsCode(err, "stale_write") {
		t.Fatalf("stale cancel: %v", err)
	}
	cancelled, err := f.s.CancelRun(ctx, f.p, run.ID, run.Version, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	cancelledRun := cancelled.Runs[0]
	if want := f.now.Truncate(time.Second); cancelledRun.EndedAt == nil || !cancelledRun.EndedAt.Equal(want) || cancelledRun.State != "cancelled" || cancelledRun.Outcome == nil || *cancelledRun.Outcome != "cancelled" || cancelled.Outcome != "cancelled" || cancelled.Status != "cancelled" {
		t.Fatalf("cancelled job: run=%+v want end %s outcome=%s status=%s", cancelledRun, want, cancelled.Outcome, cancelled.Status)
	}
	// One hour of runtime now: 10, halved by the retained discount.
	if price(cancelled.CalculatedPrice) != "10" || price(cancelled.EffectivePrice) != "5" {
		t.Fatalf("repriced calculated=%s effective=%s", price(cancelled.CalculatedPrice), price(cancelled.EffectivePrice))
	}
	var audited int
	if err = f.pool.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE action = 'machine_run.cancelled' AND resource_id = $1 AND request_id = $2`, run.ID, f.request).Scan(&audited); err != nil || audited != 1 {
		t.Fatalf("cancel audit rows = %d err=%v", audited, err)
	}
	if _, err = f.s.CancelRun(ctx, f.p, run.ID, cancelledRun.Version, &f.request); !apperror.IsCode(err, "run_not_running") {
		t.Fatalf("second cancel: %v", err)
	}

	finished := f.create(t, f.input(-3*time.Hour, time.Hour, "unknown"))
	if _, err = f.s.CancelRun(ctx, f.p, finished.Runs[0].ID, finished.Runs[0].Version, &f.request); !apperror.IsCode(err, "run_not_running") {
		t.Fatalf("cancel of finished run: %v", err)
	}
	// A run that starts within the current second keeps a positive duration.
	f.now = f.now.Truncate(time.Second).Add(100 * time.Millisecond)
	fresh := f.create(t, f.input(0, time.Hour, "unknown"))
	freshCancelled, err := f.s.CancelRun(ctx, f.p, fresh.Runs[0].ID, fresh.Runs[0].Version, &f.request)
	if err != nil || freshCancelled.Runs[0].EndedAt == nil || !freshCancelled.Runs[0].EndedAt.Equal(fresh.Runs[0].StartedAt.Add(time.Second)) {
		t.Fatalf("minimum duration: %v run=%+v starts=%s", err, freshCancelled.Runs[0], fresh.Runs[0].StartedAt)
	}
}

func TestAdditionalRunsSumUpAndDeriveTheOutcome(t *testing.T) {
	f := newJobFixture(t)
	input := f.input(-10*time.Hour, time.Hour, "successful")
	input.Usages = []UsageInput{{MaterialID: f.material.ID, Quantity: "50"}}
	job := f.create(t, input)
	if job.Outcome != "successful" || job.Status != "successful" || job.DurationSeconds != 3600 || price(job.CalculatedPrice) != "15" || len(job.Runs) != 1 || job.Runs[0].Source != "manual" || len(job.Runs[0].Usages) != 1 {
		t.Fatalf("first run: %+v", job)
	}

	// A reprint: another hour and 20 g, still failed.
	job = f.addRun(t, job, -5*time.Hour, 2*time.Hour, outcomePtr("failed"), UsageInput{MaterialID: f.material.ID, Quantity: "20"})
	if len(job.Runs) != 2 || job.DurationSeconds != 3*3600 || job.Outcome != "partial_failure" || job.Status != "partial_failure" {
		t.Fatalf("after reprint: runs=%d duration=%d outcome=%s", len(job.Runs), job.DurationSeconds, job.Outcome)
	}
	// 3 h at 10 plus 70 g at 0.1.
	if price(job.CalculatedPrice) != "37" || len(job.Usages) != 2 {
		t.Fatalf("summed price = %s usages=%d", price(job.CalculatedPrice), len(job.Usages))
	}
	if job.StartedAt == nil || !job.StartedAt.Equal(job.Runs[0].StartedAt) || job.EndedAt == nil || !job.EndedAt.Equal(*job.Runs[1].EndedAt) {
		t.Fatalf("job times: %v %v", job.StartedAt, job.EndedAt)
	}
	if got := f.quantity(t, f.material.ID); got != decimalMinus("1000", "70") {
		t.Fatalf("material quantity = %s", got)
	}

	// Derived outcome rules over the runs' outcomes.
	cases := []struct{ first, second, want string }{
		{"successful", "successful", "successful"},
		{"cancelled", "cancelled", "cancelled"},
		{"failed", "failed", "failed"},
		{"successful", "cancelled", "partial_failure"},
		{"failed", "cancelled", "partial_failure"},
	}
	for _, c := range cases {
		j := f.create(t, f.input(-10*time.Hour, time.Hour, c.first))
		j = f.addRun(t, j, -5*time.Hour, time.Hour, outcomePtr(c.second))
		if j.Outcome != c.want || j.Status != c.want {
			t.Fatalf("%s + %s = %s/%s want %s", c.first, c.second, j.Outcome, j.Status, c.want)
		}
	}
	// A run without outcome leaves the job waiting for one.
	pending := f.addRun(t, f.create(t, f.input(-10*time.Hour, time.Hour, "successful")), -5*time.Hour, time.Hour, nil)
	if pending.Status != "needs_outcome" || pending.Outcome != "unknown" {
		t.Fatalf("pending: %s/%s", pending.Status, pending.Outcome)
	}
	// ...until the outcome is recorded on that run.
	second := pending.Runs[1]
	result, err := f.s.UpdateRun(t.Context(), f.p, second.ID, second.Version, RunUpdate{Outcome: outcomePtr("failed")}, &f.request)
	if err != nil || result.Job.Status != "partial_failure" {
		t.Fatalf("outcome on the second run: %v %+v", err, result.Job)
	}

	// The outcome override replaces the derived outcome and can be cleared.
	overridden := f.edit(t, *result.Job, func(u *JobUpdate) { u.OutcomeOverride = outcomePtr("successful") })
	if overridden.Outcome != "successful" || overridden.Status != "successful" || !overridden.OutcomeOverridden {
		t.Fatalf("override: %+v", overridden)
	}
	cleared := f.edit(t, overridden, func(u *JobUpdate) { u.OutcomeOverride = nil })
	if cleared.Outcome != "partial_failure" || cleared.OutcomeOverridden {
		t.Fatalf("cleared override: %s overridden=%v", cleared.Outcome, cleared.OutcomeOverridden)
	}
	if _, err = f.s.AddManualRun(t.Context(), authorization.Principal{AccountID: f.p.AccountID}, job.ID, job.Version, ManualRunInput{StartsAt: f.now.Add(-time.Hour), EndsAt: f.now}, &f.request); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("add run without edit: %v", err)
	}
	if _, err = f.s.AddManualRun(t.Context(), f.p, job.ID, job.Version+1, ManualRunInput{StartsAt: f.now.Add(-time.Hour), EndsAt: f.now}, &f.request); !apperror.IsCode(err, "stale_write") {
		t.Fatalf("stale add run: %v", err)
	}
	if _, err = f.s.AddManualRun(t.Context(), f.p, job.ID, job.Version, ManualRunInput{StartsAt: f.now, EndsAt: f.now}, &f.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("empty interval: %v", err)
	}
}

func (f *jobFixture) quantity(t *testing.T, materialID uuid.UUID) string {
	t.Helper()
	var sum string
	if err := f.pool.QueryRow(t.Context(), `SELECT COALESCE(sum(quantity_delta), 0)::text FROM inventory_transactions WHERE material_id = $1`, materialID).Scan(&sum); err != nil {
		t.Fatal(err)
	}
	value, err := decimal.NewFromString(sum)
	if err != nil {
		t.Fatal(err)
	}
	return value.String()
}

func TestUpdateRunTimesAndPermissions(t *testing.T) {
	f := newLiveJobFixture(t)
	ctx := t.Context()
	job := f.create(t, f.input(-3*time.Hour, time.Hour, "successful"))
	run := job.Runs[0]
	start, end := f.now.Add(-4*time.Hour), f.now.Add(-time.Hour)
	if _, err := f.s.UpdateRun(ctx, authorization.Principal{AccountID: f.p.AccountID}, run.ID, run.Version, RunUpdate{StartsAt: &start, EndsAt: &end, Outcome: outcomePtr("successful")}, &f.request); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("update without edit: %v", err)
	}
	if _, err := f.s.UpdateRun(ctx, f.p, run.ID, run.Version+1, RunUpdate{Outcome: outcomePtr("successful")}, &f.request); !apperror.IsCode(err, "stale_write") {
		t.Fatalf("stale update: %v", err)
	}
	future := f.now.Add(time.Hour)
	if _, err := f.s.UpdateRun(ctx, f.p, run.ID, run.Version, RunUpdate{EndsAt: &future, Outcome: outcomePtr("successful")}, &f.request); !apperror.IsCode(err, "outcome_before_run_end") {
		t.Fatalf("future end with outcome: %v", err)
	}
	if _, err := f.s.UpdateRun(ctx, f.p, run.ID, run.Version, RunUpdate{StartsAt: &end, EndsAt: &start}, &f.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("inverted interval: %v", err)
	}
	if _, err := f.s.UpdateRun(ctx, f.p, uuid.Must(uuid.NewV7()), 1, RunUpdate{}, &f.request); !apperror.IsCode(err, "not_found") {
		t.Fatalf("unknown run: %v", err)
	}
	result, err := f.s.UpdateRun(ctx, f.p, run.ID, run.Version, RunUpdate{StartsAt: &start, EndsAt: &end, Outcome: outcomePtr("failed")}, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	// Three hours now, priced from the snapshot.
	if result.Run.Version != run.Version+1 || result.Run.DurationSeconds != 3*3600 || price(result.Job.CalculatedPrice) != "30" || result.Job.Status != "failed" || result.Job.Version <= job.Version {
		t.Fatalf("updated run: %+v job=%+v", result.Run, result.Job)
	}
	var fields []string
	if err = f.pool.QueryRow(ctx, `SELECT changed_fields FROM audit_events WHERE action = 'machine_run.updated' AND resource_id = $1 AND request_id = $2`, run.ID, f.request).Scan(&fields); err != nil || strings.Join(fields, ",") != "outcome,startsAt,endsAt" {
		t.Fatalf("update audit fields = %v err=%v", fields, err)
	}
}

func TestReplaceRunUsagesCompensatesInventory(t *testing.T) {
	f := newJobFixture(t)
	ctx := t.Context()
	input := f.input(-10*time.Hour, time.Hour, "successful")
	input.Usages = []UsageInput{{MaterialID: f.material.ID, Quantity: "50"}}
	job := f.create(t, input)
	run := job.Runs[0]
	if _, err := f.s.ReplaceRunUsages(ctx, authorization.Principal{AccountID: f.p.AccountID}, run.ID, run.Version, nil, &f.request); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("replace without edit: %v", err)
	}
	if _, err := f.s.ReplaceRunUsages(ctx, f.p, run.ID, run.Version+1, nil, &f.request); !apperror.IsCode(err, "stale_write") {
		t.Fatalf("stale replace: %v", err)
	}
	result, err := f.s.ReplaceRunUsages(ctx, f.p, run.ID, run.Version, []UsageInput{{MaterialID: f.material.ID, Quantity: "80"}}, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Run.Usages) != 1 || result.Run.Usages[0].Quantity != "80" || result.Run.UsagesFromMachine || price(result.Job.CalculatedPrice) != "18" {
		t.Fatalf("replaced usages: %+v price=%s", result.Run.Usages, price(result.Job.CalculatedPrice))
	}
	if got := f.quantity(t, f.material.ID); got != decimalMinus("1000", "80") {
		t.Fatalf("material quantity = %s", got)
	}
	if _, err = f.s.ReplaceRunUsages(ctx, f.p, run.ID, result.Run.Version, []UsageInput{{MaterialID: f.material.ID, Quantity: "0"}}, &f.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("zero quantity: %v", err)
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
	if _, err := f.s.SetJobPriceAdjustment(ctx, f.p, job.ID, job.Version+1, "fixed", "1", "r", &f.request); !apperror.IsCode(err, "stale_write") {
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
	start := job.Runs[0].StartedAt
	longer := func(j MachineJob) MachineJob {
		return f.retime(t, j, start, start.Add(2*time.Hour), outcomePtr("successful"))
	}
	shorter := func(j MachineJob) MachineJob {
		return f.retime(t, j, start, start.Add(time.Hour), outcomePtr("successful"))
	}

	discounted := f.adjust(t, job, "discount_percent", "50")
	if price(discounted.EffectivePrice) != "7.5" {
		t.Fatalf("discounted = %s", price(discounted.EffectivePrice))
	}
	discounted = longer(discounted)
	if discounted.PricingSnapshot.Revision != 1 || price(discounted.CalculatedPrice) != "25" || price(discounted.EffectivePrice) != "12.5" {
		t.Fatalf("percent after runtime change: calculated=%s effective=%s", price(discounted.CalculatedPrice), price(discounted.EffectivePrice))
	}
	discounted = shorter(discounted)
	if price(discounted.EffectivePrice) != "7.5" {
		t.Fatalf("percent after shortening: %s", price(discounted.EffectivePrice))
	}

	fixed := f.adjust(t, discounted, "fixed", "7")
	fixed = longer(fixed)
	if price(fixed.CalculatedPrice) != "25" || price(fixed.EffectivePrice) != "7" {
		t.Fatalf("fixed after runtime change: calculated=%s effective=%s", price(fixed.CalculatedPrice), price(fixed.EffectivePrice))
	}

	// Usage replacement recalculates as well: 2 h at 10 plus 100 g at 0.1.
	multiplied := f.adjust(t, fixed, "multiplier", "2")
	run := multiplied.Runs[0]
	result, err := f.s.ReplaceRunUsages(t.Context(), f.p, run.ID, run.Version, []UsageInput{{MaterialID: f.material.ID, Quantity: "100"}}, &f.request)
	if err != nil || price(result.Job.CalculatedPrice) != "30" || price(result.Job.EffectivePrice) != "60" {
		t.Fatalf("multiplier after usage change: %v calculated=%s effective=%s", err, price(result.Job.CalculatedPrice), price(result.Job.EffectivePrice))
	}

	// An explicit pricing group captures a new snapshot and keeps the adjustment.
	repriced := f.edit(t, *result.Job, func(u *JobUpdate) { u.PricingGroupID = &f.group.ID })
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
	job = f.edit(t, job, func(u *JobUpdate) { u.Title = &renamed })
	if job.Title == nil || *job.Title != "Gears" {
		t.Fatalf("updated title = %v", job.Title)
	}
	blank := "   "
	job = f.edit(t, job, func(u *JobUpdate) { u.Title = &blank })
	if job.Title != nil {
		t.Fatalf("blank title stored as %q", *job.Title)
	}
	tooLong := strings.Repeat("x", 201)
	if _, err = f.s.UpdateJobFacts(t.Context(), f.p, job.ID, job.Version, JobUpdate{MachineID: f.machine.ID, Customer: PartyReference{Kind: "person", ID: f.person}, OperatorPersonID: f.person, Title: &tooLong}, &f.request); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("long title: %v", err)
	}
	input.Title = &tooLong
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
	from, to := time.Date(2020, time.March, 1, 0, 0, 0, 0, time.UTC), time.Date(2020, time.April, 1, 0, 0, 0, 0, time.UTC)
	charges := func() string {
		stats, err := f.s.Statistics(ctx, f.p, from, to)
		if err != nil {
			t.Fatal(err)
		}
		for _, point := range stats.CustomerCharges {
			if point.Label == "2020-03" {
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
