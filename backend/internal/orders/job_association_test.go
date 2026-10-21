package orders

import (
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/google/uuid"
)

func TestJobAssociationReturnsTheChargingOrderItem(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	start := time.Now().UTC().Add(-time.Hour)
	job, err := f.jobs.CreateManualJob(
		ctx,
		f.p,
		machinelogbook.JobInput{
			MachineID:        f.machine,
			StartsAt:         start,
			EndsAt:           start.Add(time.Hour),
			Customer:         machinelogbook.PartyReference{Kind: "organization", ID: f.organization},
			OperatorPersonID: f.person,
			Outcome:          "successful",
		},
		&f.request,
	)
	if err != nil {
		t.Fatal(err)
	}
	free, err := f.s.JobAssociation(ctx, f.p, job.ID)
	if err != nil || free.OrderID != nil || free.OrderItemID != nil {
		t.Fatalf("job outside any order: %v %+v", err, free)
	}
	draft, err := f.s.Create(
		ctx,
		f.p,
		OrderDraftInput{Customer: &OrderCustomer{Kind: "person", ID: f.person}, FulfillmentMode: "immediate"},
		&f.request,
	)
	if err != nil {
		t.Fatal(err)
	}
	order, err := f.s.ChangeItem(
		ctx,
		f.p,
		draft.ID,
		uuid.Nil,
		OrderItemInput{
			Kind:               "machine_job",
			MachineJobID:       job.ID,
			ExpectedJobVersion: job.Version,
			ExpectedVersion:    draft.Version,
		},
		"add",
		&f.request,
	)
	if err != nil || len(order.Items) != 1 {
		t.Fatalf("add item: %v %+v", err, order)
	}
	charged, err := f.s.JobAssociation(ctx, f.p, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if charged.OrderID == nil || *charged.OrderID != order.ID || charged.OrderItemID == nil ||
		*charged.OrderItemID != order.Items[0].ID || charged.SourceChanged {
		t.Fatalf("association: %+v, item %s", charged, order.Items[0].ID)
	}
}
