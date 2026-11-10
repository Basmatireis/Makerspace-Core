package integration_test

import (
	"net/http"
	"slices"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/signage"
	"github.com/google/uuid"
)

// createGroup creates a 16:9 group through the API.
func (e *signageEnv) createGroup(staff staffSession, name string, defaults []signage.SceneListItem) map[string]any {
	e.t.Helper()
	return e.expect(e.as(staff, http.MethodPost, "/signage/groups", map[string]any{
		"name": name, "aspectRatio": map[string]any{"width": 16, "height": 9}, "defaultScenes": defaults,
	}), http.StatusCreated)
}

// pairInto pairs a 16:9 display straight into a group.
func (e *signageEnv) pairInto(staff staffSession, name, groupID string) (map[string]any, *http.Client) {
	e.t.Helper()
	player := e.newPlayer()
	start := e.expect(e.do(player, "", http.MethodPost, "/public/signage/pairing", nil), http.StatusCreated)
	display := e.expect(e.as(staff, http.MethodPost, "/signage/displays", map[string]any{
		"code": start["code"], "name": name, "location": "Hall", "aspectRatio": map[string]any{"width": 16, "height": 9},
		"visibleFromOutside": false, "defaultScenes": []any{}, "groupId": groupID,
	}), http.StatusCreated)
	if display["groupId"] != groupID || len(display["defaultScenes"].([]any)) != 0 {
		e.t.Fatalf("paired member = %v", display)
	}
	e.expect(e.do(player, "", http.MethodGet, "/public/signage/pairing", nil), http.StatusOK)
	return display, player
}

func (e *signageEnv) groupVersion(staff staffSession, id string) int64 {
	e.t.Helper()
	return int64(e.expect(e.as(staff, http.MethodGet, "/signage/groups/"+id, nil), http.StatusOK)["version"].(float64))
}

// displayUpdate is the PUT body of a display with the given group and default list.
func displayUpdate(display map[string]any, version int64, groupID any, defaults any, width, height int) map[string]any {
	return map[string]any{
		"expectedVersion": version, "name": display["name"], "location": display["location"],
		"aspectRatio":        map[string]any{"width": width, "height": height},
		"visibleFromOutside": false, "defaultScenes": defaults, "groupId": groupID,
	}
}

func groupRuleBody(version int64, scenes []signage.SceneListItem) map[string]any {
	return map[string]any{
		"expectedVersion": version, "enabled": true, "conditionKind": "time_window",
		"weekdays": []int{1, 2, 3, 4, 5}, "timeFrom": "08:00", "timeTo": "18:00",
		"scenes": scenes, "minSeconds": 20, "multiMode": "split", "alternateSeconds": 10,
	}
}

func (e *signageEnv) count(query string, args ...any) int {
	e.t.Helper()
	var n int
	if err := e.pool.QueryRow(testContext(e.t), query, args...).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n
}

func pendingKinds(object map[string]any) []string {
	var kinds []string
	for _, item := range object["pendingChanges"].([]any) {
		change := item.(map[string]any)
		kinds = append(kinds, change["kind"].(string)+":"+change["name"].(string)+":"+change["change"].(string))
	}
	return kinds
}

