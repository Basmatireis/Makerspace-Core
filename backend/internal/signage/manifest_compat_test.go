package signage

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// A publication made before custom layouts has no customLayouts and no customLayoutId. It must still
// decode into blocks, and diffing it against itself must not report changes or crash.
func TestOldPublicationStillDecodesAndDiffs(t *testing.T) {
	const old = `{"revision":3,"display":{"orientation":"landscape","resolution":{"width":1920,"height":1080},"visibleFromOutside":false},
		"defaultPlaylistId":"01a163eb-b404-77e3-a447-7ad9b8535d7a","rules":[],"playlists":[],"assets":[],"layoutsVersion":1,
		"scenes":[{"id":"01a163eb-b3fd-74c6-9fa2-4aeb568c12f3","name":"A","orientation":"landscape","layoutId":"full",
		"backgroundColor":"#101820","backgroundAssetId":null,"backgroundFit":"cover","backgroundDim":0,"theme":"dark",
		"zones":{"main":{"type":"events","count":3}},"version":1}]}`
	published, err := upgradeManifest([]byte(old))
	if err != nil {
		t.Fatal(err)
	}
	blocks := published.Scenes[0].Blocks
	if published.ManifestVersion != ManifestVersion || len(blocks) != 1 || blocks[0].ID != "main" ||
		blocks[0].W != 1920 || blocks[0].H != 1080 || string(blocks[0].Widget) != `{"count":3,"type":"events"}` {
		t.Fatalf("old manifest = %#v", published)
	}
	if _, err := sceneAssetIDs(published.Scenes[0]); err != nil {
		t.Fatalf("old scene no longer validates: %v", err)
	}
	draft := published
	if changes := diffManifests(published, draft); len(changes) != 0 {
		t.Fatalf("an unchanged draft reports changes: %v", changes)
	}
}

// A publication made before aspect ratios carries orientation and resolution; it decodes with the ratios
// that the migration gave its display and scenes, so an unchanged draft reports no pending change.
func TestPublicationWithOrientationGetsAspectRatios(t *testing.T) {
	cases := []struct {
		name, display, scene string
		wantDisplay          AspectRatio
		wantScene            AspectRatio
	}{
		{
			name:        "reduced resolution",
			display:     `{"orientation":"landscape","resolution":{"width":1920,"height":1080},"visibleFromOutside":true}`,
			scene:       "landscape",
			wantDisplay: AspectRatio{16, 9}, wantScene: AspectRatio{16, 9},
		},
		{
			name:        "portrait",
			display:     `{"orientation":"portrait","resolution":{"width":1080,"height":1920},"visibleFromOutside":false}`,
			scene:       "portrait",
			wantDisplay: AspectRatio{9, 16}, wantScene: AspectRatio{9, 16},
		},
		{
			name:        "irreducible resolution falls back by orientation",
			display:     `{"orientation":"landscape","resolution":{"width":1366,"height":768},"visibleFromOutside":false}`,
			scene:       "portrait",
			wantDisplay: AspectRatio{16, 9}, wantScene: AspectRatio{9, 16},
		},
	}
	for _, c := range cases {
		raw := `{"revision":1,"display":` + c.display + `,"defaultPlaylistId":"01a163eb-b404-77e3-a447-7ad9b8535d7a",
			"rules":[],"playlists":[],"assets":[],"layoutsVersion":2,"customLayouts":[],
			"scenes":[{"id":"01a163eb-b3fd-74c6-9fa2-4aeb568c12f3","name":"A","orientation":"` + c.scene + `","layoutId":"full",
			"customLayoutId":null,"backgroundColor":"#101820","backgroundAssetId":null,"backgroundFit":"cover","backgroundDim":0,
			"theme":"dark","zones":{"main":{"type":"empty"}},"version":1}]}`
		manifest, err := upgradeManifest([]byte(raw))
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if manifest.Display.AspectRatio != c.wantDisplay || manifest.Scenes[0].AspectRatio != c.wantScene {
			t.Fatalf("%s: display %s scene %s, want %s and %s", c.name, manifest.Display.AspectRatio,
				manifest.Scenes[0].AspectRatio, c.wantDisplay, c.wantScene)
		}
	}
	current := `{"revision":1,"display":{"aspectRatio":{"width":21,"height":9},"visibleFromOutside":false},
		"defaultPlaylistId":"01a163eb-b404-77e3-a447-7ad9b8535d7a","rules":[],"playlists":[],"assets":[],"layoutsVersion":2,
		"customLayouts":[],"scenes":[]}`
	manifest, err := upgradeManifest([]byte(current))
	if err != nil || manifest.Display.AspectRatio != (AspectRatio{21, 9}) {
		t.Fatalf("current manifest = %#v, %v", manifest.Display, err)
	}
}

