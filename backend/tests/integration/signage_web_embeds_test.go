package integration_test

import (
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/signage"
	"github.com/google/uuid"
)

// createEmbed creates a 16:9 web embed allowed on https://www.example.org.
func (e *signageEnv) createEmbed(staff staffSession, name string, defaults []signage.SceneListItem) map[string]any {
	e.t.Helper()
	return e.expect(e.as(staff, http.MethodPost, "/signage/web-embeds", map[string]any{
		"name": name, "aspectRatio": map[string]any{"width": 16, "height": 9},
		"allowedOrigins": []string{"https://www.example.org"}, "defaultScenes": defaults,
	}), http.StatusCreated)
}

func (e *signageEnv) embed(staff staffSession, id string) map[string]any {
	e.t.Helper()
	return e.expect(e.as(staff, http.MethodGet, "/signage/web-embeds/"+id, nil), http.StatusOK)
}

func (e *signageEnv) patchEmbed(staff staffSession, id string, fields map[string]any) *http.Response {
	e.t.Helper()
	body := map[string]any{"expectedVersion": e.embed(staff, id)["version"]}
	for key, value := range fields {
		body[key] = value
	}
	return e.as(staff, http.MethodPatch, "/signage/web-embeds/"+id, body)
}

func auditChangedFields(e *signageEnv, action, resourceID string) []string {
	e.t.Helper()
	var fields []string
	if err := e.pool.QueryRow(testContext(e.t),
		`SELECT COALESCE(changed_fields, '{}') FROM audit_events WHERE action = $1 AND resource_id = $2::uuid
		 ORDER BY occurred_at DESC LIMIT 1`, action, resourceID,
	).Scan(&fields); err != nil {
		e.t.Fatal(err)
	}
	return fields
}

func TestSignageWebEmbedPermissions(t *testing.T) {
	e := newSignageEnv(t)
	_, defaults := e.seedContent("Embed permissions")
	reader := e.staff("embed-reader", authorization.SignageRead)
	manager := e.staff("embed-manager", authorization.SignageRead, authorization.SignageManage)
	publisher := e.staff("embed-publisher", authorization.SignageRead, authorization.SignagePublish)
	content := e.staff("embed-content", authorization.SignageContentManage)

	create := map[string]any{
		"name": "Website", "aspectRatio": map[string]any{"width": 16, "height": 9},
		"allowedOrigins": []string{"https://www.example.org"}, "defaultScenes": defaults,
	}
	e.expectCode(e.as(reader, http.MethodPost, "/signage/web-embeds", create), http.StatusForbidden, "permission_denied")
	e.expectCode(e.as(publisher, http.MethodPost, "/signage/web-embeds", create), http.StatusForbidden, "permission_denied")
	embed := e.expect(e.as(manager, http.MethodPost, "/signage/web-embeds", create), http.StatusCreated)
	id := embed["id"].(string)
	base := "/signage/web-embeds/" + id

	e.expectCode(e.as(content, http.MethodGet, "/signage/web-embeds", nil), http.StatusForbidden, "permission_denied")
	e.expectCode(e.as(content, http.MethodGet, base, nil), http.StatusForbidden, "permission_denied")
	if list := e.expect(e.as(reader, http.MethodGet, "/signage/web-embeds", nil), http.StatusOK); len(list["items"].([]any)) != 1 {
		t.Fatalf("reader list = %v", list)
	}
	e.expect(e.as(reader, http.MethodGet, base, nil), http.StatusOK)

	version := func() any { return e.embed(reader, id)["version"] }
	for _, denied := range []staffSession{reader, publisher} {
		e.expectCode(e.as(denied, http.MethodPatch, base, map[string]any{"expectedVersion": version(), "enabled": false}),
			http.StatusForbidden, "permission_denied")
		e.expectCode(e.as(denied, http.MethodPost, base+"/rotate-key", map[string]any{"expectedVersion": version()}),
			http.StatusForbidden, "permission_denied")
		e.expectCode(e.as(denied, http.MethodDelete, base, map[string]any{"expectedVersion": version()}),
			http.StatusForbidden, "permission_denied")
	}
	for _, denied := range []staffSession{reader, manager} {
		e.expectCode(e.as(denied, http.MethodPost, base+"/publish", nil), http.StatusForbidden, "permission_denied")
	}
	e.expect(e.as(manager, http.MethodPatch, base, map[string]any{"expectedVersion": version(), "openDirectly": true}),
		http.StatusOK)
	e.expect(e.as(manager, http.MethodPost, base+"/rotate-key", map[string]any{"expectedVersion": version()}),
		http.StatusOK)
	published := e.expect(e.as(publisher, http.MethodPost, base+"/publish", nil), http.StatusOK)
	if published["publishedRevision"] != float64(1) || published["hasUnpublishedChanges"] != false {
		t.Fatalf("published embed = %v", published)
	}
	e.expect(e.as(manager, http.MethodDelete, base, map[string]any{"expectedVersion": version()}), http.StatusNoContent)
	e.expectCode(e.as(reader, http.MethodGet, base, nil), http.StatusNotFound, "not_found")
	if e.count(`SELECT count(*) FROM signage_web_embeds`) != 0 ||
		e.count(`SELECT count(*) FROM signage_publications WHERE display_id = $1::uuid`, id) != 0 {
		t.Fatal("the deleted embed left rows behind")
	}
}

