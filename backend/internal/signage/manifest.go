package signage

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"

	"github.com/google/uuid"
)

// LayoutsVersion is the version of the layout model that manifests were built against: 2 added
// custom layouts to the manifest. Bump it whenever the layout list or its meaning changes incompatibly.
const LayoutsVersion = 2

// Resolution is a display's pixel size.
type Resolution struct {
	Width  int `json:"width"`
	Height int `json:"height"`
}

// ManifestDisplay carries the display settings a player needs.
type ManifestDisplay struct {
	Orientation        Orientation `json:"orientation"`
	Resolution         Resolution  `json:"resolution"`
	VisibleFromOutside bool        `json:"visibleFromOutside"`
}

// ManifestRule is an enabled rule; rules are listed in evaluation order (first match wins).
type ManifestRule struct {
	ID                      uuid.UUID     `json:"id"`
	Kind                    ConditionKind `json:"kind"`
	Weekdays                []int         `json:"weekdays"`
	TimeFrom                *string       `json:"timeFrom"`
	TimeTo                  *string       `json:"timeTo"`
	MachineIDs              []uuid.UUID   `json:"machineIds"`
	MachineMatch            *MachineMatch `json:"machineMatch"`
	AnnouncementTemplateIDs []uuid.UUID   `json:"announcementTemplateIds"`
	TargetKind              TargetKind    `json:"targetKind"`
	TargetID                uuid.UUID     `json:"targetId"`
	MinSeconds              int           `json:"minSeconds"`
	MultiMode               MultiMode     `json:"multiMode"`
	AlternateSeconds        int           `json:"alternateSeconds"`
}

// ManifestScene is a scene as published; the version identifies the draft it was taken from.
type ManifestScene struct {
	ID                uuid.UUID                  `json:"id"`
	Name              string                     `json:"name"`
	Orientation       Orientation                `json:"orientation"`
	LayoutID          string                     `json:"layoutId"`
	CustomLayoutID    *uuid.UUID                 `json:"customLayoutId"`
	BackgroundColor   string                     `json:"backgroundColor"`
	BackgroundAssetID *uuid.UUID                 `json:"backgroundAssetId"`
	BackgroundFit     MediaFit                   `json:"backgroundFit"`
	BackgroundDim     int                        `json:"backgroundDim"`
	Theme             Theme                      `json:"theme"`
	Zones             map[string]json.RawMessage `json:"zones"`
	Version           int64                      `json:"version"`
}

// ManifestCustomLayout is a custom layout as published; the version identifies the draft it was taken from.
type ManifestCustomLayout struct {
	ID      uuid.UUID        `json:"id"`
	Name    string           `json:"name"`
	Mode    CustomLayoutMode `json:"mode"`
	Columns []int            `json:"columns"`
	Rows    []int            `json:"rows"`
	Zones   []CustomZone     `json:"zones"`
	Version int64            `json:"version"`
}

// ManifestPlaylistItem is one scene slot of a published playlist.
type ManifestPlaylistItem struct {
	SceneID    uuid.UUID  `json:"sceneId"`
	Seconds    int        `json:"seconds"`
	Transition Transition `json:"transition"`
}

// ManifestPlaylist is a playlist as published.
type ManifestPlaylist struct {
	ID      uuid.UUID              `json:"id"`
	Name    string                 `json:"name"`
	Items   []ManifestPlaylistItem `json:"items"`
	Version int64                  `json:"version"`
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
	Revision          int                `json:"revision"`
	Display           ManifestDisplay    `json:"display"`
	DefaultPlaylistID uuid.UUID          `json:"defaultPlaylistId"`
	Rules             []ManifestRule     `json:"rules"`
	Scenes            []ManifestScene    `json:"scenes"`
	Playlists         []ManifestPlaylist `json:"playlists"`
	Assets            []ManifestAsset    `json:"assets"`
	// CustomLayouts holds the custom layouts the published scenes use; publications made before custom
	// layouts existed do not have the field.
	CustomLayouts  []ManifestCustomLayout `json:"customLayouts"`
	LayoutsVersion int                    `json:"layoutsVersion"`
}

// displayDraft is the editable state of one display that a manifest is built from.
type displayDraft struct {
	ID                 uuid.UUID
	Name               string
	Orientation        Orientation
	Resolution         Resolution
	VisibleFromOutside bool
	DefaultPlaylistID  uuid.UUID
	Rules              []Rule
}

// manifestContent holds the scenes, playlists and assets that drafts can reach.
type manifestContent struct {
	scenes        map[uuid.UUID]ManifestScene
	playlists     map[uuid.UUID]ManifestPlaylist
	assets        map[uuid.UUID]ManifestAsset
	customLayouts map[uuid.UUID]ManifestCustomLayout
}

// sceneAssetIDs lists the assets a scene's background and widgets use.
func sceneAssetIDs(scene ManifestScene) ([]uuid.UUID, error) {
	var ids []uuid.UUID
	if scene.BackgroundAssetID != nil {
		ids = append(ids, *scene.BackgroundAssetID)
	}
	keys := make([]string, 0, len(scene.Zones))
	for key := range scene.Zones {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		_, refs, err := ValidateWidget(key, scene.Zones[key])
		if err != nil {
			return nil, fmt.Errorf("scene %s zone %s: %w", scene.ID, key, err)
		}
		ids = append(ids, refs.AllAssets()...)
	}
	return distinct(ids), nil
}