// A publication stored before manifest version 3 refers to playlists. It is upgraded in memory: rule targets
// become scene lists (a playlist's items, a scene as one ten-second item), a rule with an empty playlist is
// dropped, and an empty default playlist falls back to the first scene with the display's ratio.
func TestUpgradeManifestTurnsPlaylistsIntoSceneLists(t *testing.T) {
	const old = `{"revision":4,"display":{"aspectRatio":{"width":16,"height":9},"visibleFromOutside":false},
		"defaultPlaylistId":"01a163eb-b404-77e3-a447-7ad9b8535d00","layoutsVersion":2,"customLayouts":[],"assets":[],
		"playlists":[
			{"id":"01a163eb-b404-77e3-a447-7ad9b8535d00","name":"Empty","items":[],"version":1},
			{"id":"01a163eb-b404-77e3-a447-7ad9b8535d01","name":"Two","version":2,"items":[
				{"sceneId":"01a163eb-b3fd-74c6-9fa2-4aeb568c12b0","seconds":15,"transition":"fade"},
				{"sceneId":"01a163eb-b3fd-74c6-9fa2-4aeb568c12a0","seconds":20,"transition":"cut"}]}],
		"rules":[
			{"id":"01a163eb-b500-7000-8000-000000000001","kind":"live_data_unavailable","weekdays":[],"timeFrom":null,"timeTo":null,
			 "machineIds":[],"machineMatch":null,"announcementTemplateIds":[],"targetKind":"playlist",
			 "targetId":"01a163eb-b404-77e3-a447-7ad9b8535d01","minSeconds":20,"multiMode":"split","alternateSeconds":10},
			{"id":"01a163eb-b500-7000-8000-000000000002","kind":"announcement_active","weekdays":[],"timeFrom":null,"timeTo":null,
			 "machineIds":[],"machineMatch":null,"announcementTemplateIds":[],"targetKind":"playlist",
			 "targetId":"01a163eb-b404-77e3-a447-7ad9b8535d00","minSeconds":20,"multiMode":"split","alternateSeconds":10},
			{"id":"01a163eb-b500-7000-8000-000000000003","kind":"announcement_active","weekdays":[],"timeFrom":null,"timeTo":null,
			 "machineIds":[],"machineMatch":null,"announcementTemplateIds":[],"targetKind":"scene",
			 "targetId":"01a163eb-b3fd-74c6-9fa2-4aeb568c12a0","minSeconds":0,"multiMode":"alternate","alternateSeconds":5}],
		"scenes":[
			{"id":"01a163eb-b3fd-74c6-9fa2-4aeb568c12a0","name":"Landscape","aspectRatio":{"width":16,"height":9},"layoutId":"full",
			 "customLayoutId":null,"backgroundColor":"#101820","backgroundAssetId":null,"backgroundFit":"cover","backgroundDim":0,
			 "theme":"dark","zones":{"main":{"type":"empty"}},"version":1},
			{"id":"01a163eb-b3fd-74c6-9fa2-4aeb568c12b0","name":"Portrait","aspectRatio":{"width":9,"height":16},"layoutId":"full",
			 "customLayoutId":null,"backgroundColor":"#101820","backgroundAssetId":null,"backgroundFit":"cover","backgroundDim":0,
			 "theme":"dark","zones":{"main":{"type":"empty"}},"version":1}]}`
	manifest, err := upgradeManifest([]byte(old))
	if err != nil {
		t.Fatal(err)
	}
	landscape := uuid.MustParse("01a163eb-b3fd-74c6-9fa2-4aeb568c12a0")
	portrait := uuid.MustParse("01a163eb-b3fd-74c6-9fa2-4aeb568c12b0")
	if manifest.ManifestVersion != ManifestVersion || manifest.Revision != 4 {
		t.Fatalf("version %d revision %d", manifest.ManifestVersion, manifest.Revision)
	}
	if len(manifest.Rules) != 2 {
		t.Fatalf("rules = %#v, want the empty-playlist rule dropped", manifest.Rules)
	}
	wantPlaylistRule := []SceneListItem{
		{SceneID: portrait, Seconds: 15, Transition: TransitionFade},
		{SceneID: landscape, Seconds: 20, Transition: TransitionCut},
	}
	if manifest.Rules[0].ID.String() != "01a163eb-b500-7000-8000-000000000001" ||
		!sceneListsEqual(manifest.Rules[0].Scenes, wantPlaylistRule) {
		t.Fatalf("playlist rule = %#v", manifest.Rules[0])
	}
	wantSceneRule := []SceneListItem{{SceneID: landscape, Seconds: 10, Transition: TransitionCut}}
	if manifest.Rules[1].ID.String() != "01a163eb-b500-7000-8000-000000000003" ||
		!sceneListsEqual(manifest.Rules[1].Scenes, wantSceneRule) || manifest.Rules[1].MultiMode != MultiModeAlternate {
		t.Fatalf("scene rule = %#v", manifest.Rules[1])
	}
	if !sceneListsEqual(manifest.DefaultScenes, wantSceneRule) {
		t.Fatalf("default = %#v, want the first scene with the display's ratio", manifest.DefaultScenes)
	}
	if len(manifest.Scenes) != 2 {
		t.Fatalf("scenes = %d, want no synthetic scene", len(manifest.Scenes))
	}
	encoded, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	for _, gone := range []string{`"playlists"`, `"defaultPlaylistId"`, `"targetKind"`, `"targetId"`} {
		if strings.Contains(string(encoded), gone) {
			t.Fatalf("upgraded manifest still carries %s: %s", gone, encoded)
		}
	}
	// Upgrading is idempotent: the current shape passes through unchanged.
	again, err := upgradeManifest(encoded)
	if err != nil {
		t.Fatal(err)
	}
	reencoded, _ := json.Marshal(again)
	if string(reencoded) != string(encoded) {
		t.Fatalf("a current manifest changed on upgrade:\n%s\n%s", encoded, reencoded)
	}
}

