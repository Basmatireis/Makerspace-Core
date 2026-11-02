package integration_test

import (
	"bytes"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/signage"
	"github.com/google/uuid"
)

func (e *signageEnv) uploadFont(staff staffSession, name string) map[string]any {
	e.t.Helper()
	font := append([]byte("wOF2"), bytes.Repeat([]byte{0}, 200)...)
	return e.expect(e.doRaw(staff.client, staff.csrf, http.MethodPost, "/signage/assets", font,
		"X-File-Name", url.PathEscape(name), "X-File-Content-Type", "font/woff2"), http.StatusCreated)
}

func sceneUpdateBody(scene map[string]any) map[string]any {
	return map[string]any{
		"expectedVersion": scene["version"], "name": scene["name"], "aspectRatio": scene["aspectRatio"],
		"layoutId": scene["layoutId"], "backgroundColor": scene["backgroundColor"], "backgroundFit": scene["backgroundFit"],
		"backgroundDim": scene["backgroundDim"], "theme": scene["theme"],
		"fontFamily": scene["fontFamily"], "fontAssetId": scene["fontAssetId"],
	}
}

func TestSignageSceneFontRoundTripManifestAndDelete(t *testing.T) {
	e := newSignageEnv(t)
	staff := e.allStaff()
	font := e.uploadFont(staff, "Scene.woff2")
	fontID := font["id"].(string)
	image := e.fixture.uploadImage(t, "poster.jpg")

	// The default is sans without an asset.
	omitted := sceneBody("full", "", nil)
	delete(omitted, "fontFamily")
	delete(omitted, "fontAssetId")
	plain := e.createScene(staff, omitted)
	if plain["fontFamily"] != "sans" || plain["fontAssetId"] != nil {
		t.Fatalf("default font = %v / %v", plain["fontFamily"], plain["fontAssetId"])
	}

	// Custom needs a font asset; a font asset needs custom; the asset must be a font.
	custom := sceneBody("full", "", nil)
	custom["fontFamily"] = "custom"
	e.expectCode(e.as(staff, http.MethodPost, "/signage/scenes", custom), http.StatusUnprocessableEntity, "validation_failed")
	custom["fontAssetId"] = image.ID.String()
	e.expectCode(e.as(staff, http.MethodPost, "/signage/scenes", custom), http.StatusUnprocessableEntity, "validation_failed")
	custom["fontAssetId"] = ids.New().String()
	e.expectCode(e.as(staff, http.MethodPost, "/signage/scenes", custom), http.StatusUnprocessableEntity, "validation_failed")
	serif := sceneBody("full", "", nil)
	serif["fontFamily"] = "serif"
	serif["fontAssetId"] = fontID
	e.expectCode(e.as(staff, http.MethodPost, "/signage/scenes", serif), http.StatusUnprocessableEntity, "validation_failed")
	serif["fontFamily"] = "comic"
	delete(serif, "fontAssetId")
	expectRejected(t, e.as(staff, http.MethodPost, "/signage/scenes", serif))

	custom["fontAssetId"] = fontID
	scene := e.createScene(staff, custom)
	if scene["fontFamily"] != "custom" || scene["fontAssetId"] != fontID {
		t.Fatalf("custom scene = %v", scene)
	}
	got := e.expect(e.as(staff, http.MethodGet, "/signage/scenes/"+scene["id"].(string), nil), http.StatusOK)
	if got["fontFamily"] != "custom" || got["fontAssetId"] != fontID {
		t.Fatalf("stored scene = %v", got)
	}

	// Update validates the same way.
	body := sceneUpdateBody(scene)
	body["fontAssetId"] = nil
	e.expectCode(e.as(staff, http.MethodPut, "/signage/scenes/"+scene["id"].(string), body), http.StatusUnprocessableEntity, "validation_failed")
	body["fontAssetId"] = image.ID.String()
	e.expectCode(e.as(staff, http.MethodPut, "/signage/scenes/"+scene["id"].(string), body), http.StatusUnprocessableEntity, "validation_failed")

	// The font reaches the manifest of a publication, including its asset.
	display, player := e.pair(staff, "Font display", sceneList(uuid.MustParse(scene["id"].(string))))
	displayID := display["id"].(string)
	e.expect(e.as(staff, http.MethodPost, "/signage/displays/"+displayID+"/publish", nil), http.StatusOK)
	manifest := e.expect(e.do(player, "", http.MethodGet, "/signage/player/manifest", nil), http.StatusOK)["manifest"].(map[string]any)
	published := manifest["scenes"].([]any)[0].(map[string]any)
	if published["fontFamily"] != "custom" || published["fontAssetId"] != fontID {
		t.Fatalf("published scene = %v", published)
	}
	foundFont := false
	for _, asset := range manifest["assets"].([]any) {
		if asset.(map[string]any)["id"] == fontID && asset.(map[string]any)["kind"] == "font" {
			foundFont = true
		}
	}
	if !foundFont {
		t.Fatalf("manifest assets = %v", manifest["assets"])
	}

	// The font cannot be deleted while the scene uses it; the scene is listed as a reference.
	blocked := e.expect(e.as(staff, http.MethodDelete, "/signage/assets/"+fontID, nil), http.StatusConflict)
	references := blocked["details"].(map[string]any)["references"].([]any)
	if blocked["code"] != "signage_in_use" || len(references) != 1 ||
		references[0].(map[string]any)["kind"] != "scene" || references[0].(map[string]any)["id"] != scene["id"] {
		t.Fatalf("blocked = %v", blocked)
	}

	// Switching the scene back to a built-in font releases the asset.
	body = sceneUpdateBody(got)
	body["fontFamily"] = "mono"
	body["fontAssetId"] = nil
	updated := e.expect(e.as(staff, http.MethodPut, "/signage/scenes/"+scene["id"].(string), body), http.StatusOK)
	if updated["fontFamily"] != "mono" || updated["fontAssetId"] != nil {
		t.Fatalf("updated scene = %v", updated)
	}
	e.expect(e.as(staff, http.MethodDelete, "/signage/assets/"+fontID, nil), http.StatusNoContent)
}

