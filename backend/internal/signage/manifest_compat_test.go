package signage

import (
	"encoding/json"
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
	var published Manifest
	if err := json.Unmarshal([]byte(old), &published); err != nil {
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
