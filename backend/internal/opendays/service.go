package opendays

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	opendaysdb "github.com/Basmatireis/Makerspace-Core/backend/internal/opendays/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
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
	Status                  string
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
	ID, OpenDayID, RequirementID, PersonID uuid.UUID
	DisplayName                            string
	IsCurrentUser                          bool
	CreatedAt                              time.Time
}

type Requirement struct {
	ID                           uuid.UUID
	Kind                         string
	RequiredCount, AssignedCount int
	EligibleRoleIDs              []uuid.UUID
	EligibleRolesVisible         bool
	Assignments                  *[]Assignment
}

type OpenDay struct {
	ID, PeriodID         uuid.UUID
	StartsAt, EndsAt     time.Time
	InternalNote         *string
	InternalNoteVisible  bool
	Status               string
	Requirements         []Requirement
	MyAssignment         *Assignment
	Version              int64
	CreatedAt, UpdatedAt time.Time
}

type RequirementInput struct {
	Kind            string
	RequiredCount   int
	EligibleRoleIDs []uuid.UUID
}

type ScheduleInput struct {
	ID               uuid.UUID
	ExpectedVersion  int64
	StartsAt, EndsAt time.Time
	InternalNote     *string
	Requirements     []RequirementInput
}

type RemovalInput struct {
	ID              uuid.UUID
	ExpectedVersion int64
}

type ScheduleDelta struct {
	ExpectedPeriodVersion int64
	Creates, Updates      []ScheduleInput
	Removals              []RemovalInput
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
}

