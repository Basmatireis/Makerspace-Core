package orders

import (
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

func (f *fixture) principal(t *testing.T, permissions ...authorization.Permission) authorization.Principal {
	t.Helper()
	person, account, role := newID(), newID(), newID()
	ctx := t.Context()
	for _, step := range []struct {
		sql  string
		args []any
	}{
		{"INSERT INTO people(id,first_name,last_name,phone) VALUES($1,'Permission','Test','test')", []any{person}},
		{"INSERT INTO accounts(id,person_id,status) VALUES($1,$2,'enabled')", []any{account, person}},
		{"INSERT INTO roles(id,name) VALUES($1,$2)", []any{role, "finance-" + role.String()}},
		{"INSERT INTO person_roles(person_id,role_id) VALUES($1,$2)", []any{person, role}},
	} {
		if _, err := f.pool.Exec(ctx, step.sql, step.args...); err != nil {
			t.Fatal(err)
		}
	}
	for _, permission := range permissions {
		if _, err := f.pool.Exec(ctx, "INSERT INTO role_permission_grants(id,role_id,permission_id) VALUES($1,$2,$3)", newID(), role, string(permission)); err != nil {
			t.Fatal(err)
		}
	}
	p, err := authorization.LoadPermissionsFrom(ctx, f.pool, authorization.Principal{AccountID: account, PersonID: person})
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestSeparatedFinancialPermissions(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	o := f.draft(t, true, "10")
	read := f.principal(t, authorization.OrdersRead)
	if _, e := f.s.Get(ctx, read, o.ID); e != nil {
		t.Fatal(e)
	}
	cases := map[string]func() error{
		"draft write": func() error {
			_, e := f.s.Update(ctx, read, o.ID, UpdateOrderDraftInput{ExpectedVersion: o.Version, FulfillmentMode: "immediate"}, nil)
			return e
		},
		"finalize":       func() error { _, e := f.s.Command(ctx, read, o.ID, cmd(o), "finalize", nil); return e },
		"reverse":        func() error { _, e := f.s.Command(ctx, read, o.ID, cmd(o), "reverse", nil); return e },
		"record":         func() error { _, e := f.s.RecordPayment(ctx, read, o.ID, RecordOrderPayment{}, nil); return e },
		"payment read":   func() error { _, e := f.s.ListPayments(ctx, read, "", nil, nil, 1, 25); return e },
		"recipient read": func() error { _, e := f.s.ListRequests(ctx, read, "", "", 1, 25); return e },
	}
	for name, call := range cases {
		t.Run(name, func(t *testing.T) {
			if e := call(); !apperror.IsCode(e, "permission_denied") {
				t.Fatal(e)
			}
		})
	}
	writer := f.principal(t, authorization.OrdersRead, authorization.OrdersWrite)
	if _, e := f.s.Command(ctx, writer, o.ID, cmd(o), "finalize", nil); !apperror.IsCode(e, "permission_denied") {
		t.Fatal(e)
	}
	finalizer := f.principal(t, authorization.OrdersRead, authorization.OrdersFinalize)
	o, e := f.s.Command(ctx, finalizer, o.ID, cmd(o), "finalize", nil)
	if e != nil {
		t.Fatal(e)
	}
	recorder := f.principal(t, authorization.OrdersRead, authorization.PaymentsRead, authorization.PaymentsRecord)
	o, e = f.s.RecordPayment(ctx, recorder, o.ID, RecordOrderPayment{OperationKey: newID(), ExpectedVersion: o.Version, Payment: receipt("cash", "10")}, nil)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.s.ReversePayment(ctx, recorder, *o.Allocations[0].PaymentID, ReversePaymentCommand{}, nil); !apperror.IsCode(e, "permission_denied") {
		t.Fatal(e)
	}
	requestManager := f.principal(t, authorization.OrdersRead, authorization.ExternalInvoiceRequestsRead)
	if _, e = f.s.CreateRequest(ctx, requestManager, o.ID, CreateInvoiceRequest{}, nil); !apperror.IsCode(e, "permission_denied") {
		t.Fatal(e)
	}
	counter := CounterSaleCommand{OperationKey: newID(), ImmediateFulfillmentConfirmed: true}
	if _, e = f.s.CounterSale(ctx, recorder, counter, nil); !apperror.IsCode(e, "permission_denied") {
		t.Fatal(e)
	}
}

func TestDraftEditingStaleVersionsAndConcurrentFinalization(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	o := f.draft(t, true, "1.005")
	if o.TotalAmount != "1.01" || o.CustomerName == nil {
		t.Fatal(o)
	}
	oldVersion := o.Version
	o, e := f.s.Update(ctx, f.p, o.ID, UpdateOrderDraftInput{ExpectedVersion: o.Version, FulfillmentMode: "deferred", PreserveCustomer: true}, nil)
	if e != nil || o.Customer == nil || o.Customer.ID != f.organization {
		t.Fatalf("omitted customer not preserved: %v %+v", e, o)
	}
	if _, e = f.s.Update(ctx, f.p, o.ID, UpdateOrderDraftInput{ExpectedVersion: oldVersion, FulfillmentMode: "immediate"}, nil); !apperror.IsCode(e, "stale_write") {
		t.Fatal(e)
	}
	o, e = f.s.Update(ctx, f.p, o.ID, UpdateOrderDraftInput{ExpectedVersion: o.Version, FulfillmentMode: "immediate", Customer: nil}, nil)
	if e != nil || o.Customer != nil || o.CustomerKind != "anonymous" {
		t.Fatal(e, o)
	}
	o, e = f.s.Update(ctx, f.p, o.ID, UpdateOrderDraftInput{ExpectedVersion: o.Version, FulfillmentMode: "immediate", Customer: &OrderCustomer{Kind: "organization", ID: f.organization}}, nil)
	if e != nil {
		t.Fatal(e)
	}
	o, e = f.s.ChangeItem(ctx, f.p, o.ID, o.Items[0].ID, OrderItemInput{Kind: "manual", Description: "Corrected service", Quantity: "3", Unit: "piece", UnitPrice: "2.005", ExpectedVersion: o.Version}, "update", nil)
	if e != nil || o.TotalAmount != "6.02" || len(o.Items) != 2 || o.Items[0].RemovedAt == nil {
		t.Fatal(e, o)
	}
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := f.s.Command(ctx, f.p, o.ID, cmd(o), "finalize", nil)
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	success, stale := 0, 0
	for e := range results {
		if e == nil {
			success++
		} else if apperror.IsCode(e, "stale_write") {
			stale++
		} else {
			t.Fatal(e)
		}
	}
	if success != 1 || stale != 1 {
		t.Fatalf("double finalization: %d/%d", success, stale)
	}
}

func TestLowerAnonymousReplacementRequiresExplicitWholeReceiptCorrection(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	o := f.draft(t, false, "10")
	checkout := cmd(o)
	checkout.Payments = []PaymentInput{receipt("cash", "10")}
	o, e := f.s.Command(ctx, f.p, o.ID, checkout, "checkout", nil)
	if e != nil {
		t.Fatal(e)
	}
	next, e := f.s.Command(ctx, f.p, o.ID, cmd(o), "replacements", nil)
	if e != nil {
		t.Fatal(e)
	}
	next, e = f.s.ChangeItem(ctx, f.p, next.ID, next.Items[0].ID, OrderItemInput{Kind: "manual", Description: "Correct charge", Quantity: "1", Unit: "service", UnitPrice: "6", ExpectedVersion: next.Version}, "update", nil)
	if e != nil {
		t.Fatal(e)
	}
	input := cmd(o)
	input.Reason = "Correct price"
	input.ReplacementOrderID = next.ID
	input.ExpectedReplacementVersion = next.Version
	if _, e = f.s.Command(ctx, f.p, o.ID, input, "replace", nil); !apperror.IsCode(e, "payment_exceeds_outstanding") {
		t.Fatal(e)
	}
	retained, _ := f.s.Get(ctx, f.p, o.ID)
	if retained.Status != "finalized" || retained.SettledAmount != "10.00" {
		t.Fatal("failed replacement was partially committed")
	}
	input.OperationKey = newID()
	input.Reversals = []PaymentReversalInput{{PaymentID: *o.Allocations[0].PaymentID, ReasonKind: "refund", Reason: "Whole cash receipt refunded", OccurredAt: time.Now()}}
	if _, e = f.s.Command(ctx, f.p, o.ID, input, "replace", nil); !apperror.IsCode(e, "anonymous_requires_full_settlement") {
		t.Fatal(e)
	}
	input.OperationKey = newID()
	input.Payments = []PaymentInput{receipt("cash", "6")}
	next, e = f.s.Command(ctx, f.p, o.ID, input, "replace", nil)
	if e != nil || next.SettledAmount != "6.00" {
		t.Fatal(e, next)
	}
	journal, e := f.s.Reconciliation(ctx, f.p, "", nil, nil, 1, 100)
	if e != nil || journal.Cash != "6.00" || journal.Total != 3 {
		t.Fatal(e, journal)
	}
	original, _ := f.s.Get(ctx, f.p, o.ID)
	if original.ReplacedByOrderID == nil || *original.ReplacedByOrderID != next.ID {
		t.Fatal("missing successor link")
	}
	if _, e = f.s.Command(ctx, f.p, o.ID, cmd(original), "replacements", nil); !apperror.IsCode(e, "order_already_replaced") {
		t.Fatal(e)
	}
}

func TestAnonymousPreviewInventoryAndOperationalCorrection(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	materials := []uuid.UUID{}
	for _, name := range []string{"PLA black", "PLA white"} {
		m, e := f.jobs.CreateMaterial(ctx, f.p, name, "pla", nil, "g", nil, nil)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = f.jobs.AddPurchase(ctx, f.p, m.ID, m.InventoryVersion, "100", "10", time.Now(), nil, nil, nil); e != nil {
			t.Fatal(e)
		}
		materials = append(materials, m.ID)
	}
	category, unit := "pla", "g"
	if _, e := f.jobs.CreatePricingRule(ctx, f.p, f.group, "material", nil, &category, &unit, "0.1", nil); e != nil {
		t.Fatal(e)
	}
	start := time.Now().UTC().Add(-time.Hour)
	input := CounterSaleCommand{OperationKey: newID(), ImmediateFulfillmentConfirmed: true, Job: CounterSaleJob{ManualJob: &ManualJob{MachineID: f.machine, StartsAt: start, EndsAt: start.Add(time.Hour), OperatorPersonID: f.person, Outcome: "successful", PricingGroupID: &f.group, Usages: []UsageInput{{MaterialID: materials[0], Quantity: "10"}, {MaterialID: materials[1], Quantity: "20"}}}}}
	quote, e := f.s.PreviewCounterSale(ctx, f.p, input)
	if e != nil || quote.TotalAmount != "13.00" {
		t.Fatalf("repeated category charge: %v %+v", e, quote)
	}
	var count int
	if e = f.pool.QueryRow(ctx, "SELECT count(*) FROM machine_jobs").Scan(&count); e != nil || count != 0 {
		t.Fatal("preview persisted a job", e, count)
	}
	for _, id := range materials {
		m, e := f.jobs.GetMaterial(ctx, f.p, id)
		if e != nil || m.Quantity != "100" {
			t.Fatal("preview consumed stock", e, m)
		}
	}
	input.Payments = []PaymentInput{receipt("cash", "13")}
	o, e := f.s.CounterSale(ctx, f.p, input, nil)
	if e != nil {
		t.Fatal(e)
	}
	job, e := f.jobs.GetJob(ctx, f.p, *o.Items[0].SourceMachineJobID)
	if e != nil {
		t.Fatal(e)
	}
	job, e = f.jobs.UpdateJobFacts(ctx, f.p, job.ID, job.Version, machinelogbook.JobInput{MachineID: f.machine, StartsAt: start, EndsAt: start.Add(2 * time.Hour), OperatorPersonID: f.person, Outcome: "successful"}, nil)
	if e != nil || job.Customer != nil {
		t.Fatal("anonymous operational correction failed", e)
	}
	job, e = f.jobs.ReplaceJobUsages(ctx, f.p, job.ID, job.Version, []machinelogbook.UsageInput{{MaterialID: materials[0], Quantity: "5"}, {MaterialID: materials[1], Quantity: "20"}}, nil)
	if e != nil {
		t.Fatal(e)
	}
	retained, e := f.s.Get(ctx, f.p, o.ID)
	if e != nil || retained.TotalAmount != "13.00" || !retained.Items[0].SourceChanged {
		t.Fatal(e, retained)
	}
	m, e := f.jobs.GetMaterial(ctx, f.p, materials[0])
	if e != nil || m.Quantity != "95" {
		t.Fatal("compensating stock failed", e, m)
	}
	if _, e = f.pool.Exec(ctx, "UPDATE order_items SET source_machine_job_id=NULL WHERE id=$1", o.Items[0].ID); e != nil {
		t.Fatal(e)
	}
	retained, e = f.s.Get(ctx, f.p, o.ID)
	if e != nil || retained.Items[0].SourceMachineJobID != nil || retained.Items[0].Snapshot == nil || retained.TotalAmount != "13.00" {
		t.Fatal("source detachment destroyed snapshot", e, retained)
	}
	encoded, _ := json.Marshal(retained.Items[0].Snapshot)
	var fields map[string]any
	_ = json.Unmarshal(encoded, &fields)
	for _, key := range []string{"customer", "operator", "notes", "externalMetadata"} {
		if _, ok := fields[key]; ok {
			t.Fatal("unnecessary identity in financial snapshot", key)
		}
	}
}

func TestAnonymousReviewConfirmationIsAtomic(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	machine, e := f.jobs.GetMachine(ctx, f.p, f.machine)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.jobs.UpdateMachine(ctx, f.p, machine.ID, machine.Version, machine.MachineType.ID, machine.Name, "active", nil, true, nil); e != nil {
		t.Fatal(e)
	}
	start := time.Now().UTC().Add(-time.Hour)
	job, _, e := f.jobs.IngestAutomaticJob(ctx, f.p, machinelogbook.AutomaticJobInput{MachineID: f.machine, StartsAt: start, EndsAt: start.Add(time.Hour), ExternalID: "automatic-counter-sale", ExternalMetadata: []byte(`{}`)}, nil)
	if e != nil || job.Customer != nil || job.ReviewState != "needs_review" {
		t.Fatal(e, job)
	}
	if _, e = f.jobs.ConfirmJob(ctx, f.p, job.ID, job.Version, machinelogbook.PartyReference{}, f.person, "successful", nil, &f.group, nil); e == nil {
		t.Fatal("ordinary confirmation allowed unpaid anonymous job")
	}
	input := CounterSaleCommand{OperationKey: newID(), ImmediateFulfillmentConfirmed: true, Job: CounterSaleJob{ExistingJobID: job.ID, ExpectedJobVersion: job.Version, OperatorPersonID: f.person, Outcome: "successful", PricingGroupID: f.group}, Payments: []PaymentInput{receipt("card", "9")}}
	if _, e = f.s.CounterSale(ctx, f.p, input, nil); e == nil {
		t.Fatal("partial review counter sale accepted")
	}
	job, e = f.jobs.GetJob(ctx, f.p, job.ID)
	if e != nil || job.ReviewState != "needs_review" {
		t.Fatal("failed payment left confirmed job", e, job)
	}
	input.OperationKey = newID()
	input.Payments = []PaymentInput{receipt("card", "10")}
	o, e := f.s.CounterSale(ctx, f.p, input, nil)
	if e != nil || o.SettlementState != "paid" {
		t.Fatal(e, o)
	}
	if _, e = f.pool.Exec(ctx, "UPDATE orders SET fulfillment_mode='deferred' WHERE id=$1", o.ID); e == nil {
		t.Fatal("anonymous deferred history accepted")
	}
}

func TestConcurrentJobClaimsAndCardReferenceUniqueness(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	start := time.Now().UTC().Add(-time.Hour)
	job, e := f.jobs.CreateManualJob(ctx, f.p, machinelogbook.JobInput{MachineID: f.machine, StartsAt: start, EndsAt: start.Add(time.Hour), Customer: machinelogbook.PartyReference{Kind: "organization", ID: f.organization}, OperatorPersonID: f.person, Outcome: "successful"}, nil)
	if e != nil {
		t.Fatal(e)
	}
	orders := []Order{f.draft(t, true, "1"), f.draft(t, true, "1")}
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for _, o := range orders {
		wg.Add(1)
		go func(o Order) {
			defer wg.Done()
			_, err := f.s.ChangeItem(ctx, f.p, o.ID, uuid.Nil, OrderItemInput{Kind: "machine_job", MachineJobID: job.ID, ExpectedJobVersion: job.Version, ExpectedVersion: o.Version}, "add", nil)
			results <- err
		}(o)
	}
	wg.Wait()
	close(results)
	success, claimed := 0, 0
	for err := range results {
		if err == nil {
			success++
		} else if apperror.IsCode(err, "job_already_ordered") {
			claimed++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || claimed != 1 {
		t.Fatal("concurrent double charge", success, claimed)
	}
	a := f.draft(t, true, "10")
	b := f.draft(t, true, "10")
	a, e = f.s.Command(ctx, f.p, a.ID, cmd(a), "finalize", nil)
	if e != nil {
		t.Fatal(e)
	}
	b, e = f.s.Command(ctx, f.p, b.ID, cmd(b), "finalize", nil)
	if e != nil {
		t.Fatal(e)
	}
	payment := receipt("card", "10")
	if _, e = f.s.RecordPayment(ctx, f.p, a.ID, RecordOrderPayment{OperationKey: newID(), ExpectedVersion: a.Version, Payment: payment}, nil); e != nil {
		t.Fatal(e)
	}
	if _, e = f.s.RecordPayment(ctx, f.p, b.ID, RecordOrderPayment{OperationKey: newID(), ExpectedVersion: b.Version, Payment: payment}, nil); !apperror.IsCode(e, "already_exists") {
		t.Fatal("same terminal payment recorded twice", e)
	}
	b, e = f.s.Get(ctx, f.p, b.ID)
	if e != nil || b.SettledAmount != "0.00" {
		t.Fatal("duplicate card rollback failed", e, b)
	}
}

func TestConcurrentReplacementAndAuditPaymentRollback(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	o := f.draft(t, true, "10")
	o, e := f.s.Command(ctx, f.p, o.ID, cmd(o), "finalize", nil)
	if e != nil {
		t.Fatal(e)
	}
	o, e = f.s.RecordPayment(ctx, f.p, o.ID, RecordOrderPayment{OperationKey: newID(), ExpectedVersion: o.Version, Payment: receipt("cash", "10")}, nil)
	if e != nil {
		t.Fatal(e)
	}
	candidates := []Order{}
	for range 2 {
		next, e := f.s.Command(ctx, f.p, o.ID, cmd(o), "replacements", nil)
		if e != nil {
			t.Fatal(e)
		}
		candidates = append(candidates, next)
	}
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for _, next := range candidates {
		wg.Add(1)
		go func(next Order) {
			defer wg.Done()
			input := cmd(o)
			input.Reason = "Concurrent correction"
			input.ReplacementOrderID = next.ID
			input.ExpectedReplacementVersion = next.Version
			_, err := f.s.Command(ctx, f.p, o.ID, input, "replace", nil)
			results <- err
		}(next)
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
		t.Fatal("concurrent replacement moved receipt twice", success, stale)
	}
	journal, e := f.s.Reconciliation(ctx, f.p, "", nil, nil, 1, 100)
	if e != nil || journal.Cash != "10.00" || journal.Total != 1 {
		t.Fatal("allocation transfer moved cash", e, journal)
	}
	unpaid := f.draft(t, true, "3")
	unpaid, e = f.s.Command(ctx, f.p, unpaid.ID, cmd(unpaid), "finalize", nil)
	if e != nil {
		t.Fatal(e)
	}
	var before int
	if e = f.pool.QueryRow(ctx, "SELECT count(*) FROM audit_events").Scan(&before); e != nil {
		t.Fatal(e)
	}
	if _, e = f.pool.Exec(ctx, "CREATE FUNCTION reject_payment_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='payment.recorded' THEN RAISE EXCEPTION 'injected audit failure'; END IF;RETURN NEW;END $$;CREATE TRIGGER reject_payment_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_payment_audit()"); e != nil {
		t.Fatal(e)
	}
	if _, e = f.s.RecordPayment(ctx, f.p, unpaid.ID, RecordOrderPayment{OperationKey: newID(), ExpectedVersion: unpaid.Version, Payment: receipt("cash", "3")}, nil); e == nil {
		t.Fatal("payment escaped audit failure")
	}
	unpaid, e = f.s.Get(ctx, f.p, unpaid.ID)
	if e != nil || unpaid.SettledAmount != "0.00" {
		t.Fatal(e, unpaid)
	}
	var after int
	if e = f.pool.QueryRow(ctx, "SELECT count(*) FROM audit_events").Scan(&after); e != nil || before != after {
		t.Fatal("audit transaction rollback failed", e, before, after)
	}
}

func TestOrderTotalOverflowBlocksFinalization(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	o := f.draft(t, true, "0")
	item := OrderItemInput{Kind: "manual", Description: "Large exact charge", Quantity: "1000000000", Unit: "piece", UnitPrice: "900000000", ExpectedVersion: o.Version}
	o, err := f.s.ChangeItem(ctx, f.p, o.ID, uuid.Nil, item, "add", nil)
	if err != nil || o.TotalAmount != "900000000000000000.00" {
		t.Fatal(err, o.TotalAmount)
	}
	item.ExpectedVersion = o.Version
	o, err = f.s.ChangeItem(ctx, f.p, o.ID, uuid.Nil, item, "add", nil)
	if err != nil || o.TotalAmount != "1800000000000000000.00" {
		t.Fatal(err, o.TotalAmount)
	}
	if _, err = f.s.Command(ctx, f.p, o.ID, cmd(o), "finalize", nil); !apperror.IsCode(err, "validation_failed") {
		t.Fatal(err)
	}
	persisted, err := f.s.Get(ctx, f.p, o.ID)
	if err != nil || persisted.Status != "draft" || persisted.Version != o.Version || persisted.TotalAmount != o.TotalAmount {
		t.Fatal("overflow finalization was not rolled back", err, persisted)
	}
}
