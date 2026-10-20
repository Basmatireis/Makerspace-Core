package signage

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	signagedb "github.com/Basmatireis/Makerspace-Core/backend/internal/signage/db"
	"github.com/google/uuid"
)

func TestPairingCodeUsesAlphabetAndLength(t *testing.T) {
	seen := map[string]struct{}{}
	for i := 0; i < 500; i++ {
		code, err := GeneratePairingCode()
		if err != nil {
			t.Fatal(err)
		}
		if len(code) != PairingCodeLength {
			t.Fatalf("code %q has length %d", code, len(code))
		}
		for _, character := range code {
			if !strings.ContainsRune(PairingCodeAlphabet, character) {
				t.Fatalf("code %q contains %q outside the alphabet", code, character)
			}
		}
		seen[code] = struct{}{}
	}
	if len(seen) < 490 {
		t.Fatalf("only %d distinct codes in 500 draws", len(seen))
	}
	for _, ambiguous := range "01OI" {
		if strings.ContainsRune(PairingCodeAlphabet, ambiguous) {
			t.Fatalf("alphabet contains look-alike %q", ambiguous)
		}
	}
}

func TestNormalizePairingCode(t *testing.T) {
	for raw, want := range map[string]string{"abc234": "ABC234", " abc-234 ": "ABC234", "ABC 234": "ABC234"} {
		got, ok := NormalizePairingCode(raw)
		if !ok || got != want {
			t.Errorf("NormalizePairingCode(%q) = %q, %v; want %q", raw, got, ok, want)
		}
	}
	for _, raw := range []string{"", "ABC23", "ABC2345", "ABC10O", "ABC23!", "ÄBC234"} {
		if _, ok := NormalizePairingCode(raw); ok {
			t.Errorf("NormalizePairingCode(%q) accepted a malformed code", raw)
		}
	}
}

func str(value string) *string { return &value }

func validTimeWindow() RuleInput {
	return RuleInput{
		Enabled: true, ConditionKind: "time_window", Weekdays: []int{3, 1, 1}, TimeFrom: str("22:00"), TimeTo: str("06:00"),
		TargetKind: "scene", TargetID: uuid.Must(uuid.NewV7()), MinSeconds: 20, MultiMode: "split", AlternateSeconds: 10,
	}
}

