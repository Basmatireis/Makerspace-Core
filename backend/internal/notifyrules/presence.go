package notifyrules

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	notifyrulesdb "github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// maxWaitsPerPoll bounds the waiting notifications one poll delivers; the rest follow with the next poll.
const maxWaitsPerPoll = 20

// DeliverWaiting delivers the in-app notifications that wait for the person to open the application. The inbox poll
// calls it inside its transaction after recording the account's presence (and the device's), so the notifications it
// creates are handed over by the same poll. A wait for other devices stays for later; a wait whose rule was switched
// off or whose conditions no longer hold ends as "not online". Every wait runs in its own savepoint, so one that
// fails is logged and dropped without failing the poll.
func (d *Dispatcher) DeliverWaiting(ctx context.Context, tx pgx.Tx, principal authorization.Principal, now time.Time) error {
	var deviceID, deviceTypeID *uuid.UUID
	if device := principal.Device; device != nil {
		deviceID, deviceTypeID = &device.ID, &device.DeviceTypeID
	}
	q := newStore(tx)
	rows, err := q.ClaimPresenceWaits(ctx, notifyrulesdb.ClaimPresenceWaitsParams{
		PersonID: principal.PersonID, Now: now, MaxRows: maxWaitsPerPoll,
	})
	if err != nil {
		return fmt.Errorf("claim waiting notifications: %w", err)
	}
	for _, row := range rows {
		var action Action
		if err := json.Unmarshal(row.Action, &action); err != nil || action.InApp == nil {
			if err := endWait(ctx, q, row); err != nil {
				return err
			}
			continue
		}
		if !action.InApp.Devices.Matches(deviceID, deviceTypeID) {
			continue
		}
		savepoint, err := tx.Begin(ctx)
		if err != nil {
			return fmt.Errorf("begin waiting notification: %w", err)
		}
		if err = d.deliverWait(ctx, newStore(savepoint), row, action, principal.PersonID, now); err != nil {
			_ = savepoint.Rollback(ctx)
			if ctx.Err() != nil {
				return ctx.Err()
			}
			slog.WarnContext(ctx, "waiting notification failed", "rule_id", row.RuleID, "wait_id", row.ID, "error", err)
			if err := endWait(ctx, q, row); err != nil {
				return err
			}
			continue
		}
		if err = savepoint.Commit(ctx); err != nil {
			return fmt.Errorf("commit waiting notification: %w", err)
		}
	}
	return nil
}

// deliverWait checks the rule again and delivers one waiting notification to the person who just came online. The
// "waiting" log line gives way to the line the delivery writes.
func (d *Dispatcher) deliverWait(
	ctx context.Context,
	q *store,
	row notifyrulesdb.ClaimPresenceWaitsRow,
	action Action,
	person uuid.UUID,
	now time.Time,
) error {
	def, err := ParseDefinition(row.Definition)
	if !row.RuleEnabled || err != nil {
		return endWait(ctx, q, row)
	}
	var item pendingItem
	if len(row.Item) > 0 {
		if err = json.Unmarshal(row.Item, &item); err != nil {
			return endWait(ctx, q, row)
		}
	}
	values := Context(decodeFields(item.Values))
	if len(item.Values) == 0 {
		values = eventValues(decodeFields(item.Fields))
	}
	people := []uuid.UUID{person}
	evaluated, err := d.evaluate(ctx, q, def, values, now, people)
	if err != nil {
		return err
	}
	if !evaluated.eventOK {
		return endWait(ctx, q, row)
	}
	runtime := newRuntime(
		row.RuleID, row.RuleName, row.CategoryID, row.CategoryBasis, row.CategoryTextVersion, row.Mandatory,
		row.OwnerAccountID != nil, def,
	)
	runtime.Pass = evaluated.pass
	if err = q.DeletePresenceWait(ctx, row.ID); err != nil {
		return fmt.Errorf("remove waiting notification: %w", err)
	}
	if row.LogID != nil {
		if err = q.DeleteFiringRecipient(ctx, *row.LogID); err != nil {
			return fmt.Errorf("remove waiting log line: %w", err)
		}
	}
	return d.deliver(ctx, q, runtime, deliveryInput{
		FiringID: row.FiringID, Step: int(row.Step), Action: action, Link: item.Link, People: people, Item: item,
		Late: true,
	}, now)
}

// endWait removes a wait that will never be delivered; its log line says the person was not online.
func endWait(ctx context.Context, q *store, row notifyrulesdb.ClaimPresenceWaitsRow) error {
	if err := q.DeletePresenceWait(ctx, row.ID); err != nil {
		return fmt.Errorf("remove waiting notification: %w", err)
	}
	if row.LogID != nil {
		if err := q.MarkFiringRecipientOffline(ctx, *row.LogID); err != nil {
			return fmt.Errorf("mark waiting log line: %w", err)
		}
	}
	return nil
}

// ExpireWaiting ends the waiting notifications that expired or whose firing was resolved and returns how many.
func (d *Dispatcher) ExpireWaiting(ctx context.Context) (int64, error) {
	ended, err := newStore(d.pool).ExpirePresenceWaits(ctx, d.now())
	if err != nil {
		return 0, fmt.Errorf("expire waiting notifications: %w", err)
	}
	return ended, nil
}
