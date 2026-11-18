package integration_test

import (
	"net/http"
	"slices"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/signage"
	"github.com/google/uuid"
)

type noticeOptInEnv struct {
	*signageEnv
	manager    staffSession
	author     staffSession
	rules      *notifyrules.Service
	dispatcher *notifyrules.Dispatcher
	category   uuid.UUID
	list       []signage.SceneListItem
	tokens     int
}

func newNoticeOptInEnv(t *testing.T) *noticeOptInEnv {
	t.Helper()
	env := newSignageEnv(t)
	_, list := env.seedContent("Opt-in")
	e := &noticeOptInEnv{
		signageEnv: env,
		manager:    env.allStaff(),
		author: env.staff("opt-in-author", authorization.NotificationRulesManage, authorization.NotificationRulesRead,
			authorization.SignageRead, authorization.MachinesRead),
		rules:      notifyrules.NewService(env.pool),
		dispatcher: notifyrules.NewDispatcher(env.pool, time.UTC),
		list:       list,
	}
	if err := env.pool.QueryRow(testContext(t), `SELECT id FROM notification_categories WHERE key='service'`).Scan(&e.category); err != nil {
		t.Fatal(err)
	}
	return e
}

// rule creates a central printer-error rule whose only action is a signage notice (or, without one, an in-app one).
func (e *noticeOptInEnv) rule(name string, withSignage bool) notifyrules.Rule {
	e.t.Helper()
	input := eventRule("printer_error", "operator")
	input.Name = name
	input.CategoryID = &e.category
	if withSignage {
		input.Definition.Actions = []notifyrules.Action{signageAction(notifyrules.ToneWarning, 5)}
	}
	rule, err := e.rules.CreateRule(testContext(e.t), e.author.principal, input, nil)
	if err != nil {
		e.t.Fatalf("create rule: %v", err)
	}
	return rule
}

// fire delivers a printer error and returns the token that resolves it.
func (e *noticeOptInEnv) fire() string {
	e.t.Helper()
	e.tokens++
	token := "opt-in:" + uuid.NewString()
	event := noticeEvent(token)
	event.OccurredAt = time.Now().UTC()
	ctx := testContext(e.t)
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		e.t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err = e.dispatcher.Emit(ctx, tx, event); err != nil {
		e.t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		e.t.Fatal(err)
	}
	return token
}

func (e *noticeOptInEnv) optIn(kind, id string, allRules bool, ruleIDs ...uuid.UUID) map[string]any {
	e.t.Helper()
	list := []string{}
	for _, rule := range ruleIDs {
		list = append(list, rule.String())
	}
	return e.expect(e.as(e.manager, http.MethodPut, "/signage/"+kind+"/"+id+"/notices",
		map[string]any{"allRules": allRules, "ruleIds": list}), http.StatusOK)
}

func (e *noticeOptInEnv) shown(player *http.Client) int {
	return len(liveRuleNotices(e.signageEnv, player))
}

func (e *noticeOptInEnv) leaveGroup(display map[string]any) {
	e.t.Helper()
	e.expect(e.as(e.manager, http.MethodPut, "/signage/displays/"+display["id"].(string),
		displayUpdate(display, e.displayVersion(e.manager, display["id"].(string)), nil, []any{}, 16, 9)), http.StatusOK)
}

func (e *noticeOptInEnv) joinGroup(display map[string]any, groupID string) {
	e.t.Helper()
	e.expect(e.as(e.manager, http.MethodPut, "/signage/displays/"+display["id"].(string),
		displayUpdate(display, e.displayVersion(e.manager, display["id"].(string)), groupID, []any{}, 16, 9)), http.StatusOK)
}

func TestSignageNoticeOptInDisplayShowsAndOthersDoNot(t *testing.T) {
	e := newNoticeOptInEnv(t)
	rule := e.rule("Wall rule", true)
	e.rule("Other rule", true)
	chosen, chosenPlayer := e.pair(e.manager, "Opted in", e.list)
	_, plainPlayer := e.pair(e.manager, "Not opted in", e.list)

	selection := e.optIn("displays", chosen["id"].(string), false, rule.ID)
	if selection["allRules"] != false || len(selection["ruleIds"].([]any)) != 1 || selection["ruleIds"].([]any)[0] != rule.ID.String() {
		t.Fatalf("selection = %v", selection)
	}
	got := e.expect(e.as(e.manager, http.MethodGet, "/signage/displays/"+chosen["id"].(string)+"/notices", nil), http.StatusOK)
	if got["allRules"] != false || len(got["ruleIds"].([]any)) != 1 {
		t.Fatalf("read back = %v", got)
	}

	e.fire()
	if n := e.shown(chosenPlayer); n != 1 {
		t.Fatalf("opted-in display shows %d notices, want 1", n)
	}
	if n := e.shown(plainPlayer); n != 0 {
		t.Fatalf("display that did not opt in shows %d notices", n)
	}
	// Replacing the choice takes the notice off at once: the choice is live.
	e.optIn("displays", chosen["id"].(string), false)
	if n := e.shown(chosenPlayer); n != 0 {
		t.Fatalf("display shows %d notices after dropping its choice", n)
	}
}