func TestValidateRuleInputPerKind(t *testing.T) {
	machine := uuid.Must(uuid.NewV7())
	template := uuid.Must(uuid.NewV7())
	cases := []struct {
		name   string
		mutate func(*RuleInput)
		ok     bool
	}{
		{"time window wraps midnight", func(*RuleInput) {}, true},
		{"time window needs weekdays", func(r *RuleInput) { r.Weekdays = nil }, false},
		{"time window needs times", func(r *RuleInput) { r.TimeTo = nil }, false},
		{"time window bad clock", func(r *RuleInput) { r.TimeFrom = str("24:00") }, false},
		{"time window equal bounds", func(r *RuleInput) { r.TimeTo = str("22:00") }, false},
		{"time window bad weekday", func(r *RuleInput) { r.Weekdays = []int{8} }, false},
		{"time window rejects machines", func(r *RuleInput) { r.MachineIDs = []uuid.UUID{machine} }, false},
		{
			"time window rejects templates",
			func(r *RuleInput) { r.AnnouncementTemplateIDs = []uuid.UUID{template} },
			false,
		},
		{"machine rule", func(r *RuleInput) {
			*r = RuleInput{
				ConditionKind:    "machine_printing",
				MachineIDs:       []uuid.UUID{machine},
				MachineMatch:     str("any"),
				TargetKind:       "playlist",
				TargetID:         r.TargetID,
				MinSeconds:       0,
				MultiMode:        "alternate",
				AlternateSeconds: 3,
			}
		}, true},
		{"machine rule needs machines", func(r *RuleInput) {
			*r = RuleInput{
				ConditionKind:    "machine_printing",
				MachineMatch:     str("any"),
				TargetKind:       "scene",
				TargetID:         r.TargetID,
				MultiMode:        "split",
				AlternateSeconds: 10,
			}
		}, false},
		{"machine rule needs match", func(r *RuleInput) {
			*r = RuleInput{
				ConditionKind:    "machine_printing",
				MachineIDs:       []uuid.UUID{machine},
				TargetKind:       "scene",
				TargetID:         r.TargetID,
				MultiMode:        "split",
				AlternateSeconds: 10,
			}
		}, false},
		{"machine rule rejects weekdays", func(r *RuleInput) {
			*r = RuleInput{
				ConditionKind:    "machine_printing",
				Weekdays:         []int{1},
				MachineIDs:       []uuid.UUID{machine},
				MachineMatch:     str("all"),
				TargetKind:       "scene",
				TargetID:         r.TargetID,
				MultiMode:        "split",
				AlternateSeconds: 10,
			}
		}, false},
		{"announcement rule any template", func(r *RuleInput) {
			*r = RuleInput{
				ConditionKind:    "announcement_active",
				TargetKind:       "scene",
				TargetID:         r.TargetID,
				MultiMode:        "split",
				AlternateSeconds: 10,
			}
		}, true},
		{"announcement rule with templates", func(r *RuleInput) {
			*r = RuleInput{
				ConditionKind:           "announcement_active",
				AnnouncementTemplateIDs: []uuid.UUID{template},
				TargetKind:              "scene",
				TargetID:                r.TargetID,
				MultiMode:               "split",
				AlternateSeconds:        10,
			}
		}, true},
		{"announcement rule rejects machines", func(r *RuleInput) {
			*r = RuleInput{
				ConditionKind:    "announcement_active",
				MachineIDs:       []uuid.UUID{machine},
				TargetKind:       "scene",
				TargetID:         r.TargetID,
				MultiMode:        "split",
				AlternateSeconds: 10,
			}
		}, false},
		{"live data rule", func(r *RuleInput) {
			*r = RuleInput{
				ConditionKind:    "live_data_unavailable",
				TargetKind:       "scene",
				TargetID:         r.TargetID,
				MultiMode:        "split",
				AlternateSeconds: 10,
			}
		}, true},
		{"live data rule rejects templates", func(r *RuleInput) {
			*r = RuleInput{
				ConditionKind:           "live_data_unavailable",
				AnnouncementTemplateIDs: []uuid.UUID{template},
				TargetKind:              "scene",
				TargetID:                r.TargetID,
				MultiMode:               "split",
				AlternateSeconds:        10,
			}
		}, false},
		{"unknown kind", func(r *RuleInput) { r.ConditionKind = "weather" }, false},
		{"unknown target kind", func(r *RuleInput) { r.TargetKind = "stream" }, false},
		{"missing target", func(r *RuleInput) { r.TargetID = uuid.Nil }, false},
		{"minimum seconds range", func(r *RuleInput) { r.MinSeconds = 601 }, false},
		{"alternate seconds range", func(r *RuleInput) { r.AlternateSeconds = 2 }, false},
		{"multi mode", func(r *RuleInput) { r.MultiMode = "grid" }, false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			input := validTimeWindow()
			testCase.mutate(&input)
			_, err := ValidateRuleInput(input)
			if (err == nil) != testCase.ok {
				t.Fatalf("err = %v, want ok = %v", err, testCase.ok)
			}
		})
	}
}

func TestValidateRuleInputNormalises(t *testing.T) {
	checked, err := ValidateRuleInput(validTimeWindow())
	if err != nil {
		t.Fatal(err)
	}
	if len(checked.Weekdays) != 2 || checked.Weekdays[0] != 1 || checked.Weekdays[1] != 3 {
		t.Fatalf("weekdays = %v, want sorted and de-duplicated [1 3]", checked.Weekdays)
	}
}

