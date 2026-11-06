package opendays

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules"
	opendaysdb "github.com/Basmatireis/Makerspace-Core/backend/internal/opendays/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/trainings"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Period struct {
	ID                      uuid.UUID
	Name                    string
	StartsOn, EndsOn        time.Time
	SignUpDeadline          *time.Time
	Status                  PeriodStatus
	Version                 int64
	CreatedAt, UpdatedAt    time.Time
	TotalOpenDays           int
	FullyStaffedCount       int
	NeedsStaffCount         int
	OpenSupervisorPositions int
	CancelledCount          int
	MyAssignmentCount       int
}

type Assignment struct {
	ID, OpenDayID, TimeslotID, RequirementID, PersonID uuid.UUID
	DisplayName                                        string
	IsCurrentUser                                      bool
	CreatedAt                                          time.Time
}

type PersonAssignmentSummary struct {
	AssignmentID, OpenDayID, TimeslotID, PeriodID uuid.UUID
	PeriodName                                    string
	StartsAt, EndsAt                              time.Time
	Role                                          RequirementKind
}

type Requirement struct {
	ID, TimeslotID               uuid.UUID
	Kind                         RequirementKind
	RequiredCount, AssignedCount int
	EligibleRoleIDs              []uuid.UUID
	EligibleRolesVisible         bool
	// Eligible says the caller's membership and extra roles fit the place; CanJoin that they may sign up for it now.
	Eligible, CanJoin bool
	Assignments       *[]Assignment
}

type Timeslot struct {
	ID               uuid.UUID
	Position         int
	StartsAt, EndsAt time.Time
	Requirements     []Requirement
	MyAssignment     *Assignment
}

type OpenDay struct {
	ID, PeriodID        uuid.UUID
	StartsAt, EndsAt    time.Time
	InternalNote        *string
	InternalNoteVisible bool
	Status              DayStatus
	Timeslots           []Timeslot
	SeriesID            *uuid.UUID
	// DetachedFromSeriesID is the series a day came from before it was edited on its own.
	DetachedFromSeriesID *uuid.UUID
	// Requirements and MyAssignment flatten the timeslots for callers that look at the whole day: every timeslot's
	// places in timeslot order, and the caller's earliest assignment.
	Requirements []Requirement
	MyAssignment *Assignment
	// Competencies are the planned competencies derived from the assigned supervisors' training records.
	Competencies         []trainings.Competency
	Version              int64
	CreatedAt, UpdatedAt time.Time
}

type RequirementInput struct {
	Kind            RequirementKind
	RequiredCount   int
	EligibleRoleIDs []uuid.UUID
}

// TimeslotInput is one timeslot of a day being saved. ID names an existing timeslot of the day that keeps its
// assignments; nil creates a new one.
type TimeslotInput struct {
	ID               *uuid.UUID
	StartsAt, EndsAt time.Time
	Requirements     []RequirementInput
}

type ScheduleInput struct {
	ID              uuid.UUID
	ExpectedVersion int64
	InternalNote    *string
	Timeslots       []TimeslotInput
	// StartsAt, EndsAt and Requirements describe a day with one timeslot when Timeslots is empty; an update in
	// that form keeps the day's only timeslot and its assignments.
	StartsAt, EndsAt time.Time
	Requirements     []RequirementInput
}

func (in ScheduleInput) timeslots() []TimeslotInput {
	if len(in.Timeslots) > 0 {
		return in.Timeslots
	}
	return []TimeslotInput{{StartsAt: in.StartsAt, EndsAt: in.EndsAt, Requirements: in.Requirements}}
}

type RemovalInput struct {
	ID              uuid.UUID
	ExpectedVersion int64
}

type ScheduleDelta struct {
	ExpectedPeriodVersion int64
	Creates, Updates      []ScheduleInput
	Removals              []RemovalInput
	SeriesCreates         []SeriesCreate
	SeriesUpdates         []SeriesUpdate
	SeriesRejoins         []SeriesRejoin
}

type Schedule struct {
	Period   Period
	Items    []OpenDay
	TimeZone string
}

type Service struct {
	pool     *pgxpool.Pool
	cfg      config.Config
	location *time.Location
	holidays HolidayProvider
	inbox    NotificationEmitter
}

