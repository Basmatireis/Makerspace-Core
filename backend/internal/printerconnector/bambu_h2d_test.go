package printerconnector

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

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
	if settings.IPAddress.String() != "192.168.1.42" || settings.SerialNumber != "01P09A123456789" || !settings.AutoDetectSpools || secrets.LANAccessCode != "secret" {
		t.Fatalf("unexpected parsed configuration: %#v %#v", settings, secrets)
	}
	for name, test := range map[string]struct {
		settings map[string]any
		secrets  map[string]string
	}{
		"hostname":       {map[string]any{"ipAddress": "printer.local", "serialNumber": "01P09A123456789"}, map[string]string{"lanAccessCode": "secret"}},
		"multicast":      {map[string]any{"ipAddress": "224.0.0.1", "serialNumber": "01P09A123456789"}, map[string]string{"lanAccessCode": "secret"}},
		"bad serial":     {map[string]any{"ipAddress": "192.168.1.42", "serialNumber": "bad serial"}, map[string]string{"lanAccessCode": "secret"}},
		"missing secret": {map[string]any{"ipAddress": "192.168.1.42", "serialNumber": "01P09A123456789"}, map[string]string{}},
		"unknown field":  {map[string]any{"ipAddress": "192.168.1.42", "serialNumber": "01P09A123456789", "port": 1883}, map[string]string{"lanAccessCode": "secret"}},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if _, _, parseErr := parseBambuH2DConfiguration(test.settings, test.secrets); parseErr == nil {
				t.Fatal("expected validation failure")
			}
		})
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
	processor := &bambuProcessor{state: bambuPersistedState{Document: map[string]any{}, Sessions: map[string]string{}, LastSlots: map[string]string{}, ActiveErrors: map[string]bool{}, RunFacts: map[string]bambuRunFacts{}}, firstSnapshot: true}
	payload := []byte(`{"print":{"gcode_state":"RUNNING","task_id":"5","ams":{"tray_now":"0","ams":[{"id":"0","tray":[{"id":"0","tag_uid":"TAG-A"}]},{"id":"1","tray":[{"id":"0","tag_uid":"TAG-B"}]}]}}}`)
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
	processor := &bambuProcessor{state: bambuPersistedState{Document: map[string]any{}, Sessions: map[string]string{}, LastSlots: map[string]string{}, EmptySlotCounts: map[string]uint8{}, ActiveErrors: map[string]bool{}, RunFacts: map[string]bambuRunFacts{}}, firstSnapshot: true}
	at := time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)
	occupied := []byte(`{"print":{"gcode_state":"RUNNING","task_id":"5","ams":{"ams":[{"id":"128","tray":[{"id":"0","tag_uid":"RFID-1","tray_type":"PLA"}]}]}}}`)
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
	if err = json.Unmarshal(observations[0].Payload, &payload); err != nil || payload["empty"] != true || payload["tagUid"] != nil {
		t.Fatalf("confirmed empty payload = %s, err=%v", observations[0].Payload, err)
	}
}

