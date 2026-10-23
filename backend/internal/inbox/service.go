package inbox

import (
	"context"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	inboxdb "github.com/Basmatireis/Makerspace-Core/backend/internal/inbox/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ratelimit"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	// sendsPerWindow bounds how many manual messages one account may send per sendWindow.
	sendsPerWindow = 10
	sendWindow     = time.Hour
	// sweepInterval is the minimum time between two retention sweeps triggered by reads.
	sweepInterval = 10 * time.Minute
)

// Service implements the signed-in account's inbox and the manual messages to roles. Reading,
// marking and dismissing are always scoped to the principal's account by every query; sending and
// the sent list need notifications.send.
type Service struct {
	pool        *pgxpool.Pool
	now         func() time.Time
	sendLimiter *ratelimit.Limiter // manual messages sent per sender account

	sweepMu   sync.Mutex
	lastSweep time.Time
}

// NewService builds the service.
func NewService(pool *pgxpool.Pool) *Service {
	return &Service{
		pool:        pool,
		now:         func() time.Time { return time.Now().UTC() },
		sendLimiter: ratelimit.New(sendsPerWindow, sendWindow),
	}
}

func pageWindow(page, pageSize int) (int, int) {
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = defaultPageSize
	}
	return page, min(pageSize, maxPageSize)
}

// sweepExpiredThrottled hard-deletes expired notifications at most once per sweepInterval per
// process, so retention holds without a background worker. Failures are not fatal for the caller.
func (s *Service) sweepExpiredThrottled(ctx context.Context) {
	now := s.now()
	s.sweepMu.Lock()
	if !s.lastSweep.IsZero() && now.Sub(s.lastSweep) < sweepInterval && !now.Before(s.lastSweep) {
		s.sweepMu.Unlock()
		return
	}
	s.lastSweep = now
	s.sweepMu.Unlock()
	_, _ = inboxdb.New(s.pool).DeleteExpiredNotifications(ctx, now)
}

// List returns the principal's own notifications, newest first.
func (s *Service) List(ctx context.Context, principal authorization.Principal, page, pageSize int) (Page, error) {
	s.sweepExpiredThrottled(ctx)
	page, pageSize = pageWindow(page, pageSize)
	queries := inboxdb.New(s.pool)
	now := s.now()
	rows, err := queries.ListOwnNotifications(ctx, inboxdb.ListOwnNotificationsParams{
		AccountID:  principal.AccountID,
		Now:        now,
		PageOffset: int32(min((page-1)*pageSize, 1<<30)), //nolint:gosec // bounded just above
		PageLimit:  int32(pageSize),                      //nolint:gosec // at most maxPageSize
	})
	if err != nil {
		return Page{}, fmt.Errorf("list notifications: %w", err)
	}
	total, err := queries.CountOwnNotifications(ctx, inboxdb.CountOwnNotificationsParams{
		AccountID: principal.AccountID, Now: now,
	})
	if err != nil {
		return Page{}, fmt.Errorf("count notifications: %w", err)
	}
	unread, err := queries.CountOwnUnreadNotifications(ctx, inboxdb.CountOwnUnreadNotificationsParams{
		AccountID: principal.AccountID, Now: now,
	})
	if err != nil {
		return Page{}, fmt.Errorf("count unread notifications: %w", err)
	}
	items := make([]Notification, 0, len(rows))
	for _, row := range rows {
		item := Notification{
			ID: row.ID, Kind: Kind(row.Kind), Title: row.Title, Body: row.Body, Link: row.Link, CreatedAt: row.CreatedAt,
		}
		if row.ReadAt.Valid {
			readAt := row.ReadAt.Time.UTC()
			item.ReadAt = &readAt
		}
		items = append(items, item)
	}
	return Page{Items: items, Page: page, PageSize: pageSize, Total: total, UnreadCount: unread}, nil
}

// UnreadCount returns how many of the principal's notifications are unread.
func (s *Service) UnreadCount(ctx context.Context, principal authorization.Principal) (int64, error) {
	s.sweepExpiredThrottled(ctx)
	count, err := inboxdb.New(s.pool).CountOwnUnreadNotifications(ctx, inboxdb.CountOwnUnreadNotificationsParams{
		AccountID: principal.AccountID, Now: s.now(),
	})
	if err != nil {
		return 0, fmt.Errorf("count unread notifications: %w", err)
	}
	return count, nil
}

