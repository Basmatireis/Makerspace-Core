package orders

import (
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
)

func ownPayment(total string, orders []uuid.UUID, jobs []uuid.UUID, payments ...PaymentInput) OwnPaymentInput {
	return OwnPaymentInput{
		OperationKey:  ids.New(),
		OrderIDs:      orders,
		JobIDs:        jobs,
		Payments:      payments,
		ExpectedTotal: total,
	}
}

func TestPayOwnSettlesOrdersAndJobsInOneTransaction(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	member := f.principal(t, memberPermissions...)
	first := f.personOrder(t, member.PersonID, "12.50")
	partly := f.pay(t, f.personOrder(t, member.PersonID, "5"), "cash", "2")
	jobA := f.personJob(t, member.PersonID, f.person, uuid.Nil, "", "successful", 30)
	jobB := f.personJob(t, member.PersonID, f.person, uuid.Nil, "", "failed", 20)

	balanceOrders, e := f.s.OwnPayableOrders(ctx, member)
	if e != nil {
		t.Fatal(e)
	}
	unbilled, e := f.jobs.OwnUnbilledJobs(ctx, member)
	if e != nil {
		t.Fatal(e)
	}
	if len(balanceOrders) != 2 || len(unbilled) != 2 || unbilled[0].Price.StringFixed(2) != "10.00" {
		t.Fatalf("balance before = %+v / %+v", balanceOrders, unbilled)
	}

	// 12.50 + 3.00 + 2 × 10.00 = 35.50: 8.00 cash, the rest on one card slip that spans two orders.
	card := receipt("card", "27.50")
	input := ownPayment(
		"35.50",
		[]uuid.UUID{partly.ID, first.ID},
		[]uuid.UUID{jobB.ID, jobA.ID},
		receipt("cash", "8"),
		card,
	)
	result, e := f.s.PayOwn(ctx, member, input, nil)
	if e != nil {
		t.Fatal(e)
	}
	if result.Total != "35.50" || result.CreatedOrderID == nil || len(result.Orders) != 3 {
		t.Fatalf("result = %+v", result)
	}
	created, e := f.s.Get(ctx, f.p, *result.CreatedOrderID)
	if e != nil {
		t.Fatal(e)
	}
	if created.Status != OrderFinalized || created.Customer == nil || created.Customer.ID != member.PersonID ||
		len(created.Items) != 2 || created.TotalAmount != "20.00" || created.SettlementState != SettlementPaid {
		t.Fatalf("created order = %+v", created)
	}
	if created.CreatedBy == nil || created.CreatedBy.ID != member.PersonID {
		t.Fatalf("created by = %+v, want the paying person", created.CreatedBy)
	}
	for _, id := range []uuid.UUID{first.ID, partly.ID} {
		o, e := f.s.Get(ctx, f.p, id)
		if e != nil {
			t.Fatal(e)
		}
		if o.SettlementState != SettlementPaid || o.OutstandingAmount != "0.00" {
			t.Fatalf("order %s not paid in full: %+v", o.Reference, o)
		}
	}

	// Every receipt settles one order and is recorded by the paying person; the card slip is split into parts.
	var receipts, cardParts, byOthers int
	var cardTotal string
	if e = f.pool.QueryRow(
		ctx,
		`SELECT count(*), count(*) FILTER (WHERE method='card'), count(*) FILTER (WHERE actor_account_id<>$1),
		        COALESCE(sum(amount) FILTER (WHERE method='card'),0)::text
		 FROM payments WHERE id IN (SELECT payment_id FROM payment_allocations WHERE operation_id=$2)`,
		member.AccountID,
		input.OperationKey,
	).Scan(&receipts, &cardParts, &byOthers, &cardTotal); e != nil {
		t.Fatal(e)
	}
	if receipts < 3 || cardParts < 2 || byOthers != 0 || cardTotal != "27.50" {
		t.Fatalf("receipts=%d card parts=%d by others=%d card total=%s", receipts, cardParts, byOthers, cardTotal)
	}
	var audited int
	if e = f.pool.QueryRow(
		ctx,
		`SELECT count(*) FROM audit_events WHERE actor_account_id=$1 AND action IN ('order.created','order.finalized','payment.recorded')`,
		member.AccountID,
	).Scan(&audited); e != nil {
		t.Fatal(e)
	}
	if audited != 2+receipts {
		t.Fatalf("audit events = %d, want order.created, order.finalized and one payment.recorded per receipt", audited)
	}

	// Nothing is left to pay, and a retry returns the recorded result without paying twice.
	balanceOrders, _ = f.s.OwnPayableOrders(ctx, member)
	unbilled, _ = f.jobs.OwnUnbilledJobs(ctx, member)
	if len(balanceOrders) != 0 || len(unbilled) != 0 {
		t.Fatalf("balance after = %+v / %+v", balanceOrders, unbilled)
	}
	retry, e := f.s.PayOwn(ctx, member, input, nil)
	if e != nil || retry.Total != "35.50" || retry.CreatedOrderID == nil || *retry.CreatedOrderID != *result.CreatedOrderID ||
		len(retry.Orders) != 3 {
		t.Fatalf("retry = %+v, %v", retry, e)
	}

	// The same card slip cannot be recorded again.
	again := f.personOrder(t, member.PersonID, "4")
	if _, e = f.s.PayOwn(ctx, member, ownPayment("4.00", []uuid.UUID{again.ID}, nil, PaymentInput{
		Method: "card", Amount: "4", OccurredAt: time.Now(), ExternalSource: card.ExternalSource,
		ExternalReference: card.ExternalReference,
	}), nil); !apperror.IsCode(e, "already_exists") {
		t.Fatalf("reused card slip: %v", e)
	}
}