func TestSignageNoticeOptInOnlyForTheChosenRule(t *testing.T) {
	e := newNoticeOptInEnv(t)
	chosenRule := e.rule("Chosen rule", true)
	e.rule("Ignored rule", true)
	display, player := e.pair(e.manager, "Picky", e.list)
	e.optIn("displays", display["id"].(string), false, chosenRule.ID)
	e.fire() // both rules fire on the same event; only the chosen rule's notice shows
	notices := liveRuleNotices(e.signageEnv, player)
	if len(notices) != 1 {
		t.Fatalf("notices = %v, want one", notices)
	}
}

func TestSignageNoticeOptInGroupReachesMembersAndFollowsMembership(t *testing.T) {
	e := newNoticeOptInEnv(t)
	rule := e.rule("Group rule", true)
	group := e.createGroup(e.manager, "Notice group", e.list)
	groupID := group["id"].(string)
	_, memberPlayer := e.pairInto(e.manager, "Member", groupID)
	_, outsidePlayer := e.pair(e.manager, "Outside", e.list)
	late, latePlayer := e.pair(e.manager, "Late joiner", e.list)

	e.optIn("groups", groupID, false, rule.ID)
	got := e.expect(e.as(e.manager, http.MethodGet, "/signage/groups/"+groupID+"/notices", nil), http.StatusOK)
	if len(got["ruleIds"].([]any)) != 1 {
		t.Fatalf("group choice = %v", got)
	}
	e.fire()
	if e.shown(memberPlayer) != 1 {
		t.Fatal("group member does not show the notice")
	}
	if e.shown(outsidePlayer) != 0 || e.shown(latePlayer) != 0 {
		t.Fatal("a display outside the group shows the notice")
	}

	// Joining after the delivery picks up the live notice; leaving drops it again.
	e.joinGroup(late, groupID)
	if e.shown(latePlayer) != 1 {
		t.Fatal("display that joined the opted-in group after delivery does not show the live notice")
	}
	late = e.expect(e.as(e.manager, http.MethodGet, "/signage/displays/"+late["id"].(string), nil), http.StatusOK)
	e.leaveGroup(late)
	if e.shown(latePlayer) != 0 {
		t.Fatal("display that left the group still shows its notice")
	}
}

func TestSignageNoticeOptInAllRules(t *testing.T) {
	e := newNoticeOptInEnv(t)
	e.rule("First", true)
	e.rule("Second", true)
	displayAll, displayPlayer := e.pair(e.manager, "All on display", e.list)
	_, plainPlayer := e.pair(e.manager, "Plain", e.list)
	group := e.createGroup(e.manager, "All group", e.list)
	_, memberPlayer := e.pairInto(e.manager, "All group member", group["id"].(string))

	e.optIn("displays", displayAll["id"].(string), true)
	e.optIn("groups", group["id"].(string), true)
	got := e.expect(e.as(e.manager, http.MethodGet, "/signage/displays/"+displayAll["id"].(string)+"/notices", nil), http.StatusOK)
	if got["allRules"] != true {
		t.Fatalf("display choice = %v", got)
	}
	e.fire()
	if n := e.shown(displayPlayer); n != 2 {
		t.Fatalf("display with allRules shows %d notices, want 2", n)
	}
	if n := e.shown(memberPlayer); n != 2 {
		t.Fatalf("member of group with allRules shows %d notices, want 2", n)
	}
	if n := e.shown(plainPlayer); n != 0 {
		t.Fatalf("plain display shows %d notices", n)
	}
}

