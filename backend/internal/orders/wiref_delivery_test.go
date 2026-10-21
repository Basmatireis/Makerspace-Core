package orders

import (
	"bytes"
	"context"
	"strings"
	"sync"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/invoicing"
	mailservice "github.com/Basmatireis/Makerspace-Core/backend/internal/mail"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifications"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type authorizationPrincipal = authorization.Principal

func newKey() uuid.UUID { return ids.New() }

// recordingDelivery replaces the invoicing service. While it is called it tries to lock the request row without
// waiting: that only succeeds when the forwarding transaction has committed and nothing holds a lock.
type recordingDelivery struct {
	mu        sync.Mutex
	pool      *pgxpool.Pool
	documents []invoicing.Document
	outcome   invoicing.Outcome
	lockErr   error
}

func (d *recordingDelivery) Deliver(ctx context.Context, document invoicing.Document) invoicing.Outcome {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.documents = append(d.documents, document)
	tx, err := d.pool.Begin(ctx)
	if err == nil {
		defer func() { _ = tx.Rollback(ctx) }()
		_, d.lockErr = tx.Exec(ctx,
			"SELECT 1 FROM external_invoice_requests WHERE reference=$1 FOR UPDATE NOWAIT", document.RequestNumber)
	}
	return d.outcome
}

func (d *recordingDelivery) calls() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return len(d.documents)
}

func submittedRequest(t *testing.T, f *fixture, a invoiceActors, amount string) ExternalInvoiceRequest {
	t.Helper()
	o := f.finalized(t, amount)
	r := f.newRequest(t, a.staff, o)
	return f.ok(t, a.staff, r, "submit", nil)
}

func auditCount(t *testing.T, f *fixture, action string, id uuid.UUID) int {
	t.Helper()
	var n int
	if err := f.pool.QueryRow(
		t.Context(), "SELECT count(*) FROM audit_events WHERE action=$1 AND resource_id=$2", action, id,
	).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestForwardingMailsTheInvoiceOnceAfterCommit(t *testing.T) {
	f := newFixture(t)
	a := f.actors(t)
	delivery := &recordingDelivery{pool: f.pool, outcome: invoicing.Outcome{Status: invoicing.DeliverySent}}
	f.s.WithInvoiceDelivery(delivery)
	r := submittedRequest(t, f, a, "10")
	if r.WiRefDelivery != nil || delivery.calls() != 0 {
		t.Fatalf("delivery before forwarding: %+v", r.WiRefDelivery)
	}
	forward := InvoiceRequestCommand{OperationKey: newKey(), ExpectedVersion: r.Version}
	issued, err := f.s.RequestCommand(t.Context(), a.approver, r.ID, forward, "forward", nil)
	if err != nil || issued.State != InvoiceIssued {
		t.Fatalf("forward: %v %+v", err, issued)
	}
	if delivery.calls() != 1 {
		t.Fatalf("expected exactly one delivery, got %d", delivery.calls())
	}
	if delivery.lockErr != nil {
		t.Fatalf("the request row was still locked while sending: %v", delivery.lockErr)
	}
	d := delivery.documents[0]
	if d.Organisation != "Billing recipient" || d.RequestNumber != r.Reference || d.OrderNumber != r.OrderReference ||
		d.Total != "10.00" || d.Approver != "Permission Test" || len(d.Items) == 0 || d.ApprovedAt.IsZero() ||
		d.ContactName != "Contact" || len(d.AddressLines) != 3 {
		t.Fatalf("document %+v", d)
	}
	if issued.WiRefDelivery == nil || issued.WiRefDelivery.Status != "sent" || issued.WiRefDelivery.FailureCode != "" {
		t.Fatalf("delivery status %+v", issued.WiRefDelivery)
	}
	reloaded, err := f.s.GetRequest(t.Context(), a.approver, r.ID)
	if err != nil || reloaded.WiRefDelivery == nil || reloaded.WiRefDelivery.Status != "sent" ||
		reloaded.Version != issued.Version {
		t.Fatalf("persisted status %v %+v", err, reloaded)
	}
	if auditCount(t, f, "external_invoice_request.wiref_delivery_sent", r.ID) != 1 {
		t.Fatal("delivery audit event missing")
	}
	// Replaying the same operation neither forwards nor mails again.
	if _, err = f.s.RequestCommand(t.Context(), a.approver, r.ID, forward, "forward", nil); err != nil {
		t.Fatal(err)
	}
	if delivery.calls() != 1 {
		t.Fatalf("replay mailed again: %d", delivery.calls())
	}
}

func TestOtherCommandsDoNotMailWiRef(t *testing.T) {
	f := newFixture(t)
	a := f.actors(t)
	delivery := &recordingDelivery{pool: f.pool}
	f.s.WithInvoiceDelivery(delivery)
	r := submittedRequest(t, f, a, "10")
	r = f.ok(t, a.approver, r, "return", func(c *InvoiceRequestCommand) { c.Reason = "again" })
	if delivery.calls() != 0 || r.WiRefDelivery != nil {
		t.Fatalf("mailed on return: %d %+v", delivery.calls(), r.WiRefDelivery)
	}
}

func TestForwardingRecordsMissingConfigurationAndFailuresWithoutUndoingIt(t *testing.T) {
	for name, outcome := range map[string]invoicing.Outcome{
		"not configured": {Status: invoicing.DeliveryNotConfigured},
		"failed":         {Status: invoicing.DeliveryFailed, FailureCode: invoicing.FailureSendFailed},
	} {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t)
			a := f.actors(t)
			f.s.WithInvoiceDelivery(&recordingDelivery{pool: f.pool, outcome: outcome})
			r := submittedRequest(t, f, a, "10")
			issued := f.ok(t, a.approver, r, "forward", nil)
			if issued.State != InvoiceIssued {
				t.Fatalf("state %s", issued.State)
			}
			got := issued.WiRefDelivery
			if got == nil || got.Status != string(outcome.Status) || got.FailureCode != outcome.FailureCode ||
				got.AttemptedAt.IsZero() {
				t.Fatalf("delivery %+v", got)
			}
			o, err := f.s.Get(t.Context(), f.p, *r.OrderID)
			if err != nil || o.SettlementState != "paid" {
				t.Fatalf("settlement %v %+v", err, o.SettlementState)
			}
		})
	}
}

