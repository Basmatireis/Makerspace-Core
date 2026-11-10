package integration_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
)

func timelapseWidget(source string, machines []uuid.UUID, count, maxAgeDays int) json.RawMessage {
	encoded, _ := json.Marshal(machines)
	if machines == nil {
		encoded = []byte("[]")
	}
	return json.RawMessage(fmt.Sprintf(
		`{"type":"timelapse","source":%q,"machineIds":%s,"count":%d,"maxAgeDays":%d,"maxSeconds":30,"transition":"fade","showCaption":true,"fit":"cover"}`,
		source, encoded, count, maxAgeDays,
	))
}

type seededTimelapse struct {
	run    uuid.UUID
	sha256 string
	data   []byte
}

// Finished recorded runs with a stored timelapse show on displays whose publication has a timelapse widget:
// newest first, never hidden, failed or too old runs, and the player may fetch only what its selection lists.
func TestSignageTimelapseWidgetLiveAndContent(t *testing.T) {
	g := newConnectorEnv(t)
	ctx := testContext(t)
	staff := g.allStaff()
	svc, admin := g.fixture.service, g.fixture.admin
	first := g.bambu("Timelapse A", "bambu_h2d", "192.168.1.91", "30000001")
	second := g.bambu("Timelapse B", "bambu_h2d", "192.168.1.92", "30000002")
	store := files.NewService(g.pool, g.fixture.store)

	insertRun := func(machine uuid.UUID, state, endedAgo string, hidden bool) uuid.UUID {
		t.Helper()
		id := ids.New()
		if _, err := g.pool.Exec(
			ctx,
			`INSERT INTO machine_runs (id, display_id, source, assignment_id, machine_id, state, first_observed_at, last_observed_at,
				started_at, ended_at, hidden_from_signage)
			 SELECT $1, 'R-2031-' || lpad((('x' || substr(replace($1::uuid::text, '-', ''), 17, 7))::bit(28)::int)::text, 9, '0'),
				'recorded', a.id, $2, $3, now() - $4::interval - interval '1 hour', now() - $4::interval,
				now() - $4::interval - interval '1 hour', now() - $4::interval, $5
			 FROM printer_connector_assignments a WHERE a.machine_id = $2 AND a.ended_at IS NULL`,
			id, machine, state, endedAgo, hidden,
		); err != nil {
			t.Fatal(err)
		}
		return id
	}
	withTimelapse := func(run uuid.UUID, fill byte) seededTimelapse {
		t.Helper()
		data := append([]byte("\x00\x00\x00\x18ftypisom"), bytes.Repeat([]byte{fill}, 4000)...)
		file, err := store.StoreSystemBytes(ctx, "clip.mp4", "video/mp4", data, nil)
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(data)
		if _, err = g.pool.Exec(
			ctx,
			`INSERT INTO machine_run_timelapses (run_id, file_id, size_bytes, sha256) VALUES ($1, $2, $3, $4)`,
			run, file.ID, len(data), sum[:],
		); err != nil {
			t.Fatal(err)
		}
		return seededTimelapse{run: run, sha256: hex.EncodeToString(sum[:]), data: data}
	}
	newestB := withTimelapse(insertRun(second, "finished", "30 minutes", false), 'b')
	newestA := withTimelapse(insertRun(first, "finished", "1 hour", false), 'a')
	olderA := withTimelapse(insertRun(first, "finished", "2 days", false), 'c')
	oldestA := withTimelapse(insertRun(first, "finished", "3 days", false), 'd')
	hidden := withTimelapse(insertRun(first, "finished", "10 minutes", true), 'h')
	failed := withTimelapse(insertRun(first, "failed", "5 minutes", false), 'f')
	tooOld := withTimelapse(insertRun(second, "finished", "40 days", false), 'o')
	withoutClip := insertRun(second, "finished", "20 minutes", false)

	publish := func(name string, zones map[string]json.RawMessage, layout string) (string, *http.Client) {
		t.Helper()
		input := sceneInput(name, layout)
		input.Zones = zones
		scene, err := svc.CreateScene(ctx, admin, input, nil)
		if err != nil {
			t.Fatal(err)
		}
		shown, player := g.pair(staff, name+" display", sceneList(scene.ID))
		id := shown["id"].(string)
		g.expect(g.as(staff, http.MethodPost, "/signage/displays/"+id+"/publish", nil), http.StatusOK)
		return id, player
	}
	listed := func(live map[string]any) []string {
		t.Helper()
		raw, ok := live["timelapses"]
		if !ok {
			t.Fatalf("live lacks the timelapses key: %v", live)
		}
		if raw == nil {
			return nil
		}
		runs := []string{}
		for _, item := range raw.([]any) {
			clip := item.(map[string]any)
			runs = append(runs, clip["runId"].(string))
		}
		return runs
	}
	runIDs := func(clips ...seededTimelapse) []string {
		result := []string{}
		for _, clip := range clips {
			result = append(result, clip.run.String())
		}
		return result
	}
	expectRuns := func(label string, got []string, want ...seededTimelapse) {
		t.Helper()
		if strings.Join(got, ",") != strings.Join(runIDs(want...), ",") {
			t.Fatalf("%s: runs = %v, want %v", label, got, runIDs(want...))
		}
	}
	live := func(player *http.Client) map[string]any {
		t.Helper()
		return g.expect(g.do(player, "", http.MethodGet, "/signage/player/live", nil), http.StatusOK)
	}
	clipPath := func(clip seededTimelapse) string {
		return "/signage/player/timelapses/" + clip.run.String() + "/" + clip.sha256
	}

	// A widget for both machines, two newest clips within 30 days.
	machinesDisplay, machinesPlayer := publish("Machine clips", map[string]json.RawMessage{
		"main": timelapseWidget("machines", []uuid.UUID{first, second}, 2, 30),
	}, "full")
	current := live(machinesPlayer)
	expectRuns("machines widget", listed(current), newestB, newestA)
	clip := current["timelapses"].([]any)[0].(map[string]any)
	if clip["machineId"] != second.String() || clip["machineName"] != "Timelapse B" || clip["sha256"] != newestB.sha256 ||
		clip["sizeBytes"] != float64(len(newestB.data)) || clip["url"] != "/api/v1"+clipPath(newestB) || clip["endedAt"] == nil {
		t.Fatalf("clip = %v", clip)
	}
	if len(clip) != 7 {
		t.Fatalf("clip carries more than the documented fields: %v", clip)
	}
	// The timelapse machines do not join the live machine list.
	if machines := current["machines"].([]any); len(machines) != 0 {
		t.Fatalf("timelapse machines listed as live machines: %v", machines)
	}

	// The player fetches listed clips, whole and by range, and nothing else.
	response, body := g.rawGet(machinesPlayer, clipPath(newestB))
	if response.StatusCode != http.StatusOK || !bytes.Equal(body, newestB.data) ||
		response.Header.Get("Content-Type") != "video/mp4" ||
		response.Header.Get("Cache-Control") != "private, max-age=31536000, immutable" ||
		response.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("clip response status=%d headers=%v", response.StatusCode, response.Header)
	}
	response, body = g.rawGet(machinesPlayer, clipPath(newestA), "Range", "bytes=10-19")
	if response.StatusCode != http.StatusPartialContent || !bytes.Equal(body, newestA.data[10:20]) ||
		response.Header.Get("Content-Range") != fmt.Sprintf("bytes 10-19/%d", len(newestA.data)) {
		t.Fatalf("range response status=%d headers=%v", response.StatusCode, response.Header)
	}
	wrongSum := seededTimelapse{run: newestB.run, sha256: strings.Repeat("0", 64)}
	for label, notListed := range map[string]seededTimelapse{
		"hidden": hidden, "failed": failed, "too old": tooOld, "beyond count": olderA, "wrong sha": wrongSum,
	} {
		response, _ := g.rawGet(machinesPlayer, clipPath(notListed))
		if response.StatusCode != http.StatusNotFound {
			t.Fatalf("%s clip: status %d, want 404", label, response.StatusCode)
		}
	}

	// Every machine within 30 days, merged with a second widget of any age for one machine.
	_, allPlayer := publish("All clips", map[string]json.RawMessage{"main": timelapseWidget("all", nil, 20, 30)}, "full")
	expectRuns("all source", listed(live(allPlayer)), newestB, newestA, olderA, oldestA)
	_, mergedPlayer := publish("Merged clips", map[string]json.RawMessage{
		"left":  timelapseWidget("all", nil, 20, 30),
		"right": timelapseWidget("machines", []uuid.UUID{second}, 5, 0),
	}, "split")
	expectRuns("merged widgets", listed(live(mergedPlayer)), newestB, newestA, olderA, oldestA, tooOld)
	response, body = g.rawGet(mergedPlayer, clipPath(tooOld))
	if response.StatusCode != http.StatusOK || !bytes.Equal(body, tooOld.data) {
		t.Fatalf("merged display old clip status=%d", response.StatusCode)
	}

	// A display without a timelapse widget gets null and no clips.
	_, clockPlayer := publish("Clock only", map[string]json.RawMessage{
		"main": json.RawMessage(`{"type":"clock","mode":"time"}`),
	}, "full")
	if runs := listed(live(clockPlayer)); runs != nil {
		t.Fatalf("display without timelapse widget lists %v", runs)
	}
	if response, _ := g.rawGet(clockPlayer, clipPath(newestB)); response.StatusCode != http.StatusNotFound {
		t.Fatalf("display without timelapse widget fetched a clip: %d", response.StatusCode)
	}

	// The admin preview carries the same block.
	preview := g.expect(g.as(staff, http.MethodGet, "/signage/displays/"+machinesDisplay+"/preview", nil), http.StatusOK)
	expectRuns("preview", listed(preview["live"].(map[string]any)), newestB, newestA)

	// Staff load the clips for previews with signage.read.
	reader := g.staff("timelapse-reader", authorization.SignageRead)
	content := func(run uuid.UUID) string { return "/signage/timelapses/" + run.String() + "/content" }
	response, body = g.rawGet(reader.client, content(newestA.run)+"?v="+newestA.sha256)
	if response.StatusCode != http.StatusOK || !bytes.Equal(body, newestA.data) ||
		response.Header.Get("Content-Type") != "video/mp4" ||
		response.Header.Get("Cache-Control") != "private, max-age=31536000, immutable" {
		t.Fatalf("staff clip status=%d headers=%v", response.StatusCode, response.Header)
	}
	response, _ = g.rawGet(reader.client, content(tooOld.run))
	if response.StatusCode != http.StatusOK || response.Header.Get("Cache-Control") != "private, no-store" {
		t.Fatalf("staff clip without v status=%d headers=%v", response.StatusCode, response.Header)
	}
	response, body = g.rawGet(reader.client, content(olderA.run), "Range", "bytes=0-9")
	if response.StatusCode != http.StatusPartialContent || !bytes.Equal(body, olderA.data[:10]) {
		t.Fatalf("staff range status=%d", response.StatusCode)
	}
	// Hidden, failed, clip-less and unknown runs.
	for _, run := range []uuid.UUID{hidden.run, failed.run, withoutClip, ids.New()} {
		g.expectCode(g.as(reader, http.MethodGet, content(run), nil), http.StatusNotFound, "not_found")
	}
	nobody := g.staff("timelapse-nobody", authorization.SignageManage)
	g.expectCode(g.as(nobody, http.MethodGet, content(newestA.run), nil), http.StatusForbidden, "permission_denied")
	// The player credential never reaches the staff endpoint, nor staff the player endpoint.
	if response, _ := g.rawGet(machinesPlayer, content(newestA.run)); response.StatusCode == http.StatusOK {
		t.Fatal("player fetched the staff endpoint")
	}
	if response, _ := g.rawGet(reader.client, clipPath(newestA)); response.StatusCode == http.StatusOK {
		t.Fatal("staff fetched the player endpoint")
	}

	// Timelapses are camera recordings: a display visible from outside lists and serves none without
	// allowCameraOutside, in the live data, the preview and the clip endpoint alike.
	setOutside := func(visible, allowCamera bool) {
		t.Helper()
		shown := g.expect(g.as(staff, http.MethodGet, "/signage/displays/"+machinesDisplay, nil), http.StatusOK)
		g.expect(g.as(staff, http.MethodPut, "/signage/displays/"+machinesDisplay, map[string]any{
			"expectedVersion": shown["version"], "name": shown["name"], "location": shown["location"],
			"aspectRatio": shown["aspectRatio"], "visibleFromOutside": visible, "allowCameraOutside": allowCamera,
			"defaultScenes": shown["defaultScenes"], "groupId": shown["groupId"],
		}), http.StatusOK)
	}
	setOutside(true, false)
	if runs := listed(live(machinesPlayer)); runs == nil || len(runs) != 0 {
		t.Fatalf("outside display without allowCameraOutside lists %v, want an empty list", runs)
	}
	preview = g.expect(g.as(staff, http.MethodGet, "/signage/displays/"+machinesDisplay+"/preview", nil), http.StatusOK)
	if runs := listed(preview["live"].(map[string]any)); runs == nil || len(runs) != 0 {
		t.Fatalf("outside display preview lists %v, want an empty list", runs)
	}
	for _, clip := range []seededTimelapse{newestB, newestA} {
		if response, _ := g.rawGet(machinesPlayer, clipPath(clip)); response.StatusCode != http.StatusNotFound {
			t.Fatalf("outside display without allowCameraOutside fetched a clip: %d", response.StatusCode)
		}
	}
	setOutside(true, true)
	expectRuns("outside with allowCameraOutside", listed(live(machinesPlayer)), newestB, newestA)
	preview = g.expect(g.as(staff, http.MethodGet, "/signage/displays/"+machinesDisplay+"/preview", nil), http.StatusOK)
	expectRuns("outside preview with allowCameraOutside", listed(preview["live"].(map[string]any)), newestB, newestA)
	if response, _ := g.rawGet(machinesPlayer, clipPath(newestA)); response.StatusCode != http.StatusOK {
		t.Fatalf("outside display with allowCameraOutside: clip status %d", response.StatusCode)
	}
	setOutside(false, false)

	// Hiding a finished run later removes its clip from the selection, the endpoint and the staff endpoint.
	if _, err := g.pool.Exec(ctx, `UPDATE machine_runs SET hidden_from_signage = true WHERE id = $1`, newestB.run); err != nil {
		t.Fatal(err)
	}
	expectRuns("after hiding", listed(live(machinesPlayer)), newestA, olderA)
	if response, _ := g.rawGet(machinesPlayer, clipPath(newestB)); response.StatusCode != http.StatusNotFound {
		t.Fatalf("hidden clip still served: %d", response.StatusCode)
	}
	g.expectCode(g.as(reader, http.MethodGet, content(newestB.run), nil), http.StatusNotFound, "not_found")
	// A deleted run disappears the same way.
	if _, err := g.pool.Exec(ctx, `UPDATE machine_runs SET deleted_at = now() WHERE id = $1`, newestA.run); err != nil {
		t.Fatal(err)
	}
	expectRuns("after deleting", listed(live(machinesPlayer)), olderA, oldestA)
}