// The New web embed dialog sends either a display group or default scenes: an embed without either has nothing to
// show and is refused with a message the dialog can show as it is.
func TestSignageWebEmbedCreateNeedsContent(t *testing.T) {
	e := newSignageEnv(t)
	staff := e.allStaff()
	_, defaults := e.seedContent("Embed create")
	group := e.createGroup(staff, "Websites", defaults)
	create := func(content map[string]any) *http.Response {
		body := map[string]any{
			"name": "Website Druckerstatus", "aspectRatio": map[string]any{"width": 16, "height": 9},
			"allowedOrigins": []string{"https://makerspace.example"},
		}
		for key, value := range content {
			body[key] = value
		}
		return e.as(staff, http.MethodPost, "/signage/web-embeds", body)
	}

	for name, content := range map[string]map[string]any{
		"nothing":    {},
		"empty list": {"defaultScenes": []any{}},
		"null group": {"groupId": nil, "defaultScenes": []any{}},
	} {
		refused := e.expect(create(content), http.StatusUnprocessableEntity)
		if refused["code"] != "validation_failed" || refused["message"] != "choose at least one default scene or a display group" {
			t.Fatalf("%s: refused = %v", name, refused)
		}
	}
	unknown := e.expect(create(map[string]any{"defaultScenes": sceneList(uuid.Must(uuid.NewV7()))}),
		http.StatusUnprocessableEntity)
	if unknown["message"] != "a scene of the default scenes does not exist any more" {
		t.Fatalf("unknown scene = %v", unknown)
	}
	if e.count(`SELECT count(*) FROM signage_web_embeds`) != 0 {
		t.Fatal("a refused embed was stored")
	}

	own := e.expect(create(map[string]any{"defaultScenes": defaults}), http.StatusCreated)
	if own["groupId"] != nil || len(own["defaultScenes"].([]any)) != 1 {
		t.Fatalf("embed with its own scenes = %v", own)
	}
	member := e.expect(create(map[string]any{"groupId": group["id"]}), http.StatusCreated)
	if member["groupId"] != group["id"] || len(member["defaultScenes"].([]any)) != 0 {
		t.Fatalf("embed in a group = %v", member)
	}
	// Both can be renamed afterwards without touching their content.
	e.expect(e.patchEmbed(staff, own["id"].(string), map[string]any{"name": "Renamed"}), http.StatusOK)
	e.expect(e.patchEmbed(staff, member["id"].(string), map[string]any{"name": "Renamed too"}), http.StatusOK)
}