func TestPayOwnPaysOnlyTheSelection(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	member := f.principal(t, memberPermissions...)
	paid := f.personOrder(t, member.PersonID, "7")
	kept := f.personOrder(t, member.PersonID, "3")
	job := f.personJob(t, member.PersonID, f.person, uuid.Nil, "", "successful", 5)

	result, e := f.s.PayOwn(ctx, member, ownPayment("7.00", []uuid.UUID{paid.ID}, nil, receipt("cash", "7")), nil)
	if e != nil {
		t.Fatal(e)
	}
	if result.CreatedOrderID != nil || len(result.Orders) != 1 || result.Orders[0].OrderID != paid.ID {
		t.Fatalf("result = %+v", result)
	}
	left, _ := f.s.OwnPayableOrders(ctx, member)
	jobs, _ := f.jobs.OwnUnbilledJobs(ctx, member)
	if len(left) != 1 || left[0].ID != kept.ID || len(jobs) != 1 || jobs[0].ID != job.ID {
		t.Fatalf("left = %+v / %+v", left, jobs)
	}

	// Paying only the job puts it on an order; orders alone need no order-writing permission.
	payer := f.principal(t, authorization.OrdersRead, authorization.PaymentsRead, authorization.PaymentsRecord)
	payerOrder := f.personOrder(t, payer.PersonID, "2")
	if _, e = f.s.PayOwn(ctx, payer, ownPayment("2.00", []uuid.UUID{payerOrder.ID}, nil, receipt("cash", "2")), nil); e != nil {
		t.Fatalf("paying an own order without order permissions: %v", e)
	}
	payerJob := f.personJob(t, payer.PersonID, f.person, uuid.Nil, "", "successful", 3)
	if _, e = f.s.PayOwn(ctx, payer, ownPayment("10.00", nil, []uuid.UUID{payerJob.ID}, receipt("cash", "10")), nil); !apperror.IsCode(
		e,
		"permission_denied",
	) {
		t.Fatalf("jobs without orders.write/finalize: %v", e)
	}
	jobOnly, e := f.s.PayOwn(ctx, member, ownPayment("10.00", nil, []uuid.UUID{job.ID}, receipt("cash", "10")), nil)
	if e != nil || jobOnly.CreatedOrderID == nil || len(jobOnly.Orders) != 1 {
		t.Fatalf("job only = %+v, %v", jobOnly, e)
	}
}

