package signage

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"

	"github.com/google/uuid"
)

// ManifestVersion is the shape of the manifests this code publishes: 3 replaced playlists with scene lists
// on rules and the default, 4 replaced layouts with zones by blocks. Stored manifests of an older shape are
// upgraded when they are read.
const ManifestVersion = 4

// blankSceneID is the id of the synthetic scene that an upgraded publication shows when its default playlist
// was empty and it holds no scene with the display's aspect ratio.
var blankSceneID = uuid.MustParse("00000000-0000-7000-8000-000000000001")

// ManifestDisplay carries the display settings a player needs.
type ManifestDisplay struct {
	AspectRatio        AspectRatio `json:"aspectRatio"`
	VisibleFromOutside bool        `json:"visibleFromOutside"`
}

// ManifestRule is an enabled rule; rules are listed in evaluation order (first match wins).
type ManifestRule struct {
	ID                      uuid.UUID       `json:"id"`
	Kind                    ConditionKind   `json:"kind"`
	Weekdays                []int           `json:"weekdays"`
	TimeFrom                *string         `json:"timeFrom"`
	TimeTo                  *string         `json:"timeTo"`
	MachineIDs              []uuid.UUID     `json:"machineIds"`
	MachineMatch            *MachineMatch   `json:"machineMatch"`
	AnnouncementTemplateIDs []uuid.UUID     `json:"announcementTemplateIds"`
	Scenes                  []SceneListItem `json:"scenes"`
	MinSeconds              int             `json:"minSeconds"`
	MultiMode               MultiMode       `json:"multiMode"`
	AlternateSeconds        int             `json:"alternateSeconds"`
}

// ManifestScene is a scene as published; the version identifies the draft it was taken from.
type ManifestScene struct {
	ID                uuid.UUID       `json:"id"`
	Name              string          `json:"name"`
	AspectRatio       AspectRatio     `json:"aspectRatio"`
	BackgroundColor   string          `json:"backgroundColor"`
	BackgroundAssetID *uuid.UUID      `json:"backgroundAssetId"`
	BackgroundFit     MediaFit        `json:"backgroundFit"`
	BackgroundDim     int             `json:"backgroundDim"`
	Theme             Theme           `json:"theme"`
	FontFamily        SceneFontFamily `json:"fontFamily"`
	FontAssetID       *uuid.UUID      `json:"fontAssetId"`
	Blocks            []Block         `json:"blocks"`
	Version           int64           `json:"version"`
}

// ManifestAsset is a media file a published scene uses; players fetch it by id and sha256.
type ManifestAsset struct {
	ID          uuid.UUID `json:"id"`
	Kind        AssetKind `json:"kind"`
	Name        string    `json:"name"`
	ContentType string    `json:"contentType"`
	SHA256      string    `json:"sha256"`
	SizeBytes   int64     `json:"sizeBytes"`
	Width       *int      `json:"width"`
	Height      *int      `json:"height"`
	DurationMs  *int      `json:"durationMs"`
}

// Manifest is the immutable content of one publication.
type Manifest struct {
	ManifestVersion int             `json:"manifestVersion"`
	Revision        int             `json:"revision"`
	Display         ManifestDisplay `json:"display"`
	DefaultScenes   []SceneListItem `json:"defaultScenes"`
	Rules           []ManifestRule  `json:"rules"`
	Scenes          []ManifestScene `json:"scenes"`
	Assets          []ManifestAsset `json:"assets"`
}

// displayDraft is the editable state of one display that a manifest is built from.
type displayDraft struct {
	ID                 uuid.UUID
	Name               string
	AspectRatio        AspectRatio
	VisibleFromOutside bool
	DefaultScenes      []SceneListItem
	Rules              []Rule
}

// manifestContent holds the scenes and assets that drafts can reach.
type manifestContent struct {
	scenes map[uuid.UUID]ManifestScene
	assets map[uuid.UUID]ManifestAsset
}

// sceneAssetIDs lists the assets a scene's background, font and visible blocks use; displays never show
// hidden blocks, so their assets are not published.
func sceneAssetIDs(scene ManifestScene) ([]uuid.UUID, error) {
	var ids []uuid.UUID
	if scene.BackgroundAssetID != nil {
		ids = append(ids, *scene.BackgroundAssetID)
	}
	if scene.FontAssetID != nil {
		ids = append(ids, *scene.FontAssetID)
	}
	for _, block := range scene.Blocks {
		if block.Hidden {
			continue
		}
		refs, err := blockRefs(block)
		if err != nil {
			return nil, fmt.Errorf("scene %s block %s: %w", scene.ID, block.ID, err)
		}
		ids = append(ids, refs.AllAssets()...)
	}
	return distinct(ids), nil
}

