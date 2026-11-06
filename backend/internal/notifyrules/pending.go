package notifyrules

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	notifyrulesdb "github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/database"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

const (
	// PendingInterval is how often the scheduler looks for waiting notifications that are due.
	PendingInterval = time.Minute
	// PendingBatch bounds the waiting notifications one pass delivers.
	PendingBatch = 200
	// pendingMaxAttempts is how often a failing waiting notification is tried before it is given up.
	pendingMaxAttempts = 5
	pendingRetryDelay  = 5 * time.Minute
)

// RunPending delivers the waiting notifications that are due (delayed actions, e-mail fallbacks and escalation steps)
// and returns how many it handled. Each one runs in its own transaction, so one that keeps failing cannot hold back
// the others; it is retried a few times and then dropped.
func (d *Dispatcher) RunPending(ctx context.Context, limit int) (int, error) {
	handled := 0
	for handled < limit {
		found, err := d.runOnePending(ctx)
		if err != nil {
			return handled, err
		}
		if !found {
			break
		}
		handled++
	}
	return handled, nil
}

func (d *Dispatcher) runOnePending(ctx context.Context) (bool, error) {
	now := d.now()
	var claimed uuid.UUID
	var attempts int32
	found := false
	err := database.InTx(ctx, d.pool, func(tx pgx.Tx) error {
		q := notifyrulesdb.New(tx)
		row, err := q.ClaimDuePendingAction(ctx, now)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("claim waiting notification: %w", err)
		}
		found, claimed, attempts = true, row.ID, row.Attempts
		return d.processPending(ctx, q, row, now)
	})
	if err == nil || !found || ctx.Err() != nil {
		return found, err
	}
	slog.WarnContext(ctx, "waiting notification failed", "pending_id", claimed, "attempt", attempts+1, "error", err)
	q := notifyrulesdb.New(d.pool)
	if attempts+1 >= pendingMaxAttempts {
		if err = q.DeletePendingAction(ctx, claimed); err != nil {
			return true, fmt.Errorf("drop waiting notification: %w", err)
		}
		return true, nil
	}
	if err = q.DeferPendingAction(ctx, notifyrulesdb.DeferPendingActionParams{
		ID: claimed, DueAt: now.Add(pendingRetryDelay),
	}); err != nil {
		return true, fmt.Errorf("defer waiting notification: %w", err)
	}
	return true, nil
}

// stopsOnReading says whether the escalation's stop condition is something the in-app notification's recipients do.
// Until delivery tracking exists, reading a notification counts as opening, seeing and acknowledging it.
func stopsOnReading(stopWhen string) bool {
	switch stopWhen {
	case ResolutionOpened, ResolutionAcknowledged, ResolutionSeen:
		return true
	}
	return false
}

// processPending delivers one claimed waiting notification and removes it. Escalation steps and fallbacks of a
// resolved or already read firing are dropped without sending; delayed first actions are delivered either way. The
// rule's conditions are evaluated again, with the event's stored field values and the present moment.
func (d *Dispatcher) processPending(
	ctx context.Context,
	q *notifyrulesdb.Queries,
	row notifyrulesdb.ClaimDuePendingActionRow,
	now time.Time,
) error {
	drop := func() error {
		if err := q.DeletePendingAction(ctx, row.ID); err != nil {
			return fmt.Errorf("remove waiting notification: %w", err)
		}
		return nil
	}
	def, err := ParseDefinition(row.Definition)
	if !row.RuleEnabled || err != nil {
		return drop()
	}
	var item pendingItem
	if len(row.Item) > 0 {
		if err = json.Unmarshal(row.Item, &item); err != nil {
			return drop()
		}
	}
	waits := row.Step > 0 || item.Fallback
	if waits && row.FiringResolvedAt.Valid {
		return drop()
	}
	if row.Step > 0 && def.Escalation != nil && stopsOnReading(def.Escalation.StopWhen) {
		read, err := q.FiringWasRead(ctx, row.FiringID)
		if err != nil {
			return fmt.Errorf("check whether the notification was read: %w", err)
		}
		if read {
			reason := def.Escalation.StopWhen
			if err = q.ResolveFiring(ctx, notifyrulesdb.ResolveFiringParams{
				ResolvedAt: pgtype.Timestamptz{Time: now, Valid: true}, Reason: &reason, ID: row.FiringID,
			}); err != nil {
				return fmt.Errorf("resolve firing: %w", err)
			}
			if _, err = q.DeletePendingEscalations(ctx, []string{row.FiringID.String()}); err != nil {
				return fmt.Errorf("drop escalation steps: %w", err)
			}
			return drop()
		}
	}
	var action Action
	if err = json.Unmarshal(row.Action, &action); err != nil {
		return drop()
	}
	var peopleTexts []string
	if err = json.Unmarshal(row.Recipients, &peopleTexts); err != nil {
		return drop()
	}
	people := make([]uuid.UUID, 0, len(peopleTexts))
	for _, text := range peopleTexts {
		if id, parseErr := uuid.Parse(text); parseErr == nil {
			people = append(people, id)
		}
	}
	if item.Fallback && item.NotificationID != nil {
		// Only people who still did not read the notification get the mail.
		unread, err := q.ListPeopleWhoHaveNotRead(ctx, *item.NotificationID)
		if err != nil {
			return fmt.Errorf("find unread notifications: %w", err)
		}
		people = intersectPeople(people, unread)
	}

	personal := row.OwnerAccountID != nil
	runtime := newRuntime(
		row.RuleID, row.RuleName, row.CategoryID, row.CategoryBasis, row.CategoryTextVersion, row.Mandatory, personal, def,
	)
	if !item.Fallback {
		evaluated, err := d.evaluate(ctx, q, def, decodeFields(item.Fields), now, people)
		if err != nil {
			return err
		}
		if !evaluated.eventOK {
			return drop()
		}
		runtime.Pass = evaluated.pass
	}
	if err = d.deliver(ctx, q, runtime, deliveryInput{
		FiringID: row.FiringID, Step: int(row.Step), Action: action, Link: item.Link, People: people,
		Organizations: item.Organizations, Fallback: item.Fallback,
	}, now); err != nil {
		return err
	}
	return drop()
}

func intersectPeople(people, allowed []uuid.UUID) []uuid.UUID {
	keep := map[uuid.UUID]struct{}{}
	for _, person := range allowed {
		keep[person] = struct{}{}
	}
	var result []uuid.UUID
	for _, person := range people {
		if _, ok := keep[person]; ok {
			result = append(result, person)
		}
	}
	return result
}