// MarkRead marks one of the principal's notifications as read. Another account's notification is
// reported as not found, exactly like a missing one.
func (s *Service) MarkRead(ctx context.Context, principal authorization.Principal, id uuid.UUID) error {
	affected, err := inboxdb.New(s.pool).MarkOwnNotificationRead(ctx, inboxdb.MarkOwnNotificationReadParams{
		Now:            pgtype.Timestamptz{Time: s.now(), Valid: true},
		NotificationID: id,
		AccountID:      principal.AccountID,
	})
	if err != nil {
		return fmt.Errorf("mark notification read: %w", err)
	}
	if affected == 0 {
		return apperror.NotFound
	}
	return nil
}

// MarkAllRead marks all of the principal's notifications as read.
func (s *Service) MarkAllRead(ctx context.Context, principal authorization.Principal) error {
	_, err := inboxdb.New(s.pool).MarkAllOwnNotificationsRead(ctx, inboxdb.MarkAllOwnNotificationsReadParams{
		Now:       pgtype.Timestamptz{Time: s.now(), Valid: true},
		AccountID: principal.AccountID,
	})
	if err != nil {
		return fmt.Errorf("mark all notifications read: %w", err)
	}
	return nil
}

// Dismiss hard-deletes the principal's copy of a notification. A system notification that nobody
// holds any more is deleted with it.
func (s *Service) Dismiss(ctx context.Context, principal authorization.Principal, id uuid.UUID) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := inboxdb.New(tx)
	affected, err := queries.DeleteOwnRecipient(ctx, inboxdb.DeleteOwnRecipientParams{
		NotificationID: id, AccountID: principal.AccountID,
	})
	if err != nil {
		return fmt.Errorf("dismiss notification: %w", err)
	}
	if affected == 0 {
		return apperror.NotFound
	}
	if err := queries.DeleteOrphanedSystemNotification(ctx, id); err != nil {
		return fmt.Errorf("delete orphaned notification: %w", err)
	}
	return tx.Commit(ctx)
}

func uniqueRoleIDs(values []uuid.UUID) []uuid.UUID {
	seen := make(map[uuid.UUID]struct{}, len(values))
	unique := make([]uuid.UUID, 0, len(values))
	for _, value := range values {
		if _, duplicate := seen[value]; !duplicate {
			seen[value] = struct{}{}
			unique = append(unique, value)
		}
	}
	return unique
}

// SendMessage sends a manual message to the active accounts of the people who hold any of the
// roles right now. The recipient set is a snapshot taken in the sending transaction together with
// the audit event, which names the message but never carries its text.
func (s *Service) SendMessage(
	ctx context.Context,
	principal authorization.Principal,
	input MessageInput,
	requestID *uuid.UUID,
) (SentMessage, error) {
	if !principal.Has(authorization.NotificationsSend) {
		return SentMessage{}, apperror.PermissionDenied
	}
	title, err := cleanTitle(input.Title)
	if err != nil {
		return SentMessage{}, err
	}
	body, err := cleanBody(input.Body)
	if err != nil {
		return SentMessage{}, err
	}
	link, err := cleanLink(input.Link)
	if err != nil {
		return SentMessage{}, err
	}
	roleIDs := uniqueRoleIDs(input.RoleIDs)
	if len(roleIDs) == 0 || len(roleIDs) > MaxMessageRoles {
		return SentMessage{}, apperror.Invalid("Choose between 1 and 100 roles.")
	}
	now := s.now()
	sender := principal.AccountID.String()
	if !s.sendLimiter.Take(sender, now) {
		return SentMessage{}, apperror.RateLimited(
			"notification_rate_limited", "Too many messages sent; try again later.", sendWindow,
		)
	}
	sent := false
	defer func() {
		if !sent {
			s.sendLimiter.Refund(sender, now)
		}
	}()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return SentMessage{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := inboxdb.New(tx)
	existing, err := queries.CountRolesByIDs(ctx, uuidTexts(roleIDs))
	if err != nil {
		return SentMessage{}, fmt.Errorf("count roles: %w", err)
	}
	if existing != int64(len(roleIDs)) {
		return SentMessage{}, apperror.New(
			http.StatusUnprocessableEntity, "unknown_role", "At least one of the chosen roles does not exist.",
		)
	}
	recipients, err := queries.ListEnabledAccountIDsByRoles(ctx, uuidTexts(roleIDs))
	if err != nil {
		return SentMessage{}, fmt.Errorf("resolve recipients: %w", err)
	}
	if len(recipients) == 0 {
		return SentMessage{}, apperror.New(
			http.StatusUnprocessableEntity, "no_recipients", "Nobody with an active account holds the chosen roles.",
		)
	}
	actor := principal.AccountID
	row, err := queries.InsertNotification(ctx, inboxdb.InsertNotificationParams{
		ID:                 ids.New(),
		Kind:               string(KindMessage),
		Title:              title,
		Body:               body,
		Link:               link,
		CreatedByAccountID: &actor,
		CreatedAt:          now,
		ExpiresAt:          now.Add(Retention),
	})
	if err != nil {
		return SentMessage{}, fmt.Errorf("insert message: %w", err)
	}
	if err := queries.InsertNotificationRoles(ctx, inboxdb.InsertNotificationRolesParams{
		NotificationID: row.ID, RoleIds: uuidTexts(roleIDs),
	}); err != nil {
		return SentMessage{}, fmt.Errorf("insert message roles: %w", err)
	}
	if _, err := queries.InsertRecipients(ctx, inboxdb.InsertRecipientsParams{
		NotificationID: row.ID, AccountIds: uuidTexts(recipients),
	}); err != nil {
		return SentMessage{}, fmt.Errorf("insert recipients: %w", err)
	}
	changed := []string{"title", "body", "roleIds"}
	if link != nil {
		changed = append(changed, "link")
	}
	if err := audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &actor,
		Action:         "inbox_message.sent",
		ResourceType:   "inbox_message",
		ResourceID:     &row.ID,
		RequestID:      requestID,
		ChangedFields:  changed,
	}); err != nil {
		return SentMessage{}, err
	}
	roles, err := queries.ListNotificationRoles(ctx, uuidTexts([]uuid.UUID{row.ID}))
	if err != nil {
		return SentMessage{}, fmt.Errorf("list message roles: %w", err)
	}
	senderName, err := queries.GetAccountPersonName(ctx, actor)
	if err != nil {
		return SentMessage{}, fmt.Errorf("load sender name: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return SentMessage{}, err
	}
	sent = true
	name := strings.TrimSpace(senderName.FirstName + " " + senderName.LastName)
	result := SentMessage{
		ID: row.ID, Title: row.Title, Body: row.Body, Link: row.Link, SenderName: &name,
		RecipientCount: int64(len(recipients)), CreatedAt: row.CreatedAt, ExpiresAt: row.ExpiresAt,
	}
	for _, role := range roles {
		result.Roles = append(result.Roles, MessageRole{ID: role.RoleID, Name: role.RoleName})
	}
	return result, nil
}

