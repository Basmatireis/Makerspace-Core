package printerconnectors

import (
	"context"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/inbox"
)

type recordingMailer struct{ sent []string }

func (m *recordingMailer) SendNotice(_ context.Context, to, subject, _, link string) error {
	m.sent = append(m.sent, to+"|"+subject+"|"+link)
	return nil
}

func TestPrinterEventRulesTellEveryoneOnceAndQueueTheirMail(t *testing.T) {
	h := newIngestHarness(t)
	ctx := t.Context()
	t0 := time.Now().UTC().Truncate(time.Second).Add(-time.Hour)
	supervisor := h.principalWith("rulesupervisor", authorization.MachinesRead)
	bystander := h.principalWith("rulebystander", authorization.MachinesRead)
	h.cleanupNotifications(supervisor.AccountID, bystander.AccountID, h.principal.AccountID)
	var roleID string
	if err := h.pool.QueryRow(ctx, `SELECT role_id::text FROM person_roles WHERE person_id = $1`, supervisor.PersonID).Scan(&roleID); err != nil {
		t.Fatal(err)
	}
	// Operator and recipient are the same person here; the role holder is someone else.
	if _, err := h.pool.Exec(
		ctx,
		`UPDATE printer_notification_rules SET notify_operator = true, notify_recipient = true, role_id = $1, email = true, min_severity = NULL
		 WHERE event = 'printer_error'`,
		roleID,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := h.pool.Exec(ctx, `UPDATE mail_configuration SET enabled = true`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		background := context.Background()
		_, _ = h.pool.Exec(background, `UPDATE mail_configuration SET enabled = false`)
		_, _ = h.pool.Exec(background, `UPDATE printer_notification_rules SET notify_recipient = false, role_id = NULL, email = false, min_severity = 'serious' WHERE event = 'printer_error'`)
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
		`SELECT count(*) FROM notification_mail_outbox WHERE kind = 'printer_error' AND person_id IN ($1, $2)`,
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
	if _, err = h.pool.Exec(ctx, `UPDATE printer_notification_rules SET email = false WHERE event = 'printer_error'`); err != nil {
		t.Fatal(err)
	}
	h.accepted(runID, EventPrinterError, t0.Add(2*time.Minute), `{"transition":"appeared","sourceFamily":"print","code":"07FF8005"}`)
	if err = h.pool.QueryRow(ctx, `SELECT count(*) FROM notification_mail_outbox`).Scan(&queued); err != nil || queued != 0 {
		t.Fatalf("mails queued without e-mail = %d, %v", queued, err)
	}
}