func TestSignageGroupPermissions(t *testing.T) {
	e := newSignageEnv(t)
	all := e.allStaff()
	_, defaults := e.seedContent("Perm")
	group := e.createGroup(all, "Hall", defaults)
	groupID := group["id"].(string)
	base := "/signage/groups/" + groupID
	e.pairInto(all, "Member", groupID)

	none := e.staff("none")
	reader := e.staff("reader", authorization.SignageRead)
	manager := e.staff("manager", authorization.SignageRead, authorization.SignageManage)
	publisher := e.staff("publisher", authorization.SignageRead, authorization.SignagePublish)

	for _, path := range []string{"/signage/groups", base, base + "/rules", base + "/preview"} {
		e.expectCode(e.as(none, http.MethodGet, path, nil), http.StatusForbidden, "permission_denied")
		e.expect(e.as(reader, http.MethodGet, path, nil), http.StatusOK)
	}
	create := map[string]any{"name": "Other", "aspectRatio": map[string]any{"width": 16, "height": 9}, "defaultScenes": defaults}
	for _, denied := range []staffSession{reader, publisher} {
		e.expectCode(e.as(denied, http.MethodPost, "/signage/groups", create), http.StatusForbidden, "permission_denied")
		e.expectCode(
			e.as(denied, http.MethodPost, base+"/rules", groupRuleBody(e.groupVersion(all, groupID), defaults)),
			http.StatusForbidden, "permission_denied",
		)
		e.expectCode(e.as(denied, http.MethodPut, base, map[string]any{
			"expectedVersion": e.groupVersion(all, groupID), "name": "Renamed",
			"aspectRatio": map[string]any{"width": 16, "height": 9}, "defaultScenes": defaults,
		}), http.StatusForbidden, "permission_denied")
		e.expectCode(
			e.as(denied, http.MethodDelete, base, map[string]any{"expectedVersion": e.groupVersion(all, groupID)}),
			http.StatusForbidden, "permission_denied",
		)
	}
	for _, denied := range []staffSession{reader, manager} {
		e.expectCode(e.as(denied, http.MethodPost, base+"/publish", nil), http.StatusForbidden, "permission_denied")
	}
	other := e.expect(e.as(manager, http.MethodPost, "/signage/groups", create), http.StatusCreated)
	rules := e.expect(
		e.as(manager, http.MethodPost, base+"/rules", groupRuleBody(e.groupVersion(all, groupID), defaults)),
		http.StatusCreated,
	)
	ruleID := rules["items"].([]any)[0].(map[string]any)["id"].(string)
	e.expect(e.as(manager, http.MethodPatch, base+"/rules/"+ruleID, map[string]any{
		"expectedVersion": rules["ownerVersion"], "enabled": false,
	}), http.StatusOK)
	e.expect(e.as(publisher, http.MethodPost, base+"/publish", nil), http.StatusOK)
	e.expect(e.as(manager, http.MethodDelete, "/signage/groups/"+other["id"].(string), map[string]any{
		"expectedVersion": other["version"],
	}), http.StatusNoContent)
}