func NewService(pool *pgxpool.Pool, cfg config.Config) (*Service, error) {
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
	return &Service{pool: pool, cfg: cfg, location: location, holidays: holidayProvider}, nil
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
		if row.Status == "draft" && !principal.Has(authorization.OpenDaysManage) {
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
	if row.Status == "draft" && !principal.Has(authorization.OpenDaysManage) {
		return Period{}, apperror.NotFound
	}
	return s.periodFromRow(ctx, queries, principal, row)
}

func (s *Service) CreatePeriod(ctx context.Context, principal authorization.Principal, name string, startsOn, endsOn time.Time, requestID *uuid.UUID) (Period, error) {
	if !principal.Has(authorization.OpenDaysManage) {
		return Period{}, apperror.PermissionDenied
	}
	name, err := validatePeriod(name, startsOn, endsOn)
	if err != nil {
		return Period{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Period{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := opendaysdb.New(tx)
	id := uuid.Must(uuid.NewV7())
	row, err := queries.CreatePeriod(ctx, opendaysdb.CreatePeriodParams{ID: id, Name: name, StartsOn: pgDate(startsOn), EndsOn: pgDate(endsOn)})
	if err != nil {
		return Period{}, databaseError(err)
	}
	if err := writeAudit(ctx, tx, principal, "open_day_period.created", "open_day_period", id, requestID, []string{"name", "startsOn", "endsOn"}); err != nil {
		return Period{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Period{}, err
	}
	return periodBase(row), nil
}

func (s *Service) UpdatePeriod(ctx context.Context, principal authorization.Principal, id uuid.UUID, expected int64, name string, startsOn, endsOn time.Time, requestID *uuid.UUID) (Period, error) {
	if !principal.Has(authorization.OpenDaysManage) {
		return Period{}, apperror.PermissionDenied
	}
	name, err := validatePeriod(name, startsOn, endsOn)
	if err != nil || expected < 1 {
		if err != nil {
			return Period{}, err
		}
		return Period{}, validation("expectedVersion must be positive")
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
	if current.Status != "draft" {
		return Period{}, conflict("period_not_draft", "Period metadata can only be edited in draft")
	}
	days, err := queries.ListOpenDaysByPeriod(ctx, id)
	if err != nil {
		return Period{}, err
	}
	for _, day := range days {
		if !dateWithin(day.StartsAt.In(s.location), startsOn, endsOn) ||
			!dateWithin(day.EndsAt.Add(-time.Nanosecond).In(s.location), startsOn, endsOn) {
			return Period{}, validation("period bounds must contain every Open Day")
		}
	}
	row, err := queries.UpdatePeriod(ctx, opendaysdb.UpdatePeriodParams{Name: name, StartsOn: pgDate(startsOn), EndsOn: pgDate(endsOn), ID: id, ExpectedVersion: expected})
	if errors.Is(err, pgx.ErrNoRows) {
		return Period{}, apperror.StaleWrite
	}
	if err != nil {
		return Period{}, databaseError(err)
	}
	if err := writeAudit(ctx, tx, principal, "open_day_period.updated", "open_day_period", id, requestID, []string{"name", "startsOn", "endsOn"}); err != nil {
		return Period{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Period{}, err
	}
	return periodBase(row), nil
}

func (s *Service) TransitionPeriod(ctx context.Context, principal authorization.Principal, id uuid.UUID, expected int64, target string, requestID *uuid.UUID) (Period, error) {
	if !principal.Has(authorization.OpenDaysManage) {
		return Period{}, apperror.PermissionDenied
	}
	allowed := map[string]map[string]bool{
		"draft":     {"staffing": true},
		"staffing":  {"draft": true, "published": true},
		"published": {"staffing": true, "archived": true},
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
	if !allowed[current.Status][target] {
		return Period{}, conflict("invalid_period_transition", "Open Day period transition is not allowed")
	}
	row, err := q.TransitionPeriod(ctx, opendaysdb.TransitionPeriodParams{Status: target, ID: id, ExpectedVersion: expected})
	if errors.Is(err, pgx.ErrNoRows) {
		return Period{}, apperror.StaleWrite
	}
	if err != nil {
		return Period{}, err
	}
	if err := writeAudit(ctx, tx, principal, "open_day_period."+target, "open_day_period", id, requestID, []string{"status"}); err != nil {
		return Period{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Period{}, err
	}
	return periodBase(row), nil
}

func (s *Service) GetSchedule(ctx context.Context, principal authorization.Principal, periodID uuid.UUID) (Schedule, error) {
	period, err := s.GetPeriod(ctx, principal, periodID)
	if err != nil {
		return Schedule{}, err
	}
	q := opendaysdb.New(s.pool)
	rows, err := q.ListOpenDaysByPeriod(ctx, periodID)
	if err != nil {
		return Schedule{}, err
	}
	items := make([]OpenDay, 0, len(rows))
	for _, row := range rows {
		day, err := s.dayFromRow(ctx, q, principal, row)
		if err != nil {
			return Schedule{}, err
		}
		items = append(items, day)
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
	if p.Status == "draft" && !principal.Has(authorization.OpenDaysManage) {
		return OpenDay{}, apperror.NotFound
	}
	return s.dayFromRow(ctx, q, principal, row)
}

func (s *Service) CreateOpenDay(ctx context.Context, principal authorization.Principal, periodID uuid.UUID, expected int64, input ScheduleInput, requestID *uuid.UUID) (Schedule, error) {
	delta := ScheduleDelta{ExpectedPeriodVersion: expected, Creates: []ScheduleInput{input}}
	return s.SaveSchedule(ctx, principal, periodID, delta, requestID)
}

func (s *Service) UpdateOpenDay(ctx context.Context, principal authorization.Principal, id uuid.UUID, expectedPeriod int64, input ScheduleInput, requestID *uuid.UUID) (Schedule, error) {
	q := opendaysdb.New(s.pool)
	row, err := q.GetOpenDay(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Schedule{}, apperror.NotFound
	}
	if err != nil {
		return Schedule{}, err
	}
	input.ID = id
	return s.SaveSchedule(ctx, principal, row.PeriodID, ScheduleDelta{ExpectedPeriodVersion: expectedPeriod, Updates: []ScheduleInput{input}}, requestID)
}

func (s *Service) RemoveOpenDay(ctx context.Context, principal authorization.Principal, id uuid.UUID, expectedPeriod, expectedDay int64, requestID *uuid.UUID) (Schedule, error) {
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
	return s.SaveSchedule(ctx, principal, row.PeriodID, ScheduleDelta{ExpectedPeriodVersion: expectedPeriod, Removals: []RemovalInput{{ID: id, ExpectedVersion: expectedDay}}}, requestID)
}

func (s *Service) CancelOpenDay(ctx context.Context, principal authorization.Principal, id uuid.UUID, expectedPeriod, expectedDay int64, requestID *uuid.UUID) (Schedule, error) {
	return s.RemoveOpenDay(ctx, principal, id, expectedPeriod, expectedDay, requestID)
}

func (s *Service) SaveSchedule(ctx context.Context, principal authorization.Principal, periodID uuid.UUID, delta ScheduleDelta, requestID *uuid.UUID) (Schedule, error) {
	if !principal.Has(authorization.OpenDaysManage) {
		return Schedule{}, apperror.PermissionDenied
	}
	if delta.ExpectedPeriodVersion < 1 {
		return Schedule{}, validation("expectedPeriodVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Schedule{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := opendaysdb.New(tx)
	period, err := q.GetPeriodForUpdate(ctx, periodID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Schedule{}, apperror.NotFound
	}
	if err != nil {
		return Schedule{}, err
	}
	if period.Version != delta.ExpectedPeriodVersion {
		return Schedule{}, apperror.StaleWrite
	}
	if period.Status == "archived" {
		return Schedule{}, conflict("period_archived", "Archived Open Day periods are read-only")
	}
	existing, err := q.ListOpenDaysByPeriod(ctx, periodID)
	if err != nil {
		return Schedule{}, err
	}
	byID := make(map[uuid.UUID]opendaysdb.OpenDay, len(existing))
	for _, day := range existing {
		byID[day.ID] = day
	}
	targets := map[uuid.UUID]bool{}
	removing := map[uuid.UUID]bool{}
	for _, rm := range delta.Removals {
		if rm.ID == uuid.Nil || targets[rm.ID] {
			return Schedule{}, validation("schedule operations must target each Open Day at most once")
		}
		targets[rm.ID] = true
		day, ok := byID[rm.ID]
		if !ok {
			return Schedule{}, apperror.NotFound
		}
		if day.Version != rm.ExpectedVersion {
			return Schedule{}, apperror.StaleWrite
		}
		removing[rm.ID] = true
	}
	updates := map[uuid.UUID]ScheduleInput{}
	for _, input := range delta.Updates {
		if input.ID == uuid.Nil || targets[input.ID] {
			return Schedule{}, validation("schedule operations must target each Open Day at most once")
		}
		targets[input.ID] = true
		day, ok := byID[input.ID]
		if !ok {
			return Schedule{}, apperror.NotFound
		}
		if day.Version != input.ExpectedVersion {
			return Schedule{}, apperror.StaleWrite
		}
		if day.Status != "scheduled" {
			return Schedule{}, conflict("open_day_cancelled", "Cancelled Open Days cannot be edited")
		}
		updates[input.ID] = input
	}
	seen := map[string]uuid.UUID{}
	for _, day := range existing {
		if day.Status != "scheduled" || removing[day.ID] {
			continue
		}
		start, end := day.StartsAt, day.EndsAt
		if update, ok := updates[day.ID]; ok {
			start, end = update.StartsAt, update.EndsAt
		}
		if err := s.validateSlot(period, start, end); err != nil {
			return Schedule{}, err
		}
		key := slotKey(start, end)
		if other, ok := seen[key]; ok && other != day.ID {
			return Schedule{}, conflict("duplicate_open_day", "An Open Day already uses this exact time range")
		}
		seen[key] = day.ID
	}
	for _, input := range delta.Creates {
		if err := s.validateInput(period, input); err != nil {
			return Schedule{}, err
		}
		key := slotKey(input.StartsAt, input.EndsAt)
		if _, ok := seen[key]; ok {
			return Schedule{}, conflict("duplicate_open_day", "An Open Day already uses this exact time range")
		}
		seen[key] = uuid.Nil
	}
	for _, input := range delta.Updates {
		if err := s.validateInput(period, input); err != nil {
			return Schedule{}, err
		}
	}
	for _, rm := range delta.Removals {
		day := byID[rm.ID]
		if period.Status == "draft" {
			if _, err := q.DeleteOpenDay(ctx, opendaysdb.DeleteOpenDayParams{ID: rm.ID, ExpectedVersion: rm.ExpectedVersion}); err != nil {
				return Schedule{}, databaseError(err)
			}
		} else {
			if _, err := q.CancelOpenDay(ctx, opendaysdb.CancelOpenDayParams{ID: rm.ID, ExpectedVersion: rm.ExpectedVersion}); err != nil {
				return Schedule{}, databaseError(err)
			}
		}
		action := "open_day.cancelled"
		if period.Status == "draft" {
			action = "open_day.deleted"
		}
		if err := writeAudit(ctx, tx, principal, action, "open_day", day.ID, requestID, nil); err != nil {
			return Schedule{}, err
		}
	}
	for _, input := range delta.Updates {
		row, err := q.UpdateOpenDay(ctx, opendaysdb.UpdateOpenDayParams{StartsAt: input.StartsAt.UTC(), EndsAt: input.EndsAt.UTC(), InternalNote: cleanNote(input.InternalNote), ID: input.ID, ExpectedVersion: input.ExpectedVersion})
		if err != nil {
			return Schedule{}, databaseError(err)
		}
		if err := replaceRequirements(ctx, q, row.ID, input.Requirements); err != nil {
			return Schedule{}, err
		}
		if err := writeAudit(ctx, tx, principal, "open_day.updated", "open_day", row.ID, requestID, []string{"startsAt", "endsAt", "internalNote", "requirements"}); err != nil {
			return Schedule{}, err
		}
	}
	for _, input := range delta.Creates {
		id := uuid.Must(uuid.NewV7())
		row, err := q.CreateOpenDay(ctx, opendaysdb.CreateOpenDayParams{ID: id, PeriodID: periodID, StartsAt: input.StartsAt.UTC(), EndsAt: input.EndsAt.UTC(), InternalNote: cleanNote(input.InternalNote)})
		if err != nil {
			return Schedule{}, databaseError(err)
		}
		if err := createRequirements(ctx, q, row.ID, input.Requirements); err != nil {
			return Schedule{}, err
		}
		if err := writeAudit(ctx, tx, principal, "open_day.created", "open_day", row.ID, requestID, []string{"startsAt", "endsAt", "internalNote", "requirements"}); err != nil {
			return Schedule{}, err
		}
	}
	if len(delta.Creates)+len(delta.Updates)+len(delta.Removals) > 0 {
		if _, err := q.BumpPeriodVersion(ctx, opendaysdb.BumpPeriodVersionParams{ID: periodID, ExpectedVersion: period.Version}); errors.Is(err, pgx.ErrNoRows) {
			return Schedule{}, apperror.StaleWrite
		} else if err != nil {
			return Schedule{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Schedule{}, databaseError(err)
	}
	return s.GetSchedule(ctx, principal, periodID)
}

func (s *Service) periodFromRow(ctx context.Context, q *opendaysdb.Queries, principal authorization.Principal, row opendaysdb.OpenDayPeriod) (Period, error) {
	result := periodBase(row)
	days, err := q.ListOpenDaysByPeriod(ctx, row.ID)
	if err != nil {
		return Period{}, err
	}
	for _, day := range days {
		if day.Status == "cancelled" {
			result.CancelledCount++
			continue
		}
		result.TotalOpenDays++
		reqs, err := q.ListRequirements(ctx, day.ID)
		if err != nil {
			return Period{}, err
		}
		full := true
		for _, req := range reqs {
			count, err := q.CountRequirementAssignments(ctx, req.ID)
			if err != nil {
				return Period{}, err
			}
			if req.Kind == "supervisor" && count < int64(req.RequiredCount) {
				result.OpenSupervisorPositions += int(int64(req.RequiredCount) - count)
			}
			if count < int64(req.RequiredCount) {
				full = false
			}
		}
		if full {
			result.FullyStaffedCount++
		} else {
			result.NeedsStaffCount++
		}
		if _, err := q.GetPersonOpenDayAssignment(ctx, opendaysdb.GetPersonOpenDayAssignmentParams{OpenDayID: day.ID, PersonID: principal.PersonID}); err == nil {
			result.MyAssignmentCount++
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return Period{}, err
		}
	}
	return result, nil
}

func (s *Service) dayFromRow(ctx context.Context, q *opendaysdb.Queries, principal authorization.Principal, row opendaysdb.OpenDay) (OpenDay, error) {
	result := OpenDay{ID: row.ID, PeriodID: row.PeriodID, StartsAt: row.StartsAt, EndsAt: row.EndsAt, Status: row.Status, Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt, Requirements: []Requirement{}}
	if principal.Has(authorization.OpenDaysManage) {
		result.InternalNote = row.InternalNote
		result.InternalNoteVisible = true
	}
	reqs, err := q.ListRequirements(ctx, row.ID)
	if err != nil {
		return OpenDay{}, err
	}
	assignments, err := q.ListAssignments(ctx, row.ID)
	if err != nil {
		return OpenDay{}, err
	}
	byReq := map[uuid.UUID][]Assignment{}
	for _, a := range assignments {
		item := Assignment{ID: a.ID, OpenDayID: a.OpenDayID, RequirementID: a.RequirementID, PersonID: a.PersonID, DisplayName: strings.TrimSpace(a.FirstName + " " + a.LastName), IsCurrentUser: a.PersonID == principal.PersonID, CreatedAt: a.CreatedAt}
		byReq[a.RequirementID] = append(byReq[a.RequirementID], item)
		if item.IsCurrentUser {
			copy := item
			result.MyAssignment = &copy
		}
	}
	for _, req := range reqs {
		var roles []uuid.UUID
		rolesVisible := false
		if principal.Has(authorization.OpenDaysManage) {
			roles = []uuid.UUID{}
			rolesVisible = true
			roles, err = q.ListRequirementRoleIDs(ctx, req.ID)
			if err != nil {
				return OpenDay{}, err
			}
		}
		item := Requirement{ID: req.ID, Kind: req.Kind, RequiredCount: int(req.RequiredCount), AssignedCount: len(byReq[req.ID]), EligibleRoleIDs: roles, EligibleRolesVisible: rolesVisible}
		if principal.Has(authorization.OpenDaysReadAssignments) {
			values := byReq[req.ID]
			item.Assignments = &values
		}
		result.Requirements = append(result.Requirements, item)
	}
	sort.Slice(result.Requirements, func(i, j int) bool { return result.Requirements[i].Kind < result.Requirements[j].Kind })
	return result, nil
}

func createRequirements(ctx context.Context, q *opendaysdb.Queries, openDayID uuid.UUID, inputs []RequirementInput) error {
	for _, input := range inputs {
		id := uuid.Must(uuid.NewV7())
		if _, err := q.CreateRequirement(ctx, opendaysdb.CreateRequirementParams{ID: id, OpenDayID: openDayID, Kind: input.Kind, RequiredCount: int32(input.RequiredCount)}); err != nil {
			return databaseError(err)
		}
		for _, roleID := range uniqueIDs(input.EligibleRoleIDs) {
			if err := q.AddRequirementRole(ctx, opendaysdb.AddRequirementRoleParams{RequirementID: id, RoleID: roleID}); err != nil {
				return databaseError(err)
			}
		}
	}
	return nil
}

func replaceRequirements(ctx context.Context, q *opendaysdb.Queries, openDayID uuid.UUID, inputs []RequirementInput) error {
	rows, err := q.ListRequirements(ctx, openDayID)
	if err != nil {
		return err
	}
	byKind := map[string]opendaysdb.OpenDayStaffRequirement{}
	for _, r := range rows {
		byKind[r.Kind] = r
	}
	for _, input := range inputs {
		r, ok := byKind[input.Kind]
		if !ok {
			return validation("both supervisor and trainee requirements are required")
		}
		count, err := q.CountRequirementAssignments(ctx, r.ID)
		if err != nil {
			return err
		}
		if int64(input.RequiredCount) < count {
			return conflict("requirement_below_assignments", "Required staff count cannot be below current assignments")
		}
		if _, err := q.UpdateRequirement(ctx, opendaysdb.UpdateRequirementParams{RequiredCount: int32(input.RequiredCount), ID: r.ID}); err != nil {
			return err
		}
		if err := q.DeleteRequirementRoles(ctx, r.ID); err != nil {
			return err
		}
		for _, roleID := range uniqueIDs(input.EligibleRoleIDs) {
			if err := q.AddRequirementRole(ctx, opendaysdb.AddRequirementRoleParams{RequirementID: r.ID, RoleID: roleID}); err != nil {
				return databaseError(err)
			}
		}
	}
	return nil
}

func (s *Service) validateInput(period opendaysdb.OpenDayPeriod, input ScheduleInput) error {
	if err := s.validateSlot(period, input.StartsAt, input.EndsAt); err != nil {
		return err
	}
	if len(input.Requirements) != 2 {
		return validation("exactly supervisor and trainee requirements are required")
	}
	seen := map[string]bool{}
	for _, r := range input.Requirements {
		if r.Kind != "supervisor" && r.Kind != "trainee" {
			return validation("requirement kind is invalid")
		}
		if seen[r.Kind] {
			return validation("requirement kinds must be unique")
		}
		seen[r.Kind] = true
		if r.RequiredCount < 0 || r.RequiredCount > 100 {
			return validation("requiredCount must be between 0 and 100")
		}
		if r.RequiredCount > 0 && len(uniqueIDs(r.EligibleRoleIDs)) == 0 {
			return validation("positive requirements need at least one eligible role")
		}
	}
	return nil
}

func (s *Service) validateSlot(period opendaysdb.OpenDayPeriod, start, end time.Time) error {
	if start.IsZero() || end.IsZero() || !end.After(start) {
		return validation("endsAt must be after startsAt")
	}
	if !dateWithin(start.In(s.location), period.StartsOn.Time, period.EndsOn.Time) || !dateWithin(end.Add(-time.Nanosecond).In(s.location), period.StartsOn.Time, period.EndsOn.Time) {
		return validation("Open Day must be within the period in the makerspace timezone")
	}
	return nil
}

func validatePeriod(name string, start, end time.Time) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || len([]rune(name)) > 150 {
		return "", validation("period name is invalid")
	}
	if start.IsZero() || end.IsZero() || end.Before(start) {
		return "", validation("period date range is invalid")
	}
	return name, nil
}
func periodBase(r opendaysdb.OpenDayPeriod) Period {
	return Period{ID: r.ID, Name: r.Name, StartsOn: r.StartsOn.Time, EndsOn: r.EndsOn.Time, Status: r.Status, Version: r.Version, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt}
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
func slotKey(start, end time.Time) string {
	return start.UTC().Format(time.RFC3339Nano) + "/" + end.UTC().Format(time.RFC3339Nano)
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
func validation(message string) error     { return apperror.New(422, "validation_failed", message) }
func conflict(code, message string) error { return apperror.New(409, code, message) }
func databaseError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && (pgErr.Code == "23505" || pgErr.Code == "23503" || pgErr.Code == "23514") {
		return apperror.Conflict
	}
	return err
}
func writeAudit(ctx context.Context, tx pgx.Tx, p authorization.Principal, action, resource string, id uuid.UUID, requestID *uuid.UUID, fields []string) error {
	actor := p.AccountID
	return audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: action, ResourceType: resource, ResourceID: &id, RequestID: requestID, ChangedFields: fields})
}
