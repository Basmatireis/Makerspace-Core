package integration_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/people"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	requestsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/subjectrequests/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/workinggroups"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// taskFixture is one group with a lead, a member and a machine, plus a manager and an outsider who may only read.
type taskFixture struct {
	pool                            *pgxpool.Pool
	service                         *workinggroups.Service
	group                           workinggroups.Group
	machine                         uuid.UUID
	manager, lead, member, outsider authorization.Principal
	leadID, memberID, outsiderID    uuid.UUID
	columnTodo, columnProgress      uuid.UUID
}

func newTaskFixture(t *testing.T, pool *pgxpool.Pool, tag string) taskFixture {
	t.Helper()
	ctx := testContext(t)
	f := taskFixture{pool: pool, service: workinggroups.NewService(pool)}
	var seeded seededAccount
	f.manager, _ = groupPrincipal(t, pool, tag+"-manager", "working_groups.read", "working_groups.manage")
	f.lead, seeded = groupPrincipal(t, pool, tag+"-lead", "working_groups.read")
	f.leadID = seeded.personID
	f.member, seeded = groupPrincipal(t, pool, tag+"-member", "working_groups.read")
	f.memberID = seeded.personID
	f.outsider, seeded = groupPrincipal(t, pool, tag+"-outsider", "working_groups.read")
	f.outsiderID = seeded.personID

	group, err := f.service.Create(ctx, f.manager, workinggroups.CreateInput{Name: "Laser " + tag, LeadPersonID: f.leadID}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.AddMember(ctx, f.manager, group.ID, f.memberID, nil); err != nil {
		t.Fatal(err)
	}
	f.machine = insertWorkingGroupMachine(t, pool, "Cutter "+tag)
	if _, err := f.service.SetMachines(ctx, f.manager, group.ID, []uuid.UUID{f.machine}, nil); err != nil {
		t.Fatal(err)
	}
	f.group, err = f.service.Get(ctx, f.manager, group.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(f.group.Columns) != 2 || f.group.Columns[0].Name != "To do" || f.group.Columns[1].Name != "In progress" {
		t.Fatalf("default columns = %+v", f.group.Columns)
	}
	f.columnTodo, f.columnProgress = f.group.Columns[0].ID, f.group.Columns[1].ID
	return f
}

func (f taskFixture) newTicket(t *testing.T, p authorization.Principal, subject string) workinggroups.TicketDetail {
	t.Helper()
	machine := f.machine
	detail, err := f.service.CreateTicket(testContext(t), p, workinggroups.CreateTicketInput{
		GroupID: f.group.ID, MachineID: &machine, Kind: workinggroups.KindProblem, Subject: subject,
		Body: "The lens is dirty", BlocksUse: true,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	return detail
}

func day(year int, month time.Month, d int) time.Time {
	return time.Date(year, month, d, 0, 0, 0, 0, time.UTC)
}

func TestWorkingGroupTasksRequireReadPermissionEverywhere(t *testing.T) {
	pool := statementPool(t)
	ctx := testContext(t)
	service := workinggroups.NewService(pool)
	manageOnly, _ := groupPrincipal(t, pool, "wgt-manage-only", "working_groups.manage")
	nobody, _ := groupPrincipal(t, pool, "wgt-nobody", "machines.read")
	group, id := ids.New(), ids.New()
	due := day(2027, 1, 1)

	for name, p := range map[string]authorization.Principal{"manage only": manageOnly, "nobody": nobody} {
		check := func(operation string, err error) {
			t.Helper()
			requireAppError(t, err, http.StatusForbidden, "permission_denied")
			_ = operation
			_ = name
		}
		_, err := service.ListTickets(ctx, p, workinggroups.TicketFilter{})
		check("list tickets", err)
		_, err = service.GetTicket(ctx, p, id)
		check("get ticket", err)
		_, err = service.CreateTicket(ctx, p, workinggroups.CreateTicketInput{GroupID: group, Kind: workinggroups.KindProblem, Subject: "x"}, nil)
		check("create ticket", err)
		_, err = service.PlanTicket(ctx, p, id, workinggroups.PlanTicketInput{ColumnID: id}, nil)
		check("plan", err)
		_, err = service.UpdateTicket(ctx, p, id, workinggroups.UpdateTicketInput{ExpectedVersion: 1}, nil)
		check("update ticket", err)
		_, err = service.CloseTicket(ctx, p, id, workinggroups.CloseTicketInput{Outcome: workinggroups.StatusDone}, nil)
		check("close", err)
		_, err = service.ReopenTicket(ctx, p, id, nil)
		check("reopen", err)
		_, err = service.FollowTicket(ctx, p, id, nil)
		check("follow", err)
		_, err = service.UnfollowTicket(ctx, p, id, nil)
		check("unfollow", err)
		_, err = service.AddTicketComment(ctx, p, id, workinggroups.CommentInput{Text: "x"}, nil)
		check("ticket comment", err)
		_, err = service.ListTodos(ctx, p, nil)
		check("list todos", err)
		_, err = service.GetTodo(ctx, p, id)
		check("get todo", err)
		_, err = service.CreateTodo(ctx, p, workinggroups.CreateTodoInput{GroupID: group, Title: "x", DueOn: due}, nil)
		check("create todo", err)
		_, err = service.UpdateTodo(ctx, p, id, workinggroups.UpdateTodoInput{ExpectedVersion: 1}, nil)
		check("update todo", err)
		check("delete todo", service.DeleteTodo(ctx, p, id, nil))
		_, err = service.MarkTodoDone(ctx, p, id, nil)
		check("todo done", err)
		_, err = service.ReopenTodo(ctx, p, id, nil)
		check("todo reopen", err)
		_, err = service.AddTodoComment(ctx, p, id, workinggroups.CommentInput{Text: "x"}, nil)
		check("todo comment", err)
		_, err = service.SetColumns(ctx, p, group, []workinggroups.ColumnInput{{Name: "x"}}, nil)
		check("set columns", err)
	}
	assertCount(t, pool, `SELECT count(*) FROM working_group_tickets`, 0)
}

func TestWorkingGroupTicketsOutsidersWriteReadAndFollowButNeverWorkOnThem(t *testing.T) {
	pool := statementPool(t)
	ctx := testContext(t)
	f := newTaskFixture(t, pool, "wgt-outside")

	// An outsider writes a ticket for the group's machine and sees it.
	ticket := f.newTicket(t, f.outsider, "Lens is dirty")
	if ticket.Ticket.Status != workinggroups.StatusNew || ticket.Ticket.Author == nil || ticket.Ticket.Author.ID != f.outsiderID ||
		ticket.Ticket.Inside || !ticket.Ticket.IsMine || ticket.Ticket.MachineName == nil || !ticket.Ticket.BlocksUse {
		t.Fatalf("ticket = %+v", ticket.Ticket)
	}

	// Every reader sees every ticket of every group; the member is inside.
	listed, err := f.service.ListTickets(ctx, f.member, workinggroups.TicketFilter{})
	if err != nil || len(listed) != 1 || !listed[0].Inside || listed[0].IsMine {
		t.Fatalf("member list = %+v, %v", listed, err)
	}
	other, _ := groupPrincipal(t, pool, "wgt-outside-other", "working_groups.read")
	listed, err = f.service.ListTickets(ctx, other, workinggroups.TicketFilter{})
	if err != nil || len(listed) != 1 || listed[0].Inside {
		t.Fatalf("other outsider list = %+v, %v", listed, err)
	}

	// The machine must belong to the group; an unknown group is 404; a bad kind is 422 only after the group exists.
	foreign := insertWorkingGroupMachine(t, pool, "Foreign machine")
	_, err = f.service.CreateTicket(ctx, f.outsider, workinggroups.CreateTicketInput{
		GroupID: f.group.ID, MachineID: &foreign, Kind: workinggroups.KindRequest, Subject: "x",
	}, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "machine_not_in_working_group")
	_, err = f.service.CreateTicket(ctx, f.outsider, workinggroups.CreateTicketInput{GroupID: ids.New(), Kind: workinggroups.KindRequest, Subject: "x"}, nil)
	requireAppError(t, err, http.StatusNotFound, "")
	_, err = f.service.CreateTicket(ctx, f.outsider, workinggroups.CreateTicketInput{GroupID: f.group.ID, Kind: "wish", Subject: "x"}, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "")
	_, err = f.service.CreateTicket(ctx, f.outsider, workinggroups.CreateTicketInput{GroupID: f.group.ID, Kind: workinggroups.KindQuestion, Subject: "  "}, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "")

	// Following and public comments are open to outsiders.
	followed, err := f.service.FollowTicket(ctx, other, ticket.Ticket.ID, nil)
	if err != nil || followed.Ticket.FollowerCount != 1 || !followed.Ticket.IsFollowing || len(followed.Followers) != 1 {
		t.Fatalf("follow = %+v, %v", followed, err)
	}
	commented, err := f.service.AddTicketComment(ctx, other, ticket.Ticket.ID, workinggroups.CommentInput{Text: "Same here"}, nil)
	if err != nil || len(commented.Comments) != 1 || commented.Comments[0].Internal || commented.Comments[0].Author == nil {
		t.Fatalf("comment = %+v, %v", commented, err)
	}

	// Outsiders cannot work on the ticket or write internal comments.
	column := f.columnTodo
	_, err = f.service.PlanTicket(ctx, f.outsider, ticket.Ticket.ID, workinggroups.PlanTicketInput{ColumnID: column}, nil)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")
	_, err = f.service.UpdateTicket(ctx, f.outsider, ticket.Ticket.ID, workinggroups.UpdateTicketInput{ExpectedVersion: 1, ColumnID: &column}, nil)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")
	_, err = f.service.CloseTicket(ctx, f.outsider, ticket.Ticket.ID, workinggroups.CloseTicketInput{Outcome: workinggroups.StatusDone}, nil)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")
	_, err = f.service.ReopenTicket(ctx, f.outsider, ticket.Ticket.ID, nil)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")
	_, err = f.service.AddTicketComment(ctx, f.outsider, ticket.Ticket.ID, workinggroups.CommentInput{Text: "Secret", Internal: true}, nil)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")
	// Permission is checked before input: an empty internal comment is still 403, not 422.
	_, err = f.service.AddTicketComment(ctx, f.outsider, ticket.Ticket.ID, workinggroups.CommentInput{Internal: true}, nil)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")
	_, err = f.service.GetTicket(ctx, f.outsider, ids.New())
	requireAppError(t, err, http.StatusNotFound, "")

	// Inside people write internal comments; outsiders never get them back.
	if _, err := f.service.AddTicketComment(ctx, f.member, ticket.Ticket.ID, workinggroups.CommentInput{Text: "Order a lens", Internal: true}, nil); err != nil {
		t.Fatal(err)
	}
	asOutsider, err := f.service.GetTicket(ctx, f.outsider, ticket.Ticket.ID)
	if err != nil || len(asOutsider.Comments) != 1 || asOutsider.Ticket.CommentCount != 1 {
		t.Fatalf("outsider view = %+v, %v", asOutsider, err)
	}
	asMember, err := f.service.GetTicket(ctx, f.member, ticket.Ticket.ID)
	if err != nil || len(asMember.Comments) != 2 || asMember.Ticket.CommentCount != 2 {
		t.Fatalf("member view = %+v, %v", asMember, err)
	}
	asManager, err := f.service.GetTicket(ctx, f.manager, ticket.Ticket.ID)
	if err != nil || len(asManager.Comments) != 2 || !asManager.Ticket.Inside {
		t.Fatalf("manager view = %+v, %v", asManager, err)
	}
	assertCount(t, pool, `SELECT count(*) FROM working_group_tickets WHERE status <> 'new'`, 0)

	// To-dos do not exist for outsiders: not in lists, 404 for every single-to-do operation, 403 for creating one.
	todo, err := f.service.CreateTodo(ctx, f.member, workinggroups.CreateTodoInput{GroupID: f.group.ID, Title: "Clean the lens", DueOn: day(2027, 1, 15)}, nil)
	if err != nil {
		t.Fatal(err)
	}
	items, err := f.service.ListTodos(ctx, f.outsider, nil)
	if err != nil || len(items) != 0 {
		t.Fatalf("outsider todos = %+v, %v", items, err)
	}
	items, err = f.service.ListTodos(ctx, f.outsider, &f.group.ID)
	if err != nil || len(items) != 0 {
		t.Fatalf("outsider group todos = %+v, %v", items, err)
	}
	_, err = f.service.GetTodo(ctx, f.outsider, todo.Todo.ID)
	requireAppError(t, err, http.StatusNotFound, "")
	_, err = f.service.UpdateTodo(ctx, f.outsider, todo.Todo.ID, workinggroups.UpdateTodoInput{ExpectedVersion: 1}, nil)
	requireAppError(t, err, http.StatusNotFound, "")
	_, err = f.service.MarkTodoDone(ctx, f.outsider, todo.Todo.ID, nil)
	requireAppError(t, err, http.StatusNotFound, "")
	_, err = f.service.ReopenTodo(ctx, f.outsider, todo.Todo.ID, nil)
	requireAppError(t, err, http.StatusNotFound, "")
	_, err = f.service.AddTodoComment(ctx, f.outsider, todo.Todo.ID, workinggroups.CommentInput{Text: "x"}, nil)
	requireAppError(t, err, http.StatusNotFound, "")
	requireAppError(t, f.service.DeleteTodo(ctx, f.outsider, todo.Todo.ID, nil), http.StatusNotFound, "")
	_, err = f.service.CreateTodo(ctx, f.outsider, workinggroups.CreateTodoInput{GroupID: f.group.ID, Title: "x", DueOn: day(2027, 1, 1)}, nil)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")
	assertCount(t, pool, `SELECT count(*) FROM working_group_todos`, 1)
	// The same to-do is there for the member, the lead and the manager.
	for _, p := range []authorization.Principal{f.member, f.lead, f.manager} {
		items, err = f.service.ListTodos(ctx, p, nil)
		if err != nil || len(items) != 1 {
			t.Fatalf("inside todos = %+v, %v", items, err)
		}
	}
}

func TestWorkingGroupTicketFollowRules(t *testing.T) {
	pool := statementPool(t)
	ctx := testContext(t)
	f := newTaskFixture(t, pool, "wgt-follow")
	ticket := f.newTicket(t, f.outsider, "Door sticks")

	// The author cannot follow their own ticket.
	_, err := f.service.FollowTicket(ctx, f.outsider, ticket.Ticket.ID, nil)
	requireAppError(t, err, http.StatusConflict, "working_group_ticket_own")

	// Following twice is idempotent and audited once; unfollowing twice is fine too.
	for i := 0; i < 2; i++ {
		detail, err := f.service.FollowTicket(ctx, f.member, ticket.Ticket.ID, nil)
		if err != nil || detail.Ticket.FollowerCount != 1 {
			t.Fatalf("follow %d = %+v, %v", i, detail, err)
		}
	}
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action = 'working_group_ticket.followed' AND resource_id = $1`, 1, ticket.Ticket.ID)
	for i := 0; i < 2; i++ {
		detail, err := f.service.UnfollowTicket(ctx, f.member, ticket.Ticket.ID, nil)
		if err != nil || detail.Ticket.FollowerCount != 0 || detail.Ticket.IsFollowing {
			t.Fatalf("unfollow %d = %+v, %v", i, detail, err)
		}
	}
	_, err = f.service.FollowTicket(ctx, f.member, ids.New(), nil)
	requireAppError(t, err, http.StatusNotFound, "")
}

func TestWorkingGroupTicketPlanningPatchCloseAndReopen(t *testing.T) {
	pool := statementPool(t)
	ctx := testContext(t)
	f := newTaskFixture(t, pool, "wgt-plan")
	ticket := f.newTicket(t, f.outsider, "Lens is dirty")
	id := ticket.Ticket.ID
	due := day(2027, 2, 1)

	// Planning needs a member as assignee and a column of this very group.
	_, err := f.service.PlanTicket(ctx, f.member, id, workinggroups.PlanTicketInput{AssigneePersonID: &f.outsiderID, ColumnID: f.columnTodo}, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "assignee_not_in_group")
	otherGroup, err := f.service.Create(ctx, f.manager, workinggroups.CreateInput{Name: "Other wgt-plan", LeadPersonID: f.leadID}, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.service.PlanTicket(ctx, f.member, id, workinggroups.PlanTicketInput{ColumnID: otherGroup.Columns[0].ID}, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "working_group_column_not_found")
	_, err = f.service.PlanTicket(ctx, f.member, id, workinggroups.PlanTicketInput{ColumnID: ids.New()}, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "working_group_column_not_found")
	// A ticket that is not planned cannot be patched.
	_, err = f.service.UpdateTicket(ctx, f.member, id, workinggroups.UpdateTicketInput{ExpectedVersion: 1, ColumnID: &f.columnProgress}, nil)
	requireAppError(t, err, http.StatusConflict, "working_group_task_state")

	planned, err := f.service.PlanTicket(ctx, f.member, id, workinggroups.PlanTicketInput{
		AssigneePersonID: &f.memberID, DueOn: &due, ColumnID: f.columnTodo,
	}, nil)
	if err != nil || planned.Ticket.Status != workinggroups.StatusPlanned || planned.Ticket.Assignee == nil ||
		planned.Ticket.Assignee.ID != f.memberID || planned.Ticket.DueOn == nil || !planned.Ticket.DueOn.Equal(due) ||
		planned.Ticket.ColumnID == nil || *planned.Ticket.ColumnID != f.columnTodo || planned.Ticket.Version != 2 {
		t.Fatalf("planned = %+v, %v", planned.Ticket, err)
	}
	_, err = f.service.PlanTicket(ctx, f.member, id, workinggroups.PlanTicketInput{ColumnID: f.columnTodo}, nil)
	requireAppError(t, err, http.StatusConflict, "working_group_task_state")
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action = 'working_group_ticket.planned' AND resource_id = $1 AND actor_account_id = $2`,
		1, id, f.member.AccountID)

	// Patch: stale versions are refused, then assignee, due date and column change.
	_, err = f.service.UpdateTicket(ctx, f.lead, id, workinggroups.UpdateTicketInput{ExpectedVersion: 1, ColumnID: &f.columnProgress}, nil)
	requireAppError(t, err, http.StatusConflict, "stale_write")
	_, err = f.service.UpdateTicket(ctx, f.lead, id, workinggroups.UpdateTicketInput{ExpectedVersion: 0}, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "")
	_, err = f.service.UpdateTicket(ctx, f.lead, id, workinggroups.UpdateTicketInput{
		ExpectedVersion: 2, Assignee: workinggroups.OptionalID{Set: true, Value: &f.outsiderID},
	}, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "assignee_not_in_group")
	later := day(2027, 3, 1)
	patched, err := f.service.UpdateTicket(ctx, f.lead, id, workinggroups.UpdateTicketInput{
		ExpectedVersion: 2, Assignee: workinggroups.OptionalID{Set: true, Value: &f.leadID},
		DueOn: workinggroups.OptionalDate{Set: true, Value: &later}, ColumnID: &f.columnProgress,
	}, nil)
	if err != nil || patched.Ticket.Version != 3 || patched.Ticket.Assignee.ID != f.leadID || !patched.Ticket.DueOn.Equal(later) ||
		*patched.Ticket.ColumnID != f.columnProgress {
		t.Fatalf("patched = %+v, %v", patched.Ticket, err)
	}
	cleared, err := f.service.UpdateTicket(ctx, f.manager, id, workinggroups.UpdateTicketInput{
		ExpectedVersion: 3, Assignee: workinggroups.OptionalID{Set: true}, DueOn: workinggroups.OptionalDate{Set: true},
	}, nil)
	if err != nil || cleared.Ticket.Assignee != nil || cleared.Ticket.DueOn != nil || cleared.Ticket.Version != 4 {
		t.Fatalf("cleared = %+v, %v", cleared.Ticket, err)
	}

	// Closing: declining needs an answer; the answer becomes a public comment in the same transaction.
	_, err = f.service.CloseTicket(ctx, f.member, id, workinggroups.CloseTicketInput{Outcome: workinggroups.StatusDeclined}, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "")
	_, err = f.service.CloseTicket(ctx, f.member, id, workinggroups.CloseTicketInput{Outcome: workinggroups.StatusDeclined, Answer: "   "}, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "")
	_, err = f.service.CloseTicket(ctx, f.member, id, workinggroups.CloseTicketInput{Outcome: workinggroups.StatusNew}, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "")
	assertCount(t, pool, `SELECT count(*) FROM working_group_comments WHERE ticket_id = $1`, 0, id)
	closed, err := f.service.CloseTicket(ctx, f.member, id, workinggroups.CloseTicketInput{Outcome: workinggroups.StatusDone, Answer: "Cleaned it"}, nil)
	if err != nil || closed.Ticket.Status != workinggroups.StatusDone || closed.Ticket.ClosedAt == nil || closed.Ticket.ColumnID != nil ||
		len(closed.Comments) != 1 || closed.Comments[0].Internal || closed.Comments[0].Text != "Cleaned it" ||
		closed.Comments[0].Author == nil || closed.Comments[0].Author.ID != f.memberID {
		t.Fatalf("closed = %+v, %v", closed, err)
	}
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action = 'working_group_ticket.closed' AND resource_id = $1 AND actor_account_id = $2`,
		1, id, f.member.AccountID)
	_, err = f.service.CloseTicket(ctx, f.member, id, workinggroups.CloseTicketInput{Outcome: workinggroups.StatusDone}, nil)
	requireAppError(t, err, http.StatusConflict, "working_group_task_state")
	_, err = f.service.UpdateTicket(ctx, f.member, id, workinggroups.UpdateTicketInput{ExpectedVersion: closed.Ticket.Version, ColumnID: &f.columnTodo}, nil)
	requireAppError(t, err, http.StatusConflict, "working_group_task_state")

	// Reopen sends it back to the inbox; a declined ticket can be reopened too.
	reopened, err := f.service.ReopenTicket(ctx, f.lead, id, nil)
	if err != nil || reopened.Ticket.Status != workinggroups.StatusNew || reopened.Ticket.ClosedAt != nil || reopened.Ticket.ColumnID != nil ||
		reopened.Ticket.Assignee != nil || reopened.Ticket.DueOn != nil {
		t.Fatalf("reopened = %+v, %v", reopened.Ticket, err)
	}
	_, err = f.service.ReopenTicket(ctx, f.lead, id, nil)
	requireAppError(t, err, http.StatusConflict, "working_group_task_state")
	declined, err := f.service.CloseTicket(ctx, f.manager, id, workinggroups.CloseTicketInput{Outcome: workinggroups.StatusDeclined, Answer: "Not ours"}, nil)
	if err != nil || declined.Ticket.Status != workinggroups.StatusDeclined || len(declined.Comments) != 2 {
		t.Fatalf("declined = %+v, %v", declined, err)
	}
	if _, err := f.service.ReopenTicket(ctx, f.manager, id, nil); err != nil {
		t.Fatal(err)
	}

	// Filters: by group and status.
	filtered, err := f.service.ListTickets(ctx, f.outsider, workinggroups.TicketFilter{GroupID: &otherGroup.ID})
	if err != nil || len(filtered) != 0 {
		t.Fatalf("other group tickets = %+v, %v", filtered, err)
	}
	status := workinggroups.StatusNew
	filtered, err = f.service.ListTickets(ctx, f.outsider, workinggroups.TicketFilter{GroupID: &f.group.ID, Status: &status})
	if err != nil || len(filtered) != 1 {
		t.Fatalf("new tickets = %+v, %v", filtered, err)
	}
	bad := workinggroups.TicketStatus("open")
	_, err = f.service.ListTickets(ctx, f.outsider, workinggroups.TicketFilter{Status: &bad})
	requireAppError(t, err, http.StatusUnprocessableEntity, "")

	// Audit events carry ids and field names, never the ticket's text.
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE resource_type = 'working_group_ticket'
		AND (to_jsonb(audit_events)::text LIKE '%dirty%' OR to_jsonb(audit_events)::text LIKE '%Cleaned%' OR to_jsonb(audit_events)::text LIKE '%Not ours%')`, 0)
}

func TestWorkingGroupTodosRepeatAndLifecycle(t *testing.T) {
	pool := statementPool(t)
	ctx := testContext(t)
	f := newTaskFixture(t, pool, "wgt-todo")
	due := day(2027, 1, 10)

	_, err := f.service.CreateTodo(ctx, f.member, workinggroups.CreateTodoInput{GroupID: f.group.ID, Title: "  ", DueOn: due}, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "")
	_, err = f.service.CreateTodo(ctx, f.member, workinggroups.CreateTodoInput{GroupID: f.group.ID, Title: "x"}, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "")
	zero, huge := 0, 731
	for _, repeat := range []*int{&zero, &huge} {
		_, err = f.service.CreateTodo(ctx, f.member, workinggroups.CreateTodoInput{GroupID: f.group.ID, Title: "x", DueOn: due, RepeatEveryDays: repeat}, nil)
		requireAppError(t, err, http.StatusUnprocessableEntity, "")
	}
	_, err = f.service.CreateTodo(ctx, f.member, workinggroups.CreateTodoInput{GroupID: f.group.ID, Title: "x", DueOn: due, AssigneePersonID: &f.outsiderID}, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "assignee_not_in_group")
	_, err = f.service.CreateTodo(ctx, f.member, workinggroups.CreateTodoInput{GroupID: ids.New(), Title: "x", DueOn: due}, nil)
	requireAppError(t, err, http.StatusNotFound, "")
	assertCount(t, pool, `SELECT count(*) FROM working_group_todos`, 0)

	seven := 7
	todo, err := f.service.CreateTodo(ctx, f.member, workinggroups.CreateTodoInput{
		GroupID: f.group.ID, Title: "Check the filters", DueOn: due, AssigneePersonID: &f.memberID, RepeatEveryDays: &seven,
	}, nil)
	if err != nil || todo.Todo.ColumnID != f.columnTodo || todo.Todo.Done || todo.Todo.RepeatEveryDays == nil || *todo.Todo.RepeatEveryDays != 7 ||
		!todo.Todo.IsMine || todo.Todo.CreatedBy == nil {
		t.Fatalf("todo = %+v, %v", todo.Todo, err)
	}

	// Patch with a stale version, then for real.
	title := "Check the air filters"
	_, err = f.service.UpdateTodo(ctx, f.lead, todo.Todo.ID, workinggroups.UpdateTodoInput{ExpectedVersion: 5, Title: &title}, nil)
	requireAppError(t, err, http.StatusConflict, "stale_write")
	patched, err := f.service.UpdateTodo(ctx, f.lead, todo.Todo.ID, workinggroups.UpdateTodoInput{
		ExpectedVersion: 1, Title: &title, ColumnID: &f.columnProgress, Assignee: workinggroups.OptionalID{Set: true},
	}, nil)
	if err != nil || patched.Todo.Title != title || patched.Todo.ColumnID != f.columnProgress || patched.Todo.Assignee != nil || patched.Todo.Version != 2 {
		t.Fatalf("patched = %+v, %v", patched.Todo, err)
	}
	if _, err := f.service.UpdateTodo(ctx, f.lead, todo.Todo.ID, workinggroups.UpdateTodoInput{
		ExpectedVersion: 2, Assignee: workinggroups.OptionalID{Set: true, Value: &f.memberID},
	}, nil); err != nil {
		t.Fatal(err)
	}

	// Done spawns the next open to-do: today plus the interval, same title, assignee, column and repeat.
	done, err := f.service.MarkTodoDone(ctx, f.member, todo.Todo.ID, nil)
	if err != nil || !done.Todo.Done || done.NextTodoID == nil {
		t.Fatalf("done = %+v, %v", done, err)
	}
	next, err := f.service.GetTodo(ctx, f.member, *done.NextTodoID)
	wantDue := time.Now().UTC().AddDate(0, 0, 7)
	if err != nil || next.Todo.Done || next.Todo.Title != title || next.Todo.Assignee == nil || next.Todo.Assignee.ID != f.memberID ||
		next.Todo.ColumnID != f.columnProgress || next.Todo.RepeatEveryDays == nil || *next.Todo.RepeatEveryDays != 7 ||
		next.Todo.DueOn.Format("2006-01-02") != wantDue.Format("2006-01-02") {
		t.Fatalf("next = %+v, %v", next.Todo, err)
	}
	_, err = f.service.MarkTodoDone(ctx, f.member, todo.Todo.ID, nil)
	requireAppError(t, err, http.StatusConflict, "working_group_task_state")
	assertCount(t, pool, `SELECT count(*) FROM working_group_todos`, 2)

	// Reopen clears the done mark without spawning anything; a to-do that is not done cannot be reopened.
	reopened, err := f.service.ReopenTodo(ctx, f.member, todo.Todo.ID, nil)
	if err != nil || reopened.Todo.Done || reopened.NextTodoID != nil {
		t.Fatalf("reopened = %+v, %v", reopened, err)
	}
	_, err = f.service.ReopenTodo(ctx, f.member, todo.Todo.ID, nil)
	requireAppError(t, err, http.StatusConflict, "working_group_task_state")
	assertCount(t, pool, `SELECT count(*) FROM working_group_todos`, 2)

	// A to-do without a repeat spawns nothing; comments are always internal; delete is hard.
	single, err := f.service.CreateTodo(ctx, f.manager, workinggroups.CreateTodoInput{GroupID: f.group.ID, Title: "Once", DueOn: due}, nil)
	if err != nil {
		t.Fatal(err)
	}
	commented, err := f.service.AddTodoComment(ctx, f.lead, single.Todo.ID, workinggroups.CommentInput{Text: "Remember", Internal: false}, nil)
	if err != nil || len(commented.Comments) != 1 || !commented.Comments[0].Internal || commented.Todo.CommentCount != 1 {
		t.Fatalf("todo comment = %+v, %v", commented, err)
	}
	if done, err = f.service.MarkTodoDone(ctx, f.manager, single.Todo.ID, nil); err != nil || done.NextTodoID != nil {
		t.Fatalf("single done = %+v, %v", done, err)
	}
	assertCount(t, pool, `SELECT count(*) FROM working_group_todos`, 3)
	if err := f.service.DeleteTodo(ctx, f.manager, single.Todo.ID, nil); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `SELECT count(*) FROM working_group_todos`, 2)
	assertCount(t, pool, `SELECT count(*) FROM working_group_comments`, 0)
	_, err = f.service.GetTodo(ctx, f.manager, single.Todo.ID)
	requireAppError(t, err, http.StatusNotFound, "")
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action = 'working_group_todo.deleted' AND resource_id = $1`, 1, single.Todo.ID)

	// A member who leaves the group no longer carries its to-dos and tickets.
	ticket := f.newTicket(t, f.outsider, "Fan noise")
	if _, err := f.service.PlanTicket(ctx, f.lead, ticket.Ticket.ID, workinggroups.PlanTicketInput{AssigneePersonID: &f.memberID, ColumnID: f.columnTodo}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.RemoveMember(ctx, f.manager, f.group.ID, f.memberID, nil); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `SELECT count(*) FROM working_group_todos WHERE assignee_person_id IS NOT NULL`, 0)
	assertCount(t, pool, `SELECT count(*) FROM working_group_tickets WHERE assignee_person_id IS NOT NULL`, 0)
	assertCount(t, pool, `SELECT count(*) FROM working_group_tickets WHERE status = 'planned'`, 1)
	// And is outside now: the to-dos are gone for them.
	if items, err := f.service.ListTodos(ctx, f.member, nil); err != nil || len(items) != 0 {
		t.Fatalf("former member todos = %+v, %v", items, err)
	}
}

func TestWorkingGroupColumns(t *testing.T) {
	pool := statementPool(t)
	ctx := testContext(t)
	f := newTaskFixture(t, pool, "wgt-columns")
	due := day(2027, 1, 10)
	ticket := f.newTicket(t, f.outsider, "Sort me")
	if _, err := f.service.PlanTicket(ctx, f.member, ticket.Ticket.ID, workinggroups.PlanTicketInput{ColumnID: f.columnProgress}, nil); err != nil {
		t.Fatal(err)
	}
	todo, err := f.service.CreateTodo(ctx, f.member, workinggroups.CreateTodoInput{GroupID: f.group.ID, Title: "Sort me too", DueOn: due, ColumnID: &f.columnProgress}, nil)
	if err != nil {
		t.Fatal(err)
	}

	// Only the lead and management change columns.
	_, err = f.service.SetColumns(ctx, f.member, f.group.ID, []workinggroups.ColumnInput{{Name: "x"}}, nil)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")
	_, err = f.service.SetColumns(ctx, f.outsider, f.group.ID, []workinggroups.ColumnInput{{Name: "x"}}, nil)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")
	_, err = f.service.SetColumns(ctx, f.manager, ids.New(), []workinggroups.ColumnInput{{Name: "x"}}, nil)
	requireAppError(t, err, http.StatusNotFound, "")

	// Validation: at least one column, names, duplicates, foreign ids.
	_, err = f.service.SetColumns(ctx, f.lead, f.group.ID, nil, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "working_group_column_required")
	_, err = f.service.SetColumns(ctx, f.lead, f.group.ID, []workinggroups.ColumnInput{{Name: " "}}, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "")
	_, err = f.service.SetColumns(ctx, f.lead, f.group.ID, []workinggroups.ColumnInput{{Name: strings.Repeat("x", 41)}}, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "")
	_, err = f.service.SetColumns(ctx, f.lead, f.group.ID, []workinggroups.ColumnInput{{Name: "Same"}, {Name: "same"}}, nil)
	requireAppError(t, err, http.StatusConflict, "working_group_column_exists")
	foreign := ids.New()
	_, err = f.service.SetColumns(ctx, f.lead, f.group.ID, []workinggroups.ColumnInput{{ID: &foreign, Name: "x"}}, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "working_group_column_not_found")

	// Rename, reorder and add: swap the two columns' names, put the old second one first, add one at the end.
	todoID, progressID := f.columnTodo, f.columnProgress
	swapped, err := f.service.SetColumns(ctx, f.lead, f.group.ID, []workinggroups.ColumnInput{
		{ID: &progressID, Name: "To do"}, {ID: &todoID, Name: "In progress"}, {Name: "Review"},
	}, nil)
	if err != nil || len(swapped.Columns) != 3 || swapped.Columns[0].ID != progressID || swapped.Columns[0].Name != "To do" ||
		swapped.Columns[1].ID != todoID || swapped.Columns[2].Name != "Review" {
		t.Fatalf("columns = %+v, %v", swapped.Columns, err)
	}
	review := swapped.Columns[2].ID

	// Deleting a column moves its open tickets and to-dos to the first remaining column. The ticket and to-do sit in
	// the column that is now first ("To do" = progressID), so delete that one: they move to the new first column.
	after, err := f.service.SetColumns(ctx, f.manager, f.group.ID, []workinggroups.ColumnInput{{ID: &todoID, Name: "Backlog"}, {ID: &review, Name: "Review"}}, nil)
	if err != nil || len(after.Columns) != 2 || after.Columns[0].ID != todoID || after.Columns[0].Name != "Backlog" {
		t.Fatalf("after = %+v, %v", after.Columns, err)
	}
	moved, err := f.service.GetTicket(ctx, f.member, ticket.Ticket.ID)
	if err != nil || moved.Ticket.ColumnID == nil || *moved.Ticket.ColumnID != todoID || moved.Ticket.Status != workinggroups.StatusPlanned {
		t.Fatalf("moved ticket = %+v, %v", moved.Ticket, err)
	}
	movedTodo, err := f.service.GetTodo(ctx, f.member, todo.Todo.ID)
	if err != nil || movedTodo.Todo.ColumnID != todoID {
		t.Fatalf("moved todo = %+v, %v", movedTodo.Todo, err)
	}

	// Deleting down to a brand-new first column also moves the items there; the last column cannot be deleted.
	replaced, err := f.service.SetColumns(ctx, f.lead, f.group.ID, []workinggroups.ColumnInput{{Name: "Fresh"}}, nil)
	if err != nil || len(replaced.Columns) != 1 || replaced.Columns[0].Name != "Fresh" {
		t.Fatalf("replaced = %+v, %v", replaced.Columns, err)
	}
	movedTodo, err = f.service.GetTodo(ctx, f.member, todo.Todo.ID)
	if err != nil || movedTodo.Todo.ColumnID != replaced.Columns[0].ID {
		t.Fatalf("todo after replace = %+v, %v", movedTodo.Todo, err)
	}
	_, err = f.service.SetColumns(ctx, f.lead, f.group.ID, []workinggroups.ColumnInput{}, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "working_group_column_required")
	assertCount(t, pool, `SELECT count(*) FROM working_group_columns WHERE group_id = $1`, 1, f.group.ID)
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action = 'working_group_columns.changed' AND resource_id = $1`, 3, f.group.ID)

	// A new group starts with the default columns; deleting the group removes columns, tickets and to-dos.
	if err := f.service.Delete(ctx, f.manager, f.group.ID, nil); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `SELECT count(*) FROM working_group_columns WHERE group_id = $1`, 0, f.group.ID)
	assertCount(t, pool, `SELECT count(*) FROM working_group_tickets`, 0)
	assertCount(t, pool, `SELECT count(*) FROM working_group_todos`, 0)
}

