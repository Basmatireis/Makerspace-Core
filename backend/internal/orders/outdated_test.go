package orders

import (
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
)

// Only changes a charge depends on mark an ordered job as outdated; notes and the signage flag do not.
func TestOrderItemIsOutdatedOnlyByBillingRelevantJobChanges(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	plaType, e := f.jobs.CreateMaterialType(ctx, f.p, "PLA "+ids.New().String(), "filament", "g", nil, nil)
	if e != nil {
		t.Fatal(e)
	}
	material, e := f.jobs.CreateMaterial(
		ctx,
		f.p,
		machinelogbook.MaterialInput{Name: "PLA black", MaterialTypeID: plaType.ID},
		nil,
	)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.jobs.AddPurchase(
		ctx, f.p, material.ID, material.InventoryVersion, "100", "10", time.Now(), nil, nil, nil, nil,
	); e != nil {
		t.Fatal(e)
	}
	if _, e = f.jobs.CreatePricingRule(ctx, f.p, f.group, "material", nil, &plaType.ID, nil, "0.1", nil); e != nil {
		t.Fatal(e)
	}
	start := time.Now().UTC().Add(-3 * time.Hour)
	job, e := f.jobs.CreateManualJob(
		ctx,
		f.p,
		machinelogbook.JobInput{
			MachineID:        f.machine,
			StartsAt:         start,
			EndsAt:           start.Add(time.Hour),
			Customer:         machinelogbook.PartyReference{Kind: "organization", ID: f.organization},
			OperatorPersonID: f.person,
			Outcome:          "successful",
			PricingGroupID:   &f.group,
			Usages:           []machinelogbook.UsageInput{{MaterialID: material.ID, Quantity: "10"}},
		},
		nil,
	)
	if e != nil {
		t.Fatal(e)
	}
	o, e := f.s.Create(
		ctx,
		f.p,
		OrderDraftInput{Customer: &OrderCustomer{Kind: "organization", ID: f.organization}},
		nil,
	)
	if e != nil {
		t.Fatal(e)
	}
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
	// outdated reports the item flag; the order attention, the job's billing attention and the job
	// association must agree with it.
	outdated := func() bool {
		t.Helper()
		got, err := f.s.Get(ctx, f.p, o.ID)
		if err != nil {
			t.Fatal(err)
		}
		attention := false
		for _, a := range got.Attention {
			attention = attention || a.Code == AttentionSourceChanged
		}
		current, err := f.jobs.GetJob(ctx, f.p, job.ID)
		if err != nil {
			t.Fatal(err)
		}
		jobAttention := false
		for _, a := range current.Attention {
			jobAttention = jobAttention || a.Code == machinelogbook.AttentionOrderOutdated
		}
		association, err := f.s.JobAssociation(ctx, f.p, job.ID)
		if err != nil {
			t.Fatal(err)
		}
		item := false
		for _, i := range got.Items {
			if i.RemovedAt == nil {
				item = i.SourceChanged
			}
		}
		if item != attention || item != jobAttention || item != association.SourceChanged {
			t.Fatalf("inconsistent: item %v order attention %v job attention %v association %v",
				item, attention, jobAttention, association.SourceChanged)
		}
		return item
	}
	if outdated() {
		t.Fatal("a fresh item is outdated")
	}
	update := func(mutate func(*machinelogbook.JobUpdate)) {
		t.Helper()
		current, err := f.jobs.GetJob(ctx, f.p, job.ID)
		if err != nil {
			t.Fatal(err)
		}
		input := machinelogbook.JobUpdate{
			MachineID:        current.Machine.ID,
			Customer:         machinelogbook.PartyReference{Kind: "organization", ID: f.organization},
			OperatorPersonID: f.person,
			Title:            current.Title,
			Notes:            current.Notes,
		}
		mutate(&input)
		if _, err = f.jobs.UpdateJobFacts(ctx, f.p, job.ID, current.Version, input, nil); err != nil {
			t.Fatal(err)
		}
	}
	hidden, notes := true, "Customer wants it matte"
	update(func(i *machinelogbook.JobUpdate) { i.HiddenFromSignage = &hidden })
	if outdated() {
		t.Fatal("hiding the job from signage marked the order outdated")
	}
	update(func(i *machinelogbook.JobUpdate) { i.Notes = &notes })
	if outdated() {
		t.Fatal("editing notes marked the order outdated")
	}

	current, err := f.jobs.GetJob(ctx, f.p, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.jobs.ReplaceRunUsages(
		ctx,
		f.p,
		current.Runs[0].ID,
		current.Runs[0].Version,
		[]machinelogbook.UsageInput{{MaterialID: material.ID, Quantity: "5"}},
		nil,
	); err != nil {
		t.Fatal(err)
	}
	if !outdated() {
		t.Fatal("changing a usage quantity did not mark the order outdated")
	}
	// Refreshing the item captures the job again.
	got, err := f.s.Get(ctx, f.p, o.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.ChangeItem(
		ctx, f.p, o.ID, got.Items[0].ID, OrderItemInput{ExpectedVersion: got.Version}, "refresh", nil,
	); err != nil {
		t.Fatal(err)
	}
	if outdated() {
		t.Fatal("a refreshed item is still outdated")
	}
}