func TestSignageClockDateMode(t *testing.T) {
	e := newSignageEnv(t)
	staff := e.allStaff()
	scene := e.createScene(staff, sceneBody("full", "", map[string]any{"main": map[string]any{"type": "clock", "mode": "date"}}))
	if scene["zones"].(map[string]any)["main"].(map[string]any)["mode"] != "date" {
		t.Fatalf("scene = %v", scene)
	}
	expectRejected(t, e.as(staff, http.MethodPost, "/signage/scenes",
		sceneBody("full", "", map[string]any{"main": map[string]any{"type": "clock", "mode": "weekday"}})))
}

func jsonEqual(a, b any) bool { return reflect.DeepEqual(a, b) }

func expectRejected(t *testing.T, response *http.Response) {
	t.Helper()
	defer response.Body.Close()
	if response.StatusCode != http.StatusBadRequest && response.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 400 or 422", response.StatusCode)
	}
}

func TestSignageDuplicateScene(t *testing.T) {
	e := newSignageEnv(t)
	staff := e.allStaff()
	editor := e.staff("dup-scene-editor", authorization.SignageContentManage)
	reader := e.staff("dup-scene-reader", authorization.SignageRead)
	manager := e.staff("dup-scene-manager", authorization.SignageManage, authorization.SignagePublish)
	font := e.uploadFont(staff, "Dup.woff2")

	body := sceneBody("split", "", map[string]any{
		"left":  map[string]any{"type": "clock", "mode": "datetime"},
		"right": map[string]any{"type": "text", "text": "Hello", "size": "m", "align": "start"},
	})
	body["name"] = "Welcome"
	body["backgroundDim"] = 35
	body["theme"] = "light"
	body["fontFamily"] = "custom"
	body["fontAssetId"] = font["id"]
	body["aspectRatio"] = map[string]any{"width": 9, "height": 16}
	source := e.createScene(staff, body)
	path := "/signage/scenes/" + source["id"].(string) + "/duplicate"

	for name, session := range map[string]staffSession{"reader": reader, "manager": manager} {
		e.expectCode(e.as(session, http.MethodPost, path, nil), http.StatusForbidden, "permission_denied")
		_ = name
	}
	e.expect(e.do(e.newPlayer(), "", http.MethodPost, path, nil), http.StatusUnauthorized)
	before := e.countAudit("signage_scene.created")

	first := e.expect(e.as(editor, http.MethodPost, path, nil), http.StatusCreated)
	if first["name"] != "Welcome (copy)" || first["id"] == source["id"] || versionOf(first) != 1 {
		t.Fatalf("first copy = %v", first)
	}
	for _, key := range []string{
		"aspectRatio", "layoutId", "customLayoutId", "backgroundColor", "backgroundAssetId", "backgroundFit",
		"backgroundDim", "theme", "fontFamily", "fontAssetId", "zones",
	} {
		if !jsonEqual(first[key], source[key]) {
			t.Fatalf("copy %s = %v, want %v", key, first[key], source[key])
		}
	}
	second := e.expect(e.as(editor, http.MethodPost, path, nil), http.StatusCreated)
	if second["name"] != "Welcome (copy 2)" {
		t.Fatalf("second copy = %v", second["name"])
	}
	// Copying a copy continues from the copy's name.
	third := e.expect(e.as(editor, http.MethodPost, "/signage/scenes/"+first["id"].(string)+"/duplicate", nil), http.StatusCreated)
	if third["name"] != "Welcome (copy) (copy)" {
		t.Fatalf("third copy = %v", third["name"])
	}
	if after := e.countAudit("signage_scene.created"); after != before+3 {
		t.Fatalf("created audit rows %d -> %d, want +3", before, after)
	}
	e.expectCode(e.as(editor, http.MethodPost, "/signage/scenes/"+ids.New().String()+"/duplicate", nil), http.StatusNotFound, "not_found")

	// A long name is truncated so that the suffixed name fits 100 characters.
	long := sceneBody("full", "", nil)
	long["name"] = strings.Repeat("x", 100)
	longScene := e.createScene(staff, long)
	longCopy := e.expect(e.as(editor, http.MethodPost, "/signage/scenes/"+longScene["id"].(string)+"/duplicate", nil), http.StatusCreated)
	if want := strings.Repeat("x", 93) + " (copy)"; longCopy["name"] != want {
		t.Fatalf("long copy = %v", longCopy["name"])
	}
	longCopy = e.expect(e.as(editor, http.MethodPost, "/signage/scenes/"+longScene["id"].(string)+"/duplicate", nil), http.StatusCreated)
	if want := strings.Repeat("x", 91) + " (copy 2)"; longCopy["name"] != want {
		t.Fatalf("second long copy = %v", longCopy["name"])
	}
}

