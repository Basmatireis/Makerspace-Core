package integration_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/events"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

// eventFixture is an event with one public session and one public open shift with a position.
type eventFixture struct {
	event       events.Event
	shift       events.Shift
	requirement uuid.UUID
}

// newEventFixture creates a draft with an owner, a public session and a public open shift whose single position has
// the given number of places.
func (e *staffingEnv) newEventFixture(name string, start time.Time, places int) eventFixture {
	e.t.Helper()
	ctx := testContext(e.t)
	owner := e.master.PersonID
	event, err := e.events.Create(ctx, e.master, events.EventInput{Name: name, OwnerPersonID: &owner}, nil)
	if err != nil {
		e.t.Fatal(err)
	}
	if _, err = e.events.CreateSession(ctx, e.master, event.ID, events.SessionInput{
		Name: stringPointer(name), StartsAt: start, EndsAt: start.Add(3 * time.Hour), IsPublic: true,
	}, nil); err != nil {
		e.t.Fatal(err)
	}
	shift, err := e.events.CreateShift(ctx, e.master, event.ID, events.ShiftInput{
		Name: "Helpers", StartsAt: start, EndsAt: start.Add(3 * time.Hour), IsPublic: true, Status: "open",
	}, nil)
	if err != nil {
		e.t.Fatal(err)
	}
	requirement, err := addPosition(e.events, ctx, e.master, event.ID, shift.ID, events.RequirementInput{
		Name: "Helper", RequiredCount: places,
	}, nil)
	if err != nil {
		e.t.Fatal(err)
	}
	event, err = e.events.Get(ctx, e.master, event.ID)
	if err != nil {
		e.t.Fatal(err)
	}
	return eventFixture{event: event, shift: shift, requirement: requirement.ID}
}

func (e *staffingEnv) transition(fixture *eventFixture, target events.EventStatus) {
	e.t.Helper()
	event, err := e.events.Transition(testContext(e.t), e.master, fixture.event.ID, fixture.event.Version, target, nil)
	if err != nil {
		e.t.Fatalf("transition to %s: %v", target, err)
	}
	fixture.event = event
}

func expectNotFound(t *testing.T, err error, what string) {
	t.Helper()
	if !errors.Is(err, apperror.NotFound) {
		t.Fatalf("%s error = %v, want not found", what, err)
	}
}

// Drafts are visible to organizers only: events.read alone sees confirmed and closed events, while events.manage,
// events.staffing.manage and events.assign also see drafts — in the list, the detail and every sub-resource.
func TestEventDraftsAreInvisibleToReadersWithoutOrganizerPermissions(t *testing.T) {
	e := newStaffingEnv(t)
	ctx := testContext(t)
	start := e.now.Add(72 * time.Hour).Truncate(time.Minute)
	draft := e.newEventFixture("Draft fair", start, 2)
	confirmed := e.newEventFixture("Confirmed fair", start.Add(24*time.Hour), 2)
	e.transition(&confirmed, events.EventStatusConfirmed)

	reader := e.person("event-reader", e.role("Event readers", nil, authorization.EventsRead).ID)
	signup := e.person("event-signup", e.role("Event signups", nil, authorization.EventsRead, authorization.EventsSignup).ID)
	nobody := e.person("event-nobody")
	organizers := map[string]authorization.Principal{
		"manage":   e.person("event-manager", e.role("Event managers", nil, authorization.EventsManage).ID),
		"staffing": e.person("event-staffing", e.role("Event staffing", nil, authorization.EventsStaffingManage).ID),
		"assign":   e.person("event-assign", e.role("Event assigners", nil, authorization.EventsAssign).ID),
	}

	for name, principal := range map[string]authorization.Principal{"read": reader, "read+signup": signup} {
		drafts, err := e.events.List(ctx, principal, events.ListQuery{Scope: events.ListScopeDrafts})
		if err != nil || drafts.Total != 0 || len(drafts.Items) != 0 {
			t.Fatalf("%s draft list = %#v, err=%v", name, drafts, err)
		}
		upcoming, err := e.events.List(ctx, principal, events.ListQuery{})
		if err != nil || upcoming.Total != 1 || upcoming.Items[0].ID != confirmed.event.ID {
			t.Fatalf("%s upcoming list = %#v, err=%v", name, upcoming, err)
		}
		_, err = e.events.Get(ctx, principal, draft.event.ID)
		expectNotFound(t, err, name+" get draft")
		_, err = e.events.ListSessions(ctx, principal, draft.event.ID)
		expectNotFound(t, err, name+" draft sessions")
		_, err = e.events.ListShifts(ctx, principal, draft.event.ID)
		expectNotFound(t, err, name+" draft shifts")
		_, err = e.events.ListTasks(ctx, principal, draft.event.ID, events.TaskFilter{IncludeDone: true})
		expectNotFound(t, err, name+" draft tasks")
		_, err = e.events.ListTaskLists(ctx, principal, draft.event.ID)
		expectNotFound(t, err, name+" draft task lists")
		_, err = e.events.ListFiles(ctx, principal, draft.event.ID)
		expectNotFound(t, err, name+" draft files")
		if _, err = e.events.Get(ctx, principal, confirmed.event.ID); err != nil {
			t.Fatalf("%s get confirmed: %v", name, err)
		}
		if _, err = e.events.ListShifts(ctx, principal, confirmed.event.ID); err != nil {
			t.Fatalf("%s confirmed shifts: %v", name, err)
		}
	}
	for name, principal := range organizers {
		got, err := e.events.Get(ctx, principal, draft.event.ID)
		if err != nil || got.Status != events.EventStatusDraft {
			t.Fatalf("%s get draft = %#v, err=%v", name, got, err)
		}
		if _, err = e.events.ListShifts(ctx, principal, draft.event.ID); err != nil {
			t.Fatalf("%s draft shifts: %v", name, err)
		}
		drafts, err := e.events.List(ctx, principal, events.ListQuery{Scope: events.ListScopeDrafts})
		if err != nil || drafts.Total != 1 || drafts.Items[0].ID != draft.event.ID {
			t.Fatalf("%s draft list = %#v, err=%v", name, drafts, err)
		}
	}
	if _, err := e.events.Get(ctx, nobody, confirmed.event.ID); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("no permission get error = %v", err)
	}
}