func TestSignageNoticeOptInUnionOfDisplayAndGroup(t *testing.T) {
	e := newNoticeOptInEnv(t)
	byDisplay := e.rule("By display", true)
	byGroup := e.rule("By group", true)
	e.rule("By nobody", true)
	group := e.createGroup(e.manager, "Union group", e.list)
	member, memberPlayer := e.pairInto(e.manager, "Union member", group["id"].(string))
	e.optIn("displays", member["id"].(string), false, byDisplay.ID)
	e.optIn("groups", group["id"].(string), false, byGroup.ID)
	e.fire()
	if n := e.shown(memberPlayer); n != 2 {
		t.Fatalf("member shows %d notices, want its own and its group's (2)", n)
	}
	// A rule both chose still shows once.
	e.optIn("groups", group["id"].(string), false, byGroup.ID, byDisplay.ID)
	if n := e.shown(memberPlayer); n != 2 {
		t.Fatalf("member shows %d notices with an overlapping choice, want 2", n)
	}
}

func TestSignageNoticeOptInsGoWithTheirOwners(t *testing.T) {
	e := newNoticeOptInEnv(t)
	rule := e.rule("Doomed rule", true)
	keep := e.rule("Kept rule", true)
	display, player := e.pair(e.manager, "Doomed display", e.list)
	other, _ := e.pair(e.manager, "Surviving display", e.list)
	group := e.createGroup(e.manager, "Doomed group", e.list)
	e.optIn("displays", display["id"].(string), false, rule.ID, keep.ID)
	e.optIn("displays", other["id"].(string), false, rule.ID)
	e.optIn("groups", group["id"].(string), false, rule.ID)
	e.fire()
	if e.shown(player) != 2 {
		t.Fatal("setup: display should show both notices")
	}

	// Deleting the rule removes its opt-ins and its notices.
	if err := e.rules.DeleteRule(testContext(t), e.author.principal, rule.ID, rule.Version, nil); err != nil {
		t.Fatal(err)
	}
	if n := e.count(`SELECT count(*) FROM signage_notice_opt_ins WHERE rule_id = $1`, rule.ID); n != 0 {
		t.Fatalf("%d opt-ins left after the rule was deleted", n)
	}
	if n := e.count(`SELECT count(*) FROM signage_rule_notices WHERE rule_id = $1`, rule.ID); n != 0 {
		t.Fatalf("%d notices left after the rule was deleted", n)
	}
	if e.shown(player) != 1 {
		t.Fatal("the other rule's notice should stay")
	}
	got := e.expect(e.as(e.manager, http.MethodGet, "/signage/displays/"+display["id"].(string)+"/notices", nil), http.StatusOK)
	if ids := got["ruleIds"].([]any); len(ids) != 1 || ids[0] != keep.ID.String() {
		t.Fatalf("display choice after rule deletion = %v", got)
	}

	// Deleting a group removes its opt-ins (the group is empty here), and so does deleting a display.
	e.optIn("groups", group["id"].(string), false, keep.ID)
	if n := e.count(`SELECT count(*) FROM signage_notice_opt_ins WHERE group_id = $1::uuid`, group["id"]); n != 1 {
		t.Fatalf("group opt-ins = %d, want 1", n)
	}
	e.expect(e.as(e.manager, http.MethodDelete, "/signage/groups/"+group["id"].(string),
		map[string]any{"expectedVersion": e.groupVersion(e.manager, group["id"].(string))}), http.StatusNoContent)
	if n := e.count(`SELECT count(*) FROM signage_notice_opt_ins WHERE group_id = $1::uuid`, group["id"]); n != 0 {
		t.Fatalf("%d group opt-ins left after the group was deleted", n)
	}
	e.expect(e.as(e.manager, http.MethodDelete, "/signage/displays/"+display["id"].(string),
		map[string]any{"expectedVersion": e.displayVersion(e.manager, display["id"].(string))}), http.StatusNoContent)
	if n := e.count(`SELECT count(*) FROM signage_notice_opt_ins WHERE display_id = $1::uuid`, display["id"]); n != 0 {
		t.Fatalf("%d display opt-ins left after the display was deleted", n)
	}
	if n := e.count(`SELECT count(*) FROM signage_notice_opt_ins WHERE display_id = $1::uuid`, other["id"]); n != 0 {
		// The surviving display chose only the deleted rule, which cascaded away.
		t.Fatalf("surviving display kept %d opt-ins of the deleted rule", n)
	}
}

