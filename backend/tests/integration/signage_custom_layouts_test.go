package integration_test

import (
	"bytes"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/events"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/storage"
	"github.com/google/uuid"
)

func gridZoneBody(id string, col, row, colSpan, rowSpan int) map[string]any {
	return map[string]any{
		"id": id, "label": strings.ToUpper(id), "rect": nil,
		"grid": map[string]any{"col": col, "row": row, "colSpan": colSpan, "rowSpan": rowSpan},
	}
}

func freeZoneBody(id string, x, y, width, height float64) map[string]any {
	return map[string]any{
		"id": id, "label": strings.ToUpper(id), "grid": nil,
		"rect": map[string]any{"x": x, "y": y, "width": width, "height": height},
	}
}

func layoutBody(name string, zones ...map[string]any) map[string]any {
	return map[string]any{
		"name": name, "mode": "grid", "columns": []int{1, 1}, "rows": []int{1}, "zones": zones,
	}
}

func versionOf(body map[string]any) int64 { return int64(body["version"].(float64)) }

func sceneBody(layout, customLayoutID string, zones map[string]any) map[string]any {
	body := map[string]any{
		"name": "Scene " + uuid.NewString()[:8], "orientation": "landscape", "layoutId": layout,
		"backgroundColor": "#101820", "backgroundFit": "cover", "backgroundDim": 0, "theme": "dark",
	}
	if customLayoutID != "" {
		body["customLayoutId"] = customLayoutID
	}
	if zones != nil {
		body["zones"] = zones
	}
	return body
}

func (e *signageEnv) createLayout(staff staffSession, body map[string]any) map[string]any {
	e.t.Helper()
	return e.expect(e.as(staff, http.MethodPost, "/signage/custom-layouts", body), http.StatusCreated)
}

func (e *signageEnv) createScene(staff staffSession, body map[string]any) map[string]any {
	e.t.Helper()
	return e.expect(e.as(staff, http.MethodPost, "/signage/scenes", body), http.StatusCreated)
}