func TestSignageGroupMembershipRulesAndReferences(t *testing.T) {
	e := newSignageEnv(t)
	ctx := testContext(t)
	staff := e.allStaff()
	sceneA, defaults := e.seedContent("A")
	sceneB := e.fixture.scene(t, "B scene")
	portraitInput := sceneInput("Portrait")
	portraitInput.AspectRatio = signage.AspectRatio{Width: 9, Height: 16}
	portrait, err := e.fixture.service.CreateScene(ctx, e.fixture.admin, portraitInput, nil)
	if err != nil {
		t.Fatal(err)
	}

	// Create, validate, rename.
	e.expectCode(e.as(staff, http.MethodPost, "/signage/groups", map[string]any{
		"name": "Bad", "aspectRatio": map[string]any{"width": 9, "height": 16}, "defaultScenes": defaults,
	}), http.StatusUnprocessableEntity, "validation_failed")
	group := e.createGroup(staff, "  Workshop  ", defaults)
	groupID := group["id"].(string)
	if group["name"] != "Workshop" || !hasAspectRatio(group, 16, 9) || len(group["displayIds"].([]any)) != 0 ||
		group["version"] != float64(1) || len(group["pendingChanges"].([]any)) != 0 {
		t.Fatalf("created group = %v", group)
	}
	portraitGroup := e.expect(e.as(staff, http.MethodPost, "/signage/groups", map[string]any{
		"name": "Portrait", "aspectRatio": map[string]any{"width": 9, "height": 16}, "defaultScenes": sceneList(portrait.ID),
	}), http.StatusCreated)
	listed := e.expect(e.as(staff, http.MethodGet, "/signage/groups", nil), http.StatusOK)["items"].([]any)
	if len(listed) != 2 || listed[0].(map[string]any)["name"] != "Portrait" {
		t.Fatalf("groups = %v", listed)
	}

	// A standalone display with a rule of its own.
	display, _ := e.pair(staff, "Bench", defaults)
	displayID := display["id"].(string)
	displayBase := "/signage/displays/" + displayID
	e.expect(e.as(staff, http.MethodPost, displayBase+"/rules",
		groupRuleBody(e.displayVersion(staff, displayID), sceneList(sceneB.ID))), http.StatusCreated)

	// Joining needs the group's ratio and an empty default list.
	e.expectCode(e.as(staff, http.MethodPut, displayBase,
		displayUpdate(display, e.displayVersion(staff, displayID), portraitGroup["id"], []any{}, 16, 9)),
		http.StatusUnprocessableEntity, "validation_failed")
	e.expectCode(e.as(staff, http.MethodPut, displayBase,
		displayUpdate(display, e.displayVersion(staff, displayID), groupID, defaults, 16, 9)),
		http.StatusUnprocessableEntity, "validation_failed")
	e.expectCode(e.as(staff, http.MethodPut, displayBase,
		displayUpdate(display, e.displayVersion(staff, displayID), nil, []any{}, 16, 9)),
		http.StatusUnprocessableEntity, "validation_failed")
	joined := e.expect(e.as(staff, http.MethodPut, displayBase,
		displayUpdate(display, e.displayVersion(staff, displayID), groupID, []any{}, 16, 9)), http.StatusOK)
	if joined["groupId"] != groupID || len(joined["defaultScenes"].([]any)) != 0 {
		t.Fatalf("joined display = %v", joined)
	}
	if n := e.count(`SELECT count(*) FROM signage_rules WHERE display_id = $1`, displayID); n != 0 {
		t.Fatalf("display kept %d own rules after joining", n)
	}
	if n := e.count(`SELECT count(*) FROM signage_default_scenes WHERE display_id = $1`, displayID); n != 0 {
		t.Fatalf("display kept %d own default items after joining", n)
	}
	if n := e.count(`SELECT count(*) FROM audit_events WHERE action = 'signage_display.updated' AND resource_id = $1
		AND 'groupId' = ANY(changed_fields)`, displayID); n != 1 {
		t.Fatalf("join audit rows = %d", n)
	}
	// A member keeps the group's ratio.
	e.expectCode(e.as(staff, http.MethodPut, displayBase,
		displayUpdate(joined, e.displayVersion(staff, displayID), groupID, []any{}, 9, 16)),
		http.StatusUnprocessableEntity, "validation_failed")

	// Display rule writes conflict while in a group; reads show the group's rules.
	e.expectCode(e.as(staff, http.MethodPost, displayBase+"/rules",
		groupRuleBody(e.displayVersion(staff, displayID), defaults)), http.StatusConflict, "display_in_group")
	e.expectCode(e.as(staff, http.MethodPut, displayBase+"/rule-order", map[string]any{
		"expectedVersion": e.displayVersion(staff, displayID), "ruleIds": []string{},
	}), http.StatusConflict, "display_in_group")
	groupRules := e.expect(e.as(staff, http.MethodPost, "/signage/groups/"+groupID+"/rules",
		groupRuleBody(e.groupVersion(staff, groupID), sceneList(sceneB.ID))), http.StatusCreated)
	if groupRules["ownerVersion"] != float64(2) || len(groupRules["items"].([]any)) != 1 {
		t.Fatalf("group rules = %v", groupRules)
	}
	groupRuleID := groupRules["items"].([]any)[0].(map[string]any)["id"].(string)
	viaDisplay := e.expect(e.as(staff, http.MethodGet, displayBase+"/rules", nil), http.StatusOK)
	if viaDisplay["ownerVersion"] != groupRules["ownerVersion"] ||
		viaDisplay["items"].([]any)[0].(map[string]any)["id"] != groupRuleID {
		t.Fatalf("display rules of a member = %v", viaDisplay)
	}
	if got := e.expect(e.as(staff, http.MethodGet, "/signage/groups/"+groupID, nil), http.StatusOK); len(got["displayIds"].([]any)) != 1 ||
		got["displayIds"].([]any)[0] != displayID {
		t.Fatalf("group members = %v", got)
	}
	// Group rules carry the group in their audit rows.
	if n := e.count(`SELECT count(*) FROM audit_events WHERE action = 'signage_rule.created' AND resource_id = $1
		AND 'groupId' = ANY(changed_fields)`, groupRuleID); n != 1 {
		t.Fatalf("group rule audit rows = %d", n)
	}

	// Scenes used by the group are referenced as kind group; their ratio cannot change.
	expectInUse(t, e.fixture.service.DeleteScene(ctx, e.fixture.admin, sceneB.ID, sceneB.Version, nil), "group")
	changed := sceneInput("B scene")
	changed.AspectRatio = signage.AspectRatio{Width: 9, Height: 16}
	if _, err := e.fixture.service.UpdateScene(ctx, e.fixture.admin, sceneB.ID, sceneB.Version, changed, nil); err == nil {
		t.Fatal("scene ratio changed while a group rule shows it")
	}
	if err := e.fixture.service.DeleteScene(ctx, e.fixture.admin, sceneA.ID, sceneA.Version, nil); err == nil {
		t.Fatal("scene in a group default list was deleted")
	}

	// The group cannot change its ratio or be deleted while it has members.
	e.expectCode(e.as(staff, http.MethodPut, "/signage/groups/"+groupID, map[string]any{
		"expectedVersion": e.groupVersion(staff, groupID), "name": "Workshop",
		"aspectRatio": map[string]any{"width": 9, "height": 16}, "defaultScenes": sceneList(portrait.ID),
	}), http.StatusUnprocessableEntity, "validation_failed")
	e.expectCode(e.as(staff, http.MethodDelete, "/signage/groups/"+groupID,
		map[string]any{"expectedVersion": e.groupVersion(staff, groupID)}), http.StatusConflict, "signage_in_use")

	// Leaving copies the group's rules (new ids) and default list.
	left := e.expect(e.as(staff, http.MethodPut, displayBase,
		displayUpdate(joined, e.displayVersion(staff, displayID), nil, []any{}, 16, 9)), http.StatusOK)
	if left["groupId"] != nil || len(left["defaultScenes"].([]any)) != 1 ||
		left["defaultScenes"].([]any)[0].(map[string]any)["sceneId"] != sceneA.ID.String() {
		t.Fatalf("display after leaving = %v", left)
	}
	own := e.expect(e.as(staff, http.MethodGet, displayBase+"/rules", nil), http.StatusOK)
	copied := own["items"].([]any)
	if len(copied) != 1 || copied[0].(map[string]any)["id"] == groupRuleID ||
		copied[0].(map[string]any)["timeFrom"] != "08:00" || own["ownerVersion"] != left["version"] {
		t.Fatalf("display rules after leaving = %v", own)
	}
	if id, err := uuid.Parse(copied[0].(map[string]any)["id"].(string)); err != nil || id.Version() != 7 {
		t.Fatalf("copied rule id = %v", copied[0])
	}
	if n := e.count(`SELECT count(*) FROM signage_rules WHERE group_id = $1`, groupID); n != 1 {
		t.Fatalf("group lost its rules when a member left: %d", n)
	}
	// Without members the group may change its ratio (once its rules match) and be deleted.
	e.expect(e.as(staff, http.MethodDelete, "/signage/groups/"+groupID+"/rules/"+groupRuleID,
		map[string]any{"expectedVersion": e.groupVersion(staff, groupID)}), http.StatusOK)
	e.expect(e.as(staff, http.MethodPut, "/signage/groups/"+groupID, map[string]any{
		"expectedVersion": e.groupVersion(staff, groupID), "name": "Workshop",
		"aspectRatio": map[string]any{"width": 9, "height": 16}, "defaultScenes": sceneList(portrait.ID),
	}), http.StatusOK)
	e.expect(e.as(staff, http.MethodDelete, "/signage/groups/"+groupID,
		map[string]any{"expectedVersion": e.groupVersion(staff, groupID)}), http.StatusNoContent)
	if e.countAudit("signage_display_group.created") != 2 || e.countAudit("signage_display_group.updated") != 1 ||
		e.countAudit("signage_display_group.deleted") != 1 {
		t.Fatal("group audit rows missing")
	}
	e.expectCode(e.as(staff, http.MethodGet, "/signage/groups/"+groupID, nil), http.StatusNotFound, "not_found")
}

