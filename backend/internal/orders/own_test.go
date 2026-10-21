package orders

import (
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

var memberPermissions = []authorization.Permission{
	authorization.OrdersRead,
	authorization.OrdersWrite,
	authorization.OrdersFinalize,
	authorization.PaymentsRead,
	authorization.PaymentsRecord,
	authorization.MachineJobsRead,
}

// personOrder finalizes an order of one manual item for the given person, recorded by the operator.
func (f *fixture) personOrder(t *testing.T, person uuid.UUID, amount string) Order {
	t.Helper()
	ctx := t.Context()
	o, e := f.s.Create(
		ctx,
		f.p,
		OrderDraftInput{Customer: &OrderCustomer{Kind: CustomerPerson, ID: person}, FulfillmentMode: "deferred"},
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
			Kind:            "manual",
			Description:     "Workshop fee",
			Quantity:        "1",
			Unit:            "service",
			UnitPrice:       amount,
			ExpectedVersion: o.Version,
		},
		"add",
		nil,
	)
	if e != nil {
		t.Fatal(e)
	}
	o, e = f.s.Command(ctx, f.p, o.ID, cmd(o), "finalize", nil)
	if e != nil {
		t.Fatal(e)
	}
	return o
}

// personJob records an ended one-hour job for the customer, run by the operator; the fixture's runtime rule
// prices it at 10.00.
func (f *fixture) personJob(
	t *testing.T,
	customer, operator uuid.UUID,
	material uuid.UUID,
	grams string,
	outcome machinelogbook.JobOutcome,
	hoursAgo int,
) machinelogbook.MachineJob {
	t.Helper()
	start := time.Now().UTC().Add(-time.Duration(hoursAgo) * time.Hour).Truncate(time.Second)
	input := machinelogbook.JobInput{
		MachineID:        f.machine,
		StartsAt:         start,
		EndsAt:           start.Add(time.Hour),
		Customer:         machinelogbook.PartyReference{Kind: "person", ID: customer},
		OperatorPersonID: operator,
		Outcome:          outcome,
	}
	if material != uuid.Nil {
		input.Usages = []machinelogbook.UsageInput{{MaterialID: material, Quantity: grams}}
	}
	job, e := f.jobs.CreateManualJob(t.Context(), f.p, input, nil)
	if e != nil {
		t.Fatal(e)
	}
	return job
}

func TestOwnOrdersAndJobsAreScopedToTheCaller(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	member := f.principal(t, memberPermissions...)
	other := f.principal(t, memberPermissions...)
	material := f.stockedMaterial(t, "PLA statistics")
	f.personOrder(t, other.PersonID, "9")
	invoiced := f.personOrder(t, member.PersonID, "6")
	f.newRequest(t, f.actors(t).staff, invoiced)
	f.pay(t, f.personOrder(t, member.PersonID, "1"), "cash", "1")
	f.personJob(t, member.PersonID, f.person, material, "40", "successful", 50)
	f.personJob(t, member.PersonID, f.person, material, "25.5", "failed", 40)
	f.personJob(t, other.PersonID, member.PersonID, material, "100", "successful", 1) // run for someone else

	unpaid, e := f.s.OwnPayableOrders(ctx, member)
	if e != nil || len(unpaid) != 0 {
		t.Fatalf("unpaid = %+v, %v (invoiced and paid orders do not count)", unpaid, e)
	}
	recent, e := f.s.OwnRecentOrders(ctx, member)
	if e != nil || len(recent) != 2 {
		t.Fatalf("recent orders = %+v, %v", recent, e)
	}
	for _, o := range recent {
		if o.Payable || (o.ID == invoiced.ID) != o.Invoiced || o.ItemSummary != "Workshop fee" || o.ItemCount != 1 {
			t.Fatalf("recent order = %+v", o)
		}
	}

	jobs, e := f.jobs.OwnRecentJobs(ctx, member)
	if e != nil || len(jobs) != 3 {
		t.Fatalf("recent jobs = %+v, %v", jobs, e)
	}
	if jobs[0].Own || jobs[0].Billing != nil || jobs[0].OrderReference != nil || jobs[0].Status != "successful" {
		t.Fatalf("job run for someone else = %+v, want no billing details", jobs[0])
	}
	if !jobs[1].Own || jobs[1].Billing == nil || *jobs[1].Billing != machinelogbook.BillingNotOnOrder ||
		jobs[1].Price == nil || *jobs[1].Price != "12.55" {
		t.Fatalf("own job = %+v", jobs[1])
	}

	statistics, e := f.jobs.OwnStatistics(ctx, member)
	if e != nil {
		t.Fatal(e)
	}
	if statistics.Jobs != 2 || statistics.SuccessfulJobs != 1 || statistics.FinishedJobs != 2 ||
		statistics.SuccessRate == nil || *statistics.SuccessRate != 50 || statistics.MaterialGrams != 65.5 ||
		statistics.MachineSeconds != 7200 || statistics.FavouriteMachine == nil ||
		statistics.FavouriteMachine.Name != "Printer 1" || statistics.FavouriteMachine.Jobs != 2 ||
		len(statistics.JobsPerMonth) != machinelogbook.OwnStatisticsMonths {
		t.Fatalf("statistics = %+v", statistics)
	}
	sum := 0
	for _, month := range statistics.JobsPerMonth {
		sum += month.Jobs
	}
	if sum != 2 || statistics.JobsPerMonth[len(statistics.JobsPerMonth)-1].Month != time.Now().UTC().Format("2006-01") {
		t.Fatalf("jobs per month = %+v", statistics.JobsPerMonth)
	}

	empty := f.principal(t, memberPermissions...)
	none, e := f.jobs.OwnStatistics(ctx, empty)
	if e != nil || none.Jobs != 0 || none.SuccessRate != nil || none.FavouriteMachine != nil || len(none.JobsPerMonth) != 12 {
		t.Fatalf("empty statistics = %+v, %v", none, e)
	}

	reader := f.principal(t, authorization.PaymentsRead)
	if _, e = f.s.OwnPayableOrders(ctx, reader); !apperror.IsCode(e, "permission_denied") {
		t.Fatalf("own orders without orders.read: %v", e)
	}
	if _, e = f.jobs.OwnUnbilledJobs(ctx, reader); !apperror.IsCode(e, "permission_denied") {
		t.Fatalf("unbilled jobs without orders.read: %v", e)
	}
	if _, e = f.jobs.OwnRecentJobs(ctx, reader); !apperror.IsCode(e, "permission_denied") {
		t.Fatalf("recent jobs without machine_jobs.read: %v", e)
	}
	if _, e = f.jobs.OwnStatistics(ctx, reader); !apperror.IsCode(e, "permission_denied") {
		t.Fatalf("statistics without machine_jobs.read: %v", e)
	}
}