func TestSignageWebEmbedOriginsKeyAndAudit(t *testing.T) {
	e := newSignageEnv(t)
	staff := e.allStaff()
	_, defaults := e.seedContent("Embed origins")
	create := func(origins []string) *http.Response {
		return e.as(staff, http.MethodPost, "/signage/web-embeds", map[string]any{
			"name": "Website", "aspectRatio": map[string]any{"width": 16, "height": 9},
			"allowedOrigins": origins, "defaultScenes": defaults,
		})
	}
	for _, invalid := range [][]string{
		{},
		{"http://www.example.org"},
		{"https://www.example.org/"},
		{"https://www.example.org/path"},
		{"https://www.example.org?x=1"},
		{"https://*.example.org"},
		{"https://www.example.org 'unsafe-inline'"},
		{"https://www.example.org;script-src"},
		{"https://www.example.org:99999"},
		{"https://user@www.example.org"},
		{"*"},
	} {
		e.expectCode(create(invalid), http.StatusUnprocessableEntity, "validation_failed")
	}
	// Without a group the embed needs a default list, as a display does.
	e.expectCode(e.as(staff, http.MethodPost, "/signage/web-embeds", map[string]any{
		"name": "Website", "aspectRatio": map[string]any{"width": 16, "height": 9},
		"allowedOrigins": []string{"https://www.example.org"},
	}), http.StatusUnprocessableEntity, "validation_failed")

	embed := e.expect(create([]string{"HTTPS://WWW.Example.org", "https://www.example.org", "https://b.example:8443"}),
		http.StatusCreated)
	id := embed["id"].(string)
	if origins := embed["allowedOrigins"].([]any); len(origins) != 2 || origins[0] != "https://www.example.org" ||
		origins[1] != "https://b.example:8443" {
		t.Fatalf("allowed origins = %v", origins)
	}
	key := embed["embedKey"].(string)
	if len(key) != 32 || embed["embedUrl"] != e.origin+"/embed/"+key || embed["enabled"] != true ||
		embed["cameraEnabled"] != false || embed["timelapseEnabled"] != false || embed["publishedRevision"] != nil ||
		embed["hasUnpublishedChanges"] != true || embed["loadsToday"] != float64(0) {
		t.Fatalf("created embed = %v", embed)
	}
	if e.count(`SELECT count(*) FROM signage_displays WHERE id = $1::uuid AND kind = 'web_embed'
		AND managed_device_id IS NULL AND visible_from_outside`, id) != 1 {
		t.Fatal("the embed's display row is not a device-less web embed")
	}

	// The last website cannot be removed; a stale version conflicts.
	e.expectCode(e.patchEmbed(staff, id, map[string]any{"allowedOrigins": []string{}}),
		http.StatusUnprocessableEntity, "validation_failed")
	e.expectCode(e.as(staff, http.MethodPatch, "/signage/web-embeds/"+id,
		map[string]any{"expectedVersion": 99, "enabled": false}), http.StatusConflict, "stale_write")
	e.expectCode(e.patchEmbed(staff, id, map[string]any{"cameraMachineIds": []string{ids7()}}),
		http.StatusUnprocessableEntity, "validation_failed")

	printer := e.printer("Embed camera printer")
	updated := e.expect(e.patchEmbed(staff, id, map[string]any{
		"enabled": false, "cameraEnabled": true, "cameraMachineIds": []string{printer.machineID.String()},
		"timelapseCount": 3, "name": "Website renamed",
	}), http.StatusOK)
	if updated["enabled"] != false || updated["cameraEnabled"] != true || updated["timelapseCount"] != float64(3) ||
		updated["name"] != "Website renamed" {
		t.Fatalf("updated embed = %v", updated)
	}
	fields := auditChangedFields(e, "signage_web_embed.updated", id)
	slices.Sort(fields)
	if want := []string{"cameraEnabled", "cameraMachineIds", "enabled", "name", "timelapseCount"}; !slices.Equal(fields, want) {
		t.Fatalf("audited fields = %v, want %v", fields, want)
	}

	rotated := e.expect(e.as(staff, http.MethodPost, "/signage/web-embeds/"+id+"/rotate-key",
		map[string]any{"expectedVersion": updated["version"]}), http.StatusOK)
	newKey := rotated["embedKey"].(string)
	if newKey == key || len(newKey) != 32 || rotated["embedUrl"] != e.origin+"/embed/"+newKey {
		t.Fatalf("rotated embed = %v", rotated)
	}
	if fields := auditChangedFields(e, "signage_web_embed.key_rotated", id); !slices.Equal(fields, []string{"embedKey"}) {
		t.Fatalf("rotation audit fields = %v", fields)
	}
	// No audit event of the embed carries a key.
	var leaked int
	if err := e.pool.QueryRow(testContext(t), `SELECT count(*) FROM audit_events a
		WHERE a.resource_id = $1::uuid AND (to_jsonb(a)::text LIKE '%' || $2 || '%' OR to_jsonb(a)::text LIKE '%' || $3 || '%')`,
		id, key, newKey).Scan(&leaked); err != nil {
		t.Fatal(err)
	}
	if leaked != 0 || e.count(`SELECT count(*) FROM audit_events WHERE resource_id = $1::uuid`, id) < 3 {
		t.Fatalf("audit events leak the key (%d) or are missing", leaked)
	}
}

