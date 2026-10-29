package printerconnector

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/printartifacts/parser"
	"github.com/google/uuid"
)

func TestParseBambuH2DConfiguration(t *testing.T) {
	t.Parallel()
	settings, secrets, err := parseBambuH2DConfiguration(
		map[string]any{"ipAddress": "192.168.1.42", "serialNumber": " 01p09a123456789 ", "autoDetectSpools": true},
		map[string]string{"lanAccessCode": " secret "},
	)
	if err != nil {
		t.Fatal(err)
	}
	if settings.IPAddress.String() != "192.168.1.42" || settings.SerialNumber != "01P09A123456789" ||
		!settings.AutoDetectSpools ||
		secrets.LANAccessCode != "secret" {
		t.Fatalf("unexpected parsed configuration: %#v %#v", settings, secrets)
	}
	for name, test := range map[string]struct {
		settings map[string]any
		secrets  map[string]string
	}{
		"hostname": {
			map[string]any{"ipAddress": "printer.local", "serialNumber": "01P09A123456789"},
			map[string]string{"lanAccessCode": "secret"},
		},
		"multicast": {
			map[string]any{"ipAddress": "224.0.0.1", "serialNumber": "01P09A123456789"},
			map[string]string{"lanAccessCode": "secret"},
		},
		"bad serial": {
			map[string]any{"ipAddress": "192.168.1.42", "serialNumber": "bad serial"},
			map[string]string{"lanAccessCode": "secret"},
		},
		"missing secret": {
			map[string]any{"ipAddress": "192.168.1.42", "serialNumber": "01P09A123456789"},
			map[string]string{},
		},
		"unknown field": {
			map[string]any{"ipAddress": "192.168.1.42", "serialNumber": "01P09A123456789", "port": 1883},
			map[string]string{"lanAccessCode": "secret"},
		},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if _, _, parseErr := parseBambuH2DConfiguration(test.settings, test.secrets); parseErr == nil {
				t.Fatal("expected validation failure")
			}
		})
	}
}

func TestBambuX1CAdapterUsesSharedLANContract(t *testing.T) {
	t.Parallel()
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	adapter, err := NewBambuX1C(ids.New(), 1, bambuX1CSchemaVersion,
		map[string]any{"ipAddress": "192.168.1.43", "serialNumber": " 00m00a123456789 ", "autoDetectSpools": true},
		map[string]string{"lanAccessCode": "secret"}, store)
	if err != nil {
		t.Fatal(err)
	}
	if got := adapter.Descriptor(); got.Kind != AdapterBambuX1C || got.SchemaVersion != 1 {
		t.Fatalf("descriptor = %+v", got)
	}
}