func TestResendNeedsApprovePermissionAndAnIssuedRequest(t *testing.T) {
	f := newFixture(t)
	a := f.actors(t)
	delivery := &recordingDelivery{pool: f.pool, outcome: invoicing.Outcome{Status: invoicing.DeliveryNotConfigured}}
	f.s.WithInvoiceDelivery(delivery)
	r := submittedRequest(t, f, a, "10")
	_, err := f.s.ResendToWiRef(t.Context(), a.approver, r.ID, nil)
	wantCode(t, err, "invalid_request_transition")
	issued := f.ok(t, a.approver, r, "forward", nil)
	for name, who := range map[string]authorizationPrincipal{"staff": a.staff, "finance": a.finance} {
		if _, err = f.s.ResendToWiRef(t.Context(), who, issued.ID, nil); err == nil {
			t.Fatalf("%s may resend", name)
		}
		denied(t, err)
	}
	if delivery.calls() != 1 {
		t.Fatalf("denied resend mailed: %d", delivery.calls())
	}
	delivery.outcome = invoicing.Outcome{Status: invoicing.DeliverySent}
	again, err := f.s.ResendToWiRef(t.Context(), a.approver, issued.ID, nil)
	if err != nil || delivery.calls() != 2 || again.WiRefDelivery == nil || again.WiRefDelivery.Status != "sent" ||
		again.Version != issued.Version {
		t.Fatalf("resend %v calls=%d %+v", err, delivery.calls(), again.WiRefDelivery)
	}
	if auditCount(t, f, "external_invoice_request.wiref_delivery_sent", issued.ID) != 1 ||
		auditCount(t, f, "external_invoice_request.wiref_delivery_not_configured", issued.ID) != 1 {
		t.Fatal("audit events of both attempts expected")
	}
}

// mailbox is the notifier the real invoicing service sends through in the end-to-end test.
type mailbox struct {
	mu   sync.Mutex
	sent []mailed
}

type mailed struct {
	to          string
	cc          []string
	subject     string
	attachments []mailservice.Attachment
}

func (m *mailbox) SendBrandedCC(
	_ context.Context,
	to string,
	cc []string,
	subject string,
	_ notifications.Content,
	attachments ...mailservice.Attachment,
) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sent = append(m.sent, mailed{to: to, cc: cc, subject: subject, attachments: attachments})
	return nil
}

func (m *mailbox) RenderBranded(_ context.Context, c notifications.Content) (string, string) {
	return notifications.RenderBranded(notifications.Branding{}, c)
}

func (m *mailbox) Branding(context.Context) notifications.Branding { return notifications.Branding{} }

func TestForwardingSendsOneMailWithPDFToTheConfiguredRecipient(t *testing.T) {
	f := newFixture(t)
	a := f.actors(t)
	box := &mailbox{}
	mailer := invoicing.NewService(f.pool, box, nil)
	f.s.WithInvoiceDelivery(mailer)
	r := submittedRequest(t, f, a, "10")

	// Without settings the forwarding still succeeds and records that nothing was configured.
	unconfigured := f.ok(t, a.approver, r, "forward", nil)
	if unconfigured.WiRefDelivery == nil || unconfigured.WiRefDelivery.Status != "not_configured" || len(box.sent) != 0 {
		t.Fatalf("unconfigured %+v mails=%d", unconfigured.WiRefDelivery, len(box.sent))
	}

	settings, err := mailer.GetSettings(t.Context(), f.p)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = mailer.UpdateSettings(t.Context(), f.p, invoicing.SettingsInput{
		Templates:       settings.Templates,
		Enabled:         true,
		RecipientEmail:  "wiref@example.org",
		CCEmails:        []string{"office@example.org"},
		ExpectedVersion: settings.Version,
	}, nil); err != nil {
		t.Fatal(err)
	}
	second := submittedRequest(t, f, a, "25.50")
	issued := f.ok(t, a.approver, second, "forward", nil)
	if len(box.sent) != 1 {
		t.Fatalf("expected exactly one mail, got %d", len(box.sent))
	}
	m := box.sent[0]
	if m.to != "wiref@example.org" || len(m.cc) != 1 || !strings.Contains(m.subject, second.Reference) ||
		len(m.attachments) != 1 || m.attachments[0].ContentType != "application/pdf" ||
		!bytes.HasPrefix(m.attachments[0].Data, []byte("%PDF-")) {
		t.Fatalf("mail %+v", m)
	}
	if issued.WiRefDelivery == nil || issued.WiRefDelivery.Status != "sent" {
		t.Fatalf("status %+v", issued.WiRefDelivery)
	}
	// The first request can be sent now that wiRef is configured.
	resent, err := f.s.ResendToWiRef(t.Context(), a.approver, unconfigured.ID, nil)
	if err != nil || resent.WiRefDelivery.Status != "sent" || len(box.sent) != 2 {
		t.Fatalf("resend %v %+v mails=%d", err, resent.WiRefDelivery, len(box.sent))
	}
}