// assembleManifest builds the revision-less manifest of a draft from the content it reaches.
// Only enabled rules are published. Scenes and assets are ordered by id so that equal drafts always
// produce equal manifests.
func assembleManifest(draft displayDraft, content manifestContent) (Manifest, error) {
	if len(draft.DefaultScenes) == 0 {
		return Manifest{}, fmt.Errorf("display %s has no default scenes", draft.ID)
	}
	manifest := Manifest{
		ManifestVersion: ManifestVersion,
		Display: ManifestDisplay{
			AspectRatio:        draft.AspectRatio,
			VisibleFromOutside: draft.VisibleFromOutside,
		},
		DefaultScenes: append([]SceneListItem{}, draft.DefaultScenes...),
		Rules:         []ManifestRule{},
		Scenes:        []ManifestScene{},
		Assets:        []ManifestAsset{},
	}
	sceneIDs := map[uuid.UUID]struct{}{}
	for _, item := range draft.DefaultScenes {
		sceneIDs[item.SceneID] = struct{}{}
	}
	for _, rule := range draft.Rules {
		if !rule.Enabled {
			continue
		}
		manifest.Rules = append(manifest.Rules, manifestRuleFrom(rule))
		for _, item := range rule.Scenes {
			sceneIDs[item.SceneID] = struct{}{}
		}
	}
	assetIDs := map[uuid.UUID]struct{}{}
	for _, id := range sortedIDs(sceneIDs) {
		scene, ok := content.scenes[id]
		if !ok {
			return Manifest{}, fmt.Errorf("scene %s is missing", id)
		}
		manifest.Scenes = append(manifest.Scenes, scene)
		ids, err := sceneAssetIDs(scene)
		if err != nil {
			return Manifest{}, err
		}
		for _, assetID := range ids {
			assetIDs[assetID] = struct{}{}
		}
	}
	for _, id := range sortedIDs(assetIDs) {
		asset, ok := content.assets[id]
		if !ok {
			return Manifest{}, fmt.Errorf("asset %s is missing", id)
		}
		manifest.Assets = append(manifest.Assets, asset)
	}
	return manifest, nil
}

func manifestRuleFrom(rule Rule) ManifestRule {
	return ManifestRule{
		ID: rule.ID, Kind: rule.ConditionKind, Weekdays: append(
			[]int{},
			rule.Weekdays...,
		), TimeFrom: rule.TimeFrom, TimeTo: rule.TimeTo,
		MachineIDs: append([]uuid.UUID{}, rule.MachineIDs...), MachineMatch: rule.MachineMatch,
		AnnouncementTemplateIDs: append([]uuid.UUID{}, rule.AnnouncementTemplateIDs...),
		Scenes:                  append([]SceneListItem{}, rule.Scenes...),
		MinSeconds:              rule.MinSeconds,
		MultiMode:               rule.MultiMode,
		AlternateSeconds:        rule.AlternateSeconds,
	}
}

func sortedIDs(set map[uuid.UUID]struct{}) []uuid.UUID {
	ids := make([]uuid.UUID, 0, len(set))
	for id := range set {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return bytes.Compare(ids[i][:], ids[j][:]) < 0 })
	return ids
}

// manifestWidgets lists the widgets of the visible blocks of every published scene.
func manifestWidgets(manifest Manifest) []RawWidget {
	var widgets []RawWidget
	for _, scene := range manifest.Scenes {
		widgets = append(widgets, visibleWidgets(scene.Blocks)...)
	}
	return widgets
}

// ManifestMachineIDs lists the machines a published manifest refers to: rule conditions, status
// widgets and camera widgets of visible blocks. These are the machines the live endpoint reports.
func ManifestMachineIDs(manifest Manifest) []uuid.UUID {
	ids := map[uuid.UUID]struct{}{}
	for _, rule := range manifest.Rules {
		for _, id := range rule.MachineIDs {
			ids[id] = struct{}{}
		}
	}
	for _, raw := range manifestWidgets(manifest) {
		var widget struct {
			Type       WidgetType   `json:"type"`
			Source     CameraSource `json:"source"`
			MachineID  *uuid.UUID   `json:"machineId"`
			MachineIDs []uuid.UUID  `json:"machineIds"`
		}
		if json.Unmarshal(raw, &widget) != nil {
			continue
		}
		switch widget.Type {
		case WidgetCamera:
			if widget.MachineID != nil {
				ids[*widget.MachineID] = struct{}{}
			}
			if widget.Source == CameraSourceAuto {
				for _, id := range widget.MachineIDs {
					ids[id] = struct{}{}
				}
			}
		case WidgetStatus:
			for _, id := range widget.MachineIDs {
				ids[id] = struct{}{}
			}
		}
	}
	return sortedIDs(ids)
}

