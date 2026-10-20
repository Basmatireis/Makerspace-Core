package orders

import (
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

func (f *fixture) stockedMaterial(t *testing.T, name string) uuid.UUID {
	t.Helper()
	materialType, e := f.jobs.CreateMaterialType(
		t.Context(),
		f.p,
		"PLA "+ids.New().String(),
		"g",
		[]string{"fdm_printing", "other"},
		nil,
	)
	if e != nil {
		t.Fatal(e)
	}
	m, e := f.jobs.CreateMaterial(
		t.Context(),
		f.p,
		machinelogbook.MaterialInput{Name: name, MaterialTypeID: materialType.ID},
		nil,
	)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.jobs.AddPurchase(
		t.Context(),
		f.p,
		m.ID,
		m.InventoryVersion,
		"1000",
		"20",
		time.Now(),
		nil,
		nil,
		nil,
	); e != nil {
		t.Fatal(e)
	}
	if _, e = f.jobs.CreatePricingRule(
		t.Context(),
		f.p,
		f.group,
		"material",
		nil,
		&materialType.ID,
		nil,
		"0.1",
		nil,
	); e != nil {
		t.Fatal(e)
	}
	return m.ID
}

func TestOrderItemSnapshotIsBuiltFromAllRuns(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	material := f.stockedMaterial(t, "PLA runs")
	start := time.Now().UTC().Add(-6 * time.Hour).Truncate(time.Second)
	job, e := f.jobs.CreateManualJob(
		ctx,
		f.p,
		machinelogbook.JobInput{
			MachineID:        f.machine,
			StartsAt:         start,
			EndsAt:           start.Add(time.Hour),
			Customer:         machinelogbook.PartyReference{Kind: "organization", ID: f.organization},
			OperatorPersonID: f.person,
			Outcome:          "failed",
			Usages:           []machinelogbook.UsageInput{{MaterialID: material, Quantity: "30"}},
		},
		nil,
	)
	if e != nil {
		t.Fatal(e)
	}
	reprintStart := start.Add(2 * time.Hour)
	reprintEnd := reprintStart.Add(2 * time.Hour)
	outcome := machinelogbook.RunOutcomeSuccessful
	job, e = f.jobs.AddManualRun(
		ctx,
		f.p,
		job.ID,
		job.Version,
		machinelogbook.ManualRunInput{
			StartsAt: reprintStart,
			EndsAt:   reprintEnd,
			Outcome:  &outcome,
			Usages:   []machinelogbook.UsageInput{{MaterialID: material, Quantity: "45"}},
		},
		nil,
	)
	if e != nil || len(job.Runs) != 2 {
		t.Fatal(e, job.Runs)
	}
	o := f.draft(t, true, "1")
	o, e = f.s.ChangeItem(
		ctx,
		f.p,
		o.ID,
		uuid.Nil,
		OrderItemInput{
			Kind:               "machine_job",
			MachineJobID:       job.ID,
			ExpectedJobVersion: job.Version,
			ExpectedVersion:    o.Version,
		},
		"add",
		nil,
	)
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
	job, e := f.jobs.CreateManualJob(
		ctx,
		f.p,
		machinelogbook.JobInput{
			MachineID:        f.machine,
			StartsAt:         start,
			EndsAt:           start.Add(30 * time.Minute),
			Customer:         machinelogbook.PartyReference{Kind: "organization", ID: f.organization},
			OperatorPersonID: f.person,
			Outcome:          "successful",
		},
		nil,
	)
	if e != nil {
		t.Fatal(e)
	}
	// A manual run that ends in the future is running.
	end := time.Now().UTC().Add(time.Hour)
	running, e := f.jobs.AddManualRun(
		ctx,
		f.p,
		job.ID,
		job.Version,
		machinelogbook.ManualRunInput{StartsAt: start.Add(time.Hour), EndsAt: end},
		nil,
	)
	if e != nil || running.Status != "running" {
		t.Fatalf("job is not running: %v %+v", e, running.Status)
	}
	o := f.draft(t, true, "1")
	if _, e = f.s.ChangeItem(
		ctx,
		f.p,
		o.ID,
		uuid.Nil,
		OrderItemInput{
			Kind:               "machine_job",
			MachineJobID:       running.ID,
			ExpectedJobVersion: running.Version,
			ExpectedVersion:    o.Version,
		},
		"add",
		nil,
	); !apperror.IsCode(
		e,
		"job_running",
	) {
		t.Fatalf("running job added to an order: %v", e)
	}
}
