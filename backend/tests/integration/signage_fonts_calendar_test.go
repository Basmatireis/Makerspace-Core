package integration_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/events"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/storage"
	"github.com/google/uuid"
)

func versionOf(body map[string]any) int64 { return int64(body["version"].(float64)) }

// testBlockStyleBody is the default block style as a request body value.
func testBlockStyleBody() map[string]any {
	var style map[string]any
	if err := json.Unmarshal([]byte(testBlockStyle), &style); err != nil {
		panic(err)
	}
	return style
}

// sceneBody is a 16:9 scene request whose blocks show the widgets by block id (in id order, each covering the scene).
func sceneBody(widgets map[string]any) map[string]any {
	keys := make([]string, 0, len(widgets))
	for key := range widgets {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	blocks := make([]any, 0, len(keys))
	for _, key := range keys {
		blocks = append(blocks, map[string]any{
			"id": key, "name": "Block " + key, "x": 0, "y": 0, "w": 1920, "h": 1080, "hidden": false, "locked": false,
			"widget": widgets[key], "style": testBlockStyleBody(),
		})
	}
	return map[string]any{
		"name": "Scene " + uuid.NewString()[:8], "aspectRatio": map[string]any{"width": 16, "height": 9},
		"backgroundColor": "#101820", "backgroundFit": "cover", "backgroundDim": 0, "theme": "dark",
		"fontFamily": "sans", "fontAssetId": nil, "blocks": blocks,
	}
}

// blockOf returns the block with the id from a scene response.
func blockOf(scene map[string]any, id string) map[string]any {
	for _, raw := range scene["blocks"].([]any) {
		block := raw.(map[string]any)
		if block["id"] == id {
			return block
		}
	}
	return nil
}

func (e *signageEnv) createScene(staff staffSession, body map[string]any) map[string]any {
	e.t.Helper()
	return e.expect(e.as(staff, http.MethodPost, "/signage/scenes", body), http.StatusCreated)
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

	// References: the block style's fontAssetId and the widget's fontAssetIds must be font assets.
	text := func(extra map[string]any, family string, fontID any) map[string]any {
		widget := map[string]any{"type": "text", "text": "Hello", "fit": false}
		for key, value := range extra {
			widget[key] = value
		}
		body := sceneBody(map[string]any{"main": widget})
		style := body["blocks"].([]any)[0].(map[string]any)["style"].(map[string]any)
		style["fontFamily"], style["fontAssetId"] = family, fontID
		return body
	}
	image := e.fixture.uploadImage(t, "poster.jpg")
	e.expectCode(e.as(staff, http.MethodPost, "/signage/scenes", text(nil, "custom", image.ID.String())),
		http.StatusUnprocessableEntity, "validation_failed")
	e.expectCode(e.as(staff, http.MethodPost, "/signage/scenes",
		text(map[string]any{"fontAssetIds": []string{ids.New().String()}}, "inherit", nil)),
		http.StatusUnprocessableEntity, "validation_failed")
	e.expectCode(e.as(staff, http.MethodPost, "/signage/scenes", text(nil, "custom", nil)),
		http.StatusUnprocessableEntity, "validation_failed")
	scene := e.createScene(staff, text(map[string]any{
		"format": "markdown", "css": "p { margin: 0 }", "fontAssetIds": []string{asset["id"].(string)},
	}, "custom", asset["id"].(string)))
	stored := blockOf(scene, "main")
	if stored["widget"].(map[string]any)["format"] != "markdown" ||
		stored["style"].(map[string]any)["fontAssetId"] != asset["id"] {
		t.Fatalf("stored block = %v", stored)
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
	scene := e.createScene(staff, sceneBody(map[string]any{"main": map[string]any{"type": "events", "count": 3}}))
	if zone := blockOf(scene, "main")["widget"].(map[string]any); len(zone) != 2 || zone["count"] != float64(3) {
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
		"templateId": template["id"], "values": map[string]string{"note": "<b>1. a_b</b>"}, "allDisplays": true, "displayIds": []string{}, "groupIds": []string{},
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
		scene := e.createScene(staff, sceneBody(zones))
		sceneID, err := uuid.Parse(scene["id"].(string))
		if err != nil {
			t.Fatal(err)
		}
		defaults := sceneList(sceneID)
		display, player := e.pair(staff, "Calendar "+uuid.NewString()[:8], defaults)
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