func TestSignageNotificationRuleListAndShownOn(t *testing.T) {
	e := newNoticeOptInEnv(t)
	wall := e.rule("Listed signage rule", true)
	e.rule("Central without signage", false)
	subscriber := e.signageEnv.staff("opt-in-subscriber", authorization.MachinesRead).principal
	if _, err := e.rules.CreateSubscription(testContext(t), subscriber, eventRule("printer_error", "me"), nil); err != nil {
		t.Fatal(err)
	}
	display, _ := e.pair(e.manager, "Shown on display", e.list)
	group := e.createGroup(e.manager, "Shown on group", e.list)
	everything, _ := e.pair(e.manager, "Shown on all", e.list)
	e.optIn("displays", display["id"].(string), false, wall.ID)
	e.optIn("groups", group["id"].(string), false, wall.ID)
	e.optIn("displays", everything["id"].(string), true)

	list := e.expect(e.as(e.author, http.MethodGet, "/signage/notification-rules", nil), http.StatusOK)
	names := []string{}
	for _, item := range list["items"].([]any) {
		rule := item.(map[string]any)
		if rule["hasSignageAction"] != true {
			t.Fatalf("listed rule without signage action: %v", rule)
		}
		names = append(names, rule["name"].(string))
	}
	if !slices.Contains(names, "Listed signage rule") || slices.Contains(names, "Central without signage") ||
		slices.Contains(names, "Rule on printer_error") {
		t.Fatalf("listed rules = %v", names)
	}

	got := e.expect(e.as(e.author, http.MethodGet, "/notification-rules/"+wall.ID.String(), nil), http.StatusOK)
	shown := got["signageShownOn"].(map[string]any)
	displays, groups := shown["displays"].([]any), shown["groups"].([]any)
	if len(groups) != 1 || groups[0].(map[string]any)["name"] != "Shown on group" || groups[0].(map[string]any)["allRules"] != false {
		t.Fatalf("shown on groups = %v", groups)
	}
	byName := map[string]bool{}
	for _, item := range displays {
		d := item.(map[string]any)
		byName[d["name"].(string)] = d["allRules"].(bool)
	}
	if len(byName) != 2 || byName["Shown on display"] || !byName["Shown on all"] {
		t.Fatalf("shown on displays = %v", displays)
	}

	// A rule without a signage action carries no signageShownOn.
	plain := e.rule("Plain central", false)
	got = e.expect(e.as(e.author, http.MethodGet, "/notification-rules/"+plain.ID.String(), nil), http.StatusOK)
	if _, ok := got["signageShownOn"]; ok {
		t.Fatalf("rule without signage action has signageShownOn: %v", got["signageShownOn"])
	}
}