func sampleScene(name string, version int64, zones map[string]json.RawMessage) ManifestScene {
	return ManifestScene{
		ID: uuid.Must(
			uuid.NewV7(),
		), Name: name, Orientation: "landscape", LayoutID: "full", BackgroundColor: "#101820", BackgroundFit: "cover", Theme: "dark",
		Zones: zones, Version: version,
	}
}

func TestAssembleManifestIncludesOnlyReachableContent(t *testing.T) {
	image, video, unused := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	machine := uuid.Must(uuid.NewV7())
	ruleScene := sampleScene("Rule scene", 1, map[string]json.RawMessage{
		"main": json.RawMessage(`{"type":"video","mediaId":"` + video.String() + `","fit":"cover"}`),
	})
	listScene := sampleScene("Playlist scene", 1, map[string]json.RawMessage{
		"main": json.RawMessage(
			`{"type":"status","machineIds":["` + machine.String() + `"],"showProgress":true,"showRemaining":true}`,
		),
	})
	listScene.BackgroundAssetID = &image
	orphan := sampleScene("Orphan", 1, map[string]json.RawMessage{"main": json.RawMessage(`{"type":"empty"}`)})
	playlist := ManifestPlaylist{
		ID:      uuid.Must(uuid.NewV7()),
		Name:    "Default",
		Version: 3,
		Items:   []ManifestPlaylistItem{{SceneID: listScene.ID, Seconds: 10, Transition: "cut"}},
	}
	content := manifestContent{
		scenes:    map[uuid.UUID]ManifestScene{ruleScene.ID: ruleScene, listScene.ID: listScene, orphan.ID: orphan},
		playlists: map[uuid.UUID]ManifestPlaylist{playlist.ID: playlist},
		assets: map[uuid.UUID]ManifestAsset{
			image:  {ID: image, Kind: "image", SHA256: strings.Repeat("a", 64)},
			video:  {ID: video, Kind: "video", SHA256: strings.Repeat("b", 64)},
			unused: {ID: unused, Kind: "image", SHA256: strings.Repeat("c", 64)},
		},
	}
	enabled := Rule{
		ID:               uuid.Must(uuid.NewV7()),
		Enabled:          true,
		ConditionKind:    "live_data_unavailable",
		TargetKind:       "scene",
		TargetID:         ruleScene.ID,
		MinSeconds:       20,
		MultiMode:        "split",
		AlternateSeconds: 10,
	}
	disabled := Rule{
		ID:            uuid.Must(uuid.NewV7()),
		Enabled:       false,
		ConditionKind: "live_data_unavailable",
		TargetKind:    "scene",
		TargetID:      orphan.ID,
	}
	manifest, err := assembleManifest(displayDraft{
		Orientation: "landscape", Resolution: Resolution{Width: 1920, Height: 1080}, DefaultPlaylistID: playlist.ID, Rules: []Rule{enabled, disabled},
	}, content)
	if err != nil {
		t.Fatal(err)
	}
	if len(manifest.Rules) != 1 || manifest.Rules[0].ID != enabled.ID {
		t.Fatalf("rules = %#v, want only the enabled rule", manifest.Rules)
	}
	if len(manifest.Scenes) != 2 || len(manifest.Playlists) != 1 || len(manifest.Assets) != 2 {
		t.Fatalf(
			"scenes=%d playlists=%d assets=%d, want 2/1/2 (no orphan scene, no unused asset)",
			len(manifest.Scenes),
			len(manifest.Playlists),
			len(manifest.Assets),
		)
	}
	if machines := ManifestMachineIDs(manifest); len(machines) != 1 || machines[0] != machine {
		t.Fatalf("machine ids = %v, want [%s]", machines, machine)
	}
	if manifest.LayoutsVersion != LayoutsVersion {
		t.Fatal("layouts version missing")
	}
	again, err := assembleManifest(
		displayDraft{
			Orientation:       "landscape",
			Resolution:        Resolution{Width: 1920, Height: 1080},
			DefaultPlaylistID: playlist.ID,
			Rules:             []Rule{enabled, disabled},
		},
		content,
	)
	if err != nil {
		t.Fatal(err)
	}
	first, _ := json.Marshal(manifest)
	second, _ := json.Marshal(again)
	if string(first) != string(second) {
		t.Fatal("equal drafts produced different manifests")
	}
	if _, err := assembleManifest(displayDraft{DefaultPlaylistID: uuid.Must(uuid.NewV7())}, content); err == nil {
		t.Fatal("a missing default playlist was accepted")
	}
}