func TestSignageGroupPublishAndPendingChanges(t *testing.T) {
	e := newSignageEnv(t)
	staff := e.allStaff()
	scene, defaults := e.seedContent("Pub")
	group := e.createGroup(staff, "Lobby", defaults)
	groupID := group["id"].(string)
	base := "/signage/groups/" + groupID
	empty := e.createGroup(staff, "Empty", defaults)
	e.expectCode(e.as(staff, http.MethodPost, "/signage/groups/"+empty["id"].(string)+"/publish", nil),
		http.StatusUnprocessableEntity, "validation_failed")

	first, firstPlayer := e.pairInto(staff, "First", groupID)
	second, _ := e.pairInto(staff, "Second", groupID)
	standalone, _ := e.pair(staff, "Standalone", defaults)
	firstID, secondID := first["id"].(string), second["id"].(string)

	published := e.expect(e.as(staff, http.MethodPost, base+"/publish", nil), http.StatusOK)
	if len(published["pendingChanges"].([]any)) != 0 {
		t.Fatalf("pending after publish = %v", published)
	}
	for _, id := range []string{firstID, secondID} {
		display := e.expect(e.as(staff, http.MethodGet, "/signage/displays/"+id, nil), http.StatusOK)
		if display["publishedRevision"] != float64(1) || len(display["pendingChanges"].([]any)) != 0 {
			t.Fatalf("member after group publish = %v", display)
		}
	}
	if n := e.count(`SELECT count(*) FROM signage_publications WHERE display_id = $1`, standalone["id"]); n != 0 {
		t.Fatalf("standalone display got %d publications", n)
	}
	if e.countAudit("signage_display_group.published") != 1 || e.countAudit("signage_display.published") != 2 {
		t.Fatal("group publish audit rows missing")
	}
	manifest := e.expect(e.do(firstPlayer, "", http.MethodGet, "/signage/player/manifest", nil), http.StatusOK)["manifest"].(map[string]any)
	if manifest["defaultScenes"].([]any)[0].(map[string]any)["sceneId"] != scene.ID.String() ||
		len(manifest["rules"].([]any)) != 0 {
		t.Fatalf("member manifest = %v", manifest)
	}

	// A group rule is pending on the group and on each member.
	rules := e.expect(e.as(staff, http.MethodPost, base+"/rules",
		groupRuleBody(e.groupVersion(staff, groupID), defaults)), http.StatusCreated)
	ruleID := rules["items"].([]any)[0].(map[string]any)["id"].(string)
	pending := pendingKinds(e.expect(e.as(staff, http.MethodGet, base, nil), http.StatusOK))
	if len(pending) != 1 || pending[0] != "rule:Rule 1 (time_window):added" {
		t.Fatalf("group pending = %v", pending)
	}
	for _, id := range []string{firstID, secondID} {
		display := e.expect(e.as(staff, http.MethodGet, "/signage/displays/"+id, nil), http.StatusOK)
		if !slices.Equal(pendingKinds(display), pending) {
			t.Fatalf("member pending = %v, want %v", pendingKinds(display), pending)
		}
	}

	// Publishing one member uses the group's content; the group stays pending for the other one.
	member := e.expect(e.as(staff, http.MethodPost, "/signage/displays/"+firstID+"/publish", nil), http.StatusOK)
	if member["publishedRevision"] != float64(2) || len(member["pendingChanges"].([]any)) != 0 {
		t.Fatalf("member publish = %v", member)
	}
	manifest = e.expect(e.do(firstPlayer, "", http.MethodGet, "/signage/player/manifest", nil), http.StatusOK)["manifest"].(map[string]any)
	if len(manifest["rules"].([]any)) != 1 || manifest["rules"].([]any)[0].(map[string]any)["id"] != ruleID {
		t.Fatalf("member manifest after member publish = %v", manifest)
	}
	if pending := pendingKinds(e.expect(e.as(staff, http.MethodGet, base, nil), http.StatusOK)); len(pending) != 1 {
		t.Fatalf("group pending with one stale member = %v", pending)
	}
	published = e.expect(e.as(staff, http.MethodPost, base+"/publish", nil), http.StatusOK)
	if len(published["pendingChanges"].([]any)) != 0 {
		t.Fatalf("group pending after second publish = %v", published)
	}
	for id, revision := range map[string]float64{firstID: 3, secondID: 2} {
		if got := e.expect(e.as(staff, http.MethodGet, "/signage/displays/"+id, nil), http.StatusOK)["publishedRevision"]; got != revision {
			t.Fatalf("display %s revision = %v, want %v", id, got, revision)
		}
	}
}

