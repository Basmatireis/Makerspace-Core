package integration_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/signage"
)

// hideBlock marks a block built by sceneBlock as hidden.
func hideBlock(block json.RawMessage) json.RawMessage {
	return json.RawMessage(strings.Replace(string(block), `"hidden":false`, `"hidden":true`, 1))
}

// withBackground gives a block (built by sceneBlock) the image as its style background.
func withBackground(block json.RawMessage, assetID string) json.RawMessage {
	return json.RawMessage(strings.Replace(string(block), `"backgroundAssetId":null`, `"backgroundAssetId":"`+assetID+`"`, 1))
}

const plainTextWidget = `{"type":"text","text":"hello","format":"plain"}`

func manifestAssetIDs(manifest map[string]any) map[string]bool {
	found := map[string]bool{}
	for _, raw := range manifest["assets"].([]any) {
		found[raw.(map[string]any)["id"].(string)] = true
	}
	return found
}

// Hidden blocks never reach a display: their blocks and assets are left out of the manifest, the player asset
// endpoint refuses their assets and a hidden camera yields no stream.
func TestSignageHiddenBlocksDoNotReachPlayers(t *testing.T) {
	e := newSignageEnv(t)
	staff := e.allStaff()
	hiddenOnly := e.fixture.uploadImage(t, "hidden-only.jpg")
	shown := e.fixture.uploadImage(t, "shown.jpg")
	imageWidget := func(id string) json.RawMessage {
		return json.RawMessage(`{"type":"image","mediaId":"` + id + `","fit":"cover","dim":0}`)
	}
	input := sceneInput("Hidden media")
	input.Blocks = sceneBlocks(
		sceneBlock("visible", json.RawMessage(plainTextWidget)),
		withBackground(sceneBlock("styled", json.RawMessage(plainTextWidget)), shown.ID.String()),
		hideBlock(sceneBlock("hidden", imageWidget(hiddenOnly.ID.String()))),
	)
	scene, err := e.fixture.service.CreateScene(testContext(t), e.fixture.admin, input, nil)
	if err != nil {
		t.Fatal(err)
	}
	display, player := e.pair(staff, "Hidden display", sceneList(scene.ID))
	displayID := display["id"].(string)
	e.expect(e.as(staff, http.MethodPost, "/signage/displays/"+displayID+"/publish", nil), http.StatusOK)

	manifest := e.expect(e.do(player, "", http.MethodGet, "/signage/player/manifest", nil), http.StatusOK)["manifest"].(map[string]any)
	assets := manifestAssetIDs(manifest)
	if assets[hiddenOnly.ID.String()] {
		t.Fatalf("manifest lists the asset of a hidden block: %v", manifest["assets"])
	}
	if !assets[shown.ID.String()] {
		t.Fatalf("manifest misses the visible block background: %v", manifest["assets"])
	}
	blocks := manifest["scenes"].([]any)[0].(map[string]any)["blocks"].([]any)
	if len(blocks) != 2 {
		t.Fatalf("published blocks = %v, want the two visible ones", blocks)
	}
	for _, raw := range blocks {
		if raw.(map[string]any)["hidden"] == true {
			t.Fatalf("a hidden block was published: %v", raw)
		}
	}
	path := func(id string, sha string) string { return "/signage/player/assets/" + id + "/" + sha }
	served := func(a signage.Asset) int {
		response, _ := e.rawGet(player, path(a.ID.String(), a.SHA256))
		return response.StatusCode
	}
	if got := served(shown); got != http.StatusOK {
		t.Fatalf("visible block background asset = %d", got)
	}
	if got := served(hiddenOnly); got != http.StatusNotFound {
		t.Fatalf("hidden block asset = %d, want 404", got)
	}

	// Hiding or showing a block is a change the display has not published yet.
	update := input
	update.Blocks = sceneBlocks(
		sceneBlock("visible", json.RawMessage(plainTextWidget)),
		withBackground(sceneBlock("styled", json.RawMessage(plainTextWidget)), shown.ID.String()),
		sceneBlock("hidden", imageWidget(hiddenOnly.ID.String())),
	)
	if _, err := e.fixture.service.UpdateScene(testContext(t), e.fixture.admin, scene.ID, scene.Version, update, nil); err != nil {
		t.Fatal(err)
	}
	pending := e.expect(e.as(staff, http.MethodGet, "/signage/displays/"+displayID, nil), http.StatusOK)["pendingChanges"].([]any)
	if len(pending) == 0 {
		t.Fatal("showing a hidden block is not a pending change")
	}
	e.expect(e.as(staff, http.MethodPost, "/signage/displays/"+displayID+"/publish", nil), http.StatusOK)
	if got := served(hiddenOnly); got != http.StatusOK {
		t.Fatalf("asset of the shown block = %d, want 200", got)
	}
}

// Assets used by a block style background or only by a hidden block are references: deleting them fails.
func TestSignageAssetDeleteSeesStyleBackgroundsAndHiddenBlocks(t *testing.T) {
	f := newSignageFixture(t)
	ctx := testContext(t)
	styled := f.uploadImage(t, "styled.jpg")
	hidden := f.uploadImage(t, "hidden.jpg")
	input := sceneInput("References")
	input.Blocks = sceneBlocks(
		withBackground(sceneBlock("styled", json.RawMessage(plainTextWidget)), styled.ID.String()),
		hideBlock(sceneBlock("hidden", json.RawMessage(`{"type":"image","mediaId":"`+hidden.ID.String()+`","fit":"cover","dim":0}`))),
	)
	if _, err := f.service.CreateScene(ctx, f.admin, input, nil); err != nil {
		t.Fatal(err)
	}
	expectInUse(t, f.service.DeleteAsset(ctx, f.admin, styled.ID, nil), "scene")
	expectInUse(t, f.service.DeleteAsset(ctx, f.admin, hidden.ID, nil), "scene")
}

// A camera block that is hidden offers no stream; showing it again does.
func TestSignageHiddenCameraBlockHasNoLiveStream(t *testing.T) {
	r := newRelayEnv(t)
	if streams := r.liveStreams(); len(streams) != 1 {
		t.Fatalf("visible camera streams = %v", streams)
	}
	set := func(hidden bool) {
		t.Helper()
		block := sceneBlock("main", cameraWidget(r.machine))
		if hidden {
			block = hideBlock(block)
		}
		input := sceneInput("Relay camera")
		input.Blocks = sceneBlocks(block)
		if _, err := r.fixture.service.UpdateScene(testContext(t), r.fixture.admin, r.scene.ID, r.sceneVersion, input, nil); err != nil {
			t.Fatal(err)
		}
		r.sceneVersion++
		r.publish()
	}
	set(true)
	if streams := r.liveStreams(); len(streams) != 0 {
		t.Fatalf("hidden camera block still streams: %v", streams)
	}
	set(false)
	if streams := r.liveStreams(); len(streams) != 1 {
		t.Fatalf("shown camera block streams = %v", streams)
	}
}
