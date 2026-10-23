package orders

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/inbox"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestFinancialPermissionsBeforePersistence(t *testing.T) {
	s := NewService(nil, nil)
	p := authorization.Principal{}
	id := ids.New()
	ctx := t.Context()
	tests := map[string]func() error{
		"read": func() error { _, e := s.Get(ctx, p, id); return e }, "list": func() error { _, e := s.List(ctx, p, "", "", 1, 25); return e }, "create": func() error { _, e := s.Create(ctx, p, OrderDraftInput{}, nil); return e }, "edit": func() error { _, e := s.Update(ctx, p, id, UpdateOrderDraftInput{}, nil); return e }, "items": func() error { _, e := s.ChangeItem(ctx, p, id, id, OrderItemInput{}, "add", nil); return e }, "finalize": func() error { _, e := s.Command(ctx, p, id, OrderCommand{}, "finalize", nil); return e }, "reverse": func() error { _, e := s.Command(ctx, p, id, OrderCommand{}, "reverse", nil); return e }, "payments": func() error { _, e := s.RecordPayment(ctx, p, id, RecordOrderPayment{}, nil); return e }, "payment reverse": func() error { _, e := s.ReversePayment(ctx, p, id, ReversePaymentCommand{}, nil); return e }, "payment read": func() error { _, e := s.GetPayment(ctx, p, id); return e }, "journal": func() error { _, e := s.ListPayments(ctx, p, "", nil, nil, 1, 25); return e }, "reconcile": func() error { _, e := s.Reconciliation(ctx, p, "", nil, nil, 1, 25); return e }, "request create": func() error { _, e := s.CreateRequest(ctx, p, id, CreateInvoiceRequest{}, nil); return e }, "request read": func() error { _, e := s.GetRequest(ctx, p, id); return e }, "request list": func() error { _, e := s.ListRequests(ctx, p, "", "", nil, 1, 25); return e }, "request update": func() error { _, e := s.UpdateRequest(ctx, p, id, UpdateInvoiceRequest{}, nil); return e }, "request return": func() error { _, e := s.RequestCommand(ctx, p, id, InvoiceRequestCommand{}, "return", nil); return e }, "request forward": func() error { _, e := s.RequestCommand(ctx, p, id, InvoiceRequestCommand{}, "forward", nil); return e }, "cash movement": func() error { _, e := s.CreateCashMovement(ctx, p, CashMovementInput{}, nil); return e }, "cash movements": func() error { _, e := s.ListCashMovements(ctx, p, "", nil, nil, 1, 25); return e }, "cash register": func() error { _, e := s.CashRegister(ctx, p, nil); return e }, "request command": func() error { _, e := s.RequestCommand(ctx, p, id, InvoiceRequestCommand{}, "submit", nil); return e }, "requirements": func() error { _, e := s.UpdateRequirements(ctx, p, id, UpdateInvoicingRequirements{}, nil); return e }, "association": func() error { _, e := s.JobAssociation(ctx, p, id); return e }}
	for name, call := range tests {
		t.Run(name, func(t *testing.T) {
			if err := call(); !apperror.IsCode(err, "permission_denied") {
				t.Fatalf("expected permission_denied: %v", err)
			}
		})
	}

}
func TestAmountsRejectPrecisionAndOverflow(t *testing.T) {
	for _, v := range []string{"-1", "1e3", "NaN", "1000000000000000000", "1.001"} {
		if _, e := parseAmount(v, 2, false); e == nil {
			t.Fatalf("accepted money %q", v)
		}
	}
	qty, e := parseAmount("1.005", 6, true)
	if e != nil {
		t.Fatal(e)
	}
	if got := qty.Round(2).StringFixed(2); got != "1.01" {
		t.Fatal(got)
	}
}