func TestWorkingGroupTicketsOutliveTheirAuthors(t *testing.T) {
	pool := statementPool(t)
	ctx := testContext(t)
	f := newTaskFixture(t, pool, "wgt-former")
	ticket := f.newTicket(t, f.outsider, "Orphan soon")
	if _, err := f.service.AddTicketComment(ctx, f.outsider, ticket.Ticket.ID, workinggroups.CommentInput{Text: "Still broken"}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.FollowTicket(ctx, f.member, ticket.Ticket.ID, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.PlanTicket(ctx, f.lead, ticket.Ticket.ID, workinggroups.PlanTicketInput{AssigneePersonID: &f.memberID, ColumnID: f.columnTodo}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM people WHERE id = $1`, f.outsiderID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM people WHERE id = $1`, f.memberID); err != nil {
		t.Fatal(err)
	}
	detail, err := f.service.GetTicket(ctx, f.manager, ticket.Ticket.ID)
	if err != nil || detail.Ticket.Author != nil || detail.Ticket.Assignee != nil || detail.Ticket.Status != workinggroups.StatusPlanned ||
		len(detail.Comments) != 1 || detail.Comments[0].Author != nil || len(detail.Followers) != 0 {
		t.Fatalf("detail = %+v, %v", detail, err)
	}
}

func TestPeopleMergeMovesWorkingGroupTasks(t *testing.T) {
	pool := statementPool(t)
	ctx := testContext(t)
	actor, _ := groupPrincipal(t, pool, "wgt-merge-actor", mergePermissions...)
	f := newTaskFixture(t, pool, "wgt-merge")
	target := insertGroupPerson(t, pool, "wgt-merge-target@example.test")
	source := insertGroupPerson(t, pool, "wgt-merge-source@example.test")
	for _, person := range []uuid.UUID{target, source} {
		if _, err := f.service.AddMember(ctx, f.manager, f.group.ID, person, nil); err != nil {
			t.Fatal(err)
		}
	}
	insertTicket := func(subject string, author uuid.UUID) uuid.UUID {
		id := ids.New()
		if _, err := pool.Exec(ctx, `INSERT INTO working_group_tickets(id, group_id, kind, subject, author_person_id)
			VALUES($1, $2, 'problem', $3, $4)`, id, f.group.ID, subject, author); err != nil {
			t.Fatal(err)
		}
		return id
	}
	insertTicket("Written by source", source)
	bothID := insertTicket("Followed by both", f.outsiderID)
	byTargetID := insertTicket("Written by target", target)
	assigned := f.newTicket(t, f.outsider, "Assigned to source")
	if _, err := f.service.PlanTicket(ctx, f.manager, assigned.Ticket.ID, workinggroups.PlanTicketInput{AssigneePersonID: &source, ColumnID: f.columnTodo}, nil); err != nil {
		t.Fatal(err)
	}
	for _, follow := range []struct{ person, ticket uuid.UUID }{{source, bothID}, {target, bothID}, {source, byTargetID}} {
		if _, err := pool.Exec(ctx, `INSERT INTO working_group_ticket_followers(ticket_id, person_id) VALUES($1, $2)`,
			follow.ticket, follow.person); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO working_group_comments(id, ticket_id, author_person_id, text) VALUES($1, $2, $3, 'Me too')`,
		ids.New(), bothID, source); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.CreateTodo(ctx, f.manager, workinggroups.CreateTodoInput{
		GroupID: f.group.ID, Title: "For source", DueOn: day(2027, 5, 1), AssigneePersonID: &source,
	}, nil); err != nil {
		t.Fatal(err)
	}

	result, err := people.NewService(pool, nil).Merge(ctx, actor, people.MergeInput{
		MergeSelection:   people.MergeSelection{TargetPersonID: target, SourcePersonIDs: []uuid.UUID{source}},
		ExpectedVersions: mergeVersions(t, pool, target, source),
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `SELECT count(*) FROM working_group_tickets WHERE author_person_id = $1`, 2, target)
	assertCount(t, pool, `SELECT count(*) FROM working_group_tickets WHERE assignee_person_id = $1`, 1, target)
	assertCount(t, pool, `SELECT count(*) FROM working_group_todos WHERE assignee_person_id = $1`, 1, target)
	assertCount(t, pool, `SELECT count(*) FROM working_group_comments WHERE author_person_id = $1`, 1, target)
	assertCount(t, pool, `SELECT count(*) FROM working_group_ticket_followers WHERE person_id = $1`, 1, target)
	assertCount(t, pool, `SELECT count(*) FROM working_group_ticket_followers WHERE person_id = $1 AND ticket_id = $2`, 1, target, bothID)
	assertCount(t, pool, `SELECT count(*) FROM working_group_tickets WHERE author_person_id = $1 OR assignee_person_id = $1`, 0, source)
	assertCount(t, pool, `SELECT count(*) FROM working_group_ticket_followers f JOIN working_group_tickets t ON t.id = f.ticket_id WHERE f.person_id = t.author_person_id`, 0)
	var count int64
	for _, moved := range result.Moved {
		if moved.Category == people.MergedWorkingGroupTasks {
			count = moved.Count
		}
	}
	// Two tickets (written, assigned), one to-do, one comment and two follows dropped as duplicates.
	if count != 6 {
		t.Fatalf("working group tasks merged = %d, want 6 (moved %+v)", count, result.Moved)
	}
}

func TestSubjectRequestWorkingGroupTasksExport(t *testing.T) {
	pool := statementPool(t)
	ctx := testContext(t)
	f := newTaskFixture(t, pool, "wgt-export")
	mine := f.newTicket(t, f.outsider, "My own ticket")
	theirs := f.newTicket(t, f.member, "Somebody else's ticket")
	if _, err := f.service.FollowTicket(ctx, f.outsider, theirs.Ticket.ID, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.AddTicketComment(ctx, f.outsider, theirs.Ticket.ID, workinggroups.CommentInput{Text: "Same here"}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.CreateTodo(ctx, f.member, workinggroups.CreateTodoInput{GroupID: f.group.ID, Title: "Member's to-do", DueOn: day(2027, 4, 1)}, nil); err != nil {
		t.Fatal(err)
	}
	_ = mine

	queries := requestsdb.New(pool)
	count, err := queries.CountWorkingGroupTasks(ctx, f.outsiderID)
	if err != nil || count != 3 { // ticket + follow + comment
		t.Fatalf("count = %d, %v", count, err)
	}
	document, err := queries.ExportWorkingGroupTasks(ctx, f.outsiderID)
	if err != nil {
		t.Fatal(err)
	}
	var export map[string][]map[string]any
	if err := json.Unmarshal(document, &export); err != nil {
		t.Fatal(err)
	}
	if len(export["tickets"]) != 1 || export["tickets"][0]["subject"] != "My own ticket" || len(export["follows"]) != 1 ||
		len(export["comments"]) != 1 || len(export["todos"]) != 0 {
		t.Fatalf("export = %s", document)
	}
	// Other people's ticket text and to-dos are not part of the subject's data.
	if strings.Contains(string(document), "Somebody else") || strings.Contains(string(document), "Member's to-do") {
		t.Fatalf("export holds other people's text: %s", document)
	}
	memberCount, err := queries.CountWorkingGroupTasks(ctx, f.memberID)
	if err != nil || memberCount != 2 { // ticket + created to-do
		t.Fatalf("member count = %d, %v", memberCount, err)
	}
}