// ManifestCameraMachineIDs lists the machines whose camera stream the published manifest can show:
// the machines of visible camera widgets bound to a machine and the machines an automatic camera widget is
// restricted to. allCameras reports an automatic widget without a restriction; it may show every
// machine that has a camera, which the caller resolves.
func ManifestCameraMachineIDs(manifest Manifest) (ids []uuid.UUID, allCameras bool) {
	set := map[uuid.UUID]struct{}{}
	for _, raw := range manifestWidgets(manifest) {
		var widget struct {
			Type       WidgetType   `json:"type"`
			Source     CameraSource `json:"source"`
			MachineID  *uuid.UUID   `json:"machineId"`
			MachineIDs []uuid.UUID  `json:"machineIds"`
		}
		if json.Unmarshal(raw, &widget) != nil || widget.Type != WidgetCamera {
			continue
		}
		switch {
		case widget.Source != CameraSourceAuto:
			if widget.MachineID != nil {
				set[*widget.MachineID] = struct{}{}
			}
		case len(widget.MachineIDs) == 0:
			allCameras = true
		default:
			for _, id := range widget.MachineIDs {
				set[id] = struct{}{}
			}
		}
	}
	return sortedIDs(set), allCameras
}

// PendingChange is one difference between a display's drafts and its latest publication.
type PendingChange struct {
	Kind   ChangeTarget
	Name   string
	Change ChangeKind
}

// diffManifests lists what publishing the draft would change compared with the published manifest.
// Scenes are compared by id, version and blocks (a publication upgraded from layouts and zones keeps its scene
// versions), assets by id and checksum, rules and the default scene list by content.
func diffManifests(published, draft Manifest) []PendingChange {
	changes := []PendingChange{}
	if published.Display != draft.Display {
		changes = append(changes, PendingChange{Kind: ChangeTargetDisplay, Name: "Display settings", Change: ChangeModified})
	}
	if !sceneListsEqual(published.DefaultScenes, draft.DefaultScenes) {
		changes = append(changes, PendingChange{Kind: ChangeTargetDisplay, Name: "Default scenes", Change: ChangeModified})
	}
	changes = append(changes, diffRules(published.Rules, draft.Rules)...)
	scenes := func(manifest Manifest) map[uuid.UUID]versioned {
		result := map[uuid.UUID]versioned{}
		for _, scene := range manifest.Scenes {
			result[scene.ID] = versioned{name: scene.Name, marker: fmt.Sprint(scene.Version) + ":" + blocksDigest(scene.Blocks)}
		}
		return result
	}
	assets := func(manifest Manifest) map[uuid.UUID]versioned {
		result := map[uuid.UUID]versioned{}
		for _, asset := range manifest.Assets {
			result[asset.ID] = versioned{name: asset.Name, marker: asset.SHA256}
		}
		return result
	}
	changes = append(changes, diffEntities(ChangeTargetScene, scenes(published), scenes(draft))...)
	changes = append(changes, diffEntities(ChangeTargetAsset, assets(published), assets(draft))...)
	return changes
}

type versioned struct{ name, marker string }

// blocksDigest identifies the content of blocks independent of key order and whitespace of their widgets.
func blocksDigest(blocks []Block) string {
	encoded, err := json.Marshal(blocks)
	if err != nil {
		return ""
	}
	var generic any
	if json.Unmarshal(encoded, &generic) != nil {
		return ""
	}
	normalized, err := json.Marshal(generic)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(normalized)
	return hex.EncodeToString(sum[:])
}

func diffEntities(kind ChangeTarget, published, draft map[uuid.UUID]versioned) []PendingChange {
	var changes []PendingChange
	for id, item := range draft {
		previous, existed := published[id]
		switch {
		case !existed:
			changes = append(changes, PendingChange{Kind: kind, Name: item.name, Change: ChangeAdded})
		case previous.marker != item.marker:
			changes = append(changes, PendingChange{Kind: kind, Name: item.name, Change: ChangeModified})
		}
	}
	for id, item := range published {
		if _, kept := draft[id]; !kept {
			changes = append(changes, PendingChange{Kind: kind, Name: item.name, Change: ChangeRemoved})
		}
	}
	sort.Slice(changes, func(i, j int) bool {
		if changes[i].Name != changes[j].Name {
			return changes[i].Name < changes[j].Name
		}
		return changes[i].Change < changes[j].Change
	})
	return changes
}

