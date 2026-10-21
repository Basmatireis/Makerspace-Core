package events

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

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
	return &Service{
		pool:     pool,
		cfg:      cfg,
		files:    fileService,
		location: location,
		limiter:  newSignupLimiter(cfg.ChallengeHMACKey),
	}, nil
}

// List pages the events of one scope. Organizers (canSeeDrafts) see every event of the scope; everyone else never
// sees drafts and sees past events only when they helped at them.
func (s *Service) List(ctx context.Context, principal authorization.Principal, query ListQuery) (EventPage, error) {
	if !canRead(principal) {
		return EventPage{}, apperror.PermissionDenied
	}
	switch query.Scope {
	case "":
		query.Scope = ListScopeUpcoming
	case ListScopeUpcoming, ListScopeDrafts, ListScopePast:
	default:
		return EventPage{}, apperror.Invalid("scope must be upcoming, drafts, or past")
	}
	if query.Page == 0 {
		query.Page = 1
	}
	if query.PageSize == 0 {
		query.PageSize = DefaultListPageSize
	}
	if query.Page < 1 || query.PageSize < 1 || query.PageSize > MaxListPageSize {
		return EventPage{}, apperror.Invalid("page must be positive and pageSize between 1 and 100")
	}
	query.Search = strings.TrimSpace(query.Search)
	if len([]rune(query.Search)) > maxSearchLength {
		return EventPage{}, apperror.Invalid("search is too long")
	}
	now := time.Now().UTC()
	params := eventsdb.ListEventPageParams{
		Scope:         string(query.Scope),
		Now:           now,
		OwnerPersonID: query.OwnerPersonID,
		Search:        query.Search,
		PageOffset:    int32((query.Page - 1) * query.PageSize),
		PageLimit:     int32(query.PageSize),
	}
	if !canSeeDrafts(principal) {
		params.HelperPersonID = &principal.PersonID
	}
	q := eventsdb.New(s.pool)
	rows, err := q.ListEventPage(ctx, params)
	if err != nil {
		return EventPage{}, err
	}
	page := EventPage{Items: make([]Event, 0, len(rows)), Page: query.Page, PageSize: query.PageSize}
	for _, row := range rows {
		page.Total = row.Total
		event, err := q.GetEvent(ctx, row.ID)
		if err != nil {
			return EventPage{}, err
		}
		item, err := s.eventView(ctx, q, event, principal.PersonID, now)
		if err != nil {
			return EventPage{}, err
		}
		page.Items = append(page.Items, item)
	}
	return page, nil
}

func (s *Service) Get(ctx context.Context, principal authorization.Principal, id uuid.UUID) (Event, error) {
	q := eventsdb.New(s.pool)
	row, err := visibleEvent(ctx, q, principal, id)
	if err != nil {
		return Event{}, err
	}
	return s.eventView(ctx, q, row, principal.PersonID, time.Now().UTC())
}

