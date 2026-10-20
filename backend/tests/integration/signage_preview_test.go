package integration_test

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/signage"
	"github.com/google/uuid"
)

func TestSignageDisplayPreview(t *testing.T) {
	e := newSignageEnv(t)
	ctx := testContext(t)
	staff := e.allStaff()
	svc, admin := e.fixture.service, e.fixture.admin
	watched := e.printer("Preview printer")
	watched.report("printing", time.Now().UTC())

	input := sceneInput("Preview scene", "full")
	input.Zones = map[string]json.RawMessage{
		"main": json.RawMessage(
			`{"type":"status","machineIds":["` + watched.machineID.String() + `"],"showProgress":true,"showRemaining":true}`,
		),
	}
	scene, err := svc.CreateScene(ctx, admin, input, nil)
	if err != nil {
		t.Fatal(err)
	}
	playlist := e.fixture.playlist(t, "Preview", scene.ID)
	display, _ := e.pair(staff, "Preview display", playlist.ID)
	other, _ := e.pair(staff, "Other display", playlist.ID)
	displayID := display["id"].(string)
	path := "/signage/displays/" + displayID + "/preview"

	template, err := svc.CreateTemplate(
		ctx,
		admin,
		signage.TemplateInput{Name: "Notice", Tone: "info", Title: "Hello {display}", Body: ""},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{displayID, other["id"].(string)} {
		if _, err := svc.StartAnnouncement(ctx, admin, signage.AnnouncementInput{TemplateID: template.ID, DisplayIDs: []uuid.UUID{uuid.MustParse(target)}}, nil); err != nil {
			t.Fatal(err)
		}
	}

	// Permission: only signage.read.
	reader := e.staff("preview-reader", authorization.SignageRead)
	for name, denied := range map[string]staffSession{
		"nobody":  e.staff("preview-nobody"),
		"manager": e.staff("preview-manager", authorization.SignageManage),
		"publish": e.staff("preview-publisher", authorization.SignagePublish),
		"content": e.staff("preview-content", authorization.SignageContentManage, authorization.SignageOverride),
	} {
		t.Run("denied "+name, func(t *testing.T) {
			e.expectCode(e.as(denied, http.MethodGet, path, nil), http.StatusForbidden, "permission_denied")
		})
	}
	e.expectCode(
		e.as(reader, http.MethodGet, "/signage/displays/"+uuid.Must(uuid.NewV7()).String()+"/preview", nil),
		http.StatusNotFound,
		"not_found",
	)

	// Never published: no manifest, but the announcements in force for this display (not the other's).
	response := e.as(reader, http.MethodGet, path, nil)
	if response.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control = %q", response.Header.Get("Cache-Control"))
	}
	body := e.expect(response, http.StatusOK)
	live := body["live"].(map[string]any)
	if body["manifest"] != nil || live["revision"] != nil || len(live["machines"].([]any)) != 0 {
		t.Fatalf("unpublished preview = %v", body)
	}
	announcements := live["announcements"].([]any)
	if len(announcements) != 1 || announcements[0].(map[string]any)["title"] != "Hello Preview display" {
		t.Fatalf("announcements = %v", announcements)
	}

	// After publishing: the latest publication and the live state of the machines it uses.
	e.expect(e.as(staff, http.MethodPost, "/signage/displays/"+displayID+"/publish", nil), http.StatusOK)
	body = e.expect(e.as(reader, http.MethodGet, path, nil), http.StatusOK)
	manifest, _ := body["manifest"].(map[string]any)
	if manifest == nil || manifest["revision"] != float64(1) || len(manifest["scenes"].([]any)) != 1 {
		t.Fatalf("published preview manifest = %v", body["manifest"])
	}
	live = body["live"].(map[string]any)
	machines := live["machines"].([]any)
	if live["revision"] != float64(1) || len(machines) != 1 || machines[0].(map[string]any)["state"] != "printing" ||
		machines[0].(map[string]any)["name"] != "Preview printer" {
		t.Fatalf("live = %v", live)
	}
}
