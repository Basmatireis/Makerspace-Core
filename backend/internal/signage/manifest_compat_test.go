package signage

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// A publication made before custom layouts has no customLayouts and no customLayoutId. It must still
// decode, and diffing it against a current manifest must not report layouts or crash.
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
	if published.CustomLayouts != nil || published.Scenes[0].CustomLayoutID != nil || published.LayoutsVersion != 1 {
		t.Fatalf("old manifest = %#v", published)
	}
	if _, err := sceneAssetIDs(published.Scenes[0]); err != nil {
		t.Fatalf("old scene no longer validates: %v", err)
	}
	draft := published
	draft.CustomLayouts, draft.LayoutsVersion = []ManifestCustomLayout{}, LayoutsVersion
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
	// Upgrading is idempotent: the stored shape of version 3 passes through unchanged.
	again, err := upgradeManifest(encoded)
	if err != nil {
		t.Fatal(err)
	}
	reencoded, _ := json.Marshal(again)
	if string(reencoded) != string(encoded) {
		t.Fatalf("a version 3 manifest changed on upgrade:\n%s\n%s", encoded, reencoded)
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
		blank.LayoutID != "full" || blank.BackgroundColor != "#000000" || blank.Theme != ThemeDark || blank.Version != 1 ||
		len(blank.Zones) != 1 || string(blank.Zones["main"]) != `{"type":"empty"}` {
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