func ruleLabel(position int, rule ManifestRule) string {
	return fmt.Sprintf("Rule %d (%s)", position+1, rule.Kind)
}

func diffRules(published, draft []ManifestRule) []PendingChange {
	var changes []PendingChange
	previous := make(map[uuid.UUID]int, len(published))
	for index, rule := range published {
		previous[rule.ID] = index
	}
	kept := make(map[uuid.UUID]struct{}, len(draft))
	var survivingDraft, survivingPublished []uuid.UUID
	for index, rule := range draft {
		kept[rule.ID] = struct{}{}
		old, existed := previous[rule.ID]
		if !existed {
			changes = append(changes, PendingChange{Kind: ChangeTargetRule, Name: ruleLabel(index, rule), Change: ChangeAdded})
			continue
		}
		survivingDraft = append(survivingDraft, rule.ID)
		before, _ := json.Marshal(published[old])
		after, _ := json.Marshal(rule)
		if !bytes.Equal(before, after) {
			changes = append(changes, PendingChange{Kind: ChangeTargetRule, Name: ruleLabel(index, rule), Change: ChangeModified})
		}
	}
	for index, rule := range published {
		if _, ok := kept[rule.ID]; !ok {
			changes = append(changes, PendingChange{Kind: ChangeTargetRule, Name: ruleLabel(index, rule), Change: ChangeRemoved})
		} else {
			survivingPublished = append(survivingPublished, rule.ID)
		}
	}
	for index := range survivingDraft {
		if survivingDraft[index] != survivingPublished[index] {
			changes = append(changes, PendingChange{Kind: ChangeTargetRule, Name: "Rule order", Change: ChangeModified})
			break
		}
	}
	return changes
}

// legacyManifestShape holds the fields that older publications carried instead: orientation and resolution
// before aspect ratios, rule targets, the default playlist and the playlists before scene lists (version 3),
// and layouts with zones and the custom layouts before blocks (version 4).
type legacyManifestShape struct {
	Display struct {
		Orientation string `json:"orientation"`
		Resolution  struct {
			Width  int `json:"width"`
			Height int `json:"height"`
		} `json:"resolution"`
	} `json:"display"`
	Scenes []struct {
		Orientation string `json:"orientation"`
		legacyManifestScene
	} `json:"scenes"`
	CustomLayouts []LegacyCustomLayout `json:"customLayouts"`
	Rules         []struct {
		TargetKind string    `json:"targetKind"`
		TargetID   uuid.UUID `json:"targetId"`
	} `json:"rules"`
	DefaultPlaylistID uuid.UUID `json:"defaultPlaylistId"`
	Playlists         []struct {
		ID    uuid.UUID       `json:"id"`
		Items []SceneListItem `json:"items"`
	} `json:"playlists"`
}

// upgradeManifest reads a stored publication. Stored rows are never rewritten, so an older publication still has
// an older shape; it is converted in memory:
//   - a publication made before aspect ratios gets the ratios that migration 00090 gave its display and scenes
//     (the reduced resolution, or 16:9 / 9:16 when that does not fit 1–100; scenes 16:9 when landscape and
//     9:16 when portrait);
//   - a rule that showed a scene shows a one-item list (10 seconds, cut), a rule that showed a playlist shows
//     the published playlist's items, and a rule whose playlist was empty is dropped (it showed nothing);
//   - the default playlist's items become the default list; an empty default playlist becomes the first scene
//     with the display's ratio, or a synthetic black Blank scene when there is none;
//   - a scene with a layout and zones gets the blocks that migration 00130 gave the stored scenes, using the
//     custom layout published with it (ConvertLegacyScene).
func upgradeManifest(raw []byte) (Manifest, error) {
	var manifest Manifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return Manifest{}, err
	}
	// Publications made before scene fonts have no font; their scenes use the default one.
	for index := range manifest.Scenes {
		if manifest.Scenes[index].FontFamily == "" {
			manifest.Scenes[index].FontFamily = SceneFontSans
		}
	}
	if manifest.ManifestVersion >= ManifestVersion {
		return manifest, nil
	}
	var legacy legacyManifestShape
	if err := json.Unmarshal(raw, &legacy); err != nil {
		return Manifest{}, err
	}
	if manifest.ManifestVersion < 3 {
		upgradeToSceneLists(&manifest, legacy)
	}
	if err := upgradeToBlocks(&manifest, legacy); err != nil {
		return Manifest{}, err
	}
	manifest.ManifestVersion = ManifestVersion
	return manifest, nil
}

