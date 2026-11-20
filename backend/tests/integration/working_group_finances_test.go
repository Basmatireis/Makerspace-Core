package integration_test

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/people"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/storage"
	requestsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/subjectrequests/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/workinggroups"
	"github.com/google/uuid"
)

var pdfBytes = []byte("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n")

func pdfUpload(name string) workinggroups.FileUpload {
	return workinggroups.FileUpload{Filename: name, ContentType: "application/pdf", Data: pdfBytes}
}

// financeFixture is a group with a lead, two members, an outsider, a manager (working_groups.manage only), a finance
// manager and an open period containing today with a share of 1000.00 for the group.
type financeFixture struct {
	pinboardFixture
	finance, third authorization.Principal
	thirdID        uuid.UUID
	period         workinggroups.Period
	fileService    *files.Service
}

func newFinanceFixture(t *testing.T, tag string) financeFixture {
	t.Helper()
	f := financeFixture{pinboardFixture: newPinFixture(t, tag)}
	ctx := testContext(t)
	// The database is shared between tests: close the periods of earlier ones and reset the rules.
	mergeExec(t, f.pool, `UPDATE working_group_budget_periods SET closed_at = now() WHERE closed_at IS NULL`)
	mergeExec(t, f.pool, `UPDATE working_group_finance_rules SET project_threshold = 100, offers_threshold = 500`)
	store, err := storage.NewLocal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	f.fileService = files.NewService(f.pool, store)
	f.service = workinggroups.NewService(f.pool).WithFiles(f.fileService)
	var seeded seededAccount
	f.finance, _ = groupPrincipal(t, f.pool, tag+"-finance", "working_groups.read", "working_group_finances.manage")
	f.third, seeded = groupPrincipal(t, f.pool, tag+"-third", "working_groups.read")
	f.thirdID = seeded.personID
	if _, err := f.service.AddMember(ctx, f.manager, f.group.ID, f.thirdID, nil); err != nil {
		t.Fatal(err)
	}
	f.period = f.newPeriod(t, "Period "+tag)
	if _, err := f.service.SetShare(ctx, f.finance, f.period.ID, f.group.ID, "1000.00", nil); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f financeFixture) newPeriod(t *testing.T, name string) workinggroups.Period {
	t.Helper()
	now := time.Now().UTC()
	period, err := f.service.CreatePeriod(testContext(t), f.finance, workinggroups.PeriodInput{
		Name: name, StartsOn: now.AddDate(0, 0, -2), EndsOn: now.AddDate(0, 0, 30), TotalAmount: "5000.00",
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	return period
}

func (f financeFixture) buy(t *testing.T, p authorization.Principal, how, item string, quantity int, price string) workinggroups.Purchase {
	t.Helper()
	items, err := f.service.CreatePurchases(testContext(t), p, workinggroups.CreatePurchasesInput{
		GroupID: f.group.ID, How: how, Items: []workinggroups.PurchaseItemInput{{Item: item, Quantity: quantity, UnitPrice: price}},
	}, nil)
	if err != nil || len(items) != 1 {
		t.Fatalf("buy %s: %v", item, err)
	}
	return items[0]
}

func (f financeFixture) get(t *testing.T, id uuid.UUID) workinggroups.Purchase {
	t.Helper()
	purchase, err := f.service.GetPurchase(testContext(t), f.finance, id)
	if err != nil {
		t.Fatal(err)
	}
	return purchase
}

func (f financeFixture) approve(t *testing.T, id uuid.UUID) workinggroups.Purchase {
	t.Helper()
	purchase, err := f.service.ApprovePurchase(testContext(t), f.finance, id, f.get(t, id).Version, nil)
	if err != nil {
		t.Fatal(err)
	}
	return purchase
}

func (f financeFixture) budgetOf(t *testing.T, p authorization.Principal) workinggroups.Budget {
	t.Helper()
	budget, err := f.service.GetBudget(testContext(t), p, &f.period.ID)
	if err != nil {
		t.Fatal(err)
	}
	return budget
}

func (f financeFixture) groupFigures(t *testing.T) workinggroups.GroupBudget {
	t.Helper()
	for _, g := range f.budgetOf(t, f.member).Groups {
		if g.GroupID == f.group.ID {
			return g
		}
	}
	t.Fatal("group missing in the budget")
	return workinggroups.GroupBudget{}
}

func readAll(t *testing.T, reader io.ReadCloser) string {
	t.Helper()
	defer reader.Close()
	data, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func auditCount(t *testing.T, f financeFixture, action string, id uuid.UUID) {
	t.Helper()
	assertCount(t, f.pool, `SELECT count(*) FROM audit_events WHERE action = $1 AND resource_id = $2`, 1, action, id)
}

func TestWorkingGroupFinancesRefuseWithoutReadAndWithoutTheFinancePermission(t *testing.T) {
	f := newFinanceFixture(t, "wgf-deny")
	ctx := testContext(t)
	svc, group, id := f.service, f.group.ID, ids.New()
	noRead, _ := groupPrincipal(t, f.pool, "wgf-deny-noread", "working_group_finances.manage")

	denied := func(p authorization.Principal, label string, errs ...error) {
		t.Helper()
		for i, err := range errs {
			if err == nil {
				t.Fatalf("%s: call %d was allowed", label, i)
			}
			requireAppError(t, err, http.StatusForbidden, "permission_denied")
		}
	}
	// Without working_groups.read nothing works, whatever else the person holds.
	_, e1 := svc.ListPeriods(ctx, noRead)
	_, e2 := svc.CreatePeriod(ctx, noRead, workinggroups.PeriodInput{}, nil)
	_, e3 := svc.GetBudget(ctx, noRead, nil)
	_, _, e4 := svc.ListPurchases(ctx, noRead, workinggroups.PurchaseFilter{})
	_, e5 := svc.CreatePurchases(ctx, noRead, workinggroups.CreatePurchasesInput{GroupID: group}, nil)
	_, e6 := svc.ApprovePurchase(ctx, noRead, id, 1, nil)
	_, _, e7 := svc.ListOrders(ctx, noRead)
	_, e8 := svc.GetRules(ctx, noRead)
	_, e9 := svc.SetRules(ctx, noRead, workinggroups.FinanceRulesInput{}, nil)
	_, _, e10 := svc.ListBookings(ctx, noRead, nil, nil)
	_, e11 := svc.SetShare(ctx, noRead, f.period.ID, group, "1", nil)
	_, _, e12 := svc.OpenPurchaseFile(ctx, noRead, id, true)
	denied(noRead, "no read", e1, e2, e3, e4, e5, e6, e7, e8, e9, e10, e11, e12)

	// Members and managers of working groups hold no finance rights.
	for _, p := range []authorization.Principal{f.member, f.lead, f.manager, f.outsider} {
		_, a1 := svc.CreatePeriod(ctx, p, workinggroups.PeriodInput{Name: "x"}, nil)
		_, a2 := svc.UpdatePeriod(ctx, p, f.period.ID, workinggroups.PeriodUpdate{ExpectedVersion: 1}, nil)
		_, a3 := svc.ClosePeriod(ctx, p, f.period.ID, 1, nil)
		_, a4 := svc.SetShare(ctx, p, f.period.ID, group, "1.00", nil)
		_, a5 := svc.SetRules(ctx, p, workinggroups.FinanceRulesInput{ExpectedVersion: 1, ProjectThreshold: "1", OffersThreshold: "1"}, nil)
		_, a6 := svc.CreateProjectRequest(ctx, p, "PA-1", "x", nil)
		_, a7 := svc.UpdateProjectRequest(ctx, p, id, "PA-1", "x", nil)
		a8 := svc.DeleteProjectRequest(ctx, p, id, nil)
		_, _, a9 := svc.ListOrders(ctx, p)
		_, a10 := svc.GetOrder(ctx, p, id)
		_, a11 := svc.CreateOrder(ctx, p, workinggroups.CreateOrderInput{Shop: "x", PurchaseIDs: []uuid.UUID{id}}, nil)
		_, a12 := svc.MarkOrderArrived(ctx, p, id, 1, nil)
		_, a13 := svc.SetOrderInvoice(ctx, p, id, pdfUpload("i.pdf"), nil)
		_, _, a14 := svc.OpenOrderInvoice(ctx, p, id)
		_, a15 := svc.CreateBooking(ctx, p, workinggroups.CreateBookingInput{GroupID: group, PeriodID: f.period.ID, Text: "x", Amount: "1", BookedOn: time.Now()}, nil)
		a16 := svc.DeleteBooking(ctx, p, id, nil)
		denied(p, "member", a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12, a13, a14, a15, a16)
	}

	// Approve, decline and refund are the finance manager's; a member of the group sees the purchase and is refused.
	purchase := f.buy(t, f.member, workinggroups.HowSelf, "Glue", 1, "5.00")
	for _, p := range []authorization.Principal{f.member, f.lead, f.third} {
		_, b1 := svc.ApprovePurchase(ctx, p, purchase.ID, purchase.Version, nil)
		_, b2 := svc.DeclinePurchase(ctx, p, purchase.ID, purchase.Version, nil, nil)
		_, b3 := svc.MarkPurchaseRefunded(ctx, p, purchase.ID, purchase.Version, nil)
		denied(p, "purchase", b1, b2, b3)
	}
}

func TestWorkingGroupFinancesAreInvisibleToEverybodyButMembersAndFinanceManagers(t *testing.T) {
	f := newFinanceFixture(t, "wgf-vis")
	ctx := testContext(t)
	purchase := f.buy(t, f.member, workinggroups.HowCentral, "Screws", 3, "2.00")
	if _, err := f.service.CreateBooking(ctx, f.finance, workinggroups.CreateBookingInput{
		GroupID: f.group.ID, PeriodID: f.period.ID, Text: "Fees", Amount: "4.00", BookedOn: time.Now(),
	}, nil); err != nil {
		t.Fatal(err)
	}
	// otherMember belongs to another group with its own purchase.
	otherSeen, err := f.service.CreatePurchases(ctx, f.otherMember, workinggroups.CreatePurchasesInput{
		GroupID: f.otherGroup.ID, How: workinggroups.HowSelf, Items: []workinggroups.PurchaseItemInput{{Item: "Wood", Quantity: 1, UnitPrice: "9.00"}},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}

	for _, p := range []authorization.Principal{f.outsider, f.manager, f.otherMember} {
		items, truncated, err := f.service.ListPurchases(ctx, p, workinggroups.PurchaseFilter{GroupID: &f.group.ID})
		if err != nil || len(items) != 0 || truncated {
			t.Fatalf("list = %+v, %v", items, err)
		}
		_, err = f.service.GetPurchase(ctx, p, purchase.ID)
		requireAppError(t, err, http.StatusNotFound, "")
		_, err = f.service.ApprovePurchase(ctx, p, purchase.ID, purchase.Version, nil)
		requireAppError(t, err, http.StatusNotFound, "")
		_, err = f.service.MarkPurchaseArrived(ctx, p, purchase.ID, purchase.Version, nil)
		requireAppError(t, err, http.StatusNotFound, "")
		requireAppError(t, f.service.DeletePurchase(ctx, p, purchase.ID, nil), http.StatusNotFound, "")
		_, err = f.service.SetAttachment(ctx, p, purchase.ID, pdfUpload("o.pdf"), nil)
		requireAppError(t, err, http.StatusNotFound, "")
		_, err = f.service.HandInReceipt(ctx, p, purchase.ID, workinggroups.ReceiptInput{ExpectedVersion: 1, Amount: "1", File: pdfUpload("r.pdf")}, nil)
		requireAppError(t, err, http.StatusNotFound, "")
		_, _, err = f.service.OpenPurchaseFile(ctx, p, purchase.ID, false)
		requireAppError(t, err, http.StatusNotFound, "")
		bookings, _, err := f.service.ListBookings(ctx, p, &f.group.ID, nil)
		if err != nil || len(bookings) != 0 {
			t.Fatalf("bookings = %+v, %v", bookings, err)
		}
		// Creating a purchase for a group one does not belong to: the group does not exist for them.
		_, err = f.service.CreatePurchases(ctx, p, workinggroups.CreatePurchasesInput{
			GroupID: f.group.ID, How: workinggroups.HowSelf, Items: []workinggroups.PurchaseItemInput{{Item: "x", Quantity: 1, UnitPrice: "1"}},
		}, nil)
		requireAppError(t, err, http.StatusNotFound, "")
	}
	// A finance manager who is not a member may see everything but not request for the group.
	_, err = f.service.CreatePurchases(ctx, f.finance, workinggroups.CreatePurchasesInput{
		GroupID: f.group.ID, How: workinggroups.HowSelf, Items: []workinggroups.PurchaseItemInput{{Item: "x", Quantity: 1, UnitPrice: "1"}},
	}, nil)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")
	all, _, err := f.service.ListPurchases(ctx, f.finance, workinggroups.PurchaseFilter{PeriodID: &f.period.ID})
	if err != nil || len(all) != 2 {
		t.Fatalf("finance list = %d, %v", len(all), err)
	}

	// Budget: the outsider and the plain manager get nothing, the member of another group only their own group.
	for _, p := range []authorization.Principal{f.outsider, f.manager} {
		_, err := f.service.GetBudget(ctx, p, &f.period.ID)
		requireAppError(t, err, http.StatusNotFound, "")
		periods, err := f.service.ListPeriods(ctx, p)
		if err != nil || len(periods) != 0 {
			t.Fatalf("periods = %+v, %v", periods, err)
		}
		_, err = f.service.GetRules(ctx, p)
		requireAppError(t, err, http.StatusNotFound, "")
	}
	budget := f.budgetOf(t, f.otherMember)
	if len(budget.Groups) != 1 || budget.Groups[0].GroupID != f.otherGroup.ID || budget.Totals != nil {
		t.Fatalf("other member budget = %+v", budget)
	}
	if _, err := f.service.GetRules(ctx, f.otherMember); err != nil {
		t.Fatal(err)
	}
	if got := f.budgetOf(t, f.finance); got.Totals == nil || got.Totals.TotalAmount != "5000.00" {
		t.Fatalf("finance budget = %+v", got.Totals)
	}
	_ = otherSeen
}

func TestWorkingGroupSelfPurchaseFlowWithReceiptAndRefund(t *testing.T) {
	f := newFinanceFixture(t, "wgf-self")
	ctx := testContext(t)
	purchase := f.buy(t, f.member, workinggroups.HowSelf, "Glue", 2, "12.00")
	if purchase.Status != workinggroups.PurchaseWanted || purchase.EstimatedTotal != "24.00" || purchase.PeriodID != f.period.ID ||
		purchase.Requester == nil || purchase.Requester.ID != f.memberID || !purchase.CanDelete || purchase.CanApprove {
		t.Fatalf("purchase = %+v", purchase)
	}
	finance := f.get(t, purchase.ID)
	if !finance.CanApprove || !finance.CanDecline || !finance.CanDelete {
		t.Fatalf("finance flags = %+v", finance.PurchaseFlags)
	}
	// Stale version and the receipt before approval.
	_, err := f.service.ApprovePurchase(ctx, f.finance, purchase.ID, purchase.Version+5, nil)
	requireAppError(t, err, http.StatusConflict, "stale_write")
	_, err = f.service.HandInReceipt(ctx, f.member, purchase.ID, workinggroups.ReceiptInput{ExpectedVersion: purchase.Version, Amount: "20.00", File: pdfUpload("r.pdf")}, nil)
	requireAppError(t, err, http.StatusConflict, "working_group_purchase_state")
	approved := f.approve(t, purchase.ID)
	if approved.Status != workinggroups.PurchaseApproved || approved.ApprovedAt == nil {
		t.Fatalf("approved = %+v", approved)
	}
	auditCount(t, f, "working_group_purchase.approved", purchase.ID)

	receipt := func(p authorization.Principal, amount string, upload workinggroups.FileUpload) (workinggroups.Purchase, error) {
		return f.service.HandInReceipt(ctx, p, purchase.ID, workinggroups.ReceiptInput{
			ExpectedVersion: f.get(t, purchase.ID).Version, Amount: amount, File: upload,
		}, nil)
	}
	// Only the requester, the lead and a finance manager; others of the group are refused, outsiders see nothing.
	_, err = receipt(f.third, "20.00", pdfUpload("r.pdf"))
	requireAppError(t, err, http.StatusForbidden, "permission_denied")
	_, err = receipt(f.outsider, "20.00", pdfUpload("r.pdf"))
	requireAppError(t, err, http.StatusNotFound, "")
	_, err = receipt(f.member, "20.00", workinggroups.FileUpload{Filename: "r.html", ContentType: "text/html", Data: []byte("<html></html>")})
	requireAppError(t, err, http.StatusUnprocessableEntity, "")
	_, err = receipt(f.member, "20.00", workinggroups.FileUpload{Filename: "r.pdf", ContentType: "application/pdf", Data: []byte("not a pdf at all")})
	requireAppError(t, err, http.StatusUnprocessableEntity, "")
	_, err = receipt(f.member, "20.005", pdfUpload("r.pdf"))
	requireAppError(t, err, http.StatusUnprocessableEntity, "")
	// A receipt that reaches the project threshold needs a project request.
	_, err = receipt(f.member, "100.00", pdfUpload("r.pdf"))
	requireAppError(t, err, http.StatusConflict, "receipt_needs_project")
	assertCount(t, f.pool, `SELECT count(*) FROM working_group_purchases WHERE id = $1 AND receipt_file_id IS NOT NULL`, 0, purchase.ID)

	bought, err := receipt(f.member, "21.50", pdfUpload("receipt.pdf"))
	if err != nil {
		t.Fatal(err)
	}
	if bought.Status != workinggroups.PurchaseBought || bought.ActualTotal == nil || *bought.ActualTotal != "21.50" || !bought.HasReceipt || bought.CanHandInReceipt {
		t.Fatalf("bought = %+v", bought)
	}
	auditCount(t, f, "working_group_purchase.receipt_added", purchase.ID)
	// Receipt metadata is visible to the group, the file too; not to outsiders.
	_, reader, err := f.service.OpenPurchaseFile(ctx, f.third, purchase.ID, true)
	if err != nil || readAll(t, reader) != string(pdfBytes) {
		t.Fatalf("receipt download: %v", err)
	}
	_, _, err = f.service.OpenPurchaseFile(ctx, f.outsider, purchase.ID, true)
	requireAppError(t, err, http.StatusNotFound, "")
	// Spent uses the actual amount, not the estimate.
	if figures := f.groupFigures(t); figures.Spent != "21.50" || figures.Reserved != "0.00" {
		t.Fatalf("figures = %+v", figures)
	}

	_, err = f.service.MarkPurchaseRefunded(ctx, f.member, purchase.ID, bought.Version, nil)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")
	if !f.get(t, purchase.ID).CanMarkRefunded {
		t.Fatal("finance manager cannot mark refunded")
	}
	refunded, err := f.service.MarkPurchaseRefunded(ctx, f.finance, purchase.ID, bought.Version, nil)
	if err != nil || refunded.Status != workinggroups.PurchaseRefunded || refunded.RefundedAt == nil {
		t.Fatalf("refunded = %+v, %v", refunded, err)
	}
	auditCount(t, f, "working_group_purchase.refunded", purchase.ID)
	_, err = f.service.MarkPurchaseRefunded(ctx, f.finance, purchase.ID, refunded.Version, nil)
	requireAppError(t, err, http.StatusConflict, "working_group_purchase_state")

	// The lead hands in the receipt for somebody else's purchase.
	second := f.buy(t, f.third, workinggroups.HowSelf, "Tape", 1, "3.00")
	f.approve(t, second.ID)
	if _, err := f.service.HandInReceipt(ctx, f.lead, second.ID, workinggroups.ReceiptInput{
		ExpectedVersion: f.get(t, second.ID).Version, Amount: "3.10", File: pdfUpload("tape.pdf"),
	}, nil); err != nil {
		t.Fatal(err)
	}
}

func TestWorkingGroupCentralPurchaseFlowWithCollectiveOrder(t *testing.T) {
	f := newFinanceFixture(t, "wgf-central")
	ctx := testContext(t)
	a := f.buy(t, f.member, workinggroups.HowCentral, "Screws", 2, "10.00")
	b := f.buy(t, f.third, workinggroups.HowCentral, "Nuts", 1, "15.00")
	// Attachment: requester, lead and finance; not the other member; members read it, outsiders do not.
	_, err := f.service.SetAttachment(ctx, f.third, a.ID, pdfUpload("offer.pdf"), nil)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")
	withFile, err := f.service.SetAttachment(ctx, f.member, a.ID, pdfUpload("offer.pdf"), nil)
	if err != nil || !withFile.HasAttachment {
		t.Fatalf("attachment = %+v, %v", withFile, err)
	}
	_, reader, err := f.service.OpenPurchaseFile(ctx, f.third, a.ID, false)
	if err != nil || readAll(t, reader) != string(pdfBytes) {
		t.Fatalf("attachment download: %v", err)
	}
	_, _, err = f.service.OpenPurchaseFile(ctx, f.outsider, a.ID, false)
	requireAppError(t, err, http.StatusNotFound, "")
	_, _, err = f.service.OpenPurchaseFile(ctx, f.third, a.ID, true)
	requireAppError(t, err, http.StatusNotFound, "")

	// Orders need approved purchases that are bought centrally.
	order := func(ps ...uuid.UUID) (workinggroups.PurchaseOrder, error) {
		return f.service.CreateOrder(ctx, f.finance, workinggroups.CreateOrderInput{Shop: "ACME", PurchaseIDs: ps}, nil)
	}
	_, err = order(a.ID)
	requireAppError(t, err, http.StatusConflict, "purchase_not_orderable")
	_, err = f.service.MarkPurchaseArrived(ctx, f.member, a.ID, f.get(t, a.ID).Version, nil)
	requireAppError(t, err, http.StatusConflict, "working_group_purchase_state")
	f.approve(t, a.ID)
	f.approve(t, b.ID)
	_, err = order()
	requireAppError(t, err, http.StatusUnprocessableEntity, "")
	_, err = order(a.ID, ids.New())
	requireAppError(t, err, http.StatusNotFound, "")
	if figures := f.groupFigures(t); figures.Reserved != "35.00" || figures.Spent != "0.00" {
		t.Fatalf("approved figures = %+v", figures)
	}
	placed, err := order(a.ID, b.ID)
	if err != nil || placed.TotalAmount != "35.00" || placed.Status != "ordered" || len(placed.PurchaseIDs) != 2 || placed.ProjectRequestID != nil {
		t.Fatalf("order = %+v, %v", placed, err)
	}
	auditCount(t, f, "working_group_purchase_order.created", placed.ID)
	auditCount(t, f, "working_group_purchase.ordered", a.ID)
	if got := f.get(t, a.ID); got.Status != workinggroups.PurchaseOrdered || got.OrderID == nil || *got.OrderID != placed.ID || !got.CanMarkArrived {
		t.Fatalf("ordered purchase = %+v", got)
	}
	if figures := f.groupFigures(t); figures.Reserved != "0.00" || figures.Spent != "35.00" || figures.Free != "965.00" {
		t.Fatalf("ordered figures = %+v", figures)
	}
	// An ordered purchase is not ordered twice.
	_, err = order(a.ID)
	requireAppError(t, err, http.StatusConflict, "purchase_not_orderable")

	// Arrival: a member of the group marks one; outsiders and members of other groups cannot see it.
	for _, p := range []authorization.Principal{f.outsider, f.otherMember} {
		_, err = f.service.MarkPurchaseArrived(ctx, p, a.ID, f.get(t, a.ID).Version, nil)
		requireAppError(t, err, http.StatusNotFound, "")
	}
	received, err := f.service.MarkPurchaseArrived(ctx, f.third, a.ID, f.get(t, a.ID).Version, nil)
	if err != nil || received.Status != workinggroups.PurchaseReceived {
		t.Fatalf("received = %+v, %v", received, err)
	}
	auditCount(t, f, "working_group_purchase.received", a.ID)

	// The invoice: finance only; the order arrives and the rest is received.
	_, err = f.service.SetOrderInvoice(ctx, f.finance, placed.ID, workinggroups.FileUpload{Filename: "i.exe", ContentType: "application/x-msdownload", Data: []byte("MZ")}, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "")
	withInvoice, err := f.service.SetOrderInvoice(ctx, f.finance, placed.ID, pdfUpload("invoice.pdf"), nil)
	if err != nil || !withInvoice.HasInvoice {
		t.Fatalf("invoice = %+v, %v", withInvoice, err)
	}
	_, reader, err = f.service.OpenOrderInvoice(ctx, f.finance, placed.ID)
	if err != nil || readAll(t, reader) != string(pdfBytes) {
		t.Fatalf("invoice download: %v", err)
	}
	_, err = f.service.MarkOrderArrived(ctx, f.finance, placed.ID, withInvoice.Version+3, nil)
	requireAppError(t, err, http.StatusConflict, "stale_write")
	arrived, err := f.service.MarkOrderArrived(ctx, f.finance, placed.ID, withInvoice.Version, nil)
	if err != nil || arrived.Status != "arrived" || arrived.ArrivedAt == nil {
		t.Fatalf("arrived = %+v, %v", arrived, err)
	}
	auditCount(t, f, "working_group_purchase_order.arrived", placed.ID)
	if got := f.get(t, b.ID); got.Status != workinggroups.PurchaseReceived {
		t.Fatalf("second purchase = %+v", got)
	}
	_, err = f.service.MarkOrderArrived(ctx, f.finance, placed.ID, arrived.Version, nil)
	requireAppError(t, err, http.StatusConflict, "working_group_order_state")
	listed, _, err := f.service.ListOrders(ctx, f.finance)
	if err != nil || len(listed) == 0 || listed[0].ID != placed.ID {
		t.Fatalf("orders = %+v, %v", listed, err)
	}
}

func TestWorkingGroupCollectiveOrderValidation(t *testing.T) {
	f := newFinanceFixture(t, "wgf-order")
	ctx := testContext(t)
	small := f.buy(t, f.member, workinggroups.HowCentral, "Small", 1, "10.00")
	f.approve(t, small.ID)
	selfBuy := f.buy(t, f.member, workinggroups.HowSelf, "Self", 1, "10.00")
	f.approve(t, selfBuy.ID)
	_, err := f.service.CreateOrder(ctx, f.finance, workinggroups.CreateOrderInput{Shop: "ACME", PurchaseIDs: []uuid.UUID{small.ID, selfBuy.ID}}, nil)
	requireAppError(t, err, http.StatusConflict, "purchase_not_orderable")
	_, err = f.service.CreateOrder(ctx, f.finance, workinggroups.CreateOrderInput{Shop: " ", PurchaseIDs: []uuid.UUID{small.ID}}, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "")

	// Together the two purchases reach the threshold: a standing project request is required and must exist.
	big := f.buy(t, f.member, workinggroups.HowCentral, "Big", 1, "95.00")
	f.approve(t, big.ID)
	two := []uuid.UUID{small.ID, big.ID}
	_, err = f.service.CreateOrder(ctx, f.finance, workinggroups.CreateOrderInput{Shop: "ACME", PurchaseIDs: two}, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "project_request_required")
	unknown := ids.New()
	_, err = f.service.CreateOrder(ctx, f.finance, workinggroups.CreateOrderInput{Shop: "ACME", PurchaseIDs: two, ProjectRequestID: &unknown}, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "project_request_unknown")
	request, err := f.service.CreateProjectRequest(ctx, f.finance, "PA-2026-031", "Laser tube", nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.service.CreateProjectRequest(ctx, f.finance, "pa-2026-031", "Duplicate", nil)
	requireAppError(t, err, http.StatusConflict, "working_group_project_request_exists")
	// A purchase in another (later) period cannot join this order.
	later := f.newPeriod(t, "Later wgf-order")
	other := f.buy(t, f.member, workinggroups.HowCentral, "Other period", 1, "5.00")
	if other.PeriodID != later.ID {
		t.Fatalf("new purchases go into the period that started last: %v vs %v", other.PeriodID, later.ID)
	}
	f.approve(t, other.ID)
	_, err = f.service.CreateOrder(ctx, f.finance, workinggroups.CreateOrderInput{Shop: "ACME", PurchaseIDs: []uuid.UUID{small.ID, other.ID}}, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "purchases_mixed_periods")

	order, err := f.service.CreateOrder(ctx, f.finance, workinggroups.CreateOrderInput{Shop: "ACME", PurchaseIDs: two, ProjectRequestID: &request.ID}, nil)
	if err != nil || order.ProjectNumber == nil || *order.ProjectNumber != "PA-2026-031" || order.TotalAmount != "105.00" {
		t.Fatalf("order = %+v, %v", order, err)
	}
	// Deleting the standing request leaves the number on the order.
	if err := f.service.DeleteProjectRequest(ctx, f.finance, request.ID, nil); err != nil {
		t.Fatal(err)
	}
	if got, err := f.service.GetOrder(ctx, f.finance, order.ID); err != nil || got.ProjectRequestID != nil || got.ProjectNumber == nil {
		t.Fatalf("order after delete = %+v, %v", got, err)
	}
	updated, err := f.service.CreateProjectRequest(ctx, f.finance, "PA-1", "First", nil)
	if err != nil {
		t.Fatal(err)
	}
	if renamed, err := f.service.UpdateProjectRequest(ctx, f.finance, updated.ID, "PA-1", "Renamed", nil); err != nil || renamed.Label != "Renamed" {
		t.Fatalf("renamed = %+v, %v", renamed, err)
	}
	if err := f.service.DeleteProjectRequest(ctx, f.finance, updated.ID, nil); err != nil {
		t.Fatal(err)
	}
	requireAppError(t, f.service.DeleteProjectRequest(ctx, f.finance, updated.ID, nil), http.StatusNotFound, "")
}

func TestWorkingGroupProjectThresholdAndRules(t *testing.T) {
	f := newFinanceFixture(t, "wgf-rules")
	ctx := testContext(t)
	over := f.buy(t, f.member, workinggroups.HowCentral, "Laser tube", 1, "100.00")
	under := f.buy(t, f.member, workinggroups.HowCentral, "Lens", 1, "99.99")
	if !over.NeedsProject || under.NeedsProject || f.get(t, over.ID).CanApprove || !f.get(t, under.ID).CanApprove {
		t.Fatalf("flags: over %+v under %+v", over, under)
	}
	_, err := f.service.ApprovePurchase(ctx, f.finance, over.ID, over.Version, nil)
	requireAppError(t, err, http.StatusConflict, "purchase_needs_project")
	f.approve(t, under.ID)
	declined, err := f.service.DeclinePurchase(ctx, f.finance, over.ID, over.Version, ptr("Needs a project request"), nil)
	if err != nil || declined.Status != workinggroups.PurchaseDeclined || declined.DeclineReason == nil || *declined.DeclineReason != "Needs a project request" {
		t.Fatalf("declined = %+v, %v", declined, err)
	}
	auditCount(t, f, "working_group_purchase.declined", over.ID)

	rules, err := f.service.GetRules(ctx, f.member)
	if err != nil || rules.ProjectThreshold != "100.00" || rules.OffersThreshold != "500.00" {
		t.Fatalf("rules = %+v, %v", rules, err)
	}
	input := workinggroups.FinanceRulesInput{ExpectedVersion: rules.Version, ProjectThreshold: "250.00", OffersThreshold: "800"}
	_, err = f.service.SetRules(ctx, f.member, input, nil)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")
	stale := input
	stale.ExpectedVersion++
	_, err = f.service.SetRules(ctx, f.finance, stale, nil)
	requireAppError(t, err, http.StatusConflict, "stale_write")
	bad := input
	bad.ProjectThreshold = "-1"
	_, err = f.service.SetRules(ctx, f.finance, bad, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "")
	changed, err := f.service.SetRules(ctx, f.finance, input, nil)
	if err != nil || changed.ProjectThreshold != "250.00" || changed.OffersThreshold != "800.00" {
		t.Fatalf("changed = %+v, %v", changed, err)
	}
	assertCount(t, f.pool, `SELECT count(*) FROM audit_events WHERE action = 'working_group_finance_rules.updated'`, 1)
	// With the higher threshold the purchase of 100.00 is an ordinary one.
	again := f.buy(t, f.member, workinggroups.HowCentral, "Laser tube again", 1, "100.00")
	if again.NeedsProject {
		t.Fatalf("again = %+v", again)
	}
	f.approve(t, again.ID)
}

func TestWorkingGroupBudgetFigures(t *testing.T) {
	f := newFinanceFixture(t, "wgf-figures")
	ctx := testContext(t)
	if _, err := f.service.SetShare(ctx, f.finance, f.period.ID, f.group.ID, "300.00", nil); err != nil {
		t.Fatal(err)
	}
	a := f.buy(t, f.member, workinggroups.HowCentral, "Ordered", 2, "10.00") // estimate 20.00
	b := f.buy(t, f.member, workinggroups.HowSelf, "Bought", 1, "30.00")     // estimate 30.00, receipt 25.00
	f.approve(t, a.ID)
	f.approve(t, b.ID)
	if figures := f.groupFigures(t); figures.Given != "300.00" || figures.Reserved != "50.00" || figures.Spent != "0.00" || figures.Free != "250.00" {
		t.Fatalf("reserved = %+v", figures)
	}
	if _, err := f.service.CreateOrder(ctx, f.finance, workinggroups.CreateOrderInput{Shop: "ACME", PurchaseIDs: []uuid.UUID{a.ID}}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.HandInReceipt(ctx, f.member, b.ID, workinggroups.ReceiptInput{ExpectedVersion: f.get(t, b.ID).Version, Amount: "25.00", File: pdfUpload("b.pdf")}, nil); err != nil {
		t.Fatal(err)
	}
	booking, err := f.service.CreateBooking(ctx, f.finance, workinggroups.CreateBookingInput{
		GroupID: f.group.ID, PeriodID: f.period.ID, Text: "Membership fee", Amount: "5.00", BookedOn: time.Now(),
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	auditCount(t, f, "working_group_booking.created", booking.ID)
	c := f.buy(t, f.member, workinggroups.HowCentral, "Reserved", 1, "40.00")
	f.approve(t, c.ID)
	if figures := f.groupFigures(t); figures.Spent != "50.00" || figures.Reserved != "40.00" || figures.Free != "210.00" {
		t.Fatalf("figures = %+v", figures)
	}
	// Members read the bookings of their group; the finance manager sees the period's totals.
	listed, _, err := f.service.ListBookings(ctx, f.third, &f.group.ID, &f.period.ID)
	if err != nil || len(listed) != 1 || listed[0].Text != "Membership fee" || listed[0].Amount != "5.00" {
		t.Fatalf("bookings = %+v, %v", listed, err)
	}
	totals := f.budgetOf(t, f.finance).Totals
	if totals == nil || totals.TotalAmount != "5000.00" || totals.GivenSum != "300.00" || totals.KeptBack != "4700.00" ||
		totals.SpentSum != "50.00" || totals.ReservedSum != "40.00" || totals.FreeSum != "210.00" {
		t.Fatalf("totals = %+v", totals)
	}
	// Over-spending makes free negative.
	if _, err := f.service.CreateBooking(ctx, f.finance, workinggroups.CreateBookingInput{
		GroupID: f.group.ID, PeriodID: f.period.ID, Text: "Big cost", Amount: "400.00", BookedOn: time.Now(),
	}, nil); err != nil {
		t.Fatal(err)
	}
	if figures := f.groupFigures(t); figures.Free != "-190.00" {
		t.Fatalf("negative figures = %+v", figures)
	}
	// Deleting the booking removes it from the figures.
	if err := f.service.DeleteBooking(ctx, f.finance, booking.ID, nil); err != nil {
		t.Fatal(err)
	}
	auditCount(t, f, "working_group_booking.deleted", booking.ID)
	if figures := f.groupFigures(t); figures.Spent != "445.00" {
		t.Fatalf("figures after delete = %+v", figures)
	}
	// Share change and copy to a new period are audited and copied.
	assertCount(t, f.pool, `SELECT count(*) FROM audit_events WHERE action = 'working_group_budget_period.share_set' AND resource_id = $1`, 2, f.period.ID)
	now := time.Now().UTC()
	next, err := f.service.CreatePeriod(ctx, f.finance, workinggroups.PeriodInput{
		Name: "Next wgf-figures", StartsOn: now.AddDate(0, 6, 0), EndsOn: now.AddDate(1, 0, 0), TotalAmount: "100.00", CopySharesFromPeriodID: &f.period.ID,
	}, nil)
	if err != nil || next.Current {
		t.Fatalf("next = %+v, %v", next, err)
	}
	copied, err := f.service.GetBudget(ctx, f.member, &next.ID)
	if err != nil || len(copied.Groups) == 0 {
		t.Fatalf("copied = %+v, %v", copied, err)
	}
	for _, g := range copied.Groups {
		if g.GroupID == f.group.ID && g.Given != "300.00" {
			t.Fatalf("copied share = %+v", g)
		}
	}
}

func TestWorkingGroupClosedPeriodIsReadOnly(t *testing.T) {
	f := newFinanceFixture(t, "wgf-closed")
	ctx := testContext(t)
	wanted := f.buy(t, f.member, workinggroups.HowSelf, "Wanted", 1, "5.00")
	approved := f.buy(t, f.member, workinggroups.HowCentral, "Approved", 1, "5.00")
	f.approve(t, approved.ID)
	booking, err := f.service.CreateBooking(ctx, f.finance, workinggroups.CreateBookingInput{
		GroupID: f.group.ID, PeriodID: f.period.ID, Text: "Fee", Amount: "1.00", BookedOn: time.Now(),
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.service.ClosePeriod(ctx, f.member, f.period.ID, f.period.Version, nil)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")
	_, err = f.service.ClosePeriod(ctx, f.finance, f.period.ID, 99, nil)
	requireAppError(t, err, http.StatusConflict, "stale_write")
	current, err := f.service.ListPeriods(ctx, f.finance)
	if err != nil {
		t.Fatal(err)
	}
	var version int64
	for _, p := range current {
		if p.ID == f.period.ID {
			version = p.Version
		}
	}
	closed, err := f.service.ClosePeriod(ctx, f.finance, f.period.ID, version, nil)
	if err != nil || !closed.Closed || closed.Current {
		t.Fatalf("closed = %+v, %v", closed, err)
	}
	auditCount(t, f, "working_group_budget_period.closed", f.period.ID)

	closedErr := func(err error) {
		t.Helper()
		requireAppError(t, err, http.StatusConflict, "budget_period_closed")
	}
	_, err = f.service.ApprovePurchase(ctx, f.finance, wanted.ID, wanted.Version, nil)
	closedErr(err)
	_, err = f.service.MarkPurchaseArrived(ctx, f.member, approved.ID, approved.Version, nil)
	requireAppError(t, err, http.StatusConflict, "")
	closedErr(f.service.DeletePurchase(ctx, f.member, wanted.ID, nil))
	_, err = f.service.CreateOrder(ctx, f.finance, workinggroups.CreateOrderInput{Shop: "ACME", PurchaseIDs: []uuid.UUID{approved.ID}}, nil)
	closedErr(err)
	_, err = f.service.SetShare(ctx, f.finance, f.period.ID, f.group.ID, "1.00", nil)
	closedErr(err)
	_, err = f.service.UpdatePeriod(ctx, f.finance, f.period.ID, workinggroups.PeriodUpdate{ExpectedVersion: closed.Version, Name: ptr("Renamed")}, nil)
	closedErr(err)
	_, err = f.service.ClosePeriod(ctx, f.finance, f.period.ID, closed.Version, nil)
	closedErr(err)
	_, err = f.service.CreateBooking(ctx, f.finance, workinggroups.CreateBookingInput{
		GroupID: f.group.ID, PeriodID: f.period.ID, Text: "Late", Amount: "1.00", BookedOn: time.Now(),
	}, nil)
	closedErr(err)
	closedErr(f.service.DeleteBooking(ctx, f.finance, booking.ID, nil))
	_, err = f.service.SetAttachment(ctx, f.member, wanted.ID, pdfUpload("o.pdf"), nil)
	closedErr(err)
	// No open period: nobody can request.
	_, err = f.service.CreatePurchases(ctx, f.member, workinggroups.CreatePurchasesInput{
		GroupID: f.group.ID, How: workinggroups.HowSelf, Items: []workinggroups.PurchaseItemInput{{Item: "x", Quantity: 1, UnitPrice: "1"}},
	}, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "budget_period_missing")
	// The figures of a closed period stay readable.
	if figures := f.groupFigures(t); figures.Spent != "1.00" || figures.Reserved != "5.00" {
		t.Fatalf("closed figures = %+v", figures)
	}
}

func TestWorkingGroupPurchaseDeleteRulesAndFiles(t *testing.T) {
	f := newFinanceFixture(t, "wgf-delete")
	ctx := testContext(t)
	mine := f.buy(t, f.member, workinggroups.HowSelf, "Mine", 1, "5.00")
	withFile, err := f.service.SetAttachment(ctx, f.member, mine.ID, pdfUpload("offer.pdf"), nil)
	if err != nil || !withFile.HasAttachment {
		t.Fatalf("attachment = %+v, %v", withFile, err)
	}
	var fileID uuid.UUID
	if err := f.pool.QueryRow(ctx, `SELECT attachment_file_id FROM working_group_purchases WHERE id = $1`, mine.ID).Scan(&fileID); err != nil {
		t.Fatal(err)
	}
	// Replacing the attachment deletes the old file.
	if _, err := f.service.SetAttachment(ctx, f.lead, mine.ID, pdfUpload("offer2.pdf"), nil); err != nil {
		t.Fatal(err)
	}
	assertCount(t, f.pool, `SELECT count(*) FROM files WHERE id = $1`, 0, fileID)
	_, err = f.service.SetAttachment(ctx, f.member, mine.ID, workinggroups.FileUpload{Filename: "x.pdf", ContentType: "application/pdf", Data: make([]byte, workinggroups.MaxFinanceFileBytes+1)}, nil)
	requireAppError(t, err, http.StatusRequestEntityTooLarge, "")

	// Only the requester (while wanted) and finance (wanted or declined) delete.
	for _, p := range []authorization.Principal{f.third, f.lead, f.manager} {
		err := f.service.DeletePurchase(ctx, p, mine.ID, nil)
		if p.PersonID == f.manager.PersonID {
			requireAppError(t, err, http.StatusNotFound, "")
		} else {
			requireAppError(t, err, http.StatusForbidden, "permission_denied")
		}
	}
	var current uuid.UUID
	if err := f.pool.QueryRow(ctx, `SELECT attachment_file_id FROM working_group_purchases WHERE id = $1`, mine.ID).Scan(&current); err != nil {
		t.Fatal(err)
	}
	if err := f.service.DeletePurchase(ctx, f.member, mine.ID, nil); err != nil {
		t.Fatal(err)
	}
	auditCount(t, f, "working_group_purchase.deleted", mine.ID)
	assertCount(t, f.pool, `SELECT count(*) FROM files WHERE id = $1`, 0, current)
	requireAppError(t, f.service.DeletePurchase(ctx, f.member, mine.ID, nil), http.StatusNotFound, "")

	approved := f.buy(t, f.member, workinggroups.HowSelf, "Approved", 1, "5.00")
	f.approve(t, approved.ID)
	requireAppError(t, f.service.DeletePurchase(ctx, f.member, approved.ID, nil), http.StatusConflict, "working_group_purchase_state")
	requireAppError(t, f.service.DeletePurchase(ctx, f.finance, approved.ID, nil), http.StatusConflict, "working_group_purchase_state")
	declined := f.buy(t, f.member, workinggroups.HowSelf, "Declined", 1, "5.00")
	if _, err := f.service.DeclinePurchase(ctx, f.finance, declined.ID, declined.Version, nil, nil); err != nil {
		t.Fatal(err)
	}
	requireAppError(t, f.service.DeletePurchase(ctx, f.member, declined.ID, nil), http.StatusConflict, "working_group_purchase_state")
	if err := f.service.DeletePurchase(ctx, f.finance, declined.ID, nil); err != nil {
		t.Fatal(err)
	}
	wanted := f.buy(t, f.member, workinggroups.HowSelf, "Wanted", 1, "5.00")
	if err := f.service.DeletePurchase(ctx, f.finance, wanted.ID, nil); err != nil {
		t.Fatal(err)
	}

	// Deleting the group deletes the purchases and their stored files.
	last := f.buy(t, f.member, workinggroups.HowSelf, "Last", 1, "5.00")
	f.approve(t, last.ID)
	if _, err := f.service.HandInReceipt(ctx, f.member, last.ID, workinggroups.ReceiptInput{ExpectedVersion: f.get(t, last.ID).Version, Amount: "4.00", File: pdfUpload("last.pdf")}, nil); err != nil {
		t.Fatal(err)
	}
	var receiptFile uuid.UUID
	if err := f.pool.QueryRow(ctx, `SELECT receipt_file_id FROM working_group_purchases WHERE id = $1`, last.ID).Scan(&receiptFile); err != nil {
		t.Fatal(err)
	}
	// A group with budget records is not deleted by working_groups.manage alone, and not at all with closed records.
	requireAppError(t, f.service.Delete(ctx, f.manager, f.group.ID, nil), http.StatusConflict, "working_group_has_finances")
	both, _ := groupPrincipal(t, f.pool, "wgf-delete-both", "working_groups.read", "working_groups.manage", "working_group_finances.manage")
	if err := f.service.Delete(ctx, both, f.group.ID, nil); err != nil {
		t.Fatal(err)
	}
	assertCount(t, f.pool, `SELECT count(*) FROM working_group_purchases WHERE group_id = $1`, 0, f.group.ID)
	assertCount(t, f.pool, `SELECT count(*) FROM files WHERE id = $1`, 0, receiptFile)
}

func TestWorkingGroupFinanceValidation(t *testing.T) {
	f := newFinanceFixture(t, "wgf-valid")
	ctx := testContext(t)
	create := func(items ...workinggroups.PurchaseItemInput) error {
		_, err := f.service.CreatePurchases(ctx, f.member, workinggroups.CreatePurchasesInput{GroupID: f.group.ID, How: workinggroups.HowSelf, Items: items}, nil)
		return err
	}
	link := "http://insecure.example"
	good := "https://shop.example/item"
	for _, bad := range []workinggroups.PurchaseItemInput{
		{Item: " ", Quantity: 1, UnitPrice: "1"}, {Item: strings.Repeat("x", 161), Quantity: 1, UnitPrice: "1"},
		{Item: "a", Quantity: 0, UnitPrice: "1"}, {Item: "a", Quantity: 1, UnitPrice: "-1"}, {Item: "a", Quantity: 1, UnitPrice: "1.234"},
		{Item: "a", Quantity: 1, UnitPrice: "1", Link: &link},
	} {
		requireAppError(t, create(bad), http.StatusUnprocessableEntity, "")
	}
	requireAppError(t, create(), http.StatusUnprocessableEntity, "")
	_, err := f.service.CreatePurchases(ctx, f.member, workinggroups.CreatePurchasesInput{GroupID: f.group.ID, How: "bank", Items: []workinggroups.PurchaseItemInput{{Item: "a", Quantity: 1, UnitPrice: "1"}}}, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "")
	// Several purchases in one call share the way of buying.
	items, err := f.service.CreatePurchases(ctx, f.member, workinggroups.CreatePurchasesInput{GroupID: f.group.ID, How: workinggroups.HowCentral, Items: []workinggroups.PurchaseItemInput{
		{Item: "a", Quantity: 1, UnitPrice: "1.5", Link: &good}, {Item: "b", Quantity: 3, UnitPrice: "2"},
	}}, nil)
	if err != nil || len(items) != 2 || items[0].Link == nil || items[0].UnitPrice != "1.50" || items[1].How != workinggroups.HowCentral {
		t.Fatalf("items = %+v, %v", items, err)
	}
	auditCount(t, f, "working_group_purchase.created", items[0].ID)
	_, err = f.service.CreatePeriod(ctx, f.finance, workinggroups.PeriodInput{Name: "Bad", StartsOn: time.Now(), EndsOn: time.Now().AddDate(0, 0, -1), TotalAmount: "1"}, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "")
	_, err = f.service.CreatePeriod(ctx, f.finance, workinggroups.PeriodInput{Name: "Bad", StartsOn: time.Now(), EndsOn: time.Now(), TotalAmount: "-5"}, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "")
	_, err = f.service.GetBudget(ctx, f.finance, ptr(ids.New()))
	requireAppError(t, err, http.StatusNotFound, "")
	_, _, err = f.service.ListPurchases(ctx, f.finance, workinggroups.PurchaseFilter{Status: ptr("sold")})
	requireAppError(t, err, http.StatusUnprocessableEntity, "")
	renamed, err := f.service.UpdatePeriod(ctx, f.finance, f.period.ID, workinggroups.PeriodUpdate{ExpectedVersion: f.period.Version, Name: ptr("Renamed")}, nil)
	if err != nil || renamed.Name != "Renamed" || renamed.Version != f.period.Version+1 {
		t.Fatalf("renamed = %+v, %v", renamed, err)
	}
	_, err = f.service.UpdatePeriod(ctx, f.finance, f.period.ID, workinggroups.PeriodUpdate{ExpectedVersion: f.period.Version, Name: ptr("Again")}, nil)
	requireAppError(t, err, http.StatusConflict, "stale_write")
}

func TestPeopleMergeMovesWorkingGroupPurchaseRequesters(t *testing.T) {
	f := newFinanceFixture(t, "wgf-merge")
	ctx := testContext(t)
	actor, _ := groupPrincipal(t, f.pool, "wgf-merge-actor", mergePermissions...)
	target := insertGroupPerson(t, f.pool, "wgf-merge-target@example.test")
	source := insertGroupPerson(t, f.pool, "wgf-merge-source@example.test")
	mergeExec(t, f.pool, `INSERT INTO working_group_purchases(id, group_id, period_id, item, quantity, unit_price, how, requester_person_id)
		VALUES($1, $2, $3, 'By source', 1, 2, 'self', $4)`, ids.New(), f.group.ID, f.period.ID, source)
	result, err := people.NewService(f.pool, nil).Merge(ctx, actor, people.MergeInput{
		MergeSelection:   people.MergeSelection{TargetPersonID: target, SourcePersonIDs: []uuid.UUID{source}},
		ExpectedVersions: mergeVersions(t, f.pool, target, source),
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	assertCount(t, f.pool, `SELECT count(*) FROM working_group_purchases WHERE requester_person_id = $1`, 1, target)
	var moved int64
	for _, m := range result.Moved {
		if m.Category == people.MergedWorkingGroupTasks {
			moved = m.Count
		}
	}
	if moved != 1 {
		t.Fatalf("working group tasks merged = %d, want 1 (%+v)", moved, result.Moved)
	}
}

func TestSubjectRequestExportHoldsOnlyTheSubjectsPurchases(t *testing.T) {
	f := newFinanceFixture(t, "wgf-export")
	ctx := testContext(t)
	subject := insertGroupPerson(t, f.pool, "wgf-export-subject@example.test")
	mergeExec(t, f.pool, `INSERT INTO working_group_purchases(id, group_id, period_id, item, quantity, unit_price, how, requester_person_id,
		status, decline_reason, declined_at) VALUES($1, $2, $3, 'Subject item', 1, 2, 'self', $4, 'declined', 'Reason written by finance', now())`,
		ids.New(), f.group.ID, f.period.ID, subject)
	mergeExec(t, f.pool, `INSERT INTO working_group_purchases(id, group_id, period_id, item, quantity, unit_price, how, requester_person_id)
		VALUES($1, $2, $3, 'Colleague item', 1, 2, 'self', $4)`, ids.New(), f.group.ID, f.period.ID, f.memberID)
	queries := requestsdb.New(f.pool)
	count, err := queries.CountWorkingGroupFinances(ctx, subject)
	if err != nil || count != 1 {
		t.Fatalf("count = %d, %v", count, err)
	}
	document, err := queries.ExportWorkingGroupFinances(ctx, subject)
	if err != nil {
		t.Fatal(err)
	}
	var export map[string][]map[string]any
	if err := json.Unmarshal(document, &export); err != nil {
		t.Fatal(err)
	}
	if len(export["purchases"]) != 1 || export["purchases"][0]["item"] != "Subject item" || export["purchases"][0]["hasReceipt"] != false ||
		strings.Contains(string(document), "Colleague item") || strings.Contains(string(document), "Reason written by finance") {
		t.Fatalf("export = %s", document)
	}
}

func (f financeFixture) newGroup(t *testing.T, name string) workinggroups.Group {
	t.Helper()
	group, err := f.service.Create(testContext(t), f.manager, workinggroups.CreateInput{Name: name, LeadPersonID: f.leadID}, nil)
	if err != nil {
		t.Fatal(err)
	}
	return group
}

func TestWorkingGroupPeriodTotalIsForFinanceManagersOnly(t *testing.T) {
	f := newFinanceFixture(t, "wgf-total")
	ctx := testContext(t)
	periods, err := f.service.ListPeriods(ctx, f.member)
	if err != nil || len(periods) == 0 {
		t.Fatalf("periods = %+v, %v", periods, err)
	}
	for _, p := range periods {
		if p.TotalAmount != "" {
			t.Fatalf("member sees a total: %+v", p)
		}
	}
	if budget := f.budgetOf(t, f.member); budget.Period.TotalAmount != "" || budget.Totals != nil {
		t.Fatalf("member budget = %+v", budget)
	}
	if budget := f.budgetOf(t, f.finance); budget.Period.TotalAmount != "5000.00" {
		t.Fatalf("finance budget = %+v", budget.Period)
	}
}

func TestWorkingGroupDeleteKeepsBudgetRecords(t *testing.T) {
	f := newFinanceFixture(t, "wgf-gdel")
	ctx := testContext(t)
	both, _ := groupPrincipal(t, f.pool, "wgf-gdel-both", "working_groups.read", "working_groups.manage", "working_group_finances.manage")
	// A share alone is a record: the manage-only holder is refused, a finance manager may delete.
	open := f.newGroup(t, "Open records wgf-gdel")
	if _, err := f.service.SetShare(ctx, f.finance, f.period.ID, open.ID, "10.00", nil); err != nil {
		t.Fatal(err)
	}
	requireAppError(t, f.service.Delete(ctx, f.manager, open.ID, nil), http.StatusConflict, "working_group_has_finances")
	if err := f.service.Delete(ctx, both, open.ID, nil); err != nil {
		t.Fatal(err)
	}
	// Records in a closed period are never deleted with the group.
	closedGroup := f.newGroup(t, "Closed records wgf-gdel")
	if _, err := f.service.SetShare(ctx, f.finance, f.period.ID, closedGroup.ID, "10.00", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.ClosePeriod(ctx, f.finance, f.period.ID, f.period.Version, nil); err != nil {
		t.Fatal(err)
	}
	for _, p := range []authorization.Principal{f.manager, both} {
		requireAppError(t, f.service.Delete(ctx, p, closedGroup.ID, nil), http.StatusConflict, "working_group_has_finances")
	}
	// A group without any record is deleted by the manager as before.
	empty := f.newGroup(t, "Empty wgf-gdel")
	if err := f.service.Delete(ctx, f.manager, empty.ID, nil); err != nil {
		t.Fatal(err)
	}
}

// The first share of a group and the first purchase of a member run at the same time without a deadlock.
func TestWorkingGroupFirstShareAndPurchaseDoNotDeadlock(t *testing.T) {
	f := newFinanceFixture(t, "wgf-dead")
	ctx := testContext(t)
	for i := 0; i < 8; i++ {
		group := f.newGroup(t, "Race "+strings.Repeat("x", i)+" wgf-dead")
		if _, err := f.service.AddMember(ctx, f.manager, group.ID, f.memberID, nil); err != nil {
			t.Fatal(err)
		}
		errs := make(chan error, 2)
		start := make(chan struct{})
		go func() {
			<-start
			_, err := f.service.SetShare(ctx, f.finance, f.period.ID, group.ID, "20.00", nil)
			errs <- err
		}()
		go func() {
			<-start
			_, err := f.service.CreatePurchases(ctx, f.member, workinggroups.CreatePurchasesInput{
				GroupID: group.ID, How: workinggroups.HowSelf, Items: []workinggroups.PurchaseItemInput{{Item: "Race", Quantity: 1, UnitPrice: "1.00"}},
			}, nil)
			errs <- err
		}()
		close(start)
		for j := 0; j < 2; j++ {
			if err := <-errs; err != nil {
				t.Fatalf("round %d: %v", i, err)
			}
		}
	}
}

func TestWorkingGroupRedactionRemovesPersonalDataInAnyStatusAndPeriod(t *testing.T) {
	f := newFinanceFixture(t, "wgf-redact")
	ctx := testContext(t)
	link := "https://shop.example/personal"
	items, err := f.service.CreatePurchases(ctx, f.member, workinggroups.CreatePurchasesInput{
		GroupID: f.group.ID, How: workinggroups.HowSelf, Items: []workinggroups.PurchaseItemInput{{Item: "Name on it", Link: &link, Quantity: 1, UnitPrice: "9.00"}},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	id := items[0].ID
	if _, err := f.service.SetAttachment(ctx, f.member, id, pdfUpload("offer.pdf"), nil); err != nil {
		t.Fatal(err)
	}
	f.approve(t, id)
	if _, err := f.service.HandInReceipt(ctx, f.member, id, workinggroups.ReceiptInput{ExpectedVersion: f.get(t, id).Version, Amount: "8.00", File: pdfUpload("r.pdf")}, nil); err != nil {
		t.Fatal(err)
	}
	var attachment, receipt uuid.UUID
	if err := f.pool.QueryRow(ctx, `SELECT attachment_file_id, receipt_file_id FROM working_group_purchases WHERE id = $1`, id).Scan(&attachment, &receipt); err != nil {
		t.Fatal(err)
	}
	version := f.get(t, id).Version
	// Denials: a member of the group, and the manage-only holder (for whom the purchase does not exist).
	_, err = f.service.RedactPurchase(ctx, f.member, id, version, true, true, nil)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")
	_, err = f.service.RedactPurchase(ctx, f.manager, id, version, true, true, nil)
	requireAppError(t, err, http.StatusNotFound, "")
	_, err = f.service.RedactPurchase(ctx, f.finance, id, version, false, false, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "")
	_, err = f.service.RedactPurchase(ctx, f.finance, id, version+4, true, false, nil)
	requireAppError(t, err, http.StatusConflict, "stale_write")
	before := f.groupFigures(t)

	// Close the period: redaction still works and changes no figure.
	var periodVersion int64
	if err := f.pool.QueryRow(ctx, `SELECT version FROM working_group_budget_periods WHERE id = $1`, f.period.ID).Scan(&periodVersion); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.ClosePeriod(ctx, f.finance, f.period.ID, periodVersion, nil); err != nil {
		t.Fatal(err)
	}
	textOnly, err := f.service.RedactPurchase(ctx, f.finance, id, version, true, false, nil)
	if err != nil || textOnly.Item != "Removed" || textOnly.Link != nil || !textOnly.HasAttachment || !textOnly.HasReceipt {
		t.Fatalf("text redaction = %+v, %v", textOnly, err)
	}
	both, err := f.service.RedactPurchase(ctx, f.finance, id, textOnly.Version, false, true, nil)
	if err != nil || both.HasAttachment || both.HasReceipt || both.ActualTotal == nil || *both.ActualTotal != "8.00" {
		t.Fatalf("file redaction = %+v, %v", both, err)
	}
	assertCount(t, f.pool, `SELECT count(*) FROM files WHERE id = ANY($1)`, 0, []uuid.UUID{attachment, receipt})
	if after := f.groupFigures(t); after != before {
		t.Fatalf("figures changed: %+v -> %+v", before, after)
	}
	assertCount(t, f.pool, `SELECT count(*) FROM audit_events WHERE action = 'working_group_purchase.redacted' AND resource_id = $1`, 2, id)
}

func TestWorkingGroupInvoiceAndBookingRedaction(t *testing.T) {
	f := newFinanceFixture(t, "wgf-redact2")
	ctx := testContext(t)
	purchase := f.buy(t, f.member, workinggroups.HowCentral, "Parts", 1, "10.00")
	f.approve(t, purchase.ID)
	order, err := f.service.CreateOrder(ctx, f.finance, workinggroups.CreateOrderInput{Shop: "ACME", PurchaseIDs: []uuid.UUID{purchase.ID}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.SetOrderInvoice(ctx, f.finance, order.ID, pdfUpload("i.pdf"), nil); err != nil {
		t.Fatal(err)
	}
	var invoice uuid.UUID
	if err := f.pool.QueryRow(ctx, `SELECT invoice_file_id FROM working_group_purchase_orders WHERE id = $1`, order.ID).Scan(&invoice); err != nil {
		t.Fatal(err)
	}
	booking, err := f.service.CreateBooking(ctx, f.finance, workinggroups.CreateBookingInput{
		GroupID: f.group.ID, PeriodID: f.period.ID, Text: "Personal text", Amount: "2.00", BookedOn: time.Now(),
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range []authorization.Principal{f.member, f.manager} {
		requireAppError(t, f.service.RemoveOrderInvoice(ctx, p, order.ID, nil), http.StatusForbidden, "permission_denied")
		_, err := f.service.RedactBooking(ctx, p, booking.ID, nil)
		requireAppError(t, err, http.StatusForbidden, "permission_denied")
	}
	if err := f.service.RemoveOrderInvoice(ctx, f.finance, order.ID, nil); err != nil {
		t.Fatal(err)
	}
	assertCount(t, f.pool, `SELECT count(*) FROM files WHERE id = $1`, 0, invoice)
	requireAppError(t, f.service.RemoveOrderInvoice(ctx, f.finance, order.ID, nil), http.StatusNotFound, "")
	redacted, err := f.service.RedactBooking(ctx, f.finance, booking.ID, nil)
	if err != nil || redacted.Text != "Removed" || redacted.Amount != "2.00" {
		t.Fatalf("redacted = %+v, %v", redacted, err)
	}
	_, err = f.service.RedactBooking(ctx, f.finance, ids.New(), nil)
	requireAppError(t, err, http.StatusNotFound, "")
	// Deleting a booking twice: the second time nothing was deleted.
	if err := f.service.DeleteBooking(ctx, f.finance, booking.ID, nil); err != nil {
		t.Fatal(err)
	}
	requireAppError(t, f.service.DeleteBooking(ctx, f.finance, booking.ID, nil), http.StatusNotFound, "")
	assertCount(t, f.pool, `SELECT count(*) FROM audit_events WHERE action = 'working_group_booking.deleted' AND resource_id = $1`, 1, booking.ID)
}

func TestWorkingGroupAttachmentOnlyWhileWantedAndOrdersAreCapped(t *testing.T) {
	f := newFinanceFixture(t, "wgf-cap")
	ctx := testContext(t)
	purchase := f.buy(t, f.member, workinggroups.HowCentral, "Parts", 1, "10.00")
	f.approve(t, purchase.ID)
	_, err := f.service.SetAttachment(ctx, f.member, purchase.ID, pdfUpload("late.pdf"), nil)
	requireAppError(t, err, http.StatusConflict, "working_group_purchase_state")

	mergeExec(t, f.pool, `INSERT INTO working_group_purchase_orders (id, period_id, shop, total_amount, created_at)
		SELECT uuidv7(), $1, 'bulk', 1, now() + make_interval(secs => g) FROM generate_series(1, 201) g`, f.period.ID)
	t.Cleanup(func() { _, _ = f.pool.Exec(ctx, `DELETE FROM working_group_purchase_orders WHERE shop = 'bulk'`) })
	listed, truncated, err := f.service.ListOrders(ctx, f.finance)
	if err != nil || len(listed) != workinggroups.MaxOrderListRows || !truncated {
		t.Fatalf("orders = %d truncated %v, %v", len(listed), truncated, err)
	}
}

// A malformed receipt header is refused before anything is read, and a well-formed one for an unknown purchase is a 404.
func TestWorkingGroupReceiptHeadersOverHTTP(t *testing.T) {
	h := newCashRegisterHTTP(t)
	send := func(amount, version string, withName bool) int {
		t.Helper()
		request, err := http.NewRequestWithContext(testContext(t), http.MethodPost,
			h.server.URL+"/api/v1/working-group-purchases/"+ids.New().String()+"/receipt", strings.NewReader("%PDF-1.4"))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Origin", h.origin)
		request.Header.Set("X-CSRF-Token", h.csrf)
		request.Header.Set("Content-Type", "application/octet-stream")
		if withName {
			request.Header.Set("X-File-Name", "r.pdf")
		}
		request.Header.Set("X-File-Content-Type", "application/pdf")
		request.Header.Set("X-Receipt-Amount", amount)
		request.Header.Set("X-Expected-Version", version)
		response, err := h.client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		return response.StatusCode
	}
	for _, bad := range [][2]string{{"12,5", "1"}, {"-1", "1"}, {"1.234", "1"}, {"10", "abc"}, {"10", "0"}} {
		if status := send(bad[0], bad[1], true); status != http.StatusBadRequest && status != http.StatusUnprocessableEntity {
			t.Fatalf("amount %q version %q: status %d", bad[0], bad[1], status)
		}
	}
	if status := send("10.00", "1", false); status != http.StatusBadRequest {
		t.Fatalf("missing file name: status %d", status)
	}
	if status := send("10.00", "1", true); status != http.StatusNotFound {
		t.Fatalf("unknown purchase: status %d", status)
	}
}
