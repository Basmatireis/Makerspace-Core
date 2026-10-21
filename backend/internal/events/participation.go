package events

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	eventsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/events/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/optional"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Participation is the helper view of an event: the person's own assignments and every shift that is open or
// closed for signup, with its positions, fill counts and whether the person can join. Names of co-helpers need
// canSeeHelperNames; contact details are never part of it.
func (s *Service) Participation(
	ctx context.Context,
	principal authorization.Principal,
	eventID uuid.UUID,
) (Participation, error) {
	q := eventsdb.New(s.pool)
	event, err := visibleEvent(ctx, q, principal, eventID)
	if err != nil {
		return Participation{}, err
	}
	now := time.Now().UTC()
	result := Participation{
		EventID:     event.ID,
		Status:      EventStatus(event.Status),
		CanSignup:   principal.Has(authorization.EventsSignup),
		CanSeeNames: canSeeHelperNames(principal),
		Sessions:    []Session{},
		Shifts:      []ParticipationShift{},
	}
	if result.MyAssignments, err = ownAssignments(ctx, q, event, principal.PersonID, now); err != nil {
		return Participation{}, err
	}
	sessions, err := q.ListEventSessions(ctx, eventID)
	if err != nil {
		return Participation{}, err
	}
	for _, row := range sessions {
		result.Sessions = append(result.Sessions, sessionFromRow(row))
	}
	shifts, err := q.ListEventShifts(ctx, eventID)
	if err != nil {
		return Participation{}, err
	}
	requirements, err := q.ListEventRequirements(ctx, eventID)
	if err != nil {
		return Participation{}, err
	}
	roles, err := q.ListEventRequirementRoles(
		ctx,
		eventsdb.ListEventRequirementRolesParams{EventID: eventID, PersonID: principal.PersonID},
	)
	if err != nil {
		return Participation{}, err
	}
	roleNames := map[uuid.UUID][]string{}
	eligible := map[uuid.UUID]bool{}
	for _, role := range roles {
		roleNames[role.RequirementID] = append(roleNames[role.RequirementID], role.Name)
		eligible[role.RequirementID] = eligible[role.RequirementID] || role.Held
	}
	helpers := map[uuid.UUID][]ParticipationHelper{}
	mine := map[uuid.UUID]uuid.UUID{}
	inShift := map[uuid.UUID]bool{}
	for _, own := range result.MyAssignments {
		mine[own.RequirementID] = own.AssignmentID
		inShift[own.ShiftID] = true
	}
	if result.CanSeeNames {
		assignments, err := q.ListEventAssignments(ctx, eventID)
		if err != nil {
			return Participation{}, err
		}
		for _, row := range assignments {
			if AssignmentStatus(row.Status) != AssignmentStatusActive {
				continue
			}
			helpers[row.RequirementID] = append(helpers[row.RequirementID], ParticipationHelper{
				DisplayName: helperName(row.PersonFirstName, row.PersonLastName, row.FirstNameSnapshot,
					row.LastNameSnapshot),
				IsMe: row.PersonID != nil && *row.PersonID == principal.PersonID,
			})
		}
	}
	byShift := map[uuid.UUID][]eventsdb.ListEventRequirementsRow{}
	for _, row := range requirements {
		byShift[row.ShiftID] = append(byShift[row.ShiftID], row)
	}
	for _, row := range shifts {
		status := ShiftStatus(row.Status)
		if status != ShiftStatusOpen && status != ShiftStatusClosed {
			continue
		}
		shift := ParticipationShift{Shift: shiftFromListRow(row), Positions: []ParticipationPosition{}}
		block := shiftSignupBlock(
			result.Status,
			status,
			row.SessionStatus,
			row.EndsAt,
			pgTime(row.SignupOpensAt),
			pgTime(row.SignupClosesAt),
			now,
		)
		for _, requirement := range byShift[row.ID] {
			position := ParticipationPosition{
				ID:            requirement.ID,
				Name:          requirement.Name,
				Description:   requirement.Description,
				RequiredCount: int(requirement.RequiredCount),
				FilledCount:   int(requirement.FilledCount),
				RoleNames:     roleNames[requirement.ID],
			}
			if position.RoleNames == nil {
				position.RoleNames = []string{}
			}
			if id, ok := mine[requirement.ID]; ok {
				position.MyAssignmentID = &id
			}
			if result.CanSeeNames {
				position.Helpers = helpers[requirement.ID]
				if position.Helpers == nil {
					position.Helpers = []ParticipationHelper{}
				}
			}
			switch {
			case !result.CanSignup:
				position.Reason = JoinReasonNoPermission
			case block == signupBlockClosed:
				position.Reason = JoinReasonClosed
			case block == signupBlockNotOpen:
				position.Reason = JoinReasonNotOpen
			case block == signupBlockOpensAt:
				position.Reason = JoinReasonOpensAt
				position.OpensAt = pgTime(row.SignupOpensAt)
			case inShift[row.ID]:
				position.Reason = JoinReasonAlreadyJoined
			case requirement.FilledCount >= int64(requirement.RequiredCount):
				position.Reason = JoinReasonFull
			case EligibilityMode(requirement.EligibilityMode) == EligibilityRoles && !eligible[requirement.ID]:
				position.Reason = JoinReasonRolesOnly
			}
			position.Joinable = position.Reason == ""
			shift.Positions = append(shift.Positions, position)
		}
		result.Shifts = append(result.Shifts, shift)
	}
	return result, nil
}

