package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"strings"
	"sync"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/invoicing"
	mailservice "github.com/Basmatireis/Makerspace-Core/backend/internal/mail"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/people"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	requestsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/subjectrequests/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/workinggroups"
	"github.com/google/uuid"
)

type sentMail struct {
	subject     string
	paragraphs  []string
	attachments []mailservice.Attachment
}

// wirefStub records the messages the service sends to the wiRef address.
type wirefStub struct {
	mu   sync.Mutex
	sent []sentMail
	fail bool
}

func (s *wirefStub) SendMessage(_ context.Context, subject string, paragraphs []string, attachments []mailservice.Attachment) invoicing.Outcome {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fail {
		return invoicing.Outcome{Status: invoicing.DeliveryFailed, FailureCode: "send_failed"}
	}
	s.sent = append(s.sent, sentMail{subject, paragraphs, attachments})
	return invoicing.Outcome{Status: invoicing.DeliverySent}
}

func (s *wirefStub) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.sent)
}

func (m sentMail) names() []string {
	out := make([]string, 0, len(m.attachments))
	for _, a := range m.attachments {
		out = append(out, a.Name)
	}
	return out
}

func (m sentMail) attachment(name string) []byte {
	for _, a := range m.attachments {
		if a.Name == name {
			return a.Data
		}
	}
	return nil
}

type projectFixture struct {
	financeFixture
	mail      *wirefStub
	signature []byte
}

func newProjectFixture(t *testing.T, tag string) projectFixture {
	t.Helper()
	f := projectFixture{financeFixture: newFinanceFixture(t, tag), mail: &wirefStub{}}
	f.service.WithWiRefMailer(f.mail)
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 8, 4))); err != nil {
		t.Fatal(err)
	}
	f.signature = buf.Bytes()
	return f
}

func is(t *testing.T, err error, want error) {
	t.Helper()
	if !errors.Is(err, want) {
		t.Fatalf("error = %v, want %v", err, want)
	}
}

