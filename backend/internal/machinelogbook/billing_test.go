package machinelogbook

import (
	"slices"
	"testing"
)

func TestNothingToBillNeedsAnEndedCompletelyPricedJobOfZero(t *testing.T) {
	price := func(v string) *string { return &v }
	tests := []struct {
		name string
		job  MachineJob
		want bool
	}{
		{"zero", MachineJob{Status: JobStatusSuccessful, PricingStatus: PricingComplete, EffectivePrice: price("0.00")}, true},
		{"zero failed", MachineJob{Status: JobStatusFailed, PricingStatus: PricingComplete, EffectivePrice: price("0")}, true},
		{"priced", MachineJob{Status: JobStatusSuccessful, PricingStatus: PricingComplete, EffectivePrice: price("0.01")}, false},
		{"running", MachineJob{Status: JobStatusRunning, PricingStatus: PricingComplete, EffectivePrice: price("0.00")}, false},
		{"planned", MachineJob{Status: JobStatusPlanned, PricingStatus: PricingComplete, EffectivePrice: price("0.00")}, false},
		{"incomplete", MachineJob{Status: JobStatusSuccessful, PricingStatus: PricingIncomplete, EffectivePrice: price("0.00")}, false},
		{"pending", MachineJob{Status: JobStatusSuccessful, PricingStatus: "pending", EffectivePrice: price("0.00")}, false},
		{"no price", MachineJob{Status: JobStatusSuccessful, PricingStatus: PricingComplete}, false},
	}
	for _, test := range tests {
		if got := test.job.NothingToBill(); got != test.want {
			t.Errorf("%s: NothingToBill() = %v, want %v", test.name, got, test.want)
		}
	}
}

// A waived job is "nothing to bill" in the work table, in the billing filters and for its recipient, and is not
// flagged as missing from an order; a running job keeps its state although its price is zero.
func TestWorkItemsShowNothingToBill(t *testing.T) {
	w := newWorkItemFixture(t)
	ctx := t.Context()
	waive := func(job MachineJob) MachineJob {
		t.Helper()
		job, err := w.s.GetJob(ctx, w.p, job.ID)
		if err != nil {
			t.Fatal(err)
		}
		job, err = w.s.SetJobPriceAdjustment(ctx, w.p, job.ID, job.Version, AdjustmentFixed, "0", "Waived", &w.request)
		if err != nil {
			t.Fatal(err)
		}
		return job
	}
	waived := waive(w.recorded)
	if !waived.NothingToBill() || slices.ContainsFunc(waived.Attention, func(a Attention) bool { return a.Code == AttentionNotOnOrder }) {
		t.Fatalf("waived job: nothingToBill %v, attention %+v", waived.NothingToBill(), waived.Attention)
	}
	running := waive(w.running)
	if running.NothingToBill() {
		t.Fatalf("a running job is never nothing to bill: %+v", running)
	}

	items, _ := w.list(t, WorkItemFilters{})
	for _, item := range items {
		switch item.ID {
		case w.recorded.ID:
			if item.Billing == nil || item.Billing.State != BillingNothingToBill {
				t.Fatalf("waived billing = %+v", item.Billing)
			}
			if slices.ContainsFunc(item.Attention, func(a Attention) bool { return a.Code == AttentionNotOnOrder }) {
				t.Fatalf("waived job flagged as not on an order: %+v", item.Attention)
			}
		case w.running.ID:
			if item.Billing != nil && item.Billing.State == BillingNothingToBill {
				t.Fatalf("running job billing = %+v", item.Billing)
			}
		}
	}
	only := func(label string, filters WorkItemFilters, want bool) {
		t.Helper()
		items, _ := w.list(t, filters)
		if slices.Contains(idsOf(items), w.recorded.ID) != want {
			t.Fatalf("%s: waived job listed = %v", label, !want)
		}
	}
	only("not billed", WorkItemFilters{Billing: []BillingState{BillingNotOnOrder}}, false)
	only("nothing to bill", WorkItemFilters{Billing: []BillingState{BillingNothingToBill}}, true)
	nothing, total := w.list(t, WorkItemFilters{Billing: []BillingState{BillingNothingToBill}})
	if total != 1 || len(nothing) != 1 {
		t.Fatalf("only the waived job has nothing to bill: %d %+v", total, idsOf(nothing))
	}

	own := w.p
	own.PersonID = w.person
	recent, err := w.s.OwnRecentJobs(ctx, own)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, job := range recent {
		if job.ID == w.recorded.ID {
			found = true
			if job.Billing == nil || *job.Billing != BillingNothingToBill {
				t.Fatalf("own recent billing = %v", job.Billing)
			}
		}
	}
	if !found {
		t.Fatal("the waived job is among the recipient's recent jobs")
	}
	unbilled, err := w.s.OwnUnbilledJobs(ctx, own)
	if err != nil {
		t.Fatal(err)
	}
	if slices.ContainsFunc(unbilled, func(job OwnUnbilledJob) bool { return job.ID == w.recorded.ID }) {
		t.Fatal("a job with nothing to bill is not owed")
	}
}
