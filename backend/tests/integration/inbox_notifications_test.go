package integration_test

import (
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/inbox"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/opendays"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/privacy"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/roles"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type inboxEnv struct {
	*staffingEnv
	inbox *inbox.Service
}

func newInboxEnv(t *testing.T) *inboxEnv {
	t.Helper()
	env := newStaffingEnv(t)
	return &inboxEnv{staffingEnv: env, inbox: inbox.NewService(env.pool)}
}

// list returns the principal's notifications of one kind.
func (e *inboxEnv) kinds(p authorization.Principal, kind inbox.Kind) []inbox.Notification {
	e.t.Helper()
	page, err := e.inbox.List(testContext(e.t), p, 1, 100)
	if err != nil {
		e.t.Fatal(err)
	}
	var found []inbox.Notification
	for _, item := range page.Items {
		if item.Kind == kind {
			found = append(found, item)
		}
	}
	return found
}

func (e *inboxEnv) expectCount(p authorization.Principal, kind inbox.Kind, want int, who string) {
	e.t.Helper()
	if got := len(e.kinds(p, kind)); got != want {
		e.t.Fatalf("%s has %d %s notifications, want %d", who, got, kind, want)
	}
}

func (e *inboxEnv) disable(p authorization.Principal) {
	e.t.Helper()
	e.exec(`UPDATE accounts SET status='disabled' WHERE id=$1`, p.AccountID)
}

func (e *inboxEnv) emit(fn func(tx pgx.Tx) error) {
	e.t.Helper()
	ctx := testContext(e.t)
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		e.t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := fn(tx); err != nil {
		e.t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		e.t.Fatal(err)
	}
}

func TestInboxMessageReachesCurrentRoleHoldersAndIsScopedToEachAccount(t *testing.T) {
	e := newInboxEnv(t)
	ctx := testContext(t)
	crew := e.role("Crew", nil)
	sender := e.person("sender", e.role("Messenger", nil, authorization.NotificationsSend).ID)
	alice := e.person("alice", crew.ID)
	bob := e.person("bob", crew.ID)
	gone := e.person("gone", crew.ID)
	e.disable(gone)
	outsider := e.person("outsider")

	sent, err := e.inbox.SendMessage(ctx, sender, inbox.MessageInput{
		Title: "  Cleanup day ", Body: "Bring gloves.\r\nThanks", RoleIDs: []uuid.UUID{crew.ID, crew.ID},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if sent.Title != "Cleanup day" || sent.Body != "Bring gloves.\nThanks" || sent.RecipientCount != 2 {
		t.Fatalf("sent message = %+v", sent)
	}
	// A person who gets the role later does not receive the message: recipients are a snapshot.
	late := e.person("late", crew.ID)
	e.expectCount(late, inbox.KindMessage, 0, "late role holder")
	e.expectCount(gone, inbox.KindMessage, 0, "disabled account")
	e.expectCount(outsider, inbox.KindMessage, 0, "outsider")
	e.expectCount(alice, inbox.KindMessage, 1, "alice")
	e.expectCount(bob, inbox.KindMessage, 1, "bob")

	id := e.kinds(alice, inbox.KindMessage)[0].ID
	// Another account can neither mark nor dismiss it, exactly as if it did not exist.
	expectAppCode(t, e.inbox.MarkRead(ctx, outsider, id), "not_found")
	expectAppCode(t, e.inbox.Dismiss(ctx, outsider, id), "not_found")
	// Alice reading it leaves Bob's copy unread.
	if err := e.inbox.MarkRead(ctx, alice, id); err != nil {
		t.Fatal(err)
	}
	if err := e.inbox.MarkRead(ctx, alice, id); err != nil {
		t.Fatalf("marking a read notification again: %v", err)
	}
	if n, _ := e.inbox.UnreadCount(ctx, alice); n != 0 {
		t.Fatalf("alice unread = %d, want 0", n)
	}
	if n, _ := e.inbox.UnreadCount(ctx, bob); n != 1 {
		t.Fatalf("bob unread = %d, want 1", n)
	}
	if n, _ := e.inbox.UnreadCount(ctx, outsider); n != 0 {
		t.Fatalf("outsider unread = %d, want 0", n)
	}
	// Bob dismissing his copy keeps Alice's.
	if err := e.inbox.Dismiss(ctx, bob, id); err != nil {
		t.Fatal(err)
	}
	e.expectCount(bob, inbox.KindMessage, 0, "bob after dismissing")
	e.expectCount(alice, inbox.KindMessage, 1, "alice after bob dismissed")
	if err := e.inbox.MarkAllRead(ctx, bob); err != nil {
		t.Fatal(err)
	}

	// The sent list shows role names and counts of the recipients who kept the message.
	page, err := e.inbox.ListSent(ctx, sender, 1, 25)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 1 || len(page.Items[0].Roles) != 1 || page.Items[0].Roles[0].Name != "Crew" ||
		page.Items[0].RecipientCount != 1 || page.Items[0].ReadCount != 1 {
		t.Fatalf("sent list = %+v", page)
	}
}

func TestInboxSendingNeedsPermissionAndValidInput(t *testing.T) {
	e := newInboxEnv(t)
	ctx := testContext(t)
	crew := e.role("Crew", nil)
	member := e.person("member", crew.ID)
	empty := e.role("Nobody holds this", nil)
	sender := e.person("sender", e.role("Messenger", nil, authorization.NotificationsSend).ID)
	valid := inbox.MessageInput{Title: "Hello", Body: "Text", RoleIDs: []uuid.UUID{crew.ID}}

	_, err := e.inbox.SendMessage(ctx, member, valid, nil)
	expectAppCode(t, err, "permission_denied")
	_, err = e.inbox.ListSent(ctx, member, 1, 25)
	expectAppCode(t, err, "permission_denied")
	e.expectCount(member, inbox.KindMessage, 0, "member after a denied send")

	bad := func(mutate func(*inbox.MessageInput), code string) {
		t.Helper()
		input := valid
		mutate(&input)
		_, err := e.inbox.SendMessage(ctx, sender, input, nil)
		expectAppCode(t, err, code)
	}
	external := "//evil.example/x"
	scheme := "https://evil.example/x"
	backslash := "/\\evil.example"
	bad(func(i *inbox.MessageInput) { i.Title = "  " }, "validation_failed")
	bad(func(i *inbox.MessageInput) { i.Title = "two\nlines" }, "validation_failed")
	bad(func(i *inbox.MessageInput) { i.Body = "" }, "validation_failed")
	bad(func(i *inbox.MessageInput) { i.Body = string(make([]rune, 2001)) + "x" }, "validation_failed")
	bad(func(i *inbox.MessageInput) { i.Link = &external }, "validation_failed")
	bad(func(i *inbox.MessageInput) { i.Link = &scheme }, "validation_failed")
	bad(func(i *inbox.MessageInput) { i.Link = &backslash }, "validation_failed")
	bad(func(i *inbox.MessageInput) { i.RoleIDs = nil }, "validation_failed")
	bad(func(i *inbox.MessageInput) { i.RoleIDs = []uuid.UUID{ids.New()} }, "unknown_role")
	bad(func(i *inbox.MessageInput) { i.RoleIDs = []uuid.UUID{empty.ID} }, "no_recipients")

	path := "/open-days"
	sent, err := e.inbox.SendMessage(ctx, sender, inbox.MessageInput{
		Title: "Linked", Body: "See there", Link: &path, RoleIDs: []uuid.UUID{crew.ID},
	}, nil)
	if err != nil || sent.Link == nil || *sent.Link != path {
		t.Fatalf("send with a link: %+v, %v", sent, err)
	}
	var audited int
	if err := e.pool.QueryRow(
		ctx, `SELECT count(*) FROM audit_events WHERE action='inbox_message.sent' AND resource_id=$1 AND metadata='{}'`, sent.ID,
	).Scan(&audited); err != nil || audited != 1 {
		t.Fatalf("audit events for the message = %d, %v", audited, err)
	}
}

func TestInboxSendingIsRateLimitedPerSender(t *testing.T) {
	e := newInboxEnv(t)
	ctx := testContext(t)
	crew := e.role("Crew", nil)
	e.person("member", crew.ID)
	sender := e.person("sender", e.role("Messenger", nil, authorization.NotificationsSend).ID)
	input := inbox.MessageInput{Title: "Spam", Body: "Text", RoleIDs: []uuid.UUID{crew.ID}}
	for range 10 {
		if _, err := e.inbox.SendMessage(ctx, sender, input, nil); err != nil {
			t.Fatal(err)
		}
	}
	_, err := e.inbox.SendMessage(ctx, sender, input, nil)
	expectAppCode(t, err, "notification_rate_limited")
}

// applyRetention runs one retention handler with the delete action in its own committed transaction.
func applyRetention(t *testing.T, pool *pgxpool.Pool, handler privacy.RetentionHandler, cutoff time.Time) int64 {
	t.Helper()
	ctx := testContext(t)
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	affected, err := handler.Apply(ctx, tx, privacy.ActionDelete, cutoff, 500)
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	return affected
}

// Expired notifications are hidden from reads and removed by the retention
// handler (formerly a sweep on read).
func TestInboxExpiredNotificationsAreHiddenAndRetained(t *testing.T) {
	e := newInboxEnv(t)
	ctx := testContext(t)
	member := e.person("member")
	id := ids.New()
	e.exec(
		`INSERT INTO inbox_notifications(id,kind,title,body,created_at,expires_at)
		 VALUES($1,'message','Old','Old text',now()-interval '100 days',now()-interval '10 days')`, id,
	)
	e.exec(`INSERT INTO inbox_recipients(notification_id,account_id) VALUES($1,$2)`, id, member.AccountID)
	page, err := e.inbox.List(ctx, member, 1, 25)
	if err != nil || page.Total != 0 {
		t.Fatalf("expired notification listed: %+v, %v", page, err)
	}
	assertCount(t, e.pool, `SELECT count(*) FROM inbox_notifications WHERE id=$1`, 1, id)
	if affected := applyRetention(t, e.pool, inbox.NotificationRetention(), time.Now().Add(-90*24*time.Hour)); affected != 1 {
		t.Fatalf("retention affected %d, want 1", affected)
	}
	assertCount(t, e.pool, `SELECT count(*) FROM inbox_notifications WHERE id=$1`, 0, id)
}

func TestInboxLabRulesConfirmationRequestNotifiesConfirmersExceptTheRequester(t *testing.T) {
	e := newInboxEnv(t)
	confirmerRole := e.role("Confirmers", nil, authorization.LaborordnungConfirm)
	requester := e.person("requester", confirmerRole.ID)
	confirmer := e.person("confirmer", confirmerRole.ID)
	disabled := e.person("disabled-confirmer", confirmerRole.ID)
	e.disable(disabled)
	plain := e.person("plain", e.role("Reader", nil, authorization.LaborordnungRead).ID)
	// master holds every permission, including laborordnung.confirm.
	master := e.master

	e.emit(func(tx pgx.Tx) error {
		return inbox.NewEmitter().LabRulesConfirmationRequested(testContext(e.t), tx, requester.AccountID)
	})
	e.expectCount(confirmer, inbox.KindLabRulesConfirmationRequested, 1, "confirmer")
	e.expectCount(master, inbox.KindLabRulesConfirmationRequested, 1, "master")
	e.expectCount(requester, inbox.KindLabRulesConfirmationRequested, 0, "requester")
	e.expectCount(disabled, inbox.KindLabRulesConfirmationRequested, 0, "disabled confirmer")
	e.expectCount(plain, inbox.KindLabRulesConfirmationRequested, 0, "reader without confirm")
	item := e.kinds(confirmer, inbox.KindLabRulesConfirmationRequested)[0]
	if item.Link == nil || *item.Link != "/settings/laborordnung" {
		t.Fatalf("link = %v", item.Link)
	}
}

func TestInboxOpenDayPeriodOpeningNotifiesPeopleWithAStaffingLevel(t *testing.T) {
	e := newInboxEnv(t)
	ctx := testContext(t)
	supervisor := e.person("supervisor", e.role("Supervisors", level(roles.StaffingSupervisor)).ID)
	trainee := e.person("trainee", e.role("Trainees", level(roles.StaffingTrainee)).ID)
	plain := e.person("plain", e.role("Guests", nil).ID)
	disabled := e.person("disabled", e.role("Old supervisors", level(roles.StaffingSupervisor)).ID)
	e.disable(disabled)
	draft := e.newPeriod("Next semester", "draft", e.now.AddDate(0, 6, 0), e.now.AddDate(0, 9, 0))

	if _, err := e.opendays.TransitionPeriod(ctx, e.master, draft, 1, opendays.PeriodStaffing, nil); err != nil {
		t.Fatal(err)
	}
	e.expectCount(supervisor, inbox.KindOpenDayPeriodOpen, 1, "supervisor")
	e.expectCount(trainee, inbox.KindOpenDayPeriodOpen, 1, "trainee")
	e.expectCount(plain, inbox.KindOpenDayPeriodOpen, 0, "person without a staffing level")
	e.expectCount(disabled, inbox.KindOpenDayPeriodOpen, 0, "disabled account")
	item := e.kinds(supervisor, inbox.KindOpenDayPeriodOpen)[0]
	if item.Link == nil || *item.Link != "/open-days/"+draft.String() {
		t.Fatalf("link = %v", item.Link)
	}
	// Reopening a published period was already open for sign-up and stays quiet.
	if _, err := e.opendays.TransitionPeriod(ctx, e.master, draft, 2, opendays.PeriodPublished, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := e.opendays.TransitionPeriod(ctx, e.master, draft, 3, opendays.PeriodStaffing, nil); err != nil {
		t.Fatal(err)
	}
	e.expectCount(supervisor, inbox.KindOpenDayPeriodOpen, 1, "supervisor after reopening")
}

func TestInboxFreedSupervisorPlaceNotifiesUnassignedSupervisorsWithinTwoWeeks(t *testing.T) {
	e := newInboxEnv(t)
	ctx := testContext(t)
	supervisorRole := e.role("Supervisors", level(roles.StaffingSupervisor), authorization.OpenDaysSignup, authorization.OpenDaysRead)
	traineeRole := e.role("Trainees", level(roles.StaffingTrainee), authorization.OpenDaysSignup, authorization.OpenDaysRead)
	leaver := e.person("leaver", supervisorRole.ID)
	assigned := e.person("assigned", supervisorRole.ID)
	free := e.person("free", supervisorRole.ID)
	trainee := e.person("trainee", traineeRole.ID)
	traineeLeaver := e.person("trainee-leaver", traineeRole.ID)
	plain := e.person("plain")

	soon := e.openDay(e.now.Add(3*24*time.Hour), 4*time.Hour, 2, 2, supervisorRole.ID, traineeRole.ID)
	e.join(soon, soon.supervisorRequirement, leaver)
	e.join(soon, soon.supervisorRequirement, assigned)
	e.join(soon, soon.traineeRequirement, traineeLeaver)
	if err := e.opendays.Leave(ctx, leaver, soon.id, nil); err != nil {
		t.Fatal(err)
	}
	e.expectCount(free, inbox.KindOpenDayPlaceFreed, 1, "unassigned supervisor")
	e.expectCount(assigned, inbox.KindOpenDayPlaceFreed, 0, "already assigned supervisor")
	e.expectCount(leaver, inbox.KindOpenDayPlaceFreed, 0, "person who left")
	e.expectCount(trainee, inbox.KindOpenDayPlaceFreed, 0, "trainee")
	e.expectCount(plain, inbox.KindOpenDayPlaceFreed, 0, "person without a staffing level")
	item := e.kinds(free, inbox.KindOpenDayPlaceFreed)[0]
	if item.Link == nil || *item.Link != "/open-days/"+e.period.String()+"/days/"+soon.id.String() {
		t.Fatalf("link = %v", item.Link)
	}

	// A trainee place never triggers.
	if err := e.opendays.Leave(ctx, traineeLeaver, soon.id, nil); err != nil {
		t.Fatal(err)
	}
	e.expectCount(free, inbox.KindOpenDayPlaceFreed, 1, "unassigned supervisor after a trainee left")

	// An open day more than 14 days away stays quiet; a supervisor removed by someone else notifies as well.
	later := e.openDay(e.now.Add(20*24*time.Hour), 4*time.Hour, 2, 0, supervisorRole.ID)
	e.join(later, later.supervisorRequirement, assigned)
	if err := e.opendays.Leave(ctx, assigned, later.id, nil); err != nil {
		t.Fatal(err)
	}
	e.expectCount(free, inbox.KindOpenDayPlaceFreed, 1, "unassigned supervisor after a far-away open day")

	removed := e.openDay(e.now.Add(5*24*time.Hour), 4*time.Hour, 2, 0, supervisorRole.ID)
	e.join(removed, removed.supervisorRequirement, free)
	var assignmentID uuid.UUID
	if err := e.pool.QueryRow(ctx, `SELECT id FROM open_day_assignments WHERE open_day_id=$1`, removed.id).Scan(&assignmentID); err != nil {
		t.Fatal(err)
	}
	if err := e.opendays.RemoveAssignment(ctx, e.master, removed.id, assignmentID, nil); err != nil {
		t.Fatal(err)
	}
	e.expectCount(assigned, inbox.KindOpenDayPlaceFreed, 1, "supervisor told about the removed place")
	e.expectCount(free, inbox.KindOpenDayPlaceFreed, 1, "removed supervisor is not told")
}

func TestInboxDismissingTheLastCopyDeletesASystemNotificationButKeepsMessages(t *testing.T) {
	e := newInboxEnv(t)
	ctx := testContext(t)
	confirmerRole := e.role("Confirmers", nil, authorization.LaborordnungConfirm)
	requester := e.person("requester")
	confirmer := e.person("confirmer", confirmerRole.ID)
	e.emit(func(tx pgx.Tx) error {
		return inbox.NewEmitter().LabRulesConfirmationRequested(ctx, tx, requester.AccountID)
	})
	// Master receives it too, so both copies must go before the notification does.
	for _, p := range []authorization.Principal{confirmer, e.master} {
		item := e.kinds(p, inbox.KindLabRulesConfirmationRequested)[0]
		assertCount(t, e.pool, `SELECT count(*) FROM inbox_notifications WHERE id=$1`, 1, item.ID)
		if err := e.inbox.Dismiss(ctx, p, item.ID); err != nil {
			t.Fatal(err)
		}
	}
	assertCount(t, e.pool, `SELECT count(*) FROM inbox_notifications WHERE kind='lab_rules_confirmation_requested'`, 0)
}