func TestSignageCustomLayoutPermissionsAndLifecycle(t *testing.T) {
	e := newSignageEnv(t)
	editor := e.staff("layout-editor", authorization.SignageContentManage)
	viewer := e.staff("layout-viewer", authorization.SignageRead)
	manager := e.staff("layout-manager", authorization.SignageManage, authorization.SignagePublish)
	nobody := e.staff("layout-nobody")

	created := e.createLayout(editor, layoutBody("Wall", gridZoneBody("a", 1, 1, 1, 1), gridZoneBody("b", 2, 1, 1, 1)))
	id := created["id"].(string)
	if created["sceneCount"] != float64(0) || created["mode"] != "grid" || versionOf(created) != 1 {
		t.Fatalf("created = %v", created)
	}

	// Read needs signage.read or signage.content.manage; write needs signage.content.manage.
	for name, session := range map[string]staffSession{"viewer": viewer, "editor": editor} {
		e.expect(e.as(session, http.MethodGet, "/signage/custom-layouts", nil), http.StatusOK)
		e.expect(e.as(session, http.MethodGet, "/signage/custom-layouts/"+id, nil), http.StatusOK)
		_ = name
	}
	for name, session := range map[string]staffSession{"manager": manager, "nobody": nobody} {
		e.expectCode(e.as(session, http.MethodGet, "/signage/custom-layouts", nil), http.StatusForbidden, "permission_denied")
		e.expectCode(e.as(session, http.MethodGet, "/signage/custom-layouts/"+id, nil), http.StatusForbidden, "permission_denied")
		_ = name
	}
	update := func(version int64, name string) map[string]any {
		body := layoutBody(name, gridZoneBody("a", 1, 1, 1, 1), gridZoneBody("b", 2, 1, 1, 1))
		body["expectedVersion"] = version
		return body
	}
	for name, session := range map[string]staffSession{"viewer": viewer, "manager": manager, "nobody": nobody} {
		e.expectCode(e.as(session, http.MethodPost, "/signage/custom-layouts", layoutBody("X", gridZoneBody("a", 1, 1, 1, 1))),
			http.StatusForbidden, "permission_denied")
		e.expectCode(e.as(session, http.MethodPut, "/signage/custom-layouts/"+id, update(1, "Hijack")),
			http.StatusForbidden, "permission_denied")
		e.expectCode(e.as(session, http.MethodDelete, "/signage/custom-layouts/"+id, map[string]any{"expectedVersion": 1}),
			http.StatusForbidden, "permission_denied")
		_ = name
	}
	e.expect(e.do(e.newPlayer(), "", http.MethodGet, "/signage/custom-layouts", nil), http.StatusUnauthorized)

	// Validation: overlap, bounds, free-mode decimals.
	e.expectCode(e.as(editor, http.MethodPost, "/signage/custom-layouts",
		layoutBody("Overlap", gridZoneBody("a", 1, 1, 2, 1), gridZoneBody("b", 2, 1, 1, 1))), http.StatusUnprocessableEntity, "validation_failed")
	e.expectCode(e.as(editor, http.MethodPost, "/signage/custom-layouts",
		layoutBody("Outside", gridZoneBody("a", 2, 1, 2, 1))), http.StatusUnprocessableEntity, "validation_failed")
	free := layoutBody("Free", freeZoneBody("a", 0, 0, 50.25, 100), freeZoneBody("b", 40, 10, 60, 30))
	free["mode"] = "free"
	freeCreated := e.createLayout(editor, free) // zones may overlap in free mode
	if cols := freeCreated["columns"].([]any); len(cols) != 1 || cols[0] != float64(1) {
		t.Fatalf("free layout columns = %v", cols)
	}
	badFree := layoutBody("Free", freeZoneBody("a", 0, 0, 33.333, 10))
	badFree["mode"] = "free"
	e.expectCode(e.as(editor, http.MethodPost, "/signage/custom-layouts", badFree), http.StatusUnprocessableEntity, "validation_failed")
	badFree = layoutBody("Free", freeZoneBody("a", 60, 0, 50, 10))
	badFree["mode"] = "free"
	e.expectCode(e.as(editor, http.MethodPost, "/signage/custom-layouts", badFree), http.StatusUnprocessableEntity, "validation_failed")

	// Optimistic concurrency.
	updated := e.expect(e.as(editor, http.MethodPut, "/signage/custom-layouts/"+id, update(1, "Wall 2")), http.StatusOK)
	if versionOf(updated) != 2 || updated["name"] != "Wall 2" {
		t.Fatalf("updated = %v", updated)
	}
	e.expectCode(e.as(editor, http.MethodPut, "/signage/custom-layouts/"+id, update(1, "Stale")), http.StatusConflict, "stale_write")

	// A scene that uses the layout blocks its deletion and is listed in the references.
	scene := e.createScene(editor, sceneBody("custom", id, nil))
	if scene["customLayoutId"] != id {
		t.Fatalf("scene = %v", scene)
	}
	if listed := e.expect(e.as(viewer, http.MethodGet, "/signage/custom-layouts/"+id, nil), http.StatusOK); listed["sceneCount"] != float64(1) {
		t.Fatalf("sceneCount = %v", listed["sceneCount"])
	}
	blocked := e.expect(e.as(editor, http.MethodDelete, "/signage/custom-layouts/"+id, map[string]any{"expectedVersion": 2}), http.StatusConflict)
	details := blocked["details"].(map[string]any)["references"].([]any)
	if blocked["code"] != "signage_in_use" || len(details) != 1 || details[0].(map[string]any)["id"] != scene["id"] {
		t.Fatalf("blocked = %v", blocked)
	}
	e.expect(e.as(editor, http.MethodDelete, "/signage/scenes/"+scene["id"].(string), map[string]any{"expectedVersion": 1}), http.StatusNoContent)
	e.expectCode(e.as(editor, http.MethodDelete, "/signage/custom-layouts/"+id, map[string]any{"expectedVersion": 1}), http.StatusConflict, "stale_write")
	e.expect(e.as(editor, http.MethodDelete, "/signage/custom-layouts/"+id, map[string]any{"expectedVersion": 2}), http.StatusNoContent)
	e.expectCode(e.as(editor, http.MethodGet, "/signage/custom-layouts/"+id, nil), http.StatusNotFound, "not_found")

	for _, action := range []string{"signage_custom_layout.created", "signage_custom_layout.updated", "signage_custom_layout.deleted"} {
		if e.countAudit(action) == 0 {
			t.Errorf("no %s audit event", action)
		}
	}
}

