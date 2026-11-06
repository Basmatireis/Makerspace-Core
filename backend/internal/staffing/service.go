package staffing

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/database"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/roles"
	staffingdb "github.com/Basmatireis/Makerspace-Core/backend/internal/staffing/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Service owns the staffing rules and excusals and evaluates people against them.
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

// Rules returns the rules to principals who read the staffing overview or manage open days.
func (s *Service) Rules(ctx context.Context, principal authorization.Principal) (Rules, error) {
	if !principal.Has(authorization.SupervisorDashboardRead) && !principal.Has(authorization.OpenDaysManage) {
		return Rules{}, apperror.PermissionDenied
	}
	return s.Settings(ctx)
}

// Settings loads the rules without an authorization check, for services that already authorized the caller.
func (s *Service) Settings(ctx context.Context) (Rules, error) {
	return loadRules(ctx, staffingdb.New(s.pool))
}

func loadRules(ctx context.Context, queries *staffingdb.Queries) (Rules, error) {
	row, err := queries.GetStaffingRules(ctx)
	if err != nil {
		return Rules{}, err
	}
	exceptions, err := queries.ListStaffingRuleExceptions(ctx)
	if err != nil {
		return Rules{}, err
	}
	return rulesFromRow(row, exceptions), nil
}

// UpdateRules replaces the rules and their exceptions with optimistic versioning and writes the audit event in the
// same transaction.
func (s *Service) UpdateRules(
	ctx context.Context,
	principal authorization.Principal,
	input UpdateInput,
	requestID *uuid.UUID,
) (Rules, error) {
	if !principal.Has(authorization.OpenDaysManage) {
		return Rules{}, apperror.PermissionDenied
	}
	var result Rules
	err := database.InTx(ctx, s.pool, func(tx pgx.Tx) (err error) {
		result, err = s.UpdateRulesTx(ctx, tx, principal, input, requestID)
		return err
	})
	return result, err
}

// UpdateRulesTx is UpdateRules inside the caller's transaction; the configuration import uses it.
func (s *Service) UpdateRulesTx(
	ctx context.Context,
	tx pgx.Tx,
	principal authorization.Principal,
	input UpdateInput,
	requestID *uuid.UUID,
) (Rules, error) {
	if !principal.Has(authorization.OpenDaysManage) {
		return Rules{}, apperror.PermissionDenied
	}
	if err := validateRules(input); err != nil {
		return Rules{}, err
	}
	queries := staffingdb.New(tx)
	// Roles are locked before the rules row, the same order a role update takes.
	exceptions := slices.Clone(input.Exceptions)
	slices.SortFunc(exceptions, func(a, b ExceptionInput) int { return bytes.Compare(a.RoleID[:], b.RoleID[:]) })
	for _, exception := range exceptions {
		key, err := queries.GetRoleSystemKeyForShare(ctx, exception.RoleID)
		if errors.Is(err, pgx.ErrNoRows) {
			return Rules{}, apperror.InvalidField("an exception references a role that does not exist")
		}
		if err != nil {
			return Rules{}, err
		}
		if key != nil {
			return Rules{}, apperror.InvalidField("system roles cannot have an exception")
		}
	}
	current, err := queries.GetStaffingRulesForUpdate(ctx)
	if err != nil {
		return Rules{}, err
	}
	if current.Version != input.ExpectedVersion {
		return Rules{}, apperror.StaleWrite
	}
	currentExceptions, err := queries.ListStaffingRuleExceptions(ctx)
	if err != nil {
		return Rules{}, err
	}
	actor := principal.AccountID
	row, err := queries.UpdateStaffingRules(ctx, staffingdb.UpdateStaffingRulesParams{
		SupervisorMinimum:  int32(input.SupervisorMinimum), //nolint:gosec // validated to 0..20
		TraineeMinimum:     int32(input.TraineeMinimum),    //nolint:gosec // validated to 0..20
		TraineeReadyAfter:  int32(input.TraineeReadyAfter), //nolint:gosec // validated to 1..20
		WarningWindowDays:  int32(input.WarningWindowDays), //nolint:gosec // validated to 1..60
		CountBy:            string(input.CountBy),
		DefaultDeadline:    string(input.DefaultDeadline),
		UpdatedByAccountID: &actor,
		ExpectedVersion:    input.ExpectedVersion,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return Rules{}, apperror.StaleWrite
	}
	if err != nil {
		return Rules{}, err
	}
	if err := queries.DeleteStaffingRuleExceptions(ctx); err != nil {
		return Rules{}, err
	}
	for _, exception := range exceptions {
		if err := queries.InsertStaffingRuleException(ctx, staffingdb.InsertStaffingRuleExceptionParams{
			RoleID: exception.RoleID, Minimum: int32(exception.Minimum), //nolint:gosec // validated to 0..20
		}); err != nil {
			return Rules{}, err
		}
	}
	stored, err := queries.ListStaffingRuleExceptions(ctx)
	if err != nil {
		return Rules{}, err
	}
	if err := audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &actor,
		Action:         "staffing_rules.updated",
		ResourceType:   "staffing_rules",
		RequestID:      requestID,
		ChangedFields:  changedRuleFields(current, input, currentExceptions, stored),
	}); err != nil {
		return Rules{}, err
	}
	return rulesFromRow(row, stored), nil
}