func (s *Service) Create(
	ctx context.Context,
	principal authorization.Principal,
	input EventInput,
	requestID *uuid.UUID,
) (Event, error) {
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
	id := ids.New()
	actor := principal.AccountID
	row, err := eventsdb.New(tx).
		CreateEvent(
			ctx,
			eventsdb.CreateEventParams{
				ID:                  id,
				Name:                name,
				InternalDescription: description,
				Location:            location,
				OwnerPersonID:       input.OwnerPersonID,
				PublicID:            publicID,
				CreatedByAccountID:  &actor,
			},
		)
	if err != nil {
		return Event{}, databaseError(err)
	}
	if err := eventAudit(
		ctx,
		tx,
		&actor,
		"event.created",
		"event",
		id,
		requestID,
		[]string{"name", "internalDescription", "location", "ownerPersonId"},
		nil,
	); err != nil {
		return Event{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Event{}, err
	}
	return s.eventView(ctx, eventsdb.New(s.pool), row, principal.PersonID, time.Now().UTC())
}

func (s *Service) Update(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	input EventInput,
	requestID *uuid.UUID,
) (Event, error) {
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
	if EventStatus(current.Status).Closed() {
		return Event{}, eventReadOnly()
	}
	if input.PublicSignupEnabled {
		facts, err := q.EventPublicationFacts(ctx, id)
		if err != nil {
			return Event{}, err
		}
		if !facts.HasPublicRequirement {
			return Event{}, apperror.Invalid(
				"Add a public shift with at least one requirement before enabling public signup",
			)
		}
	}
	row, err := q.UpdateEvent(
		ctx,
		eventsdb.UpdateEventParams{
			Name:                name,
			InternalDescription: description,
			Location:            location,
			OwnerPersonID:       input.OwnerPersonID,
			PublicTitle:         publicTitle,
			PublicDescription:   publicDescription,
			PublicLocation:      publicLocation,
			PublicSignupEnabled: input.PublicSignupEnabled,
			ID:                  id,
			ExpectedVersion:     int32(input.ExpectedVersion),
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Event{}, apperror.StaleWrite
	}
	if err != nil {
		return Event{}, databaseError(err)
	}
	actor := principal.AccountID
	if err := eventAudit(
		ctx,
		tx,
		&actor,
		"event.updated",
		"event",
		id,
		requestID,
		[]string{
			"name",
			"internalDescription",
			"location",
			"ownerPersonId",
			"publicTitle",
			"publicDescription",
			"publicLocation",
			"publicSignupEnabled",
		},
		nil,
	); err != nil {
		return Event{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Event{}, err
	}
	return s.eventView(ctx, eventsdb.New(s.pool), row, principal.PersonID, time.Now().UTC())
}

// lifecycleTransitions lists the allowed status changes. Completed and cancelled are final.
var lifecycleTransitions = map[EventStatus]map[EventStatus]bool{
	EventStatusDraft:     {EventStatusConfirmed: true, EventStatusCancelled: true},
	EventStatusConfirmed: {EventStatusDraft: true, EventStatusCompleted: true, EventStatusCancelled: true},
}

func (s *Service) Transition(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	expectedVersion int64,
	target EventStatus,
	requestID *uuid.UUID,
) (Event, error) {
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
	if !lifecycleTransitions[EventStatus(current.Status)][target] {
		return Event{}, apperror.New(
			http.StatusConflict,
			"invalid_event_transition",
			"Event lifecycle transition is not allowed",
		)
	}
	if target == EventStatusConfirmed {
		facts, err := q.EventPublicationFacts(ctx, id)
		if err != nil {
			return Event{}, err
		}
		if current.OwnerPersonID == nil || (!facts.HasSession && !facts.HasShift) {
			return Event{}, apperror.Invalid("confirmation requires an owner and a scheduled session or shift")
		}
	}
	closedAt := pgtype.Timestamptz{}
	if target.Closed() {
		closedAt = pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true}
	}
	row, err := q.TransitionEvent(
		ctx,
		eventsdb.TransitionEventParams{
			Status:          string(target),
			ClosedAt:        closedAt,
			ID:              id,
			ExpectedVersion: int32(expectedVersion),
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Event{}, apperror.StaleWrite
	}
	if err != nil {
		return Event{}, databaseError(err)
	}
	actor := principal.AccountID
	if err := eventAudit(
		ctx,
		tx,
		&actor,
		"event."+string(target),
		"event",
		id,
		requestID,
		[]string{"status"},
		nil,
	); err != nil {
		return Event{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Event{}, err
	}
	return s.eventView(ctx, eventsdb.New(s.pool), row, principal.PersonID, time.Now().UTC())
}

func (s *Service) SetPublished(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	expectedVersion int64,
	published bool,
	requestID *uuid.UUID,
) (Event, error) {
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
	if published {
		if EventStatus(current.Status).Closed() {
			return Event{}, eventReadOnly()
		}
		facts, err := q.EventPublicationFacts(ctx, id)
		if err != nil {
			return Event{}, err
		}
		if current.OwnerPersonID == nil || current.PublicTitle == nil ||
			(!facts.HasPublicSession && !facts.HasPublicShift) {
			return Event{}, apperror.Invalid("publication requires an owner, public title, and public schedule content")
		}
		if current.PublicSignupEnabled && !facts.HasPublicRequirement {
			return Event{}, apperror.Invalid(
				"Add a public shift with at least one requirement before enabling public signup",
			)
		}
	}
	row, err := q.SetEventPublication(
		ctx,
		eventsdb.SetEventPublicationParams{IsPublic: published, ID: id, ExpectedVersion: int32(expectedVersion)},
	)
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
	return s.eventView(ctx, eventsdb.New(s.pool), row, principal.PersonID, time.Now().UTC())
}

func (s *Service) RotatePublicID(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	expectedVersion int64,
	requestID *uuid.UUID,
) (Event, error) {
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
	if EventStatus(current.Status).Closed() {
		return Event{}, eventReadOnly()
	}
	row, err := q.RotateEventPublicID(
		ctx,
		eventsdb.RotateEventPublicIDParams{PublicID: publicID, ID: id, ExpectedVersion: int32(expectedVersion)},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Event{}, apperror.StaleWrite
	}
	if err != nil {
		return Event{}, databaseError(err)
	}
	actor := principal.AccountID
	if err := eventAudit(
		ctx,
		tx,
		&actor,
		"event.public_id_rotated",
		"event",
		id,
		requestID,
		[]string{"publicId"},
		nil,
	); err != nil {
		return Event{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Event{}, err
	}
	return s.eventView(ctx, eventsdb.New(s.pool), row, principal.PersonID, time.Now().UTC())
}

func (s *Service) Delete(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	expectedVersion int64,
	requestID *uuid.UUID,
) ([]uuid.UUID, error) {
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
	if EventStatus(current.Status) != EventStatusDraft {
		return nil, apperror.New(http.StatusConflict, "event_not_deletable", "Only draft events can be deleted")
	}
	count, err := q.CountEventAssignmentHistory(ctx, id)
	if err != nil {
		return nil, err
	}
	if count != 0 {
		return nil, apperror.New(
			http.StatusConflict,
			"event_has_assignment_history",
			"Event assignment history prevents deletion",
		)
	}
	fileIDs, err := q.ListEventFileIDsForDelete(ctx, id)
	if err != nil {
		return nil, err
	}
	if _, err := q.DeleteDraftEvent(
		ctx,
		eventsdb.DeleteDraftEventParams{ID: id, ExpectedVersion: int32(expectedVersion)},
	); err != nil {
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
	return Event{
		ID:                  row.ID,
		Name:                row.Name,
		InternalDescription: row.InternalDescription,
		Location:            row.Location,
		OwnerPersonID:       row.OwnerPersonID,
		Status:              EventStatus(row.Status),
		PublicTitle:         row.PublicTitle,
		PublicDescription:   row.PublicDescription,
		PublicLocation:      row.PublicLocation,
		PublicID:            row.PublicID,
		IsPublic:            row.IsPublic,
		PublicSignupEnabled: row.PublicSignupEnabled,
		ClosedAt:            pgTime(row.ClosedAt),
		Version:             int64(row.Version),
		CreatedAt:           row.CreatedAt,
		UpdatedAt:           row.UpdatedAt,
	}
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

func eventAudit(
	ctx context.Context,
	tx pgx.Tx,
	actor *uuid.UUID,
	action, resourceType string,
	resourceID uuid.UUID,
	requestID *uuid.UUID,
	changed []string,
	metadata map[string]any,
) error {
	return audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: actor,
			Action:         action,
			ResourceType:   resourceType,
			ResourceID:     &resourceID,
			RequestID:      requestID,
			ChangedFields:  changed,
			Metadata:       metadata,
		},
	)
}

func databaseError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23503":
			return apperror.Invalid("A referenced resource does not exist")
		case "23505":
			return apperror.Conflict
		case "23514":
			return apperror.Invalid("The requested values are invalid")
		}
	}
	return err
}