func TestSignageCustomLayoutZonePruningAndRemapAcrossLayouts(t *testing.T) {
	e := newSignageEnv(t)
	staff := e.allStaff()
	layout := e.createLayout(staff, layoutBody("Two", gridZoneBody("a", 1, 1, 1, 1), gridZoneBody("b", 2, 1, 1, 1)))
	id := layout["id"].(string)
	clock := map[string]any{"type": "clock", "mode": "time"}
	count := map[string]any{"type": "open_days", "count": 3}

	// Zones must belong to the custom layout.
	e.expectCode(e.as(staff, http.MethodPost, "/signage/scenes", sceneBody("custom", id, map[string]any{"left": clock})),
		http.StatusUnprocessableEntity, "validation_failed")
	e.expectCode(e.as(staff, http.MethodPost, "/signage/scenes", sceneBody("custom", "", nil)), http.StatusUnprocessableEntity, "validation_failed")
	e.expectCode(e.as(staff, http.MethodPost, "/signage/scenes", sceneBody("full", id, nil)), http.StatusUnprocessableEntity, "validation_failed")
	e.expectCode(e.as(staff, http.MethodPost, "/signage/scenes", sceneBody("custom", ids.New().String(), nil)),
		http.StatusUnprocessableEntity, "validation_failed")

	scene := e.createScene(staff, sceneBody("custom", id, map[string]any{"a": clock, "b": count}))
	sceneID := scene["id"].(string)
	bystander := e.createScene(staff, sceneBody("full", "", nil))
	before := e.countAudit("signage_scene.updated")

	// Remove zone b, add zone c: the scene keeps a, loses b, gets an empty c and a new version.
	update := layoutBody("Two", gridZoneBody("a", 1, 1, 1, 1), gridZoneBody("c", 2, 1, 1, 1))
	update["expectedVersion"] = 1
	e.expect(e.as(staff, http.MethodPut, "/signage/custom-layouts/"+id, update), http.StatusOK)
	pruned := e.expect(e.as(staff, http.MethodGet, "/signage/scenes/"+sceneID, nil), http.StatusOK)
	zones := pruned["zones"].(map[string]any)
	if len(zones) != 2 || zones["a"].(map[string]any)["type"] != "clock" || zones["c"].(map[string]any)["type"] != "empty" || zones["b"] != nil {
		t.Fatalf("pruned zones = %v", zones)
	}
	if versionOf(pruned) != 2 || e.countAudit("signage_scene.updated") != before+1 {
		t.Fatalf("scene version %d, scene audit events %d (was %d)", versionOf(pruned), e.countAudit("signage_scene.updated"), before)
	}
	if untouched := e.expect(e.as(staff, http.MethodGet, "/signage/scenes/"+bystander["id"].(string), nil), http.StatusOK); versionOf(untouched) != 1 {
		t.Fatalf("scene without the layout changed: %v", untouched)
	}

	// A change that keeps the zone ids leaves the scene alone.
	same := layoutBody("Two renamed", gridZoneBody("a", 1, 1, 1, 1), gridZoneBody("c", 2, 1, 1, 1))
	same["expectedVersion"] = 2
	e.expect(e.as(staff, http.MethodPut, "/signage/custom-layouts/"+id, same), http.StatusOK)
	if again := e.expect(e.as(staff, http.MethodGet, "/signage/scenes/"+sceneID, nil), http.StatusOK); versionOf(again) != 2 {
		t.Fatalf("scene version changed without zone changes: %v", again)
	}

	// Switching to a built-in layout keeps the widgets by position, and back again.
	toSplit := sceneBody("split", "", nil)
	toSplit["name"], toSplit["expectedVersion"] = pruned["name"], versionOf(pruned)
	split := e.expect(e.as(staff, http.MethodPut, "/signage/scenes/"+sceneID, toSplit), http.StatusOK)
	if split["customLayoutId"] != nil || split["zones"].(map[string]any)["left"].(map[string]any)["type"] != "clock" {
		t.Fatalf("split = %v", split)
	}
	toCustom := sceneBody("custom", id, nil)
	toCustom["name"], toCustom["expectedVersion"] = split["name"], versionOf(split)
	back := e.expect(e.as(staff, http.MethodPut, "/signage/scenes/"+sceneID, toCustom), http.StatusOK)
	if back["customLayoutId"] != id || back["zones"].(map[string]any)["a"].(map[string]any)["type"] != "clock" {
		t.Fatalf("back on custom = %v", back)
	}
}

