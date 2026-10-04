package events

import (
	"context"
	"errors"
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

func (s *Service) GetPublic(ctx context.Context, publicID string) (PublicEvent, error) {
	q := eventsdb.New(s.pool)
	event, err := q.GetEventByPublicID(ctx, publicID)
	if errors.Is(err, pgx.ErrNoRows) || event.Status == "archived" {
		return PublicEvent{}, apperror.NotFound
	}
	if err != nil {
		return PublicEvent{}, err
	}
	if event.PublicTitle == nil {
		return PublicEvent{}, apperror.NotFound
	}
	result := PublicEvent{PublicID: event.PublicID, Title: *event.PublicTitle, Description: event.PublicDescription, Location: event.PublicLocation, Status: event.Status, TimeZone: s.cfg.MakerspaceTimeZone, PublicSignupEnabled: event.PublicSignupEnabled && event.Status != "completed" && event.Status != "cancelled"}
	sessions, err := q.ListEventSessions(ctx, event.ID)
	if err != nil {
		return PublicEvent{}, err
	}
	result.Sessions = []Session{}
	for _, row := range sessions {
		if row.IsPublic && row.Status == "scheduled" {
			item := sessionFromRow(row)
			item.Description = row.Description
			result.Sessions = append(result.Sessions, item)
		}
	}
	shifts, err := q.ListEventShifts(ctx, event.ID)
	if err != nil {
		return PublicEvent{}, err
	}
	requirements, err := q.ListEventRequirements(ctx, event.ID)
	if err != nil {
		return PublicEvent{}, err
	}
	byShift := map[uuid.UUID][]Requirement{}
	for _, row := range requirements {
		remaining := int(row.RequiredCount) - int(row.FilledCount)
		availability := "available"
		if remaining <= 0 {
			availability = "full"
		}
		item := Requirement{ID: row.ID, EventID: uuid.Nil, ShiftID: row.ShiftID, Name: row.Name, Description: row.Description, RequiredCount: int(row.RequiredCount), FilledCount: int(row.FilledCount), EligibilityMode: row.EligibilityMode, Availability: availability, Version: int64(row.Version)}
		if row.EligibilityMode == "roles" && remaining > 0 {
			item.Availability = "authenticated_only"
		}
		byShift[row.ShiftID] = append(byShift[row.ShiftID], item)
	}
	result.Shifts = []PublicShift{}
	now := time.Now().UTC()
	for _, row := range shifts {
		if !row.IsPublic || row.Status == "cancelled" {
			continue
		}
		shift := Shift{ID: row.ID, EventID: uuid.Nil, SessionID: row.SessionID, Name: row.Name, Description: row.Description, StartsAt: row.StartsAt, EndsAt: row.EndsAt, SignupOpensAt: pgTime(row.SignupOpensAt), SignupClosesAt: pgTime(row.SignupClosesAt), IsPublic: true, Status: row.Status, LinkedSessionStatus: row.SessionStatus, Version: int64(row.Version)}
		effective := row.Status == "open" && result.PublicSignupEnabled && (row.SessionStatus == nil || *row.SessionStatus != "cancelled") && (!row.SignupOpensAt.Valid || !now.Before(row.SignupOpensAt.Time)) && (!row.SignupClosesAt.Valid || now.Before(row.SignupClosesAt.Time))
		items := byShift[row.ID]
		if !effective {
			for i := range items {
				items[i].Availability = "not_open"
			}
		}
		result.Shifts = append(result.Shifts, PublicShift{Shift: shift, Requirements: items})
	}
	files, err := q.ListEventFiles(ctx, event.ID)
	if err != nil {
		return PublicEvent{}, err
	}
	result.Files = []EventFile{}
	for _, row := range files {
		if row.IsBanner {
			result.HasBanner = row.Visibility == "public"
			continue
		}
		if row.Visibility == "public" {
			result.Files = append(result.Files, EventFile{ID: row.ID, EventID: uuid.Nil, FileID: uuid.Nil, Description: row.Description, Visibility: "public", IsBanner: false, OriginalFilename: row.OriginalFilename, ContentType: row.ContentType, SizeBytes: row.SizeBytes, Version: int64(row.Version), CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt})
		}
	}
	return result, nil
}

func (s *Service) SignupAnonymous(ctx context.Context, publicID, clientIP string, input AssignmentInput, requestID *uuid.UUID) (SignupResult, error) {
	_, emailNormalized, _, phoneNormalized, err := normalizeContact(input.Email, input.Phone)
	if err != nil {
		return SignupResult{}, err
	}
	if !s.limiter.allow(clientIP, publicID, emailNormalized, phoneNormalized) {
		return SignupResult{}, apperror.New(429, "signup_rate_limited", "Too many signup attempts")
	}
	event, err := eventsdb.New(s.pool).GetEventByPublicID(ctx, publicID)
	if errors.Is(err, pgx.ErrNoRows) {
		return SignupResult{}, apperror.NotFound
	}
	if err != nil {
		return SignupResult{}, err
	}
	input.PersonID = nil
	assignment, url, err := s.createAssignment(ctx, nil, event.ID, input, "public_signup", true, true, requestID)
	if err != nil {
		return SignupResult{}, err
	}
	assignment.PublicID = publicID
	return SignupResult{Assignment: assignment, ManagementURL: url}, nil
}

func (s *Service) SignupAuthenticated(ctx context.Context, principal authorization.Principal, publicID, clientIP, signupFor string, input AssignmentInput, requestID *uuid.UUID) (SignupResult, error) {
	event, err := eventsdb.New(s.pool).GetEventByPublicID(ctx, publicID)
	if errors.Is(err, pgx.ErrNoRows) {
		return SignupResult{}, apperror.NotFound
	}
	if err != nil {
		return SignupResult{}, err
	}
	switch signupFor {
	case "self":
		_, emailNormalized, _, phoneNormalized, normalizationErr := normalizeContact(input.Email, input.Phone)
		if normalizationErr != nil {
			return SignupResult{}, normalizationErr
		}
		if !s.limiter.allow(clientIP, publicID, emailNormalized, phoneNormalized) {
			return SignupResult{}, apperror.New(429, "signup_rate_limited", "Too many signup attempts")
		}
		input.PersonID = &principal.PersonID
		assignment, _, err := s.createAssignment(ctx, &principal, event.ID, input, "authenticated_self", true, false, requestID)
		assignment.PublicID = publicID
		return SignupResult{Assignment: assignment}, err
	case "other":
		_, emailNormalized, _, phoneNormalized, normalizationErr := normalizeContact(input.Email, input.Phone)
		if normalizationErr != nil {
			return SignupResult{}, normalizationErr
		}
		if !s.limiter.allow(clientIP, publicID, emailNormalized, phoneNormalized) {
			return SignupResult{}, apperror.New(429, "signup_rate_limited", "Too many signup attempts")
		}
		input.PersonID = nil
		assignment, url, createErr := s.createAssignment(ctx, &principal, event.ID, input, "authenticated_on_behalf", true, true, requestID)
		assignment.PublicID = publicID
		return SignupResult{Assignment: assignment, ManagementURL: url}, createErr
	default:
		return SignupResult{}, validation("signupFor must be self or other")
	}
}

func (s *Service) GetManagedSignup(ctx context.Context, token string) (Assignment, error) {
	digest, err := managementDigest(token)
	if err != nil {
		return Assignment{}, apperror.NotFound
	}
	row, err := eventsdb.New(s.pool).GetEventAssignmentByTokenDigest(ctx, digest)
	if errors.Is(err, pgx.ErrNoRows) {
		return Assignment{}, apperror.NotFound
	}
	if err != nil {
		return Assignment{}, err
	}
	result := assignmentFromRow(row)
	event, err := eventsdb.New(s.pool).GetEvent(ctx, row.EventID)
	if err != nil {
		return Assignment{}, err
	}
	result.PublicID = event.PublicID
	return result, nil
}

func (s *Service) UpdateManagedSignup(ctx context.Context, token string, input AssignmentUpdateInput, requestID *uuid.UUID) (Assignment, error) {
	digest, err := managementDigest(token)
	if err != nil {
		return Assignment{}, apperror.NotFound
	}
	current, err := eventsdb.New(s.pool).GetEventAssignmentByTokenDigest(ctx, digest)
	if errors.Is(err, pgx.ErrNoRows) {
		return Assignment{}, apperror.NotFound
	}
	if err != nil {
		return Assignment{}, err
	}
	event, err := eventsdb.New(s.pool).GetEvent(ctx, current.EventID)
	if err != nil {
		return Assignment{}, err
	}
	if input.ShiftID != nil || input.RequirementID != nil {
		if input.ShiftID == nil || input.RequirementID == nil {
			return Assignment{}, validation("shiftId and requirementId must be provided together")
		}
		result, err := s.moveAssignment(ctx, nil, digest, current.EventID, current.ID, *input.ShiftID, *input.RequirementID, input.ExpectedVersion, false, true, requestID)
		result.PublicID = event.PublicID
		return result, err
	}
	result, err := s.updateAssignmentContact(ctx, nil, digest, uuid.Nil, uuid.Nil, input, requestID)
	result.PublicID = event.PublicID
	return result, err
}

func (s *Service) CancelManagedSignup(ctx context.Context, token string, expected int64, requestID *uuid.UUID) (Assignment, error) {
	digest, err := managementDigest(token)
	if err != nil {
		return Assignment{}, apperror.NotFound
	}
	row, err := eventsdb.New(s.pool).GetEventAssignmentByTokenDigest(ctx, digest)
	if errors.Is(err, pgx.ErrNoRows) {
		return Assignment{}, apperror.NotFound
	}
	if err != nil {
		return Assignment{}, err
	}
	event, err := eventsdb.New(s.pool).GetEvent(ctx, row.EventID)
	if err != nil {
		return Assignment{}, err
	}
	result, err := s.cancelAssignment(ctx, nil, digest, row.EventID, row.ID, expected, requestID)
	result.PublicID = event.PublicID
	return result, err
}

func (s *Service) ListOwnAssignments(ctx context.Context, principal authorization.Principal, publicID string) ([]Assignment, error) {
	rows, err := eventsdb.New(s.pool).ListOwnEventAssignments(ctx, eventsdb.ListOwnEventAssignmentsParams{PublicID: publicID, PersonID: &principal.PersonID})
	if err != nil {
		return nil, err
	}
	result := make([]Assignment, 0, len(rows))
	for _, row := range rows {
		item := assignmentFromRow(row)
		item.PublicID = publicID
		result = append(result, item)
	}
	return result, nil
}
func (s *Service) UpdateOwnAssignment(ctx context.Context, principal authorization.Principal, publicID string, id uuid.UUID, input AssignmentUpdateInput, requestID *uuid.UUID) (Assignment, error) {
	event, err := eventsdb.New(s.pool).GetEventByPublicID(ctx, publicID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Assignment{}, apperror.NotFound
	}
	if err != nil {
		return Assignment{}, err
	}
	if input.ShiftID != nil || input.RequirementID != nil {
		if input.ShiftID == nil || input.RequirementID == nil {
			return Assignment{}, validation("shiftId and requirementId must be provided together")
		}
		result, err := s.moveAssignment(ctx, &principal, nil, event.ID, id, *input.ShiftID, *input.RequirementID, input.ExpectedVersion, false, true, requestID)
		result.PublicID = publicID
		return result, err
	}
	result, err := s.updateAssignmentContact(ctx, &principal, nil, event.ID, id, input, requestID)
	result.PublicID = publicID
	return result, err
}
func (s *Service) CancelOwnAssignment(ctx context.Context, principal authorization.Principal, publicID string, id uuid.UUID, expected int64, requestID *uuid.UUID) (Assignment, error) {
	event, err := eventsdb.New(s.pool).GetEventByPublicID(ctx, publicID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Assignment{}, apperror.NotFound
	}
	if err != nil {
		return Assignment{}, err
	}
	result, err := s.cancelAssignment(ctx, &principal, nil, event.ID, id, expected, requestID)
	result.PublicID = publicID
	return result, err
}

func (s *Service) updateAssignmentContact(ctx context.Context, principal *authorization.Principal, digest []byte, eventID, id uuid.UUID, input AssignmentUpdateInput, requestID *uuid.UUID) (Assignment, error) {
	if err := validateVersion(input.ExpectedVersion); err != nil {
		return Assignment{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Assignment{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := eventsdb.New(tx)
	current, err := loadAuthorizedAssignment(ctx, q, principal, digest, eventID, id)
	if err != nil {
		return Assignment{}, err
	}
	if int64(current.Version) != input.ExpectedVersion {
		return Assignment{}, apperror.StaleWrite
	}
	if current.Status != "active" || current.PersonalDataErasedAt.Valid {
		return Assignment{}, apperror.Conflict
	}
	event, err := q.GetEventForUpdate(ctx, current.EventID)
	if err != nil {
		return Assignment{}, err
	}
	if event.Status == "archived" {
		return Assignment{}, apperror.New(409, "event_read_only", "Event is read-only")
	}
	firstName, lastName := "", ""
	if current.FirstNameSnapshot != nil {
		firstName = *current.FirstNameSnapshot
	}
	if current.LastNameSnapshot != nil {
		lastName = *current.LastNameSnapshot
	}
	changedFields := make([]string, 0, 4)
	if input.FirstNameSet || input.FirstName != "" {
		firstName, err = cleanRequired(input.FirstName, "firstName", 100)
		if err != nil {
			return Assignment{}, err
		}
		changedFields = append(changedFields, "firstName")
	}
	if input.LastNameSet || input.LastName != "" {
		lastName, err = cleanRequired(input.LastName, "lastName", 100)
		if err != nil {
			return Assignment{}, err
		}
		changedFields = append(changedFields, "lastName")
	}
	email, phone := current.EmailSnapshot, current.PhoneSnapshot
	if input.EmailSet || input.Email != nil {
		email = input.Email
		changedFields = append(changedFields, "email")
	}
	if input.PhoneSet || input.Phone != nil {
		phone = input.Phone
		changedFields = append(changedFields, "phone")
	}
	if len(changedFields) == 0 {
		return Assignment{}, validation("at least one contact field must be provided")
	}
	emailDisplay, emailNormalized, phoneDisplay, phoneNormalized, err := normalizeContact(email, phone)
	if err != nil {
		return Assignment{}, err
	}
	for _, key := range lockKeys(emailNormalized, phoneNormalized) {
		if err = q.AdvisoryLockEventContact(ctx, key); err != nil {
			return Assignment{}, err
		}
	}
	shift, err := q.GetEventShift(ctx, eventsdb.GetEventShiftParams{ID: current.ShiftID, EventID: current.EventID})
	if err != nil {
		return Assignment{}, err
	}
	conflicts, err := q.FindContactEventShiftConflicts(ctx, eventsdb.FindContactEventShiftConflictsParams{ExcludeAssignmentID: current.ID, EmailNormalized: emailNormalized, PhoneNormalized: phoneNormalized, EndsAt: shift.EndsAt, StartsAt: shift.StartsAt})
	if err != nil {
		return Assignment{}, err
	}
	if len(conflicts) != 0 {
		return Assignment{}, signupUnavailable()
	}
	row, err := q.UpdateEventAssignmentContact(ctx, eventsdb.UpdateEventAssignmentContactParams{FirstNameSnapshot: &firstName, LastNameSnapshot: &lastName, EmailSnapshot: emailDisplay, EmailNormalized: emailNormalized, PhoneSnapshot: phoneDisplay, PhoneNormalized: phoneNormalized, ID: current.ID, ExpectedVersion: int32(input.ExpectedVersion)})
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return Assignment{}, signupUnavailable()
		}
		return Assignment{}, databaseError(err)
	}
	actorType := "unknown"
	var actor *uuid.UUID
	if principal != nil {
		actor = &principal.AccountID
		actorType = "user"
	}
	if err = audit.Write(ctx, tx, audit.Event{ActorType: actorType, ActorAccountID: actor, Action: "event_assignment.updated", ResourceType: "event_assignment", ResourceID: &current.ID, RequestID: requestID, ChangedFields: changedFields, Metadata: map[string]any{"eventId": current.EventID.String(), "shiftId": current.ShiftID.String()}}); err != nil {
		return Assignment{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Assignment{}, err
	}
	return assignmentFromRow(row), nil
}

func (s *Service) moveAssignment(ctx context.Context, principal *authorization.Principal, digest []byte, eventID, id, destinationShiftID, destinationRequirementID uuid.UUID, expected int64, override, publicFlow bool, requestID *uuid.UUID) (Assignment, error) {
	if err := validateVersion(expected); err != nil {
		return Assignment{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Assignment{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := eventsdb.New(tx)
	current, err := loadAuthorizedAssignment(ctx, q, principal, digest, eventID, id)
	if err != nil {
		return Assignment{}, err
	}
	if int64(current.Version) != expected {
		return Assignment{}, apperror.StaleWrite
	}
	if current.Status != "active" || current.PersonalDataErasedAt.Valid {
		return Assignment{}, apperror.Conflict
	}
	event, err := q.GetEventForUpdate(ctx, current.EventID)
	if err != nil {
		return Assignment{}, err
	}
	if event.Status == "archived" || event.Status == "completed" || event.Status == "cancelled" {
		return Assignment{}, apperror.New(409, "event_read_only", "Event is read-only")
	}
	requirementIDs := []uuid.UUID{current.RequirementID}
	if destinationRequirementID != current.RequirementID {
		requirementIDs = append(requirementIDs, destinationRequirementID)
		if requirementIDs[1].String() < requirementIDs[0].String() {
			requirementIDs[0], requirementIDs[1] = requirementIDs[1], requirementIDs[0]
		}
	}
	for _, requirementID := range requirementIDs {
		if _, err = q.LockEventRequirement(ctx, requirementID); err != nil {
			return Assignment{}, err
		}
	}
	shift, err := q.GetEventShift(ctx, eventsdb.GetEventShiftParams{ID: destinationShiftID, EventID: current.EventID})
	if errors.Is(err, pgx.ErrNoRows) {
		return Assignment{}, apperror.NotFound
	}
	if err != nil {
		return Assignment{}, err
	}
	if shift.Status == "cancelled" {
		if publicFlow {
			return Assignment{}, signupUnavailable()
		}
		return Assignment{}, apperror.New(409, "shift_cancelled", "Cancelled shifts cannot receive assignments")
	}
	req, err := q.GetEventRequirement(ctx, eventsdb.GetEventRequirementParams{ID: destinationRequirementID, ShiftID: destinationShiftID, EventID: current.EventID})
	if errors.Is(err, pgx.ErrNoRows) {
		return Assignment{}, apperror.NotFound
	}
	if err != nil {
		return Assignment{}, err
	}
	if publicFlow && !isEffectivePublicSignup(event, shift) {
		return Assignment{}, signupUnavailable()
	}
	if req.EligibilityMode == "roles" {
		if current.PersonID == nil {
			return Assignment{}, signupUnavailable()
		}
		eligible, err := q.PersonEligibleForEventRequirement(ctx, eventsdb.PersonEligibleForEventRequirementParams{PersonID: *current.PersonID, RequirementID: req.ID})
		if err != nil {
			return Assignment{}, err
		}
		if eligible == nil || !*eligible {
			return Assignment{}, signupUnavailable()
		}
	}
	if destinationRequirementID != current.RequirementID {
		count, err := q.CountActiveEventRequirementAssignments(ctx, destinationRequirementID)
		if err != nil {
			return Assignment{}, err
		}
		if count >= int64(req.RequiredCount) {
			return Assignment{}, signupUnavailable()
		}
	}
	conflict := false
	if current.PersonID != nil {
		if _, err = q.LockPersonForEventAssignment(ctx, *current.PersonID); err != nil {
			return Assignment{}, err
		}
		rows, err := q.FindPersonEventShiftConflicts(ctx, eventsdb.FindPersonEventShiftConflictsParams{PersonID: current.PersonID, ExcludeAssignmentID: current.ID, EndsAt: shift.EndsAt, StartsAt: shift.StartsAt})
		if err != nil {
			return Assignment{}, err
		}
		conflict = len(rows) != 0
	} else {
		for _, key := range lockKeys(current.EmailNormalized, current.PhoneNormalized) {
			if err = q.AdvisoryLockEventContact(ctx, key); err != nil {
				return Assignment{}, err
			}
		}
		rows, err := q.FindContactEventShiftConflicts(ctx, eventsdb.FindContactEventShiftConflictsParams{ExcludeAssignmentID: current.ID, EmailNormalized: current.EmailNormalized, PhoneNormalized: current.PhoneNormalized, EndsAt: shift.EndsAt, StartsAt: shift.StartsAt})
		if err != nil {
			return Assignment{}, err
		}
		conflict = len(rows) != 0
	}
	var overrideActor *uuid.UUID
	if conflict {
		if publicFlow || !override || principal == nil || !principal.Has(authorization.EventsAssign) {
			return Assignment{}, signupUnavailable()
		}
		overrideActor = &principal.AccountID
	}
	row, err := q.MoveEventAssignment(ctx, eventsdb.MoveEventAssignmentParams{ShiftID: destinationShiftID, RequirementID: destinationRequirementID, ConflictOverriddenByAccountID: overrideActor, ID: current.ID, ExpectedVersion: int32(expected)})
	if err != nil {
		return Assignment{}, databaseError(err)
	}
	actorType := "unknown"
	var actor *uuid.UUID
	if principal != nil {
		actor = &principal.AccountID
		actorType = "user"
	}
	if err = audit.Write(ctx, tx, audit.Event{ActorType: actorType, ActorAccountID: actor, Action: "event_assignment.moved", ResourceType: "event_assignment", ResourceID: &current.ID, RequestID: requestID, ChangedFields: []string{"shiftId", "requirementId"}, Metadata: map[string]any{"eventId": current.EventID.String(), "shiftId": destinationShiftID.String()}}); err != nil {
		return Assignment{}, err
	}
	if overrideActor != nil {
		if err = audit.Write(ctx, tx, audit.Event{ActorAccountID: overrideActor, Action: "event_assignment.conflict_overridden", ResourceType: "event_assignment", ResourceID: &current.ID, RequestID: requestID, Metadata: map[string]any{"eventId": current.EventID.String(), "shiftId": destinationShiftID.String()}}); err != nil {
			return Assignment{}, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return Assignment{}, err
	}
	return assignmentFromRow(row), nil
}

func (s *Service) cancelAssignment(ctx context.Context, principal *authorization.Principal, digest []byte, eventID, id uuid.UUID, expected int64, requestID *uuid.UUID) (Assignment, error) {
	if err := validateVersion(expected); err != nil {
		return Assignment{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Assignment{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := eventsdb.New(tx)
	current, err := loadAuthorizedAssignment(ctx, q, principal, digest, eventID, id)
	if err != nil {
		return Assignment{}, err
	}
	if int64(current.Version) != expected {
		return Assignment{}, apperror.StaleWrite
	}
	if current.Status != "active" {
		return Assignment{}, apperror.Conflict
	}
	event, err := q.GetEventForUpdate(ctx, current.EventID)
	if err != nil {
		return Assignment{}, err
	}
	if event.Status == "archived" {
		return Assignment{}, apperror.New(409, "event_read_only", "Event is read-only")
	}
	var actor *uuid.UUID
	actorType := "unknown"
	if principal != nil {
		actor = &principal.AccountID
		actorType = "user"
	}
	row, err := q.CancelEventAssignment(ctx, eventsdb.CancelEventAssignmentParams{CancelledByAccountID: actor, ID: current.ID, ExpectedVersion: int32(expected)})
	if err != nil {
		return Assignment{}, databaseError(err)
	}
	if err = audit.Write(ctx, tx, audit.Event{ActorType: actorType, ActorAccountID: actor, Action: "event_assignment.cancelled", ResourceType: "event_assignment", ResourceID: &current.ID, RequestID: requestID, ChangedFields: []string{"status"}, Metadata: map[string]any{"eventId": current.EventID.String(), "shiftId": current.ShiftID.String()}}); err != nil {
		return Assignment{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Assignment{}, err
	}
	return assignmentFromRow(row), nil
}

func loadAuthorizedAssignment(ctx context.Context, q *eventsdb.Queries, principal *authorization.Principal, digest []byte, eventID, id uuid.UUID) (eventsdb.EventShiftAssignment, error) {
	var row eventsdb.EventShiftAssignment
	var err error
	if len(digest) != 0 {
		row, err = q.GetEventAssignmentByTokenDigestForUpdate(ctx, digest)
	} else {
		row, err = q.GetEventAssignmentForUpdate(ctx, eventsdb.GetEventAssignmentForUpdateParams{ID: id, EventID: eventID})
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return row, apperror.NotFound
	}
	if err != nil {
		return row, err
	}
	if principal != nil && !principal.Has(authorization.EventsAssign) && (row.PersonID == nil || *row.PersonID != principal.PersonID) {
		return row, apperror.NotFound
	}
	return row, nil
}
func managementDigest(token string) ([]byte, error) {
	if len(token) != 43 {
		return nil, errors.New("invalid token")
	}
	return security.DigestToken(token), nil
}
