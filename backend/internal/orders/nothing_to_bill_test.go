package orders

import (
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

func (f *fixture) endedJob(t *testing.T) machinelogbook.MachineJob {
	t.Helper()
	start := time.Now().UTC().Add(-2 * time.Hour)
	job, err := f.jobs.CreateManualJob(
		t.Context(),
		f.p,
		machinelogbook.JobInput{
			MachineID:        f.machine,
			StartsAt:         start,
			EndsAt:           start.Add(time.Hour),
			Customer:         machinelogbook.PartyReference{Kind: "person", ID: f.person},
			OperatorPersonID: f.person,
			Outcome:          "successful",
		},
		&f.request,
	)
	if err != nil {
		t.Fatal(err)
	}
	return job
}

func (f *fixture) waive(t *testing.T, job machinelogbook.MachineJob) machinelogbook.MachineJob {
	t.Helper()
	waived, err := f.jobs.SetJobPriceAdjustment(
		t.Context(), f.p, job.ID, job.Version, machinelogbook.AdjustmentFixed, "0", "Waived", &f.request,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !waived.NothingToBill() {
		t.Fatalf("a waived ended job has nothing to bill: %+v", waived)
	}
	return waived
}

func (f *fixture) draftFor(t *testing.T, customer *OrderCustomer) Order {
	t.Helper()
	draft, err := f.s.Create(t.Context(), f.p, OrderDraftInput{Customer: customer}, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	return draft
}

func TestOrderRefusesJobWithNothingToBill(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	job := f.waive(t, f.endedJob(t))
	draft := f.draftFor(t, &OrderCustomer{Kind: "person", ID: f.person})
	_, err := f.s.ChangeItem(ctx, f.p, draft.ID, uuid.Nil, OrderItemInput{
		Kind: ItemMachineJob, MachineJobID: job.ID, ExpectedJobVersion: job.Version, ExpectedVersion: draft.Version,
	}, ItemActionAdd, &f.request)
	if !apperror.IsCode(err, "nothing_to_bill") {
		t.Fatalf("adding a job with nothing to bill: %v", err)
	}
	association, err := f.s.JobAssociation(ctx, f.p, job.ID)
	if err != nil || association.OrderID != nil {
		t.Fatalf("the refused job is not claimed: %v %+v", err, association)
	}
	again, err := f.s.Get(ctx, f.p, draft.ID)
	if err != nil || len(again.Items) != 0 || again.Version != draft.Version {
		t.Fatalf("the draft is unchanged: %v %+v", err, again)
	}
}

func TestOrderRefusesRefreshOfJobThatDroppedToNothing(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	job := f.endedJob(t)
	if job.NothingToBill() {
		t.Fatalf("a priced job has something to bill: %+v", job)
	}
	draft := f.draftFor(t, &OrderCustomer{Kind: "person", ID: f.person})
	order, err := f.s.ChangeItem(ctx, f.p, draft.ID, uuid.Nil, OrderItemInput{
		Kind: ItemMachineJob, MachineJobID: job.ID, ExpectedJobVersion: job.Version, ExpectedVersion: draft.Version,
	}, ItemActionAdd, &f.request)
	if err != nil || len(order.Items) != 1 {
		t.Fatalf("add priced job: %v %+v", err, order)
	}
	f.waive(t, job)
	_, err = f.s.ChangeItem(ctx, f.p, order.ID, order.Items[0].ID, OrderItemInput{ExpectedVersion: order.Version},
		ItemActionRefresh, &f.request)
	if !apperror.IsCode(err, "nothing_to_bill") {
		t.Fatalf("refreshing a job that dropped to 0: %v", err)
	}
	kept, err := f.s.Get(ctx, f.p, order.ID)
	if err != nil || len(kept.Items) != 1 || kept.Version != order.Version {
		t.Fatalf("the refused refresh rolls back: %v %+v", err, kept)
	}
	removed, err := f.s.ChangeItem(ctx, f.p, order.ID, order.Items[0].ID, OrderItemInput{ExpectedVersion: order.Version},
		ItemActionRemove, &f.request)
	if err != nil || removed.TotalAmount != "0.00" {
		t.Fatalf("the job can still be removed: %v %+v", err, removed)
	}
}

func TestListOrdersFiltersByCustomerAndSearchesDraftCustomers(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	personDraft := f.draftFor(t, &OrderCustomer{Kind: "person", ID: f.person})
	orgDraft := f.draftFor(t, &OrderCustomer{Kind: "organization", ID: f.organization})
	f.draftFor(t, nil)
	page, err := f.s.List(ctx, f.p, "", "draft", &f.person, 1, 100)
	if err != nil || page.Total != 1 || len(page.Items) != 1 || page.Items[0].ID != personDraft.ID {
		t.Fatalf("drafts of the person: %v %+v", err, page)
	}
	page, err = f.s.List(ctx, f.p, "", "draft", &f.organization, 1, 100)
	if err != nil || page.Total != 1 || page.Items[0].ID != orgDraft.ID {
		t.Fatalf("drafts of the organization: %v %+v", err, page)
	}
	// A draft has no captured customer name yet; the current name is searched.
	page, err = f.s.List(ctx, f.p, "financial oper", "draft", nil, 1, 100)
	if err != nil || page.Total != 1 || page.Items[0].ID != personDraft.ID {
		t.Fatalf("search by the draft customer's name: %v %+v", err, page)
	}
	other := uuid.Must(uuid.NewV7())
	page, err = f.s.List(ctx, f.p, "", "", &other, 1, 100)
	if err != nil || page.Total != 0 || len(page.Items) != 0 {
		t.Fatalf("an unknown customer has no orders: %v %+v", err, page)
	}
}

func TestListOrdersByCustomerRequiresOrdersRead(t *testing.T) {
	f := newFixture(t)
	f.draftFor(t, &OrderCustomer{Kind: "person", ID: f.person})
	denied := authorization.Principal{AccountID: f.p.AccountID, PersonID: f.person}
	_, err := f.s.List(t.Context(), denied, "", "draft", &f.person, 1, 100)
	if !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("listing orders of a customer without orders.read: %v", err)
	}
}