// ListSent returns the manual messages that were sent, newest first.
func (s *Service) ListSent(
	ctx context.Context,
	principal authorization.Principal,
	page, pageSize int,
) (SentPage, error) {
	if !principal.Has(authorization.NotificationsSend) {
		return SentPage{}, apperror.PermissionDenied
	}
	s.sweepExpiredThrottled(ctx)
	page, pageSize = pageWindow(page, pageSize)
	queries := inboxdb.New(s.pool)
	now := s.now()
	rows, err := queries.ListSentMessages(ctx, inboxdb.ListSentMessagesParams{
		Now:        now,
		PageOffset: int32(min((page-1)*pageSize, 1<<30)), //nolint:gosec // bounded just above
		PageLimit:  int32(pageSize),                      //nolint:gosec // at most maxPageSize
	})
	if err != nil {
		return SentPage{}, fmt.Errorf("list sent messages: %w", err)
	}
	total, err := queries.CountSentMessages(ctx, now)
	if err != nil {
		return SentPage{}, fmt.Errorf("count sent messages: %w", err)
	}
	messageIDs := make([]uuid.UUID, 0, len(rows))
	for _, row := range rows {
		messageIDs = append(messageIDs, row.ID)
	}
	roleRows, err := queries.ListNotificationRoles(ctx, uuidTexts(messageIDs))
	if err != nil {
		return SentPage{}, fmt.Errorf("list message roles: %w", err)
	}
	rolesByMessage := make(map[uuid.UUID][]MessageRole, len(rows))
	for _, role := range roleRows {
		rolesByMessage[role.NotificationID] = append(
			rolesByMessage[role.NotificationID], MessageRole{ID: role.RoleID, Name: role.RoleName},
		)
	}
	items := make([]SentMessage, 0, len(rows))
	for _, row := range rows {
		item := SentMessage{
			ID: row.ID, Title: row.Title, Body: row.Body, Link: row.Link,
			Roles:          slices.Clone(rolesByMessage[row.ID]),
			RecipientCount: row.RecipientCount, ReadCount: row.ReadCount,
			CreatedAt: row.CreatedAt, ExpiresAt: row.ExpiresAt,
		}
		if row.SenderFirstName != nil && row.SenderLastName != nil {
			name := strings.TrimSpace(*row.SenderFirstName + " " + *row.SenderLastName)
			item.SenderName = &name
		}
		items = append(items, item)
	}
	return SentPage{Items: items, Page: page, PageSize: pageSize, Total: total}, nil
}
