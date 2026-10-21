package integration_test

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/events"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
)

func shiftInputOf(shift events.Shift) events.ShiftInput {
	positions := make([]events.RequirementInput, 0, len(shift.Requirements))
	for _, requirement := range shift.Requirements {
		id := requirement.ID
		positions = append(positions, events.RequirementInput{
			ID: &id, Name: requirement.Name, RequiredCount: requirement.RequiredCount,
			EligibilityMode: requirement.EligibilityMode, EligibleRoleIDs: requirement.EligibleRoleIDs,
		})
	}
	return events.ShiftInput{
		SessionID: shift.SessionID, Name: shift.Name, StartsAt: shift.StartsAt, EndsAt: shift.EndsAt,
		IsPublic: shift.IsPublic, Status: shift.Status, Requirements: positions, ExpectedVersion: shift.Version,
	}
}

// A shift and its positions are saved in one request and one transaction: positions are created, updated and
// deleted by diff, a position with assignment history cannot be removed and no position shrinks below its helpers.
func TestEventShiftSaveDiffsPositionsInOneTransaction(t *testing.T) {
	e := newStaffingEnv(t)
	ctx := testContext(t)
	start := e.now.Add(90 * time.Hour).Truncate(time.Minute)
	fixture := e.newEventFixture("Fair", start, 2)
	e.transition(&fixture, events.EventStatusConfirmed)
	instructors := e.role("Instructors", nil)

	shift, err := e.events.CreateShift(ctx, e.master, fixture.event.ID, events.ShiftInput{
		Name: "Booth", StartsAt: start, EndsAt: start.Add(2 * time.Hour), Status: "open", IsPublic: true,
		Requirements: []events.RequirementInput{
			{Name: "Bar", RequiredCount: 2},
			{Name: "First aid", RequiredCount: 1, EligibilityMode: events.EligibilityRoles,
				EligibleRoleIDs: []uuid.UUID{instructors.ID}},
			{Name: "Spare", RequiredCount: 1},
		},
	}, nil)
	if err != nil || len(shift.Requirements) != 3 {
		t.Fatalf("create shift = %#v, err=%v", shift, err)
	}
	positionID := func(shift events.Shift, name string) uuid.UUID {
		t.Helper()
		for _, requirement := range shift.Requirements {
			if requirement.Name == name {
				return requirement.ID
			}
		}
		t.Fatalf("position %s missing in %#v", name, shift.Requirements)
		return uuid.Nil
	}
	barHelpers := e.role("Bar helpers", nil, authorization.EventsRead, authorization.EventsSignup)
	member := e.person("bar-helper", barHelpers.ID)
	joined, err := e.events.Join(ctx, member, fixture.event.ID, shift.ID, positionID(shift, "Bar"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = e.events.Leave(ctx, member, fixture.event.ID, joined.AssignmentID, joined.Version, nil); err != nil {
		t.Fatal(err)
	}
	for _, helper := range []authorization.Principal{member, e.person("bar-helper", barHelpers.ID)} {
		if _, err = e.events.Join(ctx, helper, fixture.event.ID, shift.ID, positionID(shift, "Bar"), nil); err != nil {
			t.Fatal(err)
		}
	}
	staff := e.person("staff-only", e.role("Staff only", nil, authorization.EventsAssign).ID)
	if _, err = e.events.UpdateShift(ctx, staff, fixture.event.ID, shift.ID, shiftInputOf(shift), nil); !errors.Is(
		err,
		apperror.PermissionDenied,
	) {
		t.Fatalf("update shift without staffing permission error = %v", err)
	}

	// Rename and grow Bar, drop Spare, add Cashier.
	input := shiftInputOf(shift)
	input.Name = "Booth (main)"
	kept := []events.RequirementInput{}
	for _, position := range input.Requirements {
		switch position.Name {
		case "Bar":
			position.Name, position.RequiredCount = "Bar & drinks", 3
		case "Spare":
			continue
		}
		kept = append(kept, position)
	}
	input.Requirements = append(kept, events.RequirementInput{Name: "Cashier", RequiredCount: 1})
	saved, err := e.events.UpdateShift(ctx, e.master, fixture.event.ID, shift.ID, input, nil)
	if err != nil {
		t.Fatalf("save shift: %v", err)
	}
	if saved.Name != "Booth (main)" || len(saved.Requirements) != 3 || saved.Version != shift.Version+1 {
		t.Fatalf("saved shift = %#v", saved)
	}
	bar := positionID(saved, "Bar & drinks")
	if bar != positionID(shift, "Bar") {
		t.Fatal("updating a position replaced it")
	}
	for _, requirement := range saved.Requirements {
		if requirement.Name == "First aid" && (len(requirement.EligibleRoleIDs) != 1 || requirement.EligibleRoleIDs[0] != instructors.ID) {
			t.Fatalf("roles after save = %#v", requirement)
		}
		if requirement.Name == "Bar & drinks" && (requirement.RequiredCount != 3 || requirement.FilledCount != 2) {
			t.Fatalf("bar after save = %#v", requirement)
		}
	}
	assertCount(t, e.pool, `SELECT count(*) FROM audit_events WHERE action='event_requirement.deleted' AND resource_id=$1`,
		1, positionID(shift, "Spare"))

	// Removing a position with assignment history fails and changes nothing.
	failing := shiftInputOf(saved)
	failing.Name = "Should not stick"
	failing.Requirements = failing.Requirements[:0]
	for _, position := range shiftInputOf(saved).Requirements {
		if *position.ID != bar {
			failing.Requirements = append(failing.Requirements, position)
		}
	}
	_, err = e.events.UpdateShift(ctx, e.master, fixture.event.ID, shift.ID, failing, nil)
	expectAppCode(t, err, "requirement_has_assignments")
	shrinking := shiftInputOf(saved)
	for index := range shrinking.Requirements {
		if *shrinking.Requirements[index].ID == bar {
			shrinking.Requirements[index].RequiredCount = 1
		}
	}
	_, err = e.events.UpdateShift(ctx, e.master, fixture.event.ID, shift.ID, shrinking, nil)
	expectAppCode(t, err, "requirement_below_assignments")
	assertCount(t, e.pool, `SELECT count(*) FROM event_shifts WHERE id=$1 AND name='Booth (main)'`, 1, shift.ID)

	unknown := shiftInputOf(saved)
	stranger := ids.New()
	unknown.Requirements = append(unknown.Requirements, events.RequirementInput{ID: &stranger, Name: "Ghost", RequiredCount: 1})
	if _, err = e.events.UpdateShift(ctx, e.master, fixture.event.ID, shift.ID, unknown, nil); err == nil {
		t.Fatal("accepted a position of another shift")
	}
	duplicate := shiftInputOf(saved)
	duplicate.Requirements = append(duplicate.Requirements, events.RequirementInput{Name: "cashier", RequiredCount: 1})
	if _, err = e.events.UpdateShift(ctx, e.master, fixture.event.ID, shift.ID, duplicate, nil); err == nil {
		t.Fatal("accepted duplicate position names")
	}
	if _, err = e.events.UpdateShift(ctx, e.master, fixture.event.ID, shift.ID, shiftInputOf(shift), nil); !errors.Is(
		err,
		apperror.StaleWrite,
	) {
		t.Fatalf("stale shift save error = %v", err)
	}

	// Duplicating copies the shift and its positions with roles, as a draft without assignments.
	copied, err := e.events.DuplicateShift(ctx, e.master, fixture.event.ID, shift.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	if copied.ID == shift.ID || copied.Status != events.ShiftStatusDraft || copied.Name != saved.Name ||
		len(copied.Requirements) != 3 {
		t.Fatalf("copied shift = %#v", copied)
	}
	for _, requirement := range copied.Requirements {
		if requirement.FilledCount != 0 || requirement.ID == bar {
			t.Fatalf("copied position = %#v", requirement)
		}
		if requirement.Name == "First aid" && len(requirement.EligibleRoleIDs) != 1 {
			t.Fatalf("copied roles = %#v", requirement)
		}
	}
	if _, err = e.events.DuplicateShift(ctx, staff, fixture.event.ID, shift.ID, nil); !errors.Is(
		err,
		apperror.PermissionDenied,
	) {
		t.Fatalf("duplicate without staffing permission error = %v", err)
	}
}

// Creating an event with its first session happens in one transaction.
func TestEventCreateWithFirstSession(t *testing.T) {
	e := newStaffingEnv(t)
	ctx := testContext(t)
	start := e.now.Add(300 * time.Hour).Truncate(time.Minute)
	event, err := e.events.Create(ctx, e.master, events.EventInput{
		Name:         "Hackathon",
		FirstSession: &events.SessionInput{StartsAt: start, EndsAt: start.Add(8 * time.Hour), IsPublic: true},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	sessions, err := e.events.ListSessions(ctx, e.master, event.ID)
	if err != nil || len(sessions) != 1 || sessions[0].Status != events.SessionStatusScheduled || !sessions[0].IsPublic {
		t.Fatalf("first session = %#v, err=%v", sessions, err)
	}
	if event.RangeStartsAt == nil || !event.RangeStartsAt.Equal(start) {
		t.Fatalf("event range = %v", event.RangeStartsAt)
	}
	if _, err = e.events.Create(ctx, e.master, events.EventInput{
		Name:         "Broken",
		FirstSession: &events.SessionInput{StartsAt: start, EndsAt: start.Add(-time.Hour)},
	}, nil); err == nil {
		t.Fatal("accepted a first session that ends before it starts")
	}
	assertCount(t, e.pool, `SELECT count(*) FROM events WHERE name='Broken'`, 0)
}

// The helpers overview groups helpers by person or contact, lists unlinked public signups with person matches and
// overridden conflicts; names need a helper-name permission, contacts staffing permissions, suggestions events.assign.
func TestEventHelpersOverviewByPermission(t *testing.T) {
	e := newStaffingEnv(t)
	ctx := testContext(t)
	start := e.now.Add(180 * time.Hour).Truncate(time.Minute)
	fixture := e.newEventFixture("Garden day", start, 3)
	title := "Garden day"
	owner := e.master.PersonID
	updated, err := e.events.Update(ctx, e.master, fixture.event.ID, events.EventInput{
		Name: fixture.event.Name, OwnerPersonID: &owner, PublicTitle: &title, PublicSignupEnabled: true,
		ExpectedVersion: fixture.event.Version,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if fixture.event, err = e.events.SetPublished(ctx, e.master, fixture.event.ID, updated.Version, true, nil); err != nil {
		t.Fatal(err)
	}
	e.transition(&fixture, events.EventStatusConfirmed)
	second, err := e.events.CreateShift(ctx, e.master, fixture.event.ID, events.ShiftInput{
		Name: "Cleanup", StartsAt: start.Add(4 * time.Hour), EndsAt: start.Add(5 * time.Hour), Status: "open",
		IsPublic: true, Requirements: []events.RequirementInput{{Name: "Sweeper", RequiredCount: 2}},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	member := e.person("gardener", e.role("Gardeners", nil, authorization.EventsRead, authorization.EventsSignup).ID)
	for _, target := range []struct{ shift, requirement uuid.UUID }{
		{fixture.shift.ID, fixture.requirement}, {second.ID, second.Requirements[0].ID},
	} {
		if _, err = e.events.Join(ctx, member, fixture.event.ID, target.shift, target.requirement, nil); err != nil {
			t.Fatal(err)
		}
	}
	matchEmail := "known.visitor@example.test"
	e.exec(`INSERT INTO people(id,first_name,last_name,email) VALUES($1,'Known','Visitor',$2)`, ids.New(), matchEmail)
	if _, err = e.events.SignupAnonymous(ctx, fixture.event.PublicID, "192.0.2.80", events.AssignmentInput{
		ShiftID: fixture.shift.ID, RequirementID: fixture.requirement, FirstName: "Known", LastName: "Visitor",
		Email: &matchEmail,
	}, nil); err != nil {
		t.Fatal(err)
	}

	assign := e.person("helpers-assign", e.role("Helper assigners", nil, authorization.EventsAssign).ID)
	staffing := e.person("helpers-staffing", e.role("Helper staffing", nil, authorization.EventsStaffingManage).ID)
	names := e.person("helpers-names", e.role("Helper names", nil, authorization.EventsRead,
		authorization.EventsReadAssignments).ID)
	reader := e.person("helpers-reader", e.role("Helper readers", nil, authorization.EventsRead).ID)
	if _, err = e.events.Helpers(ctx, reader, fixture.event.ID); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("helpers without names permission error = %v", err)
	}

	overview, err := e.events.Helpers(ctx, assign, fixture.event.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(overview.Helpers) != 2 || overview.RequiredCount != 5 || overview.FilledCount != 3 || overview.OpenPlaces != 2 {
		t.Fatalf("overview = %#v", overview)
	}
	var memberRow, visitorRow events.Helper
	for _, helper := range overview.Helpers {
		if helper.PersonID != nil && *helper.PersonID == member.PersonID {
			memberRow = helper
		} else {
			visitorRow = helper
		}
		if strings.Contains(helper.Key, "@") {
			t.Fatalf("helper key carries contact data: %s", helper.Key)
		}
	}
	if len(memberRow.Shifts) != 2 || memberRow.Sources[0] != events.SourceAuthenticatedSelf {
		t.Fatalf("member helper = %#v", memberRow)
	}
	if visitorRow.Email == nil || *visitorRow.Email != matchEmail || visitorRow.Sources[0] != events.SourcePublicSignup {
		t.Fatalf("visitor helper = %#v", visitorRow)
	}
	if len(overview.UnlinkedSignups) != 1 || len(overview.UnlinkedSignups[0].Suggestions) != 1 ||
		overview.UnlinkedSignups[0].Suggestions[0].FirstName != "Known" {
		t.Fatalf("unlinked signups = %#v", overview.UnlinkedSignups)
	}

	staffView, err := e.events.Helpers(ctx, staffing, fixture.event.ID)
	if err != nil || len(staffView.UnlinkedSignups) != 1 || len(staffView.UnlinkedSignups[0].Suggestions) != 0 {
		t.Fatalf("staffing overview = %#v, err=%v", staffView, err)
	}
	nameView, err := e.events.Helpers(ctx, names, fixture.event.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, helper := range nameView.Helpers {
		if helper.Email != nil || helper.Phone != nil || helper.DisplayName == nil {
			t.Fatalf("names-only helper = %#v", helper)
		}
	}
	if len(nameView.UnlinkedSignups[0].Suggestions) != 0 {
		t.Fatal("names-only overview carries person suggestions")
	}
}