// upgradeToSceneLists converts a publication made before manifest version 3.
func upgradeToSceneLists(manifest *Manifest, legacy legacyManifestShape) {
	if manifest.Display.AspectRatio == (AspectRatio{}) {
		resolution := AspectRatio{Width: legacy.Display.Resolution.Width, Height: legacy.Display.Resolution.Height}
		ratio := resolution.Reduce()
		if !ratio.Valid() {
			ratio = ratioOfOrientation(legacy.Display.Orientation != "portrait")
		}
		manifest.Display.AspectRatio = ratio
	}
	for index := range manifest.Scenes {
		if manifest.Scenes[index].AspectRatio == (AspectRatio{}) && index < len(legacy.Scenes) {
			manifest.Scenes[index].AspectRatio = ratioOfOrientation(legacy.Scenes[index].Orientation != "portrait")
		}
	}
	if manifest.Scenes == nil {
		manifest.Scenes = []ManifestScene{}
	}
	playlists := make(map[uuid.UUID][]SceneListItem, len(legacy.Playlists))
	for _, playlist := range legacy.Playlists {
		playlists[playlist.ID] = playlist.Items
	}
	rules := make([]ManifestRule, 0, len(manifest.Rules))
	for index, rule := range manifest.Rules {
		if len(rule.Scenes) == 0 && index < len(legacy.Rules) {
			target := legacy.Rules[index]
			if target.TargetKind == "playlist" {
				rule.Scenes = append([]SceneListItem{}, playlists[target.TargetID]...)
			} else if target.TargetID != uuid.Nil {
				rule.Scenes = []SceneListItem{{SceneID: target.TargetID, Seconds: defaultItemSeconds, Transition: TransitionCut}}
			}
		}
		if len(rule.Scenes) == 0 {
			continue // an empty playlist showed nothing; the rule never matched visibly
		}
		rules = append(rules, rule)
	}
	manifest.Rules = rules
	if len(manifest.DefaultScenes) == 0 {
		manifest.DefaultScenes = append([]SceneListItem{}, playlists[legacy.DefaultPlaylistID]...)
	}
	if len(manifest.DefaultScenes) == 0 {
		manifest.DefaultScenes = []SceneListItem{{SceneID: fallbackScene(manifest), Seconds: defaultItemSeconds, Transition: TransitionCut}}
	}
}

// upgradeToBlocks gives every scene published with a layout and zones its blocks.
func upgradeToBlocks(manifest *Manifest, legacy legacyManifestShape) error {
	layouts := make(map[uuid.UUID]LegacyCustomLayout, len(legacy.CustomLayouts))
	for _, layout := range legacy.CustomLayouts {
		layouts[layout.ID] = layout
	}
	for index := range manifest.Scenes {
		scene := &manifest.Scenes[index]
		if scene.Blocks != nil || index >= len(legacy.Scenes) {
			continue
		}
		stored := legacy.Scenes[index].legacyManifestScene
		var custom *LegacyCustomLayout
		if stored.CustomLayoutID != nil {
			if layout, ok := layouts[*stored.CustomLayoutID]; ok {
				custom = &layout
			}
		}
		blocks, err := ConvertLegacyScene(scene.AspectRatio, stored.LayoutID, custom, stored.Zones)
		if err != nil {
			return fmt.Errorf("upgrade scene %s: %w", scene.ID, err)
		}
		scene.Blocks = blocks
	}
	return nil
}

// fallbackScene is the default an upgraded publication shows when its default playlist was empty: the first
// scene with the display's ratio, or a synthetic black Blank scene that it appends to the manifest.
func fallbackScene(manifest *Manifest) uuid.UUID {
	for _, scene := range manifest.Scenes {
		if scene.AspectRatio == manifest.Display.AspectRatio {
			return scene.ID
		}
	}
	// The full layout with an empty zone: one empty block, which cannot fail to convert.
	blocks, _ := ConvertLegacyScene(manifest.Display.AspectRatio, "full", nil, nil)
	manifest.Scenes = append(manifest.Scenes, ManifestScene{
		ID:              blankSceneID,
		Name:            "Blank",
		AspectRatio:     manifest.Display.AspectRatio,
		BackgroundColor: "#000000",
		BackgroundFit:   MediaFitCover,
		Theme:           ThemeDark,
		FontFamily:      SceneFontSans,
		Blocks:          blocks,
		Version:         1,
	})
	return blankSceneID
}

// ratioOfOrientation is 16:9 for landscape and 9:16 for portrait.
func ratioOfOrientation(landscape bool) AspectRatio {
	if landscape {
		return AspectRatio{Width: 16, Height: 9}
	}
	return AspectRatio{Width: 9, Height: 16}
}