func TestSignageGroupAnnouncementsAndPreview(t *testing.T) {
	e := newSignageEnv(t)
	ctx := testContext(t)
	staff := e.allStaff()
	_, defaults := e.seedContent("Ann")
	group := e.createGroup(staff, "Gallery", defaults)
	groupID := group["id"].(string)
	base := "/signage/groups/" + groupID

	// Preview without members has no manifest.
	preview := e.expect(e.as(staff, http.MethodGet, base+"/preview", nil), http.StatusOK)
	if preview["manifest"] != nil || preview["live"] == nil {
		t.Fatalf("empty group preview = %v", preview)
	}
	member, memberPlayer := e.pairInto(staff, "Member", groupID)
	outsider, outsiderPlayer := e.pair(staff, "Outsider", defaults)
	e.expect(e.as(staff, http.MethodPost, base+"/publish", nil), http.StatusOK)
	e.expect(e.as(staff, http.MethodPost, "/signage/displays/"+outsider["id"].(string)+"/publish", nil), http.StatusOK)

	template, err := e.fixture.service.CreateTemplate(ctx, e.fixture.admin, signage.TemplateInput{
		Name: "Notice", Tone: "info", Title: "Hello {display}", Body: "",
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	start := func(body map[string]any) *http.Response {
		value := map[string]any{"templateId": template.ID, "values": map[string]any{}, "allDisplays": false,
			"displayIds": []string{}, "groupIds": []string{}}
		for key, override := range body {
			value[key] = override
		}
		return e.as(staff, http.MethodPost, "/signage/announcements", value)
	}
	e.expectCode(start(map[string]any{"allDisplays": true, "groupIds": []string{groupID}}),
		http.StatusUnprocessableEntity, "validation_failed")
	e.expectCode(start(nil), http.StatusUnprocessableEntity, "validation_failed")
	e.expectCode(start(map[string]any{"groupIds": []string{ids7()}}), http.StatusUnprocessableEntity, "validation_failed")
	announcement := e.expect(start(map[string]any{"groupIds": []string{groupID}}), http.StatusCreated)
	if groups := announcement["groupIds"].([]any); len(groups) != 1 || groups[0] != groupID ||
		len(announcement["displayIds"].([]any)) != 0 {
		t.Fatalf("announcement = %v", announcement)
	}
	liveTitles := func(player *http.Client) []string {
		live := e.expect(e.do(player, "", http.MethodGet, "/signage/player/live", nil), http.StatusOK)
		var titles []string
		for _, item := range live["announcements"].([]any) {
			titles = append(titles, item.(map[string]any)["title"].(string))
		}
		return titles
	}
	if titles := liveTitles(memberPlayer); len(titles) != 1 || titles[0] != "Hello Member" {
		t.Fatalf("member live announcements = %v", titles)
	}
	if titles := liveTitles(outsiderPlayer); len(titles) != 0 {
		t.Fatalf("outsider live announcements = %v", titles)
	}

	// The group preview shows the member's publication and live data.
	preview = e.expect(e.as(staff, http.MethodGet, base+"/preview", nil), http.StatusOK)
	if preview["manifest"] == nil || preview["manifest"].(map[string]any)["revision"] != float64(1) ||
		len(preview["live"].(map[string]any)["announcements"].([]any)) != 1 {
		t.Fatalf("group preview = %v", preview)
	}

	// A display that leaves the group stops showing the group's announcements on its next poll.
	e.expect(e.as(staff, http.MethodPut, "/signage/displays/"+member["id"].(string),
		displayUpdate(member, e.displayVersion(staff, member["id"].(string)), nil, []any{}, 16, 9)), http.StatusOK)
	if titles := liveTitles(memberPlayer); len(titles) != 0 {
		t.Fatalf("former member live announcements = %v", titles)
	}
	// Deleting the group removes it from the announcement's targets.
	e.expect(e.as(staff, http.MethodDelete, base, map[string]any{"expectedVersion": e.groupVersion(staff, groupID)}),
		http.StatusNoContent)
	got := e.expect(e.as(staff, http.MethodGet, "/signage/announcements/"+announcement["id"].(string), nil), http.StatusOK)
	if len(got["groupIds"].([]any)) != 0 {
		t.Fatalf("announcement after group delete = %v", got)
	}
}

func ids7() string { return uuid.Must(uuid.NewV7()).String() }

func TestSignageGroupMutationsAndAuditShareOneTransaction(t *testing.T) {
	e := newSignageEnv(t)
	ctx := testContext(t)
	svc, admin := e.fixture.service, e.fixture.admin
	staff := e.allStaff()
	_, defaults := e.seedContent("Tx")
	group, err := svc.CreateGroup(ctx, admin, signage.GroupInput{
		Name: "Kept", AspectRatio: signage.AspectRatio{Width: 16, Height: 9}, DefaultScenes: defaults,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	display, _ := e.pair(staff, "Standalone", defaults)
	displayID := uuid.MustParse(display["id"].(string))
	if _, err := e.pool.Exec(ctx,
		`CREATE FUNCTION reject_group_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action LIKE 'signage_%' THEN RAISE EXCEPTION 'forced signage audit failure'; END IF; RETURN NEW; END; $$`,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := e.pool.Exec(ctx,
		`CREATE TRIGGER reject_group_audit_insert BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_group_audit()`,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateGroup(ctx, admin, signage.GroupInput{
		Name: "Never", AspectRatio: signage.AspectRatio{Width: 16, Height: 9}, DefaultScenes: defaults,
	}, nil); err == nil {
		t.Fatal("group committed without audit")
	}
	if _, err := svc.UpdateGroup(ctx, admin, group.ID, group.Version, signage.GroupInput{
		Name: "Renamed", AspectRatio: signage.AspectRatio{Width: 16, Height: 9}, DefaultScenes: defaults,
	}, nil); err == nil {
		t.Fatal("group update committed without audit")
	}
	if _, err := svc.CreateGroupRule(ctx, admin, group.ID, group.Version, signage.RuleInput{
		Enabled: true, ConditionKind: signage.ConditionLiveDataUnavailable, Scenes: defaults,
		MinSeconds: 20, MultiMode: signage.MultiModeSplit, AlternateSeconds: 10,
	}, nil); err == nil {
		t.Fatal("group rule committed without audit")
	}
	version := e.displayVersion(staff, display["id"].(string))
	if _, err := svc.UpdateDisplay(ctx, admin, displayID, version, signage.DisplayInput{
		Name: "Standalone", Location: "Entrance hall", AspectRatio: signage.AspectRatio{Width: 16, Height: 9},
		GroupID: &group.ID,
	}, nil); err == nil {
		t.Fatal("join committed without audit")
	}
	if err := svc.DeleteGroup(ctx, admin, group.ID, group.Version, nil); err == nil {
		t.Fatal("group delete committed without audit")
	}
	if n := e.count(`SELECT count(*) FROM signage_display_groups`); n != 1 {
		t.Fatalf("groups = %d", n)
	}
	if n := e.count(`SELECT count(*) FROM signage_display_groups WHERE name = 'Kept' AND version = 1`); n != 1 {
		t.Fatal("group changed without audit")
	}
	if n := e.count(`SELECT count(*) FROM signage_rules WHERE group_id = $1`, group.ID); n != 0 {
		t.Fatal("group rule stored without audit")
	}
	if n := e.count(`SELECT count(*) FROM signage_displays WHERE id = $1 AND group_id IS NULL`, displayID); n != 1 {
		t.Fatal("display joined without audit")
	}
	if n := e.count(`SELECT count(*) FROM signage_default_scenes WHERE display_id = $1`, displayID); n != 1 {
		t.Fatal("display lost its default list without audit")
	}
}