func TestDiffManifests(t *testing.T) {
	sceneA := ManifestScene{ID: uuid.Must(uuid.NewV7()), Name: "A", Version: 1}
	sceneB := ManifestScene{ID: uuid.Must(uuid.NewV7()), Name: "B", Version: 1}
	playlist := ManifestPlaylist{ID: uuid.Must(uuid.NewV7()), Name: "P", Version: 1}
	rule1 := ManifestRule{
		ID:         uuid.Must(uuid.NewV7()),
		Kind:       "live_data_unavailable",
		TargetKind: "scene",
		TargetID:   sceneA.ID,
		MinSeconds: 20,
	}
	rule2 := ManifestRule{
		ID:         uuid.Must(uuid.NewV7()),
		Kind:       "announcement_active",
		TargetKind: "scene",
		TargetID:   sceneB.ID,
		MinSeconds: 20,
	}
	base := Manifest{
		Display: ManifestDisplay{Orientation: "landscape"}, DefaultPlaylistID: playlist.ID,
		Rules: []ManifestRule{
			rule1,
			rule2,
		}, Scenes: []ManifestScene{sceneA, sceneB}, Playlists: []ManifestPlaylist{playlist},
		Assets: []ManifestAsset{{ID: uuid.Must(uuid.NewV7()), Name: "logo", SHA256: "x"}},
	}
	if changes := diffManifests(base, base); len(changes) != 0 {
		t.Fatalf("identical manifests differ: %#v", changes)
	}

	modified := base
	modified.Scenes = []ManifestScene{{ID: sceneA.ID, Name: "A", Version: 2}, sceneB}
	if changes := diffManifests(base, modified); len(changes) != 1 ||
		changes[0] != (PendingChange{Kind: "scene", Name: "A", Change: "modified"}) {
		t.Fatalf("scene version bump = %#v", changes)
	}

	changed := base
	changed.Display.Orientation = "portrait"
	changed.Rules = []ManifestRule{rule2, rule1}
	removedScene := ManifestScene{ID: uuid.Must(uuid.NewV7()), Name: "C", Version: 1}
	changed.Scenes = []ManifestScene{sceneA, removedScene}
	changed.Playlists = nil
	changed.Assets = []ManifestAsset{{ID: base.Assets[0].ID, Name: "logo", SHA256: "y"}}
	got := map[PendingChange]bool{}
	for _, change := range diffManifests(base, changed) {
		got[change] = true
	}
	for _, want := range []PendingChange{
		{Kind: "display", Name: "Display settings", Change: "modified"},
		{Kind: "rule", Name: "Rule order", Change: "modified"},
		{Kind: "scene", Name: "C", Change: "added"},
		{Kind: "scene", Name: "B", Change: "removed"},
		{Kind: "playlist", Name: "P", Change: "removed"},
		{Kind: "asset", Name: "logo", Change: "modified"},
	} {
		if !got[want] {
			t.Errorf("missing change %#v in %#v", want, got)
		}
	}

	edited := base
	edited.Rules = []ManifestRule{
		rule1,
		{ID: rule2.ID, Kind: "announcement_active", TargetKind: "scene", TargetID: sceneB.ID, MinSeconds: 30},
		{ID: uuid.Must(uuid.NewV7()), Kind: "live_data_unavailable"},
	}
	changes := diffManifests(base, edited)
	var added, modifiedRules int
	for _, change := range changes {
		if change.Kind == "rule" && change.Change == "added" {
			added++
		}
		if change.Kind == "rule" && change.Change == "modified" {
			modifiedRules++
		}
	}
	if added != 1 || modifiedRules != 1 {
		t.Fatalf("rule changes = %#v", changes)
	}
}

