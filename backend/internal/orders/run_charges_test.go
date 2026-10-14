package orders

import (
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

func (f *fixture) stockedMaterial(t *testing.T, name string) uuid.UUID {
	t.Helper()
	m, e := f.jobs.CreateMaterial(t.Context(), f.p, name, "pla", nil, "g", nil, nil)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.jobs.AddPurchase(t.Context(), f.p, m.ID, m.InventoryVersion, "1000", "20", time.Now(), nil, nil, nil); e != nil {
		t.Fatal(e)
	}
	category, unit := "pla", "g"
	if _, e = f.jobs.CreatePricingRule(t.Context(), f.p, f.group, "material", nil, &category, &unit, "0.1", nil); e != nil {
		t.Fatal(e)
	}
	return m.ID
}

func TestOrderItemSnapshotIsBuiltFromAllRuns(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	material := f.stockedMaterial(t, "PLA runs")
	start := time.Now().UTC().Add(-6 * time.Hour).Truncate(time.Second)
	job, e := f.jobs.CreateManualJob(ctx, f.p, machinelogbook.JobInput{MachineID: f.machine, StartsAt: start, EndsAt: start.Add(time.Hour), Customer: machinelogbook.PartyReference{Kind: "organization", ID: f.organization}, OperatorPersonID: f.person, Outcome: "failed", Usages: []machinelogbook.UsageInput{{MaterialID: material, Quantity: "30"}}}, nil)
	if e != nil {
		t.Fatal(e)
	}
	reprintStart := start.Add(2 * time.Hour)
	reprintEnd := reprintStart.Add(2 * time.Hour)
	outcome := "successful"
	job, e = f.jobs.AddManualRun(ctx, f.p, job.ID, job.Version, machinelogbook.ManualRunInput{StartsAt: reprintStart, EndsAt: reprintEnd, Outcome: &outcome, Usages: []machinelogbook.UsageInput{{MaterialID: material, Quantity: "45"}}}, nil)
	if e != nil || len(job.Runs) != 2 {
		t.Fatal(e, job.Runs)
	}
	o := f.draft(t, true, "1")
	o, e = f.s.ChangeItem(ctx, f.p, o.ID, uuid.Nil, OrderItemInput{Kind: "machine_job", MachineJobID: job.ID, ExpectedJobVersion: job.Version, ExpectedVersion: o.Version}, "add", nil)
	if e != nil {
		t.Fatal(e)
	}
	var snapshot *JobChargeSnapshot
	for _, item := range o.Items {
		if item.Snapshot != nil {
			snapshot = item.Snapshot
		}
	}
	if snapshot == nil || !snapshot.StartsAt.Equal(start) || !snapshot.EndsAt.Equal(reprintEnd) {
		t.Fatalf("snapshot times are not the summary of the runs: %+v", snapshot)
	}
	if len(snapshot.Usages) != 2 {
		t.Fatalf("snapshot usages across the runs: %+v", snapshot.Usages)
	}
	total := map[string]bool{}
	for _, u := range snapshot.Usages {
		total[u.Quantity] = true
	}
	if !total["30"] || !total["45"] {
		t.Fatalf("snapshot usages: %+v", snapshot.Usages)
	}
	// 3 h of machine time at 10 per hour.
	if snapshot.DurationNanoseconds != "10800000000000" {
		t.Fatalf("duration = %s", snapshot.DurationNanoseconds)
	}
}

func TestRunningJobCannotBeOrderedOrFinalized(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	start := time.Now().UTC().Add(-time.Hour).Truncate(time.Second)
	job, e := f.jobs.CreateManualJob(ctx, f.p, machinelogbook.JobInput{MachineID: f.machine, StartsAt: start, EndsAt: start.Add(30 * time.Minute), Customer: machinelogbook.PartyReference{Kind: "organization", ID: f.organization}, OperatorPersonID: f.person, Outcome: "successful"}, nil)
	if e != nil {
		t.Fatal(e)
	}
	// A manual run that ends in the future is running.
	end := time.Now().UTC().Add(time.Hour)
	running, e := f.jobs.AddManualRun(ctx, f.p, job.ID, job.Version, machinelogbook.ManualRunInput{StartsAt: start.Add(time.Hour), EndsAt: end}, nil)
	if e != nil || running.Status != "running" {
		t.Fatalf("job is not running: %v %+v", e, running.Status)
	}
	o := f.draft(t, true, "1")
	if _, e = f.s.ChangeItem(ctx, f.p, o.ID, uuid.Nil, OrderItemInput{Kind: "machine_job", MachineJobID: running.ID, ExpectedJobVersion: running.Version, ExpectedVersion: o.Version}, "add", nil); !apperror.IsCode(e, "job_running") {
		t.Fatalf("running job added to an order: %v", e)
	}
}

func TestCounterSaleCreatesOneManualRunAndConsumesItsUsage(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	material := f.stockedMaterial(t, "PLA counter")
	start := time.Now().UTC().Add(-2 * time.Hour).Truncate(time.Second)
	input := CounterSaleCommand{OperationKey: newID(), ImmediateFulfillmentConfirmed: true, Job: CounterSaleJob{ManualJob: &ManualJob{MachineID: f.machine, StartsAt: start, EndsAt: start.Add(time.Hour), OperatorPersonID: f.person, Outcome: "successful", PricingGroupID: &f.group, Usages: []UsageInput{{MaterialID: material, Quantity: "40"}}}}, Payments: []PaymentInput{receipt("card", "14")}}
	counter, e := f.s.CounterSale(ctx, f.p, input, nil)
	if e != nil {
		t.Fatal(e)
	}
	job, e := f.jobs.GetJob(ctx, f.p, *counter.Items[0].SourceMachineJobID)
	if e != nil || len(job.Runs) != 1 || job.Runs[0].Source != "manual" || len(job.Runs[0].Usages) != 1 || job.Runs[0].Usages[0].Quantity != "40" {
		t.Fatalf("counter sale job: %v %+v", e, job.Runs)
	}
	var runs int
	if e = f.pool.QueryRow(ctx, "SELECT count(*) FROM machine_runs WHERE job_id=$1", job.ID).Scan(&runs); e != nil || runs != 1 {
		t.Fatalf("runs = %d %v", runs, e)
	}
	var consumed string
	if e = f.pool.QueryRow(ctx, "SELECT COALESCE(sum(quantity_delta),0)::text FROM inventory_transactions WHERE material_id=$1 AND kind='machine_run_consumption'", material).Scan(&consumed); e != nil || consumed != "-40.000000" && consumed != "-40" {
		t.Fatalf("consumption = %s %v", consumed, e)
	}
	// A counter sale whose manual run has not ended yet is a running job.
	future := CounterSaleCommand{OperationKey: newID(), ImmediateFulfillmentConfirmed: true, Job: CounterSaleJob{ManualJob: &ManualJob{MachineID: f.machine, StartsAt: time.Now().UTC().Add(-time.Minute), EndsAt: time.Now().UTC().Add(time.Hour), OperatorPersonID: f.person, PricingGroupID: &f.group, Usages: []UsageInput{}}}, Payments: []PaymentInput{receipt("card", "10")}}
	if _, e = f.s.CounterSale(ctx, f.p, future, nil); !apperror.IsCode(e, "job_running") {
		t.Fatalf("counter sale of a running job: %v", e)
	}
}