func TestSignageWebEmbedsAreNotDevices(t *testing.T) {
	e := newSignageEnv(t)
	staff := e.allStaff()
	_, defaults := e.seedContent("Embed isolation")
	device, _ := e.pair(staff, "Lobby", defaults)
	deviceID := device["id"].(string)
	embed := e.createEmbed(staff, "Website", defaults)
	embedID := embed["id"].(string)

	// The Displays page lists devices only, and the device endpoints do not know embeds.
	list := e.expect(e.as(staff, http.MethodGet, "/signage/displays", nil), http.StatusOK)
	for _, item := range list["items"].([]any) {
		if item.(map[string]any)["id"] == embedID {
			t.Fatal("the display list contains a web embed")
		}
	}
	version := embed["version"]
	displayPath := "/signage/displays/" + embedID
	e.expectCode(e.as(staff, http.MethodGet, displayPath, nil), http.StatusNotFound, "not_found")
	e.expectCode(e.as(staff, http.MethodPut, displayPath, map[string]any{
		"expectedVersion": version, "name": "X", "location": "", "aspectRatio": map[string]any{"width": 16, "height": 9},
		"visibleFromOutside": false, "defaultScenes": defaults,
	}), http.StatusNotFound, "not_found")
	e.expectCode(e.as(staff, http.MethodPost, displayPath+"/revoke", map[string]any{"expectedVersion": version}),
		http.StatusNotFound, "not_found")
	e.expectCode(e.as(staff, http.MethodPost, displayPath+"/publish", nil), http.StatusNotFound, "not_found")
	e.expectCode(e.as(staff, http.MethodDelete, displayPath, map[string]any{"expectedVersion": version}),
		http.StatusNotFound, "not_found")
	// And the embed endpoints do not know devices.
	embedPath := "/signage/web-embeds/" + deviceID
	deviceVersion := e.displayVersion(staff, deviceID)
	e.expectCode(e.as(staff, http.MethodGet, embedPath, nil), http.StatusNotFound, "not_found")
	e.expectCode(e.as(staff, http.MethodPatch, embedPath, map[string]any{"expectedVersion": deviceVersion, "enabled": false}),
		http.StatusNotFound, "not_found")
	e.expectCode(e.as(staff, http.MethodPost, embedPath+"/rotate-key", map[string]any{"expectedVersion": deviceVersion}),
		http.StatusNotFound, "not_found")
	e.expectCode(e.as(staff, http.MethodPost, embedPath+"/publish", nil), http.StatusNotFound, "not_found")
	e.expectCode(e.as(staff, http.MethodDelete, embedPath, map[string]any{"expectedVersion": deviceVersion}),
		http.StatusNotFound, "not_found")
	if e.count(`SELECT count(*) FROM signage_displays WHERE id = $1::uuid AND kind = 'device'
		AND managed_device_id IS NOT NULL`, deviceID) != 1 {
		t.Fatal("a paired display is not of kind device")
	}

	// Rules and the preview of an embed use the display endpoints with the embed id.
	rule := e.expect(e.as(staff, http.MethodPost, displayPath+"/rules", groupRuleBody(int64(version.(float64)), defaults)),
		http.StatusCreated)
	if len(rule["items"].([]any)) != 1 {
		t.Fatalf("embed rules after create = %v", rule)
	}
	if rules := e.expect(e.as(staff, http.MethodGet, displayPath+"/rules", nil), http.StatusOK); len(rules["items"].([]any)) != 1 {
		t.Fatalf("embed rules = %v", rules)
	}
	preview := e.expect(e.as(staff, http.MethodGet, displayPath+"/preview", nil), http.StatusOK)
	if preview["manifest"] != nil {
		t.Fatalf("unpublished embed preview = %v", preview)
	}
}