// helperName prefers the linked person's current name over the signup snapshot; erased rows have neither.
func helperName(personFirst, personLast, snapshotFirst, snapshotLast *string) *string {
	first, last := snapshotFirst, snapshotLast
	if personFirst != nil && personLast != nil {
		first, last = personFirst, personLast
	}
	if first == nil || last == nil {
		return nil
	}
	name := strings.TrimSpace(*first + " " + *last)
	return &name
}

// Join takes one place in a position for the principal's own person. The event row lock serializes it with every
// other assignment change of the event, so capacity holds under concurrency.
func (s *Service) Join(
	ctx context.Context,
	principal authorization.Principal,
	eventID, shiftID, requirementID uuid.UUID,
	requestID *uuid.UUID,
) (MyAssignment, error) {
	if !principal.Has(authorization.EventsSignup) {
		return MyAssignment{}, apperror.PermissionDenied
	}
	q := eventsdb.New(s.pool)
	person, err := q.GetEventPerson(ctx, principal.PersonID)
	if errors.Is(err, pgx.ErrNoRows) {
		return MyAssignment{}, apperror.NotFound
	}
	if err != nil {
		return MyAssignment{}, err
	}
	// A person record may hold a phone number in a format signups reject; the email then suffices.
	email, phone := person.Email, person.Phone
	if email != nil && phone != nil {
		if _, _, err := normalizePhone(*phone); err != nil {
			phone = nil
		}
	}
	emailDisplay, emailNormalized, phoneDisplay, phoneNormalized, err := normalizeContact(email, phone)
	if err != nil {
		return MyAssignment{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MyAssignment{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q = eventsdb.New(tx)
	event, err := q.GetEventForUpdate(ctx, eventID)
	if errors.Is(err, pgx.ErrNoRows) {
		return MyAssignment{}, apperror.NotFound
	}
	if err != nil {
		return MyAssignment{}, err
	}
	status := EventStatus(event.Status)
	if status == EventStatusDraft && !canSeeDrafts(principal) {
		return MyAssignment{}, apperror.NotFound
	}
	shift, requirement, err := lockAssignmentTarget(ctx, q, eventID, shiftID, requirementID)
	if err != nil {
		return MyAssignment{}, err
	}
	switch shiftSignupBlock(
		status,
		ShiftStatus(shift.Status),
		shift.SessionStatus,
		shift.EndsAt,
		pgTime(shift.SignupOpensAt),
		pgTime(shift.SignupClosesAt),
		time.Now().UTC(),
	) {
	case signupBlockNotOpen, signupBlockOpensAt:
		return MyAssignment{}, apperror.Conflicting("signup_not_open", "Signup for this shift is not open yet")
	case signupBlockClosed:
		return MyAssignment{}, apperror.Conflicting("signup_closed", "Signup for this shift is closed")
	}
	if _, err = q.LockPersonForEventAssignment(ctx, principal.PersonID); err != nil {
		return MyAssignment{}, databaseError(err)
	}
	duplicate, err := q.PersonHasActiveShiftAssignment(
		ctx,
		eventsdb.PersonHasActiveShiftAssignmentParams{ShiftID: shiftID, PersonID: &principal.PersonID},
	)
	if err != nil {
		return MyAssignment{}, err
	}
	if duplicate {
		return MyAssignment{}, alreadyAssigned()
	}
	eligible, err := q.PersonEligibleForEventRequirement(
		ctx,
		eventsdb.PersonEligibleForEventRequirementParams{PersonID: principal.PersonID, RequirementID: requirementID},
	)
	if err != nil {
		return MyAssignment{}, err
	}
	if eligible == nil || !*eligible {
		return MyAssignment{}, apperror.Conflicting("person_not_eligible", "You do not have a role this position needs")
	}
	count, err := q.CountActiveEventRequirementAssignments(ctx, requirementID)
	if err != nil {
		return MyAssignment{}, err
	}
	if count >= int64(requirement.RequiredCount) {
		return MyAssignment{}, apperror.Conflicting("requirement_full", "Requirement is full")
	}
	conflicts, err := q.FindPersonEventShiftConflicts(ctx, eventsdb.FindPersonEventShiftConflictsParams{
		PersonID:            &principal.PersonID,
		ExcludeAssignmentID: uuid.Nil,
		EndsAt:              shift.EndsAt,
		StartsAt:            shift.StartsAt,
	})
	if err != nil {
		return MyAssignment{}, err
	}
	if len(conflicts) != 0 {
		return MyAssignment{}, apperror.Conflicting(
			"assignment_conflict",
			"You already have an overlapping Event assignment",
		)
	}
	id := ids.New()
	firstName, lastName := person.FirstName, person.LastName
	row, err := q.CreateEventAssignment(ctx, eventsdb.CreateEventAssignmentParams{
		ID:                 id,
		EventID:            eventID,
		ShiftID:            shiftID,
		RequirementID:      requirementID,
		PersonID:           &principal.PersonID,
		FirstNameSnapshot:  &firstName,
		LastNameSnapshot:   &lastName,
		EmailSnapshot:      emailDisplay,
		EmailNormalized:    emailNormalized,
		PhoneSnapshot:      phoneDisplay,
		PhoneNormalized:    phoneNormalized,
		Source:             string(SourceAuthenticatedSelf),
		CreatedByAccountID: &principal.AccountID,
	})
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return MyAssignment{}, alreadyAssigned()
		}
		return MyAssignment{}, databaseError(err)
	}
	actor := principal.AccountID
	if err = audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &actor,
		Action:         "event_assignment.joined",
		ResourceType:   "event_assignment",
		ResourceID:     &id,
		RequestID:      requestID,
		ChangedFields:  []string{"shiftId", "requirementId", "personId", "source"},
		Metadata:       map[string]any{"eventId": eventID.String(), "shiftId": shiftID.String()},
	}); err != nil {
		return MyAssignment{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MyAssignment{}, err
	}
	return MyAssignment{
		AssignmentID:    row.ID,
		ShiftID:         row.ShiftID,
		RequirementID:   row.RequirementID,
		ShiftName:       shift.Name,
		RequirementName: requirement.Name,
		StartsAt:        shift.StartsAt,
		EndsAt:          shift.EndsAt,
		ShiftStatus:     ShiftStatus(shift.Status),
		Version:         int64(row.Version),
		LeaveBlocked:    leaveBlock(status, shift.EndsAt, time.Now().UTC()),
	}, nil
}