// An empty default playlist without any scene of the display's ratio becomes the synthetic Blank scene, which
// the upgraded manifest carries like any other scene.
func TestUpgradeManifestFallsBackToBlankScene(t *testing.T) {
	const old = `{"revision":1,"display":{"orientation":"portrait","resolution":{"width":1080,"height":1920},"visibleFromOutside":true},
		"defaultPlaylistId":"01a163eb-b404-77e3-a447-7ad9b8535d00","rules":[],"assets":[],"layoutsVersion":2,"customLayouts":[],
		"playlists":[{"id":"01a163eb-b404-77e3-a447-7ad9b8535d00","name":"Empty","items":[],"version":1}],
		"scenes":[{"id":"01a163eb-b3fd-74c6-9fa2-4aeb568c12f3","name":"Wide","orientation":"landscape","layoutId":"full",
		"customLayoutId":null,"backgroundColor":"#101820","backgroundAssetId":null,"backgroundFit":"cover","backgroundDim":0,
		"theme":"dark","zones":{"main":{"type":"empty"}},"version":1}]}`
	manifest, err := upgradeManifest([]byte(old))
	if err != nil {
		t.Fatal(err)
	}
	portrait := AspectRatio{Width: 9, Height: 16}
	if manifest.Display.AspectRatio != portrait || len(manifest.Scenes) != 2 {
		t.Fatalf("display %s, %d scenes", manifest.Display.AspectRatio, len(manifest.Scenes))
	}
	blank := manifest.Scenes[1]
	if blank.ID.String() != "00000000-0000-7000-8000-000000000001" || blank.Name != "Blank" || blank.AspectRatio != portrait ||
		blank.BackgroundColor != "#000000" || blank.Theme != ThemeDark || blank.Version != 1 || len(blank.Blocks) != 1 ||
		string(blank.Blocks[0].Widget) != `{"type":"empty"}` || blank.Blocks[0].W != 1080 || blank.Blocks[0].H != 1920 {
		t.Fatalf("blank scene = %#v", blank)
	}
	if _, err := sceneAssetIDs(blank); err != nil {
		t.Fatalf("blank scene does not validate: %v", err)
	}
	want := []SceneListItem{{SceneID: blank.ID, Seconds: 10, Transition: TransitionCut}}
	if !sceneListsEqual(manifest.DefaultScenes, want) || len(manifest.Rules) != 0 {
		t.Fatalf("default = %#v rules = %#v", manifest.DefaultScenes, manifest.Rules)
	}
}

