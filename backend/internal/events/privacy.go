package events

import (
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	eventsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/events/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/privacy"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ScrubAssignmentsForDeletedPerson is the Event-domain participant in Person
// hard deletion. It must run inside the caller's Person deletion transaction.
func ScrubAssignmentsForDeletedPerson(
	ctx context.Context,
	tx pgx.Tx,
	actor uuid.UUID,
	personID uuid.UUID,
	requestID *uuid.UUID,
) error {
	rows, err := eventsdb.New(tx).ScrubEventAssignmentsForPerson(ctx, &personID)
	if err != nil {
		return err
	}
	for _, row := range rows {
		id := row.ID
		if err := audit.Write(
			ctx,
			tx,
			audit.Event{
				ActorAccountID: &actor,
				Action:         "event_assignment.personal_data_erased",
				ResourceType:   "event_assignment",
				ResourceID:     &id,
				RequestID:      requestID,
				ChangedFields:  []string{"personId", "personalData"},
				Metadata:       map[string]any{"eventId": row.EventID.String()},
			},
		); err != nil {
			return err
		}
	}
	return nil
}

func EraseExpiredSignupData(ctx context.Context, pool *pgxpool.Pool, cutoff time.Time) (int64, error) {
	if cutoff.IsZero() {
		return 0, nil
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	count, err := EraseExpiredSignupDataTx(ctx, tx, cutoff)
	if err != nil {
		return count, err
	}
	return count, tx.Commit(ctx)
}

// SignupRetention is the retention handler for external event sign-ups: it
// redacts the contact snapshots of assignments whose event closed before the cutoff.
func SignupRetention() privacy.RetentionHandler {
	return privacy.HandlerFunc(func(ctx context.Context, tx pgx.Tx, action privacy.Action, cutoff time.Time, _ int32) (int64, error) {
		if action != privacy.ActionRedact {
			return 0, privacy.ErrActionUnsupported
		}
		return EraseExpiredSignupDataTx(ctx, tx, cutoff)
	})
}

// EraseExpiredSignupDataTx is EraseExpiredSignupData inside the caller's transaction.
func EraseExpiredSignupDataTx(ctx context.Context, tx pgx.Tx, cutoff time.Time) (int64, error) {
	q := eventsdb.New(tx)
	rows, err := q.ListExpiredEventAssignmentsForUpdate(ctx, pgtype.Timestamptz{Time: cutoff.UTC(), Valid: true})
	if err != nil {
		return 0, err
	}
	var count int64
	for _, candidate := range rows {
		row, err := q.EraseEventAssignmentPersonalData(ctx, candidate.ID)
		if err != nil {
			return count, err
		}
		id := row.ID
		if err = audit.Write(
			ctx,
			tx,
			audit.Event{
				ActorType:     "system",
				Action:        "event_assignment.personal_data_erased",
				ResourceType:  "event_assignment",
				ResourceID:    &id,
				ChangedFields: []string{"personalData"},
				Metadata:      map[string]any{"eventId": candidate.EventID.String()},
				Source:        "admin_cli",
			},
		); err != nil {
			return count, err
		}
		count++
	}
	return count, nil
}
