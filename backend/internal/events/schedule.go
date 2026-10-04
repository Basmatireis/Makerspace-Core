package events

import (
	"context"
	"errors"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	eventsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/events/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *Service) ListSessions(ctx context.Context, principal authorization.Principal, eventID uuid.UUID) ([]Session, error) {
	if !canRead(principal) {
		return nil, apperror.PermissionDenied
	}
	if _, err := eventsdb.New(s.pool).GetEvent(ctx, eventID); errors.Is(err, pgx.ErrNoRows) {
		return nil, apperror.NotFound
	} else if err != nil {
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

func (s *Service) CreateSession(ctx context.Context, principal authorization.Principal, eventID uuid.UUID, input SessionInput, requestID *uuid.UUID) (Session, error) {
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
	id := uuid.Must(uuid.NewV7())
	row, err := q.CreateEventSession(ctx, eventsdb.CreateEventSessionParams{ID: id, EventID: eventID, Name: input.Name, Location: input.Location, Description: input.Description, StartsAt: input.StartsAt.UTC(), EndsAt: input.EndsAt.UTC(), IsPublic: input.IsPublic, Status: input.Status})
	if err != nil {
		return Session{}, databaseError(err)
	}
	actor := principal.AccountID
	if err := eventAudit(ctx, tx, &actor, "event_session.created", "event_session", id, requestID, []string{"name", "location", "description", "startsAt", "endsAt", "isPublic", "status"}, map[string]any{"eventId": eventID.String()}); err != nil {
		return Session{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Session{}, err
	}
	return sessionFromRow(row), nil
}

func (s *Service) UpdateSession(ctx context.Context, principal authorization.Principal, eventID, id uuid.UUID, input SessionInput, requestID *uuid.UUID) (Session, error) {
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
	row, err := q.UpdateEventSession(ctx, eventsdb.UpdateEventSessionParams{Name: input.Name, Location: input.Location, Description: input.Description, StartsAt: input.StartsAt.UTC(), EndsAt: input.EndsAt.UTC(), IsPublic: input.IsPublic, Status: input.Status, ID: id, EventID: eventID, ExpectedVersion: int32(input.ExpectedVersion)})
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, apperror.StaleWrite
	}
	if err != nil {
		return Session{}, databaseError(err)
	}
	actor := principal.AccountID
	if err := eventAudit(ctx, tx, &actor, "event_session.updated", "event_session", id, requestID, []string{"name", "location", "description", "startsAt", "endsAt", "isPublic", "status"}, map[string]any{"eventId": eventID.String()}); err != nil {
		return Session{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Session{}, err
	}
	return sessionFromRow(row), nil
}

func (s *Service) DeleteSession(ctx context.Context, principal authorization.Principal, eventID, id uuid.UUID, expected int64, requestID *uuid.UUID) error {
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
	if _, err := q.DeleteEventSession(ctx, eventsdb.DeleteEventSessionParams{ID: id, EventID: eventID, ExpectedVersion: int32(expected)}); err != nil {
		return databaseError(err)
	}
	actor := principal.AccountID
	if err := eventAudit(ctx, tx, &actor, "event_session.deleted", "event_session", id, requestID, nil, map[string]any{"eventId": eventID.String()}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) ListShifts(ctx context.Context, principal authorization.Principal, eventID uuid.UUID) ([]Shift, error) {
	if !canRead(principal) {
		return nil, apperror.PermissionDenied
	}
	if _, err := eventsdb.New(s.pool).GetEvent(ctx, eventID); errors.Is(err, pgx.ErrNoRows) {
		return nil, apperror.NotFound
	} else if err != nil {
		return nil, err
	}
	rows, err := eventsdb.New(s.pool).ListEventShifts(ctx, eventID)
	if err != nil {
		return nil, err
	}
	result := make([]Shift, 0, len(rows))
	for _, row := range rows {
		result = append(result, Shift{ID: row.ID, EventID: row.EventID, SessionID: row.SessionID, Name: row.Name, Description: row.Description, StartsAt: row.StartsAt, EndsAt: row.EndsAt, SignupOpensAt: pgTime(row.SignupOpensAt), SignupClosesAt: pgTime(row.SignupClosesAt), IsPublic: row.IsPublic, Status: row.Status, LinkedSessionStatus: row.SessionStatus, Version: int64(row.Version), CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt})
	}
	return result, nil
}

func (s *Service) CreateShift(ctx context.Context, principal authorization.Principal, eventID uuid.UUID, input ShiftInput, requestID *uuid.UUID) (Shift, error) {
	if !principal.Has(authorization.EventsStaffingManage) {
		return Shift{}, apperror.PermissionDenied
	}
	input, err := validateShiftInput(input)
	if err != nil {
		return Shift{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Shift{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := eventsdb.New(tx)
	if err := requireEventWritable(ctx, q, eventID, false); err != nil {
		return Shift{}, err
	}
	id := uuid.Must(uuid.NewV7())
	row, err := q.CreateEventShift(ctx, eventsdb.CreateEventShiftParams{ID: id, EventID: eventID, SessionID: input.SessionID, Name: input.Name, Description: input.Description, StartsAt: input.StartsAt.UTC(), EndsAt: input.EndsAt.UTC(), SignupOpensAt: toPGTime(input.SignupOpensAt), SignupClosesAt: toPGTime(input.SignupClosesAt), IsPublic: input.IsPublic, Status: input.Status})
	if err != nil {
		return Shift{}, databaseError(err)
	}
	actor := principal.AccountID
	if err := eventAudit(ctx, tx, &actor, "event_shift.created", "event_shift", id, requestID, []string{"sessionId", "name", "description", "startsAt", "endsAt", "signupWindow", "isPublic", "status"}, map[string]any{"eventId": eventID.String()}); err != nil {
		return Shift{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Shift{}, err
	}
	return shiftFromRow(row), nil
}

func (s *Service) UpdateShift(ctx context.Context, principal authorization.Principal, eventID, id uuid.UUID, input ShiftInput, requestID *uuid.UUID) (Shift, error) {
	if !principal.Has(authorization.EventsStaffingManage) {
		return Shift{}, apperror.PermissionDenied
	}
	if err := validateVersion(input.ExpectedVersion); err != nil {
		return Shift{}, err
	}
	input, err := validateShiftInput(input)
	if err != nil {
		return Shift{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Shift{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := eventsdb.New(tx)
	if err := requireEventWritable(ctx, q, eventID, false); err != nil {
		return Shift{}, err
	}
	current, err := q.GetEventShift(ctx, eventsdb.GetEventShiftParams{ID: id, EventID: eventID})
	if errors.Is(err, pgx.ErrNoRows) {
		return Shift{}, apperror.NotFound
	}
	if err != nil {
		return Shift{}, err
	}
	if int64(current.Version) != input.ExpectedVersion {
		return Shift{}, apperror.StaleWrite
	}
	row, err := q.UpdateEventShift(ctx, eventsdb.UpdateEventShiftParams{SessionID: input.SessionID, Name: input.Name, Description: input.Description, StartsAt: input.StartsAt.UTC(), EndsAt: input.EndsAt.UTC(), SignupOpensAt: toPGTime(input.SignupOpensAt), SignupClosesAt: toPGTime(input.SignupClosesAt), IsPublic: input.IsPublic, Status: input.Status, ID: id, EventID: eventID, ExpectedVersion: int32(input.ExpectedVersion)})
	if errors.Is(err, pgx.ErrNoRows) {
		return Shift{}, apperror.StaleWrite
	}
	if err != nil {
		return Shift{}, databaseError(err)
	}
	actor := principal.AccountID
	if err := eventAudit(ctx, tx, &actor, "event_shift.updated", "event_shift", id, requestID, []string{"sessionId", "name", "description", "startsAt", "endsAt", "signupWindow", "isPublic", "status"}, map[string]any{"eventId": eventID.String()}); err != nil {
		return Shift{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Shift{}, err
	}
	return shiftFromRow(row), nil
}

func (s *Service) DeleteShift(ctx context.Context, principal authorization.Principal, eventID, id uuid.UUID, expected int64, requestID *uuid.UUID) error {
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
	if _, err := q.DeleteEventShift(ctx, eventsdb.DeleteEventShiftParams{ID: id, EventID: eventID, ExpectedVersion: int32(expected)}); err != nil {
		return databaseError(err)
	}
	actor := principal.AccountID
	if err := eventAudit(ctx, tx, &actor, "event_shift.deleted", "event_shift", id, requestID, nil, map[string]any{"eventId": eventID.String()}); err != nil {
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
		input.Status = "scheduled"
	}
	if input.Status != "scheduled" && input.Status != "cancelled" {
		return input, validation("session status is invalid")
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
		input.Status = "draft"
	}
	if input.Status != "draft" && input.Status != "open" && input.Status != "closed" && input.Status != "cancelled" {
		return input, validation("shift status is invalid")
	}
	if input.SignupOpensAt != nil && input.SignupClosesAt != nil && !input.SignupClosesAt.After(*input.SignupOpensAt) {
		return input, validation("signupClosesAt must be after signupOpensAt")
	}
	return input, nil
}

func sessionFromRow(row eventsdb.EventSession) Session {
	return Session{ID: row.ID, EventID: row.EventID, Name: row.Name, Location: row.Location, Description: row.Description, StartsAt: row.StartsAt, EndsAt: row.EndsAt, IsPublic: row.IsPublic, Status: row.Status, Version: int64(row.Version), CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
}
func shiftFromRow(row eventsdb.EventShift) Shift {
	return Shift{ID: row.ID, EventID: row.EventID, SessionID: row.SessionID, Name: row.Name, Description: row.Description, StartsAt: row.StartsAt, EndsAt: row.EndsAt, SignupOpensAt: pgTime(row.SignupOpensAt), SignupClosesAt: pgTime(row.SignupClosesAt), IsPublic: row.IsPublic, Status: row.Status, Version: int64(row.Version), CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
}

func requireEventWritable(ctx context.Context, q *eventsdb.Queries, eventID uuid.UUID, postEventWork bool) error {
	row, err := q.GetEventForUpdate(ctx, eventID)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	if err != nil {
		return err
	}
	if row.Status == "archived" || (!postEventWork && (row.Status == "completed" || row.Status == "cancelled")) {
		return apperror.New(409, "event_read_only", "Event is read-only")
	}
	return nil
}

var _ = time.Now
