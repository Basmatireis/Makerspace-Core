package events

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	eventsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/events/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// MaxShiftPositions bounds how many positions one shift save may carry.
const MaxShiftPositions = 50

// ListShifts lists the event's shifts with their positions. Eligibility roles are shown to staffing permissions only.
func (s *Service) ListShifts(
	ctx context.Context,
	principal authorization.Principal,
	eventID uuid.UUID,
) ([]Shift, error) {
	q := eventsdb.New(s.pool)
	if _, err := visibleEvent(ctx, q, principal, eventID); err != nil {
		return nil, err
	}
	return listShifts(ctx, q, eventID, canViewPII(principal))
}

func listShifts(ctx context.Context, q *eventsdb.Queries, eventID uuid.UUID, showRoles bool) ([]Shift, error) {
	rows, err := q.ListEventShifts(ctx, eventID)
	if err != nil {
		return nil, err
	}
	requirements, err := q.ListEventRequirements(ctx, eventID)
	if err != nil {
		return nil, err
	}
	byShift := map[uuid.UUID][]Requirement{}
	for _, row := range requirements {
		roles := []uuid.UUID{}
		if showRoles {
			if roles, err = q.ListEventRequirementRoleIDs(ctx, row.ID); err != nil {
				return nil, err
			}
		}
		byShift[row.ShiftID] = append(byShift[row.ShiftID], Requirement{
			ID:              row.ID,
			EventID:         row.EventID,
			ShiftID:         row.ShiftID,
			Name:            row.Name,
			Description:     row.Description,
			RequiredCount:   int(row.RequiredCount),
			FilledCount:     int(row.FilledCount),
			EligibilityMode: EligibilityMode(row.EligibilityMode),
			EligibleRoleIDs: roles,
			Version:         int64(row.Version),
			CreatedAt:       row.CreatedAt,
			UpdatedAt:       row.UpdatedAt,
		})
	}
	result := make([]Shift, 0, len(rows))
	for _, row := range rows {
		shift := shiftFromListRow(row)
		shift.Requirements = byShift[row.ID]
		if shift.Requirements == nil {
			shift.Requirements = []Requirement{}
		}
		result = append(result, shift)
	}
	return result, nil
}

// loadShift reads one shift with its positions after a change was committed.
func loadShift(ctx context.Context, pool *pgxpool.Pool, eventID, shiftID uuid.UUID) (Shift, error) {
	shifts, err := listShifts(ctx, eventsdb.New(pool), eventID, true)
	if err != nil {
		return Shift{}, err
	}
	for _, shift := range shifts {
		if shift.ID == shiftID {
			return shift, nil
		}
	}
	return Shift{}, apperror.NotFound
}

