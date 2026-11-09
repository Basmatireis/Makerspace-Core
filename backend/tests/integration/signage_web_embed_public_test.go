package integration_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
)

// publicGet requests a public embed endpoint without any credential and checks that no cookie is set.
func (e *signageEnv) publicGet(path string) *http.Response {
	e.t.Helper()
	response := e.do(e.newPlayer(), "", http.MethodGet, path, nil)
	if cookies := response.Header.Values("Set-Cookie"); len(cookies) != 0 {
		e.t.Fatalf("%s set cookies: %v", path, cookies)
	}
	return response
}

func TestSignageEmbedPublicEndpoints(t *testing.T) {
	e := newSignageEnv(t)
	ctx := testContext(t)
	staff := e.allStaff()
	asset := e.fixture.uploadImage(t, "Embed background")
	input := sceneInput("Embed scene", "full")
	input.BackgroundAssetID = &asset.ID
	scene, err := e.fixture.service.CreateScene(ctx, e.fixture.admin, input, nil)
	if err != nil {
		t.Fatal(err)
	}
	embed := e.expect(e.as(staff, http.MethodPost, "/signage/web-embeds", map[string]any{
		"name": "Website", "aspectRatio": map[string]any{"width": 16, "height": 9},
		"allowedOrigins": []string{"https://www.example.org", "https://b.example:8443"}, "defaultScenes": sceneList(scene.ID),
	}), http.StatusCreated)
	id, key := embed["id"].(string), embed["embedKey"].(string)
	base := "/public/signage/embeds/" + key

	framePolicy := func(key string) string {
		t.Helper()
		response := e.publicGet("/public/signage/embeds/" + key + "/frame-policy")
		header := response.Header.Get("X-Embed-Frame-Ancestors")
		body := e.expect(response, http.StatusOK)
		if body["frameAncestors"] != header {
			t.Fatalf("frame policy body %v and header %q differ", body, header)
		}
		return header
	}
	// An unknown key answers 200 with 'none', because the web server's sub-request treats other answers as failures.
	unknown := strings.Repeat("A", 32)
	if got := framePolicy(unknown); got != "'none'" {
		t.Fatalf("unknown frame policy = %q", got)
	}
	if got := framePolicy(key); got != "https://www.example.org https://b.example:8443" {
		t.Fatalf("frame policy = %q", got)
	}
	e.expectCode(e.publicGet("/public/signage/embeds/"+unknown+"/manifest"), http.StatusNotFound, "not_found")
	e.expectCode(e.publicGet("/public/signage/embeds/"+unknown+"/live"), http.StatusNotFound, "not_found")
	e.expectCode(e.publicGet(base+"/manifest"), http.StatusNotFound, "signage_not_published")

	e.expect(e.as(staff, http.MethodPost, "/signage/web-embeds/"+id+"/publish", nil), http.StatusOK)
	response := e.publicGet(base + "/manifest")
	if response.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("manifest Cache-Control = %q", response.Header.Get("Cache-Control"))
	}
	body := e.expect(response, http.StatusOK)
	settings := body["embed"].(map[string]any)
	manifest := body["manifest"].(map[string]any)
	if settings["enabled"] != true || settings["openDirectly"] != false || !hasAspectRatio(settings, 16, 9) ||
		body["unchanged"] != false || manifest["revision"] != float64(1) || manifest["embedMedia"] != nil {
		t.Fatalf("embed manifest = %v", body)
	}
	assets := manifest["assets"].([]any)
	assetURL := assets[0].(map[string]any)["url"].(string)
	if len(assets) != 1 || assetURL != "/api/v1"+base+"/assets/"+asset.ID.String()+"/"+asset.SHA256 {
		t.Fatalf("embed assets = %v", assets)
	}
	assetResponse := e.publicGet(strings.TrimPrefix(assetURL, "/api/v1"))
	if assetResponse.StatusCode != http.StatusOK ||
		assetResponse.Header.Get("Cache-Control") != "private, max-age=31536000, immutable" {
		t.Fatalf("embed asset = %d %v", assetResponse.StatusCode, assetResponse.Header)
	}
	assetResponse.Body.Close()
	e.expectCode(e.publicGet(base+"/assets/"+asset.ID.String()+"/"+strings.Repeat("0", 64)), http.StatusNotFound,
		"not_found")
	if unchanged := e.expect(e.publicGet(base+"/manifest?known=1"), http.StatusOK); unchanged["unchanged"] != true ||
		unchanged["manifest"] != nil {
		t.Fatalf("unchanged manifest = %v", unchanged)
	}
	e.expect(e.publicGet(base+"/manifest?known=0"), http.StatusOK)
	// Three page loads (no known revision or 0, the one before the first publication included); the poll with a
	// known revision is not counted.
	if got := e.embed(staff, id); got["loadsToday"] != float64(3) || got["lastLoadedAt"] == nil {
		t.Fatalf("embed load counter = %v %v", got["loadsToday"], got["lastLoadedAt"])
	}
	live := e.expect(e.publicGet(base+"/live"), http.StatusOK)
	if live["revision"] != float64(1) || len(live["streams"].([]any)) != 0 || live["timelapses"] != nil {
		t.Fatalf("embed live = %v", live)
	}

	// Switched off: the manifest says so without content, everything else is gone, the page may still be framed.
	e.expect(e.patchEmbed(staff, id, map[string]any{"enabled": false}), http.StatusOK)
	off := e.expect(e.publicGet(base+"/manifest"), http.StatusOK)
	if off["embed"].(map[string]any)["enabled"] != false || off["manifest"] != nil {
		t.Fatalf("switched-off manifest = %v", off)
	}
	e.expectCode(e.publicGet(base+"/live"), http.StatusNotFound, "not_found")
	e.expectCode(e.publicGet(strings.TrimPrefix(assetURL, "/api/v1")), http.StatusNotFound, "not_found")
	if got := framePolicy(key); got != "https://www.example.org https://b.example:8443" {
		t.Fatalf("switched-off frame policy = %q", got)
	}

	// A new key ends the old one at once.
	e.expect(e.patchEmbed(staff, id, map[string]any{"enabled": true}), http.StatusOK)
	rotated := e.expect(e.as(staff, http.MethodPost, "/signage/web-embeds/"+id+"/rotate-key",
		map[string]any{"expectedVersion": e.embed(staff, id)["version"]}), http.StatusOK)
	if framePolicy(key) != "'none'" {
		t.Fatal("the old key still has a frame policy")
	}
	e.expectCode(e.publicGet(base+"/manifest"), http.StatusNotFound, "not_found")
	e.expect(e.publicGet("/public/signage/embeds/"+rotated["embedKey"].(string)+"/manifest"), http.StatusOK)
}