type fixture struct {
	s                    *Service
	jobs                 *machinelogbook.Service
	pool                 *pgxpool.Pool
	p                    authorization.Principal
	person, organization uuid.UUID
	request              uuid.UUID
	machine, group       uuid.UUID
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := t.Context()
	admin, e := pgxpool.New(ctx, url)
	if e != nil {
		t.Fatal(e)
	}
	schema := "orders_test_" + strings.ReplaceAll(ids.New().String(), "-", "")
	if _, e = admin.Exec(ctx, "CREATE SCHEMA "+schema); e != nil {
		t.Fatal(e)
	}
	cfg, e := pgxpool.ParseConfig(url)
	if e != nil {
		t.Fatal(e)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() {
		pool.Close()
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
		admin.Close()
	})
	paths, e := filepath.Glob("../../migrations/*.sql")
	if e != nil {
		t.Fatal(e)
	}
	sort.Strings(paths)
	for _, path := range paths {
		raw, e := os.ReadFile(path)
		if e != nil {
			t.Fatal(e)
		}
		up, _, _ := strings.Cut(string(raw), "-- +goose Down")
		if _, e = pool.Exec(ctx, up); e != nil {
			t.Fatalf("migrate %s: %v", path, e)
		}
	}
	f := &fixture{pool: pool, person: ids.New(), organization: ids.New(), request: ids.New()}
	account := ids.New()
	if _, e = pool.Exec(
		ctx,
		"INSERT INTO people(id,first_name,last_name,email) VALUES($1,'Financial','Operator','finance@example.test')",
		f.person,
	); e != nil {
		t.Fatal(e)
	}
	if _, e = pool.Exec(
		ctx,
		"INSERT INTO accounts(id,person_id,status) VALUES($1,$2,'enabled')",
		account,
		f.person,
	); e != nil {
		t.Fatal(e)
	}
	f.p = authorization.Principal{AccountID: account, PersonID: f.person, Master: true}
	f.jobs = machinelogbook.NewService(pool, inbox.NewEmitter())
	f.s = NewService(pool, f.jobs)
	org, e := f.jobs.CreateOrganization(
		ctx,
		f.p,
		"Example institute",
		"institute",
		machinelogbook.OrganizationDetailsInput{},
		&f.request,
	)
	if e != nil {
		t.Fatal(e)
	}
	f.organization = org.ID
	typ, e := f.jobs.CreateMachineType(ctx, f.p, "Printer", "fdm_printing", &f.request)
	if e != nil {
		t.Fatal(e)
	}
	machine, e := f.jobs.CreateMachine(ctx, f.p, typ.ID, "Printer 1", "active", nil, false, &f.request)
	if e != nil {
		t.Fatal(e)
	}
	f.machine = machine.ID
	group, e := f.jobs.CreatePricingGroup(ctx, f.p, "Standard", nil, true, &f.request)
	if e != nil {
		t.Fatal(e)
	}
	f.group = group.ID
	if _, e = f.jobs.CreatePricingRule(
		ctx,
		f.p,
		group.ID,
		"machine_runtime",
		&typ.ID,
		nil,
		nil,
		"10",
		&f.request,
	); e != nil {
		t.Fatal(e)
	}
	return f
}
func (f *fixture) draft(t *testing.T, named bool, amount string) Order {
	t.Helper()
	var c *OrderCustomer
	if named {
		c = &OrderCustomer{Kind: "organization", ID: f.organization}
	}
	o, e := f.s.Create(t.Context(), f.p, OrderDraftInput{Customer: c, FulfillmentMode: "immediate"}, &f.request)
	if e != nil {
		t.Fatal(e)
	}
	o, e = f.s.ChangeItem(
		t.Context(),
		f.p,
		o.ID,
		uuid.Nil,
		OrderItemInput{
			Kind:            "manual",
			Description:     "Service",
			Quantity:        "1",
			Unit:            "service",
			UnitPrice:       amount,
			ExpectedVersion: o.Version,
		},
		"add",
		&f.request,
	)
	if e != nil {
		t.Fatal(e)
	}
	return o
}
func cmd(o Order) OrderCommand {
	return OrderCommand{OperationKey: ids.New(), ExpectedVersion: o.Version}
}
func receipt(method PaymentMethod, amount string) PaymentInput {
	return PaymentInput{
		Method:            method,
		Amount:            amount,
		OccurredAt:        time.Now().UTC(),
		ExternalSource:    "Terminal 1",
		ExternalReference: ids.New().String(),
	}
}
func TestOrderPaymentsReplacementAndImmutability(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	o := f.draft(t, true, "10")
	var e error
	o, e = f.s.Command(ctx, f.p, o.ID, cmd(o), "finalize", &f.request)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.s.Update(
		ctx,
		f.p,
		o.ID,
		UpdateOrderDraftInput{ExpectedVersion: o.Version, FulfillmentMode: "immediate"},
		&f.request,
	); !apperror.IsCode(
		e,
		"order_not_draft",
	) {
		t.Fatalf("finalized edit accepted: %v", e)
	}
	input := RecordOrderPayment{OperationKey: ids.New(), ExpectedVersion: o.Version, Payment: receipt("cash", "4")}
	paid, e := f.s.RecordPayment(ctx, f.p, o.ID, input, &f.request)
	if e != nil {
		t.Fatal(e)
	}
	retry, e := f.s.RecordPayment(ctx, f.p, o.ID, input, &f.request)
	if e != nil || len(retry.Allocations) != 1 {
		t.Fatalf("retry duplicated: %v %+v", e, retry)
	}
	input.Payment.Amount = "5"
	if _, e = f.s.RecordPayment(ctx, f.p, o.ID, input, &f.request); !apperror.IsCode(e, "idempotency_conflict") {
		t.Fatal(e)
	}
	o, e = f.s.RecordPayment(
		ctx,
		f.p,
		o.ID,
		RecordOrderPayment{OperationKey: ids.New(), ExpectedVersion: paid.Version, Payment: receipt("card", "6")},
		&f.request,
	)
	if e != nil {
		t.Fatal(e)
	}
	if o.SettlementState != "paid" || o.OutstandingAmount != "0.00" {
		t.Fatalf("not paid: %+v", o)
	}
	next, e := f.s.Command(ctx, f.p, o.ID, cmd(o), "replacements", &f.request)
	if e != nil {
		t.Fatal(e)
	}
	if next.ReplacesOrderID == nil || *next.ReplacesOrderID != o.ID {
		t.Fatal("missing replacement link")
	}
	replace := cmd(o)
	replace.ReplacementOrderID = next.ID
	replace.ExpectedReplacementVersion = next.Version
	replace.Reason = "Correct service description"
	next, e = f.s.Command(ctx, f.p, o.ID, replace, "replace", &f.request)
	if e != nil {
		t.Fatal(e)
	}
	if next.SettledAmount != "10.00" {
		t.Fatal(next)
	}
	original, e := f.s.Get(ctx, f.p, o.ID)
	if e != nil {
		t.Fatal(e)
	}
	if original.Status != "reversed" || original.TotalAmount != "10.00" || original.NetCharge != "0.00" ||
		original.SettledAmount != "0.00" {
		t.Fatalf("wrong reversal %+v", original)
	}
	journal, e := f.s.Reconciliation(ctx, f.p, "", nil, nil, 1, 100)
	if e != nil {
		t.Fatal(e)
	}
	if journal.Cash != "4.00" || journal.Card != "6.00" || journal.Total != 2 {
		t.Fatalf("transfer moved money %+v", journal)
	}
	if _, e = f.pool.Exec(ctx, "UPDATE order_items SET amount=99 WHERE order_id=$1", next.ID); e == nil {
		t.Fatal("DB allowed snapshot change")
	}
	if _, e = f.pool.Exec(ctx, "UPDATE payments SET amount=99 WHERE id=$1", *next.Allocations[0].PaymentID); e == nil {
		t.Fatal("DB allowed receipt mutation")
	}
}
func TestAnonymousCheckoutRollbackAndCustomerDeletion(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	o := f.draft(t, false, "10")
	if _, e := f.s.Command(ctx, f.p, o.ID, cmd(o), "finalize", &f.request); !apperror.IsCode(
		e,
		"anonymous_requires_full_settlement",
	) {
		t.Fatal(e)
	}
	unchanged, e := f.s.Get(ctx, f.p, o.ID)
	if e != nil || unchanged.Status != "draft" {
		t.Fatalf("partial finalization: %v %+v", e, unchanged)
	}
	checkout := cmd(o)
	checkout.Payments = []PaymentInput{receipt("cash", "10")}
	o, e = f.s.Command(ctx, f.p, o.ID, checkout, "checkout", &f.request)
	if e != nil {
		t.Fatal(e)
	}
	id := *o.Allocations[0].PaymentID
	_, e = f.s.ReversePayment(
		ctx,
		f.p,
		id,
		ReversePaymentCommand{
			OperationKey:    ids.New(),
			ExpectedVersion: o.Version,
			Reversal: PaymentReversalInput{
				PaymentID:  id,
				ReasonKind: "refund",
				Reason:     "Refund",
				OccurredAt: time.Now(),
			},
		},
		&f.request,
	)
	if !apperror.IsCode(e, "anonymous_requires_full_settlement") {
		t.Fatal(e)
	}
	payment, e := f.s.GetPayment(ctx, f.p, id)
	if e != nil || len(payment.Allocations) != 1 {
		t.Fatalf("reversal leaked: %v", e)
	}
	// Identified financial history survives genuine Person/Account deletion.
	personOrder, e := f.s.Create(
		ctx,
		f.p,
		OrderDraftInput{Customer: &OrderCustomer{Kind: "person", ID: f.person}, FulfillmentMode: "deferred"},
		&f.request,
	)
	if e != nil {
		t.Fatal(e)
	}
	personOrder, e = f.s.ChangeItem(
		ctx,
		f.p,
		personOrder.ID,
		uuid.Nil,
		OrderItemInput{
			Kind:            "manual",
			Description:     "Deferred service",
			Quantity:        "1",
			Unit:            "service",
			UnitPrice:       "5",
			ExpectedVersion: personOrder.Version,
		},
		"add",
		&f.request,
	)
	if e != nil {
		t.Fatal(e)
	}
	personOrder, e = f.s.Command(ctx, f.p, personOrder.ID, cmd(personOrder), "finalize", &f.request)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.pool.Exec(ctx, "DELETE FROM people WHERE id=$1", f.person); e != nil {
		t.Fatal(e)
	}
	retained, e := f.s.Get(ctx, f.p, personOrder.ID)
	if e != nil || retained.Customer != nil || retained.CustomerName == nil || retained.TotalAmount != "5.00" {
		t.Fatalf("financial history destroyed %v %+v", e, retained)
	}
}
func TestConcurrentReceiptsAndAuditRollback(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	o := f.draft(t, true, "10")
	o, e := f.s.Command(ctx, f.p, o.ID, cmd(o), "finalize", &f.request)
	if e != nil {
		t.Fatal(e)
	}
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := f.s.RecordPayment(
				context.Background(),
				f.p,
				o.ID,
				RecordOrderPayment{OperationKey: ids.New(), ExpectedVersion: o.Version, Payment: receipt("cash", "7")},
				&f.request,
			)
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	success, stale := 0, 0
	for err := range results {
		if err == nil {
			success++
		} else if apperror.IsCode(err, "stale_write") {
			stale++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || stale != 1 {
		t.Fatalf("race outcomes %d %d", success, stale)
	}
	before, e := f.s.List(ctx, f.p, "", "", 1, 100)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.pool.Exec(
		ctx,
		"CREATE FUNCTION reject_finance_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='order.created' THEN RAISE EXCEPTION 'test audit failure'; END IF;RETURN NEW;END $$;CREATE TRIGGER reject_finance_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_finance_audit()",
	); e != nil {
		t.Fatal(e)
	}
	if _, e = f.s.Create(ctx, f.p, OrderDraftInput{FulfillmentMode: "immediate"}, &f.request); e == nil {
		t.Fatal("audit failure ignored")
	}
	after, e := f.s.List(ctx, f.p, "", "", 1, 100)
	if e != nil || after.Total != before.Total {
		t.Fatal("business write escaped audit rollback")
	}
}
func TestJobSnapshotsAndClaims(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	start := time.Now().UTC().Add(-time.Hour)
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
		},
		&f.request,
	)
	if e != nil {
		t.Fatal(e)
	}
	o, e := f.s.Create(
		ctx,
		f.p,
		OrderDraftInput{Customer: &OrderCustomer{Kind: "person", ID: f.person}, FulfillmentMode: "immediate"},
		&f.request,
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
		&f.request,
	)
	if e != nil {
		t.Fatal(e)
	}
	other := f.draft(t, true, "1")
	if _, e = f.s.ChangeItem(
		ctx,
		f.p,
		other.ID,
		uuid.Nil,
		OrderItemInput{
			Kind:               "machine_job",
			MachineJobID:       job.ID,
			ExpectedJobVersion: job.Version,
			ExpectedVersion:    other.Version,
		},
		"add",
		&f.request,
	); !apperror.IsCode(
		e,
		"job_already_ordered",
	) {
		t.Fatal(e)
	}
	o, e = f.s.Command(ctx, f.p, o.ID, cmd(o), "finalize", &f.request)
	if e != nil {
		t.Fatal(e)
	}
	job, e = f.jobs.SetJobPriceAdjustment(
		ctx,
		f.p,
		job.ID,
		job.Version,
		"fixed",
		"12",
		"Operational correction",
		&f.request,
	)
	if e != nil {
		t.Fatal(e)
	}
	retained, e := f.s.Get(ctx, f.p, o.ID)
	if e != nil || !retained.Items[0].SourceChanged || retained.TotalAmount != "10.00" ||
		retained.Items[0].Snapshot.EffectiveAmount != "10" {
		t.Fatalf("source changed history %v %+v", e, retained)
	}
}
