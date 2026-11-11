package inbox

import (
	"context"
	"errors"
	"fmt"
	"time"

	inboxdb "github.com/Basmatireis/Makerspace-Core/backend/internal/inbox/db"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	// MailDeliveryInterval is how often the delivery job sends queued notification e-mails.
	MailDeliveryInterval = time.Minute
	// MailDeliveryBatch bounds the e-mails one pass sends.
	MailDeliveryBatch = 50
	// mailMaxAttempts is how often a mail is tried before it is given up.
	mailMaxAttempts = 5
	// mailLease keeps a claimed mail from being taken again while a pass sends it.
	mailLease = 10 * time.Minute
	// mailRetention drops mails that could not be sent within a day; a printer event is stale by then.
	mailRetention = 24 * time.Hour
)

// ErrMailUndeliverable tells the delivery job that retrying cannot help (sending is switched off).
var ErrMailUndeliverable = errors.New("notification mail cannot be delivered")

// NoticeMailer sends one notification as an e-mail with the branded layout. link is an application path.
type NoticeMailer interface {
	// SendNotice mails one notification; settingsLink says whether the footer links the notification settings, which
	// only a recipient with an account can open.
	SendNotice(ctx context.Context, to, subject, body, link string, settingsLink bool) error
}

// MailDelivery sends the queued e-mails of notifications after their transaction committed.
type MailDelivery struct {
	pool   *pgxpool.Pool
	mailer NoticeMailer
	now    func() time.Time
}

// NewMailDelivery returns the delivery job's worker.
func NewMailDelivery(pool *pgxpool.Pool, mailer NoticeMailer) *MailDelivery {
	return &MailDelivery{pool: pool, mailer: mailer, now: func() time.Time { return time.Now().UTC() }}
}

// Deliver sends due mails and returns how many were sent. A mail whose recipient has no address any more is
// dropped; a failed one is retried with growing delays and dropped after mailMaxAttempts or a day. Addresses are
// read only now, never stored, and never logged.
func (d *MailDelivery) Deliver(ctx context.Context, limit int) (int, error) {
	queries := inboxdb.New(d.pool)
	now := d.now()
	if _, err := queries.DeleteNotificationMailsCreatedBefore(ctx, now.Add(-mailRetention)); err != nil {
		return 0, fmt.Errorf("drop stale notification mails: %w", err)
	}
	claimed, err := queries.ClaimDueNotificationMails(ctx, inboxdb.ClaimDueNotificationMailsParams{
		Now: now, LeaseUntil: now.Add(mailLease), BatchLimit: int32(min(limit, MailDeliveryBatch)),
	})
	if err != nil {
		return 0, fmt.Errorf("claim notification mails: %w", err)
	}
	sent := 0
	for _, mail := range claimed {
		recipient, err := queries.GetNotificationMailAddress(ctx, inboxdb.GetNotificationMailAddressParams{
			PersonID: mail.PersonID, OrganizationID: mail.OrganizationID,
		})
		if err != nil {
			return sent, fmt.Errorf("read notification mail address: %w", err)
		}
		address := recipient.Address
		link := ""
		if mail.Link != nil {
			link = *mail.Link
		}
		var sendErr error
		if address != "" {
			sendErr = d.mailer.SendNotice(ctx, address, mail.Subject, mail.Body, link, recipient.CanSignIn)
		}
		switch {
		case address == "" || sendErr == nil || errors.Is(sendErr, ErrMailUndeliverable) || mail.Attempts >= mailMaxAttempts:
			if err = queries.DeleteNotificationMail(ctx, mail.ID); err != nil {
				return sent, fmt.Errorf("remove notification mail: %w", err)
			}
			if address != "" && sendErr == nil {
				sent++
			}
		default:
			next := now.Add(time.Duration(mail.Attempts) * 5 * time.Minute)
			if err = queries.DeferNotificationMail(
				ctx,
				inboxdb.DeferNotificationMailParams{ID: mail.ID, NextAttemptAt: next},
			); err != nil {
				return sent, fmt.Errorf("defer notification mail: %w", err)
			}
		}
	}
	return sent, nil
}
