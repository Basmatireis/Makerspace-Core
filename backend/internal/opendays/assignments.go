package opendays

import (
	"context"
	"errors"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
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

func (s *Service) Join(ctx context.Context, p authorization.Principal, openDayID, requirementID uuid.UUID, requestID *uuid.UUID) (Assignment, error) {
	if !p.Has(authorization.OpenDaysSignup) {
		return Assignment{}, apperror.PermissionDenied
	}
	return s.assign(ctx, p, openDayID, requirementID, p.PersonID, requestID, "open_day.self_joined")
}

func (s *Service) Assign(ctx context.Context, p authorization.Principal, openDayID, requirementID, personID uuid.UUID, requestID *uuid.UUID) (Assignment, error) {
	if !p.Has(authorization.OpenDaysAssign) {
		return Assignment{}, apperror.PermissionDenied
	}
	return s.assign(ctx, p, openDayID, requirementID, personID, requestID, "open_day.person_assigned")
}

func (s *Service) assign(ctx context.Context, p authorization.Principal, openDayID, requirementID, personID uuid.UUID, requestID *uuid.UUID, action string) (Assignment, error) {
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
	if day.Status != "scheduled" || (period.Status != "staffing" && period.Status != "published") {
		return Assignment{}, conflict("assignment_closed", "Assignments are open only for scheduled Open Days in staffing or published periods")
	}
	eligible, err := q.PersonEligibleForRequirement(ctx, opendaysdb.PersonEligibleForRequirementParams{PersonID: personID, RequirementID: requirementID})
	if err != nil {
		return Assignment{}, err
	}
	if !eligible {
		return Assignment{}, conflict("person_not_eligible", "The person is not enabled and eligible for this requirement")
	}
	count, err := q.CountRequirementAssignments(ctx, requirementID)
	if err != nil {
		return Assignment{}, err
	}
	if count >= int64(req.RequiredCount) {
		return Assignment{}, conflict("requirement_full", "This staffing requirement is full")
	}
	id := uuid.Must(uuid.NewV7())
	actor := p.AccountID
	row, err := q.CreateAssignment(ctx, opendaysdb.CreateAssignmentParams{ID: id, OpenDayID: openDayID, RequirementID: requirementID, PersonID: personID, CreatedByAccountID: &actor})
	if err != nil {
		return Assignment{}, databaseError(err)
	}
	if err := writeAudit(ctx, tx, p, action, "open_day_assignment", id, requestID, []string{"requirementId", "personId"}); err != nil {
		return Assignment{}, err
	}
	people, err := q.ListEligiblePeople(ctx, opendaysdb.ListEligiblePeopleParams{RequirementID: requirementID, Search: "", PageLimit: 200})
	if err != nil {
		return Assignment{}, err
	}
	name := ""
	for _, person := range people {
		if person.ID == personID {
			name = strings.TrimSpace(person.FirstName + " " + person.LastName)
			break
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Assignment{}, err
	}
	return Assignment{ID: row.ID, OpenDayID: row.OpenDayID, RequirementID: row.RequirementID, PersonID: row.PersonID, DisplayName: name, IsCurrentUser: personID == p.PersonID, CreatedAt: row.CreatedAt}, nil
}

func (s *Service) Leave(ctx context.Context, p authorization.Principal, openDayID uuid.UUID, requestID *uuid.UUID) error {
	if !p.Has(authorization.OpenDaysSignup) {
		return apperror.PermissionDenied
	}
	q := opendaysdb.New(s.pool)
	assignment, err := q.GetPersonOpenDayAssignment(ctx, opendaysdb.GetPersonOpenDayAssignmentParams{OpenDayID: openDayID, PersonID: p.PersonID})
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	if err != nil {
		return err
	}
	return s.removeAssignment(ctx, p, openDayID, assignment.ID, true, requestID)
}

func (s *Service) RemoveAssignment(ctx context.Context, p authorization.Principal, openDayID, assignmentID uuid.UUID, requestID *uuid.UUID) error {
	if !p.Has(authorization.OpenDaysAssign) {
		return apperror.PermissionDenied
	}
	return s.removeAssignment(ctx, p, openDayID, assignmentID, false, requestID)
}

func (s *Service) removeAssignment(ctx context.Context, p authorization.Principal, openDayID, assignmentID uuid.UUID, self bool, requestID *uuid.UUID) error {
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
	if day.Status != "scheduled" || period.Status == "archived" {
		return conflict("assignment_closed", "Assignments cannot change after cancellation or archive")
	}
	if _, err := q.DeleteAssignment(ctx, assignmentID); err != nil {
		return err
	}
	action := "open_day.person_unassigned"
	if self {
		action = "open_day.self_left"
	}
	if err := writeAudit(ctx, tx, p, action, "open_day_assignment", assignmentID, requestID, nil); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) EligiblePeople(ctx context.Context, p authorization.Principal, requirementID uuid.UUID, search string) ([]MinimalPerson, error) {
	if !p.Has(authorization.OpenDaysAssign) {
		return nil, apperror.PermissionDenied
	}
	q := opendaysdb.New(s.pool)
	if _, err := q.GetRequirement(ctx, requirementID); errors.Is(err, pgx.ErrNoRows) {
		return nil, apperror.NotFound
	} else if err != nil {
		return nil, err
	}
	rows, err := q.ListEligiblePeople(ctx, opendaysdb.ListEligiblePeopleParams{RequirementID: requirementID, Search: strings.TrimSpace(search), PageLimit: 50})
	if err != nil {
		return nil, err
	}
	items := make([]MinimalPerson, 0, len(rows))
	for _, row := range rows {
		items = append(items, MinimalPerson{PersonID: row.ID, DisplayName: strings.TrimSpace(row.FirstName + " " + row.LastName)})
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
