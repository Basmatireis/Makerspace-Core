package staffing

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/roles"
	staffingdb "github.com/Basmatireis/Makerspace-Core/backend/internal/staffing/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Service reads the semester rules and owns the requirements settings.
type Service struct {
	pool     *pgxpool.Pool
	location *time.Location
}

// NewService returns the staffing service using the makerspace time zone to decide what "today" is.
func NewService(pool *pgxpool.Pool, cfg config.Config) (*Service, error) {
	timeZone := cfg.MakerspaceTimeZone
	if timeZone == "" {
		timeZone = "Europe/Vienna"
	}
	location, err := time.LoadLocation(timeZone)
	if err != nil {
		return nil, fmt.Errorf("load makerspace timezone: %w", err)
	}
	return &Service{pool: pool, location: location}, nil
}

// Requirements returns the settings to authenticated principals that may read open days.
func (s *Service) Requirements(ctx context.Context, principal authorization.Principal) (Requirements, error) {
	if !principal.Has(authorization.OpenDaysRead) {
		return Requirements{}, apperror.PermissionDenied
	}
	return s.Settings(ctx)
}

// Settings loads the settings without an authorization check, for services that already authorized the caller.
func (s *Service) Settings(ctx context.Context) (Requirements, error) {
	row, err := staffingdb.New(s.pool).GetOpenDayRequirements(ctx)
	if err != nil {
		return Requirements{}, err
	}
	return requirementsFromRow(row), nil
}