func (f projectFixture) project(t *testing.T, title, itemAmount string) workinggroups.Project {
	t.Helper()
	ctx := testContext(t)
	p, err := f.service.CreateProject(ctx, f.lead, workinggroups.CreateProjectInput{
		GroupID: f.group.ID,
		ProjectFields: workinggroups.ProjectFields{
			Title: title, Goal: "Build it", Benefit: "Everybody gains", People: 3, PlannedIncome: "0",
		},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	p, err = f.service.CreateProjectItem(ctx, f.lead, p.ID, workinggroups.ProjectItemInput{Text: "Part", PlannedAmount: itemAmount}, nil)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

// planned adds a planned purchase with a link to the first item of the project.
func (f projectFixture) planned(t *testing.T, p workinggroups.Project, price string) workinggroups.Purchase {
	t.Helper()
	link := "https://shop.example/part"
	items, err := f.service.CreatePurchases(testContext(t), f.member, workinggroups.CreatePurchasesInput{
		GroupID: f.group.ID, How: workinggroups.HowSelf, ProjectID: &p.ID, ProjectItemID: &p.Items[0].ID,
		Items: []workinggroups.PurchaseItemInput{{Item: "Part", Link: &link, Quantity: 1, UnitPrice: price}},
	}, nil)
	if err != nil || len(items) != 1 {
		t.Fatalf("planned purchase: %v", err)
	}
	return items[0]
}

func (f projectFixture) get(t *testing.T, id uuid.UUID) workinggroups.Project {
	t.Helper()
	p, err := f.service.GetProject(testContext(t), f.finance, id)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func (f projectFixture) submit(t *testing.T, p workinggroups.Project) workinggroups.Project {
	t.Helper()
	p, err := f.service.SubmitProject(testContext(t), f.lead, p.ID, p.Version, nil)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func (f projectFixture) approve(t *testing.T, p workinggroups.Project, paidFrom string) workinggroups.Project {
	t.Helper()
	p, err := f.service.ApproveProject(testContext(t), f.finance, p.ID, workinggroups.ApproveProjectInput{
		ExpectedVersion: p.Version, PaidFrom: paidFrom, Form: workinggroups.RequestFormInput{Signature: f.signature},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestWorkingGroupProjectsAreVisibleToMembersAndFinanceManagersOnly(t *testing.T) {
	f := newProjectFixture(t, "wgp-vis")
	ctx := testContext(t)
	p := f.project(t, "Visible", "50")
	for name, who := range map[string]authorization.Principal{"outsider": f.outsider, "manager": f.manager} {
		_, err := f.service.GetProject(ctx, who, p.ID)
		is(t, err, apperror.NotFound)
		list, _, err := f.service.ListProjects(ctx, who, workinggroups.ProjectFilter{})
		if err != nil || len(list) != 0 {
			t.Fatalf("%s sees %d projects (%v)", name, len(list), err)
		}
		is(t, f.service.DeleteProject(ctx, who, p.ID, nil), apperror.NotFound)
		_, err = f.service.CreateProject(ctx, who, workinggroups.CreateProjectInput{GroupID: f.group.ID, ProjectFields: workinggroups.ProjectFields{Title: "x", People: 1, PlannedIncome: "0"}}, nil)
		is(t, err, apperror.NotFound)
	}
	list, truncated, err := f.service.ListProjects(ctx, f.finance, workinggroups.ProjectFilter{GroupID: &f.group.ID})
	if err != nil || len(list) != 1 || truncated || len(list[0].Items) != 0 {
		t.Fatalf("finance list = %d %v %v", len(list), truncated, err)
	}
	if _, err := f.service.GetProject(ctx, f.member, p.ID); err != nil {
		t.Fatal(err)
	}
	// Without working_groups.read nothing is reachable.
	noRead, _ := groupPrincipal(t, f.pool, "wgp-vis-noread")
	_, err = f.service.GetProject(ctx, noRead, p.ID)
	is(t, err, apperror.PermissionDenied)
	// A finance manager who is no member may not start a project.
	_, err = f.service.CreateProject(ctx, f.finance, workinggroups.CreateProjectInput{GroupID: f.group.ID, ProjectFields: workinggroups.ProjectFields{Title: "x", People: 1, PlannedIncome: "0"}}, nil)
	is(t, err, apperror.PermissionDenied)
	assertCount(t, f.pool, `SELECT count(*) FROM audit_events WHERE action = 'working_group_project.created' AND resource_id = $1`, 1, p.ID)
}

func TestWorkingGroupProjectDenialsPerOperation(t *testing.T) {
	f := newProjectFixture(t, "wgp-deny")
	ctx := testContext(t)
	p := f.project(t, "Denials", "50")
	input := workinggroups.UpdateProjectInput{ExpectedVersion: p.Version, ProjectFields: workinggroups.ProjectFields{Title: "x", People: 1, PlannedIncome: "0"}}
	// A plain member may neither edit the fields nor hand in, decide, complete or change the cost plan.
	_, err := f.service.UpdateProject(ctx, f.member, p.ID, input, nil)
	is(t, err, apperror.PermissionDenied)
	_, err = f.service.SubmitProject(ctx, f.member, p.ID, p.Version, nil)
	is(t, err, apperror.PermissionDenied)
	_, err = f.service.CreateProjectItem(ctx, f.member, p.ID, workinggroups.ProjectItemInput{Text: "x", PlannedAmount: "1"}, nil)
	is(t, err, apperror.PermissionDenied)
	is(t, f.service.PutFinanceSignature(ctx, f.lead, workinggroups.FileUpload{Filename: "s.png", ContentType: "image/png", Data: f.signature}, nil), apperror.PermissionDenied)
	// The lead is no finance manager.
	for name, call := range map[string]func() error{
		"return":  func() error { _, err := f.service.ReturnProject(ctx, f.lead, p.ID, p.Version, "no", nil); return err },
		"decline": func() error { _, err := f.service.DeclineProject(ctx, f.lead, p.ID, p.Version, "no", nil); return err },
		"approve": func() error {
			_, err := f.service.ApproveProject(ctx, f.lead, p.ID, workinggroups.ApproveProjectInput{ExpectedVersion: p.Version, PaidFrom: "group"}, nil)
			return err
		},
		"decision": func() error {
			_, err := f.service.RecordWiRefDecision(ctx, f.lead, p.ID, workinggroups.WiRefDecisionInput{ExpectedVersion: p.Version, Number: "PA"}, nil)
			return err
		},
		"paid": func() error {
			_, err := f.service.SetProjectPaidFrom(ctx, f.lead, p.ID, p.Version, "external", "", nil)
			return err
		},
		"send": func() error { _, err := f.service.SendProjectToWiRef(ctx, f.lead, p.ID, p.Version, nil); return err },
		"advance": func() error {
			_, err := f.service.MarkProjectAdvanceReceived(ctx, f.lead, p.ID, p.Version, nil)
			return err
		},
		"preview": func() error {
			_, err := f.service.PreviewProjectRequest(ctx, f.lead, p.ID, workinggroups.RequestFormInput{})
			return err
		},
		"pdf": func() error { _, _, err := f.service.OpenProjectRequestPDF(ctx, f.lead, p.ID); return err },
	} {
		if err := call(); !errors.Is(err, apperror.PermissionDenied) {
			t.Fatalf("%s by the lead: %v", name, err)
		}
	}
	// A member who is no lead may not complete; outsiders see nothing.
	_, err = f.service.CompleteProject(ctx, f.member, p.ID, p.Version, "", nil)
	is(t, err, apperror.PermissionDenied)
	_, err = f.service.CompleteProject(ctx, f.outsider, p.ID, p.Version, "", nil)
	is(t, err, apperror.NotFound)
	// Wrong state is a conflict, a stale version too.
	_, err = f.service.CompleteProject(ctx, f.lead, p.ID, p.Version, "", nil)
	if !apperror.IsCode(err, "working_group_project_state") {
		t.Fatalf("complete a draft: %v", err)
	}
	_, err = f.service.UpdateProject(ctx, f.lead, p.ID, workinggroups.UpdateProjectInput{ExpectedVersion: p.Version + 5, ProjectFields: input.ProjectFields}, nil)
	is(t, err, apperror.StaleWrite)
}

func TestWorkingGroupProjectChecklistGuardsTheHandIn(t *testing.T) {
	f := newProjectFixture(t, "wgp-check")
	ctx := testContext(t)
	p, err := f.service.CreateProject(ctx, f.lead, workinggroups.CreateProjectInput{
		GroupID: f.group.ID, ProjectFields: workinggroups.ProjectFields{Title: "Open", People: 2, PlannedIncome: "0"},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.service.SubmitProject(ctx, f.lead, p.ID, p.Version, nil)
	var app *apperror.Error
	if !errors.As(err, &app) || app.Code != "project_checklist_open" {
		t.Fatalf("submit: %v", err)
	}
	open, _ := app.Details["open"].([]string)
	if len(open) != 3 || open[0] != "goal_missing" || open[1] != "benefit_missing" || open[2] != "items_missing" {
		t.Fatalf("open = %v", open)
	}
	p, err = f.service.UpdateProject(ctx, f.lead, p.ID, workinggroups.UpdateProjectInput{
		ExpectedVersion: p.Version, ProjectFields: workinggroups.ProjectFields{Title: "Open", Goal: "g", Benefit: "b", People: 2, PlannedIncome: "0"},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	// An item below the offers threshold needs a purchase with a link or a file.
	p, err = f.service.CreateProjectItem(ctx, f.lead, p.ID, workinggroups.ProjectItemInput{Text: "Small", PlannedAmount: "40"}, nil)
	if err != nil || p.Checklist.Complete || len(p.Checklist.Open) != 1 || !strings.HasPrefix(p.Checklist.Open[0], "item_needs_purchase:") {
		t.Fatalf("checklist = %+v %v", p.Checklist, err)
	}
	f.planned(t, p, "40")
	p = f.get(t, p.ID)
	if !p.Checklist.Complete {
		t.Fatalf("checklist = %+v", p.Checklist)
	}
	// An item at the offers threshold needs three offers and no purchase.
	p, err = f.service.CreateProjectItem(ctx, f.lead, p.ID, workinggroups.ProjectItemInput{Text: "Big", PlannedAmount: "600"}, nil)
	if err != nil || p.Checklist.Complete || !strings.HasPrefix(p.Checklist.Open[0], "item_needs_offers:") {
		t.Fatalf("checklist = %+v %v", p.Checklist, err)
	}
	big := p.Items[1].ID
	for i, shop := range []string{"A", "B", "C"} {
		if p, err = f.service.CreateProjectOffer(ctx, f.lead, p.ID, big, workinggroups.ProjectOfferInput{Shop: shop, Price: []string{"600", "620", "640"}[i]}, nil); err != nil {
			t.Fatal(err)
		}
	}
	if !p.Checklist.Complete {
		t.Fatalf("checklist = %+v", p.Checklist)
	}
	if p = f.submit(t, p); p.Status != workinggroups.ProjectSubmitted {
		t.Fatalf("status = %s", p.Status)
	}
	// Once submitted the lead cannot edit; a finance manager returns it and the lead can edit again.
	_, err = f.service.CreateProjectItem(ctx, f.lead, p.ID, workinggroups.ProjectItemInput{Text: "More", PlannedAmount: "1"}, nil)
	if !apperror.IsCode(err, "working_group_project_state") {
		t.Fatalf("edit after hand-in: %v", err)
	}
	_, err = f.service.ReturnProject(ctx, f.finance, p.ID, p.Version, "", nil)
	if !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("return without reason: %v", err)
	}
	p, err = f.service.ReturnProject(ctx, f.finance, p.ID, p.Version, "Please add details", nil)
	if err != nil || p.Status != workinggroups.ProjectReturned || len(p.History) < 3 || p.History[len(p.History)-1].Reason != "Please add details" {
		t.Fatalf("return: %+v %v", p, err)
	}
	if _, err = f.service.CreateProjectItem(ctx, f.lead, p.ID, workinggroups.ProjectItemInput{Text: "More", PlannedAmount: "1"}, nil); err != nil {
		t.Fatal(err)
	}
}

func TestWorkingGroupProjectWithoutWiRefRunsAndApprovesItsPlannedPurchases(t *testing.T) {
	f := newProjectFixture(t, "wgp-run")
	ctx := testContext(t)
	p := f.project(t, "Small", "80")
	pu := f.planned(t, p, "80")
	if pu.Status != workinggroups.PurchasePlanned || pu.ProjectID == nil {
		t.Fatalf("purchase = %+v", pu)
	}
	// Planned purchases count in no figure and cannot be approved on their own.
	if g := f.groupFigures(t); g.Reserved != "0.00" {
		t.Fatalf("figures = %+v", g)
	}
	_, err := f.service.ApprovePurchase(ctx, f.finance, pu.ID, pu.Version, nil)
	if !apperror.IsCode(err, "working_group_purchase_state") {
		t.Fatalf("approve planned: %v", err)
	}
	p = f.submit(t, f.get(t, p.ID))
	p = f.approve(t, p, workinggroups.PaidFromGroup)
	if p.Status != workinggroups.ProjectRunning || p.WiRefNeeded || f.mail.count() != 0 || p.RequestForm == nil {
		t.Fatalf("project = %+v mails %d", p, f.mail.count())
	}
	if got := f.getPurchase(t, pu.ID); got.Status != workinggroups.PurchaseApproved {
		t.Fatalf("purchase status = %s", got.Status)
	}
	// The purchase is counted once: its 80 are reserved by the purchase, the project adds nothing on top.
	if g := f.groupFigures(t); g.Reserved != "80.00" {
		t.Fatalf("figures = %+v", g)
	}
	// The project threshold does not apply to purchases of a running project.
	link := "https://shop.example/big"
	big, err := f.service.CreatePurchases(ctx, f.member, workinggroups.CreatePurchasesInput{
		GroupID: f.group.ID, How: workinggroups.HowSelf, ProjectID: &p.ID,
		Items: []workinggroups.PurchaseItemInput{{Item: "Big", Link: &link, Quantity: 1, UnitPrice: "250"}},
	}, nil)
	if err != nil || big[0].NeedsProject {
		t.Fatalf("running project purchase: %+v %v", big, err)
	}
	if _, err := f.service.ApprovePurchase(ctx, f.finance, big[0].ID, big[0].Version, nil); err != nil {
		t.Fatalf("approve in a running project: %v", err)
	}
	// Without the project the same purchase is refused.
	plain := f.buy(t, f.member, workinggroups.HowSelf, "Plain big", 1, "250")
	_, err = f.service.ApprovePurchase(ctx, f.finance, plain.ID, plain.Version, nil)
	if !apperror.IsCode(err, "purchase_needs_project") {
		t.Fatalf("plain: %v", err)
	}
	// Complete: only the lead or a finance manager.
	p = f.get(t, p.ID)
	p, err = f.service.CompleteProject(ctx, f.lead, p.ID, p.Version, "Done and dusted", nil)
	if err != nil || p.Status != workinggroups.ProjectCompleted || p.CompletionReport != "Done and dusted" {
		t.Fatalf("complete: %+v %v", p, err)
	}
	for _, action := range []string{"approved", "completed"} {
		assertCount(t, f.pool, `SELECT count(*) FROM audit_events WHERE resource_id = $1 AND action = 'working_group_project.'||$2`, 1, p.ID, action)
	}
}

func (f projectFixture) getPurchase(t *testing.T, id uuid.UUID) workinggroups.Purchase {
	t.Helper()
	return f.financeFixture.get(t, id)
}

func TestWorkingGroupProjectNeedingTheWiRefSendsOneMailAndRecordsTheDecision(t *testing.T) {
	f := newProjectFixture(t, "wgp-wiref")
	ctx := testContext(t)
	p, err := f.service.CreateProject(ctx, f.lead, workinggroups.CreateProjectInput{
		GroupID: f.group.ID, ProjectFields: workinggroups.ProjectFields{
			Title: "Big plan", Goal: "g", Benefit: "b", People: 4, PlannedIncome: "10", AdvanceRequested: true,
		},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	p, err = f.service.CreateProjectItem(ctx, f.lead, p.ID, workinggroups.ProjectItemInput{Text: "Machine", PlannedAmount: "900"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	item := p.Items[0].ID
	var offers []uuid.UUID
	for i, shop := range []string{"A", "B", "C"} {
		if p, err = f.service.CreateProjectOffer(ctx, f.lead, p.ID, item, workinggroups.ProjectOfferInput{Shop: shop, Price: []string{"900", "850", "950"}[i]}, nil); err != nil {
			t.Fatal(err)
		}
		offers = append(offers, p.Items[0].Offers[i].ID)
	}
	p, err = f.service.SetProjectOfferFile(ctx, f.lead, p.ID, offers[1], pdfUpload("offer-b.pdf"), nil)
	if err != nil || !p.Items[0].Offers[1].HasFile {
		t.Fatalf("offer file: %v", err)
	}
	if p = f.submit(t, p); !p.WiRefNeeded {
		t.Fatal("a planned total above the project threshold needs the wiRef")
	}
	// A project that needs the wiRef cannot be approved without a signature.
	_, err = f.service.ApproveProject(ctx, f.finance, p.ID, workinggroups.ApproveProjectInput{ExpectedVersion: p.Version, PaidFrom: workinggroups.PaidFromGroup}, nil)
	if !apperror.IsCode(err, "signature_required") {
		t.Fatalf("approve without signature: %v", err)
	}
	p = f.approve(t, p, workinggroups.PaidFromGroup)
	if p.Status != workinggroups.ProjectWiRef || p.WiRefRequestPending || !p.HasRequestPDF || f.mail.count() != 1 {
		t.Fatalf("project = %+v mails %d", p, f.mail.count())
	}
	mail := f.mail.sent[0]
	if mail.subject != "Projektantrag: Big plan" {
		t.Fatalf("subject = %q", mail.subject)
	}
	names := strings.Join(mail.names(), "|")
	for _, want := range []string{"Projektantrag.pdf", "Vorschussantrag.pdf", "Cost plan.pdf", "Purchases.pdf", "offer-b.pdf"} {
		if !strings.Contains(names, want) {
			t.Fatalf("attachments %q lack %s", names, want)
		}
	}
	for _, name := range []string{"Projektantrag.pdf", "Vorschussantrag.pdf", "Cost plan.pdf", "Purchases.pdf"} {
		if !bytes.HasPrefix(mail.attachment(name), []byte("%PDF")) {
			t.Fatalf("%s is not a PDF", name)
		}
	}
	file, reader, err := f.service.OpenProjectRequestPDF(ctx, f.finance, p.ID)
	if err != nil || !strings.HasPrefix(readAll(t, reader), "%PDF") || file.Size == 0 {
		t.Fatalf("request pdf: %v", err)
	}
	// Only finance managers see the stored form.
	member := mustGet(t, f, f.member, p.ID)
	if member.RequestForm != nil || p.RequestForm == nil {
		t.Fatalf("request form visibility: member %v finance %v", member.RequestForm, p.RequestForm)
	}
	// Sending again is refused: it was sent.
	_, err = f.service.SendProjectToWiRef(ctx, f.finance, p.ID, p.Version, nil)
	if !apperror.IsCode(err, "wiref_request_not_pending") {
		t.Fatalf("send again: %v", err)
	}
	// The advance can be recorded once.
	if p, err = f.service.MarkProjectAdvanceReceived(ctx, f.finance, p.ID, p.Version, nil); err != nil || p.AdvanceStatus == nil || *p.AdvanceStatus != "received" {
		t.Fatalf("advance: %v", err)
	}
	// The decision: every item with offers needs the chosen one; the amount becomes its price.
	_, err = f.service.RecordWiRefDecision(ctx, f.finance, p.ID, workinggroups.WiRefDecisionInput{ExpectedVersion: p.Version, Number: "PA-2026-114"}, nil)
	if !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("decision without a chosen offer: %v", err)
	}
	p, err = f.service.RecordWiRefDecision(ctx, f.finance, p.ID, workinggroups.WiRefDecisionInput{
		ExpectedVersion: p.Version, Number: "PA-2026-114", ChosenOffers: []workinggroups.ChosenOffer{{ItemID: item, OfferID: offers[1]}},
	}, nil)
	if err != nil || p.Status != workinggroups.ProjectRunning || p.WiRefNumber != "PA-2026-114" ||
		p.Items[0].ChosenOfferID == nil || *p.Items[0].ChosenOfferID != offers[1] || p.Items[0].PlannedAmount != "850.00" || p.Totals.Planned != "850.00" {
		t.Fatalf("decision: %+v %v", p, err)
	}
	// A group-paid running project reserves its planned total in the budget.
	if g := f.groupFigures(t); g.Reserved != "850.00" {
		t.Fatalf("figures = %+v", g)
	}
	// Paid from external: nothing is counted in the group budget.
	p, err = f.service.SetProjectPaidFrom(ctx, f.finance, p.ID, p.Version, workinggroups.PaidFromExternal, "HTU pays", nil)
	if err != nil || p.WiRefRequestPending {
		t.Fatalf("paid from: %+v %v", p, err)
	}
	if g := f.groupFigures(t); g.Reserved != "0.00" {
		t.Fatalf("external figures = %+v", g)
	}
	if f.mail.count() != 1 {
		t.Fatalf("mails = %d", f.mail.count())
	}
}

func mustGet(t *testing.T, f projectFixture, who authorization.Principal, id uuid.UUID) workinggroups.Project {
	t.Helper()
	p, err := f.service.GetProject(testContext(t), who, id)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestWorkingGroupProjectPaidFromChangeLeavesTheRequestPendingUntilSent(t *testing.T) {
	f := newProjectFixture(t, "wgp-paid")
	ctx := testContext(t)
	p := f.project(t, "Pending", "60")
	f.planned(t, p, "60")
	p = f.approve(t, f.submit(t, f.get(t, p.ID)), workinggroups.PaidFromGroup)
	if p.Status != workinggroups.ProjectRunning || f.mail.count() != 0 {
		t.Fatalf("project = %+v", p)
	}
	_, err := f.service.SetProjectPaidFrom(ctx, f.finance, p.ID, p.Version-1, workinggroups.PaidFromExternal, "", nil)
	is(t, err, apperror.StaleWrite)
	p, err = f.service.SetProjectPaidFrom(ctx, f.finance, p.ID, p.Version, workinggroups.PaidFromExternal, "", nil)
	if err != nil || !p.WiRefNeeded || !p.WiRefRequestPending {
		t.Fatalf("paid from: %+v %v", p, err)
	}
	// A failing mail leaves it pending.
	f.mail.fail = true
	_, err = f.service.SendProjectToWiRef(ctx, f.finance, p.ID, p.Version, nil)
	if !apperror.IsCode(err, "wiref_delivery_failed") {
		t.Fatalf("failed send: %v", err)
	}
	f.mail.fail = false
	p, err = f.service.SendProjectToWiRef(ctx, f.finance, p.ID, p.Version, nil)
	if err != nil || p.WiRefRequestPending || f.mail.count() != 1 || !bytes.HasPrefix(f.mail.sent[0].attachment("Projektantrag.pdf"), []byte("%PDF")) {
		t.Fatalf("send: %+v %v mails %d", p, err, f.mail.count())
	}
	assertCount(t, f.pool, `SELECT count(*) FROM audit_events WHERE resource_id = $1 AND action = 'working_group_project.request_sent'`, 1, p.ID)
}

func TestWorkingGroupPurchaseConvertsToAProject(t *testing.T) {
	f := newProjectFixture(t, "wgp-conv")
	ctx := testContext(t)
	purchase := f.buy(t, f.member, workinggroups.HowSelf, "Laser tube", 1, "400")
	if !purchase.NeedsProject {
		t.Fatal("expected a purchase that needs a project")
	}
	_, err := f.service.ConvertPurchaseToProject(ctx, f.third, purchase.ID, purchase.Version, nil)
	is(t, err, apperror.PermissionDenied)
	_, err = f.service.ConvertPurchaseToProject(ctx, f.outsider, purchase.ID, purchase.Version, nil)
	is(t, err, apperror.NotFound)
	p, err := f.service.ConvertPurchaseToProject(ctx, f.member, purchase.ID, purchase.Version, nil)
	if err != nil || p.Status != workinggroups.ProjectDraft || len(p.Items) != 1 || p.Items[0].PlannedAmount != "400.00" ||
		len(p.Items[0].Purchases) != 1 || p.Items[0].Purchases[0].Status != workinggroups.PurchasePlanned || p.Title != "Laser tube" {
		t.Fatalf("convert: %+v %v", p, err)
	}
	if got := f.getPurchase(t, purchase.ID); got.Status != workinggroups.PurchasePlanned || got.ProjectID == nil || *got.ProjectID != p.ID {
		t.Fatalf("purchase = %+v", got)
	}
	_, err = f.service.ConvertPurchaseToProject(ctx, f.member, purchase.ID, purchase.Version+1, nil)
	if err == nil {
		t.Fatal("a converted purchase cannot be converted again")
	}
}

func TestWorkingGroupFinanceSignatureAndRequestDefaults(t *testing.T) {
	f := newProjectFixture(t, "wgp-sig")
	ctx := testContext(t)
	up := workinggroups.FileUpload{Filename: "s.png", ContentType: "image/png", Data: f.signature}
	if err := f.service.PutFinanceSignature(ctx, f.finance, up, nil); err != nil {
		t.Fatal(err)
	}
	if err := f.service.PutFinanceSignature(ctx, f.finance, workinggroups.FileUpload{Filename: "s.png", ContentType: "image/png", Data: []byte("nope")}, nil); err == nil {
		t.Fatal("a non-PNG signature must be refused")
	}
	// Only the owner reads it.
	other, _ := groupPrincipal(t, f.pool, "wgp-sig-second", "working_groups.read", "working_group_finances.manage")
	_, _, err := f.service.OpenFinanceSignature(ctx, other)
	is(t, err, apperror.NotFound)
	_, reader, err := f.service.OpenFinanceSignature(ctx, f.finance)
	if err != nil || !strings.HasPrefix(readAll(t, reader), "\x89PNG") {
		t.Fatalf("own signature: %v", err)
	}
	// The saved signature is used when the approval asks for it.
	p := f.project(t, "Saved", "700")
	for i, shop := range []string{"A", "B", "C"} {
		var err error
		if p, err = f.service.CreateProjectOffer(ctx, f.lead, p.ID, p.Items[0].ID, workinggroups.ProjectOfferInput{Shop: shop, Price: []string{"700", "710", "720"}[i]}, nil); err != nil {
			t.Fatal(err)
		}
	}
	p = f.submit(t, p)
	p, err = f.service.ApproveProject(ctx, f.finance, p.ID, workinggroups.ApproveProjectInput{
		ExpectedVersion: p.Version, PaidFrom: workinggroups.PaidFromExternal, Form: workinggroups.RequestFormInput{UseSavedSignature: true},
	}, nil)
	if err != nil || p.Status != workinggroups.ProjectWiRef || f.mail.count() != 1 {
		t.Fatalf("approve with the saved signature: %+v %v", p, err)
	}
	if err := f.service.DeleteFinanceSignature(ctx, f.finance, nil); err != nil {
		t.Fatal(err)
	}
	is(t, f.service.DeleteFinanceSignature(ctx, f.finance, nil), apperror.NotFound)
	// The defaults: the responsible person must hold the finance permission.
	rules, err := f.service.GetRules(ctx, f.finance)
	if err != nil {
		t.Fatal(err)
	}
	var fin uuid.UUID
	if err := f.pool.QueryRow(ctx, `SELECT person_id FROM accounts WHERE id = $1`, f.finance.AccountID).Scan(&fin); err != nil {
		t.Fatal(err)
	}
	in := workinggroups.FinanceRulesInput{
		ExpectedVersion: rules.Version, ProjectThreshold: "100", OffersThreshold: "500",
		Request: &workinggroups.RequestDefaultsInput{UnitKind: "uv", UnitName: "HTU Studi-Lab", AddGroupName: true, ResponsiblePersonID: &f.memberID, Place: "Graz"},
	}
	_, err = f.service.SetRules(ctx, f.finance, in, nil)
	if !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("responsible person without the permission: %v", err)
	}
	in.Request.ResponsiblePersonID = &fin
	rules, err = f.service.SetRules(ctx, f.finance, in, nil)
	if err != nil || rules.Request.UnitKind != "uv" || rules.Request.ResponsiblePerson == nil || rules.Request.Place != "Graz" {
		t.Fatalf("rules: %+v %v", rules, err)
	}
	pdf, err := f.service.PreviewProjectRequest(ctx, f.finance, p.ID, workinggroups.RequestFormInput{})
	if err != nil || !bytes.HasPrefix(pdf, []byte("%PDF")) {
		t.Fatalf("preview: %v", err)
	}
	mergeExec(t, f.pool, `UPDATE working_group_finance_rules SET request_responsible_person_id = NULL`)
}

func TestPeopleMergeMovesWorkingGroupProjectRequesters(t *testing.T) {
	f := newProjectFixture(t, "wgp-merge")
	ctx := testContext(t)
	actor, _ := groupPrincipal(t, f.pool, "wgp-merge-actor", mergePermissions...)
	target := insertGroupPerson(t, f.pool, "wgp-merge-target@example.test")
	source := insertGroupPerson(t, f.pool, "wgp-merge-source@example.test")
	project := ids.New()
	mergeExec(t, f.pool, `INSERT INTO working_group_projects(id, group_id, title, requester_person_id) VALUES($1, $2, 'By source', $3)`, project, f.group.ID, source)
	mergeExec(t, f.pool, `INSERT INTO working_group_project_history(id, project_id, status, actor_person_id) VALUES($1, $2, 'draft', $3)`, ids.New(), project, source)
	if _, err := f.pool.Exec(ctx, `INSERT INTO working_group_finance_signatures(person_id, file_id) SELECT $1, id FROM files LIMIT 1`, source); err != nil {
		t.Logf("no file to point a signature at: %v", err)
	}
	if _, err := people.NewService(f.pool, nil).Merge(ctx, actor, people.MergeInput{
		MergeSelection:   people.MergeSelection{TargetPersonID: target, SourcePersonIDs: []uuid.UUID{source}},
		ExpectedVersions: mergeVersions(t, f.pool, target, source),
	}, nil); err != nil {
		t.Fatal(err)
	}
	assertCount(t, f.pool, `SELECT count(*) FROM working_group_projects WHERE requester_person_id = $1`, 1, target)
	assertCount(t, f.pool, `SELECT count(*) FROM working_group_project_history WHERE actor_person_id = $1`, 1, target)
}

func TestSubjectRequestExportHoldsTheSubjectsProjects(t *testing.T) {
	f := newProjectFixture(t, "wgp-export")
	ctx := testContext(t)
	subject := insertGroupPerson(t, f.pool, "wgp-export-subject@example.test")
	mergeExec(t, f.pool, `INSERT INTO working_group_projects(id, group_id, title, goal, requester_person_id) VALUES($1, $2, 'Subject project', 'Own goal', $3)`, ids.New(), f.group.ID, subject)
	mergeExec(t, f.pool, `INSERT INTO working_group_projects(id, group_id, title, requester_person_id) VALUES($1, $2, 'Colleague project', $3)`, ids.New(), f.group.ID, f.memberID)
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
	if len(export["projects"]) != 1 || export["projects"][0]["title"] != "Subject project" || strings.Contains(string(document), "Colleague project") {
		t.Fatalf("export = %s", document)
	}
}