func TestSignageEmbedTimelapsesNeedThePublishedAndTheCurrentSwitch(t *testing.T) {
	e := newSignageEnv(t)
	ctx := testContext(t)
	staff := e.allStaff()
	printer := e.printer("Embed timelapse printer")
	store := files.NewService(e.pool, e.fixture.store)
	clip := func(endedAgo string, fill byte) (uuid.UUID, string) {
		t.Helper()
		run := ids.New()
		if _, err := e.pool.Exec(ctx,
			`INSERT INTO machine_runs (id, display_id, source, assignment_id, machine_id, state, first_observed_at, last_observed_at,
				started_at, ended_at, hidden_from_signage)
			 SELECT $1, 'R-2031-' || lpad((('x' || substr(replace($1::uuid::text, '-', ''), 17, 7))::bit(28)::int)::text, 9, '0'),
				'recorded', a.id, $2, 'finished', now() - $3::interval - interval '1 hour', now() - $3::interval,
				now() - $3::interval - interval '1 hour', now() - $3::interval, false
			 FROM printer_connector_assignments a WHERE a.machine_id = $2 AND a.ended_at IS NULL`,
			run, printer.machineID, endedAgo); err != nil {
			t.Fatal(err)
		}
		data := append([]byte("\x00\x00\x00\x18ftypisom"), bytes.Repeat([]byte{fill}, 2000)...)
		file, err := store.StoreSystemBytes(ctx, "clip.mp4", "video/mp4", data, nil)
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(data)
		if _, err := e.pool.Exec(ctx,
			`INSERT INTO machine_run_timelapses (run_id, file_id, size_bytes, sha256) VALUES ($1, $2, $3, $4)`,
			run, file.ID, len(data), sum[:]); err != nil {
			t.Fatal(err)
		}
		return run, hex.EncodeToString(sum[:])
	}
	newest, newestSum := clip("1 hour", 1)
	clip("2 days", 2)
	clip("30 days", 3) // older than the embed's default 14 days

	input := sceneInput("Embed timelapses", "full")
	input.Zones = map[string]json.RawMessage{"main": timelapseWidget("all", nil, 10, 0)}
	scene, err := e.fixture.service.CreateScene(ctx, e.fixture.admin, input, nil)
	if err != nil {
		t.Fatal(err)
	}
	embed := e.createEmbed(staff, "Website", sceneList(scene.ID))
	id, base := embed["id"].(string), "/public/signage/embeds/"+embed["embedKey"].(string)
	publish := func() {
		e.expect(e.as(staff, http.MethodPost, "/signage/web-embeds/"+id+"/publish", nil), http.StatusOK)
	}
	clips := func() []any {
		t.Helper()
		live := e.expect(e.publicGet(base+"/live"), http.StatusOK)
		listed, ok := live["timelapses"].([]any)
		if !ok {
			t.Fatalf("timelapses = %v", live["timelapses"])
		}
		return listed
	}
	clipPath := base + "/timelapses/" + newest.String() + "/" + newestSum

	publish()
	if got := clips(); len(got) != 0 {
		t.Fatalf("clips while switched off = %v", got)
	}
	// Switched on but not yet published: still nothing.
	e.expect(e.patchEmbed(staff, id, map[string]any{"timelapseEnabled": true}), http.StatusOK)
	if got := clips(); len(got) != 0 {
		t.Fatalf("clips before publishing the switch = %v", got)
	}
	e.expectCode(e.publicGet(clipPath), http.StatusNotFound, "not_found")
	publish()
	got := clips()
	if len(got) != 2 || got[0].(map[string]any)["url"] != "/api/v1"+clipPath {
		t.Fatalf("clips after publishing = %v", got)
	}
	video := e.publicGet(clipPath)
	if video.StatusCode != http.StatusOK {
		t.Fatalf("clip download = %d", video.StatusCode)
	}
	video.Body.Close()
	// The embed's count caps the widget's.
	e.expect(e.patchEmbed(staff, id, map[string]any{"timelapseCount": 1}), http.StatusOK)
	if got := clips(); len(got) != 1 {
		t.Fatalf("clips with count 1 = %v", got)
	}
	// Switching off takes effect at once.
	e.expect(e.patchEmbed(staff, id, map[string]any{"timelapseEnabled": false}), http.StatusOK)
	if got := clips(); len(got) != 0 {
		t.Fatalf("clips after switching off = %v", got)
	}
	e.expectCode(e.publicGet(clipPath), http.StatusNotFound, "not_found")
}