func validateRules(input UpdateInput) error {
	switch {
	case input.ExpectedVersion < 1:
		return apperror.InvalidField("expectedVersion must be positive")
	case input.SupervisorMinimum < 0 || input.SupervisorMinimum > MaxMinimum:
		return apperror.InvalidField("supervisorMinimum must be between 0 and 20")
	case input.TraineeMinimum < 0 || input.TraineeMinimum > MaxMinimum:
		return apperror.InvalidField("traineeMinimum must be between 0 and 20")
	case input.TraineeReadyAfter < 1 || input.TraineeReadyAfter > MaxMinimum:
		return apperror.InvalidField("traineeReadyAfter must be between 1 and 20")
	case input.WarningWindowDays < 1 || input.WarningWindowDays > MaxWarningWindowDays:
		return apperror.InvalidField("warningWindowDays must be between 1 and 60")
	case !input.CountBy.Valid():
		return apperror.InvalidField("countBy is invalid")
	case !input.DefaultDeadline.Valid():
		return apperror.InvalidField("defaultDeadline is invalid")
	case len(input.Exceptions) > MaxExceptions:
		return apperror.InvalidField("too many exceptions")
	}
	seen := map[uuid.UUID]bool{}
	for _, exception := range input.Exceptions {
		if seen[exception.RoleID] {
			return apperror.InvalidField("each role can have one exception")
		}
		seen[exception.RoleID] = true
		if exception.Minimum < 0 || exception.Minimum > MaxMinimum {
			return apperror.InvalidField("exception minimums must be between 0 and 20")
		}
	}
	return nil
}

func changedRuleFields(
	current staffingdb.StaffingRule,
	input UpdateInput,
	before []staffingdb.ListStaffingRuleExceptionsRow,
	after []staffingdb.ListStaffingRuleExceptionsRow,
) []string {
	changed := make([]string, 0, 7)
	if int(current.SupervisorMinimum) != input.SupervisorMinimum {
		changed = append(changed, "supervisorMinimum")
	}
	if int(current.TraineeMinimum) != input.TraineeMinimum {
		changed = append(changed, "traineeMinimum")
	}
	if int(current.TraineeReadyAfter) != input.TraineeReadyAfter {
		changed = append(changed, "traineeReadyAfter")
	}
	if int(current.WarningWindowDays) != input.WarningWindowDays {
		changed = append(changed, "warningWindowDays")
	}
	if current.CountBy != string(input.CountBy) {
		changed = append(changed, "countBy")
	}
	if current.DefaultDeadline != string(input.DefaultDeadline) {
		changed = append(changed, "defaultDeadline")
	}
	if !slices.EqualFunc(before, after, func(a, b staffingdb.ListStaffingRuleExceptionsRow) bool {
		return a.RoleID == b.RoleID && a.Minimum == b.Minimum
	}) {
		changed = append(changed, "exceptions")
	}
	return changed
}

// CurrentSemester resolves the semester for the instant, or nil when no period can serve as one.
func (s *Service) CurrentSemester(ctx context.Context, rules Rules, now time.Time) (*Semester, error) {
	rows, err := staffingdb.New(s.pool).ListSemesterCandidates(ctx)
	if err != nil {
		return nil, err
	}
	candidates := make([]Semester, 0, len(rows))
	for _, row := range rows {
		candidates = append(candidates, semesterOf(rules, row.ID, row.Name, row.Status, row.StartsOn, row.EndsOn,
			row.SignUpDeadline))
	}
	return ResolveSemester(candidates, DateOf(now, s.location)), nil
}