func TestBambuX1CReducerRetainsGlobalAMSTrayHistory(t *testing.T) {
	t.Parallel()
	processor := &bambuProcessor{adapterKind: AdapterBambuX1C, state: bambuPersistedState{
		Document:        map[string]any{},
		Sessions:        map[string]string{},
		LastSlots:       map[string]string{},
		EmptySlotCounts: map[string]uint8{},
		ActiveErrors:    map[string]bool{},
		RunFacts:        map[string]bambuRunFacts{},
	}, firstSnapshot: true}
	at := time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)
	initial := []byte(
		`{"print":{"gcode_state":"RUNNING","task_id":"6380","subtask_name":"Two colour part","ams":{"tray_now":"255","ams":[{"id":"0","tray":[{"id":"0","tag_uid":"0000000000000000","tray_type":"PLA"},{"id":"2","tag_uid":"WHITE","tray_type":"PLA"}]}]},"vir_slot":[{"id":"255","tag_uid":"0000000000000000","tray_type":"TPU"}]}}`,
	)
	if _, _, err := processor.apply(context.Background(), initial, at); err != nil {
		t.Fatal(err)
	}
	first := []byte(
		`{"print":{"ams":{"tray_now":"2","ams":[{"id":"0","tray":[{"id":"0","tag_uid":"0000000000000000","tray_type":"PLA"},{"id":"2","tag_uid":"WHITE","tray_type":"PLA"}]}]}}}`,
	)
	if _, _, err := processor.apply(context.Background(), first, at.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if processor.state.LastTray != "2" {
		t.Fatalf("initial tray = %q", processor.state.LastTray)
	}
	second := []byte(
		`{"print":{"ams":{"tray_now":"0","ams":[{"id":"0","tray":[{"id":"0","tray_type":"PLA"},{"id":"2","tag_uid":"WHITE","tray_type":"PLA"}]}]}}}`,
	)
	observations, _, err := processor.apply(context.Background(), second, at.Add(2*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	assertKinds(t, observations, "filament_change")
	runID, _ := processor.currentRun()
	if runID == nil {
		t.Fatal("X1C run ID not allocated")
	}
	facts := processor.state.RunFacts[runID.String()]
	if len(facts.SpoolEvidence) != 2 || facts.SpoolEvidence[0].Extruder != 1 ||
		facts.SpoolEvidence[0].SlotExternalID != "2" ||
		facts.SpoolEvidence[1].SlotExternalID != "0" ||
		facts.SpoolEvidence[1].TagUID != "" {
		t.Fatalf("spool evidence = %+v", facts.SpoolEvidence)
	}
}

func TestBambuX1CReducerUsesExplicitSlicerFilamentMapping(t *testing.T) {
	t.Parallel()
	processor := &bambuProcessor{adapterKind: AdapterBambuX1C, state: bambuPersistedState{
		Document:        map[string]any{},
		Sessions:        map[string]string{},
		LastSlots:       map[string]string{},
		EmptySlotCounts: map[string]uint8{},
		ActiveErrors:    map[string]bool{},
		RunFacts:        map[string]bambuRunFacts{},
	}, firstSnapshot: true}
	payload := []byte(
		`{"print":{"gcode_state":"RUNNING","task_id":"6380","ams_mapping":[0,-1,2,-1,-1],"ams_mapping2":[{"ams_id":0,"slot_id":0},{"ams_id":255,"slot_id":255},{"ams_id":0,"slot_id":2},{"ams_id":255,"slot_id":255},{"ams_id":255,"slot_id":255}],"ams":{"tray_now":"0","ams":[{"id":"0","tray":[{"id":"0","tray_type":"PLA","tray_color":"00FF00FF"},{"id":"2","tag_uid":"WHITE","tray_type":"PLA","tray_color":"FFFFFFFF"}]}]}}}`,
	)
	if _, _, err := processor.apply(context.Background(), payload, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	runID, _ := processor.currentRun()
	if runID == nil {
		t.Fatal("X1C run ID not allocated")
	}
	facts := processor.state.RunFacts[runID.String()]
	if len(facts.SpoolEvidence) != 2 ||
		facts.SpoolEvidence[0].SlicerFilamentID != "1" || facts.SpoolEvidence[0].SlotExternalID != "0" ||
		facts.SpoolEvidence[1].SlicerFilamentID != "3" || facts.SpoolEvidence[1].SlotExternalID != "2" || facts.SpoolEvidence[1].TagUID != "WHITE" {
		t.Fatalf("explicit X1C material routes = %+v", facts.SpoolEvidence)
	}
}

func TestBambuX1CRejectsAmbiguousExternalHolderSentinel(t *testing.T) {
	t.Parallel()
	state := decodeDocument(
		t,
		`{"ams":{"tray_now":"255"},"vir_slot":[{"id":"255","tray_type":"TPU","tag_uid":"0000000000000000"}]}`,
	)
	if _, _, _, ok := bambuX1CActiveSlot(state); ok {
		t.Fatal("ambiguous X1C holder 255 was treated as selected")
	}
}

func TestBambuTLSConfigSharesSessionsWithFTPSDataChannels(t *testing.T) {
	t.Parallel()
	config, err := bambuTLSConfig("01P09A123456789")
	if err != nil {
		t.Fatal(err)
	}
	if config.ServerName != "01P09A123456789" {
		t.Fatalf("TLS session identity = %q", config.ServerName)
	}
	if config.ClientSessionCache == nil || config.Clone().ClientSessionCache != config.ClientSessionCache {
		t.Fatal("Bambu TLS clones do not share a client session cache")
	}
}

func TestClassifyArtifactErrorsBeforeTransport(t *testing.T) {
	t.Parallel()
	for message, want := range map[string]string{
		"ambiguous artifact candidates over FTPS":   "artifact_ambiguous",
		"artifact not available over FTPS":          "artifact_not_available",
		"artifact transfer queue is full":           "artifact_backlog_full",
		"authenticate Bambu FTPS: password denied":  "ftps_authentication_failed",
		"FTPS connection failed":                    "ftps_unavailable",
		"connect to Bambu FTPS: connection refused": "ftps_control_connect_failed",
		"connect Bambu FTPS data channel: timeout":  "ftps_data_connect_failed",
		"enter Bambu FTPS passive mode: rejected":   "ftps_passive_failed",
		"parse Bambu FTPS listing: unsupported":     "ftps_listing_failed",
	} {
		if got := classifyAdapterError(errors.New(message)); got != want {
			t.Errorf("classifyAdapterError(%q) = %q, want %q", message, got, want)
		}
	}
}

func TestBambuReconnectDelayStaysInsideReviewedEnvelope(t *testing.T) {
	for range 100 {
		if got := bambuReconnectDelay(time.Second); got < time.Second || got > 1250*time.Millisecond {
			t.Fatalf("one-second delay %s is outside the reviewed jitter envelope", got)
		}
		if got := bambuReconnectDelay(time.Minute); got < 45*time.Second || got > time.Minute {
			t.Fatalf("one-minute delay %s is outside the reviewed jitter envelope", got)
		}
	}
}

func TestSessionKeyDoesNotTrustUnverifiedLocalTaskID(t *testing.T) {
	t.Parallel()
	state := map[string]any{"local_task_id": "local-7", "task_id": "42", "subtask_id": "3"}
	if got := bambuSessionKey(state); got != "tuple:task_id=42,subtask_id=3" {
		t.Fatalf("session key = %q", got)
	}
	if got := bambuSessionKey(map[string]any{"local_task_id": "local-only"}); got != "" {
		t.Fatalf("unverified local task ID became a session key: %q", got)
	}
}

func TestBareActiveTrayIsNotAppliedAcrossMultipleAMSUnits(t *testing.T) {
	t.Parallel()
	processor := &bambuProcessor{
		state: bambuPersistedState{
			Document:     map[string]any{},
			Sessions:     map[string]string{},
			LastSlots:    map[string]string{},
			ActiveErrors: map[string]bool{},
			RunFacts:     map[string]bambuRunFacts{},
		},
		firstSnapshot: true,
	}
	payload := []byte(
		`{"print":{"gcode_state":"RUNNING","task_id":"5","ams":{"tray_now":"0","ams":[{"id":"0","tray":[{"id":"0","tag_uid":"TAG-A"}]},{"id":"1","tray":[{"id":"0","tag_uid":"TAG-B"}]}]}}}`,
	)
	observations, _, err := processor.apply(context.Background(), payload, time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	slots := 0
	for _, observation := range observations {
		if observation.Kind != "slot_observation" {
			continue
		}
		slots++
		var slot map[string]any
		if err = json.Unmarshal(observation.Payload, &slot); err != nil {
			t.Fatal(err)
		}
		if _, exists := slot["active"]; exists {
			t.Fatalf("ambiguous bare tray was marked active: %s", observation.Payload)
		}
	}
	if slots != 2 {
		t.Fatalf("slot observations = %d, want 2", slots)
	}
	for _, facts := range processor.state.RunFacts {
		if facts.InputUnitExternalID != "" || facts.SlotExternalID != "" || facts.TagUID != "" {
			t.Fatalf("ambiguous tray was retained as consumption evidence: %#v", facts)
		}
	}
}

func TestNoTraySentinelDoesNotEraseRunSpoolEvidence(t *testing.T) {
	t.Parallel()
	processor := &bambuProcessor{state: bambuPersistedState{
		Document:        map[string]any{},
		Sessions:        map[string]string{},
		LastSlots:       map[string]string{},
		EmptySlotCounts: map[string]uint8{},
		ActiveErrors:    map[string]bool{},
		RunFacts:        map[string]bambuRunFacts{},
	}, firstSnapshot: true}
	at := time.Date(2026, 10, 15, 12, 43, 0, 0, time.UTC)
	active := []byte(
		`{"print":{"gcode_state":"RUNNING","task_id":"5","device":{"extruder":{"state":256,"info":[{"id":0,"snow":65535,"info":0},{"id":1,"snow":32768,"info":2}]}},"ams":{"tray_now":"255","ams":[{"id":"128","tray":[{"id":"0","tag_uid":"A1B2C3D4E5F60708"}]}]},"vir_slot":[{"id":"254"},{"id":"255","tag_uid":"0000000000000000"}]}}`,
	)
	if _, _, err := processor.apply(context.Background(), active, at); err != nil {
		t.Fatal(err)
	}
	runID := processor.state.CurrentRunID
	before := processor.state.RunFacts[runID]
	if before.InputUnitExternalID != "128" || before.SlotExternalID != "0" || before.TagUID != "A1B2C3D4E5F60708" {
		t.Fatalf("initial spool evidence = %#v", before)
	}

	// H2D reports an empty hotend route and ambiguous tray_now 255 while
	// unloading after cancellation, so the last trustworthy evidence remains.
	if _, _, err := processor.apply(
		context.Background(),
		[]byte(`{"print":{"device":{"extruder":{"state":256,"info":[{"id":0,"snow":65535,"info":0},{"id":1,"snow":65535,"info":0}]}},"ams":{"tray_now":"255"}}}`),
		at.Add(10*time.Minute),
	); err != nil {
		t.Fatal(err)
	}
	after := processor.state.RunFacts[runID]
	if after.InputUnitExternalID != "128" || after.SlotExternalID != "0" || after.TagUID != "A1B2C3D4E5F60708" {
		t.Fatalf("no-tray sentinel erased spool evidence: before=%#v after=%#v", before, after)
	}
}

func TestInactiveExtruderDoesNotReplaceRunSpoolEvidence(t *testing.T) {
	t.Parallel()
	processor := &bambuProcessor{state: bambuPersistedState{
		Document:        map[string]any{},
		Sessions:        map[string]string{},
		LastSlots:       map[string]string{},
		EmptySlotCounts: map[string]uint8{},
		ActiveErrors:    map[string]bool{},
		RunFacts:        map[string]bambuRunFacts{},
	}, firstSnapshot: true}
	at := time.Date(2026, 10, 15, 14, 36, 0, 0, time.UTC)
	active := []byte(
		`{"print":{"gcode_state":"RUNNING","task_id":"9565","device":{"extruder":{"state":256,"info":[{"id":0,"snow":65280,"info":2},{"id":1,"snow":32768,"info":2}]}},"ams":{"tray_now":"255","ams":[{"id":"128","tray":[{"id":"0","tag_uid":"A1B2C3D4E5F60708"}]}]},"vir_slot":[{"id":"254"},{"id":"255","tag_uid":"0000000000000000"}]}}`,
	)
	if _, _, err := processor.apply(context.Background(), active, at); err != nil {
		t.Fatal(err)
	}
	runID := processor.state.CurrentRunID
	before := processor.state.RunFacts[runID]
	if before.InputUnitExternalID != "128" || before.SlotExternalID != "0" || before.TagUID != "A1B2C3D4E5F60708" {
		t.Fatalf("initial spool evidence = %#v", before)
	}

	// The active left hotend becomes empty while unloading, but the inactive
	// right hotend still advertises its external holder. It must not win.
	unloading := []byte(
		`{"print":{"device":{"extruder":{"state":256,"info":[{"id":0,"snow":65280,"info":2},{"id":1,"snow":65279,"info":2}]}}}}`,
	)
	if _, _, err := processor.apply(context.Background(), unloading, at.Add(15*time.Minute)); err != nil {
		t.Fatal(err)
	}
	after := processor.state.RunFacts[runID]
	if after.InputUnitExternalID != "128" || after.SlotExternalID != "0" || after.TagUID != "A1B2C3D4E5F60708" {
		t.Fatalf("inactive hotend replaced spool evidence: before=%#v after=%#v", before, after)
	}
}

func TestEnablingAutoDetectionReplaysStableSlotIdentitiesOnce(t *testing.T) {
	t.Parallel()
	processor := &bambuProcessor{state: bambuPersistedState{LastSlots: map[string]string{"128:0": "already-observed"}}}
	processor.configureAutoDetectSpools(true)
	if len(processor.state.LastSlots) != 0 || !processor.state.AutoDetectSpools {
		t.Fatalf("enabling auto detection did not schedule a slot replay: %#v", processor.state)
	}
	processor.state.LastSlots["128:0"] = "replayed"
	processor.configureAutoDetectSpools(true)
	if processor.state.LastSlots["128:0"] != "replayed" {
		t.Fatal("unchanged auto-detection setting repeatedly cleared slot deduplication")
	}
}

func TestBambuReducerRequiresRepeatedEmptyTrayBeforeUnassignment(t *testing.T) {
	t.Parallel()
	processor := &bambuProcessor{
		state: bambuPersistedState{
			Document:        map[string]any{},
			Sessions:        map[string]string{},
			LastSlots:       map[string]string{},
			EmptySlotCounts: map[string]uint8{},
			ActiveErrors:    map[string]bool{},
			RunFacts:        map[string]bambuRunFacts{},
		},
		firstSnapshot: true,
	}
	at := time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)
	occupied := []byte(
		`{"print":{"gcode_state":"RUNNING","task_id":"5","ams":{"ams":[{"id":"128","tray":[{"id":"0","tag_uid":"RFID-1","tray_type":"PLA"}]}]}}}`,
	)
	observations, _, err := processor.apply(context.Background(), occupied, at)
	if err != nil {
		t.Fatal(err)
	}
	assertKinds(t, observations, "operational_state", "progress", "slot_observation")

	empty := []byte(`{"print":{"ams":{"ams":[{"id":"128","tray":[{"id":"0"}]}]}}}`)
	observations, _, err = processor.apply(context.Background(), empty, at.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	for _, observation := range observations {
		if observation.Kind == "slot_observation" {
			t.Fatalf("first missing RFID report unmounted a spool: %s", observation.Payload)
		}
	}
	observations, _, err = processor.apply(context.Background(), empty, at.Add(2*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	assertKinds(t, observations, "slot_observation")
	var payload map[string]any
	if err = json.Unmarshal(observations[0].Payload, &payload); err != nil || payload["empty"] != true ||
		payload["tagUid"] != nil {
		t.Fatalf("confirmed empty payload = %s, err=%v", observations[0].Payload, err)
	}
}

func TestMergeBambuObjectRecursivelyMergesAndReplacesArrays(t *testing.T) {
	t.Parallel()
	current := map[string]any{
		"print": map[string]any{"state": "RUNNING", "progress": json.Number("10"), "keep": true},
		"ams":   []any{1, 2},
		"clear": "value",
	}
	patch := map[string]any{"print": map[string]any{"progress": json.Number("20")}, "ams": []any{3}, "clear": nil}
	merged, err := mergeBambuObject(current, patch, 0)
	if err != nil {
		t.Fatal(err)
	}
	printState := objectAt(merged, "print")
	if stringAt(printState, "state") != "RUNNING" || stringAt(printState, "progress") != "20" ||
		printState["keep"] != true {
		t.Fatalf("nested merge lost state: %#v", merged)
	}
	if values, _ := merged["ams"].([]any); len(values) != 1 || scalarString(values[0]) != "3" {
		t.Fatalf("array was not replaced: %#v", merged["ams"])
	}
	if _, exists := merged["clear"]; exists {
		t.Fatal("JSON null did not clear the field")
	}
}

func TestBambuReducerLifecycleSlotsErrorsAndPersistence(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	dir := t.TempDir()
	store, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	assignmentID := ids.New()
	processor, err := newBambuProcessor(ctx, assignmentID, store)
	if err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)
	initial := []byte(
		`{"print":{"gcode_state":"RUNNING","task_id":"23","subtask_id":"7","subtask_name":"Customer project","gcode_file":"/cache/generated-name.3mf","mc_percent":12,"mc_remaining_time":8,"layer_num":3,"total_layer_num":20,"print_error":134184963,"ams":{"ams":[{"id":"0","tray":[{"id":"1","tag_uid":"ABC","tray_uuid":"observed-only","tray_type":"PLA","tray_color":"FF0000FF","tray_weight":"1000","remain":"80"}]}]},"tray_now":"0:1"}}`,
	)
	observations, ready, err := processor.apply(ctx, initial, at)
	if err != nil || !ready {
		t.Fatalf("initial reducer application failed: ready=%v err=%v", ready, err)
	}
	assertKinds(t, observations, "operational_state", "progress", "printer_error", "slot_observation")
	var runID uuid.UUID
	for _, observation := range observations {
		if observation.RunID != nil {
			runID = *observation.RunID
			if observation.HistoryComplete {
				t.Fatal("first observation of an already active print must have incomplete history")
			}
		}
		if observation.Kind == "printer_error" {
			var payload map[string]any
			if json.Unmarshal(observation.Payload, &payload) != nil || payload["transition"] != "appeared" ||
				payload["code"] != "134184963" {
				t.Fatalf("unexpected printer error payload: %s", observation.Payload)
			}
		}
		if observation.Kind == "operational_state" || observation.Kind == "progress" {
			var payload map[string]any
			if json.Unmarshal(observation.Payload, &payload) != nil || payload["fileName"] != "Customer project" ||
				payload["artifactPath"] != "/cache/generated-name.3mf" {
				t.Fatalf("run name and artifact path were conflated: %s", observation.Payload)
			}
		}
		if observation.Kind == "slot_observation" {
			if observation.RunID != nil {
				t.Fatal("assignment-level slot observation was attached to a run")
			}
			var payload map[string]any
			if json.Unmarshal(observation.Payload, &payload) != nil || payload["inputUnitExternalId"] != "0" ||
				payload["slotExternalId"] != "1" ||
				payload["externalSlotKey"] != "0:1" {
				t.Fatalf("unexpected normalized slot payload: %s", observation.Payload)
			}
			if _, exists := payload["remainPercent"]; exists {
				t.Fatalf("volatile remaining percentage leaked into the slot transition: %s", observation.Payload)
			}
		}
	}
	if runID == uuid.Nil {
		t.Fatal("active print did not receive a run ID")
	}
	facts := processor.state.RunFacts[runID.String()]
	if facts.InputUnitExternalID != "0" || facts.SlotExternalID != "1" || facts.TagUID != "ABC" {
		t.Fatalf("active slot was not retained for terminal consumption: %#v", facts)
	}
	volatile, _, err := processor.apply(
		ctx,
		[]byte(`{"print":{"nozzle_temper":"220","nozzle_target_temper":"230","mc_print_stage":"5"}}`),
		at.Add(time.Second),
	)
	if err != nil {
		t.Fatal(err)
	}
	for _, observation := range volatile {
		if observation.Kind == "slot_observation" {
			t.Fatalf("volatile printer telemetry emitted another slot observation: %#v", volatile)
		}
	}
	if err = processor.persist(ctx); err != nil {
		t.Fatal(err)
	}

	restarted, err := newBambuProcessor(ctx, assignmentID, store)
	if err != nil {
		t.Fatal(err)
	}
	partial := []byte(`{"print":{"gcode_state":"PAUSE","mc_percent":13,"print_error":0,"hms":[]}}`)
	observations, _, err = restarted.apply(ctx, partial, at.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	assertKinds(t, observations, "operational_state", "progress", "printer_error")
	for _, observation := range observations {
		if observation.RunID == nil || *observation.RunID != runID {
			t.Fatalf("run ID changed across restart: %#v", observation.RunID)
		}
		if !observation.HistoryComplete {
			t.Fatal("persisted active run should resume with complete known connector history")
		}
		if observation.Kind == "printer_error" &&
			!bytes.Contains(observation.Payload, []byte(`"transition":"cleared"`)) {
			t.Fatalf("error clear transition was not normalized: %s", observation.Payload)
		}
	}

	observations, _, err = restarted.apply(ctx, partial, at.Add(2*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if len(observations) != 0 {
		t.Fatalf("unchanged partial state emitted duplicates: %#v", observations)
	}
	finished := []byte(`{"print":{"gcode_state":"FINISH","mc_percent":100}}`)
	observations, _, err = restarted.apply(ctx, finished, at.Add(3*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	assertKinds(t, observations, "terminal_outcome")
}

func TestBambuDisconnectTimeoutEndsPersistedRunAsUnknown(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	assignmentID := ids.New()
	processor, err := newBambuProcessor(ctx, assignmentID, store)
	if err != nil {
		t.Fatal(err)
	}
	startedAt := time.Date(2026, 10, 15, 8, 0, 0, 0, time.UTC)
	active := []byte(
		`{"print":{"gcode_state":"RUNNING","task_id":"42","subtask_name":"Gearbox housing","gcode_file":"/cache/plate_1.gcode","mc_percent":30}}`,
	)
	observations, _, err := processor.apply(ctx, active, startedAt)
	if err != nil || len(observations) == 0 {
		t.Fatalf("active run was not established: observations=%#v err=%v", observations, err)
	}
	runID, _ := processor.currentRun()
	if runID == nil || !processor.noteDisconnected(startedAt.Add(time.Minute)) {
		t.Fatal("active run did not record its first disconnect")
	}
	if got := processor.expireDisconnectedRun(startedAt.Add(time.Minute).Add(bambuDisconnectGracePeriod - time.Second)); len(
		got,
	) != 0 {
		t.Fatalf("run ended before the disconnect grace period: %#v", got)
	}
	if err = processor.persist(ctx); err != nil {
		t.Fatal(err)
	}

	restarted, err := newBambuProcessor(ctx, assignmentID, store)
	if err != nil {
		t.Fatal(err)
	}
	deadline := startedAt.Add(time.Minute).Add(bambuDisconnectGracePeriod)
	observations = restarted.expireDisconnectedRun(deadline.Add(time.Second))
	assertKinds(t, observations, "terminal_outcome")
	if observations[0].RunID == nil || *observations[0].RunID != *runID ||
		!bytes.Contains(observations[0].Payload, []byte(`"outcome":"unknown"`)) ||
		!bytes.Contains(observations[0].Payload, []byte(`"reason":"connection_timeout"`)) {
		t.Fatalf("unexpected timeout observation: %#v", observations[0])
	}
	if !restarted.state.RunTimedOut || restarted.state.DisconnectedAt != nil || restarted.state.Lifecycle != "UNKNOWN" {
		t.Fatalf("timeout state was not checkpointed in memory: %#v", restarted.state)
	}
	if repeated := restarted.expireDisconnectedRun(deadline.Add(time.Hour)); len(repeated) != 0 {
		t.Fatalf("timeout emitted more than once: %#v", repeated)
	}
	if err = restarted.persist(ctx); err != nil {
		t.Fatal(err)
	}

	reloaded, err := newBambuProcessor(ctx, assignmentID, store)
	if err != nil {
		t.Fatal(err)
	}
	if !reloaded.state.RunTimedOut {
		t.Fatal("timed-out session did not survive connector restart")
	}
	observations, _, err = reloaded.apply(ctx, active, deadline.Add(2*time.Minute))
	if err != nil || len(observations) != 0 {
		t.Fatalf("late active snapshot reopened a timed-out run: observations=%#v err=%v", observations, err)
	}
	observations, _, err = reloaded.apply(
		ctx,
		[]byte(`{"print":{"gcode_state":"FINISH","task_id":"42","mc_percent":100}}`),
		deadline.Add(3*time.Minute),
	)
	if err != nil {
		t.Fatal(err)
	}
	assertKinds(t, observations, "terminal_outcome")
	if !bytes.Contains(observations[0].Payload, []byte(`"outcome":"completed"`)) {
		t.Fatalf("trustworthy terminal state did not refine the timeout: %s", observations[0].Payload)
	}
}

func TestBambuNewPrintAfterConnectorDowntimeEndsPreviousRun(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	assignmentID := ids.New()
	processor, err := newBambuProcessor(ctx, assignmentID, store)
	if err != nil {
		t.Fatal(err)
	}
	startedAt := time.Date(2026, 10, 20, 17, 43, 0, 0, time.UTC)
	if _, _, err = processor.apply(
		ctx,
		[]byte(`{"print":{"gcode_state":"RUNNING","task_id":"41","mc_percent":77}}`),
		startedAt,
	); err != nil {
		t.Fatal(err)
	}
	previousRunID, _ := processor.currentRun()
	if previousRunID == nil {
		t.Fatal("first print did not open a run")
	}
	// The connector stops without observing a disconnect, the first print ends
	// unobserved, and the printer reports the next print after the restart.
	if err = processor.persist(ctx); err != nil {
		t.Fatal(err)
	}
	restarted, err := newBambuProcessor(ctx, assignmentID, store)
	if err != nil {
		t.Fatal(err)
	}
	observations, _, err := restarted.apply(
		ctx,
		[]byte(`{"print":{"gcode_state":"RUNNING","task_id":"42","mc_percent":5}}`),
		startedAt.Add(24*time.Minute),
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(observations) == 0 || observations[0].Kind != ObservationTerminalOutcome ||
		observations[0].RunID == nil || *observations[0].RunID != *previousRunID ||
		!bytes.Contains(observations[0].Payload, []byte(`"outcome":"unknown"`)) ||
		!bytes.Contains(observations[0].Payload, []byte(`"reason":"superseded"`)) {
		t.Fatalf("previous run was not ended: %#v", observations)
	}
	nextRunID, _ := restarted.currentRun()
	if nextRunID == nil || *nextRunID == *previousRunID {
		t.Fatal("next print did not open its own run")
	}
	for _, observation := range observations[1:] {
		if observation.RunID == nil || *observation.RunID != *nextRunID {
			t.Fatalf("observation attributed to the wrong run: %#v", observation)
		}
	}
}

func TestBambuReconnectBeforeTimeoutKeepsRunActive(t *testing.T) {
	t.Parallel()
	runID := ids.New()
	disconnectedAt := time.Date(2026, 10, 15, 8, 0, 0, 0, time.UTC)
	processor := &bambuProcessor{state: bambuPersistedState{
		Lifecycle:      "RUNNING",
		CurrentRunID:   runID.String(),
		DisconnectedAt: &disconnectedAt,
	}}
	if !processor.noteConnected() || processor.state.DisconnectedAt != nil {
		t.Fatal("reconnection did not clear the pending disconnect timeout")
	}
	if observations := processor.expireDisconnectedRun(disconnectedAt.Add(time.Hour)); len(observations) != 0 {
		t.Fatalf("reconnected run was ended: %#v", observations)
	}
}

func TestArtifactRetrievalUsesArchivePathNotProjectName(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	assignmentID, runID := ids.New(), ids.New()
	adapter := &bambuH2DAdapter{assignmentID: assignmentID, configurationVersion: 2, store: store}
	observation := Observation{
		Kind:    "progress",
		RunID:   &runID,
		Payload: mustJSON(map[string]any{"fileName": "Customer project", "artifactPath": "/cache/generated-name.3mf"}),
	}
	if err = adapter.scheduleArtifactRetrievals(ctx, []Observation{observation}, nil); err != nil {
		t.Fatal(err)
	}
	retrieval, err := store.PendingArtifactRetrieval(ctx, assignmentID)
	if err != nil || retrieval == nil || retrieval.ReportedPath != "/cache/generated-name.3mf" {
		t.Fatalf("artifact retrieval used the display name: retrieval=%#v err=%v", retrieval, err)
	}
}

func TestInternalGCodePathIsNotScheduledAsAnArtifact(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	assignmentID := ids.New()
	runID := ids.New()
	adapter := &bambuH2DAdapter{assignmentID: assignmentID, configurationVersion: 1, store: store}
	observation := Observation{
		Kind:  "progress",
		RunID: &runID,
		Payload: mustJSON(map[string]any{
			"fileName":     "Customer project",
			"artifactPath": "/data/Metadata/plate_1.gcode",
		}),
	}
	if err = adapter.scheduleArtifactRetrievals(ctx, []Observation{observation}, nil); err != nil {
		t.Fatal(err)
	}
	if retrieval, pendingErr := store.PendingArtifactRetrieval(ctx, assignmentID); pendingErr != nil ||
		retrieval != nil {
		t.Fatalf("internal G-code path was scheduled as an archive: %#v %v", retrieval, pendingErr)
	}

	if got := bambuArtifactPath(map[string]any{
		"gcode_file":   "/data/Metadata/plate_1.gcode",
		"subtask_name": "FlipOff_Ghostie.stl",
	}); got != "FlipOff_Ghostie.stl.gcode.3mf" {
		t.Fatalf("print name did not become the exact archive candidate: %q", got)
	}
	if got := bambuArtifactPath(map[string]any{
		"file":       "/cache/source.gcode.3mf",
		"gcode_file": "/data/Metadata/plate_1.gcode",
	}); got != "/cache/source.gcode.3mf" {
		t.Fatalf("reported archive candidate = %q", got)
	}
	if got := bambuArtifactPath(map[string]any{
		"gcode_file":   "/data/Metadata/plate_1.gcode",
		"subtask_name": "unsafe/name",
	}); got != "" {
		t.Fatalf("unsafe print name became an archive candidate: %q", got)
	}

	// A persisted retry from an older connector build is quarantined locally
	// before any network connection is attempted.
	if err = store.ScheduleArtifactRetrieval(
		ctx,
		assignmentID,
		runID,
		1,
		"/data/Metadata/plate_1.gcode",
		time.Now().UTC().Add(time.Hour),
	); err != nil {
		t.Fatal(err)
	}
	if _, err = store.db.ExecContext(
		ctx,
		`UPDATE artifact_retrievals SET next_attempt_at=? WHERE assignment_id=? AND run_id=?`,
		time.Now().UTC().Add(time.Hour).Format(time.RFC3339Nano),
		assignmentID.String(),
		runID.String(),
	); err != nil {
		t.Fatal(err)
	}
	if completed, cleanupErr := adapter.retrieveOneArtifact(ctx); cleanupErr != nil || !completed {
		t.Fatalf("legacy invalid retrieval was not completed locally: %v %v", completed, cleanupErr)
	}
	var state, reason string
	if err = store.db.QueryRowContext(
		ctx,
		`SELECT state,reason_code FROM artifact_retrievals WHERE assignment_id=? AND run_id=?`,
		assignmentID.String(),
		runID.String(),
	).Scan(&state, &reason); err != nil {
		t.Fatal(err)
	}
	if state != "quarantined" || reason != "artifact_candidate_not_archive" {
		t.Fatalf("legacy invalid retrieval state = %q %q", state, reason)
	}
}

func TestBambuReducerIgnoresRetainedTerminalAtStartup(t *testing.T) {
	t.Parallel()
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	processor, err := newBambuProcessor(context.Background(), ids.New(), store)
	if err != nil {
		t.Fatal(err)
	}
	observations, ready, err := processor.apply(
		context.Background(),
		[]byte(`{"print":{"gcode_state":"FINISH","task_id":"old","mc_percent":100}}`),
		time.Now().UTC(),
	)
	if err != nil || !ready || len(observations) != 0 {
		t.Fatalf("retained terminal created observations: ready=%v observations=%#v err=%v", ready, observations, err)
	}
}

func TestBambuReducerDoesNotClaimCompleteHistoryForPrintStartedWhileOffline(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	assignmentID := ids.New()
	processor, err := newBambuProcessor(ctx, assignmentID, store)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = processor.apply(
		ctx,
		[]byte(`{"print":{"gcode_state":"FINISH","task_id":"old"}}`),
		time.Now().UTC(),
	); err != nil {
		t.Fatal(err)
	}
	if err = processor.persist(ctx); err != nil {
		t.Fatal(err)
	}
	restarted, err := newBambuProcessor(ctx, assignmentID, store)
	if err != nil {
		t.Fatal(err)
	}
	observations, _, err := restarted.apply(
		ctx,
		[]byte(`{"print":{"gcode_state":"RUNNING","task_id":"new","mc_percent":50}}`),
		time.Now().UTC().Add(time.Hour),
	)
	if err != nil || len(observations) == 0 {
		t.Fatalf("new active print was not observed: %#v %v", observations, err)
	}
	for _, observation := range observations {
		if observation.HistoryComplete {
			t.Fatal("print first seen active after downtime must have incomplete history")
		}
	}
}

func TestFTPParsers(t *testing.T) {
	t.Parallel()
	port, err := parsePassivePort("227 Entering Passive Mode (10,0,0,1,195,44)")
	if err != nil || port != 49964 {
		t.Fatalf("unexpected passive port: %d %v", port, err)
	}
	entries, err := parseFTPList(
		[]byte(
			"-rw-r--r-- 1 user group 123 Oct 14 12:00 part one.3mf\r\ndrwxr-xr-x 2 user group 0 Oct 14 12:00 folder\r\n",
		),
	)
	if err != nil || len(entries) != 2 || entries[0].Name != "part one.3mf" || entries[0].Size != 123 ||
		!entries[1].IsDir {
		t.Fatalf("unexpected listing: %#v %v", entries, err)
	}
	if _, err = parseFTPList([]byte("unsupported")); err == nil {
		t.Fatal("expected malformed listing to fail")
	}
}

func TestArtifactCandidateSelectionIsExactAndRequiresStableSize(t *testing.T) {
	t.Parallel()
	listings := map[string][]FTPEntry{
		"/cache": {{Name: "part.3mf", Size: 120}},
		"/":      {{Name: "part.3mf", Size: 120}, {Name: "part-copy.3mf", Size: 130}},
	}
	candidate, err := SelectArtifactCandidate("/cache/part.3mf", listings)
	if err != nil || candidate.RemotePath != "/cache/part.3mf" {
		t.Fatalf("exact path was not preferred: %#v %v", candidate, err)
	}
	if _, err = SelectArtifactCandidate("part.3mf", listings); err == nil ||
		!strings.Contains(err.Error(), "ambiguous") {
		t.Fatalf("ambiguous basename was accepted: %v", err)
	}
	if _, err = SelectArtifactCandidate("missing.3mf", listings); err == nil {
		t.Fatal("missing artifact was accepted")
	}
	tracker := ArtifactCandidateTracker{}
	if tracker.Observe(candidate) || !tracker.Observe(candidate) {
		t.Fatal("candidate must have the same positive size in two consecutive listings")
	}
	candidate.Size++
	if tracker.Observe(candidate) {
		t.Fatal("changed size was considered stable")
	}
}

func TestArtifactDirectoryListingsKeepUsableRootWhenCacheFails(t *testing.T) {
	t.Parallel()
	var visited []string
	listings, err := listBambuArtifactDirectories(
		context.Background(),
		func(_ context.Context, directory string) ([]FTPEntry, error) {
			visited = append(visited, directory)
			if directory == "/cache" {
				return nil, errors.New("finish Bambu FTPS transfer: cache unavailable")
			}
			return []FTPEntry{{Name: "FlipOff_Ghostie.stl.gcode.3mf", Size: 123}}, nil
		},
	)
	if !slices.Equal(visited, []string{"/", "/cache"}) {
		t.Fatalf("listing order = %#v", visited)
	}
	if err == nil {
		t.Fatal("partial listing failure was not retained")
	}
	candidate, selectErr := SelectArtifactCandidate("FlipOff_Ghostie.stl.gcode.3mf", listings)
	if selectErr != nil || candidate.RemotePath != "/FlipOff_Ghostie.stl.gcode.3mf" {
		t.Fatalf("root candidate = %#v, err=%v", candidate, selectErr)
	}
}

func TestArtifactTransferQueueStagesValidZIPAndDeletesOnlyOnCompletion(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	archive := syntheticZIP(t, "3D/3dmodel.model", "model")
	transfer, err := store.StageArtifact(
		ctx,
		ids.New(),
		ids.New(),
		2,
		"/cache/part.3mf",
		"part.3mf",
		bytes.NewReader(archive),
		time.Now().UTC().Add(time.Hour),
	)
	if err != nil {
		t.Fatal(err)
	}
	if info, statErr := os.Stat(transfer.StagedPath); statErr != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("staged file is absent or not private: %#v %v", info, statErr)
	}
	pending, err := store.PendingArtifactTransfers(ctx, 20)
	if err != nil || len(pending) != 1 || pending[0].SHA256 != transfer.SHA256 {
		t.Fatalf("unexpected pending transfers: %#v %v", pending, err)
	}
	if err = store.CompleteArtifactTransfer(ctx, transfer.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(transfer.StagedPath); !os.IsNotExist(err) {
		t.Fatalf("acknowledged staged file was not removed: %v", err)
	}
	unsafe := syntheticZIP(t, "../escape", "bad")
	if _, err = store.StageArtifact(
		ctx,
		ids.New(),
		ids.New(),
		1,
		"/bad.3mf",
		"bad.3mf",
		bytes.NewReader(unsafe),
		time.Now().UTC().Add(time.Hour),
	); err == nil ||
		!strings.Contains(err.Error(), "unsafe") {
		t.Fatalf("unsafe ZIP was accepted: %v", err)
	}
}

func TestClientUploadsQueuedArtifactWithIntegrityHeaders(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	assignmentID, runID := ids.New(), ids.New()
	archive := syntheticZIP(t, "3D/3dmodel.model", "model")
	transfer, err := store.StageArtifact(
		ctx,
		assignmentID,
		runID,
		7,
		"/cache/part.3mf",
		"part.3mf",
		bytes.NewReader(archive),
		time.Now().UTC().Add(time.Hour),
	)
	if err != nil {
		t.Fatal(err)
	}
	client, err := NewClient("http://core.test", true)
	if err != nil {
		t.Fatal(err)
	}
	client.http.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.Method != http.MethodPut ||
			request.URL.Path != "/api/v1/printer-connector/self/assignments/"+assignmentID.String()+"/runs/"+runID.String()+"/artifact" {
			t.Errorf("unexpected request: %s %s", request.Method, request.URL.Path)
		}
		if request.Header.Get("Authorization") != "Bearer connector-token" ||
			request.Header.Get("Content-Type") != "application/octet-stream" ||
			request.Header.Get("X-Configuration-Version") != "7" ||
			request.Header.Get("X-Artifact-Filename") != "part.3mf" ||
			request.Header.Get("X-Artifact-SHA256") != transfer.SHA256 ||
			request.ContentLength != transfer.SizeBytes {
			t.Errorf("unexpected upload headers: %#v length=%d", request.Header, request.ContentLength)
		}
		body, readErr := io.ReadAll(request.Body)
		if readErr != nil || !bytes.Equal(body, archive) {
			t.Errorf("unexpected upload body: size=%d err=%v", len(body), readErr)
		}
		response := `{"artifact":{"id":"artifact"},"disposition":"created","runId":"` + runID.String() + `","autoAttachedJobId":null}`
		return &http.Response{
			StatusCode: http.StatusCreated,
			Status:     "201 Created",
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader(response)),
			Request:    request,
		}, nil
	})
	receipt, err := client.UploadArtifact(ctx, "connector-token", transfer)
	if err != nil || receipt.Disposition != "created" || receipt.RunID != runID {
		t.Fatalf("unexpected artifact receipt: %#v %v", receipt, err)
	}
}

func TestBuildBambuConsumptionPayloadUsesTerminalMethod(t *testing.T) {
	t.Parallel()
	archive := syntheticBambuConsumptionZIP(t)
	path := t.TempDir() + "/fixture.3mf"
	if err := os.WriteFile(path, archive, 0o600); err != nil {
		t.Fatal(err)
	}
	transfer := ArtifactTransfer{StagedPath: path, SizeBytes: int64(len(archive))}

	completed, err := buildBambuConsumptionPayload(
		transfer,
		bambuRunFacts{Outcome: "completed", InputUnitExternalID: "128", SlotExternalID: "0", TagUID: "E2C92C29"},
	)
	if err != nil {
		t.Fatal(err)
	}
	var completedReport struct {
		Items []map[string]any `json:"items"`
	}
	if err = json.Unmarshal(completed, &completedReport); err != nil {
		t.Fatal(err)
	}
	if len(completedReport.Items) != 1 || completedReport.Items[0]["method"] != "slicer_complete" ||
		completedReport.Items[0]["estimatedQuantityGrams"] != "0.300000" ||
		completedReport.Items[0]["inputUnitExternalId"] != "128" ||
		completedReport.Items[0]["slotExternalId"] != "0" ||
		completedReport.Items[0]["tagUid"] != "E2C92C29" {
		t.Fatalf("completed report = %s", completed)
	}

	layer, progress := 1, 50.0
	for _, adapterKind := range []AdapterKind{AdapterBambuH2D, AdapterBambuX1C} {
		t.Run(string(adapterKind), func(t *testing.T) {
			failed, buildErr := buildBambuConsumptionPayloadFor(
				adapterKind,
				transfer,
				bambuRunFacts{Outcome: "failed", LastLayer: &layer, LastProgress: &progress},
			)
			if buildErr != nil {
				t.Fatal(buildErr)
			}
			var failedReport struct {
				Items []map[string]any `json:"items"`
			}
			if unmarshalErr := json.Unmarshal(failed, &failedReport); unmarshalErr != nil {
				t.Fatal(unmarshalErr)
			}
			if len(failedReport.Items) != 1 || failedReport.Items[0]["method"] != "gcode_checkpoint" ||
				failedReport.Items[0]["estimatedQuantityGrams"] != "0.029825" ||
				failedReport.Items[0]["modelQuantityGrams"] != "0.029825" {
				t.Fatalf("failed report = %s", failed)
			}
		})
	}

	unresolved, err := buildBambuConsumptionPayload(transfer, bambuRunFacts{Outcome: "unknown"})
	if err != nil {
		t.Fatal(err)
	}
	var unresolvedReport struct {
		Items []map[string]any `json:"items"`
	}
	if err = json.Unmarshal(unresolved, &unresolvedReport); err != nil {
		t.Fatal(err)
	}
	if len(unresolvedReport.Items) != 1 || unresolvedReport.Items[0]["quality"] != "unresolved" ||
		unresolvedReport.Items[0]["estimatedQuantityGrams"] != nil {
		t.Fatalf("unresolved report = %s", unresolved)
	}
}

func TestMultiMaterialConsumptionMapsEachPhysicalSpool(t *testing.T) {
	t.Parallel()
	gramsA, gramsB := 3.25, 4.75
	parsed := parser.Result{
		Filaments: []parser.Filament{
			{ID: "1", WeightGrams: &gramsA, Extruders: []int{0}},
			{ID: "5", WeightGrams: &gramsB, Extruders: []int{1}},
		},
	}
	payload, err := marshalSlicerConsumption(parsed, bambuRunFacts{
		HistoryComplete: true,
		SpoolEvidence: []bambuSpoolEvidence{
			{Extruder: 0, InputUnitExternalID: "0", SlotExternalID: "2", TagUID: "RIGHT"},
			{Extruder: 1, InputUnitExternalID: "128", SlotExternalID: "0", TagUID: "LEFT"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	var report struct {
		Items []map[string]any `json:"items"`
	}
	if err = json.Unmarshal(payload, &report); err != nil {
		t.Fatal(err)
	}
	if len(report.Items) != 2 || report.Items[0]["slotExternalId"] != "2" || report.Items[0]["tagUid"] != "RIGHT" ||
		report.Items[1]["slotExternalId"] != "0" || report.Items[1]["tagUid"] != "LEFT" {
		t.Fatalf("multi-nozzle report = %s", payload)
	}
}

func TestInterruptedX1CConsumptionUsesExplicitMaterialMapping(t *testing.T) {
	t.Parallel()
	greenGrams, whiteGrams, consumedWhite := 0.76, 2.41, 2.147144
	parsed := parser.Result{Filaments: []parser.Filament{
		{ID: "1", WeightGrams: &greenGrams, Extruders: []int{1}},
		{ID: "3", WeightGrams: &whiteGrams, Extruders: []int{1}},
	}}
	estimate := parser.GCodeEstimate{
		Method:             "gcode_checkpoint",
		CalculationVersion: parser.CalculationVersion,
		Quality:            parser.QualityHigh,
		Resolved:           true,
		// M620 uses zero-based filament 2; marshalGCodeConsumption maps it to
		// the positive-quantity slice_info filament 3 before resolving the spool.
		Filaments: []parser.FilamentEstimate{{FilamentID: "2", Extruders: []int{1}, WeightGrams: &consumedWhite}},
	}
	payload, err := marshalGCodeConsumption(parsed, estimate, bambuRunFacts{
		InputUnitExternalID: "0", SlotExternalID: "0",
		SpoolEvidence: []bambuSpoolEvidence{
			{SlicerFilamentID: "1", Extruder: 1, InputUnitExternalID: "0", SlotExternalID: "0", TagUID: "GREEN"},
			{SlicerFilamentID: "3", Extruder: 1, InputUnitExternalID: "0", SlotExternalID: "2", TagUID: "WHITE"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	var report struct {
		Items []map[string]any `json:"items"`
	}
	if err = json.Unmarshal(payload, &report); err != nil {
		t.Fatal(err)
	}
	if len(report.Items) != 1 || report.Items[0]["slicerFilamentId"] != "3" ||
		report.Items[0]["slotExternalId"] != "2" ||
		report.Items[0]["tagUid"] != "WHITE" {
		t.Fatalf("interrupted X1C report = %s", payload)
	}
}

func TestMultiMaterialConsumptionMapsUniqueRemainingH2DRoute(t *testing.T) {
	t.Parallel()
	yellowGrams, whiteGrams := 0.55, 1.64
	parsed := parser.Result{
		Filaments: []parser.Filament{
			// Real H2D slice metadata numbers its two physical extruders 2/1,
			// while MQTT identifies the corresponding routes as 0/1.
			{ID: "1", WeightGrams: &yellowGrams, Extruders: []int{2}},
			{ID: "3", WeightGrams: &whiteGrams, Extruders: []int{1}},
		},
	}
	payload, err := marshalSlicerConsumption(parsed, bambuRunFacts{
		HistoryComplete: true,
		SpoolEvidence: []bambuSpoolEvidence{
			{Extruder: 0, InputUnitExternalID: "255", SlotExternalID: "255"},
			{Extruder: 1, InputUnitExternalID: "128", SlotExternalID: "0", TagUID: "WHITE"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	var report struct {
		Items []map[string]any `json:"items"`
	}
	if err = json.Unmarshal(payload, &report); err != nil {
		t.Fatal(err)
	}
	if len(report.Items) != 2 || report.Items[0]["inputUnitExternalId"] != "255" ||
		report.Items[0]["slotExternalId"] != "255" ||
		report.Items[1]["inputUnitExternalId"] != "128" ||
		report.Items[1]["slotExternalId"] != "0" ||
		report.Items[1]["tagUid"] != "WHITE" {
		t.Fatalf("H2D route elimination report = %s", payload)
	}
}

func TestMultiMaterialConsumptionMapsOrderedChangesOnOneExtruder(t *testing.T) {
	t.Parallel()
	gramsA, gramsB := 2.0, 6.0
	parsed := parser.Result{
		Filaments: []parser.Filament{
			{ID: "1", WeightGrams: &gramsA, Extruders: []int{1}},
			{ID: "5", WeightGrams: &gramsB, Extruders: []int{1}},
		},
		FilamentSequence: []string{"5", "1"},
	}
	payload, err := marshalSlicerConsumption(parsed, bambuRunFacts{
		HistoryComplete: true,
		SpoolEvidence: []bambuSpoolEvidence{
			{Extruder: 1, InputUnitExternalID: "0", SlotExternalID: "3", TagUID: "FIRST"},
			{Extruder: 1, InputUnitExternalID: "0", SlotExternalID: "1", TagUID: "SECOND"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	var report struct {
		Items []map[string]any `json:"items"`
	}
	if err = json.Unmarshal(payload, &report); err != nil {
		t.Fatal(err)
	}
	byID := map[string]map[string]any{}
	for _, item := range report.Items {
		byID[item["slicerFilamentId"].(string)] = item
	}
	if byID["5"]["slotExternalId"] != "3" || byID["5"]["tagUid"] != "FIRST" ||
		byID["1"]["slotExternalId"] != "1" || byID["1"]["tagUid"] != "SECOND" {
		t.Fatalf("single-nozzle multi-material report = %s", payload)
	}
}

func TestMultiMaterialConsumptionDoesNotGuessWithIncompleteHistory(t *testing.T) {
	t.Parallel()
	gramsA, gramsB := 2.0, 6.0
	parsed := parser.Result{
		Filaments: []parser.Filament{
			{ID: "1", WeightGrams: &gramsA, Extruders: []int{1}},
			{ID: "5", WeightGrams: &gramsB, Extruders: []int{1}},
		},
		FilamentSequence: []string{"1", "5"},
	}
	payload, err := marshalSlicerConsumption(parsed, bambuRunFacts{
		HistoryComplete: false,
		SpoolEvidence: []bambuSpoolEvidence{
			{Extruder: 1, InputUnitExternalID: "0", SlotExternalID: "0"},
			{Extruder: 1, InputUnitExternalID: "0", SlotExternalID: "1"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(payload), "slotExternalId") {
		t.Fatalf("incomplete tray history must stay unresolved: %s", payload)
	}
}

func TestAcknowledgedArtifactIsRetainedUntilConsumptionIsDurable(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	assignmentID, runID := ids.New(), ids.New()
	if err = store.SaveBambuState(ctx, assignmentID, bambuPersistedState{
		Document: map[string]any{}, Ready: true, RunFacts: map[string]bambuRunFacts{
			runID.String(): {Outcome: "completed", HistoryComplete: true, ExternalPrintID: "task-7"},
		},
	}); err != nil {
		t.Fatal(err)
	}
	archive := syntheticBambuConsumptionZIP(t)
	transfer, err := store.StageArtifact(
		ctx,
		assignmentID,
		runID,
		3,
		"/cache/fixture.3mf",
		"fixture.3mf",
		bytes.NewReader(archive),
		time.Now().UTC().Add(time.Hour),
	)
	if err != nil {
		t.Fatal(err)
	}
	if err = store.CompleteArtifactTransfer(ctx, transfer.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(transfer.StagedPath); err != nil {
		t.Fatalf("artifact was removed before consumption became durable: %v", err)
	}
	adapter := &bambuH2DAdapter{assignmentID: assignmentID, configurationVersion: 3, store: store}
	if err = adapter.processArtifactConsumptions(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(transfer.StagedPath); !os.IsNotExist(err) {
		t.Fatalf("artifact was retained after upload acknowledgement and durable report: %v", err)
	}
	events, err := store.Pending(ctx, 10)
	if err != nil || len(events) != 1 || events[0].Kind != "consumption_report" || events[0].ReportRevision == nil ||
		*events[0].ReportRevision != 1 {
		t.Fatalf("consumption outbox = %#v, err=%v", events, err)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func syntheticZIP(t *testing.T, name, content string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	entry, err := writer.Create(name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = entry.Write([]byte(content)); err != nil {
		t.Fatal(err)
	}
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func syntheticBambuConsumptionZIP(t *testing.T) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	entries := map[string]string{
		"Metadata/slice_info.config": `<?xml version="1.0"?><config><plate id="1"/><filament id="0" type="PLA" used_mm="100" used_g="0.3" density="1.24" diameter="1.75" extruder="0"/><filament id="4" type="PLA" density="1.24" diameter="1.75"/><filament id="GFA00" type="PLA" density="1.24" diameter="1.75"/></config>`,
		// The later progress marker is still on layer 1. A failed run reporting
		// layer 1 but only 50% must use both bounds and stop at the layer marker,
		// rather than accepting the later 80% checkpoint.
		"Metadata/plate_1.gcode": "M82\nG92 E0\nM620 S0A\n; layer: 0\n;TYPE:External perimeter\nG1 E10\nM73 P25\n; layer: 1\nG1 E20\nM73 P80\n; layer: 2\n",
	}
	for name, content := range entries {
		entry, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = entry.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func assertKinds(t *testing.T, observations []Observation, expected ...ObservationKind) {
	t.Helper()
	counts := map[ObservationKind]int{}
	for _, observation := range observations {
		counts[observation.Kind]++
	}
	for _, kind := range expected {
		if counts[kind] == 0 {
			t.Fatalf("missing %s in observations %#v", kind, observations)
		}
		delete(counts, kind)
	}
	if len(counts) != 0 {
		t.Fatalf("unexpected observation kinds: %#v", counts)
	}
}

func TestRuntimeQuarantinesArtifactsCoreRejectsPermanently(t *testing.T) {
	t.Parallel()
	for _, status := range []int{http.StatusNotFound, http.StatusConflict} {
		ctx := context.Background()
		store, err := OpenStore(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = store.Close() })
		archive := syntheticZIP(t, "3D/3dmodel.model", "model")
		transfer, err := store.StageArtifact(
			ctx,
			ids.New(),
			ids.New(),
			3,
			"/cache/part.3mf",
			"part.3mf",
			bytes.NewReader(archive),
			time.Now().UTC().Add(time.Hour),
		)
		if err != nil {
			t.Fatal(err)
		}
		client, err := NewClient("http://core.test", true)
		if err != nil {
			t.Fatal(err)
		}
		client.http.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
			_, _ = io.Copy(io.Discard, request.Body)
			return &http.Response{
				StatusCode: status,
				Status:     http.StatusText(status),
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader(`{"code":"not_found","message":"x"}`)),
				Request:    request,
			}, nil
		})
		var logs bytes.Buffer
		runtime := &Runtime{client: client, store: store, logger: slog.New(slog.NewTextHandler(&logs, nil))}
		if err = runtime.deliverArtifacts(ctx, Identity{CredentialSecret: "token"}); err != nil {
			t.Fatalf("status %d: rejected artifact was reported as a delivery failure: %v", status, err)
		}
		pending, err := store.PendingArtifactTransfers(ctx, 20)
		if err != nil || len(pending) != 0 {
			t.Fatalf("status %d: rejected artifact is still pending: %#v %v", status, pending, err)
		}
		if _, err = os.Stat(transfer.StagedPath); !os.IsNotExist(err) {
			t.Fatalf("status %d: rejected staged file was kept: %v", status, err)
		}
		if line := logs.String(); !strings.Contains(line, "transfer quarantined") ||
			!strings.Contains(line, fmt.Sprintf("status=%d", status)) ||
			!strings.Contains(line, "code=not_found") {
			t.Fatalf("status %d: rejection log lacks status or code: %s", status, line)
		}
		// The rejected transfer no longer occupies queue capacity.
		var queued int64
		if err = store.db.QueryRowContext(
			ctx,
			`SELECT count(*) FROM artifact_transfers WHERE `+queuedArtifactTransfer,
		).Scan(&queued); err != nil ||
			queued != 0 {
			t.Fatalf("status %d: rejected transfer still counts as queued: %d %v", status, queued, err)
		}
	}
}

func TestRuntimeRetriesArtifactsOnTransientCoreErrors(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	archive := syntheticZIP(t, "3D/3dmodel.model", "model")
	transfer, err := store.StageArtifact(
		ctx,
		ids.New(),
		ids.New(),
		3,
		"/cache/part.3mf",
		"part.3mf",
		bytes.NewReader(archive),
		time.Now().UTC().Add(time.Hour),
	)
	if err != nil {
		t.Fatal(err)
	}
	client, err := NewClient("http://core.test", true)
	if err != nil {
		t.Fatal(err)
	}
	client.http.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
		_, _ = io.Copy(io.Discard, request.Body)
		return &http.Response{
			StatusCode: http.StatusServiceUnavailable,
			Status:     "503 Service Unavailable",
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader(`{"code":"temporarily_unavailable"}`)),
			Request:    request,
		}, nil
	})
	runtime := &Runtime{client: client, store: store, logger: discardLogger()}
	err = runtime.deliverArtifacts(ctx, Identity{CredentialSecret: "token"})
	var coreErr *CoreError
	if !errors.As(err, &coreErr) || coreErr.Status != http.StatusServiceUnavailable ||
		coreErr.Code != "temporarily_unavailable" {
		t.Fatalf("transient failure lost its status and code: %v", err)
	}
	if _, err = os.Stat(transfer.StagedPath); err != nil {
		t.Fatalf("transient failure removed the staged file: %v", err)
	}
	var state string
	if err = store.db.QueryRowContext(
		ctx,
		`SELECT state FROM artifact_transfers WHERE id=?`,
		transfer.ID.String(),
	).Scan(&state); err != nil ||
		state != "pending" {
		t.Fatalf("transient failure changed the transfer state: %q %v", state, err)
	}
}

func TestInternalStoragePrintIsLookedUpByNameWhileItRuns(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	assignmentID, runID := ids.New(), ids.New()
	adapter := &bambuH2DAdapter{assignmentID: assignmentID, configurationVersion: 3, store: store}
	// The printer's url named another file, so the print counts as internal storage; its name still
	// yields the archive to look for on external storage.
	facts := map[string]bambuRunFacts{runID.String(): {
		Source: bambuSourceInternal, InternalPath: "data_metadata_plate_1_gcode", ArchiveCandidate: "/cache/Ghostie.gcode.3mf",
	}}
	observation := Observation{
		Kind:    ObservationProgress,
		RunID:   &runID,
		Payload: mustJSON(map[string]any{"fileName": "Ghostie", "artifactPath": "/data/Metadata/plate_1.gcode"}),
	}
	if err = adapter.scheduleArtifactRetrievals(ctx, []Observation{observation}, facts); err != nil {
		t.Fatal(err)
	}
	retrieval, err := store.PendingArtifactRetrieval(ctx, assignmentID)
	if err != nil || retrieval == nil || retrieval.ReportedPath != "/cache/Ghostie.gcode.3mf" ||
		retrieval.ConfigurationVersion != 3 {
		t.Fatalf("retrieval during the print = %#v err=%v", retrieval, err)
	}
	// Later progress reports do not queue it again, and a print without a candidate is left alone.
	if err = adapter.scheduleArtifactRetrievals(ctx, []Observation{observation}, facts); err != nil {
		t.Fatal(err)
	}
	other := ids.New()
	noCandidate := Observation{Kind: ObservationProgress, RunID: &other, Payload: observation.Payload}
	if err = adapter.scheduleArtifactRetrievals(
		ctx, []Observation{noCandidate}, map[string]bambuRunFacts{other.String(): {Source: bambuSourceInternal}},
	); err != nil {
		t.Fatal(err)
	}
	var count int
	if err = store.db.QueryRow(`SELECT count(*) FROM artifact_retrievals WHERE assignment_id=?`, assignmentID.String()).Scan(&count); err != nil ||
		count != 1 {
		t.Fatalf("retrievals = %d, %v; want one", count, err)
	}
}