// UpdateRequirements replaces the settings with optimistic versioning and writes the audit event in the same
// transaction.
func (s *Service) UpdateRequirements(
	ctx context.Context,
	principal authorization.Principal,
	input UpdateInput,
	requestID *uuid.UUID,
) (Requirements, error) {
	if !principal.Has(authorization.OpenDaysManage) {
		return Requirements{}, apperror.PermissionDenied
	}
	if input.ExpectedVersion < 1 {
		return Requirements{}, apperror.InvalidField("expectedVersion must be positive")
	}
	if input.MinOpenDaysPerSemester < 0 || input.MinOpenDaysPerSemester > MaxOpenDaysPerSemester {
		return Requirements{}, apperror.InvalidField("minimum open days per semester must be between 0 and 20")
	}
	if input.TraineeOpenDaysForPromotion < 1 || input.TraineeOpenDaysForPromotion > MaxOpenDaysPerSemester {
		return Requirements{}, apperror.InvalidField("trainee open days for promotion must be between 1 and 20")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Requirements{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := staffingdb.New(tx)
	// The role is locked before the settings row, the same order a role update takes.
	if input.SupervisorRoleID != nil {
		level, err := queries.GetRoleStaffingLevelForShare(ctx, *input.SupervisorRoleID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return Requirements{}, err
		}
		if err != nil || level == nil || roles.StaffingLevel(*level) != roles.StaffingSupervisor {
			return Requirements{}, apperror.InvalidField(
				"supervisorRoleId must reference a role with the supervisor staffing level",
			)
		}
	}
	current, err := queries.GetOpenDayRequirementsForUpdate(ctx)
	if err != nil {
		return Requirements{}, err
	}
	if current.Version != input.ExpectedVersion {
		return Requirements{}, apperror.StaleWrite
	}
	actor := principal.AccountID
	row, err := queries.UpdateOpenDayRequirements(ctx, staffingdb.UpdateOpenDayRequirementsParams{
		MinOpenDaysPerSemester:      int32(input.MinOpenDaysPerSemester),
		TraineeOpenDaysForPromotion: int32(input.TraineeOpenDaysForPromotion),
		SupervisorRoleID:            input.SupervisorRoleID,
		UpdatedByAccountID:          &actor,
		ExpectedVersion:             input.ExpectedVersion,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return Requirements{}, apperror.StaleWrite
	}
	if err != nil {
		return Requirements{}, err
	}
	changed := make([]string, 0, 3)
	if int(current.MinOpenDaysPerSemester) != input.MinOpenDaysPerSemester {
		changed = append(changed, "minOpenDaysPerSemester")
	}
	if int(current.TraineeOpenDaysForPromotion) != input.TraineeOpenDaysForPromotion {
		changed = append(changed, "traineeOpenDaysForPromotion")
	}
	if !sameID(current.SupervisorRoleID, input.SupervisorRoleID) {
		changed = append(changed, "supervisorRoleId")
	}
	if err := audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &actor,
		Action:         "open_day_requirements.updated",
		ResourceType:   "open_day_requirements",
		RequestID:      requestID,
		ChangedFields:  changed,
	}); err != nil {
		return Requirements{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Requirements{}, err
	}
	return requirementsFromRow(row), nil
}

// CurrentSemester resolves the semester for the instant, or nil when no period can serve as one.
func (s *Service) CurrentSemester(ctx context.Context, now time.Time) (*Semester, error) {
	rows, err := staffingdb.New(s.pool).ListSemesterCandidates(ctx)
	if err != nil {
		return nil, err
	}
	candidates := make([]Semester, 0, len(rows))
	for _, row := range rows {
		candidates = append(candidates, Semester{
			ID: row.ID, Name: row.Name, StartsOn: row.StartsOn.Time.UTC(), EndsOn: row.EndsOn.Time.UTC(),
		})
	}
	return ResolveSemester(candidates, DateOf(now, s.location)), nil
}

// Counts returns the open-day counts of the semester per person; onlyPerson narrows it to one person. People
// without any assignment are absent. A nil semester yields no counts.
func (s *Service) Counts(
	ctx context.Context,
	semester *Semester,
	now time.Time,
	onlyPerson *uuid.UUID,
) (map[uuid.UUID]Counts, error) {
	result := map[uuid.UUID]Counts{}
	if semester == nil {
		return result, nil
	}
	rows, err := staffingdb.New(s.pool).ListStaffingCounts(ctx, staffingdb.ListStaffingCountsParams{
		PeriodID: &semester.ID, Now: now, OnlyPersonID: onlyPerson,
	})
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		result[row.PersonID] = Counts{
			Staffed: int(row.Staffed), Booked: int(row.Booked), StaffedAsTrainee: int(row.StaffedAsTrainee),
		}
	}
	return result, nil
}

// LastStaffed returns when each person last staffed an ended open day, in any semester.
func (s *Service) LastStaffed(
	ctx context.Context,
	now time.Time,
	onlyPerson *uuid.UUID,
) (map[uuid.UUID]time.Time, error) {
	rows, err := staffingdb.New(s.pool).ListLastStaffed(ctx, staffingdb.ListLastStaffedParams{
		Now: now, OnlyPersonID: onlyPerson,
	})
	if err != nil {
		return nil, err
	}
	result := make(map[uuid.UUID]time.Time, len(rows))
	for _, row := range rows {
		result[row.PersonID] = row.StartsAt
	}
	return result, nil
}

// PersonKind derives the person's staffing kind from their roles; nil means the person does not staff.
func (s *Service) PersonKind(ctx context.Context, personID uuid.UUID) (*roles.StaffingLevel, error) {
	values, err := staffingdb.New(s.pool).ListPersonStaffingLevels(ctx, personID)
	if err != nil {
		return nil, err
	}
	levels := make([]roles.StaffingLevel, 0, len(values))
	for _, value := range values {
		levels = append(levels, roles.StaffingLevel(value))
	}
	return KindOf(levels), nil
}

func requirementsFromRow(row staffingdb.OpenDayRequirement) Requirements {
	return Requirements{
		MinOpenDaysPerSemester:      int(row.MinOpenDaysPerSemester),
		TraineeOpenDaysForPromotion: int(row.TraineeOpenDaysForPromotion),
		SupervisorRoleID:            row.SupervisorRoleID,
		Version:                     row.Version,
		UpdatedAt:                   row.UpdatedAt,
	}
}

func sameID(a, b *uuid.UUID) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}
