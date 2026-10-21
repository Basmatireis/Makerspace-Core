package events

import (
	"context"
	"errors"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	eventsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/events/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *Service) ListSessions(
	ctx context.Context,
	principal authorization.Principal,
	eventID uuid.UUID,
) ([]Session, error) {
	if _, err := visibleEvent(ctx, eventsdb.New(s.pool), principal, eventID); err != nil {
		return nil, err
	}
	rows, err := eventsdb.New(s.pool).ListEventSessions(ctx, eventID)
	if err != nil {
		return nil, err
	}
	result := make([]Session, 0, len(rows))
	for _, row := range rows {
		result = append(result, sessionFromRow(row))
	}
	return result, nil
}

func (s *Service) CreateSession(
	ctx context.Context,
	principal authorization.Principal,
	eventID uuid.UUID,
	input SessionInput,
	requestID *uuid.UUID,
) (Session, error) {
	if !principal.Has(authorization.EventsManage) {
		return Session{}, apperror.PermissionDenied
	}
	input, err := validateSessionInput(input)
	if err != nil {
		return Session{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Session{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := eventsdb.New(tx)
	if err := requireEventWritable(ctx, q, eventID, false); err != nil {
		return Session{}, err
	}
	actor := principal.AccountID
	row, err := insertSession(ctx, tx, q, &actor, eventID, input, requestID)
	if err != nil {
		return Session{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Session{}, err
	}
	return sessionFromRow(row), nil
}

func (s *Service) UpdateSession(
	ctx context.Context,
	principal authorization.Principal,
	eventID, id uuid.UUID,
	input SessionInput,
	requestID *uuid.UUID,
) (Session, error) {
	if !principal.Has(authorization.EventsManage) {
		return Session{}, apperror.PermissionDenied
	}
	if err := validateVersion(input.ExpectedVersion); err != nil {
		return Session{}, err
	}
	input, err := validateSessionInput(input)
	if err != nil {
		return Session{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Session{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := eventsdb.New(tx)
	if err := requireEventWritable(ctx, q, eventID, false); err != nil {
		return Session{}, err
	}
	current, err := q.GetEventSession(ctx, eventsdb.GetEventSessionParams{ID: id, EventID: eventID})
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, apperror.NotFound
	}
	if err != nil {
		return Session{}, err
	}
	if int64(current.Version) != input.ExpectedVersion {
		return Session{}, apperror.StaleWrite
	}
	row, err := q.UpdateEventSession(
		ctx,
		eventsdb.UpdateEventSessionParams{
			Name:            input.Name,
			Location:        input.Location,
			Description:     input.Description,
			StartsAt:        input.StartsAt.UTC(),
			EndsAt:          input.EndsAt.UTC(),
			IsPublic:        input.IsPublic,
			Status:          string(input.Status),
			ID:              id,
			EventID:         eventID,
			ExpectedVersion: int32(input.ExpectedVersion),
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, apperror.StaleWrite
	}
	if err != nil {
		return Session{}, databaseError(err)
	}
	actor := principal.AccountID
	if err := eventAudit(
		ctx,
		tx,
		&actor,
		"event_session.updated",
		"event_session",
		id,
		requestID,
		[]string{"name", "location", "description", "startsAt", "endsAt", "isPublic", "status"},
		map[string]any{"eventId": eventID.String()},
	); err != nil {
		return Session{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Session{}, err
	}
	return sessionFromRow(row), nil
}

func (s *Service) DeleteSession(
	ctx context.Context,
	principal authorization.Principal,
	eventID, id uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) error {
	if !principal.Has(authorization.EventsManage) {
		return apperror.PermissionDenied
	}
	if err := validateVersion(expected); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := eventsdb.New(tx)
	if err := requireEventWritable(ctx, q, eventID, false); err != nil {
		return err
	}
	current, err := q.GetEventSession(ctx, eventsdb.GetEventSessionParams{ID: id, EventID: eventID})
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	if err != nil {
		return err
	}
	if int64(current.Version) != expected {
		return apperror.StaleWrite
	}
	if _, err := q.DeleteEventSession(
		ctx,
		eventsdb.DeleteEventSessionParams{ID: id, EventID: eventID, ExpectedVersion: int32(expected)},
	); err != nil {
		return databaseError(err)
	}
	actor := principal.AccountID
	if err := eventAudit(
		ctx,
		tx,
		&actor,
		"event_session.deleted",
		"event_session",
		id,
		requestID,
		nil,
		map[string]any{"eventId": eventID.String()},
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) DeleteShift(
	ctx context.Context,
	principal authorization.Principal,
	eventID, id uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) error {
	if !principal.Has(authorization.EventsStaffingManage) {
		return apperror.PermissionDenied
	}
	if err := validateVersion(expected); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := eventsdb.New(tx)
	if err := requireEventWritable(ctx, q, eventID, false); err != nil {
		return err
	}
	current, err := q.GetEventShift(ctx, eventsdb.GetEventShiftParams{ID: id, EventID: eventID})
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	if err != nil {
		return err
	}
	if int64(current.Version) != expected {
		return apperror.StaleWrite
	}
	if _, err := q.DeleteEventShift(
		ctx,
		eventsdb.DeleteEventShiftParams{ID: id, EventID: eventID, ExpectedVersion: int32(expected)},
	); err != nil {
		return databaseError(err)
	}
	actor := principal.AccountID
	if err := eventAudit(
		ctx,
		tx,
		&actor,
		"event_shift.deleted",
		"event_shift",
		id,
		requestID,
		nil,
		map[string]any{"eventId": eventID.String()},
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func validateSessionInput(input SessionInput) (SessionInput, error) {
	var err error
	if err = validateInterval(input.StartsAt, input.EndsAt); err != nil {
		return input, err
	}
	if input.Status == "" {
		input.Status = SessionStatusScheduled
	}
	if input.Status != SessionStatusScheduled && input.Status != SessionStatusCancelled {
		return input, apperror.Invalid("session status is invalid")
	}
	if input.Name, err = cleanOptional(input.Name, 200); err != nil {
		return input, err
	}
	if input.Location, err = cleanOptional(input.Location, 500); err != nil {
		return input, err
	}
	if input.Description, err = cleanOptional(input.Description, 10000); err != nil {
		return input, err
	}
	return input, nil
}

func validateShiftInput(input ShiftInput) (ShiftInput, error) {
	var err error
	input.Name, err = cleanRequired(input.Name, "name", 200)
	if err != nil {
		return input, err
	}
	if err = validateInterval(input.StartsAt, input.EndsAt); err != nil {
		return input, err
	}
	if input.Description, err = cleanOptional(input.Description, 10000); err != nil {
		return input, err
	}
	if input.Status == "" {
		input.Status = ShiftStatusDraft
	}
	if input.Status != ShiftStatusDraft && input.Status != ShiftStatusOpen && input.Status != ShiftStatusClosed && input.Status != ShiftStatusCancelled {
		return input, apperror.Invalid("shift status is invalid")
	}
	if input.SignupOpensAt != nil && input.SignupClosesAt != nil && !input.SignupClosesAt.After(*input.SignupOpensAt) {
		return input, apperror.Invalid("signupClosesAt must be after signupOpensAt")
	}
	if input.Requirements, err = validateShiftPositions(input.Requirements); err != nil {
		return input, err
	}
	return input, nil
}

func sessionFromRow(row eventsdb.EventSession) Session {
	return Session{
		ID:          row.ID,
		EventID:     row.EventID,
		Name:        row.Name,
		Location:    row.Location,
		Description: row.Description,
		StartsAt:    row.StartsAt,
		EndsAt:      row.EndsAt,
		IsPublic:    row.IsPublic,
		Status:      SessionStatus(row.Status),
		Version:     int64(row.Version),
		CreatedAt:   row.CreatedAt,
		UpdatedAt:   row.UpdatedAt,
	}
}

func requireEventWritable(ctx context.Context, q *eventsdb.Queries, eventID uuid.UUID, postEventWork bool) error {
	row, err := q.GetEventForUpdate(ctx, eventID)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	if err != nil {
		return err
	}
	if !postEventWork && EventStatus(row.Status).Closed() {
		return eventReadOnly()
	}
	return nil
}

// insertSession creates a validated session and its audit event inside the caller's transaction.
func insertSession(
	ctx context.Context,
	tx pgx.Tx,
	q *eventsdb.Queries,
	actor *uuid.UUID,
	eventID uuid.UUID,
	input SessionInput,
	requestID *uuid.UUID,
) (eventsdb.EventSession, error) {
	id := ids.New()
	row, err := q.CreateEventSession(ctx, eventsdb.CreateEventSessionParams{
		ID:          id,
		EventID:     eventID,
		Name:        input.Name,
		Location:    input.Location,
		Description: input.Description,
		StartsAt:    input.StartsAt.UTC(),
		EndsAt:      input.EndsAt.UTC(),
		IsPublic:    input.IsPublic,
		Status:      string(input.Status),
	})
	if err != nil {
		return row, databaseError(err)
	}
	return row, eventAudit(
		ctx,
		tx,
		actor,
		"event_session.created",
		"event_session",
		id,
		requestID,
		[]string{"name", "location", "description", "startsAt", "endsAt", "isPublic", "status"},
		map[string]any{"eventId": eventID.String()},
	)
}
