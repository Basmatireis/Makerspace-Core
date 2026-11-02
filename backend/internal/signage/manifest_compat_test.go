package signage

import (
	"testing"
)

// A publication made before custom layouts has no customLayouts and no customLayoutId. It must still
// decode, and diffing it against a current manifest must not report layouts or crash.
func TestOldPublicationStillDecodesAndDiffs(t *testing.T) {
	const old = `{"revision":3,"display":{"orientation":"landscape","resolution":{"width":1920,"height":1080},"visibleFromOutside":false},
		"defaultPlaylistId":"01a163eb-b404-77e3-a447-7ad9b8535d7a","rules":[],"playlists":[],"assets":[],"layoutsVersion":1,
		"scenes":[{"id":"01a163eb-b3fd-74c6-9fa2-4aeb568c12f3","name":"A","orientation":"landscape","layoutId":"full",
		"backgroundColor":"#101820","backgroundAssetId":null,"backgroundFit":"cover","backgroundDim":0,"theme":"dark",
		"zones":{"main":{"type":"events","count":3}},"version":1}]}`
	published, err := decodeManifest([]byte(old))
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
		manifest, err := decodeManifest([]byte(raw))
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
	manifest, err := decodeManifest([]byte(current))
	if err != nil || manifest.Display.AspectRatio != (AspectRatio{21, 9}) {
		t.Fatalf("current manifest = %#v, %v", manifest.Display, err)
	}
}
