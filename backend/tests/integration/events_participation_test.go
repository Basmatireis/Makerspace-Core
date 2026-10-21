package integration_test

import (
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/events"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

func findPosition(t *testing.T, view events.Participation, requirement uuid.UUID) events.ParticipationPosition {
	t.Helper()
	for _, shift := range view.Shifts {
		for _, position := range shift.Positions {
			if position.ID == requirement {
				return position
			}
		}
	}
	t.Fatalf("position %s is not in the participant view", requirement)
	return events.ParticipationPosition{}
}

// Members join and leave positions themselves with events.signup only, in confirmed events only (E6), with the
// capacity, duplicate, role and overlap rules and without any override; their leave is limited to their own active
// assignments of open events.
func TestEventMembersJoinAndLeaveTheirOwnPlaces(t *testing.T) {
	e := newStaffingEnv(t)
	ctx := testContext(t)
	start := e.now.Add(120 * time.Hour).Truncate(time.Minute)
	fixture := e.newEventFixture("Repair café", start, 2)

	helperRole := e.role("Helpers", nil, authorization.EventsRead, authorization.EventsSignup)
	reader := e.person("reader", e.role("Readers", nil, authorization.EventsRead).ID)
	member := e.person("member", helperRole.ID)
	other := e.person("other", helperRole.ID)
	organizer := e.person("organizer", e.role("Organizers", nil, authorization.EventsManage, authorization.EventsSignup).ID)

	// E6: drafts take no joins; helpers cannot even see them, organizers get a reason.
	_, err := e.events.Join(ctx, member, fixture.event.ID, fixture.shift.ID, fixture.requirement, nil)
	expectNotFound(t, err, "join draft as member")
	_, err = e.events.Join(ctx, organizer, fixture.event.ID, fixture.shift.ID, fixture.requirement, nil)
	expectAppCode(t, err, "signup_not_open")
	organizerView, err := e.events.Participation(ctx, organizer, fixture.event.ID)
	if err != nil || findPosition(t, organizerView, fixture.requirement).Reason != events.JoinReasonNotOpen {
		t.Fatalf("draft participation = %#v, err=%v", organizerView, err)
	}
	e.transition(&fixture, events.EventStatusConfirmed)

	if _, err = e.events.Join(ctx, reader, fixture.event.ID, fixture.shift.ID, fixture.requirement, nil); !errors.Is(
		err,
		apperror.PermissionDenied,
	) {
		t.Fatalf("join without events.signup error = %v", err)
	}
	readerView, err := e.events.Participation(ctx, reader, fixture.event.ID)
	if err != nil || readerView.CanSignup || findPosition(t, readerView, fixture.requirement).Reason !=
		events.JoinReasonNoPermission {
		t.Fatalf("reader participation = %#v, err=%v", readerView, err)
	}

	joined, err := e.events.Join(ctx, member, fixture.event.ID, fixture.shift.ID, fixture.requirement, nil)
	if err != nil || joined.LeaveBlocked != "" || joined.RequirementName != "Helper" {
		t.Fatalf("join = %#v, err=%v", joined, err)
	}
	var source string
	var personID *uuid.UUID
	if err = e.pool.QueryRow(ctx, `SELECT source, person_id FROM event_shift_assignments WHERE id=$1`, joined.AssignmentID).
		Scan(&source, &personID); err != nil {
		t.Fatal(err)
	}
	if source != "authenticated_self" || personID == nil || *personID != member.PersonID {
		t.Fatalf("joined assignment source=%s person=%v", source, personID)
	}
	assertCount(t, e.pool, `SELECT count(*) FROM audit_events WHERE action='event_assignment.joined' AND resource_id=$1`,
		1, joined.AssignmentID)
	_, err = e.events.Join(ctx, member, fixture.event.ID, fixture.shift.ID, fixture.requirement, nil)
	expectAppCode(t, err, "already_assigned")
	view, err := e.events.Participation(ctx, member, fixture.event.ID)
	if err != nil {
		t.Fatal(err)
	}
	position := findPosition(t, view, fixture.requirement)
	if len(view.MyAssignments) != 1 || position.MyAssignmentID == nil || *position.MyAssignmentID != joined.AssignmentID ||
		position.Reason != events.JoinReasonAlreadyJoined || position.FilledCount != 1 || position.Helpers != nil {
		t.Fatalf("member participation = %#v / %#v", view.MyAssignments, position)
	}
	listed, err := e.events.List(ctx, member, events.ListQuery{})
	if err != nil || listed.Total != 1 || len(listed.Items[0].MyShifts) != 1 || listed.Items[0].OpenPlaces != 1 {
		t.Fatalf("member list = %#v, err=%v", listed, err)
	}

	// Leave: only one's own assignment, with the current version.
	err = e.events.Leave(ctx, other, fixture.event.ID, joined.AssignmentID, joined.Version, nil)
	expectNotFound(t, err, "leave someone else's assignment")
	if err = e.events.Leave(ctx, reader, fixture.event.ID, joined.AssignmentID, joined.Version, nil); !errors.Is(
		err,
		apperror.PermissionDenied,
	) {
		t.Fatalf("leave without events.signup error = %v", err)
	}
	if err = e.events.Leave(ctx, member, fixture.event.ID, joined.AssignmentID, joined.Version, nil); err != nil {
		t.Fatalf("leave: %v", err)
	}
	if err = e.events.Leave(ctx, member, fixture.event.ID, joined.AssignmentID, joined.Version+1, nil); !errors.Is(
		err,
		apperror.Conflict,
	) {
		t.Fatalf("leave twice error = %v", err)
	}
	assertCount(t, e.pool, `SELECT count(*) FROM audit_events WHERE action='event_assignment.left' AND resource_id=$1`,
		1, joined.AssignmentID)

	// Rejoin, then close the event: leaving is no longer possible.
	rejoined, err := e.events.Join(ctx, member, fixture.event.ID, fixture.shift.ID, fixture.requirement, nil)
	if err != nil {
		t.Fatalf("rejoin: %v", err)
	}
	e.transition(&fixture, events.EventStatusCompleted)
	err = e.events.Leave(ctx, member, fixture.event.ID, rejoined.AssignmentID, rejoined.Version, nil)
	expectAppCode(t, err, "event_read_only")
	_, err = e.events.Join(ctx, other, fixture.event.ID, fixture.shift.ID, fixture.requirement, nil)
	expectAppCode(t, err, "signup_closed")
	past, err := e.events.List(ctx, member, events.ListQuery{Scope: events.ListScopePast})
	if err != nil || past.Total != 1 {
		t.Fatalf("member past list = %#v, err=%v", past, err)
	}
	if past, err = e.events.List(ctx, other, events.ListQuery{Scope: events.ListScopePast}); err != nil || past.Total != 0 {
		t.Fatalf("non-helper past list = %#v, err=%v", past, err)
	}
	if past, err = e.events.List(ctx, organizer, events.ListQuery{Scope: events.ListScopePast}); err != nil ||
		past.Total != 1 {
		t.Fatalf("organizer past list = %#v, err=%v", past, err)
	}
}

// Roles, signup windows and overlaps: role-restricted positions say who may fill them, windows report when they
// open, and overlapping assignments block a join; only events.assign may override an overlap, and only as staff.
func TestEventJoinRulesRolesWindowsAndConflicts(t *testing.T) {
	e := newStaffingEnv(t)
	ctx := testContext(t)
	start := e.now.Add(150 * time.Hour).Truncate(time.Minute)
	first := e.newEventFixture("Open lab night", start, 3)
	second := e.newEventFixture("Laser workshop", start.Add(time.Hour), 3)
	e.transition(&first, events.EventStatusConfirmed)
	e.transition(&second, events.EventStatusConfirmed)

	laser := e.role("Laser instructors", nil, authorization.EventsRead, authorization.EventsSignup)
	helpers := e.role("Event helpers", nil, authorization.EventsRead, authorization.EventsSignup)
	instructor := e.person("instructor", laser.ID)
	helper := e.person("helper", helpers.ID)

	restricted, err := e.events.CreateRequirement(ctx, e.master, second.event.ID, second.shift.ID, events.RequirementInput{
		Name: "Instructor", RequiredCount: 1, EligibilityMode: events.EligibilityRoles,
		EligibleRoleIDs: []uuid.UUID{laser.ID},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	view, err := e.events.Participation(ctx, helper, second.event.ID)
	if err != nil {
		t.Fatal(err)
	}
	position := findPosition(t, view, restricted.ID)
	if position.Reason != events.JoinReasonRolesOnly || len(position.RoleNames) != 1 ||
		position.RoleNames[0] != "Laser instructors" {
		t.Fatalf("restricted position for helper = %#v", position)
	}
	_, err = e.events.Join(ctx, helper, second.event.ID, second.shift.ID, restricted.ID, nil)
	expectAppCode(t, err, "person_not_eligible")
	if view, err = e.events.Participation(ctx, instructor, second.event.ID); err != nil ||
		!findPosition(t, view, restricted.ID).Joinable {
		t.Fatalf("restricted position for instructor = %#v, err=%v", view, err)
	}

	// Overlap with a shift of another event blocks the join; members never override.
	if _, err = e.events.Join(ctx, helper, first.event.ID, first.shift.ID, first.requirement, nil); err != nil {
		t.Fatal(err)
	}
	_, err = e.events.Join(ctx, helper, second.event.ID, second.shift.ID, second.requirement, nil)
	expectAppCode(t, err, "assignment_conflict")
	staffing := e.person("staffing", e.role("Staffing", nil, authorization.EventsStaffingManage).ID)
	assigner := e.person("assigner", e.role("Assigners", nil, authorization.EventsAssign).ID)
	override := events.AssignmentInput{
		ShiftID: second.shift.ID, RequirementID: second.requirement, PersonID: &helper.PersonID, OverrideConflict: true,
	}
	if _, err = e.events.CreateStaffAssignment(ctx, staffing, second.event.ID, override, nil); !errors.Is(
		err,
		apperror.PermissionDenied,
	) {
		t.Fatalf("override without events.assign error = %v", err)
	}
	overridden, err := e.events.CreateStaffAssignment(ctx, assigner, second.event.ID, override, nil)
	if err != nil || overridden.ConflictOverriddenByAccountID == nil {
		t.Fatalf("override = %#v, err=%v", overridden, err)
	}
	assertCount(t, e.pool, `SELECT count(*) FROM audit_events WHERE action='event_assignment.conflict_overridden'
		AND resource_id=$1`, 1, overridden.ID)

	// A signup window that has not started reports when it opens.
	opens := e.now.Add(24 * time.Hour).Truncate(time.Minute)
	window, err := e.events.CreateShift(ctx, e.master, first.event.ID, events.ShiftInput{
		Name: "Later", StartsAt: start.Add(48 * time.Hour), EndsAt: start.Add(50 * time.Hour), Status: "open",
		SignupOpensAt: &opens,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	later, err := e.events.CreateRequirement(ctx, e.master, first.event.ID, window.ID, events.RequirementInput{
		Name: "Helper", RequiredCount: 1,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if view, err = e.events.Participation(ctx, instructor, first.event.ID); err != nil {
		t.Fatal(err)
	}
	if position = findPosition(t, view, later.ID); position.Reason != events.JoinReasonOpensAt ||
		position.OpensAt == nil || !position.OpensAt.Equal(opens) {
		t.Fatalf("windowed position = %#v", position)
	}
	_, err = e.events.Join(ctx, instructor, first.event.ID, window.ID, later.ID, nil)
	expectAppCode(t, err, "signup_not_open")
}

// Helper names are visible with events.read_assignments, events.staffing.manage or events.assign; contact details
// stay with the staffing permissions.
func TestEventHelperNamesNeedReadAssignments(t *testing.T) {
	e := newStaffingEnv(t)
	ctx := testContext(t)
	fixture := e.newEventFixture("Maker fair", e.now.Add(200*time.Hour).Truncate(time.Minute), 3)
	e.transition(&fixture, events.EventStatusConfirmed)
	member := e.person("named", e.role("Members", nil, authorization.EventsRead, authorization.EventsSignup).ID)
	if _, err := e.events.Join(ctx, member, fixture.event.ID, fixture.shift.ID, fixture.requirement, nil); err != nil {
		t.Fatal(err)
	}
	cases := map[string]struct {
		principal authorization.Principal
		names     bool
		contacts  bool
	}{
		"read":              {e.person("plain", e.role("Plain", nil, authorization.EventsRead).ID), false, false},
		"read_assignments":  {e.person("names", e.role("Names", nil, authorization.EventsRead, authorization.EventsReadAssignments).ID), true, false},
		"staffing.manage":   {e.person("staff", e.role("Staff", nil, authorization.EventsStaffingManage).ID), true, true},
		"assign":            {e.person("assign", e.role("Assign", nil, authorization.EventsAssign).ID), true, true},
		"member (self, no)": {member, false, false},
	}
	for name, tc := range cases {
		view, err := e.events.Participation(ctx, tc.principal, fixture.event.ID)
		if err != nil {
			t.Fatalf("%s participation: %v", name, err)
		}
		position := findPosition(t, view, fixture.requirement)
		if (position.Helpers != nil) != tc.names || view.CanSeeNames != tc.names || position.FilledCount != 1 {
			t.Fatalf("%s helpers = %#v", name, position)
		}
		if tc.names && (len(position.Helpers) != 1 || position.Helpers[0].DisplayName == nil ||
			*position.Helpers[0].DisplayName != "Test Person") {
			t.Fatalf("%s helper names = %#v", name, position.Helpers)
		}
		_, err = e.events.ListAssignments(ctx, tc.principal, fixture.event.ID)
		if tc.contacts != (err == nil) {
			t.Fatalf("%s contact list error = %v", name, err)
		}
	}
}

// Two members racing for the last place: exactly one gets it.
func TestEventJoinCapacityHoldsUnderConcurrency(t *testing.T) {
	e := newStaffingEnv(t)
	ctx := testContext(t)
	fixture := e.newEventFixture("Workshop", e.now.Add(100*time.Hour).Truncate(time.Minute), 1)
	e.transition(&fixture, events.EventStatusConfirmed)
	role := e.role("Racers", nil, authorization.EventsRead, authorization.EventsSignup)
	members := []authorization.Principal{e.person("racer", role.ID), e.person("racer", role.ID)}
	var wait sync.WaitGroup
	results := make(chan error, len(members))
	for _, member := range members {
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, err := e.events.Join(ctx, member, fixture.event.ID, fixture.shift.ID, fixture.requirement, nil)
			results <- err
		}()
	}
	wait.Wait()
	close(results)
	joined, full := 0, 0
	for err := range results {
		switch {
		case err == nil:
			joined++
		case apperror.IsCode(err, "requirement_full"):
			full++
		default:
			t.Fatalf("concurrent join error = %v", err)
		}
	}
	if joined != 1 || full != 1 {
		t.Fatalf("concurrent joins joined=%d full=%d", joined, full)
	}
	assertCount(t, e.pool, `SELECT count(*) FROM event_shift_assignments WHERE requirement_id=$1 AND status='active'`,
		1, fixture.requirement)
}