func TestSignageDuplicateAnnouncementTemplate(t *testing.T) {
	e := newSignageEnv(t)
	editor := e.staff("dup-template-editor", authorization.SignageContentManage)
	reader := e.staff("dup-template-reader", authorization.SignageRead)
	source, err := e.fixture.service.CreateTemplate(testContext(t), e.fixture.admin, signage.TemplateInput{
		Name:  "Machine down",
		Tone:  "warning",
		Title: "{machine} out of order",
		Body:  "Back {back_on}. Room {room}.",
		Fields: []signage.TemplateField{
			{Key: "machine", Label: "Machine", Type: "machine", Required: true},
			{Key: "back_on", Label: "Back on", Type: "datetime"},
			{Key: "room", Label: "Room", Type: "choice", Options: []string{"Wood", "Metal"}, DefaultValue: "Wood", HelperText: "Where"},
		},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	path := "/signage/announcement-templates/" + source.ID.String() + "/duplicate"
	e.expectCode(e.as(reader, http.MethodPost, path, nil), http.StatusForbidden, "permission_denied")
	before := e.countAudit("signage_announcement_template.created")

	first := e.expect(e.as(editor, http.MethodPost, path, nil), http.StatusCreated)
	if first["name"] != "Machine down (copy)" || first["id"] == source.ID.String() || versionOf(first) != 1 ||
		first["tone"] != "warning" || first["title"] != "{machine} out of order" || first["body"] != "Back {back_on}. Room {room}." {
		t.Fatalf("copy = %v", first)
	}
	fields := first["fields"].([]any)
	if len(fields) != 3 || fields[0].(map[string]any)["key"] != "machine" || fields[0].(map[string]any)["required"] != true ||
		fields[2].(map[string]any)["defaultValue"] != "Wood" || fields[2].(map[string]any)["helperText"] != "Where" ||
		len(fields[2].(map[string]any)["options"].([]any)) != 2 {
		t.Fatalf("copied fields = %v", fields)
	}
	second := e.expect(e.as(editor, http.MethodPost, path, nil), http.StatusCreated)
	if second["name"] != "Machine down (copy 2)" || len(second["fields"].([]any)) != 3 {
		t.Fatalf("second copy = %v", second)
	}
	if after := e.countAudit("signage_announcement_template.created"); after != before+2 {
		t.Fatalf("created audit rows %d -> %d, want +2", before, after)
	}
	e.expectCode(e.as(editor, http.MethodPost, "/signage/announcement-templates/"+ids.New().String()+"/duplicate", nil),
		http.StatusNotFound, "not_found")
}

func TestSignageDuplicateCustomLayout(t *testing.T) {
	e := newSignageEnv(t)
	editor := e.staff("dup-layout-editor", authorization.SignageContentManage)
	viewer := e.staff("dup-layout-viewer", authorization.SignageRead)
	source := e.createLayout(editor, layoutBody("Wall", gridZoneBody("a", 1, 1, 1, 1), gridZoneBody("b", 2, 1, 1, 1)))
	path := "/signage/custom-layouts/" + source["id"].(string) + "/duplicate"
	e.expectCode(e.as(viewer, http.MethodPost, path, nil), http.StatusForbidden, "permission_denied")
	before := e.countAudit("signage_custom_layout.created")

	first := e.expect(e.as(editor, http.MethodPost, path, nil), http.StatusCreated)
	if first["name"] != "Wall (copy)" || first["id"] == source["id"] || versionOf(first) != 1 || first["sceneCount"] != float64(0) {
		t.Fatalf("copy = %v", first)
	}
	for _, key := range []string{"mode", "columns", "rows", "zones"} {
		if !jsonEqual(first[key], source[key]) {
			t.Fatalf("copy %s = %v, want %v", key, first[key], source[key])
		}
	}
	second := e.expect(e.as(editor, http.MethodPost, path, nil), http.StatusCreated)
	if second["name"] != "Wall (copy 2)" {
		t.Fatalf("second copy = %v", second["name"])
	}
	if after := e.countAudit("signage_custom_layout.created"); after != before+2 {
		t.Fatalf("created audit rows %d -> %d, want +2", before, after)
	}
	e.expectCode(e.as(editor, http.MethodPost, "/signage/custom-layouts/"+ids.New().String()+"/duplicate", nil),
		http.StatusNotFound, "not_found")
}
