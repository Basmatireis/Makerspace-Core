package events

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	eventsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/events/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Service struct {
	pool     *pgxpool.Pool
	cfg      config.Config
	files    *files.Service
	location *time.Location
	limiter  *signupLimiter
}

func NewService(pool *pgxpool.Pool, cfg config.Config, fileService *files.Service) (*Service, error) {
	location, err := time.LoadLocation(cfg.MakerspaceTimeZone)
	if err != nil {
		return nil, fmt.Errorf("load makerspace timezone: %w", err)
	}
	return &Service{pool: pool, cfg: cfg, files: fileService, location: location, limiter: newSignupLimiter(cfg.ChallengeHMACKey)}, nil
}

func canRead(principal authorization.Principal) bool {
	return principal.Has(authorization.EventsRead) || principal.Has(authorization.EventsManage) || principal.Has(authorization.EventsStaffingManage) || principal.Has(authorization.EventsAssign)
}

func canViewPII(principal authorization.Principal) bool {
	return principal.Has(authorization.EventsStaffingManage) || principal.Has(authorization.EventsAssign)
}

func (s *Service) List(ctx context.Context, principal authorization.Principal) ([]Event, error) {
	if !canRead(principal) {
		return nil, apperror.PermissionDenied
	}
	rows, err := eventsdb.New(s.pool).ListEvents(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]Event, 0, len(rows))
	for _, row := range rows {
		item, err := s.Get(ctx, principal, row.Event.ID)
		if err != nil {
			return nil, err
		}
		if row.OwnerFirstName != nil && row.OwnerLastName != nil {
			name := strings.TrimSpace(*row.OwnerFirstName + " " + *row.OwnerLastName)
			item.OwnerName = &name
		}
		result = append(result, item)
	}
	return result, nil
}

func (s *Service) Get(ctx context.Context, principal authorization.Principal, id uuid.UUID) (Event, error) {
	if !canRead(principal) {
		return Event{}, apperror.PermissionDenied
	}
	q := eventsdb.New(s.pool)
	row, err := q.GetEvent(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Event{}, apperror.NotFound
	}
	if err != nil {
		return Event{}, err
	}
	item := eventFromRow(row)
	sessions, err := q.ListEventSessions(ctx, id)
	if err != nil {
		return Event{}, err
	}
	shifts, err := q.ListEventShifts(ctx, id)
	if err != nil {
		return Event{}, err
	}
	for _, session := range sessions {
		if session.Status == "scheduled" {
			extendRange(&item, session.StartsAt, session.EndsAt)
		}
	}
	if item.RangeStartsAt == nil {
		for _, shift := range shifts {
			if shift.Status != "cancelled" {
				extendRange(&item, shift.StartsAt, shift.EndsAt)
			}
		}
	}
	summary, err := q.EventTaskSummary(ctx, id)
	if err != nil {
		return Event{}, err
	}
	item.TaskTotal, item.TaskCompleted = summary.Total, summary.Completed
	tasks, err := q.ListEventTasks(ctx, id)
	if err != nil {
		return Event{}, err
	}
	for _, task := range tasks {
		if task.Status != "done" && task.Status != "cancelled" {
			if due := pgTime(task.DueAt); due != nil {
				setEarlier(&item.NextDeadline, *due)
			}
		}
	}
	requirements, err := q.ListEventRequirements(ctx, id)
	if err != nil {
		return Event{}, err
	}
	for _, req := range requirements {
		item.RequiredCount += int64(req.RequiredCount)
		item.FilledCount += req.FilledCount
	}
	now := time.Now().UTC()
	for _, session := range sessions {
		if session.Status == "scheduled" && session.StartsAt.After(now) {
			setEarlier(&item.NextScheduleAt, session.StartsAt)
		}
	}
	for _, shift := range shifts {
		if shift.Status != "cancelled" && shift.StartsAt.After(now) {
			setEarlier(&item.NextScheduleAt, shift.StartsAt)
		}
	}
	item.HasBanner, err = q.EventBannerExists(ctx, id)
	if err != nil {
		return Event{}, err
	}
	return item, nil
}