// The lifecycle has four statuses: confirm needs an owner and a programme, closed events are final and read-only
// except tasks and files, only drafts without assignment history can be deleted, and publishing needs draft or
// confirmed with owner, public title and public content.
func TestEventLifecycleRulesAndReadiness(t *testing.T) {
	e := newStaffingEnv(t)
	ctx := testContext(t)
	start := e.now.Add(96 * time.Hour).Truncate(time.Minute)

	bare, err := e.events.Create(ctx, e.master, events.EventInput{Name: "Bare"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := bare.GoLive.ConfirmUnmet; len(got) != 2 || got[0] != events.ReadinessOwnerMissing ||
		got[1] != events.ReadinessProgrammeMissing {
		t.Fatalf("bare confirm readiness = %v", got)
	}
	if _, err = e.events.Transition(ctx, e.master, bare.ID, bare.Version, events.EventStatusConfirmed, nil); err == nil {
		t.Fatal("confirmed an event without owner and programme")
	}
	if _, err = e.events.Transition(ctx, e.master, bare.ID, bare.Version, events.EventStatusCompleted, nil); !apperror.IsCode(
		err,
		"invalid_event_transition",
	) {
		t.Fatalf("draft to completed error = %v", err)
	}
	cancelled, err := e.events.Transition(ctx, e.master, bare.ID, bare.Version, events.EventStatusCancelled, nil)
	if err != nil || cancelled.ClosedAt == nil {
		t.Fatalf("cancel draft = %#v, err=%v", cancelled, err)
	}
	if _, err = e.events.Transition(ctx, e.master, bare.ID, cancelled.Version, events.EventStatusDraft, nil); !apperror.IsCode(
		err,
		"invalid_event_transition",
	) {
		t.Fatalf("reopen cancelled error = %v", err)
	}
	if _, err = e.events.Delete(ctx, e.master, bare.ID, cancelled.Version, nil); !apperror.IsCode(err, "event_not_deletable") {
		t.Fatalf("delete cancelled error = %v", err)
	}

	fixture := e.newEventFixture("Repair café", start, 1)
	if fixture.event.GoLive.PublicPageState != events.PublicPageOff || len(fixture.event.GoLive.ConfirmUnmet) != 0 {
		t.Fatalf("fixture readiness = %#v", fixture.event.GoLive)
	}
	if !containsCode(fixture.event.GoLive.PublicPageUnmet, events.ReadinessPublicTitleMissing) {
		t.Fatalf("public page readiness = %v", fixture.event.GoLive.PublicPageUnmet)
	}
	// Publishing works for a draft once owner, public title and public content exist.
	title := "Repair café"
	owner := e.master.PersonID
	updated, err := e.events.Update(ctx, e.master, fixture.event.ID, events.EventInput{
		Name: fixture.event.Name, OwnerPersonID: &owner, PublicTitle: &title, PublicSignupEnabled: true,
		ExpectedVersion: fixture.event.Version,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	published, err := e.events.SetPublished(ctx, e.master, fixture.event.ID, updated.Version, true, nil)
	if err != nil || published.GoLive.PublicPageState != events.PublicPageLive {
		t.Fatalf("publish draft = %#v, err=%v", published.GoLive, err)
	}
	// E6: a published draft with public signup switched on still takes no signups.
	if published.GoLive.HelperSignupState != events.HelperSignupClosed ||
		!containsCode(published.GoLive.HelperSignupUnmet, events.ReadinessEventNotConfirmed) {
		t.Fatalf("draft signup readiness = %#v", published.GoLive)
	}
	public, err := e.events.GetPublic(ctx, published.PublicID)
	if err != nil || public.PublicSignupEnabled || public.Shifts[0].Requirements[0].Availability != events.AvailabilityNotOpen {
		t.Fatalf("public draft = %#v, err=%v", public, err)
	}
	signup := events.AssignmentInput{
		ShiftID: fixture.shift.ID, RequirementID: fixture.requirement, FirstName: "Ada", LastName: "Visitor",
		Email: stringPointer("ada.visitor@example.test"),
	}
	if _, err = e.events.SignupAnonymous(ctx, published.PublicID, "192.0.2.60", signup, nil); !apperror.IsCode(
		err,
		"signup_unavailable",
	) {
		t.Fatalf("draft public signup error = %v", err)
	}
	fixture.event = published
	e.transition(&fixture, events.EventStatusConfirmed)
	if fixture.event.GoLive.HelperSignupState != events.HelperSignupOpen || fixture.event.GoLive.ShiftsAccepting != 1 ||
		fixture.event.GoLive.ShiftsTotal != 1 {
		t.Fatalf("confirmed signup readiness = %#v", fixture.event.GoLive)
	}
	if _, err = e.events.SignupAnonymous(ctx, published.PublicID, "192.0.2.61", signup, nil); err != nil {
		t.Fatalf("confirmed public signup: %v", err)
	}
	fixture.event, err = e.events.Get(ctx, e.master, fixture.event.ID)
	if err != nil {
		t.Fatal(err)
	}
	if fixture.event.FilledCount != 1 || fixture.event.RequiredCount != 1 || !fixture.event.HasAssignmentHistory ||
		fixture.event.GoLive.ShiftsAccepting != 0 {
		t.Fatalf("staffed event = %#v", fixture.event)
	}
	// Back to draft is allowed; a draft with assignment history cannot be deleted.
	e.transition(&fixture, events.EventStatusDraft)
	if _, err = e.events.Delete(ctx, e.master, fixture.event.ID, fixture.event.Version, nil); !apperror.IsCode(
		err,
		"event_has_assignment_history",
	) {
		t.Fatalf("delete draft with history error = %v", err)
	}
	e.transition(&fixture, events.EventStatusConfirmed)
	e.transition(&fixture, events.EventStatusCompleted)
	if fixture.event.ClosedAt == nil || fixture.event.GoLive.HelperSignupState != events.HelperSignupClosed {
		t.Fatalf("completed event = %#v", fixture.event)
	}
	// Completed events stay public (E4) and are read-only except tasks and files.
	if _, err = e.events.GetPublic(ctx, fixture.event.PublicID); err != nil {
		t.Fatalf("completed public page: %v", err)
	}
	if _, err = e.events.CreateSession(ctx, e.master, fixture.event.ID, events.SessionInput{
		StartsAt: start, EndsAt: start.Add(time.Hour),
	}, nil); !apperror.IsCode(err, "event_read_only") {
		t.Fatalf("session on completed event error = %v", err)
	}
	if _, err = e.events.Update(ctx, e.master, fixture.event.ID, events.EventInput{
		Name: "Renamed", ExpectedVersion: fixture.event.Version,
	}, nil); !apperror.IsCode(err, "event_read_only") {
		t.Fatalf("update completed event error = %v", err)
	}
	task, err := e.events.CreateTask(ctx, e.master, fixture.event.ID, events.TaskInput{
		Title: "Thank the helpers", Important: true,
	}, nil)
	if err != nil || task.Status != events.TaskStatusOpen || !task.Important {
		t.Fatalf("post-event task = %#v, err=%v", task, err)
	}

	// A fresh draft without history can be deleted.
	deletable, err := e.events.Create(ctx, e.master, events.EventInput{Name: "Scrapped"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = e.events.Delete(ctx, e.master, deletable.ID, deletable.Version, nil); err != nil {
		t.Fatalf("delete draft: %v", err)
	}
}

// Tasks are open or done with an Important flag; the list filters by assignee, overdue and done.
func TestEventTasksOpenDoneImportantAndFilters(t *testing.T) {
	e := newStaffingEnv(t)
	ctx := testContext(t)
	fixture := e.newEventFixture("Summer party", e.now.Add(240*time.Hour).Truncate(time.Minute), 3)
	other := e.person("task-assignee")
	mine := e.master.PersonID
	past := e.now.Add(-2 * time.Hour)
	future := e.now.Add(48 * time.Hour)
	create := func(title string, assignee *uuid.UUID, due *time.Time, status events.TaskStatus) events.Task {
		t.Helper()
		task, err := e.events.CreateTask(ctx, e.master, fixture.event.ID, events.TaskInput{
			Title: title, AssigneePersonID: assignee, DueAt: due, Status: status,
		}, nil)
		if err != nil {
			t.Fatal(err)
		}
		return task
	}
	overdueMine := create("Order drinks", &mine, &past, events.TaskStatusOpen)
	create("Book DJ", &other.PersonID, &past, events.TaskStatusOpen)
	create("Posters", &mine, &future, events.TaskStatusOpen)
	doneTask := create("Budget", &mine, &past, events.TaskStatusDone)
	if doneTask.CompletedAt == nil || doneTask.CompletedByAccount == nil {
		t.Fatalf("done task = %#v", doneTask)
	}
	if _, err := e.events.CreateTask(ctx, e.master, fixture.event.ID, events.TaskInput{
		Title: "Invalid", Status: "blocked",
	}, nil); err == nil {
		t.Fatal("accepted the removed blocked status")
	}

	count := func(filter events.TaskFilter) int {
		t.Helper()
		tasks, err := e.events.ListTasks(ctx, e.master, fixture.event.ID, filter)
		if err != nil {
			t.Fatal(err)
		}
		return len(tasks)
	}
	if got := count(events.TaskFilter{IncludeDone: true}); got != 4 {
		t.Fatalf("all tasks = %d", got)
	}
	if got := count(events.TaskFilter{}); got != 3 {
		t.Fatalf("open tasks = %d", got)
	}
	if got := count(events.TaskFilter{Mine: true, IncludeDone: true}); got != 3 {
		t.Fatalf("my tasks = %d", got)
	}
	if got := count(events.TaskFilter{Overdue: true, IncludeDone: true}); got != 2 {
		t.Fatalf("overdue tasks = %d", got)
	}
	if got := count(events.TaskFilter{Mine: true, Overdue: true}); got != 1 {
		t.Fatalf("my overdue tasks = %d", got)
	}
	event, err := e.events.Get(ctx, e.master, fixture.event.ID)
	if err != nil || event.TaskTotal != 4 || event.TaskCompleted != 1 || event.TasksOverdue != 2 {
		t.Fatalf("task summary = total %d done %d overdue %d, err=%v", event.TaskTotal, event.TaskCompleted,
			event.TasksOverdue, err)
	}
	reopened, err := e.events.UpdateTask(ctx, e.master, fixture.event.ID, doneTask.ID, events.TaskInput{
		Title: doneTask.Title, Status: events.TaskStatusOpen, Important: true, ExpectedVersion: doneTask.Version,
	}, nil)
	if err != nil || reopened.CompletedAt != nil || !reopened.Important {
		t.Fatalf("reopened task = %#v, err=%v", reopened, err)
	}
	_ = overdueMine
}

func containsCode(values []events.ReadinessCode, want events.ReadinessCode) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

// addPosition appends a position to a shift through the shift save and returns the saved position.
func addPosition(
	service *events.Service,
	ctx context.Context,
	principal authorization.Principal,
	eventID, shiftID uuid.UUID,
	input events.RequirementInput,
	requestID *uuid.UUID,
) (events.Requirement, error) {
	shifts, err := service.ListShifts(ctx, principal, eventID)
	if err != nil {
		return events.Requirement{}, err
	}
	for _, shift := range shifts {
		if shift.ID != shiftID {
			continue
		}
		positions := make([]events.RequirementInput, 0, len(shift.Requirements)+1)
		for _, existing := range shift.Requirements {
			id := existing.ID
			positions = append(positions, events.RequirementInput{
				ID: &id, Name: existing.Name, Description: existing.Description, RequiredCount: existing.RequiredCount,
				EligibilityMode: existing.EligibilityMode, EligibleRoleIDs: existing.EligibleRoleIDs,
			})
		}
		saved, err := service.UpdateShift(ctx, principal, eventID, shiftID, events.ShiftInput{
			SessionID: shift.SessionID, Name: shift.Name, Description: shift.Description, StartsAt: shift.StartsAt,
			EndsAt: shift.EndsAt, SignupOpensAt: shift.SignupOpensAt, SignupClosesAt: shift.SignupClosesAt,
			IsPublic: shift.IsPublic, Status: shift.Status, Requirements: append(positions, input),
			ExpectedVersion: shift.Version,
		}, requestID)
		if err != nil {
			return events.Requirement{}, err
		}
		for _, requirement := range saved.Requirements {
			if strings.EqualFold(requirement.Name, input.Name) {
				return requirement, nil
			}
		}
	}
	return events.Requirement{}, apperror.NotFound
}
