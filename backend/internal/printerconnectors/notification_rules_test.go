package printerconnectors

import (
	"context"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/inbox"
)

type recordingMailer struct {
	sent          []string
	settingsLinks []bool
}

func (m *recordingMailer) SendNotice(_ context.Context, to, subject, _, link string, settingsLink bool) error {
	m.sent = append(m.sent, to+"|"+subject+"|"+link)
	m.settingsLinks = append(m.settingsLinks, settingsLink)
	return nil
}

func TestPrinterEventRulesTellEveryoneOnceAndQueueTheirMail(t *testing.T) {
	h := newIngestHarness(t)
	ctx := t.Context()
	t0 := time.Now().UTC().Truncate(time.Second).Add(-time.Hour)
	supervisor := h.principalWith("rulesupervisor", authorization.MachinesRead)
	bystander := h.principalWith("rulebystander", authorization.MachinesRead)
	h.cleanupNotifications(supervisor.AccountID, bystander.AccountID, h.principal.AccountID)
	// The membership roles every person holds would reach the bystander too, so pick the test's own role.
	var roleID string
	if err := h.pool.QueryRow(
		ctx,
		`SELECT pr.role_id::text FROM person_roles pr JOIN roles r ON r.id = pr.role_id WHERE pr.person_id = $1 AND r.system_key IS NULL`,
		supervisor.PersonID,
	).Scan(&roleID); err != nil {
		t.Fatal(err)
	}
	// Operator and recipient are the same person here; the role holder is someone else.
	original := ""
	if err := h.pool.QueryRow(ctx, `SELECT definition::text FROM notification_rules WHERE system_key = 'printer_error'`).Scan(&original); err != nil {
		t.Fatal(err)
	}
	h.configureRule("printer_error", []string{"operator", "recipient", "role:" + roleID}, "", true)
	if _, err := h.pool.Exec(ctx, `UPDATE mail_configuration SET enabled = true`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		background := context.Background()
		_, _ = h.pool.Exec(background, `UPDATE mail_configuration SET enabled = false`)
		_, _ = h.pool.Exec(background, `DELETE FROM notification_mail_outbox`)
	})
	runID := h.runWithOperator(t0)
	h.accepted(runID, EventPrinterError, t0.Add(time.Minute), `{"transition":"appeared","sourceFamily":"print","code":"07FF8004"}`)

	if titles, _, _ := h.notifications(h.principal.AccountID, "printer_error"); len(titles) != 1 {
		t.Fatalf("operator and recipient notifications = %q, want one", titles)
	}
	if titles, _, _ := h.notifications(supervisor.AccountID, "printer_error"); len(titles) != 1 {
		t.Fatalf("role holder notifications = %q, want one", titles)
	}
	if titles, _, _ := h.notifications(bystander.AccountID, "printer_error"); len(titles) != 0 {
		t.Fatalf("bystander notifications = %q, want none", titles)
	}
	var queued int
	if err := h.pool.QueryRow(
		ctx,
		`SELECT count(*) FROM notification_mail_outbox WHERE kind = 'rule' AND person_id IN ($1, $2)`,
		h.principal.PersonID,
		supervisor.PersonID,
	).Scan(&queued); err != nil || queued != 2 {
		t.Fatalf("queued mails = %d, %v", queued, err)
	}

	mailer := &recordingMailer{}
	sent, err := inbox.NewMailDelivery(h.pool, mailer).Deliver(ctx, inbox.MailDeliveryBatch)
	if err != nil || sent < 1 {
		t.Fatalf("delivered %d, %v (mails %q)", sent, err, mailer.sent)
	}
	var left int
	if err = h.pool.QueryRow(ctx, `SELECT count(*) FROM notification_mail_outbox WHERE person_id IN ($1, $2)`,
		h.principal.PersonID, supervisor.PersonID).Scan(&left); err != nil || left != 0 {
		t.Fatalf("mails left after delivery = %d, %v", left, err)
	}
	for _, mail := range mailer.sent {
		if mail == "" {
			t.Fatal("empty mail")
		}
	}

	// Without e-mail the rule only writes in-app notifications.
	h.setRule("printer_error", original, []string{"operator", "recipient", "role:" + roleID}, "", false)
	h.accepted(runID, EventPrinterError, t0.Add(2*time.Minute), `{"transition":"appeared","sourceFamily":"print","code":"07FF8005"}`)
	if err = h.pool.QueryRow(ctx, `SELECT count(*) FROM notification_mail_outbox`).Scan(&queued); err != nil || queued != 0 {
		t.Fatalf("mails queued without e-mail = %d, %v", queued, err)
	}
}