func TestSignageNoticeSelectionRefusals(t *testing.T) {
	e := newNoticeOptInEnv(t)
	display, _ := e.pair(e.manager, "Refusing display", e.list)
	group := e.createGroup(e.manager, "Refusing group", e.list)
	plain := e.rule("Refused central without signage", false)
	personal, err := e.rules.CreateSubscription(
		testContext(t), e.signageEnv.staff("refusal-subscriber", authorization.MachinesRead).principal, eventRule("printer_error", "me"), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []struct{ path, id string }{{"displays", display["id"].(string)}, {"groups", group["id"].(string)}} {
		path := "/signage/" + kind.path + "/" + kind.id + "/notices"
		e.expectCode(e.as(e.manager, http.MethodPut, path,
			map[string]any{"allRules": false, "ruleIds": []string{uuid.Must(uuid.NewV7()).String()}}),
			http.StatusUnprocessableEntity, "validation_failed")
		e.expectCode(e.as(e.manager, http.MethodPut, path,
			map[string]any{"allRules": false, "ruleIds": []string{personal.ID.String()}}),
			http.StatusUnprocessableEntity, "validation_failed")
		// A central rule without a signage action cannot be newly chosen, so choosing does not reveal other rules.
		e.expectCode(e.as(e.manager, http.MethodPut, path,
			map[string]any{"allRules": false, "ruleIds": []string{plain.ID.String()}}),
			http.StatusUnprocessableEntity, "validation_failed")
		if n := e.count(`SELECT count(*) FROM signage_notice_opt_ins`); n != 0 {
			t.Fatalf("a refused choice stored %d opt-ins", n)
		}
		unknown := "/signage/" + kind.path + "/" + uuid.Must(uuid.NewV7()).String() + "/notices"
		e.expectCode(e.as(e.manager, http.MethodGet, unknown, nil), http.StatusNotFound, "not_found")
		e.expectCode(e.as(e.manager, http.MethodPut, unknown, map[string]any{"allRules": true, "ruleIds": []string{}}),
			http.StatusNotFound, "not_found")
	}

	// A rule that lost its signage action after it was chosen stays choosable for that display, and is listed as such.
	if _, err := e.pool.Exec(testContext(t), `INSERT INTO signage_notice_opt_ins (id, rule_id, display_id) VALUES ($1, $2, $3::uuid)`,
		uuid.Must(uuid.NewV7()), plain.ID, display["id"]); err != nil {
		t.Fatal(err)
	}
	e.optIn("displays", display["id"].(string), false, plain.ID)
	listed := e.expect(e.as(e.manager, http.MethodGet, "/signage/notification-rules", nil), http.StatusOK)
	found := false
	for _, item := range listed["items"].([]any) {
		rule := item.(map[string]any)
		if rule["id"] == plain.ID.String() {
			found = rule["hasSignageAction"] == false
		}
	}
	if !found {
		t.Fatalf("stale choice not listed without signage action: %v", listed["items"])
	}
	e.expectCode(e.as(e.manager, http.MethodPut, "/signage/groups/"+group["id"].(string)+"/notices",
		map[string]any{"allRules": false, "ruleIds": []string{plain.ID.String()}}),
		http.StatusUnprocessableEntity, "validation_failed")

	embed := e.createEmbed(e.manager, "Embed", e.list)
	e.expectCode(e.as(e.manager, http.MethodPut, "/signage/displays/"+embed["id"].(string)+"/notices",
		map[string]any{"allRules": true, "ruleIds": []string{}}), http.StatusUnprocessableEntity, "signage_web_embed")
}

func TestSignageNoticeSelectionIsAudited(t *testing.T) {
	e := newNoticeOptInEnv(t)
	rule := e.rule("Audited rule", true)
	display, _ := e.pair(e.manager, "Audited display", e.list)
	group := e.createGroup(e.manager, "Audited group", e.list)
	e.optIn("displays", display["id"].(string), false, rule.ID)
	e.optIn("groups", group["id"].(string), true)
	if n := e.count(`SELECT count(*) FROM audit_events WHERE action = 'signage_display.notices_changed'
		AND resource_id = $1::uuid AND actor_account_id = $2 AND 'notices' = ANY(changed_fields)`,
		display["id"], e.manager.account.accountID); n != 1 {
		t.Fatalf("display audit events = %d, want 1", n)
	}
	if n := e.count(`SELECT count(*) FROM audit_events WHERE action = 'signage_display_group.notices_changed'
		AND resource_id = $1::uuid`, group["id"]); n != 1 {
		t.Fatalf("group audit events = %d, want 1", n)
	}
}

func TestSignageNoticeSelectionPermissions(t *testing.T) {
	e := newNoticeOptInEnv(t)
	display, _ := e.pair(e.manager, "Guarded display", e.list)
	group := e.createGroup(e.manager, "Guarded group", e.list)
	nobody := e.staff("no-signage", authorization.MachinesRead)
	reader := e.staff("signage-reader", authorization.SignageRead)
	displayPath := "/signage/displays/" + display["id"].(string) + "/notices"
	groupPath := "/signage/groups/" + group["id"].(string) + "/notices"
	body := map[string]any{"allRules": true, "ruleIds": []string{}}

	for _, path := range []string{displayPath, groupPath, "/signage/notification-rules"} {
		e.expectCode(e.as(nobody, http.MethodGet, path, nil), http.StatusForbidden, "permission_denied")
		e.expect(e.as(reader, http.MethodGet, path, nil), http.StatusOK)
	}
	for _, path := range []string{displayPath, groupPath} {
		e.expectCode(e.as(nobody, http.MethodPut, path, body), http.StatusForbidden, "permission_denied")
		e.expectCode(e.as(reader, http.MethodPut, path, body), http.StatusForbidden, "permission_denied")
	}
	if n := e.count(`SELECT count(*) FROM signage_displays WHERE all_rule_notices`) +
		e.count(`SELECT count(*) FROM signage_display_groups WHERE all_rule_notices`); n != 0 {
		t.Fatalf("a refused choice changed %d rows", n)
	}
	if n := e.countAudit("signage_display.notices_changed") + e.countAudit("signage_display_group.notices_changed"); n != 0 {
		t.Fatalf("refused choices wrote %d audit events", n)
	}
}