// Leave cancels one of the principal's own active assignments while the event is open and the shift has not ended.
// Other people's assignments are reported as missing.
func (s *Service) Leave(
	ctx context.Context,
	principal authorization.Principal,
	eventID, assignmentID uuid.UUID,
	expectedVersion int64,
	requestID *uuid.UUID,
) error {
	if !principal.Has(authorization.EventsSignup) {
		return apperror.PermissionDenied
	}
	if err := validateVersion(expectedVersion); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := eventsdb.New(tx)
	event, err := q.GetEventForUpdate(ctx, eventID)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	if err != nil {
		return err
	}
	assignment, err := q.GetEventAssignmentForUpdate(
		ctx,
		eventsdb.GetEventAssignmentForUpdateParams{ID: assignmentID, EventID: eventID},
	)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && (assignment.PersonID == nil ||
		*assignment.PersonID != principal.PersonID)) {
		return apperror.NotFound
	}
	if err != nil {
		return err
	}
	if int64(assignment.Version) != expectedVersion {
		return apperror.StaleWrite
	}
	if AssignmentStatus(assignment.Status) != AssignmentStatusActive {
		return apperror.Conflict
	}
	shift, err := q.GetEventShift(ctx, eventsdb.GetEventShiftParams{ID: assignment.ShiftID, EventID: eventID})
	if err != nil {
		return err
	}
	switch leaveBlock(EventStatus(event.Status), shift.EndsAt, time.Now().UTC()) {
	case LeaveBlockEventClosed:
		return eventReadOnly()
	case LeaveBlockShiftEnded:
		return apperror.New(http.StatusConflict, "shift_ended", "The shift has already ended")
	}
	actor := principal.AccountID
	if _, err = q.CancelEventAssignment(ctx, eventsdb.CancelEventAssignmentParams{
		CancelledByAccountID: &actor,
		ID:                   assignmentID,
		ExpectedVersion:      int32(expectedVersion),
	}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return apperror.StaleWrite
		}
		return databaseError(err)
	}
	if err = audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &actor,
		Action:         "event_assignment.left",
		ResourceType:   "event_assignment",
		ResourceID:     &assignmentID,
		RequestID:      requestID,
		ChangedFields:  []string{"status"},
		Metadata:       map[string]any{"eventId": eventID.String(), "shiftId": assignment.ShiftID.String()},
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func alreadyAssigned() error {
	return apperror.Conflicting("already_assigned", "You already have a place in this shift")
}

func shiftFromListRow(row eventsdb.ListEventShiftsRow) Shift {
	return Shift{
		ID:                  row.ID,
		EventID:             row.EventID,
		SessionID:           row.SessionID,
		Name:                row.Name,
		Description:         row.Description,
		StartsAt:            row.StartsAt,
		EndsAt:              row.EndsAt,
		SignupOpensAt:       pgTime(row.SignupOpensAt),
		SignupClosesAt:      pgTime(row.SignupClosesAt),
		IsPublic:            row.IsPublic,
		Status:              ShiftStatus(row.Status),
		LinkedSessionStatus: optional.Convert[SessionStatus](row.SessionStatus),
		Version:             int64(row.Version),
		CreatedAt:           row.CreatedAt,
		UpdatedAt:           row.UpdatedAt,
	}
}
