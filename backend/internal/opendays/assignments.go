package opendays

import (
	"context"
	"errors"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules"
	opendaysdb "github.com/Basmatireis/Makerspace-Core/backend/internal/opendays/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type MinimalPerson struct {
	PersonID    uuid.UUID
	DisplayName string
}
type EligibilityRole struct {
	ID   uuid.UUID
	Name string
}

func (s *Service) Join(
	ctx context.Context,
	p authorization.Principal,
	openDayID, requirementID uuid.UUID,
	requestID *uuid.UUID,
) (Assignment, error) {
	if !p.Has(authorization.OpenDaysSignup) {
		return Assignment{}, apperror.PermissionDenied
	}
	return s.assign(ctx, p, openDayID, requirementID, p.PersonID, requestID, "open_day.self_joined")
}

func (s *Service) Assign(
	ctx context.Context,
	p authorization.Principal,
	openDayID, requirementID, personID uuid.UUID,
	requestID *uuid.UUID,
) (Assignment, error) {
	if !p.Has(authorization.OpenDaysAssign) {
		return Assignment{}, apperror.PermissionDenied
	}
	return s.assign(ctx, p, openDayID, requirementID, personID, requestID, "open_day.person_assigned")
}

func (s *Service) assign(
	ctx context.Context,
	p authorization.Principal,
	openDayID, requirementID, personID uuid.UUID,
	requestID *uuid.UUID,
	action string,
) (Assignment, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Assignment{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := opendaysdb.New(tx)
	day, err := q.GetOpenDay(ctx, openDayID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Assignment{}, apperror.NotFound
	}
	if err != nil {
		return Assignment{}, err
	}
	period, err := q.GetPeriodForUpdate(ctx, day.PeriodID)
	if err != nil {
		return Assignment{}, err
	}
	day, err = q.GetOpenDayForUpdate(ctx, openDayID)
	if err != nil {
		return Assignment{}, err
	}
	req, err := q.GetRequirementForUpdate(ctx, requirementID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Assignment{}, apperror.NotFound
	}
	if err != nil {
		return Assignment{}, err
	}
	if req.OpenDayID != openDayID {
		return Assignment{}, apperror.NotFound
	}
	if DayStatus(day.Status) != DayScheduled || (PeriodStatus(period.Status) != PeriodStaffing && PeriodStatus(period.Status) != PeriodPublished) {
		return Assignment{}, apperror.Conflicting(
			"assignment_closed",
			"Assignments are open only for scheduled Open Days in staffing or published periods",
		)
	}
	if _, err := q.GetPersonTimeslotAssignment(
		ctx,
		opendaysdb.GetPersonTimeslotAssignmentParams{TimeslotID: req.TimeslotID, PersonID: personID},
	); err == nil {
		return Assignment{}, apperror.Conflicting("already_in_timeslot", "The person already has a place in this timeslot")
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return Assignment{}, err
	}
	eligible, err := q.PersonEligibleForRequirement(
		ctx,
		opendaysdb.PersonEligibleForRequirementParams{PersonID: personID, RequirementID: requirementID},
	)
	if err != nil {
		return Assignment{}, err
	}
	if !eligible {
		return Assignment{}, apperror.Conflicting(
			"person_not_eligible",
			"The person is not eligible for this requirement",
		)
	}
	count, err := q.CountRequirementAssignments(ctx, requirementID)
	if err != nil {
		return Assignment{}, err
	}
	if count >= int64(req.RequiredCount) {
		return Assignment{}, apperror.Conflicting("requirement_full", "This staffing requirement is full")
	}
	id := ids.New()
	actor := p.AccountID
	row, err := q.CreateAssignment(
		ctx,
		opendaysdb.CreateAssignmentParams{
			ID:                 id,
			OpenDayID:          openDayID,
			TimeslotID:         req.TimeslotID,
			RequirementID:      requirementID,
			PersonID:           personID,
			CreatedByAccountID: &actor,
		},
	)
	if err != nil {
		return Assignment{}, databaseError(err)
	}
	if err := writeAuditWithMetadata(ctx, tx, p, action, "open_day_assignment", id, requestID, []string{
		"requirementId",
		"personId",
	}, map[string]any{
		"personId": personID.String(), "openDayId": openDayID.String(), "timeslotId": req.TimeslotID.String(),
	}); err != nil {
		return Assignment{}, err
	}
	if req.Kind == "supervisor" {
		if err := s.inbox.PlaceTaken(ctx, tx, req.TimeslotID); err != nil {
			return Assignment{}, err
		}
	}
	if err := s.inbox.OpenDaySignup(ctx, tx, req.TimeslotID, personID, req.Kind, personID == p.PersonID, s.location); err != nil {
		return Assignment{}, err
	}
	if personID != p.PersonID {
		slot, err := q.GetTimeslot(ctx, req.TimeslotID)
		if err != nil {
			return Assignment{}, err
		}
		if err := s.notifyAssignmentChange(
			ctx, tx, notifyrules.OpenDayAssignedByOther, personID, period.ID, openDayID, slot,
		); err != nil {
			return Assignment{}, err
		}
	}
	person, err := q.GetAssignmentPersonName(ctx, personID)
	if err != nil {
		return Assignment{}, err
	}
	name := strings.TrimSpace(person.FirstName + " " + person.LastName)
	if err := tx.Commit(ctx); err != nil {
		return Assignment{}, err
	}
	return Assignment{
		ID:              row.ID,
		OpenDayID:       row.OpenDayID,
		TimeslotID:      row.TimeslotID,
		RequirementID:   row.RequirementID,
		PersonID:        row.PersonID,
		DisplayName:     name,
		HasProfileImage: person.HasProfileImage,
		IsCurrentUser:   personID == p.PersonID,
		CreatedAt:       row.CreatedAt,
	}, nil
}

// Leave removes the caller's own assignment in one timeslot of the open day.
func (s *Service) Leave(
	ctx context.Context,
	p authorization.Principal,
	openDayID, timeslotID uuid.UUID,
	requestID *uuid.UUID,
) error {
	if !p.Has(authorization.OpenDaysSignup) {
		return apperror.PermissionDenied
	}
	q := opendaysdb.New(s.pool)
	assignment, err := q.GetPersonTimeslotAssignment(
		ctx,
		opendaysdb.GetPersonTimeslotAssignmentParams{TimeslotID: timeslotID, PersonID: p.PersonID},
	)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && assignment.OpenDayID != openDayID) {
		return apperror.NotFound
	}
	if err != nil {
		return err
	}
	return s.removeAssignment(ctx, p, openDayID, assignment.ID, true, requestID)
}