func TestPayOwnRefusesWhatIsNotTheCallersToPay(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	member := f.principal(t, memberPermissions...)
	other := f.principal(t, memberPermissions...)
	own := f.personOrder(t, member.PersonID, "5")
	othersOrder := f.personOrder(t, other.PersonID, "5")
	othersJob := f.personJob(t, other.PersonID, member.PersonID, uuid.Nil, "", "successful", 4)
	ownJob := f.personJob(t, member.PersonID, f.person, uuid.Nil, "", "successful", 3)
	invoiced := f.personOrder(t, member.PersonID, "6")
	f.newRequest(t, f.actors(t).staff, invoiced)
	paidOff := f.pay(t, f.personOrder(t, member.PersonID, "1"), "cash", "1")
	onOrder := f.personJob(t, member.PersonID, f.person, uuid.Nil, "", "successful", 2)
	draft, e := f.s.Create(ctx, f.p, OrderDraftInput{
		Customer:        &OrderCustomer{Kind: CustomerPerson, ID: member.PersonID},
		FulfillmentMode: "deferred",
	}, nil)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.s.ChangeItem(ctx, f.p, draft.ID, uuid.Nil, OrderItemInput{
		Kind: ItemMachineJob, MachineJobID: onOrder.ID, ExpectedJobVersion: onOrder.Version, ExpectedVersion: draft.Version,
	}, "add", nil); e != nil {
		t.Fatal(e)
	}

	cases := map[string]struct {
		input OwnPaymentInput
		code  string
	}{
		"another person's order": {ownPayment("10.00", []uuid.UUID{own.ID, othersOrder.ID}, nil, receipt("cash", "10")), "order_not_payable"},
		"unknown order":          {ownPayment("5.00", []uuid.UUID{ids.New()}, nil, receipt("cash", "5")), "order_not_payable"},
		"invoiced order":         {ownPayment("6.00", []uuid.UUID{invoiced.ID}, nil, receipt("cash", "6")), "order_not_payable"},
		"paid order":             {ownPayment("1.00", []uuid.UUID{paidOff.ID}, nil, receipt("cash", "1")), "order_not_payable"},
		"another person's job":   {ownPayment("15.00", []uuid.UUID{own.ID}, []uuid.UUID{othersJob.ID}, receipt("cash", "15")), "job_not_payable"},
		"job already on order":   {ownPayment("10.00", nil, []uuid.UUID{onOrder.ID}, receipt("cash", "10")), "job_not_payable"},
		"stale total":            {ownPayment("14.00", []uuid.UUID{own.ID}, []uuid.UUID{ownJob.ID}, receipt("cash", "14")), "payment_total_changed"},
		"payments short":         {ownPayment("15.00", []uuid.UUID{own.ID}, []uuid.UUID{ownJob.ID}, receipt("cash", "14")), "payment_total_mismatch"},
		"payments over":          {ownPayment("5.00", []uuid.UUID{own.ID}, nil, receipt("cash", "4"), receipt("cash", "2")), "payment_total_mismatch"},
		"external payment":       {ownPayment("5.00", []uuid.UUID{own.ID}, nil, receipt("external", "5")), "validation_failed"},
		"nothing selected":       {ownPayment("5.00", nil, nil, receipt("cash", "5")), "validation_failed"},
		"repeated order":         {ownPayment("10.00", []uuid.UUID{own.ID, own.ID}, nil, receipt("cash", "10")), "validation_failed"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			if _, e := f.s.PayOwn(ctx, member, c.input, nil); !apperror.IsCode(e, c.code) {
				t.Fatalf("got %v, want %s", e, c.code)
			}
		})
	}
	// Failed attempts left nothing behind: the own order and job are still open, the other person's too.
	left, _ := f.s.OwnPayableOrders(ctx, member)
	jobs, _ := f.jobs.OwnUnbilledJobs(ctx, member)
	othersLeft, _ := f.s.OwnPayableOrders(ctx, other)
	if len(left) != 1 || left[0].ID != own.ID || len(jobs) != 1 || jobs[0].ID != ownJob.ID || len(othersLeft) != 1 {
		t.Fatalf("after refusals: own=%+v jobs=%+v others=%+v", left, jobs, othersLeft)
	}
	var count int
	if e = f.pool.QueryRow(ctx, `SELECT count(*) FROM payments WHERE actor_account_id=$1`, member.AccountID).Scan(&count); e != nil || count != 0 {
		t.Fatalf("refused payments recorded %d receipts: %v", count, e)
	}

	withoutRecord := f.principal(t, authorization.OrdersRead, authorization.PaymentsRead)
	if _, e = f.s.PayOwn(ctx, withoutRecord, ownPayment("5.00", []uuid.UUID{own.ID}, nil, receipt("cash", "5")), nil); !apperror.IsCode(
		e,
		"permission_denied",
	) {
		t.Fatalf("payment without payments.record: %v", e)
	}
}