func TestMergeBambuObjectRecursivelyMergesAndReplacesArrays(t *testing.T) {
	t.Parallel()
	current := map[string]any{"print": map[string]any{"state": "RUNNING", "progress": json.Number("10"), "keep": true}, "ams": []any{1, 2}, "clear": "value"}
	patch := map[string]any{"print": map[string]any{"progress": json.Number("20")}, "ams": []any{3}, "clear": nil}
	merged, err := mergeBambuObject(current, patch, 0)
	if err != nil {
		t.Fatal(err)
	}
	printState := objectAt(merged, "print")
	if stringAt(printState, "state") != "RUNNING" || stringAt(printState, "progress") != "20" || printState["keep"] != true {
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
	assignmentID := uuid.Must(uuid.NewV7())
	processor, err := newBambuProcessor(ctx, assignmentID, store)
	if err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)
	initial := []byte(`{"print":{"gcode_state":"RUNNING","task_id":"23","subtask_id":"7","gcode_file":"part.3mf","mc_percent":12,"mc_remaining_time":8,"layer_num":3,"total_layer_num":20,"print_error":134184963,"ams":{"ams":[{"id":"0","tray":[{"id":"1","tag_uid":"ABC","tray_uuid":"observed-only","tray_type":"PLA","tray_color":"FF0000FF","tray_weight":"1000","remain":"80"}]}]},"tray_now":"0:1"}}`)
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
			if json.Unmarshal(observation.Payload, &payload) != nil || payload["transition"] != "appeared" || payload["code"] != "134184963" {
				t.Fatalf("unexpected printer error payload: %s", observation.Payload)
			}
		}
		if observation.Kind == "slot_observation" {
			if observation.RunID != nil {
				t.Fatal("assignment-level slot observation was attached to a run")
			}
			var payload map[string]any
			if json.Unmarshal(observation.Payload, &payload) != nil || payload["inputUnitExternalId"] != "0" || payload["slotExternalId"] != "1" || payload["externalSlotKey"] != "0:1" {
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
	volatile, _, err := processor.apply(ctx, []byte(`{"print":{"nozzle_temper":"220","nozzle_target_temper":"230","mc_print_stage":"5"}}`), at.Add(time.Second))
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
		if observation.Kind == "printer_error" && !bytes.Contains(observation.Payload, []byte(`"transition":"cleared"`)) {
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

func TestBambuReducerIgnoresRetainedTerminalAtStartup(t *testing.T) {
	t.Parallel()
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	processor, err := newBambuProcessor(context.Background(), uuid.Must(uuid.NewV7()), store)
	if err != nil {
		t.Fatal(err)
	}
	observations, ready, err := processor.apply(context.Background(), []byte(`{"print":{"gcode_state":"FINISH","task_id":"old","mc_percent":100}}`), time.Now().UTC())
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
	assignmentID := uuid.Must(uuid.NewV7())
	processor, err := newBambuProcessor(ctx, assignmentID, store)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = processor.apply(ctx, []byte(`{"print":{"gcode_state":"FINISH","task_id":"old"}}`), time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	if err = processor.persist(ctx); err != nil {
		t.Fatal(err)
	}
	restarted, err := newBambuProcessor(ctx, assignmentID, store)
	if err != nil {
		t.Fatal(err)
	}
	observations, _, err := restarted.apply(ctx, []byte(`{"print":{"gcode_state":"RUNNING","task_id":"new","mc_percent":50}}`), time.Now().UTC().Add(time.Hour))
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
	entries, err := parseFTPList([]byte("-rw-r--r-- 1 user group 123 Oct 14 12:00 part one.3mf\r\ndrwxr-xr-x 2 user group 0 Oct 14 12:00 folder\r\n"))
	if err != nil || len(entries) != 2 || entries[0].Name != "part one.3mf" || entries[0].Size != 123 || !entries[1].IsDir {
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
	if _, err = SelectArtifactCandidate("part.3mf", listings); err == nil || !strings.Contains(err.Error(), "ambiguous") {
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

func TestArtifactTransferQueueStagesValidZIPAndDeletesOnlyOnCompletion(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	archive := syntheticZIP(t, "3D/3dmodel.model", "model")
	transfer, err := store.StageArtifact(ctx, uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7()), 2, "/cache/part.3mf", "part.3mf", bytes.NewReader(archive), time.Now().UTC().Add(time.Hour))
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
	if _, err = store.StageArtifact(ctx, uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7()), 1, "/bad.3mf", "bad.3mf", bytes.NewReader(unsafe), time.Now().UTC().Add(time.Hour)); err == nil || !strings.Contains(err.Error(), "unsafe") {
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
	assignmentID, runID := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	archive := syntheticZIP(t, "3D/3dmodel.model", "model")
	transfer, err := store.StageArtifact(ctx, assignmentID, runID, 7, "/cache/part.3mf", "part.3mf", bytes.NewReader(archive), time.Now().UTC().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	client, err := NewClient("http://core.test", true)
	if err != nil {
		t.Fatal(err)
	}
	client.http.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.Method != http.MethodPut || request.URL.Path != "/api/v1/printer-connector/self/assignments/"+assignmentID.String()+"/runs/"+runID.String()+"/artifact" {
			t.Errorf("unexpected request: %s %s", request.Method, request.URL.Path)
		}
		if request.Header.Get("Authorization") != "Bearer connector-token" || request.Header.Get("Content-Type") != "application/octet-stream" || request.Header.Get("X-Configuration-Version") != "7" || request.Header.Get("X-Artifact-Filename") != "part.3mf" || request.Header.Get("X-Artifact-SHA256") != transfer.SHA256 || request.ContentLength != transfer.SizeBytes {
			t.Errorf("unexpected upload headers: %#v length=%d", request.Header, request.ContentLength)
		}
		body, readErr := io.ReadAll(request.Body)
		if readErr != nil || !bytes.Equal(body, archive) {
			t.Errorf("unexpected upload body: size=%d err=%v", len(body), readErr)
		}
		response := `{"artifact":{"id":"artifact"},"disposition":"created","runId":"` + runID.String() + `","autoAttachedJobId":null}`
		return &http.Response{StatusCode: http.StatusCreated, Status: "201 Created", Header: make(http.Header), Body: io.NopCloser(strings.NewReader(response)), Request: request}, nil
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

	completed, err := buildBambuConsumptionPayload(transfer, bambuRunFacts{Outcome: "completed", InputUnitExternalID: "128", SlotExternalID: "0", TagUID: "E2C92C29"})
	if err != nil {
		t.Fatal(err)
	}
	var completedReport struct {
		Items []map[string]any `json:"items"`
	}
	if err = json.Unmarshal(completed, &completedReport); err != nil {
		t.Fatal(err)
	}
	if len(completedReport.Items) != 1 || completedReport.Items[0]["method"] != "slicer_complete" || completedReport.Items[0]["estimatedQuantityGrams"] != "0.300000" || completedReport.Items[0]["inputUnitExternalId"] != "128" || completedReport.Items[0]["slotExternalId"] != "0" || completedReport.Items[0]["tagUid"] != "E2C92C29" {
		t.Fatalf("completed report = %s", completed)
	}

	layer := 1
	failed, err := buildBambuConsumptionPayload(transfer, bambuRunFacts{Outcome: "failed", LastLayer: &layer})
	if err != nil {
		t.Fatal(err)
	}
	var failedReport struct {
		Items []map[string]any `json:"items"`
	}
	if err = json.Unmarshal(failed, &failedReport); err != nil {
		t.Fatal(err)
	}
	if len(failedReport.Items) != 1 || failedReport.Items[0]["method"] != "gcode_checkpoint" || failedReport.Items[0]["estimatedQuantityGrams"] != "0.029825" || failedReport.Items[0]["modelQuantityGrams"] != "0.029825" {
		t.Fatalf("failed report = %s", failed)
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
	if len(unresolvedReport.Items) != 1 || unresolvedReport.Items[0]["quality"] != "unresolved" || unresolvedReport.Items[0]["estimatedQuantityGrams"] != nil {
		t.Fatalf("unresolved report = %s", unresolved)
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
	assignmentID, runID := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	if err = store.SaveBambuState(ctx, assignmentID, bambuPersistedState{
		Document: map[string]any{}, Ready: true, RunFacts: map[string]bambuRunFacts{
			runID.String(): {Outcome: "completed", HistoryComplete: true, ExternalPrintID: "task-7"},
		},
	}); err != nil {
		t.Fatal(err)
	}
	archive := syntheticBambuConsumptionZIP(t)
	transfer, err := store.StageArtifact(ctx, assignmentID, runID, 3, "/cache/fixture.3mf", "fixture.3mf", bytes.NewReader(archive), time.Now().UTC().Add(time.Hour))
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
	if err != nil || len(events) != 1 || events[0].Kind != "consumption_report" || events[0].ReportRevision == nil || *events[0].ReportRevision != 1 {
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
		"Metadata/slice_info.config": `<?xml version="1.0"?><config><plate id="1"/><filament id="0" type="PLA" used_mm="100" used_g="0.3" density="1.24" diameter="1.75" extruder="0"/></config>`,
		"Metadata/plate_1.gcode":     "M82\nG92 E0\n; layer: 0\n;TYPE:External perimeter\nG1 E10\n; layer: 1\nG1 E20\n; layer: 2\n",
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

func assertKinds(t *testing.T, observations []Observation, expected ...string) {
	t.Helper()
	counts := map[string]int{}
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
