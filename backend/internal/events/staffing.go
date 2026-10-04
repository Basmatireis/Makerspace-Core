package events

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	eventsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/events/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func (s *Service) ListRequirements(ctx context.Context, principal authorization.Principal, eventID uuid.UUID) ([]Requirement, error) {
	if !canRead(principal) {
		return nil, apperror.PermissionDenied
	}
	q := eventsdb.New(s.pool)
	rows, err := q.ListEventRequirements(ctx, eventID)
	if err != nil {
		return nil, err
	}
	showRoles := principal.Has(authorization.EventsStaffingManage) || principal.Has(authorization.EventsAssign)
	result := make([]Requirement, 0, len(rows))
	for _, row := range rows {
		item := Requirement{ID: row.ID, EventID: row.EventID, ShiftID: row.ShiftID, Name: row.Name, Description: row.Description, RequiredCount: int(row.RequiredCount), FilledCount: int(row.FilledCount), EligibilityMode: row.EligibilityMode, Version: int64(row.Version), CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
		if showRoles {
			item.EligibleRoleIDs, err = q.ListEventRequirementRoleIDs(ctx, row.ID)
			if err != nil {
				return nil, err
			}
		}
		result = append(result, item)
	}
	return result, nil
}

func (s *Service) CreateRequirement(ctx context.Context, principal authorization.Principal, eventID, shiftID uuid.UUID, input RequirementInput, requestID *uuid.UUID) (Requirement, error) {
	if !principal.Has(authorization.EventsStaffingManage) {
		return Requirement{}, apperror.PermissionDenied
	}
	input, err := validateRequirementInput(input)
	if err != nil {
		return Requirement{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Requirement{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := eventsdb.New(tx)
	if err = requireEventWritable(ctx, q, eventID, false); err != nil {
		return Requirement{}, err
	}
	if _, err = q.GetEventShift(ctx, eventsdb.GetEventShiftParams{ID: shiftID, EventID: eventID}); errors.Is(err, pgx.ErrNoRows) {
		return Requirement{}, apperror.NotFound
	} else if err != nil {
		return Requirement{}, err
	}
	id := uuid.Must(uuid.NewV7())
	row, err := q.CreateEventRequirement(ctx, eventsdb.CreateEventRequirementParams{ID: id, EventID: eventID, ShiftID: shiftID, Name: input.Name, Description: input.Description, RequiredCount: int32(input.RequiredCount), EligibilityMode: input.EligibilityMode})
	if err != nil {
		return Requirement{}, databaseError(err)
	}
	if err = replaceRequirementRoles(ctx, q, id, input.EligibilityMode, input.EligibleRoleIDs); err != nil {
		return Requirement{}, err
	}
	actor := principal.AccountID
	if err = eventAudit(ctx, tx, &actor, "event_requirement.created", "event_requirement", id, requestID, []string{"name", "description", "requiredCount", "eligibilityMode", "eligibleRoleIds"}, map[string]any{"eventId": eventID.String(), "shiftId": shiftID.String()}); err != nil {
		return Requirement{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Requirement{}, err
	}
	return requirementFromRow(row, input.EligibleRoleIDs, 0), nil
}

func (s *Service) UpdateRequirement(ctx context.Context, principal authorization.Principal, eventID, shiftID, id uuid.UUID, input RequirementInput, requestID *uuid.UUID) (Requirement, error) {
	if !principal.Has(authorization.EventsStaffingManage) {
		return Requirement{}, apperror.PermissionDenied
	}
	if err := validateVersion(input.ExpectedVersion); err != nil {
		return Requirement{}, err
	}
	input, err := validateRequirementInput(input)
	if err != nil {
		return Requirement{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Requirement{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := eventsdb.New(tx)
	if err = requireEventWritable(ctx, q, eventID, false); err != nil {
		return Requirement{}, err
	}
	current, err := q.GetEventRequirementForUpdate(ctx, eventsdb.GetEventRequirementForUpdateParams{ID: id, ShiftID: shiftID, EventID: eventID})
	if errors.Is(err, pgx.ErrNoRows) {
		return Requirement{}, apperror.NotFound
	}
	if err != nil {
		return Requirement{}, err
	}
	if int64(current.Version) != input.ExpectedVersion {
		return Requirement{}, apperror.StaleWrite
	}
	count, err := q.CountActiveEventRequirementAssignments(ctx, id)
	if err != nil {
		return Requirement{}, err
	}
	if int64(input.RequiredCount) < count {
		return Requirement{}, validation("requiredCount cannot be below active assignments")
	}
	row, err := q.UpdateEventRequirement(ctx, eventsdb.UpdateEventRequirementParams{Name: input.Name, Description: input.Description, RequiredCount: int32(input.RequiredCount), EligibilityMode: input.EligibilityMode, ID: id, ShiftID: shiftID, EventID: eventID, ExpectedVersion: int32(input.ExpectedVersion)})
	if err != nil {
		return Requirement{}, databaseError(err)
	}
	if err = replaceRequirementRoles(ctx, q, id, input.EligibilityMode, input.EligibleRoleIDs); err != nil {
		return Requirement{}, err
	}
	actor := principal.AccountID
	if err = eventAudit(ctx, tx, &actor, "event_requirement.updated", "event_requirement", id, requestID, []string{"name", "description", "requiredCount", "eligibilityMode", "eligibleRoleIds"}, map[string]any{"eventId": eventID.String(), "shiftId": shiftID.String()}); err != nil {
		return Requirement{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Requirement{}, err
	}
	return requirementFromRow(row, input.EligibleRoleIDs, int(count)), nil
}

func (s *Service) DeleteRequirement(ctx context.Context, principal authorization.Principal, eventID, shiftID, id uuid.UUID, expected int64, requestID *uuid.UUID) error {
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
	if err = requireEventWritable(ctx, q, eventID, false); err != nil {
		return err
	}
	current, err := q.GetEventRequirementForUpdate(ctx, eventsdb.GetEventRequirementForUpdateParams{ID: id, ShiftID: shiftID, EventID: eventID})
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	if err != nil {
		return err
	}
	if int64(current.Version) != expected {
		return apperror.StaleWrite
	}
	count, err := q.CountActiveEventRequirementAssignments(ctx, id)
	if err != nil {
		return err
	}
	if count != 0 {
		return apperror.New(409, "requirement_has_assignments", "Requirement has active assignments")
	}
	if _, err = q.DeleteEventRequirement(ctx, eventsdb.DeleteEventRequirementParams{ID: id, ShiftID: shiftID, EventID: eventID, ExpectedVersion: int32(expected)}); err != nil {
		return databaseError(err)
	}
	actor := principal.AccountID
	if err = eventAudit(ctx, tx, &actor, "event_requirement.deleted", "event_requirement", id, requestID, nil, map[string]any{"eventId": eventID.String(), "shiftId": shiftID.String()}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) ListAssignments(ctx context.Context, principal authorization.Principal, eventID uuid.UUID) ([]Assignment, error) {
	if !canViewPII(principal) {
		return nil, apperror.PermissionDenied
	}
	rows, err := eventsdb.New(s.pool).ListEventAssignments(ctx, eventID)
	if err != nil {
		return nil, err
	}
	result := make([]Assignment, 0, len(rows))
	for _, row := range rows {
		result = append(result, Assignment{ID: row.ID, EventID: row.EventID, ShiftID: row.ShiftID, RequirementID: row.RequirementID, PersonID: row.PersonID, FirstName: row.FirstNameSnapshot, LastName: row.LastNameSnapshot, Email: row.EmailSnapshot, Phone: row.PhoneSnapshot, Source: row.Source, Status: row.Status, ConflictOverriddenByAccountID: row.ConflictOverriddenByAccountID, CancelledAt: pgTime(row.CancelledAt), PersonalDataErasedAt: pgTime(row.PersonalDataErasedAt), Version: int64(row.Version), CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt})
	}
	return result, nil
}

func (s *Service) CreateStaffAssignment(ctx context.Context, principal authorization.Principal, eventID uuid.UUID, input AssignmentInput, requestID *uuid.UUID) (Assignment, error) {
	if !principal.Has(authorization.EventsAssign) {
		return Assignment{}, apperror.PermissionDenied
	}
	result, _, err := s.createAssignment(ctx, &principal, eventID, input, "staff_entry", false, false, requestID)
	return result, err
}

func (s *Service) CancelAssignment(ctx context.Context, principal authorization.Principal, eventID, id uuid.UUID, expected int64, requestID *uuid.UUID) (Assignment, error) {
	if !principal.Has(authorization.EventsAssign) {
		return Assignment{}, apperror.PermissionDenied
	}
	return s.cancelAssignment(ctx, &principal, nil, eventID, id, expected, requestID)
}

func (s *Service) LinkAssignmentPerson(ctx context.Context, principal authorization.Principal, eventID, id, personID uuid.UUID, expected int64, requestID *uuid.UUID) (Assignment, error) {
	if !principal.Has(authorization.EventsAssign) {
		return Assignment{}, apperror.PermissionDenied
	}
	if err := validateVersion(expected); err != nil {
		return Assignment{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Assignment{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := eventsdb.New(tx)
	if err = requireEventWritable(ctx, q, eventID, false); err != nil {
		return Assignment{}, err
	}
	assignment, err := q.GetEventAssignmentForUpdate(ctx, eventsdb.GetEventAssignmentForUpdateParams{ID: id, EventID: eventID})
	if errors.Is(err, pgx.ErrNoRows) {
		return Assignment{}, apperror.NotFound
	}
	if err != nil {
		return Assignment{}, err
	}
	if int64(assignment.Version) != expected {
		return Assignment{}, apperror.StaleWrite
	}
	if assignment.Status != "active" || assignment.PersonalDataErasedAt.Valid {
		return Assignment{}, apperror.Conflict
	}
	shift, req, err := lockAssignmentTarget(ctx, q, eventID, assignment.ShiftID, assignment.RequirementID)
	if err != nil {
		return Assignment{}, err
	}
	if shift.Status == "cancelled" {
		return Assignment{}, apperror.New(409, "shift_cancelled", "Cancelled shifts cannot be linked")
	}
	eligible, err := q.PersonEligibleForEventRequirement(ctx, eventsdb.PersonEligibleForEventRequirementParams{PersonID: personID, RequirementID: req.ID})
	if err != nil {
		return Assignment{}, err
	}
	if eligible == nil || !*eligible {
		return Assignment{}, apperror.New(409, "person_not_eligible", "Person is not eligible for this requirement")
	}
	if _, err = q.LockPersonForEventAssignment(ctx, personID); err != nil {
		return Assignment{}, databaseError(err)
	}
	conflicts, err := q.FindPersonEventShiftConflicts(ctx, eventsdb.FindPersonEventShiftConflictsParams{PersonID: &personID, ExcludeAssignmentID: id, EndsAt: shift.EndsAt, StartsAt: shift.StartsAt})
	if err != nil {
		return Assignment{}, err
	}
	if len(conflicts) != 0 {
		return Assignment{}, apperror.New(409, "assignment_conflict", "Person has an overlapping Event assignment")
	}
	row, err := q.LinkEventAssignmentPerson(ctx, eventsdb.LinkEventAssignmentPersonParams{PersonID: &personID, ID: id, ExpectedVersion: int32(expected)})
	if err != nil {
		return Assignment{}, databaseError(err)
	}
	actor := principal.AccountID
	if err = audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "event_assignment.person_linked", ResourceType: "event_assignment", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"personId"}, Metadata: map[string]any{"eventId": eventID.String(), "shiftId": assignment.ShiftID.String(), "personId": personID.String()}}); err != nil {
		return Assignment{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Assignment{}, err
	}
	return assignmentFromRow(row), nil
}

func (s *Service) MoveAssignment(ctx context.Context, principal authorization.Principal, eventID, id uuid.UUID, input AssignmentUpdateInput, requestID *uuid.UUID) (Assignment, error) {
	if !principal.Has(authorization.EventsAssign) {
		return Assignment{}, apperror.PermissionDenied
	}
	if input.ShiftID == nil || input.RequirementID == nil {
		return Assignment{}, validation("shiftId and requirementId are required")
	}
	return s.moveAssignment(ctx, &principal, nil, eventID, id, *input.ShiftID, *input.RequirementID, input.ExpectedVersion, input.OverrideConflict, false, requestID)
}

func (s *Service) ListEligibilityRoles(ctx context.Context, principal authorization.Principal) ([]Role, error) {
	if !principal.Has(authorization.EventsStaffingManage) {
		return nil, apperror.PermissionDenied
	}
	rows, err := eventsdb.New(s.pool).ListEventEligibilityRoles(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]Role, 0, len(rows))
	for _, row := range rows {
		result = append(result, Role{ID: row.ID, Name: row.Name})
	}
	return result, nil
}
func (s *Service) FindPeople(ctx context.Context, principal authorization.Principal, search string) ([]PersonOption, error) {
	if !principal.Has(authorization.EventsAssign) && !principal.Has(authorization.EventsManage) {
		return nil, apperror.PermissionDenied
	}
	search = strings.TrimSpace(search)
	if len([]rune(search)) > 200 {
		return nil, validation("search is too long")
	}
	rows, err := eventsdb.New(s.pool).FindEventPeople(ctx, eventsdb.FindEventPeopleParams{Search: search, PageLimit: 50})
	if err != nil {
		return nil, err
	}
	result := make([]PersonOption, 0, len(rows))
	for _, row := range rows {
		item := PersonOption{ID: row.ID, FirstName: row.FirstName, LastName: row.LastName}
		if principal.Has(authorization.EventsAssign) {
			item.Email, item.Phone = row.Email, row.Phone
		}
		result = append(result, item)
	}
	return result, nil
}
func (s *Service) FindAssignmentPersonMatches(ctx context.Context, principal authorization.Principal, eventID, id uuid.UUID) ([]PersonOption, error) {
	if !principal.Has(authorization.EventsAssign) {
		return nil, apperror.PermissionDenied
	}
	assignment, err := eventsdb.New(s.pool).GetEventAssignment(ctx, eventsdb.GetEventAssignmentParams{ID: id, EventID: eventID})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, apperror.NotFound
	}
	if err != nil {
		return nil, err
	}
	rows, err := eventsdb.New(s.pool).FindEventPeopleByExactContact(ctx, eventsdb.FindEventPeopleByExactContactParams{EmailNormalized: assignment.EmailNormalized, PhoneNormalized: assignment.PhoneNormalized})
	if err != nil {
		return nil, err
	}
	result := make([]PersonOption, 0, len(rows))
	for _, row := range rows {
		result = append(result, PersonOption{ID: row.ID, FirstName: row.FirstName, LastName: row.LastName, Email: row.Email, Phone: row.Phone})
	}
	return result, nil
}

func (s *Service) createAssignment(ctx context.Context, principal *authorization.Principal, eventID uuid.UUID, input AssignmentInput, source string, publicFlow, issueToken bool, requestID *uuid.UUID) (Assignment, *string, error) {
	firstName, lastName := input.FirstName, input.LastName
	email, phone := input.Email, input.Phone
	if input.PersonID != nil && source != "authenticated_self" {
		person, err := eventsdb.New(s.pool).GetEventPerson(ctx, *input.PersonID)
		if errors.Is(err, pgx.ErrNoRows) {
			return Assignment{}, nil, apperror.NotFound
		}
		if err != nil {
			return Assignment{}, nil, err
		}
		firstName, lastName, email, phone = person.FirstName, person.LastName, person.Email, person.Phone
	}
	firstName, err := cleanRequired(firstName, "firstName", 100)
	if err != nil {
		return Assignment{}, nil, err
	}
	lastName, err = cleanRequired(lastName, "lastName", 100)
	if err != nil {
		return Assignment{}, nil, err
	}
	emailDisplay, emailNormalized, phoneDisplay, phoneNormalized, err := normalizeContact(email, phone)
	if err != nil {
		return Assignment{}, nil, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Assignment{}, nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := eventsdb.New(tx)
	event, err := q.GetEventForUpdate(ctx, eventID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Assignment{}, nil, apperror.NotFound
	}
	if err != nil {
		return Assignment{}, nil, err
	}
	if !publicFlow && (event.Status == "archived" || event.Status == "completed" || event.Status == "cancelled") {
		return Assignment{}, nil, apperror.New(409, "event_read_only", "Event is read-only")
	}
	shift, req, err := lockAssignmentTarget(ctx, q, eventID, input.ShiftID, input.RequirementID)
	if err != nil {
		return Assignment{}, nil, err
	}
	if shift.Status == "cancelled" {
		if publicFlow {
			return Assignment{}, nil, signupUnavailable()
		}
		return Assignment{}, nil, apperror.New(409, "shift_cancelled", "Cancelled shifts cannot receive assignments")
	}
	if publicFlow && !isEffectivePublicSignup(event, shift) {
		return Assignment{}, nil, signupUnavailable()
	}
	if req.EligibilityMode == "roles" {
		if input.PersonID == nil {
			return Assignment{}, nil, signupUnavailable()
		}
		eligible, eligibilityErr := q.PersonEligibleForEventRequirement(ctx, eventsdb.PersonEligibleForEventRequirementParams{PersonID: *input.PersonID, RequirementID: req.ID})
		if eligibilityErr != nil {
			return Assignment{}, nil, eligibilityErr
		}
		if eligible == nil || !*eligible {
			if publicFlow {
				return Assignment{}, nil, signupUnavailable()
			}
			return Assignment{}, nil, apperror.New(409, "person_not_eligible", "Person is not eligible for this requirement")
		}
	}
	count, err := q.CountActiveEventRequirementAssignments(ctx, req.ID)
	if err != nil {
		return Assignment{}, nil, err
	}
	if count >= int64(req.RequiredCount) {
		if publicFlow {
			return Assignment{}, nil, signupUnavailable()
		}
		return Assignment{}, nil, apperror.New(409, "requirement_full", "Requirement is full")
	}
	conflict := false
	if input.PersonID != nil {
		if _, err = q.LockPersonForEventAssignment(ctx, *input.PersonID); err != nil {
			return Assignment{}, nil, databaseError(err)
		}
		rows, err := q.FindPersonEventShiftConflicts(ctx, eventsdb.FindPersonEventShiftConflictsParams{PersonID: input.PersonID, ExcludeAssignmentID: uuid.Nil, EndsAt: shift.EndsAt, StartsAt: shift.StartsAt})
		if err != nil {
			return Assignment{}, nil, err
		}
		conflict = len(rows) != 0
	} else {
		for _, key := range lockKeys(emailNormalized, phoneNormalized) {
			if err = q.AdvisoryLockEventContact(ctx, key); err != nil {
				return Assignment{}, nil, err
			}
		}
		rows, err := q.FindContactEventShiftConflicts(ctx, eventsdb.FindContactEventShiftConflictsParams{ExcludeAssignmentID: uuid.Nil, EmailNormalized: emailNormalized, PhoneNormalized: phoneNormalized, EndsAt: shift.EndsAt, StartsAt: shift.StartsAt})
		if err != nil {
			return Assignment{}, nil, err
		}
		conflict = len(rows) != 0
	}
	var overrideActor *uuid.UUID
	if conflict {
		if publicFlow || !input.OverrideConflict {
			if publicFlow {
				return Assignment{}, nil, signupUnavailable()
			}
			return Assignment{}, nil, apperror.New(409, "assignment_conflict", "Helper has an overlapping Event assignment")
		}
		if principal == nil || !principal.Has(authorization.EventsAssign) {
			return Assignment{}, nil, apperror.PermissionDenied
		}
		overrideActor = &principal.AccountID
	}
	var rawToken string
	var digest []byte
	if issueToken {
		rawToken, digest, err = security.NewOpaqueToken()
		if err != nil {
			return Assignment{}, nil, err
		}
	}
	var creator *uuid.UUID
	if principal != nil {
		creator = &principal.AccountID
	}
	id := uuid.Must(uuid.NewV7())
	row, err := q.CreateEventAssignment(ctx, eventsdb.CreateEventAssignmentParams{ID: id, EventID: eventID, ShiftID: input.ShiftID, RequirementID: input.RequirementID, PersonID: input.PersonID, FirstNameSnapshot: &firstName, LastNameSnapshot: &lastName, EmailSnapshot: emailDisplay, EmailNormalized: emailNormalized, PhoneSnapshot: phoneDisplay, PhoneNormalized: phoneNormalized, Source: source, CreatedByAccountID: creator, ManagementTokenDigest: digest, ConflictOverriddenByAccountID: overrideActor})
	if err != nil {
		var pgErr *pgconn.PgError
		if publicFlow && errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return Assignment{}, nil, signupUnavailable()
		}
		return Assignment{}, nil, databaseError(err)
	}
	actorType := "unknown"
	if principal != nil {
		actorType = "user"
	}
	if err = audit.Write(ctx, tx, audit.Event{ActorType: actorType, ActorAccountID: creator, Action: "event_assignment.created", ResourceType: "event_assignment", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"shiftId", "requirementId", "personId", "source"}, Metadata: map[string]any{"eventId": eventID.String(), "shiftId": input.ShiftID.String()}}); err != nil {
		return Assignment{}, nil, err
	}
	if overrideActor != nil {
		if err = audit.Write(ctx, tx, audit.Event{ActorAccountID: overrideActor, Action: "event_assignment.conflict_overridden", ResourceType: "event_assignment", ResourceID: &id, RequestID: requestID, Metadata: map[string]any{"eventId": eventID.String(), "shiftId": input.ShiftID.String()}}); err != nil {
			return Assignment{}, nil, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return Assignment{}, nil, err
	}
	var managementURL *string
	if issueToken {
		value := strings.TrimRight(s.cfg.PublicBaseURL.String(), "/") + "/events/signup/manage#token=" + rawToken
		managementURL = &value
	}
	return assignmentFromRow(row), managementURL, nil
}

func lockAssignmentTarget(ctx context.Context, q *eventsdb.Queries, eventID, shiftID, requirementID uuid.UUID) (eventsdb.GetEventShiftRow, eventsdb.EventShiftRequirement, error) {
	shift, err := q.GetEventShift(ctx, eventsdb.GetEventShiftParams{ID: shiftID, EventID: eventID})
	if errors.Is(err, pgx.ErrNoRows) {
		return shift, eventsdb.EventShiftRequirement{}, apperror.NotFound
	}
	if err != nil {
		return shift, eventsdb.EventShiftRequirement{}, err
	}
	req, err := q.GetEventRequirementForUpdate(ctx, eventsdb.GetEventRequirementForUpdateParams{ID: requirementID, ShiftID: shiftID, EventID: eventID})
	if errors.Is(err, pgx.ErrNoRows) {
		return shift, eventsdb.EventShiftRequirement{}, apperror.NotFound
	}
	return shift, req, err
}
func isEffectivePublicSignup(event eventsdb.Event, shift eventsdb.GetEventShiftRow) bool {
	now := time.Now().UTC()
	if !event.IsPublic || !event.PublicSignupEnabled || (event.Status != "planning" && event.Status != "confirmed") || !shift.IsPublic || shift.Status != "open" {
		return false
	}
	if shift.SessionStatus != nil && *shift.SessionStatus == "cancelled" {
		return false
	}
	if shift.SignupOpensAt.Valid && now.Before(shift.SignupOpensAt.Time) {
		return false
	}
	if shift.SignupClosesAt.Valid && !now.Before(shift.SignupClosesAt.Time) {
		return false
	}
	return true
}
func validateRequirementInput(input RequirementInput) (RequirementInput, error) {
	var err error
	input.Name, err = cleanRequired(input.Name, "name", 200)
	if err != nil {
		return input, err
	}
	input.Description, err = cleanOptional(input.Description, 10000)
	if err != nil {
		return input, err
	}
	if input.RequiredCount < 1 || input.RequiredCount > 1000 {
		return input, validation("requiredCount must be between 1 and 1000")
	}
	if input.EligibilityMode == "" {
		input.EligibilityMode = "anyone"
	}
	if input.EligibilityMode != "anyone" && input.EligibilityMode != "roles" {
		return input, validation("eligibilityMode is invalid")
	}
	if input.EligibilityMode == "roles" && len(input.EligibleRoleIDs) == 0 {
		return input, validation("role eligibility requires at least one Role")
	}
	return input, nil
}
func replaceRequirementRoles(ctx context.Context, q *eventsdb.Queries, id uuid.UUID, mode string, roleIDs []uuid.UUID) error {
	if err := q.ReplaceEventRequirementRoles(ctx, id); err != nil {
		return err
	}
	if mode == "anyone" {
		return nil
	}
	seen := map[uuid.UUID]struct{}{}
	for _, roleID := range roleIDs {
		if _, ok := seen[roleID]; ok {
			continue
		}
		seen[roleID] = struct{}{}
		if err := q.AddEventRequirementRole(ctx, eventsdb.AddEventRequirementRoleParams{RequirementID: id, RoleID: roleID}); err != nil {
			return databaseError(err)
		}
	}
	return nil
}
func requirementFromRow(row eventsdb.EventShiftRequirement, roles []uuid.UUID, filled int) Requirement {
	return Requirement{ID: row.ID, EventID: row.EventID, ShiftID: row.ShiftID, Name: row.Name, Description: row.Description, RequiredCount: int(row.RequiredCount), FilledCount: filled, EligibilityMode: row.EligibilityMode, EligibleRoleIDs: roles, Version: int64(row.Version), CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
}
func assignmentFromRow(row eventsdb.EventShiftAssignment) Assignment {
	return Assignment{ID: row.ID, EventID: row.EventID, ShiftID: row.ShiftID, RequirementID: row.RequirementID, PersonID: row.PersonID, FirstName: row.FirstNameSnapshot, LastName: row.LastNameSnapshot, Email: row.EmailSnapshot, Phone: row.PhoneSnapshot, Source: row.Source, Status: row.Status, ConflictOverriddenByAccountID: row.ConflictOverriddenByAccountID, CancelledAt: pgTime(row.CancelledAt), PersonalDataErasedAt: pgTime(row.PersonalDataErasedAt), Version: int64(row.Version), CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
}