// SemesterForPeriod returns the period as a semester. Draft periods are visible only when includeDrafts is set;
// otherwise they answer not found like a missing period.
func (s *Service) SemesterForPeriod(
	ctx context.Context,
	rules Rules,
	periodID uuid.UUID,
	includeDrafts bool,
) (*Semester, error) {
	row, err := staffingdb.New(s.pool).GetSemesterPeriod(ctx, periodID)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && row.Status == "draft" && !includeDrafts) {
		return nil, apperror.NotFound
	}
	if err != nil {
		return nil, err
	}
	semester := semesterOf(rules, row.ID, row.Name, row.Status, row.StartsOn, row.EndsOn, row.SignUpDeadline)
	return &semester, nil
}

func semesterOf(
	rules Rules,
	id uuid.UUID,
	name, status string,
	startsOn, endsOn, deadline pgtype.Date,
) Semester {
	var explicit *time.Time
	if deadline.Valid {
		value := deadline.Time.UTC()
		explicit = &value
	}
	end := endsOn.Time.UTC()
	return Semester{
		ID: id, Name: name, Status: status, StartsOn: startsOn.Time.UTC(), EndsOn: end,
		SignUpBy: rules.SignUpBy(end, explicit),
	}
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

// Minimums loads the exceptions and the excusals of the semester so each person's minimum can be resolved;
// onlyPerson narrows it to one person. A nil semester has no excusals.
func (s *Service) Minimums(
	ctx context.Context,
	rules Rules,
	semester *Semester,
	onlyPerson *uuid.UUID,
) (Minimums, error) {
	queries := staffingdb.New(s.pool)
	rows, err := queries.ListPersonExceptions(ctx, onlyPerson)
	if err != nil {
		return Minimums{}, err
	}
	result := Minimums{rules: rules, exceptions: map[uuid.UUID][]Exception{}, excusals: map[uuid.UUID]Excusal{}}
	for _, row := range rows {
		result.exceptions[row.PersonID] = append(result.exceptions[row.PersonID], Exception{
			RoleID: row.RoleID, RoleName: row.RoleName, Minimum: int(row.Minimum),
		})
	}
	if semester == nil {
		return result, nil
	}
	excusals, err := queries.ListExcusals(ctx, staffingdb.ListExcusalsParams{
		PeriodID: semester.ID, OnlyPersonID: onlyPerson,
	})
	if err != nil {
		return Minimums{}, err
	}
	for _, row := range excusals {
		result.excusals[row.PersonID] = Excusal{
			PeriodID: row.PeriodID, PersonID: row.PersonID, Reason: row.Reason, CreatedAt: row.CreatedAt,
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

// NextAssignment is a person's next upcoming open day.
type NextAssignment struct {
	OpenDayID        uuid.UUID
	StartsAt, EndsAt time.Time
}

// NextAssignments returns each person's next upcoming open day, in any semester.
func (s *Service) NextAssignments(
	ctx context.Context,
	now time.Time,
	onlyPerson *uuid.UUID,
) (map[uuid.UUID]NextAssignment, error) {
	rows, err := staffingdb.New(s.pool).ListNextAssignments(ctx, staffingdb.ListNextAssignmentsParams{
		Now: now, OnlyPersonID: onlyPerson,
	})
	if err != nil {
		return nil, err
	}
	result := make(map[uuid.UUID]NextAssignment, len(rows))
	for _, row := range rows {
		result[row.PersonID] = NextAssignment{OpenDayID: row.OpenDayID, StartsAt: row.StartsAt, EndsAt: row.EndsAt}
	}
	return result, nil
}

// PersonMembership returns the person's membership.
func (s *Service) PersonMembership(ctx context.Context, personID uuid.UUID) (roles.Membership, error) {
	value, err := staffingdb.New(s.pool).GetPersonMembership(ctx, personID)
	if errors.Is(err, pgx.ErrNoRows) {
		return roles.MembershipVisitor, nil
	}
	if err != nil {
		return "", err
	}
	return roles.Membership(value), nil
}

func rulesFromRow(row staffingdb.StaffingRule, exceptions []staffingdb.ListStaffingRuleExceptionsRow) Rules {
	result := Rules{
		SupervisorMinimum: int(row.SupervisorMinimum),
		TraineeMinimum:    int(row.TraineeMinimum),
		TraineeReadyAfter: int(row.TraineeReadyAfter),
		WarningWindowDays: int(row.WarningWindowDays),
		CountBy:           CountBy(row.CountBy),
		DefaultDeadline:   DefaultDeadline(row.DefaultDeadline),
		Exceptions:        make([]Exception, 0, len(exceptions)),
		Version:           row.Version,
		UpdatedAt:         row.UpdatedAt,
	}
	for _, exception := range exceptions {
		result.Exceptions = append(result.Exceptions, Exception{
			RoleID: exception.RoleID, RoleName: exception.RoleName, Minimum: int(exception.Minimum),
		})
	}
	return result
}
