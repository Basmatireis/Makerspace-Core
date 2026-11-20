package integration_test

import (
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/workinggroups"
	"github.com/google/uuid"
)

func (f financeFixture) newTodo(t *testing.T, p authorization.Principal, title string) workinggroups.TodoDetail {
	t.Helper()
	detail, err := f.service.CreateTodo(testContext(t), p, workinggroups.CreateTodoInput{
		GroupID: f.group.ID, Title: title, DueOn: time.Now().UTC().AddDate(0, 0, 3),
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	return detail
}

func TestWorkingGroupTicketAndTodoLinksFollowTheirPermissionsAndVisibility(t *testing.T) {
	f := newProjectFixture(t, "wglink")
	ctx := testContext(t)
	purchase := f.buy(t, f.member, workinggroups.HowSelf, "Lens", 1, "20.00")
	ticket := f.newTicket(t, f.outsider, "Dirty lens")
	version := ticket.Ticket.Version
	link := func(p authorization.Principal, purchaseID, projectID *uuid.UUID, v int64) (workinggroups.TicketDetail, error) {
		return f.service.SetTicketLink(ctx, p, ticket.Ticket.ID, workinggroups.LinkInput{ExpectedVersion: v, PurchaseID: purchaseID, ProjectID: projectID}, nil)
	}

	// Who may edit the ticket may link it; the author outside the group may not.
	if _, err := link(f.outsider, &purchase.ID, nil, version); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("outsider linking = %v", err)
	}
	// A manager who is neither a member nor a finance manager may edit the ticket but not see the purchase.
	if _, err := link(f.manager, &purchase.ID, nil, version); !apperror.IsCode(err, "not_found") {
		t.Fatalf("manager linking an unseen purchase = %v", err)
	}
	if _, err := link(f.lead, &purchase.ID, nil, version+7); !apperror.IsCode(err, "stale_write") {
		t.Fatalf("stale link = %v", err)
	}
	// Both targets at once are refused; so is a purchase of another group, for somebody who sees it.
	if _, err := link(f.lead, &purchase.ID, &purchase.ID, version); !apperror.IsCode(err, "working_group_link_ambiguous") {
		t.Fatalf("both targets = %v", err)
	}
	foreign, err := f.service.CreatePurchases(ctx, f.otherMember, workinggroups.CreatePurchasesInput{
		GroupID: f.otherGroup.ID, How: workinggroups.HowSelf,
		Items: []workinggroups.PurchaseItemInput{{Item: "Foreign", Quantity: 1, UnitPrice: "5.00"}},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := link(f.lead, &foreign[0].ID, nil, version); !apperror.IsCode(err, "not_found") {
		t.Fatalf("lead linking a purchase of a group they are not in = %v", err)
	}
	if _, err := f.service.SetTicketLink(ctx, f.finance, ticket.Ticket.ID, workinggroups.LinkInput{
		ExpectedVersion: version, PurchaseID: &foreign[0].ID,
	}, nil); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("finance manager outside the group linking = %v", err)
	}
	if _, err := link(f.manager, &foreign[0].ID, nil, version); !apperror.IsCode(err, "not_found") {
		t.Fatalf("manager without finance linking a foreign purchase = %v", err)
	}
	// Somebody inside the group who sees both groups (finance manager who is also a member) gets 422 for a foreign one.
	both, _ := groupPrincipal(t, f.pool, "wglink-both", "working_groups.read", "working_group_finances.manage")
	if _, err := f.service.AddMember(ctx, f.manager, f.group.ID, both.PersonID, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.SetTicketLink(ctx, both, ticket.Ticket.ID, workinggroups.LinkInput{
		ExpectedVersion: version, PurchaseID: &foreign[0].ID,
	}, nil); !apperror.IsCode(err, "working_group_link_other_group") {
		t.Fatalf("foreign purchase = %v", err)
	}

	linked, err := link(f.lead, &purchase.ID, nil, version)
	if err != nil {
		t.Fatal(err)
	}
	if l := linked.Ticket.Link; l == nil || l.Kind != "purchase" || l.ID != purchase.ID || l.Title != "Lens" || l.Status != "wanted" {
		t.Fatalf("link = %+v", l)
	}
	assertCount(t, f.pool, `SELECT count(*) FROM audit_events WHERE action = 'working_group_ticket.linked' AND resource_id = $1`, 1, ticket.Ticket.ID)

	// Visibility of the link: the group and finance managers see it, the author outside the group does not.
	for who, want := range map[string]struct {
		p    authorization.Principal
		seen bool
	}{"member": {f.member, true}, "finance": {f.finance, true}, "outsider": {f.outsider, false}, "manager": {f.manager, false}} {
		got, err := f.service.GetTicket(ctx, want.p, ticket.Ticket.ID)
		if err != nil {
			t.Fatal(err)
		}
		if (got.Ticket.Link != nil) != want.seen {
			t.Errorf("%s sees the link: %v", who, got.Ticket.Link != nil)
		}
	}

	// The purchase lists the linked tasks for people inside the group only.
	todo := f.newTodo(t, f.member, "Order the lens")
	if _, err := f.service.SetTodoLink(ctx, f.outsider, todo.Todo.ID, workinggroups.LinkInput{ExpectedVersion: todo.Todo.Version, PurchaseID: &purchase.ID}, nil); !apperror.IsCode(err, "not_found") {
		t.Fatalf("outsider linking a to-do = %v", err)
	}
	todoLinked, err := f.service.SetTodoLink(ctx, f.member, todo.Todo.ID, workinggroups.LinkInput{ExpectedVersion: todo.Todo.Version, PurchaseID: &purchase.ID}, nil)
	if err != nil || todoLinked.Todo.Link == nil || todoLinked.Todo.Link.ID != purchase.ID {
		t.Fatalf("to-do link = %+v, %v", todoLinked.Todo.Link, err)
	}
	if _, err := f.service.SetTodoLink(ctx, f.member, todo.Todo.ID, workinggroups.LinkInput{ExpectedVersion: todo.Todo.Version, PurchaseID: &foreign[0].ID}, nil); !apperror.IsCode(err, "stale_write") {
		t.Fatalf("stale to-do link = %v", err)
	}
	inside, err := f.service.GetPurchase(ctx, f.member, purchase.ID)
	if err != nil || len(inside.LinkedTasks) != 2 {
		t.Fatalf("linked tasks for a member = %+v, %v", inside.LinkedTasks, err)
	}
	outside, err := f.service.GetPurchase(ctx, f.finance, purchase.ID)
	if err != nil || len(outside.LinkedTasks) != 0 {
		t.Fatalf("linked tasks for a finance manager outside the group = %+v, %v", outside.LinkedTasks, err)
	}

	// A project works the same way; one task has at most one link.
	project := f.project(t, "Laser upgrade", "100.00")
	moved, err := link(f.lead, nil, &project.ID, linked.Ticket.Version)
	if err != nil || moved.Ticket.Link == nil || moved.Ticket.Link.Kind != "project" {
		t.Fatalf("project link = %+v, %v", moved.Ticket.Link, err)
	}
	if got := mustGet(t, f, f.lead, project.ID); len(got.LinkedTasks) != 1 || got.LinkedTasks[0].Kind != "ticket" {
		t.Fatalf("project linked tasks = %+v", got.LinkedTasks)
	}
	if _, err := f.pool.Exec(ctx, `UPDATE working_group_tickets SET purchase_id = $2 WHERE id = $1`, ticket.Ticket.ID, purchase.ID); err == nil {
		t.Fatal("the database accepted two links on one ticket")
	}
	cleared, err := link(f.lead, nil, nil, moved.Ticket.Version)
	if err != nil || cleared.Ticket.Link != nil {
		t.Fatalf("unlink = %+v, %v", cleared.Ticket.Link, err)
	}
	// Deleting the target leaves the task without a link.
	if _, err := f.service.SetTodoLink(ctx, f.member, todo.Todo.ID, workinggroups.LinkInput{ExpectedVersion: todoLinked.Todo.Version}, nil); err != nil {
		t.Fatal(err)
	}
	relinked, err := link(f.lead, &purchase.ID, nil, cleared.Ticket.Version)
	if err != nil {
		t.Fatal(err)
	}
	mergeExec(t, f.pool, `DELETE FROM working_group_purchases WHERE id = $1`, purchase.ID)
	if got, err := f.service.GetTicket(ctx, f.lead, relinked.Ticket.ID); err != nil || got.Ticket.Link != nil {
		t.Fatalf("link after the purchase is gone = %+v, %v", got.Ticket.Link, err)
	}
}

func TestWorkingGroupTicketNotificationsReachAuthorAndFollowersNotTheActor(t *testing.T) {
	f := newFinanceFixture(t, "wgnote")
	ctx := testContext(t)
	f.service.WithNotifications(notifyrules.NewSystemEvents(notifyrules.NewDispatcher(f.pool, time.UTC)))
	ruleManager, _ := groupPrincipal(t, f.pool, "wgnote-rules", "working_groups.read", "notification_rules.manage")
	var category uuid.UUID
	if err := f.pool.QueryRow(ctx, `SELECT id FROM notification_categories WHERE key = 'service'`).Scan(&category); err != nil {
		t.Fatal(err)
	}
	rule, err := notifyrules.NewService(f.pool).CreateRule(ctx, ruleManager, notifyrules.RuleInput{
		Name: "Ticket updates", Enabled: true, CategoryID: &category,
		Definition: notifyrules.Definition{
			Trigger:    notifyrules.TriggerDef{Type: notifyrules.TriggerEvent, Event: "working_group_ticket_updated"},
			Conditions: notifyrules.ConditionSet{Mode: notifyrules.ModeAll},
			Actions: []notifyrules.Action{{
				Channel: notifyrules.ChannelInApp, Recipients: []string{"author", "followers"}, Title: "{ticket} {change}", Body: "By {by}.",
			}},
		},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}

	ticket := f.newTicket(t, f.outsider, "Dirty lens")
	id := ticket.Ticket.ID
	if _, err := f.service.FollowTicket(ctx, f.third, id, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.FollowTicket(ctx, f.lead, id, nil); err != nil {
		t.Fatal(err)
	}
	count := func(p authorization.Principal) int {
		var n int
		if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM inbox_recipients r JOIN inbox_notifications n ON n.id = r.notification_id
			WHERE r.account_id = $1 AND n.kind = 'rule' AND n.rule_id = $2`, p.AccountID, rule.ID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}

	// Planning by the lead tells the author and the follower, not the lead and not people who follow nothing.
	if _, err := f.service.PlanTicket(ctx, f.lead, id, workinggroups.PlanTicketInput{ColumnID: f.columnTodo}, nil); err != nil {
		t.Fatal(err)
	}
	if count(f.outsider) != 1 || count(f.third) != 1 || count(f.lead) != 0 || count(f.member) != 0 {
		t.Fatalf("after planning: author %d, follower %d, actor %d, other member %d", count(f.outsider), count(f.third), count(f.lead), count(f.member))
	}
	// A public comment by the author reaches the followers only.
	if _, err := f.service.AddTicketComment(ctx, f.outsider, id, workinggroups.CommentInput{Text: "Still dirty"}, nil); err != nil {
		t.Fatal(err)
	}
	if count(f.outsider) != 1 || count(f.third) != 2 || count(f.lead) != 1 {
		t.Fatalf("after the author's comment: author %d, follower %d, lead %d", count(f.outsider), count(f.third), count(f.lead))
	}
	// An internal comment reaches only the followers who belong to the group: the author outside gets nothing.
	if _, err := f.service.AddTicketComment(ctx, f.member, id, workinggroups.CommentInput{Text: "Order a new one", Internal: true}, nil); err != nil {
		t.Fatal(err)
	}
	if count(f.outsider) != 1 || count(f.third) != 3 || count(f.lead) != 2 {
		t.Fatalf("after the internal comment: author %d, follower %d, lead %d", count(f.outsider), count(f.third), count(f.lead))
	}
	// Closing tells everybody but the person who closed it.
	if _, err := f.service.CloseTicket(ctx, f.lead, id, workinggroups.CloseTicketInput{Outcome: workinggroups.StatusDone, Answer: "Cleaned"}, nil); err != nil {
		t.Fatal(err)
	}
	if count(f.outsider) != 2 || count(f.third) != 4 || count(f.lead) != 2 {
		t.Fatalf("after closing: author %d, follower %d, actor %d", count(f.outsider), count(f.third), count(f.lead))
	}
	// Following is always about the caller: the follower list holds exactly the people who followed.
	detail, err := f.service.GetTicket(ctx, f.member, id)
	if err != nil || len(detail.Followers) != 2 {
		t.Fatalf("followers = %+v, %v", detail.Followers, err)
	}
	if _, err := f.service.FollowTicket(ctx, f.outsider, id, nil); !apperror.IsCode(err, "working_group_ticket_own") {
		t.Fatalf("author following their own ticket = %v", err)
	}
}

func TestWorkingGroupActivityShowsOutsidersOnlyTicketEvents(t *testing.T) {
	f := newProjectFixture(t, "wgact")
	ctx := testContext(t)
	ticket := f.newTicket(t, f.outsider, "Dirty lens")
	if _, err := f.service.CloseTicket(ctx, f.lead, ticket.Ticket.ID, workinggroups.CloseTicketInput{Outcome: workinggroups.StatusDone}, nil); err != nil {
		t.Fatal(err)
	}
	f.newTodo(t, f.member, "Sweep")
	todo := f.newTodo(t, f.member, "Wipe")
	if _, err := f.service.MarkTodoDone(ctx, f.member, todo.Todo.ID, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.CreateNote(ctx, f.member, workinggroups.CreateNoteInput{GroupID: &f.group.ID, Text: "Closed on Friday"}, nil); err != nil {
		t.Fatal(err)
	}
	purchase := f.buy(t, f.member, workinggroups.HowSelf, "Lens", 1, "20.00")
	f.financeFixture.approve(t, purchase.ID)

	kinds := func(p authorization.Principal, limit *int) []string {
		entries, err := f.service.ListActivity(ctx, p, f.group.ID, limit)
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for i, e := range entries {
			out = append(out, e.Kind)
			if i > 0 && e.At.After(entries[i-1].At) {
				t.Errorf("entries are not newest first at %d", i)
			}
		}
		return out
	}
	outside := kinds(f.outsider, nil)
	if len(outside) != 2 {
		t.Fatalf("outsider feed = %v", outside)
	}
	for _, kind := range outside {
		if kind != "ticket_created" && kind != "ticket_closed" {
			t.Errorf("outsider sees %s", kind)
		}
	}
	// A finance manager who is no member counts as outside.
	if got := kinds(f.finance, nil); len(got) != 2 {
		t.Fatalf("finance feed = %v", got)
	}
	inside := kinds(f.member, nil)
	for _, want := range []string{"ticket_created", "ticket_closed", "todo_done", "note_pinned", "purchase_submitted", "purchase_approved"} {
		found := false
		for _, kind := range inside {
			found = found || kind == want
		}
		if !found {
			t.Errorf("member feed lacks %s: %v", want, inside)
		}
	}
	if got := kinds(f.manager, nil); len(got) != len(inside) {
		t.Fatalf("manager feed = %v", got)
	}
	one := 1
	if got := kinds(f.member, &one); len(got) != 1 {
		t.Fatalf("limit 1 = %v", got)
	}
	for _, bad := range []int{0, 51} {
		bad := bad
		if _, err := f.service.ListActivity(ctx, f.member, f.group.ID, &bad); err == nil {
			t.Fatalf("limit %d accepted", bad)
		}
	}
	if _, err := f.service.ListActivity(ctx, f.member, uuid.New(), nil); !apperror.IsCode(err, "not_found") {
		t.Fatalf("unknown group = %v", err)
	}
	nothing, _ := principalWithPermissions(t, f.pool, "wgact-noread")
	if _, err := f.service.ListActivity(ctx, nothing, f.group.ID, nil); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("without working_groups.read = %v", err)
	}
}