// CreateShift creates a shift with its positions in one transaction.
func (s *Service) CreateShift(
	ctx context.Context,
	principal authorization.Principal,
	eventID uuid.UUID,
	input ShiftInput,
	requestID *uuid.UUID,
) (Shift, error) {
	if !principal.Has(authorization.EventsStaffingManage) {
		return Shift{}, apperror.PermissionDenied
	}
	input, err := validateShiftInput(input)
	if err != nil {
		return Shift{}, err
	}
	for _, requirement := range input.Requirements {
		if requirement.ID != nil {
			return Shift{}, apperror.Invalid("a new shift cannot reference existing positions")
		}
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Shift{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := eventsdb.New(tx)
	if err = requireEventWritable(ctx, q, eventID, false); err != nil {
		return Shift{}, err
	}
	id := ids.New()
	if err = insertShift(ctx, q, eventID, id, input); err != nil {
		return Shift{}, err
	}
	actor := principal.AccountID
	if err = eventAudit(ctx, tx, &actor, "event_shift.created", "event_shift", id, requestID, shiftAuditFields,
		map[string]any{"eventId": eventID.String()}); err != nil {
		return Shift{}, err
	}
	for _, requirement := range input.Requirements {
		if err = createPosition(ctx, tx, q, &actor, eventID, id, requirement, requestID); err != nil {
			return Shift{}, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return Shift{}, err
	}
	return loadShift(ctx, s.pool, eventID, id)
}

// UpdateShift saves a shift and its complete list of positions in one transaction: positions with an ID are
// updated, new ones created and missing ones deleted. A position with any assignment history cannot be deleted and
// no position can shrink below its active assignments.
func (s *Service) UpdateShift(
	ctx context.Context,
	principal authorization.Principal,
	eventID, id uuid.UUID,
	input ShiftInput,
	requestID *uuid.UUID,
) (Shift, error) {
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
	if err = requireEventWritable(ctx, q, eventID, false); err != nil {
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
	if _, err = q.UpdateEventShift(ctx, eventsdb.UpdateEventShiftParams{
		SessionID:       input.SessionID,
		Name:            input.Name,
		Description:     input.Description,
		StartsAt:        input.StartsAt.UTC(),
		EndsAt:          input.EndsAt.UTC(),
		SignupOpensAt:   toPGTime(input.SignupOpensAt),
		SignupClosesAt:  toPGTime(input.SignupClosesAt),
		IsPublic:        input.IsPublic,
		Status:          string(input.Status),
		ID:              id,
		EventID:         eventID,
		ExpectedVersion: int32(input.ExpectedVersion),
	}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Shift{}, apperror.StaleWrite
		}
		return Shift{}, databaseError(err)
	}
	actor := principal.AccountID
	if err = eventAudit(ctx, tx, &actor, "event_shift.updated", "event_shift", id, requestID, shiftAuditFields,
		map[string]any{"eventId": eventID.String()}); err != nil {
		return Shift{}, err
	}
	existing, err := q.ListEventShiftRequirementsForUpdate(
		ctx,
		eventsdb.ListEventShiftRequirementsForUpdateParams{ShiftID: id, EventID: eventID},
	)
	if err != nil {
		return Shift{}, err
	}
	byID := map[uuid.UUID]eventsdb.EventShiftRequirement{}
	for _, row := range existing {
		byID[row.ID] = row
	}
	kept := map[uuid.UUID]bool{}
	for _, requirement := range input.Requirements {
		if requirement.ID == nil {
			continue
		}
		if _, ok := byID[*requirement.ID]; !ok {
			return Shift{}, apperror.Invalid("a position does not belong to this shift")
		}
		kept[*requirement.ID] = true
	}
	// Deletions run first so a removed position frees its name for a new one.
	for _, row := range existing {
		if kept[row.ID] {
			continue
		}
		history, err := q.CountEventRequirementAssignmentHistory(ctx, row.ID)
		if err != nil {
			return Shift{}, err
		}
		if history != 0 {
			return Shift{}, apperror.New(
				http.StatusConflict,
				"requirement_has_assignments",
				"A position with assignment history cannot be removed",
			)
		}
		if _, err = q.DeleteEventRequirement(ctx, eventsdb.DeleteEventRequirementParams{
			ID: row.ID, ShiftID: id, EventID: eventID, ExpectedVersion: row.Version,
		}); err != nil {
			return Shift{}, databaseError(err)
		}
		if err = eventAudit(ctx, tx, &actor, "event_requirement.deleted", "event_requirement", row.ID, requestID, nil,
			map[string]any{"eventId": eventID.String(), "shiftId": id.String()}); err != nil {
			return Shift{}, err
		}
	}
	for _, requirement := range input.Requirements {
		if requirement.ID == nil {
			if err = createPosition(ctx, tx, q, &actor, eventID, id, requirement, requestID); err != nil {
				return Shift{}, err
			}
			continue
		}
		row := byID[*requirement.ID]
		count, err := q.CountActiveEventRequirementAssignments(ctx, row.ID)
		if err != nil {
			return Shift{}, err
		}
		if int64(requirement.RequiredCount) < count {
			return Shift{}, apperror.New(
				http.StatusConflict,
				"requirement_below_assignments",
				"Places cannot be fewer than the active assignments",
			)
		}
		if _, err = q.UpdateEventRequirement(ctx, eventsdb.UpdateEventRequirementParams{
			Name:            requirement.Name,
			Description:     requirement.Description,
			RequiredCount:   int32(requirement.RequiredCount),
			EligibilityMode: string(requirement.EligibilityMode),
			ID:              row.ID,
			ShiftID:         id,
			EventID:         eventID,
			ExpectedVersion: row.Version,
		}); err != nil {
			return Shift{}, databaseError(err)
		}
		if err = replaceRequirementRoles(ctx, q, row.ID, requirement.EligibilityMode, requirement.EligibleRoleIDs); err != nil {
			return Shift{}, err
		}
		if err = eventAudit(ctx, tx, &actor, "event_requirement.updated", "event_requirement", row.ID, requestID,
			requirementAuditFields, map[string]any{"eventId": eventID.String(), "shiftId": id.String()}); err != nil {
			return Shift{}, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return Shift{}, err
	}
	return loadShift(ctx, s.pool, eventID, id)
}

// DuplicateShift copies a shift with its positions and eligibility roles, without assignments, as a draft.
func (s *Service) DuplicateShift(
	ctx context.Context,
	principal authorization.Principal,
	eventID, id uuid.UUID,
	requestID *uuid.UUID,
) (Shift, error) {
	if !principal.Has(authorization.EventsStaffingManage) {
		return Shift{}, apperror.PermissionDenied
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Shift{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := eventsdb.New(tx)
	if err = requireEventWritable(ctx, q, eventID, false); err != nil {
		return Shift{}, err
	}
	source, err := q.GetEventShift(ctx, eventsdb.GetEventShiftParams{ID: id, EventID: eventID})
	if errors.Is(err, pgx.ErrNoRows) {
		return Shift{}, apperror.NotFound
	}
	if err != nil {
		return Shift{}, err
	}
	positions, err := q.ListEventShiftRequirementsForUpdate(
		ctx,
		eventsdb.ListEventShiftRequirementsForUpdateParams{ShiftID: id, EventID: eventID},
	)
	if err != nil {
		return Shift{}, err
	}
	input := ShiftInput{
		SessionID:      source.SessionID,
		Name:           source.Name,
		Description:    source.Description,
		StartsAt:       source.StartsAt,
		EndsAt:         source.EndsAt,
		SignupOpensAt:  pgTime(source.SignupOpensAt),
		SignupClosesAt: pgTime(source.SignupClosesAt),
		IsPublic:       source.IsPublic,
		Status:         ShiftStatusDraft,
	}
	copyID := ids.New()
	if err = insertShift(ctx, q, eventID, copyID, input); err != nil {
		return Shift{}, err
	}
	actor := principal.AccountID
	// The resource is the copy; shiftId in the metadata names the shift it was copied from.
	if err = eventAudit(ctx, tx, &actor, "event_shift.duplicated", "event_shift", copyID, requestID, shiftAuditFields,
		map[string]any{"eventId": eventID.String(), "shiftId": id.String()}); err != nil {
		return Shift{}, err
	}
	for _, position := range positions {
		roles, err := q.ListEventRequirementRoleIDs(ctx, position.ID)
		if err != nil {
			return Shift{}, err
		}
		if err = createPosition(ctx, tx, q, &actor, eventID, copyID, RequirementInput{
			Name:            position.Name,
			Description:     position.Description,
			RequiredCount:   int(position.RequiredCount),
			EligibilityMode: EligibilityMode(position.EligibilityMode),
			EligibleRoleIDs: roles,
		}, requestID); err != nil {
			return Shift{}, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return Shift{}, err
	}
	return loadShift(ctx, s.pool, eventID, copyID)
}

var (
	shiftAuditFields = []string{
		"sessionId", "name", "description", "startsAt", "endsAt", "signupWindow", "isPublic", "status", "requirements",
	}
	requirementAuditFields = []string{"name", "description", "requiredCount", "eligibilityMode", "eligibleRoleIds"}
)

func insertShift(ctx context.Context, q *eventsdb.Queries, eventID, id uuid.UUID, input ShiftInput) error {
	_, err := q.CreateEventShift(ctx, eventsdb.CreateEventShiftParams{
		ID:             id,
		EventID:        eventID,
		SessionID:      input.SessionID,
		Name:           input.Name,
		Description:    input.Description,
		StartsAt:       input.StartsAt.UTC(),
		EndsAt:         input.EndsAt.UTC(),
		SignupOpensAt:  toPGTime(input.SignupOpensAt),
		SignupClosesAt: toPGTime(input.SignupClosesAt),
		IsPublic:       input.IsPublic,
		Status:         string(input.Status),
	})
	return databaseError(err)
}

func createPosition(
	ctx context.Context,
	tx pgx.Tx,
	q *eventsdb.Queries,
	actor *uuid.UUID,
	eventID, shiftID uuid.UUID,
	input RequirementInput,
	requestID *uuid.UUID,
) error {
	id := ids.New()
	if _, err := q.CreateEventRequirement(ctx, eventsdb.CreateEventRequirementParams{
		ID:              id,
		EventID:         eventID,
		ShiftID:         shiftID,
		Name:            input.Name,
		Description:     input.Description,
		RequiredCount:   int32(input.RequiredCount),
		EligibilityMode: string(input.EligibilityMode),
	}); err != nil {
		return databaseError(err)
	}
	if err := replaceRequirementRoles(ctx, q, id, input.EligibilityMode, input.EligibleRoleIDs); err != nil {
		return err
	}
	return eventAudit(ctx, tx, actor, "event_requirement.created", "event_requirement", id, requestID,
		requirementAuditFields, map[string]any{"eventId": eventID.String(), "shiftId": shiftID.String()})
}

// validateShiftPositions checks every position and that names and IDs are unique within the shift.
func validateShiftPositions(inputs []RequirementInput) ([]RequirementInput, error) {
	if len(inputs) > MaxShiftPositions {
		return nil, apperror.Invalid("a shift has at most 50 positions")
	}
	names := map[string]bool{}
	seen := map[uuid.UUID]bool{}
	result := make([]RequirementInput, 0, len(inputs))
	for _, input := range inputs {
		input, err := validateRequirementInput(input)
		if err != nil {
			return nil, err
		}
		key := strings.ToLower(input.Name)
		if names[key] {
			return nil, apperror.Invalid("position names must be unique within a shift")
		}
		names[key] = true
		if input.ID != nil {
			if seen[*input.ID] {
				return nil, apperror.Invalid("a position appears twice")
			}
			seen[*input.ID] = true
		}
		result = append(result, input)
	}
	return result, nil
}