func (s *Service) Create(ctx context.Context, principal authorization.Principal, input EventInput, requestID *uuid.UUID) (Event, error) {
	if !principal.Has(authorization.EventsManage) {
		return Event{}, apperror.PermissionDenied
	}
	name, err := cleanRequired(input.Name, "name", 200)
	if err != nil {
		return Event{}, err
	}
	description, err := cleanOptional(input.InternalDescription, 10000)
	if err != nil {
		return Event{}, err
	}
	location, err := cleanOptional(input.Location, 500)
	if err != nil {
		return Event{}, err
	}
	publicID, _, err := security.NewOpaqueToken()
	if err != nil {
		return Event{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Event{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	id := uuid.Must(uuid.NewV7())
	actor := principal.AccountID
	row, err := eventsdb.New(tx).CreateEvent(ctx, eventsdb.CreateEventParams{ID: id, Name: name, InternalDescription: description, Location: location, OwnerPersonID: input.OwnerPersonID, PublicID: publicID, CreatedByAccountID: &actor})
	if err != nil {
		return Event{}, databaseError(err)
	}
	if err := eventAudit(ctx, tx, &actor, "event.created", "event", id, requestID, []string{"name", "internalDescription", "location", "ownerPersonId"}, nil); err != nil {
		return Event{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Event{}, err
	}
	return eventFromRow(row), nil
}

func (s *Service) Update(ctx context.Context, principal authorization.Principal, id uuid.UUID, input EventInput, requestID *uuid.UUID) (Event, error) {
	if !principal.Has(authorization.EventsManage) {
		return Event{}, apperror.PermissionDenied
	}
	if err := validateVersion(input.ExpectedVersion); err != nil {
		return Event{}, err
	}
	name, err := cleanRequired(input.Name, "name", 200)
	if err != nil {
		return Event{}, err
	}
	description, err := cleanOptional(input.InternalDescription, 10000)
	if err != nil {
		return Event{}, err
	}
	location, err := cleanOptional(input.Location, 500)
	if err != nil {
		return Event{}, err
	}
	publicTitle, err := cleanOptional(input.PublicTitle, 200)
	if err != nil {
		return Event{}, err
	}
	publicDescription, err := cleanOptional(input.PublicDescription, 10000)
	if err != nil {
		return Event{}, err
	}
	publicLocation, err := cleanOptional(input.PublicLocation, 500)
	if err != nil {
		return Event{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Event{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := eventsdb.New(tx)
	current, err := q.GetEventForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Event{}, apperror.NotFound
	}
	if err != nil {
		return Event{}, err
	}
	if int64(current.Version) != input.ExpectedVersion {
		return Event{}, apperror.StaleWrite
	}
	if current.Status == "completed" || current.Status == "cancelled" || current.Status == "archived" {
		return Event{}, apperror.New(409, "event_read_only", "Event is read-only")
	}
	if input.PublicSignupEnabled {
		facts, err := q.EventPublicationFacts(ctx, id)
		if err != nil {
			return Event{}, err
		}
		if !facts.HasPublicRequirement {
			return Event{}, validation("Add a public shift with at least one requirement before enabling public signup")
		}
	}
	row, err := q.UpdateEvent(ctx, eventsdb.UpdateEventParams{Name: name, InternalDescription: description, Location: location, OwnerPersonID: input.OwnerPersonID, PublicTitle: publicTitle, PublicDescription: publicDescription, PublicLocation: publicLocation, PublicSignupEnabled: input.PublicSignupEnabled, ID: id, ExpectedVersion: int32(input.ExpectedVersion)})
	if errors.Is(err, pgx.ErrNoRows) {
		return Event{}, apperror.StaleWrite
	}
	if err != nil {
		return Event{}, databaseError(err)
	}
	actor := principal.AccountID
	if err := eventAudit(ctx, tx, &actor, "event.updated", "event", id, requestID, []string{"name", "internalDescription", "location", "ownerPersonId", "publicTitle", "publicDescription", "publicLocation", "publicSignupEnabled"}, nil); err != nil {
		return Event{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Event{}, err
	}
	return eventFromRow(row), nil
}

var lifecycleTransitions = map[string]map[string]bool{
	"draft": {"planning": true}, "planning": {"draft": true, "confirmed": true, "cancelled": true},
	"confirmed": {"planning": true, "completed": true, "cancelled": true}, "completed": {"archived": true}, "cancelled": {"archived": true},
}

func (s *Service) Transition(ctx context.Context, principal authorization.Principal, id uuid.UUID, expectedVersion int64, target string, requestID *uuid.UUID) (Event, error) {
	if !principal.Has(authorization.EventsManage) {
		return Event{}, apperror.PermissionDenied
	}
	if err := validateVersion(expectedVersion); err != nil {
		return Event{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Event{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := eventsdb.New(tx)
	current, err := q.GetEventForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Event{}, apperror.NotFound
	}
	if err != nil {
		return Event{}, err
	}
	if int64(current.Version) != expectedVersion {
		return Event{}, apperror.StaleWrite
	}
	if !lifecycleTransitions[current.Status][target] {
		return Event{}, apperror.New(409, "invalid_event_transition", "Event lifecycle transition is not allowed")
	}
	if target == "confirmed" {
		facts, err := q.EventPublicationFacts(ctx, id)
		if err != nil {
			return Event{}, err
		}
		if current.OwnerPersonID == nil || (!facts.HasSession && !facts.HasShift) {
			return Event{}, validation("confirmation requires an owner and a scheduled session or shift")
		}
	}
	closedAt := pgtype.Timestamptz{}
	if target == "completed" || target == "cancelled" {
		closedAt = pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true}
	}
	if target == "archived" {
		closedAt = current.ClosedAt
	}
	row, err := q.TransitionEvent(ctx, eventsdb.TransitionEventParams{Status: target, ClosedAt: closedAt, ID: id, ExpectedVersion: int32(expectedVersion)})
	if errors.Is(err, pgx.ErrNoRows) {
		return Event{}, apperror.StaleWrite
	}
	if err != nil {
		return Event{}, databaseError(err)
	}
	actor := principal.AccountID
	if err := eventAudit(ctx, tx, &actor, "event."+target, "event", id, requestID, []string{"status"}, nil); err != nil {
		return Event{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Event{}, err
	}
	return eventFromRow(row), nil
}

func (s *Service) SetPublished(ctx context.Context, principal authorization.Principal, id uuid.UUID, expectedVersion int64, published bool, requestID *uuid.UUID) (Event, error) {
	if !principal.Has(authorization.EventsManage) {
		return Event{}, apperror.PermissionDenied
	}
	if err := validateVersion(expectedVersion); err != nil {
		return Event{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Event{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := eventsdb.New(tx)
	current, err := q.GetEventForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Event{}, apperror.NotFound
	}
	if err != nil {
		return Event{}, err
	}
	if int64(current.Version) != expectedVersion {
		return Event{}, apperror.StaleWrite
	}
	if current.Status == "archived" {
		return Event{}, apperror.New(409, "event_read_only", "Event is read-only")
	}
	if published {
		if current.Status != "planning" && current.Status != "confirmed" {
			return Event{}, validation("only planning or confirmed events can be published")
		}
		facts, err := q.EventPublicationFacts(ctx, id)
		if err != nil {
			return Event{}, err
		}
		if current.OwnerPersonID == nil || current.PublicTitle == nil || (!facts.HasPublicSession && !facts.HasPublicShift) {
			return Event{}, validation("publication requires an owner, public title, and public schedule content")
		}
		if current.PublicSignupEnabled && !facts.HasPublicRequirement {
			return Event{}, validation("Add a public shift with at least one requirement before enabling public signup")
		}
	}
	row, err := q.SetEventPublication(ctx, eventsdb.SetEventPublicationParams{IsPublic: published, ID: id, ExpectedVersion: int32(expectedVersion)})
	if errors.Is(err, pgx.ErrNoRows) {
		return Event{}, apperror.StaleWrite
	}
	if err != nil {
		return Event{}, databaseError(err)
	}
	actor := principal.AccountID
	action := "event.unpublished"
	if published {
		action = "event.published"
	}
	if err := eventAudit(ctx, tx, &actor, action, "event", id, requestID, []string{"isPublic"}, nil); err != nil {
		return Event{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Event{}, err
	}
	return eventFromRow(row), nil
}

func (s *Service) RotatePublicID(ctx context.Context, principal authorization.Principal, id uuid.UUID, expectedVersion int64, requestID *uuid.UUID) (Event, error) {
	if !principal.Has(authorization.EventsManage) {
		return Event{}, apperror.PermissionDenied
	}
	if err := validateVersion(expectedVersion); err != nil {
		return Event{}, err
	}
	publicID, _, err := security.NewOpaqueToken()
	if err != nil {
		return Event{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Event{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := eventsdb.New(tx)
	current, err := q.GetEventForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Event{}, apperror.NotFound
	}
	if err != nil {
		return Event{}, err
	}
	if int64(current.Version) != expectedVersion {
		return Event{}, apperror.StaleWrite
	}
	if current.Status == "completed" || current.Status == "cancelled" || current.Status == "archived" {
		return Event{}, apperror.New(409, "event_read_only", "Event is read-only")
	}
	row, err := q.RotateEventPublicID(ctx, eventsdb.RotateEventPublicIDParams{PublicID: publicID, ID: id, ExpectedVersion: int32(expectedVersion)})
	if errors.Is(err, pgx.ErrNoRows) {
		return Event{}, apperror.StaleWrite
	}
	if err != nil {
		return Event{}, databaseError(err)
	}
	actor := principal.AccountID
	if err := eventAudit(ctx, tx, &actor, "event.public_id_rotated", "event", id, requestID, []string{"publicId"}, nil); err != nil {
		return Event{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Event{}, err
	}
	return eventFromRow(row), nil
}

func (s *Service) Delete(ctx context.Context, principal authorization.Principal, id uuid.UUID, expectedVersion int64, requestID *uuid.UUID) ([]uuid.UUID, error) {
	if !principal.Has(authorization.EventsManage) {
		return nil, apperror.PermissionDenied
	}
	if err := validateVersion(expectedVersion); err != nil {
		return nil, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := eventsdb.New(tx)
	current, err := q.GetEventForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, apperror.NotFound
	}
	if err != nil {
		return nil, err
	}
	if int64(current.Version) != expectedVersion {
		return nil, apperror.StaleWrite
	}
	if current.Status != "draft" {
		return nil, apperror.New(409, "event_not_deletable", "Only draft events can be deleted")
	}
	count, err := q.CountEventAssignmentHistory(ctx, id)
	if err != nil {
		return nil, err
	}
	if count != 0 {
		return nil, apperror.New(409, "event_has_assignment_history", "Event assignment history prevents deletion")
	}
	fileIDs, err := q.ListEventFileIDsForDelete(ctx, id)
	if err != nil {
		return nil, err
	}
	if _, err := q.DeleteDraftEvent(ctx, eventsdb.DeleteDraftEventParams{ID: id, ExpectedVersion: int32(expectedVersion)}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, apperror.StaleWrite
		}
		return nil, err
	}
	actor := principal.AccountID
	if err := eventAudit(ctx, tx, &actor, "event.deleted", "event", id, requestID, nil, nil); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return fileIDs, nil
}

func eventFromRow(row eventsdb.Event) Event {
	return Event{ID: row.ID, Name: row.Name, InternalDescription: row.InternalDescription, Location: row.Location, OwnerPersonID: row.OwnerPersonID, Status: row.Status, PublicTitle: row.PublicTitle, PublicDescription: row.PublicDescription, PublicLocation: row.PublicLocation, PublicID: row.PublicID, IsPublic: row.IsPublic, PublicSignupEnabled: row.PublicSignupEnabled, ClosedAt: pgTime(row.ClosedAt), Version: int64(row.Version), CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
}

func pgTime(value pgtype.Timestamptz) *time.Time {
	if !value.Valid {
		return nil
	}
	result := value.Time
	return &result
}
func toPGTime(value *time.Time) pgtype.Timestamptz {
	if value == nil {
		return pgtype.Timestamptz{}
	}
	return pgtype.Timestamptz{Time: value.UTC(), Valid: true}
}
func extendRange(event *Event, start, end time.Time) {
	setEarlier(&event.RangeStartsAt, start)
	if event.RangeEndsAt == nil || end.After(*event.RangeEndsAt) {
		value := end
		event.RangeEndsAt = &value
	}
}
func setEarlier(current **time.Time, value time.Time) {
	if *current == nil || value.Before(**current) {
		next := value
		*current = &next
	}
}

func eventAudit(ctx context.Context, tx pgx.Tx, actor *uuid.UUID, action, resourceType string, resourceID uuid.UUID, requestID *uuid.UUID, changed []string, metadata map[string]any) error {
	return audit.Write(ctx, tx, audit.Event{ActorAccountID: actor, Action: action, ResourceType: resourceType, ResourceID: &resourceID, RequestID: requestID, ChangedFields: changed, Metadata: metadata})
}

func databaseError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23503":
			return validation("A referenced resource does not exist")
		case "23505":
			return apperror.Conflict
		case "23514":
			return validation("The requested values are invalid")
		}
	}
	return err
}