// NotificationEmitter is the part of the notification event source this package uses. It writes inside
// the caller's transaction.
type NotificationEmitter interface {
	PeriodOpens(ctx context.Context, tx pgx.Tx, periodID uuid.UUID) error
	// OpenDayPlaceFreed is told about a supervisor place that became free in a timeslot.
	PlaceFreed(
		ctx context.Context,
		tx pgx.Tx,
		timeslotID, leavingPersonID uuid.UUID,
		location *time.Location,
	) error
	// OpenDayPersonNotice tells one person what changed about their own place on an open day.
	OpenDayPersonNotice(
		ctx context.Context,
		tx pgx.Tx,
		kind notifyrules.OpenDayChangeKind,
		personID uuid.UUID,
		notice notifyrules.OpenDayNotice,
		location *time.Location,
	) error
}

func NewService(pool *pgxpool.Pool, emitter NotificationEmitter, cfg config.Config) (*Service, error) {
	timeZone := cfg.MakerspaceTimeZone
	if timeZone == "" {
		timeZone = "Europe/Vienna"
	}
	location, err := time.LoadLocation(timeZone)
	if err != nil {
		return nil, fmt.Errorf("load makerspace timezone: %w", err)
	}
	holidayProvider, err := newHolidayProvider(cfg)
	if err != nil {
		return nil, err
	}
	return &Service{
		pool: pool, cfg: cfg, location: location, holidays: holidayProvider, inbox: emitter,
	}, nil
}

func (s *Service) ListPeriods(ctx context.Context, principal authorization.Principal) ([]Period, error) {
	if !canRead(principal) {
		return nil, apperror.PermissionDenied
	}
	queries := opendaysdb.New(s.pool)
	rows, err := queries.ListPeriods(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]Period, 0, len(rows))
	for _, row := range rows {
		if PeriodStatus(row.Status) == PeriodDraft && !principal.Has(authorization.OpenDaysManage) {
			continue
		}
		item, err := s.periodFromRow(ctx, queries, principal, row)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, nil
}

func (s *Service) ListUpcomingAssignmentsForPerson(
	ctx context.Context,
	principal authorization.Principal,
	personID uuid.UUID,
) ([]PersonAssignmentSummary, error) {
	if !principal.CanReadPerson(personID) || !principal.Has(authorization.OpenDaysReadAssignments) {
		return nil, apperror.PermissionDenied
	}
	rows, err := opendaysdb.New(s.pool).ListUpcomingAssignmentsForPerson(ctx, personID)
	if err != nil {
		return nil, err
	}
	result := make([]PersonAssignmentSummary, 0, len(rows))
	for _, row := range rows {
		result = append(result, PersonAssignmentSummary{
			AssignmentID: row.AssignmentID, OpenDayID: row.OpenDayID, PeriodID: row.PeriodID,
			PeriodName: row.PeriodName, StartsAt: row.StartsAt, EndsAt: row.EndsAt, Role: RequirementKind(row.Kind),
		})
	}
	return result, nil
}

func (s *Service) GetPeriod(ctx context.Context, principal authorization.Principal, id uuid.UUID) (Period, error) {
	if !canRead(principal) {
		return Period{}, apperror.PermissionDenied
	}
	queries := opendaysdb.New(s.pool)
	row, err := queries.GetPeriod(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Period{}, apperror.NotFound
	}
	if err != nil {
		return Period{}, err
	}
	if PeriodStatus(row.Status) == PeriodDraft && !principal.Has(authorization.OpenDaysManage) {
		return Period{}, apperror.NotFound
	}
	return s.periodFromRow(ctx, queries, principal, row)
}

func (s *Service) CreatePeriod(
	ctx context.Context,
	principal authorization.Principal,
	name string,
	startsOn, endsOn time.Time,
	signUpDeadline *time.Time,
	requestID *uuid.UUID,
) (Period, error) {
	return s.CreatePeriodCopyingSeries(ctx, principal, name, startsOn, endsOn, signUpDeadline, nil, requestID)
}

