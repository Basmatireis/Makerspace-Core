package orders

import (
	stdcontext "context"
	"sync"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

func completeDetails() InvoiceRequestDetails {
	return InvoiceRequestDetails{RecipientName: "Billing recipient", AddressLine1: "Street 1", PostalCode: "8010", Locality: "Graz", CountryCode: "AT", ContactName: "Contact", ServiceStartsOn: "2026-10-01", ServiceEndsOn: "2026-10-06", ServiceDescription: "Machine service"}
}

type invoiceActors struct{ staff, approver, finance authorization.Principal }

func (f *fixture) actors(t *testing.T) invoiceActors {
	base := []authorization.Permission{authorization.OrdersRead, authorization.ExternalInvoiceRequestsRead}
	return invoiceActors{
		staff:    f.principal(t, append(base, authorization.ExternalInvoiceRequestsManage)...),
		approver: f.principal(t, append(base, authorization.ExternalInvoiceRequestsApprove)...),
		finance:  f.principal(t, append(base, authorization.ExternalInvoiceRequestsManage, authorization.PaymentsRead, authorization.PaymentsReverse)...),
	}
}

func (f *fixture) finalized(t *testing.T, amount string) Order {
	t.Helper()
	o := f.draft(t, true, amount)
	o, e := f.s.Command(t.Context(), f.p, o.ID, cmd(o), "finalize", nil)
	if e != nil {
		t.Fatal(e)
	}
	return o
}

func (f *fixture) pay(t *testing.T, o Order, method, amount string) Order {
	t.Helper()
	o, e := f.s.RecordPayment(t.Context(), f.p, o.ID, RecordOrderPayment{OperationKey: newID(), ExpectedVersion: o.Version, Payment: receipt(method, amount)}, nil)
	if e != nil {
		t.Fatal(e)
	}
	return o
}

func (f *fixture) newRequest(t *testing.T, who authorization.Principal, o Order) ExternalInvoiceRequest {
	t.Helper()
	r, e := f.s.CreateRequest(t.Context(), who, o.ID, CreateInvoiceRequest{OperationKey: newID(), ExpectedVersion: o.Version, Details: completeDetails()}, nil)
	if e != nil {
		t.Fatal(e)
	}
	return r
}

func (f *fixture) act(who authorization.Principal, r ExternalInvoiceRequest, action string, mod func(*InvoiceRequestCommand)) (ExternalInvoiceRequest, error) {
	c := InvoiceRequestCommand{OperationKey: newID(), ExpectedVersion: r.Version}
	if mod != nil {
		mod(&c)
	}
	return f.s.RequestCommand(stdcontext.Background(), who, r.ID, c, action, nil)
}

func (f *fixture) ok(t *testing.T, who authorization.Principal, r ExternalInvoiceRequest, action string, mod func(*InvoiceRequestCommand)) ExternalInvoiceRequest {
	t.Helper()
	v, e := f.act(who, r, action, mod)
	if e != nil {
		t.Fatalf("%s: %v", action, e)
	}
	return v
}

func denied(t *testing.T, e error) {
	t.Helper()
	if !apperror.IsCode(e, "permission_denied") {
		t.Fatalf("expected permission_denied: %v", e)
	}
}

func wantCode(t *testing.T, e error, code string) {
	t.Helper()
	if !apperror.IsCode(e, code) {
		t.Fatalf("expected %s: %v", code, e)
	}
}

func TestInvoiceApprovalWorkflowAndSettlement(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	a := f.actors(t)
	o := f.finalized(t, "10")
	r := f.newRequest(t, a.staff, o)
	if r.State != "draft" || r.AlreadyPaid != "0.00" {
		t.Fatalf("new request %+v", r)
	}
	// Only staff with manage edit a draft; approvers do not.
	_, e := f.s.UpdateRequest(ctx, a.approver, r.ID, UpdateInvoiceRequest{ExpectedVersion: r.Version, Details: completeDetails()}, nil)
	denied(t, e)
	// An incomplete checklist cannot be submitted.
	incomplete := completeDetails()
	incomplete.AddressLine1 = ""
	r, e = f.s.UpdateRequest(ctx, a.staff, r.ID, UpdateInvoiceRequest{ExpectedVersion: r.Version, Details: incomplete}, nil)
	if e != nil {
		t.Fatal(e)
	}
	_, e = f.act(a.staff, r, "submit", nil)
	wantCode(t, e, "validation_failed")
	r, e = f.s.UpdateRequest(ctx, a.staff, r.ID, UpdateInvoiceRequest{ExpectedVersion: r.Version, Details: completeDetails()}, nil)
	if e != nil {
		t.Fatal(e)
	}
	// Approver cannot submit, staff cannot approve.
	_, e = f.act(a.approver, r, "submit", nil)
	denied(t, e)
	r = f.ok(t, a.staff, r, "submit", nil)
	if r.State != "submitted" {
		t.Fatal(r.State)
	}
	// While awaiting approval only approvers edit.
	_, e = f.s.UpdateRequest(ctx, a.staff, r.ID, UpdateInvoiceRequest{ExpectedVersion: r.Version, Details: completeDetails()}, nil)
	denied(t, e)
	edited := completeDetails()
	edited.ServiceDescription = "Edited by approver"
	r, e = f.s.UpdateRequest(ctx, a.approver, r.ID, UpdateInvoiceRequest{ExpectedVersion: r.Version, Details: edited}, nil)
	if e != nil || r.Details.ServiceDescription != "Edited by approver" || r.State != "submitted" {
		t.Fatalf("approver edit %v %+v", e, r)
	}
	for _, action := range []string{"return", "forward"} {
		_, e = f.act(a.staff, r, action, func(c *InvoiceRequestCommand) { c.Reason = "x" })
		denied(t, e)
	}
	_, e = f.act(a.staff, r, "cancel", nil)
	denied(t, e)
	// Return needs a comment and shows it as an event.
	_, e = f.act(a.approver, r, "return", nil)
	wantCode(t, e, "validation_failed")
	r = f.ok(t, a.approver, r, "return", func(c *InvoiceRequestCommand) { c.Reason = "Add the purchase order" })
	last := r.Events[len(r.Events)-1]
	if r.State != "draft" || last.Kind != "returned" || last.Reason != "Add the purchase order" || last.RecordedBy == nil {
		t.Fatalf("return %+v", r)
	}
	r, e = f.s.UpdateRequest(ctx, a.staff, r.ID, UpdateInvoiceRequest{ExpectedVersion: r.Version, Details: completeDetails()}, nil)
	if e != nil {
		t.Fatal(e)
	}
	r = f.ok(t, a.staff, r, "submit", nil)
	// Forwarding issues the request and settles the open balance with an external payment, in one transaction.
	forward := InvoiceRequestCommand{OperationKey: newID(), ExpectedVersion: r.Version}
	issued, e := f.s.RequestCommand(ctx, a.approver, r.ID, forward, "forward", nil)
	if e != nil || issued.State != "issued" {
		t.Fatalf("forward %v %+v", e, issued)
	}
	retry, e := f.s.RequestCommand(ctx, a.approver, r.ID, forward, "forward", nil)
	if e != nil || retry.Version != issued.Version {
		t.Fatalf("retry %v", e)
	}
	o, e = f.s.Get(ctx, f.p, o.ID)
	if e != nil || o.SettlementState != "paid" || o.OutstandingAmount != "0.00" || len(o.Allocations) != 1 {
		t.Fatalf("not settled %v %+v", e, o)
	}
	payment, e := f.s.GetPayment(ctx, f.p, *o.Allocations[0].PaymentID)
	if e != nil || payment.Method != "external" || payment.Amount != "10.00" || payment.ExternalSource != "wiRef" || payment.RecordedBy == nil || payment.RecordedBy.DisplayName == "" {
		t.Fatalf("settling payment %v %+v", e, payment)
	}
	if o.CreatedBy == nil || o.CreatedBy.DisplayName == "" {
		t.Fatal("createdBy missing")
	}
	// A hand-recorded external payment is refused; so is cash on an issued invoice.
	_, e = f.s.RecordPayment(ctx, f.p, o.ID, RecordOrderPayment{OperationKey: newID(), ExpectedVersion: o.Version, Payment: receipt("external", "1")}, nil)
	wantCode(t, e, "invoice_settles_balance")
	_, e = f.s.RecordPayment(ctx, f.p, o.ID, RecordOrderPayment{OperationKey: newID(), ExpectedVersion: o.Version, Payment: receipt("cash", "1")}, nil)
	wantCode(t, e, "invoice_amount_frozen")
	_, e = f.act(a.approver, issued, "forward", nil)
	wantCode(t, e, "invalid_request_transition")
	// The invoice number is optional: add it later, then a correction needs a reason.
	issued = f.ok(t, a.staff, issued, "reference-corrections", func(c *InvoiceRequestCommand) { c.ExternalReference = "RE-1"; c.EffectiveAt = time.Now() })
	if issued.Events[len(issued.Events)-1].Kind != "reference_added" {
		t.Fatalf("%+v", issued.Events)
	}
	_, e = f.act(a.staff, issued, "reference-corrections", func(c *InvoiceRequestCommand) { c.ExternalReference = "RE-2"; c.EffectiveAt = time.Now() })
	wantCode(t, e, "validation_failed")
	issued = f.ok(t, a.staff, issued, "reference-corrections", func(c *InvoiceRequestCommand) {
		c.ExternalReference = "RE-2"
		c.EffectiveAt = time.Now()
		c.Reason = "typo"
	})
	if issued.Events[len(issued.Events)-1].Kind != "reference_corrected" {
		t.Fatal(issued.Events)
	}
}

func TestForwardWithOptionalInvoiceNumberAndConcurrentForward(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	a := f.actors(t)
	o := f.finalized(t, "10")
	r := f.newRequest(t, a.staff, o)
	r = f.ok(t, a.staff, r, "submit", nil)
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := f.s.RequestCommand(ctx, a.approver, r.ID, InvoiceRequestCommand{OperationKey: newID(), ExpectedVersion: r.Version, ExternalReference: "RE-7", EffectiveAt: time.Now()}, "forward", nil)
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	ok := 0
	for err := range results {
		if err == nil {
			ok++
		} else if !apperror.IsCode(err, "stale_write") && !apperror.IsCode(err, "invalid_request_transition") {
			t.Fatal(err)
		}
	}
	if ok != 1 {
		t.Fatalf("forwarded %d times", ok)
	}
	var n int
	if e := f.pool.QueryRow(ctx, "SELECT count(*) FROM payments WHERE method='external'").Scan(&n); e != nil || n != 1 {
		t.Fatalf("settling payments = %d %v", n, e)
	}
	got, _ := f.s.GetRequest(ctx, f.p, r.ID)
	if got.Events[len(got.Events)-1].Kind != "reference_added" || got.Events[len(got.Events)-1].ExternalReference != "RE-7" {
		t.Fatalf("%+v", got.Events)
	}
}

func TestInvoiceForPartiallyPaidOrderFreezesPayments(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	a := f.actors(t)
	o := f.finalized(t, "10")
	o = f.pay(t, o, "cash", "4")
	r := f.newRequest(t, a.staff, o)
	if r.AlreadyPaid != "4.00" {
		t.Fatalf("alreadyPaid %s", r.AlreadyPaid)
	}
	// A draft follows cash and card.
	o, _ = f.s.Get(ctx, f.p, o.ID)
	o = f.pay(t, o, "card", "2")
	r, _ = f.s.GetRequest(ctx, f.p, r.ID)
	if r.AlreadyPaid != "6.00" {
		t.Fatalf("draft did not follow payments: %s", r.AlreadyPaid)
	}
	r = f.ok(t, a.staff, r, "submit", nil)
	if r.AlreadyPaid != "6.00" {
		t.Fatal(r.AlreadyPaid)
	}
	o, _ = f.s.Get(ctx, f.p, o.ID)
	_, e := f.s.RecordPayment(ctx, f.p, o.ID, RecordOrderPayment{OperationKey: newID(), ExpectedVersion: o.Version, Payment: receipt("cash", "1")}, nil)
	wantCode(t, e, "invoice_amount_frozen")
	cashID := *o.Allocations[0].PaymentID
	_, e = f.s.ReversePayment(ctx, f.p, cashID, ReversePaymentCommand{OperationKey: newID(), ExpectedVersion: o.Version, Reversal: PaymentReversalInput{PaymentID: cashID, ReasonKind: "refund", Reason: "r", OccurredAt: time.Now()}}, nil)
	wantCode(t, e, "invoice_amount_frozen")
	// Returned to the draft, payments are allowed again and the figure follows.
	r = f.ok(t, a.approver, r, "return", func(c *InvoiceRequestCommand) { c.Reason = "fix" })
	o, _ = f.s.Get(ctx, f.p, o.ID)
	o = f.pay(t, o, "cash", "1")
	r, _ = f.s.GetRequest(ctx, f.p, r.ID)
	if r.AlreadyPaid != "7.00" {
		t.Fatalf("after return %s", r.AlreadyPaid)
	}
	r = f.ok(t, a.staff, r, "submit", nil)
	r = f.ok(t, a.approver, r, "forward", nil)
	o, _ = f.s.Get(ctx, f.p, o.ID)
	if o.SettlementState != "paid" || o.SettledAmount != "10.00" {
		t.Fatalf("%+v", o)
	}
	var external string
	if e = f.pool.QueryRow(ctx, "SELECT amount::text FROM payments WHERE method='external'").Scan(&external); e != nil || external != "3.00" {
		t.Fatalf("settled only the rest: %s %v", external, e)
	}
	// A fully paid order can be invoiced; forwarding then adds no payment.
	paid := f.finalized(t, "5")
	paid = f.pay(t, paid, "cash", "5")
	pr := f.newRequest(t, a.staff, paid)
	pr = f.ok(t, a.staff, pr, "submit", nil)
	f.ok(t, a.approver, pr, "forward", nil)
	var n int
	_ = f.pool.QueryRow(ctx, "SELECT count(*) FROM payments WHERE method='external'").Scan(&n)
	if n != 1 {
		t.Fatalf("external payments %d", n)
	}
}

func TestInvoiceCancellationReversesSettlement(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	a := f.actors(t)
	o := f.finalized(t, "10")
	r := f.newRequest(t, a.staff, o)
	r = f.ok(t, a.staff, r, "submit", nil)
	// Awaiting approval: only approvers cancel, locally.
	other := f.finalized(t, "3")
	or := f.newRequest(t, a.staff, other)
	or = f.ok(t, a.staff, or, "submit", nil)
	_, e := f.act(a.staff, or, "cancel", nil)
	denied(t, e)
	or = f.ok(t, a.approver, or, "cancel", func(c *InvoiceRequestCommand) { c.Reason = "wrong order" })
	if or.State != "cancelled" {
		t.Fatal(or.State)
	}
	r = f.ok(t, a.approver, r, "forward", nil)
	_, e = f.act(a.staff, r, "cancel", nil)
	wantCode(t, e, "external_reconciliation_required")
	_, e = f.act(a.staff, r, "confirm-cancellation", func(c *InvoiceRequestCommand) {})
	wantCode(t, e, "invalid_request_transition")
	r = f.ok(t, a.staff, r, "request-cancellation", nil)
	confirm := func(c *InvoiceRequestCommand) {
		c.ExternalReference = "GS-1"
		c.ReconciliationKind = "credit_note"
		c.EffectiveAt = time.Now()
	}
	// The settling payment is reversed, which needs the payment reverse permission.
	_, e = f.act(a.approver, r, "confirm-cancellation", confirm)
	denied(t, e)
	noReverse := f.principal(t, authorization.OrdersRead, authorization.ExternalInvoiceRequestsRead, authorization.ExternalInvoiceRequestsManage)
	_, e = f.act(noReverse, r, "confirm-cancellation", confirm)
	denied(t, e)
	still, _ := f.s.GetRequest(ctx, f.p, r.ID)
	if still.State != "cancellation_requested" {
		t.Fatal("denied command changed state")
	}
	r = f.ok(t, a.finance, r, "confirm-cancellation", confirm)
	if r.State != "cancelled" {
		t.Fatal(r.State)
	}
	o, _ = f.s.Get(ctx, f.p, o.ID)
	if o.SettlementState != "unpaid" || o.OutstandingAmount != "10.00" {
		t.Fatalf("balance not reopened %+v", o)
	}
	journal, e := f.s.Reconciliation(ctx, f.p, "", nil, nil, 1, 100)
	if e != nil || journal.External != "0.00" {
		t.Fatalf("external net %v %+v", e, journal)
	}
	// Cash is possible again, the order can be reversed, and a new request can follow.
	o = f.pay(t, o, "cash", "10")
	if o.SettlementState != "paid" {
		t.Fatal(o.SettlementState)
	}
	next := f.newRequest(t, a.staff, o)
	if next.SupersedesRequestID == nil || *next.SupersedesRequestID != r.ID || next.AlreadyPaid != "10.00" {
		t.Fatalf("%+v", next)
	}
}

func TestInvoiceRequestNeedsACharge(t *testing.T) {
	f := newFixture(t)
	a := f.actors(t)
	o := f.finalized(t, "0")
	_, e := f.s.CreateRequest(t.Context(), a.staff, o.ID, CreateInvoiceRequest{OperationKey: newID(), ExpectedVersion: o.Version, Details: completeDetails()}, nil)
	wantCode(t, e, "nothing_to_invoice")
}

func (f *fixture) cashMove(who authorization.Principal, kind, amount, reason, note string, at time.Time) (CashMovement, error) {
	return f.s.CreateCashMovement(stdcontext.Background(), who, CashMovementInput{OperationKey: newID(), Kind: kind, Amount: amount, Reason: reason, Note: note, OccurredAt: at}, nil)
}

func TestCashRegisterCountsOnlyCash(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	a := f.actors(t)
	register := func() CashRegister {
		t.Helper()
		v, e := f.s.CashRegister(ctx, f.p, nil)
		if e != nil {
			t.Fatal(e)
		}
		return v
	}
	if r := register(); r.Expected != "0.00" {
		t.Fatalf("%+v", r)
	}
	o := f.finalized(t, "100")
	o = f.pay(t, o, "cash", "30")
	o = f.pay(t, o, "card", "20")
	if r := register(); r.Receipts != "30.00" || r.Expected != "30.00" {
		t.Fatalf("card counted: %+v", r)
	}
	// An external invoice settlement and its reversal never touch the register.
	req := f.newRequest(t, a.staff, o)
	req = f.ok(t, a.staff, req, "submit", nil)
	req = f.ok(t, a.approver, req, "forward", nil)
	if r := register(); r.Expected != "30.00" {
		t.Fatalf("external counted: %+v", r)
	}
	req = f.ok(t, a.staff, req, "request-cancellation", nil)
	f.ok(t, a.finance, req, "confirm-cancellation", func(c *InvoiceRequestCommand) {
		c.ExternalReference = "GS"
		c.ReconciliationKind = "cancellation"
		c.EffectiveAt = time.Now()
	})
	if r := register(); r.Expected != "30.00" || r.Refunds != "0.00" {
		t.Fatalf("external reversal counted: %+v", r)
	}
	// Card refunds do not either; cash refunds do.
	o, _ = f.s.Get(ctx, f.p, o.ID)
	var cardID, cashID uuid.UUID
	for _, al := range o.Allocations {
		p, _ := f.s.GetPayment(ctx, f.p, *al.PaymentID)
		if p.Method == "card" && p.EntryKind == "receipt" {
			cardID = p.ID
		}
		if p.Method == "cash" {
			cashID = p.ID
		}
	}
	rev := func(id uuid.UUID, ref string) {
		t.Helper()
		var e error
		o, e = f.s.ReversePayment(ctx, f.p, id, ReversePaymentCommand{OperationKey: newID(), ExpectedVersion: o.Version, Reversal: PaymentReversalInput{PaymentID: id, ReasonKind: "refund", Reason: "r", OccurredAt: time.Now(), ExternalReference: ref}}, nil)
		if e != nil {
			t.Fatal(e)
		}
	}
	rev(cardID, "refund-ref")
	if r := register(); r.Expected != "30.00" || r.Refunds != "0.00" {
		t.Fatalf("card refund counted: %+v", r)
	}
	rev(cashID, "")
	if r := register(); r.Expected != "0.00" || r.Refunds != "30.00" {
		t.Fatalf("cash refund: %+v", r)
	}
	// Movements.
	now := time.Now().UTC()
	o2 := f.finalized(t, "50")
	f.pay(t, o2, "cash", "50")
	now = time.Now().UTC()
	if _, e := f.cashMove(f.p, "withdrawal", "20", "bank_deposit", "", now); e != nil {
		t.Fatal(e)
	}
	if _, e := f.cashMove(f.p, "deposit", "5.50", "float", "", now); e != nil {
		t.Fatal(e)
	}
	if r := register(); r.Withdrawals != "20.00" || r.Deposits != "5.50" || r.Expected != "35.50" {
		t.Fatalf("%+v", r)
	}
	early := now.Add(-time.Hour)
	bounded, e := f.s.CashRegister(ctx, f.p, &early)
	if e != nil || bounded.Expected != "30.00" && bounded.Expected != "0.00" {
		t.Fatalf("%v %+v", e, bounded)
	}
}

func TestCashMovementRules(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	o := f.finalized(t, "40")
	f.pay(t, o, "cash", "40")
	now := time.Now().UTC()
	_, e := f.cashMove(f.p, "withdrawal", "40.01", "safe", "", now)
	wantCode(t, e, "insufficient_cash")
	_, e = f.cashMove(f.p, "withdrawal", "0", "safe", "", now)
	wantCode(t, e, "validation_failed")
	_, e = f.cashMove(f.p, "withdrawal", "1.234", "safe", "", now)
	wantCode(t, e, "validation_failed")
	_, e = f.cashMove(f.p, "withdrawal", "1", "other", "  ", now)
	wantCode(t, e, "validation_failed")
	_, e = f.cashMove(f.p, "withdrawal", "1", "bogus", "", now)
	wantCode(t, e, "validation_failed")
	_, e = f.cashMove(f.p, "withdrawal", "1", "safe", "", now.Add(time.Hour))
	wantCode(t, e, "validation_failed")
	// A withdrawal back in time cannot exceed what was held then.
	_, e = f.cashMove(f.p, "withdrawal", "1", "safe", "", now.Add(-48*time.Hour))
	wantCode(t, e, "insufficient_cash")
	// Retries are idempotent; other input under the same key conflicts.
	in := CashMovementInput{OperationKey: newID(), Kind: "withdrawal", Amount: "10", Reason: "other", Note: "coffee", OccurredAt: now}
	first, e := f.s.CreateCashMovement(ctx, f.p, in, nil)
	if e != nil || first.RecordedBy == nil || first.Reference == "" {
		t.Fatalf("%v %+v", e, first)
	}
	again, e := f.s.CreateCashMovement(ctx, f.p, in, nil)
	if e != nil || again.ID != first.ID {
		t.Fatalf("retry %v", e)
	}
	in.Amount = "11"
	_, e = f.s.CreateCashMovement(ctx, f.p, in, nil)
	wantCode(t, e, "idempotency_conflict")
	var n int
	_ = f.pool.QueryRow(ctx, "SELECT count(*) FROM cash_movements").Scan(&n)
	if n != 1 {
		t.Fatalf("movements %d", n)
	}
	// Immutable: no edit, not even by SQL.
	for _, sql := range []string{"UPDATE cash_movements SET amount=1", "UPDATE cash_movements SET note='x'", "UPDATE cash_movements SET recorded_by_person_id='" + newID().String() + "'"} {
		if _, e = f.pool.Exec(ctx, sql); e == nil {
			t.Fatalf("allowed %s", sql)
		}
	}
	// Listing filters.
	f.cashMove(f.p, "deposit", "3", "float", "", now)
	page, e := f.s.ListCashMovements(ctx, f.p, "deposit", nil, nil, 1, 25)
	if e != nil || page.Total != 1 || page.Items[0].Kind != "deposit" {
		t.Fatalf("%v %+v", e, page)
	}
	from, to := now.Add(time.Hour), now.Add(2*time.Hour)
	page, _ = f.s.ListCashMovements(ctx, f.p, "", &from, &to, 1, 25)
	if page.Total != 0 {
		t.Fatal("period filter")
	}
	// Deleting the recording person keeps the movement, without a name.
	if _, e = f.pool.Exec(ctx, "DELETE FROM people WHERE id=$1", f.person); e != nil {
		t.Fatal(e)
	}
	page, _ = f.s.ListCashMovements(ctx, f.p, "", nil, nil, 1, 25)
	if page.Total != 2 || page.Items[0].RecordedBy != nil {
		t.Fatalf("%+v", page)
	}
}

func TestCashMovementPermissions(t *testing.T) {
	f := newFixture(t)
	now := time.Now().UTC()
	reader := f.principal(t, authorization.CashMovementsRead)
	recorderOnly := f.principal(t, authorization.CashMovementsRecord)
	both := f.principal(t, authorization.CashMovementsRead, authorization.CashMovementsRecord)
	_, e := f.cashMove(recorderOnly, "deposit", "1", "float", "", now)
	denied(t, e)
	_, e = f.cashMove(reader, "deposit", "1", "float", "", now)
	denied(t, e)
	if _, e = f.cashMove(both, "deposit", "1", "float", "", now); e != nil {
		t.Fatal(e)
	}
	if _, e = f.s.ListCashMovements(t.Context(), reader, "", nil, nil, 1, 25); e != nil {
		t.Fatal(e)
	}
	_, e = f.s.ListCashMovements(t.Context(), f.principal(t, authorization.PaymentsRead), "", nil, nil, 1, 25)
	denied(t, e)
	_, e = f.s.CashRegister(t.Context(), reader, nil)
	denied(t, e)
	_, e = f.s.CashRegister(t.Context(), f.principal(t, authorization.PaymentsRead), nil)
	denied(t, e)
	if _, e = f.s.CashRegister(t.Context(), f.principal(t, authorization.PaymentsRead, authorization.CashMovementsRead), nil); e != nil {
		t.Fatal(e)
	}
}

func TestRolePricingGroupResolution(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	mk := func(name string, def bool) uuid.UUID {
		g, e := f.jobs.CreatePricingGroup(ctx, f.p, name, nil, def, nil)
		if e != nil {
			t.Fatal(e)
		}
		return g.ID
	}
	staffG, studentG, orgG, jobG := mk("Staff", false), mk("Students", false), mk("Org", false), mk("Special", false)
	role := func(name string) uuid.UUID {
		id := newID()
		if _, e := f.pool.Exec(ctx, "INSERT INTO roles(id,name) VALUES($1,$2)", id, name); e != nil {
			t.Fatal(e)
		}
		return id
	}
	staffR, studentR, unmappedR := role("staff"), role("student"), role("member")
	person := func(roles ...uuid.UUID) uuid.UUID {
		id := newID()
		if _, e := f.pool.Exec(ctx, "INSERT INTO people(id,first_name,last_name,email) VALUES($1,'P','Q',$2)", id, id.String()+"@example.test"); e != nil {
			t.Fatal(e)
		}
		for _, r := range roles {
			if _, e := f.pool.Exec(ctx, "INSERT INTO person_roles(person_id,role_id) VALUES($1,$2)", id, r); e != nil {
				t.Fatal(e)
			}
		}
		return id
	}
	setMap := func(items ...machinelogbook.RolePricingGroupInput) error {
		_, e := f.jobs.SetRolePricingGroups(ctx, f.p, items, nil)
		return e
	}
	if e := setMap(machinelogbook.RolePricingGroupInput{RoleID: staffR, PricingGroupID: staffG, Priority: 20}, machinelogbook.RolePricingGroupInput{RoleID: studentR, PricingGroupID: studentG, Priority: 10}); e != nil {
		t.Fatal(e)
	}
	if _, e := f.jobs.SetPartyPricingGroup(ctx, f.p, machinelogbook.PartyReference{Kind: "organization", ID: f.organization}, &orgG, 0, nil); e != nil {
		t.Fatal(e)
	}
	resolve := func(personID, orgID, explicit *uuid.UUID) (uuid.UUID, string, error) {
		tx, e := f.pool.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		defer tx.Rollback(ctx)
		id, _, source, e := machinelogbook.ResolvePricingGroup(ctx, tx, personID, orgID, explicit)
		return id, source, e
	}
	check := func(label string, id uuid.UUID, source string, e error, want uuid.UUID, wantSource string) {
		t.Helper()
		if e != nil || id != want || source != wantSource {
			t.Fatalf("%s: %v %s %v", label, id, source, e)
		}
	}
	both, onlyStudent, noRole, unmapped := person(staffR, studentR), person(studentR), person(), person(unmappedR)
	id, src, e := resolve(&both, nil, nil)
	check("highest priority role", id, src, e, staffG, "role")
	id, src, e = resolve(&onlyStudent, nil, nil)
	check("single role", id, src, e, studentG, "role")
	id, src, e = resolve(&noRole, nil, nil)
	check("no role", id, src, e, f.group, "default")
	id, src, e = resolve(&unmapped, nil, nil)
	check("unmapped role", id, src, e, f.group, "default")
	id, src, e = resolve(&both, nil, &jobG)
	check("explicit beats role", id, src, e, jobG, "explicit")
	id, src, e = resolve(nil, &f.organization, nil)
	check("organization", id, src, e, orgG, "organization")
	id, src, e = resolve(nil, &f.organization, &jobG)
	check("explicit beats organization", id, src, e, jobG, "explicit")
	// An organization without a group falls back to the default, roles do not apply.
	bare, e := f.jobs.CreateOrganization(ctx, f.p, "Bare", "company", machinelogbook.OrganizationDetailsInput{}, nil)
	if e != nil {
		t.Fatal(e)
	}
	id, src, e = resolve(nil, &bare.ID, nil)
	check("organization without group", id, src, e, f.group, "default")
	// An inactive mapped group is skipped for the next role.
	if _, e = f.pool.Exec(ctx, "UPDATE pricing_groups SET active=false WHERE id=$1", staffG); e != nil {
		t.Fatal(e)
	}
	id, src, e = resolve(&both, nil, nil)
	check("inactive mapped group", id, src, e, studentG, "role")
	if _, e = f.pool.Exec(ctx, "UPDATE pricing_groups SET active=false WHERE id=$1", jobG); e != nil {
		t.Fatal(e)
	}
	if _, _, e = resolve(&both, nil, &jobG); !apperror.IsCode(e, "pricing_group_inactive") {
		t.Fatalf("inactive explicit: %v", e)
	}
	// Real jobs are priced through the resolution.
	start := time.Now().UTC().Add(-2 * time.Hour)
	job, e := f.jobs.CreateManualJob(ctx, f.p, machinelogbook.JobInput{MachineID: f.machine, StartsAt: start, EndsAt: start.Add(time.Hour), Customer: machinelogbook.PartyReference{Kind: "person", ID: onlyStudent}, OperatorPersonID: f.person, Outcome: "successful"}, nil)
	if e != nil || job.PricingSnapshot == nil || job.PricingSnapshot.PricingGroupName != "Students" {
		t.Fatalf("job group %v %+v", e, job.PricingSnapshot)
	}
}

func TestRolePricingGroupMappingRules(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	g, _ := f.jobs.CreatePricingGroup(ctx, f.p, "G2", nil, false, nil)
	inactive, _ := f.jobs.CreatePricingGroup(ctx, f.p, "Old", nil, false, nil)
	if _, e := f.pool.Exec(ctx, "UPDATE pricing_groups SET active=false WHERE id=$1", inactive.ID); e != nil {
		t.Fatal(e)
	}
	r1, r2 := newID(), newID()
	for _, r := range []uuid.UUID{r1, r2} {
		if _, e := f.pool.Exec(ctx, "INSERT INTO roles(id,name) VALUES($1,$2)", r, "r-"+r.String()); e != nil {
			t.Fatal(e)
		}
	}
	in := func(r uuid.UUID, grp uuid.UUID, prio int32) machinelogbook.RolePricingGroupInput {
		return machinelogbook.RolePricingGroupInput{RoleID: r, PricingGroupID: grp, Priority: prio}
	}
	set := func(items ...machinelogbook.RolePricingGroupInput) error {
		_, e := f.jobs.SetRolePricingGroups(ctx, f.p, items, nil)
		return e
	}
	for name, items := range map[string][]machinelogbook.RolePricingGroupInput{
		"duplicate priority": {in(r1, g.ID, 1), in(r2, g.ID, 1)},
		"duplicate role":     {in(r1, g.ID, 1), in(r1, g.ID, 2)},
		"zero priority":      {in(r1, g.ID, 0)},
		"inactive group":     {in(r1, inactive.ID, 1)},
	} {
		if e := set(items...); e == nil {
			t.Fatalf("%s accepted", name)
		}
	}
	if e := set(in(newID(), g.ID, 1)); !apperror.IsCode(e, "not_found") {
		t.Fatalf("unknown role: %v", e)
	}
	if e := set(in(r1, g.ID, 5), in(r2, g.ID, 9)); e != nil {
		t.Fatal(e)
	}
	list, e := f.jobs.ListRolePricingGroups(ctx, f.p)
	if e != nil || len(list) != 2 || list[0].RoleID != r2 {
		t.Fatalf("%v %+v", e, list)
	}
	// A failed replacement leaves the mapping untouched.
	if e = set(in(r1, g.ID, 1), in(r2, inactive.ID, 2)); e == nil {
		t.Fatal("accepted")
	}
	list, _ = f.jobs.ListRolePricingGroups(ctx, f.p)
	if len(list) != 2 {
		t.Fatal("partial replacement")
	}
	reader := f.principal(t, authorization.PricingRead)
	if _, e = f.jobs.ListRolePricingGroups(ctx, reader); e != nil {
		t.Fatal(e)
	}
	if _, e = f.jobs.SetRolePricingGroups(ctx, reader, nil, nil); !apperror.IsCode(e, "permission_denied") {
		t.Fatal(e)
	}
	if _, e = f.jobs.ListRolePricingGroups(ctx, f.principal(t)); !apperror.IsCode(e, "permission_denied") {
		t.Fatal(e)
	}
	// People no longer have a group of their own.
	if _, e = f.jobs.SetPartyPricingGroup(ctx, f.p, machinelogbook.PartyReference{Kind: "person", ID: f.person}, &g.ID, 0, nil); !apperror.IsCode(e, "validation_failed") {
		t.Fatal(e)
	}
}

func TestCancelledRequestsStayVisibleOnTheOrder(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	a := f.actors(t)
	o := f.finalized(t, "10")
	first := f.newRequest(t, a.staff, o)
	first = f.ok(t, a.staff, first, "cancel", func(c *InvoiceRequestCommand) { c.Reason = "wrong recipient" })
	o, _ = f.s.Get(ctx, f.p, o.ID)
	if o.ActiveExternalRequestID != nil || o.LatestExternalRequestID == nil || *o.LatestExternalRequestID != first.ID || *o.LatestExternalRequestState != "cancelled" || *o.LatestExternalRequestReference != first.Reference {
		t.Fatalf("latest request not exposed after cancellation: %+v", o)
	}
	second := f.newRequest(t, a.staff, o)
	o, _ = f.s.Get(ctx, f.p, o.ID)
	if o.ActiveExternalRequestID == nil || *o.ActiveExternalRequestID != second.ID || *o.LatestExternalRequestID != second.ID {
		t.Fatalf("active/latest %+v", o)
	}
	other := f.finalized(t, "4")
	f.newRequest(t, a.staff, other)
	page, e := f.s.ListRequests(ctx, a.staff, "", "", &o.ID, 1, 25)
	if e != nil || page.Total != 2 || len(page.Items) != 2 || page.Items[0].ID != second.ID || page.Items[1].ID != first.ID || page.Items[1].State != "cancelled" || len(page.Items[1].Events) == 0 {
		t.Fatalf("order requests latest first: %v %+v", e, page)
	}
	// The order filter does not widen the permission: without the read permission the list stays denied.
	_, e = f.s.ListRequests(ctx, f.principal(t, authorization.OrdersRead), "", "", &o.ID, 1, 25)
	denied(t, e)
}