func TestSignageCustomLayoutReachesManifestAndPendingChanges(t *testing.T) {
	e := newSignageEnv(t)
	staff := e.allStaff()
	layout := e.createLayout(staff, layoutBody("Wide", gridZoneBody("main", 1, 1, 2, 1)))
	layoutID := layout["id"].(string)
	scene := e.createScene(staff, sceneBody("custom", layoutID, map[string]any{"main": map[string]any{"type": "clock", "mode": "time"}}))
	sceneID, err := uuid.Parse(scene["id"].(string))
	if err != nil {
		t.Fatal(err)
	}
	playlist := e.fixture.playlist(t, "Custom playlist", sceneID)
	display, player := e.pair(staff, "Custom display", playlist.ID)
	displayID := display["id"].(string)
	e.expect(e.as(staff, http.MethodPost, "/signage/displays/"+displayID+"/publish", nil), http.StatusOK)

	envelope := e.expect(e.do(player, "", http.MethodGet, "/signage/player/manifest", nil), http.StatusOK)
	manifest := envelope["manifest"].(map[string]any)
	layouts := manifest["customLayouts"].([]any)
	if manifest["layoutsVersion"] != float64(2) || len(layouts) != 1 {
		t.Fatalf("manifest = %v", manifest)
	}
	published := layouts[0].(map[string]any)
	if published["id"] != layoutID || published["mode"] != "grid" || len(published["zones"].([]any)) != 1 {
		t.Fatalf("published layout = %v", published)
	}
	if manifest["scenes"].([]any)[0].(map[string]any)["customLayoutId"] != layoutID {
		t.Fatalf("scene without customLayoutId: %v", manifest["scenes"])
	}
	if pending := pendingSet(e.expect(e.as(staff, http.MethodGet, "/signage/displays/"+displayID, nil), http.StatusOK)); len(pending) != 0 {
		t.Fatalf("pending after publishing = %v", pending)
	}

	// Editing the layout alone is a pending change of kind layout.
	update := layoutBody("Wide renamed", gridZoneBody("main", 1, 1, 2, 1))
	update["expectedVersion"] = 1
	e.expect(e.as(staff, http.MethodPut, "/signage/custom-layouts/"+layoutID, update), http.StatusOK)
	pending := pendingSet(e.expect(e.as(staff, http.MethodGet, "/signage/displays/"+displayID, nil), http.StatusOK))
	if !pending["layout|Wide renamed|modified"] {
		t.Fatalf("pending changes = %v", pending)
	}
}