func TestValidateHeartbeat(t *testing.T) {
	revision, negative := 3, int64(-1)
	good := Heartbeat{
		Revision:      &revision,
		CurrentRule:   str("default"),
		PlayerVersion: str("1.0.0"),
		Errors:        []string{"asset failed"},
	}
	if _, err := ValidateHeartbeat(good); err != nil {
		t.Fatal(err)
	}
	zero := 0
	tooMany := make([]string, 21)
	for index := range tooMany {
		tooMany[index] = "x"
	}
	for name, bad := range map[string]Heartbeat{
		"revision zero":        {Revision: &zero},
		"negative cache":       {CacheUsedBytes: &negative},
		"too many errors":      {Errors: tooMany},
		"long error":           {Errors: []string{strings.Repeat("x", 201)}},
		"control in error":     {Errors: []string{"a\nb"}},
		"rule with space":      {CurrentRule: str("a b")},
		"empty player version": {PlayerVersion: str("")},
		"long player version":  {PlayerVersion: str(strings.Repeat("v", 65))},
	} {
		if _, err := ValidateHeartbeat(bad); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
}

func TestLiveMachineStaleness(t *testing.T) {
	id := uuid.Must(uuid.NewV7())
	now := time.Date(2026, 5, 1, 10, 0, 0, 0, time.UTC)
	snapshot := []byte(
		`{"state":"printing","job":{"fileName":"secret.3mf","progressPercent":42,"remainingMinutes":17}}`,
	)
	fresh := &signagedb.ListSignageLiveStatusesRow{
		ObservedAt: now.Add(-20 * time.Second),
		ReceivedAt: now.Add(-10 * time.Second),
		Snapshot:   snapshot,
	}
	machine := liveMachineFrom(id, "Printer", fresh, now)
	if machine.State != "printing" || machine.Stale || machine.ProgressPercent == nil ||
		*machine.ProgressPercent != 42 ||
		*machine.RemainingMinutes != 17 {
		t.Fatalf("fresh machine = %#v", machine)
	}
	old := &signagedb.ListSignageLiveStatusesRow{
		ObservedAt: now.Add(-10 * time.Minute),
		ReceivedAt: now.Add(-4 * time.Minute),
		Snapshot:   snapshot,
	}
	machine = liveMachineFrom(id, "Printer", old, now)
	if machine.State != "unknown" || !machine.Stale || machine.ProgressPercent != nil || machine.ObservedAt == nil {
		t.Fatalf("stale machine = %#v", machine)
	}
	if machine = liveMachineFrom(id, "Printer", nil, now); machine.State != "unknown" || !machine.Stale ||
		machine.ObservedAt != nil {
		t.Fatalf("machine without status = %#v", machine)
	}
	odd := &signagedb.ListSignageLiveStatusesRow{
		ObservedAt: now,
		ReceivedAt: now,
		Snapshot:   []byte(`{"state":"exploding"}`),
	}
	if machine = liveMachineFrom(id, "Printer", odd, now); machine.State != "unknown" {
		t.Fatalf("unknown state mapped to %q", machine.State)
	}
	finished := &signagedb.ListSignageLiveStatusesRow{
		ObservedAt: now,
		ReceivedAt: now,
		Snapshot:   []byte(`{"state":"finished","job":{"progressPercent":100,"remainingMinutes":0}}`),
	}
	if machine = liveMachineFrom(id, "Printer", finished, now); machine.State != "finished" ||
		machine.ProgressPercent != nil {
		t.Fatalf("finished machine = %#v", machine)
	}
}
