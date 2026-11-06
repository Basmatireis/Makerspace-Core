package notifyrules

import (
	"context"
	"fmt"
	"time"

	notifyrulesdb "github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// KioskNotice is a notice an entrance tablet shows. It never names anybody but the text the rule wrote.
type KioskNotice struct {
	ID      uuid.UUID
	Mode    TabletMode
	Title   string
	Body    string
	Level   string
	MustTap bool
}

// Notices serves the notices of tablet actions to the tablets themselves.
type Notices struct {
	pool *pgxpool.Pool
	now  func() time.Time
}

// NewNotices creates the reader of tablet notices.
func NewNotices(pool *pgxpool.Pool) *Notices {
	return &Notices{pool: pool, now: func() time.Time { return time.Now().UTC() }}
}

// WithClock replaces the clock; tests use it.
func (n *Notices) WithClock(now func() time.Time) *Notices {
	n.now = now
	return n
}

// ForDevice lists what the tablet shows by itself: the banners of its start screen and the notices every person
// checking in today sees on the result screen.
func (n *Notices) ForDevice(ctx context.Context, deviceID uuid.UUID) ([]KioskNotice, error) {
	rows, err := notifyrulesdb.New(n.pool).ListKioskDeviceNotices(ctx, notifyrulesdb.ListKioskDeviceNoticesParams{
		DeviceID: deviceID, Now: n.now(),
	})
	if err != nil {
		return nil, fmt.Errorf("list tablet notices: %w", err)
	}
	notices := make([]KioskNotice, 0, len(rows))
	for _, row := range rows {
		notices = append(notices, KioskNotice{
			ID: row.ID, Mode: TabletMode(row.Mode), Title: row.Title, Body: row.Body, Level: row.Level, MustTap: row.MustTap,
		})
	}
	return notices, nil
}

// TakeForCheckIn returns the notices waiting for the person at this tablet and marks them (and their copies for the
// other chosen tablets) shown, so each is displayed once.
func (n *Notices) TakeForCheckIn(ctx context.Context, deviceID, personID uuid.UUID) ([]KioskNotice, error) {
	tx, err := n.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin tablet notices: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := notifyrulesdb.New(tx)
	now := n.now()
	rows, err := queries.ListKioskPersonNotices(ctx, notifyrulesdb.ListKioskPersonNoticesParams{
		DeviceID: deviceID, PersonID: &personID, Now: now,
	})
	if err != nil {
		return nil, fmt.Errorf("list check-in notices: %w", err)
	}
	notices := make([]KioskNotice, 0, len(rows))
	groups := make([]uuid.UUID, 0, len(rows))
	for _, row := range rows {
		notices = append(notices, KioskNotice{
			ID: row.ID, Mode: TabletMode(row.Mode), Title: row.Title, Body: row.Body, Level: row.Level, MustTap: row.MustTap,
		})
		groups = append(groups, row.GroupID)
	}
	if len(groups) > 0 {
		if err = queries.MarkKioskNoticesShown(ctx, notifyrulesdb.MarkKioskNoticesShownParams{
			Now: pgtype.Timestamptz{Time: now, Valid: true}, PersonID: &personID, GroupIds: uuidStrings(groups),
		}); err != nil {
			return nil, fmt.Errorf("mark check-in notices shown: %w", err)
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit tablet notices: %w", err)
	}
	return notices, nil
}