func TestSignageFontAssets(t *testing.T) {
	e := newSignageEnv(t)
	staff := e.allStaff()
	upload := func(name, contentType string, body []byte) *http.Response {
		return e.doRaw(staff.client, staff.csrf, http.MethodPost, "/signage/assets", body,
			"X-File-Name", url.PathEscape(name), "X-File-Content-Type", contentType)
	}
	font := append([]byte("wOF2"), bytes.Repeat([]byte{0}, 200)...)
	asset := e.expect(upload("Display.woff2", "font/woff2", font), http.StatusCreated)
	if asset["kind"] != "font" || asset["contentType"] != "font/woff2" || asset["width"] != nil || asset["durationMs"] != nil {
		t.Fatalf("font asset = %v", asset)
	}
	e.expectCode(upload("Fake.woff2", "font/woff2", []byte("not a font at all")), http.StatusUnprocessableEntity, "validation_failed")
	e.expectCode(upload("Huge.woff2", "font/woff2", append([]byte("wOF2"), bytes.Repeat([]byte{0}, 2<<20)...)),
		http.StatusRequestEntityTooLarge, "signage_asset_too_large")
	e.expectCode(upload("Sneaky.ttf", "font/ttf", font), http.StatusBadRequest, "invalid_request")

	// Download and listing by kind.
	response := e.as(staff, http.MethodGet, "/signage/assets/"+asset["id"].(string)+"/content", nil)
	if response.StatusCode != http.StatusOK || response.Header.Get("Content-Type") != "font/woff2" {
		t.Fatalf("download = %d %q", response.StatusCode, response.Header.Get("Content-Type"))
	}
	response.Body.Close()
	listed := e.expect(e.as(staff, http.MethodGet, "/signage/assets?kind=font", nil), http.StatusOK)["items"].([]any)
	if len(listed) != 1 || listed[0].(map[string]any)["id"] != asset["id"] {
		t.Fatalf("fonts = %v", listed)
	}

	// References: style.fontAssetId and fontAssetIds must be font assets.
	style := func(family string, fontID any) map[string]any {
		return map[string]any{
			"textColor": nil, "backgroundColor": "#112233", "borderColor": nil, "backgroundOpacity": 80, "padding": 1,
			"radius": 1, "borderWidth": 0, "fontScale": 100, "fontFamily": family, "fontAssetId": fontID,
			"align": "inherit", "verticalAlign": "center",
		}
	}
	text := func(extra map[string]any) map[string]any {
		widget := map[string]any{"type": "text", "text": "Hello", "size": "m", "align": "start"}
		for key, value := range extra {
			widget[key] = value
		}
		return map[string]any{"main": widget}
	}
	image := e.fixture.uploadImage(t, "poster.jpg")
	e.expectCode(e.as(staff, http.MethodPost, "/signage/scenes", sceneBody("full", "", text(map[string]any{"style": style("custom", image.ID.String())}))),
		http.StatusUnprocessableEntity, "validation_failed")
	e.expectCode(e.as(staff, http.MethodPost, "/signage/scenes", sceneBody("full", "", text(map[string]any{"fontAssetIds": []string{ids.New().String()}}))),
		http.StatusUnprocessableEntity, "validation_failed")
	e.expectCode(e.as(staff, http.MethodPost, "/signage/scenes", sceneBody("full", "", text(map[string]any{"style": style("custom", nil)}))),
		http.StatusUnprocessableEntity, "validation_failed")
	scene := e.createScene(staff, sceneBody("full", "", text(map[string]any{
		"format": "markdown", "css": "p { margin: 0 }", "fontAssetIds": []string{asset["id"].(string)},
		"style": style("custom", asset["id"].(string)),
	})))
	stored := scene["zones"].(map[string]any)["main"].(map[string]any)
	if stored["format"] != "markdown" || stored["style"].(map[string]any)["fontAssetId"] != asset["id"] {
		t.Fatalf("stored widget = %v", stored)
	}

	// A used font cannot be deleted; the scene lists it.
	blocked := e.expect(e.as(staff, http.MethodDelete, "/signage/assets/"+asset["id"].(string), nil), http.StatusConflict)
	if blocked["code"] != "signage_in_use" {
		t.Fatalf("blocked = %v", blocked)
	}
	e.expect(e.as(staff, http.MethodDelete, "/signage/scenes/"+scene["id"].(string), map[string]any{"expectedVersion": 1}), http.StatusNoContent)
	e.expect(e.as(staff, http.MethodDelete, "/signage/assets/"+asset["id"].(string), nil), http.StatusNoContent)
}