func TestSignageEmbedCameraNeedsThePublishedAndTheCurrentSwitch(t *testing.T) {
	r := newRelayEnv(t)
	embed := r.expect(r.as(r.staff, http.MethodPost, "/signage/web-embeds", map[string]any{
		"name": "Website", "aspectRatio": map[string]any{"width": 16, "height": 9},
		"allowedOrigins": []string{"https://www.example.org"}, "defaultScenes": r.defaultScenes,
	}), http.StatusCreated)
	id, key := embed["id"].(string), embed["embedKey"].(string)
	base := "/public/signage/embeds/" + key
	streamPath := base + "/cameras/" + r.machine.String() + "/stream"
	publish := func() {
		r.expect(r.as(r.staff, http.MethodPost, "/signage/web-embeds/"+id+"/publish", nil), http.StatusOK)
	}
	streams := func() []any {
		return r.expect(r.publicGet(base+"/live"), http.StatusOK)["streams"].([]any)
	}
	sameOrigin := http.Header{"Origin": {r.origin}}
	refused := func(header http.Header, status int, code string) {
		t.Helper()
		if _, got, gotCode := r.dial(streamPath, header); got != status || gotCode != code {
			t.Fatalf("embed viewer = %d %s, want %d %s", got, gotCode, status, code)
		}
	}

	publish()
	if got := streams(); len(got) != 0 {
		t.Fatalf("streams while the camera is off = %v", got)
	}
	refused(sameOrigin, http.StatusForbidden, "camera_forbidden")
	// Switched on but not yet published: still forbidden.
	r.expect(r.patchEmbed(r.staff, id, map[string]any{
		"cameraEnabled": true, "cameraMachineIds": []string{r.machine.String()}, "cameraViewerLimit": 1,
	}), http.StatusOK)
	if got := streams(); len(got) != 0 {
		t.Fatalf("streams before publishing the switch = %v", got)
	}
	refused(sameOrigin, http.StatusForbidden, "camera_forbidden")
	publish()
	got := streams()
	if len(got) != 1 || got[0].(map[string]any)["path"] != "/api/v1"+streamPath {
		t.Fatalf("streams after publishing = %v", got)
	}

	// The upgrade needs the application's own origin.
	refused(http.Header{}, http.StatusForbidden, "origin_invalid")
	refused(http.Header{"Origin": {"https://www.example.org"}}, http.StatusForbidden, "origin_invalid")
	refused(sameOrigin, http.StatusConflict, "camera_offline")
	if _, status, code := r.dial("/public/signage/embeds/"+strings.Repeat("A", 32)+"/cameras/"+r.machine.String()+"/stream",
		sameOrigin); status != http.StatusNotFound || code != "not_found" {
		t.Fatalf("unknown embed viewer = %d %s", status, code)
	}

	r.startConnector(r.connectorToken)
	viewer, status, code := r.dial(streamPath, sameOrigin)
	if status != http.StatusSwitchingProtocols {
		t.Fatalf("embed viewer upgrade = %d %s", status, code)
	}
	expectStreaming(t, viewer)
	// The viewer limit of 1 is reached.
	refused(sameOrigin, http.StatusConflict, "camera_busy")
	// Switching the camera off ends the running stream at the next re-check.
	r.expect(r.patchEmbed(r.staff, id, map[string]any{"cameraEnabled": false}), http.StatusOK)
	expectViewerClosed(t, viewer, 4403)
	if got := streams(); len(got) != 0 {
		t.Fatalf("streams after switching off = %v", got)
	}
}