func (s *Service) RemoveAssignment(
	ctx context.Context,
	p authorization.Principal,
	openDayID, assignmentID uuid.UUID,
	requestID *uuid.UUID,
) error {
	if !p.Has(authorization.OpenDaysAssign) {
		return apperror.PermissionDenied
	}
	return s.removeAssignment(ctx, p, openDayID, assignmentID, false, requestID)
}

func (s *Service) removeAssignment(
	ctx context.Context,
	p authorization.Principal,
	openDayID, assignmentID uuid.UUID,
	self bool,
	requestID *uuid.UUID,
) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := opendaysdb.New(tx)
	assignment, err := q.GetAssignment(ctx, assignmentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	if err != nil {
		return err
	}
	if assignment.OpenDayID != openDayID || (self && assignment.PersonID != p.PersonID) {
		return apperror.NotFound
	}
	day, err := q.GetOpenDay(ctx, openDayID)
	if err != nil {
		return err
	}
	period, err := q.GetPeriodForUpdate(ctx, day.PeriodID)
	if err != nil {
		return err
	}
	day, err = q.GetOpenDayForUpdate(ctx, openDayID)
	if err != nil {
		return err
	}
	if DayStatus(day.Status) != DayScheduled || PeriodStatus(period.Status) == PeriodArchived {
		return apperror.Conflicting("assignment_closed", "Assignments cannot change after cancellation or archive")
	}
	if _, err := q.DeleteAssignment(ctx, assignmentID); err != nil {
		return err
	}
	action := "open_day.person_unassigned"
	if self {
		action = "open_day.self_left"
	}
	if err := writeAuditWithMetadata(ctx, tx, p, action, "open_day_assignment", assignmentID, requestID, nil, map[string]any{
		"personId": assignment.PersonID.String(), "openDayId": openDayID.String(),
		"timeslotId": assignment.TimeslotID.String(),
	}); err != nil {
		return err
	}
	if assignment.PersonID != p.PersonID {
		slot, err := q.GetTimeslot(ctx, assignment.TimeslotID)
		if err != nil {
			return err
		}
		if err := s.notifyAssignmentChange(
			ctx, tx, notifyrules.OpenDayUnassignedByOther, assignment.PersonID, period.ID, openDayID, slot,
		); err != nil {
			return err
		}
	}
	// Only a freed supervisor place is worth a notification; empty trainee places never warn.
	requirement, err := q.GetRequirement(ctx, assignment.RequirementID)
	if err != nil {
		return err
	}
	if RequirementKind(requirement.Kind) == RequirementSupervisor {
		if err := s.inbox.PlaceFreed(ctx, tx, assignment.TimeslotID, assignment.PersonID, s.location); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (s *Service) EligiblePeople(
	ctx context.Context,
	p authorization.Principal,
	requirementID uuid.UUID,
	search string,
) ([]MinimalPerson, error) {
	if !p.Has(authorization.OpenDaysAssign) {
		return nil, apperror.PermissionDenied
	}
	q := opendaysdb.New(s.pool)
	if _, err := q.GetRequirement(ctx, requirementID); errors.Is(err, pgx.ErrNoRows) {
		return nil, apperror.NotFound
	} else if err != nil {
		return nil, err
	}
	rows, err := q.ListEligiblePeople(
		ctx,
		opendaysdb.ListEligiblePeopleParams{
			RequirementID: requirementID,
			Search:        strings.TrimSpace(search),
			PageLimit:     50,
		},
	)
	if err != nil {
		return nil, err
	}
	items := make([]MinimalPerson, 0, len(rows))
	for _, row := range rows {
		items = append(
			items,
			MinimalPerson{PersonID: row.ID, DisplayName: strings.TrimSpace(row.FirstName + " " + row.LastName)},
		)
	}
	return items, nil
}

func (s *Service) EligibilityRoles(ctx context.Context, p authorization.Principal) ([]EligibilityRole, error) {
	if !p.Has(authorization.OpenDaysManage) {
		return nil, apperror.PermissionDenied
	}
	rows, err := opendaysdb.New(s.pool).ListEligibilityRoles(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]EligibilityRole, 0, len(rows))
	for _, row := range rows {
		items = append(items, EligibilityRole{ID: row.ID, Name: row.Name})
	}
	return items, nil
}