func TestSignageOldScenesAndAnnouncementBodyFormats(t *testing.T) {
	e := newSignageEnv(t)
	staff := e.allStaff()
	// A widget exactly as stored before this extension still validates and keeps its form.
	scene := e.createScene(staff, sceneBody("full", "", map[string]any{"main": map[string]any{"type": "events", "count": 3}}))
	if zone := scene["zones"].(map[string]any)["main"].(map[string]any); len(zone) != 2 || zone["count"] != float64(3) {
		t.Fatalf("old widget changed: %v", zone)
	}
	template := e.expect(e.as(staff, http.MethodPost, "/signage/announcement-templates", map[string]any{
		"name": "Rich", "tone": "info", "title": "Note", "body": "**{note}** until {ends_at}", "bodyFormat": "markdown",
		"bodyCss": "strong { color: red }", "fields": []map[string]any{{
			"key": "note", "label": "Note", "type": "text", "required": true, "defaultValue": "", "helperText": "", "options": []string{},
		}},
	}), http.StatusCreated)
	if template["bodyFormat"] != "markdown" || template["bodyCss"] != "strong { color: red }" {
		t.Fatalf("template = %v", template)
	}
	started := e.expect(e.as(staff, http.MethodPost, "/signage/announcements", map[string]any{
		"templateId": template["id"], "values": map[string]string{"note": "<b>1. a_b</b>"}, "allDisplays": true, "displayIds": []string{},
	}), http.StatusCreated)
	rendered := started["rendered"].(map[string]any)
	if rendered["bodyFormat"] != "markdown" || rendered["bodyCss"] != "strong { color: red }" ||
		!strings.HasPrefix(rendered["body"].(string), `**&lt;b&gt;1\. a\_b&lt;/b&gt;**`) {
		t.Fatalf("rendered = %v", rendered)
	}
	plain := e.expect(e.as(staff, http.MethodPost, "/signage/announcement-templates", map[string]any{
		"name": "Plain", "tone": "info", "title": "Note", "body": "{note}", "fields": []map[string]any{{
			"key": "note", "label": "Note", "type": "text", "required": false, "defaultValue": "", "helperText": "", "options": []string{},
		}},
	}), http.StatusCreated)
	if plain["bodyFormat"] != "plain" || plain["bodyCss"] != "" {
		t.Fatalf("plain template = %v", plain)
	}
	e.expectCode(e.as(staff, http.MethodPost, "/signage/announcement-templates", map[string]any{
		"name": "Long", "tone": "info", "title": "Note", "body": strings.Repeat("x", 5001), "fields": []map[string]any{},
	}), http.StatusBadRequest, "invalid_request")
}