// assembleManifest builds the revision-less manifest of a draft from the content it reaches.
// Only enabled rules are published. Scenes, playlists and assets are ordered by id so that equal
// drafts always produce equal manifests.
func assembleManifest(draft displayDraft, content manifestContent) (Manifest, error) {
	manifest := Manifest{
		Display: ManifestDisplay{
			Orientation:        draft.Orientation,
			Resolution:         draft.Resolution,
			VisibleFromOutside: draft.VisibleFromOutside,
		},
		DefaultPlaylistID: draft.DefaultPlaylistID,
		Rules:             []ManifestRule{},
		Scenes:            []ManifestScene{},
		Playlists:         []ManifestPlaylist{},
		Assets:            []ManifestAsset{},
		CustomLayouts:     []ManifestCustomLayout{},
		LayoutsVersion:    LayoutsVersion,
	}
	playlistIDs := map[uuid.UUID]struct{}{draft.DefaultPlaylistID: {}}
	sceneIDs := map[uuid.UUID]struct{}{}
	for _, rule := range draft.Rules {
		if !rule.Enabled {
			continue
		}
		manifest.Rules = append(manifest.Rules, manifestRuleFrom(rule))
		if rule.TargetKind == TargetKindPlaylist {
			playlistIDs[rule.TargetID] = struct{}{}
		} else {
			sceneIDs[rule.TargetID] = struct{}{}
		}
	}
	for _, id := range sortedIDs(playlistIDs) {
		playlist, ok := content.playlists[id]
		if !ok {
			return Manifest{}, fmt.Errorf("playlist %s is missing", id)
		}
		manifest.Playlists = append(manifest.Playlists, playlist)
		for _, item := range playlist.Items {
			sceneIDs[item.SceneID] = struct{}{}
		}
	}
	assetIDs := map[uuid.UUID]struct{}{}
	layoutIDs := map[uuid.UUID]struct{}{}
	for _, id := range sortedIDs(sceneIDs) {
		scene, ok := content.scenes[id]
		if !ok {
			return Manifest{}, fmt.Errorf("scene %s is missing", id)
		}
		manifest.Scenes = append(manifest.Scenes, scene)
		if scene.CustomLayoutID != nil {
			layoutIDs[*scene.CustomLayoutID] = struct{}{}
		}
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
	for _, id := range sortedIDs(layoutIDs) {
		layout, ok := content.customLayouts[id]
		if !ok {
			return Manifest{}, fmt.Errorf("custom layout %s is missing", id)
		}
		manifest.CustomLayouts = append(manifest.CustomLayouts, layout)
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
		TargetKind:              rule.TargetKind,
		TargetID:                rule.TargetID,
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

// ManifestMachineIDs lists the machines a published manifest refers to: rule conditions, status
// widgets and camera widgets. These are the machines the live endpoint reports.
func ManifestMachineIDs(manifest Manifest) []uuid.UUID {
	ids := map[uuid.UUID]struct{}{}
	for _, rule := range manifest.Rules {
		for _, id := range rule.MachineIDs {
			ids[id] = struct{}{}
		}
	}
	for _, scene := range manifest.Scenes {
		for _, raw := range scene.Zones {
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
	}
	return sortedIDs(ids)
}

// ManifestCameraMachineIDs lists the machines whose camera stream the published manifest can show:
// the machines of camera widgets bound to a machine and the machines an automatic camera widget is
// restricted to. allCameras reports an automatic widget without a restriction; it may show every
// machine that has a camera, which the caller resolves.
func ManifestCameraMachineIDs(manifest Manifest) (ids []uuid.UUID, allCameras bool) {
	set := map[uuid.UUID]struct{}{}
	for _, scene := range manifest.Scenes {
		for _, raw := range scene.Zones {
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
// Scenes and playlists are compared by id and version, assets by id and checksum, rules by content.
func diffManifests(published, draft Manifest) []PendingChange {
	changes := []PendingChange{}
	if published.Display != draft.Display || published.DefaultPlaylistID != draft.DefaultPlaylistID {
		changes = append(changes, PendingChange{Kind: ChangeTargetDisplay, Name: "Display settings", Change: ChangeModified})
	}
	changes = append(changes, diffRules(published.Rules, draft.Rules)...)
	scenes := func(manifest Manifest) map[uuid.UUID]versioned {
		result := map[uuid.UUID]versioned{}
		for _, scene := range manifest.Scenes {
			result[scene.ID] = versioned{name: scene.Name, marker: fmt.Sprint(scene.Version)}
		}
		return result
	}
	playlists := func(manifest Manifest) map[uuid.UUID]versioned {
		result := map[uuid.UUID]versioned{}
		for _, playlist := range manifest.Playlists {
			result[playlist.ID] = versioned{name: playlist.Name, marker: fmt.Sprint(playlist.Version)}
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
	layouts := func(manifest Manifest) map[uuid.UUID]versioned {
		result := map[uuid.UUID]versioned{}
		for _, layout := range manifest.CustomLayouts {
			result[layout.ID] = versioned{name: layout.Name, marker: fmt.Sprint(layout.Version)}
		}
		return result
	}
	changes = append(changes, diffEntities(ChangeTargetScene, scenes(published), scenes(draft))...)
	changes = append(changes, diffEntities(ChangeTargetLayout, layouts(published), layouts(draft))...)
	changes = append(changes, diffEntities(ChangeTargetPlaylist, playlists(published), playlists(draft))...)
	changes = append(changes, diffEntities(ChangeTargetAsset, assets(published), assets(draft))...)
	return changes
}

type versioned struct{ name, marker string }

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