// A version 3 publication carries layouts with zones and the custom layouts it uses. Reading it gives every scene
// the blocks that migration 00129 gave the stored scenes: built-in grids, custom grids and free layouts, and a
// missing custom layout renders as full.
func TestUpgradeVersion3ManifestConvertsLayoutsToBlocks(t *testing.T) {
	const raw = `{"manifestVersion":3,"revision":7,"display":{"aspectRatio":{"width":16,"height":9},"visibleFromOutside":false},
		"rules":[],"defaultScenes":[{"sceneId":"01a163eb-b3fd-74c6-9fa2-4aeb568c1201","seconds":10,"transition":"cut"}],
		"assets":[],"layoutsVersion":2,
		"customLayouts":[
			{"id":"01a163eb-b404-77e3-a447-7ad9b8535e01","name":"Grid","mode":"grid","columns":[1,3],"rows":[2,1],"version":4,
			 "zones":[{"id":"wide","label":"Wide","grid":{"col":1,"row":1,"colSpan":2,"rowSpan":1},"rect":null},
			          {"id":"low","label":"Low","grid":{"col":2,"row":2,"colSpan":1,"rowSpan":1},"rect":null}]},
			{"id":"01a163eb-b404-77e3-a447-7ad9b8535e02","name":"Free","mode":"free","columns":[1],"rows":[1],"version":1,
			 "zones":[{"id":"back","label":"Back","grid":null,"rect":{"x":0,"y":0,"width":100,"height":100}},
			          {"id":"badge","label":"Badge","grid":null,"rect":{"x":12.5,"y":33.33,"width":25,"height":10.01}}]}],
		"scenes":[
			{"id":"01a163eb-b3fd-74c6-9fa2-4aeb568c1201","name":"Split","aspectRatio":{"width":16,"height":9},"layoutId":"split",
			 "customLayoutId":null,"backgroundColor":"#101820","backgroundAssetId":null,"backgroundFit":"cover","backgroundDim":0,
			 "theme":"dark","fontFamily":"sans","fontAssetId":null,"version":3,
			 "zones":{"left":{"type":"text","text":"Hi","size":"l","align":"end"},
			          "right":{"type":"clock","mode":"time","style":{"textColor":"#ffffff","backgroundColor":"#000000","borderColor":null,
			            "backgroundOpacity":50,"padding":3,"radius":1,"borderWidth":5,"fontScale":150,"fontFamily":"serif",
			            "fontAssetId":null,"align":"start","verticalAlign":"end"}}}},
			{"id":"01a163eb-b3fd-74c6-9fa2-4aeb568c1202","name":"Grid","aspectRatio":{"width":9,"height":16},"layoutId":"custom",
			 "customLayoutId":"01a163eb-b404-77e3-a447-7ad9b8535e01","backgroundColor":"#101820","backgroundAssetId":null,
			 "backgroundFit":"cover","backgroundDim":0,"theme":"light","fontFamily":"sans","fontAssetId":null,"version":1,
			 "zones":{"wide":{"type":"image","mediaId":null,"fit":"cover"}}},
			{"id":"01a163eb-b3fd-74c6-9fa2-4aeb568c1203","name":"Free","aspectRatio":{"width":21,"height":9},"layoutId":"custom",
			 "customLayoutId":"01a163eb-b404-77e3-a447-7ad9b8535e02","backgroundColor":"#101820","backgroundAssetId":null,
			 "backgroundFit":"cover","backgroundDim":0,"theme":"dark","fontFamily":"sans","fontAssetId":null,"version":2,
			 "zones":{"badge":{"type":"camera","source":"auto","machineId":null,"multi":"split","showProgress":true,
			   "showRemaining":false,"fallback":"hide","fallbackMediaId":null}}},
			{"id":"01a163eb-b3fd-74c6-9fa2-4aeb568c1204","name":"Lost","aspectRatio":{"width":16,"height":9},"layoutId":"custom",
			 "customLayoutId":"01a163eb-b404-77e3-a447-7ad9b8535eff","backgroundColor":"#101820","backgroundAssetId":null,
			 "backgroundFit":"cover","backgroundDim":0,"theme":"dark","fontFamily":"sans","fontAssetId":null,"version":1,
			 "zones":{"main":{"type":"empty"}}}]}`
	manifest, err := upgradeManifest([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	if manifest.ManifestVersion != ManifestVersion || manifest.Revision != 7 || len(manifest.Scenes) != 4 {
		t.Fatalf("manifest = %#v", manifest)
	}
	type box struct {
		id         string
		x, y, w, h int
	}
	boxes := func(blocks []Block) []box {
		result := make([]box, 0, len(blocks))
		for _, block := range blocks {
			result = append(result, box{block.ID, block.X, block.Y, block.W, block.H})
		}
		return result
	}
	want := [][]box{
		{{"left", 0, 0, 960, 1080}, {"right", 960, 0, 960, 1080}},
		// 1080 × 1920: columns 1fr 3fr at 0 | 270 | 1080, rows 2fr 1fr at 0 | 1280 | 1920.
		{{"wide", 0, 0, 1080, 1280}, {"low", 270, 1280, 810, 640}},
		// 2520 × 1080: 12.5 % = 315, 37.5 % = 945; 33.33 % = 359.964, 43.34 % = 468.072.
		{{"back", 0, 0, 2520, 1080}, {"badge", 315, 360, 630, 108}},
		{{"main", 0, 0, 1920, 1080}},
	}
	for index, scene := range manifest.Scenes {
		if got := boxes(scene.Blocks); !reflect.DeepEqual(got, want[index]) {
			t.Errorf("scene %s blocks = %v, want %v", scene.Name, got, want[index])
		}
		if _, _, err := ParseBlocks(mustMarshal(t, scene.Blocks)); err != nil {
			t.Errorf("scene %s blocks do not validate: %v", scene.Name, err)
		}
	}
	text, clock := manifest.Scenes[0].Blocks[0], manifest.Scenes[0].Blocks[1]
	if string(text.Widget) != `{"fit":false,"text":"Hi","type":"text"}` || text.Style.TextSize != 76 ||
		text.Style.Align != BlockAlignEnd || text.Style.VerticalAlign != BlockAlignCenter || text.Style.Padding != 22 ||
		text.Style.FontWeight != FontWeight600 || text.Style.LineHeight != 115 {
		t.Errorf("text block = %s %#v", text.Widget, text.Style)
	}
	if clock.Style.TextSize != 48 || clock.Style.Padding != 32 || clock.Style.Radius != 11 || clock.Style.BorderWidth != 5 ||
		clock.Style.Align != BlockAlignCenter || clock.Style.VerticalAlign != BlockAlignEnd ||
		clock.Style.FontFamily != BlockFontSerif || clock.Style.BackgroundOpacity != 50 ||
		*clock.Style.BackgroundColor != "#000000" || *clock.Style.TextColor != "#ffffff" || clock.Style.BorderColor != nil {
		t.Errorf("clock style = %#v", clock.Style)
	}
	if got := string(manifest.Scenes[1].Blocks[0].Widget); got != `{"dim":0,"fit":"cover","mediaId":null,"type":"image"}` {
		t.Errorf("image widget = %s", got)
	}
	if got := string(manifest.Scenes[2].Blocks[1].Widget); !strings.Contains(got, `"showLive":true`) ||
		!strings.Contains(got, `"showName":true`) {
		t.Errorf("camera widget = %s", got)
	}
	encoded, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	for _, gone := range []string{`"customLayouts"`, `"layoutsVersion"`, `"layoutId"`, `"zones"`} {
		if strings.Contains(string(encoded), gone) {
			t.Fatalf("upgraded manifest still carries %s", gone)
		}
	}
	again, err := upgradeManifest(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if changes := diffManifests(manifest, again); len(changes) != 0 {
		t.Fatalf("re-reading the upgraded manifest reports %v", changes)
	}
}

func mustMarshal(t *testing.T, value any) json.RawMessage {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}