func TestSignageCalendarBlockOnlyWithPublishedCalendarWidget(t *testing.T) {
	e := newSignageEnv(t)
	ctx := testContext(t)
	admin := e.fixture.admin
	staff := e.allStaff()

	// One academic break around today and one public event in two days.
	if _, err := e.pool.Exec(ctx,
		`INSERT INTO open_day_academic_breaks (id, name, starts_on, ends_on) VALUES ($1, 'Semester break', current_date - 1, current_date + 2)`,
		ids.New()); err != nil {
		t.Fatal(err)
	}
	baseURL, _ := url.Parse("https://makerspace.example.test")
	store, err := storage.NewLocal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	eventService, err := events.NewService(e.pool, config.Config{
		MakerspaceTimeZone: "Europe/Vienna", PublicBaseURL: baseURL, ChallengeHMACKey: []byte("calendar-widget-key"),
	}, files.NewService(e.pool, store))
	if err != nil {
		t.Fatal(err)
	}
	owner, title, location := admin.PersonID, "Public soldering", "Workshop floor"
	event, err := eventService.Create(ctx, admin, events.EventInput{Name: "Soldering", OwnerPersonID: &owner}, nil)
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now().UTC().Add(48 * time.Hour).Truncate(time.Minute)
	if _, err = eventService.CreateSession(ctx, admin, event.ID,
		events.SessionInput{StartsAt: start, EndsAt: start.Add(2 * time.Hour), IsPublic: true, Status: "scheduled"}, nil); err != nil {
		t.Fatal(err)
	}
	confirmed, err := eventService.Transition(ctx, admin, event.ID, event.Version, "confirmed", nil)
	if err != nil {
		t.Fatal(err)
	}
	updated, err := eventService.Update(ctx, admin, event.ID, events.EventInput{
		Name: "Soldering", OwnerPersonID: &owner, PublicTitle: &title, PublicLocation: &location, ExpectedVersion: confirmed.Version,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = eventService.SetPublished(ctx, admin, event.ID, updated.Version, true, nil); err != nil {
		t.Fatal(err)
	}

	calendarWidget := func(breaks, eventsShown bool) map[string]any {
		return map[string]any{"main": map[string]any{
			"type": "calendar", "view": "month", "weeks": 1, "showHolidays": false, "showBreaks": breaks, "showOpenDays": false,
			"showEvents": eventsShown, "showWeekNumbers": true,
			"colors": map[string]any{"holiday": "#ff0000", "break": "#00ff00", "openDay": "#0000ff", "event": "#ffff00"},
		}}
	}
	liveCalendar := func(zones map[string]any) map[string]any {
		t.Helper()
		scene := e.createScene(staff, sceneBody("full", "", zones))
		sceneID, err := uuid.Parse(scene["id"].(string))
		if err != nil {
			t.Fatal(err)
		}
		playlist := e.fixture.playlist(t, "Calendar "+uuid.NewString()[:8], sceneID)
		display, player := e.pair(staff, "Calendar "+uuid.NewString()[:8], playlist.ID)
		e.expect(e.as(staff, http.MethodPost, "/signage/displays/"+display["id"].(string)+"/publish", nil), http.StatusOK)
		live := e.expect(e.do(player, "", http.MethodGet, "/signage/player/live", nil), http.StatusOK)
		block, _ := live["calendar"].(map[string]any)
		return block
	}

	if block := liveCalendar(map[string]any{"main": map[string]any{"type": "clock", "mode": "time"}}); block != nil {
		t.Fatalf("display without calendar widget got a calendar: %v", block)
	}
	onlyBreaks := liveCalendar(calendarWidget(true, false))
	if onlyBreaks == nil || len(onlyBreaks["breaks"].([]any)) != 1 || len(onlyBreaks["events"].([]any)) != 0 ||
		len(onlyBreaks["holidays"].([]any)) != 0 || len(onlyBreaks["openDays"].([]any)) != 0 {
		t.Fatalf("calendar with breaks only = %v", onlyBreaks)
	}
	from, _ := time.Parse("2006-01-02", onlyBreaks["from"].(string))
	to, _ := time.Parse("2006-01-02", onlyBreaks["to"].(string))
	if from.After(time.Now()) || to.Before(time.Now().AddDate(0, 0, 48)) {
		t.Fatalf("range %v..%v does not cover today..today+48", from, to)
	}
	onlyEvents := liveCalendar(calendarWidget(false, true))
	eventList := onlyEvents["events"].([]any)
	if len(onlyEvents["breaks"].([]any)) != 0 || len(eventList) != 1 ||
		eventList[0].(map[string]any)["title"] != title || eventList[0].(map[string]any)["endsAt"] == nil {
		t.Fatalf("calendar with events only = %v", onlyEvents)
	}

	// The admin preview endpoint carries every category.
	preview := e.expect(e.as(staff, http.MethodGet, "/signage/calendar", nil), http.StatusOK)["calendar"].(map[string]any)
	if len(preview["breaks"].([]any)) != 1 || len(preview["events"].([]any)) != 1 {
		t.Fatalf("preview calendar = %v", preview)
	}
	if fmt.Sprint(preview["from"]) != fmt.Sprint(onlyBreaks["from"]) {
		t.Fatalf("preview range differs: %v vs %v", preview["from"], onlyBreaks["from"])
	}
}