func TestSignageWebEmbedAnnouncementsGroupsAndPublication(t *testing.T) {
	e := newSignageEnv(t)
	ctx := testContext(t)
	staff := e.allStaff()
	_, defaults := e.seedContent("Embed content")
	group := e.createGroup(staff, "Everywhere", defaults)
	groupID := group["id"].(string)
	_, devicePlayer := e.pair(staff, "Lobby", defaults)
	embed := e.createEmbed(staff, "Website", defaults)
	embedID := embed["id"].(string)

	// The embed joins the group; its own default list goes, and group publishing reaches it.
	joined := e.expect(e.patchEmbed(staff, embedID, map[string]any{"groupId": groupID, "defaultScenes": []any{}}),
		http.StatusOK)
	if joined["groupId"] != groupID || len(joined["defaultScenes"].([]any)) != 0 {
		t.Fatalf("joined embed = %v", joined)
	}
	if members := e.expect(e.as(staff, http.MethodGet, "/signage/groups/"+groupID, nil), http.StatusOK)["displayIds"].([]any); !slices.Contains(members, any(embedID)) {
		t.Fatalf("group members = %v", members)
	}
	e.expect(e.as(staff, http.MethodPost, "/signage/groups/"+groupID+"/publish", nil), http.StatusOK)
	if got := e.embed(staff, embedID); got["publishedRevision"] != float64(1) || got["hasUnpublishedChanges"] != false {
		t.Fatalf("embed after group publish = %v", got)
	}
	if e.countAudit("signage_web_embed.published") != 1 {
		t.Fatal("the group publication of the embed is not audited as an embed publication")
	}

	template, err := e.fixture.service.CreateTemplate(ctx, e.fixture.admin, signage.TemplateInput{
		Name: "Notice", Tone: "info", Title: "{display}", Body: "",
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	start := func(title string, body map[string]any) {
		value := map[string]any{"templateId": template.ID, "values": map[string]any{}, "allDisplays": false,
			"displayIds": []string{}, "groupIds": []string{}}
		for key, override := range body {
			value[key] = override
		}
		e.expect(e.as(staff, http.MethodPost, "/signage/announcements", value), http.StatusCreated)
	}
	start("all", map[string]any{"allDisplays": true})
	start("group", map[string]any{"groupIds": []string{groupID}})
	start("named", map[string]any{"displayIds": []string{embedID}})
	preview := e.expect(e.as(staff, http.MethodGet, "/signage/displays/"+embedID+"/preview", nil), http.StatusOK)
	announcements := preview["live"].(map[string]any)["announcements"].([]any)
	// Only the announcement that names the embed reaches it; all-displays and group announcements skip embeds.
	if len(announcements) != 1 || announcements[0].(map[string]any)["title"] != "Website" {
		t.Fatalf("embed announcements = %v", announcements)
	}
	if live := e.expect(e.do(devicePlayer, "", http.MethodGet, "/signage/player/live", nil), http.StatusOK); len(live["announcements"].([]any)) != 1 {
		t.Fatalf("device announcements = %v", live["announcements"])
	}

	// Switching a medium on is a pending change until the next publication.
	switched := e.expect(e.patchEmbed(staff, embedID, map[string]any{"timelapseEnabled": true}), http.StatusOK)
	if switched["hasUnpublishedChanges"] != true ||
		!slices.Contains(pendingKinds(switched), "display:Data shown:modified") {
		t.Fatalf("embed after switching timelapses on = %v", switched)
	}
	published := e.expect(e.as(staff, http.MethodPost, "/signage/web-embeds/"+embedID+"/publish", nil), http.StatusOK)
	if published["publishedRevision"] != float64(2) || published["hasUnpublishedChanges"] != false {
		t.Fatalf("published embed = %v", published)
	}
	var manifest string
	if err := e.pool.QueryRow(ctx, `SELECT manifest::text FROM signage_publications WHERE display_id = $1::uuid
		ORDER BY revision DESC LIMIT 1`, embedID).Scan(&manifest); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(manifest, `"embedMedia": {"camera": false, "timelapses": true`) {
		t.Fatalf("publication does not record the embed media: %s", manifest)
	}
	// A group cannot be deleted while the embed is a member.
	e.expectCode(e.as(staff, http.MethodDelete, "/signage/groups/"+groupID,
		map[string]any{"expectedVersion": e.groupVersion(staff, groupID)}), http.StatusConflict, "signage_in_use")
}

// Notification rules put notices on the makerspace's own screens only; a web embed is not a display they may target.
func TestNotificationRulesRefuseWebEmbedsAsSignageTargets(t *testing.T) {
	e := newRulesEnv(t)
	ctx := testContext(t)
	embedID := ids.New()
	if _, err := e.pool.Exec(ctx, `INSERT INTO signage_displays (id, kind, name, aspect_width, aspect_height, visible_from_outside)
		VALUES ($1, 'web_embed', 'Website', 16, 9, true)`, embedID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.pool.Exec(ctx, `INSERT INTO signage_web_embeds (display_id, embed_key, allowed_origins)
		VALUES ($1, $2, '{https://www.example.org}')`, embedID, strings.Repeat("k", 32)); err != nil {
		t.Fatal(err)
	}
	input := eventRule("lab_rules_published", "need_confirm")
	input.CategoryID = &e.service
	input.Definition.Actions = []notifyrules.Action{{
		Channel: notifyrules.ChannelSignage, Title: "Printer error",
		Signage: &notifyrules.SignageTarget{DisplayIDs: []uuid.UUID{embedID}, DurationMinutes: 5, Tone: notifyrules.ToneInfo},
	}}
	_, err := e.rules.CreateRule(ctx, e.manager(), input, nil)
	var refusal *apperror.Error
	if !errors.As(err, &refusal) || !strings.Contains(fmt.Sprint(refusal.Code, refusal.Details), "displayIds") {
		t.Fatalf("rule targeting a web embed = %v %#v, want a displayIds validation error", err, refusal.Details)
	}
}

// A web embed's display row always stays visible from outside without allowCameraOutside: the device endpoints do not
// reach it and the database refuses anything else.
func TestWebEmbedDisplayStaysPublicOnly(t *testing.T) {
	e := newSignageEnv(t)
	staff := e.allStaff()
	_, defaults := e.seedContent("Embed public only")
	embed := e.createEmbed(staff, "Website", defaults)
	id := embed["id"].(string)
	e.expectCode(e.as(staff, http.MethodPut, "/signage/displays/"+id, map[string]any{
		"expectedVersion": embed["version"], "name": "Website", "location": "",
		"aspectRatio":        map[string]any{"width": 16, "height": 9},
		"visibleFromOutside": false, "allowCameraOutside": true, "defaultScenes": defaults,
	}), http.StatusNotFound, "not_found")
	for _, update := range []string{
		`UPDATE signage_displays SET visible_from_outside = false WHERE id = $1::uuid`,
		`UPDATE signage_displays SET allow_camera_outside = true WHERE id = $1::uuid`,
	} {
		if _, err := e.pool.Exec(testContext(t), update, id); err == nil {
			t.Fatalf("the database accepted %q for a web embed", update)
		}
	}
	if e.count(`SELECT count(*) FROM signage_displays WHERE id = $1::uuid AND visible_from_outside
		AND NOT allow_camera_outside`, id) != 1 {
		t.Fatal("the embed's display row changed")
	}
}
