package integration_test

import (
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/testdb"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/inbox"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/laborordnung"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules"
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
	testdb.SeedNotificationRules(t, env.pool)
	return &inboxEnv{staffingEnv: env, inbox: inbox.NewService(env.pool)}
}

// kinds returns the principal's notifications of one kind. The system notifications are written by the central
// rules newInboxEnv seeds; their kind names the rule's system key, so "lab_rules_published" finds what that rule sent.
func (e *inboxEnv) kinds(p authorization.Principal, kind inbox.Kind) []inbox.Notification {
	e.t.Helper()
	page, err := e.inbox.List(testContext(e.t), p, 1, 100)
	if err != nil {
		e.t.Fatal(err)
	}
	fromRule := map[uuid.UUID]bool{}
	if kind != inbox.KindMessage {
		rows, err := e.pool.Query(
			testContext(e.t),
			`SELECT n.id FROM inbox_notifications n JOIN notification_rules r ON r.id = n.rule_id WHERE r.system_key = $1`,
			string(kind),
		)
		if err != nil {
			e.t.Fatal(err)
		}
		defer rows.Close()
		for rows.Next() {
			var id uuid.UUID
			if err := rows.Scan(&id); err != nil {
				e.t.Fatal(err)
			}
			fromRule[id] = true
		}
	}
	var found []inbox.Notification
	for _, item := range page.Items {
		if (kind == inbox.KindMessage && item.Kind == kind) || (kind != inbox.KindMessage && fromRule[item.ID]) {
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
	insecure := "http://evil.example/x"
	script := "javascript:alert(1)"
	credentials := "https://user@evil.example/x"
	noDot := "https://localhost/x"
	backslash := "/\\evil.example"
	bad(func(i *inbox.MessageInput) { i.Title = "  " }, "validation_failed")
	bad(func(i *inbox.MessageInput) { i.Title = "two\nlines" }, "validation_failed")
	bad(func(i *inbox.MessageInput) { i.Body = "" }, "validation_failed")
	bad(func(i *inbox.MessageInput) { i.Body = string(make([]rune, 2001)) + "x" }, "validation_failed")
	bad(func(i *inbox.MessageInput) { i.Link = &external }, "validation_failed")
	bad(func(i *inbox.MessageInput) { i.Link = &insecure }, "validation_failed")
	bad(func(i *inbox.MessageInput) { i.Link = &script }, "validation_failed")
	bad(func(i *inbox.MessageInput) { i.Link = &credentials }, "validation_failed")
	bad(func(i *inbox.MessageInput) { i.Link = &noDot }, "validation_failed")
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

func TestInboxLinksMayPointToOtherSitesOverHTTPS(t *testing.T) {
	e := newInboxEnv(t)
	ctx := testContext(t)
	crew := e.role("Crew", nil)
	e.person("member", crew.ID)
	sender := e.person("sender", e.role("Messenger", nil, authorization.NotificationsSend).ID)
	for given, want := range map[string]string{
		"https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ": "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ",
		"www.youtube.com/watch?v=dQw4w9WgXcQ":                            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
		" example.org ":                                                  "https://example.org",
		"/open-days":                                                     "/open-days",
	} {
		link := given
		sent, err := e.inbox.SendMessage(ctx, sender, inbox.MessageInput{
			Title: "Linked", Body: "See there", Link: &link, RoleIDs: []uuid.UUID{crew.ID},
		}, nil)
		if err != nil || sent.Link == nil || *sent.Link != want {
			t.Fatalf("link %q stored as %v, %v; want %q", given, sent.Link, err, want)
		}
	}
}

func TestInboxSentMessagesCanBeEditedAndRetracted(t *testing.T) {
	e := newInboxEnv(t)
	ctx := testContext(t)
	crew := e.role("Crew", nil)
	alice := e.person("alice", crew.ID)
	bob := e.person("bob", crew.ID)
	sender := e.person("sender", e.role("Messenger", nil, authorization.NotificationsSend).ID)
	colleague := e.person("colleague", e.role("Messenger too", nil, authorization.NotificationsSend).ID)
	sent, err := e.inbox.SendMessage(ctx, sender, inbox.MessageInput{
		Title: "Cleanup day", Body: "Bring gloves.", RoleIDs: []uuid.UUID{crew.ID},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := e.inbox.MarkRead(ctx, alice, sent.ID); err != nil {
		t.Fatal(err)
	}

	_, err = e.inbox.UpdateMessage(ctx, alice, sent.ID, inbox.MessageUpdate{Title: "x", Body: "y"}, nil)
	expectAppCode(t, err, "permission_denied")
	expectAppCode(t, e.inbox.RetractMessage(ctx, alice, sent.ID, nil), "permission_denied")
	_, err = e.inbox.UpdateMessage(ctx, sender, sent.ID, inbox.MessageUpdate{Title: " ", Body: "y"}, nil)
	expectAppCode(t, err, "validation_failed")
	_, err = e.inbox.UpdateMessage(ctx, sender, ids.New(), inbox.MessageUpdate{Title: "x", Body: "y"}, nil)
	expectAppCode(t, err, "not_found")

	// Another sender may edit it; the change reaches the read copy and the unread one alike.
	link := "www.example.org/cleanup"
	updated, err := e.inbox.UpdateMessage(ctx, colleague, sent.ID, inbox.MessageUpdate{
		Title: "Cleanup day moved", Body: "Bring gloves.", Link: &link,
	}, nil)
	if err != nil || updated.Title != "Cleanup day moved" || updated.Link == nil ||
		*updated.Link != "https://www.example.org/cleanup" || updated.RecipientCount != 2 || updated.ReadCount != 1 ||
		len(updated.Roles) != 1 || updated.SenderName == nil {
		t.Fatalf("updated message = %+v, %v", updated, err)
	}
	for _, p := range []authorization.Principal{alice, bob} {
		items := e.kinds(p, inbox.KindMessage)
		if len(items) != 1 || items[0].Title != "Cleanup day moved" || items[0].Link == nil {
			t.Fatalf("copy after the edit = %+v", items)
		}
	}
	if n, _ := e.inbox.UnreadCount(ctx, alice); n != 0 {
		t.Fatalf("editing made alice's copy unread again")
	}
	var audited []string
	rows, err := e.pool.Query(
		ctx, `SELECT changed_fields FROM audit_events WHERE action='inbox_message.updated' AND resource_id=$1`, sent.ID,
	)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var fields []string
		if err := rows.Scan(&fields); err != nil {
			t.Fatal(err)
		}
		audited = append(audited, fields...)
	}
	rows.Close()
	if len(audited) != 2 || audited[0] != "title" || audited[1] != "link" {
		t.Fatalf("audited changed fields = %v", audited)
	}
	// Editing without a change writes no audit event.
	if _, err := e.inbox.UpdateMessage(ctx, sender, sent.ID, inbox.MessageUpdate{
		Title: "Cleanup day moved", Body: "Bring gloves.", Link: &link,
	}, nil); err != nil {
		t.Fatal(err)
	}
	var unchanged int
	if err := e.pool.QueryRow(
		ctx, `SELECT count(*) FROM audit_events WHERE action='inbox_message.updated' AND resource_id=$1`, sent.ID,
	).Scan(&unchanged); err != nil || unchanged != 1 {
		t.Fatalf("audit events after an unchanged edit = %d, %v", unchanged, err)
	}

	// Retracting removes every copy, read or not, and the message from the sent list.
	if err := e.inbox.RetractMessage(ctx, colleague, sent.ID, nil); err != nil {
		t.Fatal(err)
	}
	e.expectCount(alice, inbox.KindMessage, 0, "alice after the retraction")
	e.expectCount(bob, inbox.KindMessage, 0, "bob after the retraction")
	expectAppCode(t, e.inbox.RetractMessage(ctx, sender, sent.ID, nil), "not_found")
	page, err := e.inbox.ListSent(ctx, sender, 1, 25)
	if err != nil || page.Total != 0 {
		t.Fatalf("sent list after the retraction = %+v, %v", page, err)
	}
	var retracted int
	if err := e.pool.QueryRow(
		ctx, `SELECT count(*) FROM audit_events WHERE action='inbox_message.retracted' AND resource_id=$1`, sent.ID,
	).Scan(&retracted); err != nil || retracted != 1 {
		t.Fatalf("retraction audit events = %d, %v", retracted, err)
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

// labRulesRole is a role whose holders must confirm the Lab Rules in the given mode.
func (e *inboxEnv) labRulesRole(name, mode string) roles.Role {
	e.t.Helper()
	role := e.role(name, nil)
	e.exec(`UPDATE roles SET laborordnung_mode=$2 WHERE id=$1`, role.ID, mode)
	return role
}

func TestLabRulesAnnouncementReachesPeopleWhoMustConfirmOnce(t *testing.T) {
	e := newInboxEnv(t)
	ctx := testContext(t)
	e.exec(`UPDATE mail_configuration SET enabled=true`)
	blocking := e.labRulesRole("Members", "blocking")
	warning := e.labRulesRole("Guests", "warning")
	member := e.person("member", blocking.ID)
	guest := e.person("guest", warning.ID)
	confirmed := e.person("confirmed", blocking.ID)
	disabled := e.person("disabled", blocking.ID)
	e.disable(disabled)
	plain := e.person("plain", e.role("Staff", nil).ID)
	labRules := laborordnung.NewService(e.pool, notifyrules.NewSystemEvents(nil), nil)

	// A version that was already in effect when it was published counts as announced at migration time.
	old := insertPublishedLabRulesVersionAt(t, e.pool, e.master.AccountID, "2025.1", time.Now().Add(-time.Hour))
	e.exec(`UPDATE laborordnung_versions SET announced_at=now() WHERE id=$1`, old)
	if announced, err := labRules.Announce(ctx); err != nil || announced {
		t.Fatalf("announcing an announced version = %v, %v", announced, err)
	}
	e.expectCount(member, inbox.KindLabRulesPublished, 0, "member before a new version")

	// Two versions became effective before the job ran: only the newer one is announced, the older is marked.
	insertPublishedLabRulesVersionAt(t, e.pool, e.master.AccountID, "2026.1", time.Now().Add(-10*time.Minute))
	current := insertPublishedLabRulesVersion(t, e.pool, e.master.AccountID, "2026.2")
	e.exec(`INSERT INTO laborordnung_confirmations(id,person_id,version_id,method,confirmed_at) VALUES($1,$2,$3,'app',now())`,
		ids.New(), confirmed.PersonID, current)
	announced, err := labRules.Announce(ctx)
	if err != nil || !announced {
		t.Fatalf("announce = %v, %v", announced, err)
	}
	assertCount(t, e.pool, `SELECT count(*) FROM laborordnung_versions WHERE announced_at IS NULL`, 0)
	e.expectCount(member, inbox.KindLabRulesPublished, 1, "blocking role holder")
	e.expectCount(guest, inbox.KindLabRulesPublished, 1, "warning role holder")
	e.expectCount(confirmed, inbox.KindLabRulesPublished, 0, "person who already confirmed")
	e.expectCount(disabled, inbox.KindLabRulesPublished, 0, "disabled account")
	e.expectCount(plain, inbox.KindLabRulesPublished, 0, "role without Lab Rules")
	e.expectCount(e.master, inbox.KindLabRulesPublished, 0, "master without a Lab Rules role")
	item := e.kinds(member, inbox.KindLabRulesPublished)[0]
	if item.Link == nil || *item.Link != "/lab-rules/confirm" || item.Title != "New Lab Rules" ||
		!strings.Contains(item.Body, "2026.2") {
		t.Fatalf("notification = %+v", item)
	}
	assertCount(t, e.pool, `
		SELECT count(*) FROM notification_mail_outbox m JOIN notification_firings f ON f.id = m.firing_id JOIN notification_rules r ON r.id = f.rule_id
		WHERE r.system_key='lab_rules_published' AND m.link='/lab-rules/confirm' AND m.person_id IN ($1,$2)`,
		2, member.PersonID, guest.PersonID)
	assertCount(t, e.pool, `SELECT count(*) FROM notification_mail_outbox`, 2)
	assertCount(t, e.pool, `
		SELECT count(*) FROM audit_events WHERE action='laborordnung.version.announced' AND resource_id=$1`, 1, current)

	// The next run finds nothing to announce.
	if announced, err = labRules.Announce(ctx); err != nil || announced {
		t.Fatalf("second announce = %v, %v", announced, err)
	}
	e.expectCount(member, inbox.KindLabRulesPublished, 1, "member after the second run")
	assertCount(t, e.pool, `SELECT count(*) FROM notification_mail_outbox`, 2)

	// Confirming marks the notification read.
	if _, err = labRules.ConfirmOwn(ctx, member, current, nil); err != nil {
		t.Fatal(err)
	}
	if n, _ := e.inbox.UnreadCount(ctx, member); n != 0 {
		t.Fatalf("member unread after confirming = %d, want 0", n)
	}
}

func TestLabRulesAnnouncementQueuesNoMailWhileMailIsOff(t *testing.T) {
	e := newInboxEnv(t)
	member := e.person("member", e.labRulesRole("Members", "blocking").ID)
	insertPublishedLabRulesVersion(t, e.pool, e.master.AccountID, "2026.3")
	if announced, err := laborordnung.NewService(e.pool, notifyrules.NewSystemEvents(nil), nil).Announce(testContext(t)); err != nil ||
		!announced {
		t.Fatalf("announce = %v, %v", announced, err)
	}
	e.expectCount(member, inbox.KindLabRulesPublished, 1, "member")
	assertCount(t, e.pool, `SELECT count(*) FROM notification_mail_outbox`, 0)
}

func TestInboxOpenDayPeriodOpeningNotifiesPeopleWithAStaffingLevel(t *testing.T) {
	e := newInboxEnv(t)
	ctx := testContext(t)
	supervisor := e.person("supervisor", e.role("Supervisors", level(roles.MembershipSupervisor)).ID)
	trainee := e.person("trainee", e.role("Trainees", level(roles.MembershipTrainee)).ID)
	plain := e.person("plain", e.role("Guests", nil).ID)
	disabled := e.person("disabled", e.role("Old supervisors", level(roles.MembershipSupervisor)).ID)
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
	supervisorRole := e.role("Supervisors", level(roles.MembershipSupervisor), authorization.OpenDaysSignup, authorization.OpenDaysRead)
	traineeRole := e.role("Trainees", level(roles.MembershipTrainee), authorization.OpenDaysSignup, authorization.OpenDaysRead)
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
	if err := e.opendays.Leave(ctx, leaver, soon.id, soon.timeslot, nil); err != nil {
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
	if err := e.opendays.Leave(ctx, traineeLeaver, soon.id, soon.timeslot, nil); err != nil {
		t.Fatal(err)
	}
	e.expectCount(free, inbox.KindOpenDayPlaceFreed, 1, "unassigned supervisor after a trainee left")

	// An open day more than 14 days away stays quiet; a supervisor removed by someone else notifies as well.
	later := e.openDay(e.now.Add(20*24*time.Hour), 4*time.Hour, 2, 0, supervisorRole.ID)
	e.join(later, later.supervisorRequirement, assigned)
	if err := e.opendays.Leave(ctx, assigned, later.id, later.timeslot, nil); err != nil {
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
	members := e.labRulesRole("Members", "warning")
	first := e.person("first", members.ID)
	second := e.person("second", members.ID)
	version := insertPublishedLabRulesVersion(t, e.pool, e.master.AccountID, "2026.4")
	e.emit(func(tx pgx.Tx) error {
		return notifyrules.NewSystemEvents(nil).LabRulesPublished(ctx, tx, version)
	})
	// Both copies must go before the notification does.
	for _, p := range []authorization.Principal{first, second} {
		item := e.kinds(p, inbox.KindLabRulesPublished)[0]
		assertCount(t, e.pool, `SELECT count(*) FROM inbox_notifications WHERE id=$1`, 1, item.ID)
		if err := e.inbox.Dismiss(ctx, p, item.ID); err != nil {
			t.Fatal(err)
		}
	}
	assertCount(t, e.pool, `SELECT count(*) FROM inbox_notifications WHERE kind='lab_rules_published'`, 0)
}
