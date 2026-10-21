package events

import (
	"context"
	"sort"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	eventsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/events/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

// Helpers groups the event's active assignments by helper and lists what needs attention. It needs permission to
// see helper names; contact details need canViewPII and person-match suggestions events.assign.
func (s *Service) Helpers(ctx context.Context, principal authorization.Principal, eventID uuid.UUID) (Helpers, error) {
	if !canSeeHelperNames(principal) {
		return Helpers{}, apperror.PermissionDenied
	}
	q := eventsdb.New(s.pool)
	row, err := visibleEvent(ctx, q, principal, eventID)
	if err != nil {
		return Helpers{}, err
	}
	facts, err := loadEventFacts(ctx, q, row)
	if err != nil {
		return Helpers{}, err
	}
	var totals Event
	applyFacts(&totals, facts, time.Now().UTC())
	result := Helpers{
		RequiredCount:           totals.RequiredCount,
		FilledCount:             totals.FilledCount,
		OpenPlaces:              totals.OpenPlaces,
		Helpers:                 []Helper{},
		UnlinkedSignups:         []UnlinkedSignup{},
		OverriddenAssignmentIDs: []uuid.UUID{},
	}
	shifts := map[uuid.UUID]eventsdb.ListEventShiftsRow{}
	for _, shift := range facts.shifts {
		shifts[shift.ID] = shift
	}
	positions := map[uuid.UUID]string{}
	for _, requirement := range facts.requirements {
		positions[requirement.ID] = requirement.Name
	}
	assignments, err := q.ListEventAssignments(ctx, eventID)
	if err != nil {
		return Helpers{}, err
	}
	showContact := canViewPII(principal)
	byKey := map[string]*Helper{}
	order := []string{}
	for _, assignment := range assignments {
		if AssignmentStatus(assignment.Status) != AssignmentStatusActive {
			continue
		}
		name := helperName(assignment.PersonFirstName, assignment.PersonLastName, assignment.FirstNameSnapshot,
			assignment.LastNameSnapshot)
		overridden := assignment.ConflictOverriddenByAccountID != nil
		source := AssignmentSource(assignment.Source)
		identity := helperIdentity(assignment)
		helper, ok := byKey[identity]
		if !ok {
			// The key is the first assignment's ID so no contact data leaves the server through it.
			helper = &Helper{Key: assignment.ID.String(), PersonID: assignment.PersonID, DisplayName: name}
			if showContact {
				helper.Email, helper.Phone = assignment.EmailSnapshot, assignment.PhoneSnapshot
			}
			byKey[identity] = helper
			order = append(order, identity)
		}
		if !containsSource(helper.Sources, source) {
			helper.Sources = append(helper.Sources, source)
		}
		helper.ConflictOverridden = helper.ConflictOverridden || overridden
		shift := shifts[assignment.ShiftID]
		helper.Shifts = append(helper.Shifts, HelperShift{
			AssignmentID:       assignment.ID,
			ShiftID:            assignment.ShiftID,
			RequirementID:      assignment.RequirementID,
			ShiftName:          shift.Name,
			RequirementName:    positions[assignment.RequirementID],
			StartsAt:           shift.StartsAt,
			EndsAt:             shift.EndsAt,
			Source:             source,
			ConflictOverridden: overridden,
			Version:            int64(assignment.Version),
		})
		if overridden {
			result.OverriddenAssignmentIDs = append(result.OverriddenAssignmentIDs, assignment.ID)
		}
		if assignment.PersonID == nil && !assignment.PersonalDataErasedAt.Valid &&
			(source == SourcePublicSignup || source == SourceAuthenticatedOnBehalf) {
			unlinked := UnlinkedSignup{
				AssignmentID: assignment.ID,
				Version:      int64(assignment.Version),
				DisplayName:  name,
				Suggestions:  []PersonOption{},
			}
			if principal.Has(authorization.EventsAssign) {
				matches, err := q.FindEventPeopleByExactContact(ctx, eventsdb.FindEventPeopleByExactContactParams{
					EmailNormalized: assignment.EmailNormalized,
					PhoneNormalized: assignment.PhoneNormalized,
				})
				if err != nil {
					return Helpers{}, err
				}
				for _, match := range matches {
					unlinked.Suggestions = append(unlinked.Suggestions, PersonOption{
						ID: match.ID, FirstName: match.FirstName, LastName: match.LastName, Email: match.Email,
						Phone: match.Phone,
					})
				}
			}
			result.UnlinkedSignups = append(result.UnlinkedSignups, unlinked)
		}
	}
	for _, identity := range order {
		helper := byKey[identity]
		sort.SliceStable(helper.Shifts, func(i, j int) bool { return helper.Shifts[i].StartsAt.Before(helper.Shifts[j].StartsAt) })
		result.Helpers = append(result.Helpers, *helper)
	}
	sort.SliceStable(result.Helpers, func(i, j int) bool {
		return strings.ToLower(nameOrEmpty(result.Helpers[i].DisplayName)) <
			strings.ToLower(nameOrEmpty(result.Helpers[j].DisplayName))
	})
	return result, nil
}

// helperIdentity groups assignments of one helper: by person, else by normalized e-mail or phone, else the
// assignment stands alone (erased or free entries without contact).
func helperIdentity(assignment eventsdb.ListEventAssignmentsRow) string {
	switch {
	case assignment.PersonID != nil:
		return "person:" + assignment.PersonID.String()
	case assignment.EmailNormalized != nil:
		return "email:" + *assignment.EmailNormalized
	case assignment.PhoneNormalized != nil:
		return "phone:" + *assignment.PhoneNormalized
	}
	return "assignment:" + assignment.ID.String()
}

func containsSource(values []AssignmentSource, value AssignmentSource) bool {
	for _, item := range values {
		if item == value {
			return true
		}
	}
	return false
}

func nameOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