// CreatePeriodCopyingSeries creates a draft period; with copySeriesFrom it also copies that period's weekly series
// into it and generates their open days in the same transaction.
func (s *Service) CreatePeriodCopyingSeries(
	ctx context.Context,
	principal authorization.Principal,
	name string,
	startsOn, endsOn time.Time,
	signUpDeadline *time.Time,
	copySeriesFrom *uuid.UUID,
	requestID *uuid.UUID,
) (Period, error) {
	if !principal.Has(authorization.OpenDaysManage) {
		return Period{}, apperror.PermissionDenied
	}
	name, err := validatePeriod(name, startsOn, endsOn, signUpDeadline)
	if err != nil {
		return Period{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Period{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := opendaysdb.New(tx)
	id := ids.New()
	row, err := queries.CreatePeriod(
		ctx,
		opendaysdb.CreatePeriodParams{
			ID: id, Name: name, StartsOn: pgDate(startsOn), EndsOn: pgDate(endsOn),
			SignUpDeadline: optionalPgDate(signUpDeadline),
		},
	)
	if err != nil {
		return Period{}, databaseError(err)
	}
	if err := writeAudit(
		ctx,
		tx,
		principal,
		"open_day_period.created",
		"open_day_period",
		id,
		requestID,
		[]string{"name", "startsOn", "endsOn", "signUpDeadline"},
	); err != nil {
		return Period{}, err
	}
	if copySeriesFrom != nil {
		if err := s.copySeries(ctx, tx, principal, *copySeriesFrom, row, requestID); err != nil {
			return Period{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Period{}, err
	}
	return periodBase(row), nil
}

func (s *Service) UpdatePeriod(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	expected int64,
	name string,
	startsOn, endsOn time.Time,
	signUpDeadline *time.Time,
	requestID *uuid.UUID,
) (Period, error) {
	if !principal.Has(authorization.OpenDaysManage) {
		return Period{}, apperror.PermissionDenied
	}
	name, err := validatePeriod(name, startsOn, endsOn, signUpDeadline)
	if err != nil || expected < 1 {
		if err != nil {
			return Period{}, err
		}
		return Period{}, apperror.Invalid("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Period{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := opendaysdb.New(tx)
	current, err := queries.GetPeriodForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Period{}, apperror.NotFound
	}
	if err != nil {
		return Period{}, err
	}
	if current.Version != expected {
		return Period{}, apperror.StaleWrite
	}
	// Outside draft only the sign-up deadline may change, so the Leitung can set it for a running semester.
	if status := PeriodStatus(current.Status); status != PeriodDraft {
		boundsKept := name == current.Name && sameDate(startsOn, current.StartsOn.Time) && sameDate(endsOn, current.EndsOn.Time)
		if status == PeriodArchived || !boundsKept {
			return Period{}, apperror.Conflicting("period_not_draft", "Period metadata can only be edited in draft")
		}
	}
	days, err := queries.ListOpenDaysByPeriod(ctx, id)
	if err != nil {
		return Period{}, err
	}
	for _, day := range days {
		if !dateWithin(day.StartsAt.In(s.location), startsOn, endsOn) ||
			!dateWithin(day.EndsAt.Add(-time.Nanosecond).In(s.location), startsOn, endsOn) {
			return Period{}, apperror.Invalid("period bounds must contain every Open Day")
		}
	}
	row, err := queries.UpdatePeriod(
		ctx,
		opendaysdb.UpdatePeriodParams{
			Name:            name,
			StartsOn:        pgDate(startsOn),
			EndsOn:          pgDate(endsOn),
			SignUpDeadline:  optionalPgDate(signUpDeadline),
			ID:              id,
			ExpectedVersion: expected,
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Period{}, apperror.StaleWrite
	}
	if err != nil {
		return Period{}, databaseError(err)
	}
	if err := writeAudit(
		ctx,
		tx,
		principal,
		"open_day_period.updated",
		"open_day_period",
		id,
		requestID,
		[]string{"name", "startsOn", "endsOn", "signUpDeadline"},
	); err != nil {
		return Period{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Period{}, err
	}
	return periodBase(row), nil
}

func (s *Service) DeletePeriod(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) error {
	if !principal.Has(authorization.OpenDaysManage) {
		return apperror.PermissionDenied
	}
	if expected < 1 {
		return apperror.Invalid("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := opendaysdb.New(tx)
	current, err := q.GetPeriodForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	if err != nil {
		return err
	}
	if current.Version != expected {
		return apperror.StaleWrite
	}
	if _, err := q.DeletePeriod(ctx, opendaysdb.DeletePeriodParams{ID: id, ExpectedVersion: expected}); errors.Is(
		err,
		pgx.ErrNoRows,
	) {
		return apperror.StaleWrite
	} else if err != nil {
		return databaseError(err)
	}
	if err := writeAudit(
		ctx,
		tx,
		principal,
		"open_day_period.deleted",
		"open_day_period",
		id,
		requestID,
		nil,
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) TransitionPeriod(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	expected int64,
	target PeriodStatus,
	requestID *uuid.UUID,
) (Period, error) {
	if !principal.Has(authorization.OpenDaysManage) {
		return Period{}, apperror.PermissionDenied
	}
	allowed := map[PeriodStatus]map[PeriodStatus]bool{
		PeriodDraft:     {PeriodStaffing: true},
		PeriodStaffing:  {PeriodDraft: true, PeriodPublished: true},
		PeriodPublished: {PeriodStaffing: true, PeriodArchived: true},
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Period{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := opendaysdb.New(tx)
	current, err := q.GetPeriodForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Period{}, apperror.NotFound
	}
	if err != nil {
		return Period{}, err
	}
	if current.Version != expected {
		return Period{}, apperror.StaleWrite
	}
	if !allowed[PeriodStatus(current.Status)][target] {
		return Period{}, apperror.Conflicting("invalid_period_transition", "Open Day period transition is not allowed")
	}
	row, err := q.TransitionPeriod(
		ctx,
		opendaysdb.TransitionPeriodParams{Status: string(target), ID: id, ExpectedVersion: expected},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Period{}, apperror.StaleWrite
	}
	if err != nil {
		return Period{}, err
	}
	if err := writeAudit(
		ctx,
		tx,
		principal,
		"open_day_period."+string(target),
		"open_day_period",
		id,
		requestID,
		[]string{"status"},
	); err != nil {
		return Period{}, err
	}
	// Sign-up opens the first time a draft is moved to staffing; reopening a published period was
	// open before.
	if PeriodStatus(current.Status) == PeriodDraft && target == PeriodStaffing {
		if err := s.inbox.PeriodOpens(ctx, tx, id); err != nil {
			return Period{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Period{}, err
	}
	return periodBase(row), nil
}

func (s *Service) GetSchedule(
	ctx context.Context,
	principal authorization.Principal,
	periodID uuid.UUID,
) (Schedule, error) {
	period, err := s.GetPeriod(ctx, principal, periodID)
	if err != nil {
		return Schedule{}, err
	}
	q := opendaysdb.New(s.pool)
	periodRow, err := q.GetPeriod(ctx, periodID)
	if err != nil {
		return Schedule{}, err
	}
	rows, err := q.ListOpenDaysByPeriod(ctx, periodID)
	if err != nil {
		return Schedule{}, err
	}
	items, err := s.loadDays(ctx, q, principal, periodRow, rows)
	if err != nil {
		return Schedule{}, err
	}
	if err := s.attachCompetencies(ctx, items); err != nil {
		return Schedule{}, err
	}
	return Schedule{Period: period, Items: items, TimeZone: s.location.String()}, nil
}

func (s *Service) GetOpenDay(ctx context.Context, principal authorization.Principal, id uuid.UUID) (OpenDay, error) {
	if !canRead(principal) {
		return OpenDay{}, apperror.PermissionDenied
	}
	q := opendaysdb.New(s.pool)
	row, err := q.GetOpenDay(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return OpenDay{}, apperror.NotFound
	}
	if err != nil {
		return OpenDay{}, err
	}
	p, err := q.GetPeriod(ctx, row.PeriodID)
	if err != nil {
		return OpenDay{}, err
	}
	if PeriodStatus(p.Status) == PeriodDraft && !principal.Has(authorization.OpenDaysManage) {
		return OpenDay{}, apperror.NotFound
	}
	items, err := s.loadDays(ctx, q, principal, p, []opendaysdb.OpenDay{row})
	if err != nil {
		return OpenDay{}, err
	}
	if err := s.attachCompetencies(ctx, items); err != nil {
		return OpenDay{}, err
	}
	return items[0], nil
}

func (s *Service) attachCompetencies(ctx context.Context, items []OpenDay) error {
	dayIDs := make([]uuid.UUID, 0, len(items))
	for _, item := range items {
		dayIDs = append(dayIDs, item.ID)
	}
	competencies, err := trainings.OpenDayCompetencies(ctx, s.pool, dayIDs)
	if err != nil {
		return err
	}
	for i := range items {
		items[i].Competencies = competenciesOrEmpty(competencies[items[i].ID])
	}
	return nil
}

func competenciesOrEmpty(items []trainings.Competency) []trainings.Competency {
	if items == nil {
		return []trainings.Competency{}
	}
	return items
}

func (s *Service) CreateOpenDay(
	ctx context.Context,
	principal authorization.Principal,
	periodID uuid.UUID,
	expected int64,
	input ScheduleInput,
	requestID *uuid.UUID,
) (Schedule, error) {
	delta := ScheduleDelta{ExpectedPeriodVersion: expected, Creates: []ScheduleInput{input}}
	return s.SaveSchedule(ctx, principal, periodID, delta, requestID)
}

func (s *Service) UpdateOpenDay(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	expectedPeriod int64,
	input ScheduleInput,
	requestID *uuid.UUID,
) (Schedule, error) {
	q := opendaysdb.New(s.pool)
	row, err := q.GetOpenDay(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Schedule{}, apperror.NotFound
	}
	if err != nil {
		return Schedule{}, err
	}
	input.ID = id
	return s.SaveSchedule(
		ctx,
		principal,
		row.PeriodID,
		ScheduleDelta{ExpectedPeriodVersion: expectedPeriod, Updates: []ScheduleInput{input}},
		requestID,
	)
}

func (s *Service) RemoveOpenDay(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	expectedPeriod, expectedDay int64,
	requestID *uuid.UUID,
) (Schedule, error) {
	q := opendaysdb.New(s.pool)
	row, err := q.GetOpenDay(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Schedule{}, apperror.NotFound
	}
	if err != nil {
		return Schedule{}, err
	}
	if expectedPeriod == 0 {
		period, err := q.GetPeriod(ctx, row.PeriodID)
		if err != nil {
			return Schedule{}, err
		}
		expectedPeriod = period.Version
	}
	return s.SaveSchedule(
		ctx,
		principal,
		row.PeriodID,
		ScheduleDelta{
			ExpectedPeriodVersion: expectedPeriod,
			Removals:              []RemovalInput{{ID: id, ExpectedVersion: expectedDay}},
		},
		requestID,
	)
}

func (s *Service) CancelOpenDay(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	expectedPeriod, expectedDay int64,
	requestID *uuid.UUID,
) (Schedule, error) {
	return s.RemoveOpenDay(ctx, principal, id, expectedPeriod, expectedDay, requestID)
}

func (s *Service) periodFromRow(
	ctx context.Context,
	q *opendaysdb.Queries,
	principal authorization.Principal,
	row opendaysdb.OpenDayPeriod,
) (Period, error) {
	result := periodBase(row)
	days, err := q.ListOpenDaysByPeriod(ctx, row.ID)
	if err != nil {
		return Period{}, err
	}
	counts, err := q.ListPeriodRequirementCounts(ctx, row.ID)
	if err != nil {
		return Period{}, err
	}
	mine, err := q.ListPersonDaysInPeriod(
		ctx,
		opendaysdb.ListPersonDaysInPeriodParams{PeriodID: row.ID, PersonID: principal.PersonID},
	)
	if err != nil {
		return Period{}, err
	}
	short := map[uuid.UUID]bool{}
	for _, count := range counts {
		if count.AssignedCount < int64(count.RequiredCount) {
			short[count.OpenDayID] = true
			if RequirementKind(count.Kind) == RequirementSupervisor {
				result.OpenSupervisorPositions += int(int64(count.RequiredCount) - count.AssignedCount)
			}
		}
	}
	for _, day := range days {
		if DayStatus(day.Status) == DayCancelled {
			result.CancelledCount++
			continue
		}
		result.TotalOpenDays++
		if short[day.ID] {
			result.NeedsStaffCount++
		} else {
			result.FullyStaffedCount++
		}
	}
	// Days the caller holds at least one timeslot of.
	result.MyAssignmentCount = len(mine)
	return result, nil
}

// loadDays assembles the days with their timeslots, places and assignments as the principal may see them. Every
// day must belong to period.
func (s *Service) loadDays(
	ctx context.Context,
	q *opendaysdb.Queries,
	principal authorization.Principal,
	period opendaysdb.OpenDayPeriod,
	rows []opendaysdb.OpenDay,
) ([]OpenDay, error) {
	dayIDs := make([]uuid.UUID, 0, len(rows))
	for _, row := range rows {
		dayIDs = append(dayIDs, row.ID)
	}
	timeslots, err := q.ListTimeslotsByDays(ctx, idTexts(dayIDs))
	if err != nil {
		return nil, err
	}
	requirements, err := q.ListRequirementsByDays(ctx, idTexts(dayIDs))
	if err != nil {
		return nil, err
	}
	assignments, err := q.ListAssignmentsByDays(ctx, idTexts(dayIDs))
	if err != nil {
		return nil, err
	}
	manage := principal.Has(authorization.OpenDaysManage)
	rolesByRequirement := map[uuid.UUID][]uuid.UUID{}
	if manage {
		roleRows, err := q.ListRequirementRolesByDays(ctx, idTexts(dayIDs))
		if err != nil {
			return nil, err
		}
		for _, row := range roleRows {
			rolesByRequirement[row.RequirementID] = append(rolesByRequirement[row.RequirementID], row.RoleID)
		}
	}
	eligible := map[uuid.UUID]bool{}
	if principal.PersonID != uuid.Nil {
		eligibleIDs, err := q.ListEligibleRequirementsByDays(
			ctx,
			opendaysdb.ListEligibleRequirementsByDaysParams{OpenDayIds: idTexts(dayIDs), PersonID: principal.PersonID},
		)
		if err != nil {
			return nil, err
		}
		for _, id := range eligibleIDs {
			eligible[id] = true
		}
	}
	byRequirement := map[uuid.UUID][]Assignment{}
	mine := map[uuid.UUID]*Assignment{}
	for _, a := range assignments {
		item := Assignment{
			ID:            a.ID,
			OpenDayID:     a.OpenDayID,
			TimeslotID:    a.TimeslotID,
			RequirementID: a.RequirementID,
			PersonID:      a.PersonID,
			DisplayName:   strings.TrimSpace(a.FirstName + " " + a.LastName),
			IsCurrentUser: a.PersonID == principal.PersonID,
			CreatedAt:     a.CreatedAt,
		}
		byRequirement[a.RequirementID] = append(byRequirement[a.RequirementID], item)
		if item.IsCurrentUser {
			own := item
			mine[a.TimeslotID] = &own
		}
	}
	requirementsBySlot := map[uuid.UUID][]opendaysdb.ListRequirementsByDaysRow{}
	for _, row := range requirements {
		requirementsBySlot[row.TimeslotID] = append(requirementsBySlot[row.TimeslotID], row)
	}
	slotsByDay := map[uuid.UUID][]opendaysdb.OpenDayTimeslot{}
	for _, row := range timeslots {
		slotsByDay[row.OpenDayID] = append(slotsByDay[row.OpenDayID], row)
	}
	open := assignmentsOpen(period)
	now := time.Now()
	result := make([]OpenDay, 0, len(rows))
	for _, row := range rows {
		day := OpenDay{
			ID:                   row.ID,
			PeriodID:             row.PeriodID,
			StartsAt:             row.StartsAt,
			EndsAt:               row.EndsAt,
			Status:               DayStatus(row.Status),
			SeriesID:             row.SeriesID,
			DetachedFromSeriesID: row.DetachedFromSeriesID,
			Version:              row.Version,
			CreatedAt:            row.CreatedAt,
			UpdatedAt:            row.UpdatedAt,
			Timeslots:            []Timeslot{},
			Requirements:         []Requirement{},
		}
		if manage {
			day.InternalNote = row.InternalNote
			day.InternalNoteVisible = true
		}
		for _, slot := range slotsByDay[row.ID] {
			item := Timeslot{
				ID:           slot.ID,
				Position:     int(slot.Position),
				StartsAt:     slot.StartsAt,
				EndsAt:       slot.EndsAt,
				Requirements: []Requirement{},
				MyAssignment: mine[slot.ID],
			}
			joinable := open && day.Status == DayScheduled && slot.EndsAt.After(now) &&
				principal.Has(authorization.OpenDaysSignup) && item.MyAssignment == nil
			for _, req := range requirementsBySlot[slot.ID] {
				requirement := Requirement{
					ID:            req.ID,
					TimeslotID:    req.TimeslotID,
					Kind:          RequirementKind(req.Kind),
					RequiredCount: int(req.RequiredCount),
					AssignedCount: int(req.AssignedCount),
					Eligible:      eligible[req.ID],
				}
				requirement.CanJoin = joinable && requirement.Eligible && req.AssignedCount < int64(req.RequiredCount)
				if manage {
					requirement.EligibleRolesVisible = true
					requirement.EligibleRoleIDs = rolesByRequirement[req.ID]
					if requirement.EligibleRoleIDs == nil {
						requirement.EligibleRoleIDs = []uuid.UUID{}
					}
				}
				if principal.Has(authorization.OpenDaysReadAssignments) {
					values := byRequirement[req.ID]
					if values == nil {
						values = []Assignment{}
					}
					requirement.Assignments = &values
				}
				item.Requirements = append(item.Requirements, requirement)
			}
			sort.Slice(item.Requirements, func(i, j int) bool { return item.Requirements[i].Kind < item.Requirements[j].Kind })
			day.Requirements = append(day.Requirements, item.Requirements...)
			if day.MyAssignment == nil && item.MyAssignment != nil {
				day.MyAssignment = item.MyAssignment
			}
			day.Timeslots = append(day.Timeslots, item)
		}
		result = append(result, day)
	}
	return result, nil
}

func assignmentsOpen(period opendaysdb.OpenDayPeriod) bool {
	status := PeriodStatus(period.Status)
	return status == PeriodStaffing || status == PeriodPublished
}

func validatePeriod(name string, start, end time.Time, signUpDeadline *time.Time) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || len([]rune(name)) > 150 {
		return "", apperror.Invalid("period name is invalid")
	}
	if start.IsZero() || end.IsZero() || end.Before(start) {
		return "", apperror.Invalid("period date range is invalid")
	}
	if signUpDeadline != nil && !dateWithin(*signUpDeadline, start, end) {
		return "", apperror.Invalid("sign-up deadline must lie within the period")
	}
	return name, nil
}
func sameDate(a, b time.Time) bool {
	return a.Format(time.DateOnly) == b.Format(time.DateOnly)
}

func optionalPgDate(t *time.Time) pgtype.Date {
	if t == nil {
		return pgtype.Date{}
	}
	return pgDate(*t)
}
func periodBase(r opendaysdb.OpenDayPeriod) Period {
	var signUpDeadline *time.Time
	if r.SignUpDeadline.Valid {
		value := r.SignUpDeadline.Time
		signUpDeadline = &value
	}
	return Period{
		ID:             r.ID,
		Name:           r.Name,
		StartsOn:       r.StartsOn.Time,
		EndsOn:         r.EndsOn.Time,
		SignUpDeadline: signUpDeadline,
		Status:         PeriodStatus(r.Status),
		Version:        r.Version,
		CreatedAt:      r.CreatedAt,
		UpdatedAt:      r.UpdatedAt,
	}
}
func canRead(p authorization.Principal) bool {
	return p.Has(authorization.OpenDaysRead) || p.Has(authorization.OpenDaysManage)
}
func pgDate(t time.Time) pgtype.Date {
	return pgtype.Date{Time: time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC), Valid: true}
}
func dateWithin(value, start, end time.Time) bool {
	v := time.Date(value.Year(), value.Month(), value.Day(), 0, 0, 0, 0, time.UTC)
	s := time.Date(start.Year(), start.Month(), start.Day(), 0, 0, 0, 0, time.UTC)
	e := time.Date(end.Year(), end.Month(), end.Day(), 0, 0, 0, 0, time.UTC)
	return !v.Before(s) && !v.After(e)
}
func cleanNote(v *string) *string {
	if v == nil {
		return nil
	}
	text := strings.TrimSpace(*v)
	if text == "" {
		return nil
	}
	return &text
}

// idTexts passes IDs as text so the queries also run in pgx's simple protocol mode.
func idTexts(values []uuid.UUID) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		out = append(out, value.String())
	}
	return out
}

func uniqueIDs(ids []uuid.UUID) []uuid.UUID {
	seen := map[uuid.UUID]bool{}
	out := make([]uuid.UUID, 0, len(ids))
	for _, id := range ids {
		if id != uuid.Nil && !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}
func databaseError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && (pgErr.Code == "23505" || pgErr.Code == "23503" || pgErr.Code == "23514") {
		return apperror.Conflict
	}
	return err
}

func writeAudit(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	action, resource string,
	id uuid.UUID,
	requestID *uuid.UUID,
	fields []string,
) error {
	return writeAuditWithMetadata(ctx, tx, p, action, resource, id, requestID, fields, nil)
}

func writeAuditWithMetadata(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	action, resource string,
	id uuid.UUID,
	requestID *uuid.UUID,
	fields []string,
	metadata map[string]any,
) error {
	actor := p.AccountID
	return audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         action,
			ResourceType:   resource,
			ResourceID:     &id,
			RequestID:      requestID,
			ChangedFields:  fields,
			Metadata:       metadata,
		},
	)
}
