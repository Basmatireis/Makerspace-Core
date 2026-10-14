package printerconnector

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

// h2dStatus is a trimmed document in the shape of the observed H2D reports:
// two extruders and nozzles, AMS 0 and AMS HT 128 with the observed
// tray_exist_bits, both external holders, an HMS entry and Wi-Fi strength.
// Network, camera and identity fields are included to prove they are dropped.
const h2dStatus = `{"print":{
"gcode_state":"RUNNING","subtask_name":"Benchy 0.2mm","gcode_file":"/data/Metadata/plate_1.gcode",
"mc_percent":42,"layer_num":80,"total_layer_num":191,"mc_remaining_time":37,
"task_id":"1335983511","print_error":0,"wifi_signal":"-39dBm",
"bed_temper":59.6,"bed_target_temper":60.0,
"device":{
  "extruder":{"info":[{"id":0,"temp":219,"htar":220,"stat":393216},{"id":1,"temp":31,"htar":0}]},
  "nozzle":{"info":[{"id":0,"diameter":0.4,"type":"HS01"},{"id":1,"diameter":0.6,"type":"HH01"}]},
  "ctc":{"info":{"temp":34}}},
"ams":{"tray_now":"1","tray_exist_bits":"10003","ams":[
  {"id":"0","humidity":"2","humidity_raw":"32","temp":"32.4","tray":[
    {"id":"0","tray_type":"PETG","tray_sub_brands":"PETG HF","tray_color":"FFF144FF","remain":55,"tag_uid":"0123456789ABCDEF"},
    {"id":"1","tray_type":"PLA","tray_sub_brands":"","tray_color":"D32F2FFF","remain":-1,"tag_uid":"0000000000000000"},
    {"id":"2","tray_type":"","tray_color":"00000000","remain":0,"tag_uid":"0000000000000000"},
    {"id":"3","tray_type":"","tray_color":"00000000","remain":0,"tag_uid":"0000000000000000"}]},
  {"id":"128","humidity":"3","humidity_raw":"20","temp":"30.0","tray":[
    {"id":"0","tray_type":"TPU","tray_color":"101010FF","remain":90,"tag_uid":"FEDCBA9876543210"}]}]},
"vir_slot":[
  {"id":"254","tray_type":"PLA","tray_color":"FFFFFFFF","remain":0,"tag_uid":"0000000000000000"},
  {"id":"255","tray_type":"","tray_color":"00000000","remain":0,"tag_uid":"0000000000000000"}],
"hms":[{"attr":83952640,"code":196610,"ts_unix":"20261013230500"},{"attr":1,"code":0}],
"ipcam":{"rtsp_url":"rtsps://192.168.1.50/streaming/live/1"},
"net":{"info":[{"ip":3232235826,"mac":"AA:BB:CC:DD:EE:FF"}]},
"sn":"00MREAL123","upgrade_state":{"sn":"00MREAL123"}}}`

func decodeDocument(t *testing.T, raw string) map[string]any {
	t.Helper()
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.UseNumber()
	var document map[string]any
	if err := decoder.Decode(&document); err != nil {
		t.Fatal(err)
	}
	return document
}

func TestBuildBambuLiveSnapshotFromAnH2DDocument(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)
	snapshot := buildBambuLiveSnapshot(decodeDocument(t, h2dStatus), map[string]time.Time{}, now)

	if snapshot.State != "printing" {
		t.Fatalf("state = %q", snapshot.State)
	}
	job := snapshot.Job
	if job == nil || *job.FileName != "Benchy 0.2mm" || *job.ProgressPercent != 42 || *job.Layer != 80 || *job.TotalLayers != 191 || *job.RemainingMinutes != 37 {
		t.Fatalf("job = %+v", job)
	}
	if len(snapshot.Temperatures.Extruders) != 2 || *snapshot.Temperatures.Extruders[0].CurrentC != 219 || *snapshot.Temperatures.Extruders[0].TargetC != 220 ||
		*snapshot.Temperatures.Extruders[1].CurrentC != 31 || *snapshot.Temperatures.BedC != 59.6 || *snapshot.Temperatures.BedTargetC != 60 || *snapshot.Temperatures.ChamberC != 34 {
		t.Fatalf("temperatures = %+v", snapshot.Temperatures)
	}
	if len(snapshot.Nozzles) != 2 || *snapshot.Nozzles[0].DiameterMm != 0.4 || *snapshot.Nozzles[1].DiameterMm != 0.6 || *snapshot.Nozzles[1].Type != "HH01" {
		t.Fatalf("nozzles = %+v", snapshot.Nozzles)
	}
	// Extruder 0 is the right nozzle, extruder 1 the left one (documented assumption).
	if *snapshot.Nozzles[0].Side != "right" || *snapshot.Nozzles[1].Side != "left" || *snapshot.Temperatures.Extruders[1].Side != "left" {
		t.Fatalf("extruder sides = %+v / %+v", snapshot.Nozzles, snapshot.Temperatures.Extruders)
	}
	if *snapshot.WifiSignalDbm != -39 || snapshot.FirmwareVersion != nil {
		t.Fatalf("wifi=%v firmware=%v", snapshot.WifiSignalDbm, snapshot.FirmwareVersion)
	}

	if len(snapshot.Units) != 4 {
		t.Fatalf("units = %+v", snapshot.Units)
	}
	ams, ht, external254, external255 := snapshot.Units[0], snapshot.Units[1], snapshot.Units[2], snapshot.Units[3]
	if ams.ExternalID != "0" || ams.Kind != "ams" || *ams.HumidityPercent != 32 || *ams.TemperatureC != 32.4 || len(ams.Trays) != 4 {
		t.Fatalf("ams = %+v", ams)
	}
	if ht.ExternalID != "128" || ht.Kind != "ams_ht" || *ht.HumidityPercent != 20 || len(ht.Trays) != 1 {
		t.Fatalf("ams ht = %+v", ht)
	}
	first := ams.Trays[0]
	if *first.MaterialType != "PETG" || *first.SubBrand != "PETG HF" || *first.ColorHex != "FFF144" || *first.RemainPercent != 55 || !first.RFID || first.Empty {
		t.Fatalf("tray 0 = %+v", first)
	}
	second := ams.Trays[1]
	if *second.MaterialType != "PLA" || second.RemainPercent != nil || second.RFID || second.Empty || second.SubBrand != nil {
		t.Fatalf("tray 1 (no RFID, unknown remain) = %+v", second)
	}
	if !ams.Trays[2].Empty || !ams.Trays[3].Empty || ams.Trays[2].ColorHex != nil || ams.Trays[2].MaterialType != nil {
		t.Fatalf("empty trays = %+v", ams.Trays[2:])
	}
	if external254.Kind != "external" || external254.ExternalID != "254" || len(external254.Trays) != 1 || external254.Trays[0].ExternalID != "254" || external254.Trays[0].Empty || *external254.Trays[0].MaterialType != "PLA" {
		t.Fatalf("external 254 = %+v", external254)
	}
	if external255.ExternalID != "255" || !external255.Trays[0].Empty {
		t.Fatalf("external 255 = %+v", external255)
	}
	if snapshot.ActiveTray == nil || snapshot.ActiveTray.UnitExternalID != "0" || snapshot.ActiveTray.TrayExternalID != "1" {
		t.Fatalf("tray_now 1 identifies exactly AMS 0 tray 1: %+v", snapshot.ActiveTray)
	}

	if len(snapshot.Errors) != 1 || snapshot.Errors[0].SourceFamily != "hms" || snapshot.Errors[0].Code != "196610" || !snapshot.Errors[0].ObservedAt.Equal(now) {
		t.Fatalf("errors = %+v", snapshot.Errors)
	}

	encoded, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"192.168", "AA:BB", "00MREAL123", "rtsp", "0123456789ABCDEF", "tray_uuid", "3232235826"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("snapshot leaks %q: %s", forbidden, encoded)
		}
	}
	if len(encoded) > 8<<10 {
		t.Fatalf("snapshot is unexpectedly large: %d bytes", len(encoded))
	}
}

func TestBuildBambuLiveSnapshotStatesAndUnknownFields(t *testing.T) {
	t.Parallel()
	now := time.Now().UTC()
	for gcode, want := range map[string]string{"IDLE": "idle", "PREPARE": "preparing", "RUNNING": "printing", "PAUSE": "paused", "FINISH": "finished", "FAILED": "failed", "SLICING": "unknown", "": "unknown"} {
		snapshot := buildBambuLiveSnapshot(map[string]any{"print": map[string]any{"gcode_state": gcode}}, map[string]time.Time{}, now)
		if snapshot.State != want {
			t.Errorf("gcode_state %q -> %q, want %q", gcode, snapshot.State, want)
		}
	}
	idle := buildBambuLiveSnapshot(decodeDocument(t, `{"print":{"gcode_state":"IDLE","subtask_name":"old job","mc_percent":100,"ams":{"tray_now":"255"},"vir_slot":[{"id":"255","tray_type":""}]}}`), map[string]time.Time{}, now)
	if idle.Job != nil || idle.ActiveTray != nil {
		t.Fatalf("an idle printer has no job and no active tray (tray_now 255 means none): %+v", idle)
	}
	encoded, _ := json.Marshal(buildBambuLiveSnapshot(map[string]any{}, map[string]time.Time{}, now))
	var generic map[string]any
	if err := json.Unmarshal(encoded, &generic); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"state", "job", "temperatures", "nozzles", "units", "activeTray", "errors", "firmwareVersion", "wifiSignalDbm"} {
		if _, ok := generic[key]; !ok {
			t.Errorf("snapshot key %q must always be present: %s", key, encoded)
		}
	}
	if generic["nozzles"] == nil || generic["units"] == nil || generic["errors"] == nil || generic["temperatures"].(map[string]any)["extruders"] == nil {
		t.Fatalf("lists must encode as [] not null: %s", encoded)
	}
}

func TestBuildBambuLiveSnapshotKeepsErrorFirstSeenStable(t *testing.T) {
	t.Parallel()
	document := decodeDocument(t, `{"print":{"gcode_state":"PAUSE","print_error":134184963}}`)
	since := map[string]time.Time{}
	first := time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)
	one := buildBambuLiveSnapshot(document, since, first)
	two := buildBambuLiveSnapshot(document, since, first.Add(time.Minute))
	if len(one.Errors) != 1 || one.Errors[0].SourceFamily != "print" || !two.Errors[0].ObservedAt.Equal(first) {
		t.Fatalf("errors = %+v / %+v", one.Errors, two.Errors)
	}
	cleared := buildBambuLiveSnapshot(decodeDocument(t, `{"print":{"gcode_state":"PAUSE","print_error":0}}`), since, first.Add(2*time.Minute))
	if len(cleared.Errors) != 0 || len(since) != 0 {
		t.Fatalf("cleared errors = %+v since=%v", cleared.Errors, since)
	}
}

func TestActiveTrayResolvesExternalHoldersAndHTUnits(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name, document string
		unit, tray     string
		resolved       bool
	}{
		{"external 254", `{"gcode_state":"RUNNING","ams":{"tray_now":"254","ams":[{"id":"0","tray":[{"id":"0"}]}]},"vir_slot":[{"id":"254","tag_uid":"AB12"},{"id":"255"}]}`, "254", "254", true},
		{"external 255 while printing", `{"gcode_state":"RUNNING","ams":{"tray_now":"255"},"vir_slot":[{"id":"254"},{"id":"255"}]}`, "255", "255", true},
		{"external holder absent from the document", `{"gcode_state":"RUNNING","ams":{"tray_now":"254","ams":[{"id":"0","tray":[{"id":"0"}]}]}}`, "", "", false},
		{"AMS HT addressed by unit id", `{"gcode_state":"RUNNING","ams":{"tray_now":"128","ams":[{"id":"0","tray":[{"id":"0"},{"id":"1"}]},{"id":"128","tray":[{"id":"0"}]}]}}`, "128", "0", true},
		{"unit id of a multi-tray unit is not a tray", `{"gcode_state":"RUNNING","ams":{"tray_now":"128","ams":[{"id":"128","tray":[{"id":"0"},{"id":"1"}]}]}}`, "", "", false},
		{"explicit unit and tray", `{"gcode_state":"RUNNING","ams":{"tray_now":"128:0","ams":[{"id":"0","tray":[{"id":"0"}]},{"id":"128","tray":[{"id":"0"}]}]}}`, "128", "0", true},
		{"bare tray repeated across units", `{"gcode_state":"RUNNING","ams":{"tray_now":"0","ams":[{"id":"0","tray":[{"id":"0"}]},{"id":"128","tray":[{"id":"0"}]}]}}`, "", "", false},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			unit, tray, _, ok := bambuActiveSlot(decodeDocument(t, test.document))
			if ok != test.resolved || unit != test.unit || tray != test.tray {
				t.Fatalf("resolved %q/%q ok=%v, want %q/%q ok=%v", unit, tray, ok, test.unit, test.tray, test.resolved)
			}
		})
	}
	// The snapshot reports it only while a job is active.
	active := buildBambuLiveSnapshot(decodeDocument(t, cases[0].document), map[string]time.Time{}, time.Now())
	if active.ActiveTray == nil || active.ActiveTray.UnitExternalID != "254" || active.ActiveTray.TrayExternalID != "254" {
		t.Fatalf("active tray = %+v", active.ActiveTray)
	}
}

func TestSlotObservationsCoverExternalHolders(t *testing.T) {
	t.Parallel()
	processor := &bambuProcessor{state: bambuPersistedState{Document: map[string]any{}, Sessions: map[string]string{}, LastSlots: map[string]string{}, EmptySlotCounts: map[string]uint8{}, ActiveErrors: map[string]bool{}, RunFacts: map[string]bambuRunFacts{}}, firstSnapshot: true}
	payload := []byte(`{"print":{"gcode_state":"RUNNING","task_id":"5","ams":{"tray_now":"254"},"vir_slot":[{"id":"254","tag_uid":"RFID-EXT","tray_type":"PLA"}]}}`)
	observations, _, err := processor.apply(context.Background(), payload, time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, observation := range observations {
		if observation.Kind != "slot_observation" {
			continue
		}
		var slot map[string]any
		if err = json.Unmarshal(observation.Payload, &slot); err != nil {
			t.Fatal(err)
		}
		if slot["inputUnitExternalId"] == "254" && slot["slotExternalId"] == "254" && slot["tagUid"] == "RFID-EXT" {
			found = true
		}
	}
	if !found {
		t.Fatalf("no slot observation for vir_slot 254: %v", observations)
	}
	for _, facts := range processor.state.RunFacts {
		if facts.InputUnitExternalID != "254" || facts.SlotExternalID != "254" || facts.TagUID != "RFID-EXT" {
			t.Fatalf("run facts must carry the external holder: %+v", facts)
		}
	}
}

type recordingLiveSink struct {
	snapshots []json.RawMessage
}

func (s *recordingLiveSink) Commit(context.Context, Observation) error { return nil }
func (s *recordingLiveSink) ReportLiveStatus(snapshot json.RawMessage) {
	s.snapshots = append(s.snapshots, snapshot)
}

func TestSimulatorReportsAValidSnapshot(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	adapter, err := NewSimulator(map[string]any{"scenario": "idle"})
	if err != nil {
		t.Fatal(err)
	}
	sink := &recordingLiveSink{}
	_ = adapter.Run(ctx, sink)
	if len(sink.snapshots) != 1 {
		t.Fatalf("snapshots = %d", len(sink.snapshots))
	}
	var snapshot liveSnapshot
	if err = json.Unmarshal(sink.snapshots[0], &snapshot); err != nil || snapshot.State != "idle" || len(snapshot.Units) != 2 || snapshot.Units[0].Trays[0].ColorHex == nil {
		t.Fatalf("snapshot=%s err=%v", sink.snapshots[0], err)
	}
}

func TestLiveStatusHubThrottlesAndKeepsOnlyTheNewestSnapshot(t *testing.T) {
	t.Parallel()
	hub := newLiveStatusHub()
	clock := time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC)
	hub.now = func() time.Time { return clock }
	id := uuid.Must(uuid.NewV7())
	connected := func(uuid.UUID) bool { return true }
	disconnected := func(uuid.UUID) bool { return false }

	if len(hub.Due(connected)) != 0 {
		t.Fatal("nothing reported yet")
	}
	hub.Report(id, 3, json.RawMessage(`{"n":1}`))
	hub.Report(id, 3, json.RawMessage(`{"n":2}`))
	due := hub.Due(connected)
	if len(due) != 1 || string(due[0].Snapshot) != `{"n":2}` || due[0].ConfigurationVersion != 3 {
		t.Fatalf("only the newest snapshot is delivered: %+v", due)
	}
	hub.Delivered(id, due[0].Snapshot)

	// A change within five seconds waits for the interval to pass.
	clock = clock.Add(2 * time.Second)
	hub.Report(id, 3, json.RawMessage(`{"n":3}`))
	if len(hub.Due(connected)) != 0 {
		t.Fatal("changes are throttled to one delivery per five seconds")
	}
	clock = clock.Add(4 * time.Second)
	due = hub.Due(connected)
	if len(due) != 1 || string(due[0].Snapshot) != `{"n":3}` {
		t.Fatalf("due after the interval = %+v", due)
	}
	// A failed attempt is retried after the interval, still with the newest snapshot.
	clock = clock.Add(6 * time.Second)
	hub.Report(id, 3, json.RawMessage(`{"n":4}`))
	due = hub.Due(connected)
	if len(due) != 1 || string(due[0].Snapshot) != `{"n":4}` {
		t.Fatalf("retry = %+v", due)
	}
	hub.Delivered(id, due[0].Snapshot)

	// Unchanged snapshots are not resent before the keep-alive, and only while connected.
	clock = clock.Add(30 * time.Second)
	if len(hub.Due(connected)) != 0 {
		t.Fatal("unchanged snapshot resent too early")
	}
	clock = clock.Add(31 * time.Second)
	if len(hub.Due(disconnected)) != 0 {
		t.Fatal("keep-alive must not be sent while the printer is not connected")
	}
	due = hub.Due(connected)
	if len(due) != 1 {
		t.Fatalf("keep-alive = %+v", due)
	}
	hub.Delivered(id, due[0].Snapshot)

	// A snapshot reported during delivery stays pending; Drop and Reset forget entries.
	hub.Report(id, 3, json.RawMessage(`{"n":5}`))
	hub.Delivered(id, json.RawMessage(`{"n":4}`))
	clock = clock.Add(6 * time.Second)
	if len(hub.Due(connected)) != 1 {
		t.Fatal("a snapshot newer than the delivered one must still be sent")
	}
	hub.Drop(id)
	clock = clock.Add(time.Hour)
	if len(hub.Due(connected)) != 0 {
		t.Fatal("dropped assignment still due")
	}
	hub.Report(id, 4, json.RawMessage(`{"n":6}`))
	hub.Reset()
	if len(hub.Due(connected)) != 0 {
		t.Fatal("reset hub still due")
	}
}

func TestRuntimeDeliversLiveStatusWithoutQueueingAndDropsStaleVersions(t *testing.T) {
	t.Parallel()
	var puts atomic.Int32
	status := atomic.Int32{}
	status.Store(204)
	server, client := liveStatusTestServer(t, &puts, &status)
	defer server.Close()
	runtime := &Runtime{client: client, live: newLiveStatusHub(), health: map[uuid.UUID]AssignmentHealth{}, logger: discardLogger()}
	id := uuid.Must(uuid.NewV7())
	runtime.live.Report(id, 2, json.RawMessage(`{"state":"idle"}`))
	runtime.deliverLiveStatus(context.Background(), Identity{CredentialSecret: "secret"})
	if puts.Load() != 1 {
		t.Fatalf("puts = %d", puts.Load())
	}
	// 409 from Core: the snapshot is discarded, never retried.
	status.Store(409)
	runtime.live.now = func() time.Time { return time.Now().Add(time.Minute) }
	runtime.live.Report(id, 2, json.RawMessage(`{"state":"printing"}`))
	runtime.deliverLiveStatus(context.Background(), Identity{CredentialSecret: "secret"})
	runtime.live.now = func() time.Time { return time.Now().Add(time.Hour) }
	runtime.deliverLiveStatus(context.Background(), Identity{CredentialSecret: "secret"})
	if puts.Load() != 2 {
		t.Fatalf("a rejected snapshot must be dropped, puts = %d", puts.Load())
	}
}

func discardLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func liveStatusTestServer(t *testing.T, puts, status *atomic.Int32) (*httptest.Server, *Client) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || !strings.HasSuffix(r.URL.Path, "/status") || r.Header.Get("Authorization") != "Bearer secret" {
			http.Error(w, "unexpected request", http.StatusTeapot)
			return
		}
		var body struct {
			ProtocolVersion      int             `json:"protocolVersion"`
			ConfigurationVersion int64           `json:"configurationVersion"`
			Status               json.RawMessage `json:"status"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || body.ProtocolVersion != 1 || body.ConfigurationVersion != 2 || len(body.Status) == 0 {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		puts.Add(1)
		code := int(status.Load())
		if code >= 400 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(code)
			_, _ = w.Write([]byte(`{"code":"configuration_version_mismatch"}`))
			return
		}
		w.WriteHeader(code)
	}))
	client, err := NewClient(server.URL, true)
	if err != nil {
		t.Fatal(err)
	}
	return server, client
}

func TestHeartbeatWithNewerRevisionFetchesTheConfigurationImmediately(t *testing.T) {
	t.Parallel()
	var configurationFetches atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/heartbeat"):
			_, _ = w.Write([]byte(`{"configurationRevision":5}`))
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/configuration"):
			configurationFetches.Add(1)
			_, _ = w.Write([]byte(`{"revision":5,"protocolVersion":1,"assignments":[]}`))
		default:
			http.Error(w, "unexpected", http.StatusTeapot)
		}
	}))
	defer server.Close()
	client, err := NewClient(server.URL, true)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	store, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	runtime := NewRuntime(store, client, dir, "", discardLogger())
	runtime.revision = 4
	if err = runtime.sendHeartbeat(context.Background(), Identity{CredentialSecret: "secret"}); err != nil {
		t.Fatal(err)
	}
	if configurationFetches.Load() != 1 || runtime.revision != 5 {
		t.Fatalf("fetches=%d revision=%d", configurationFetches.Load(), runtime.revision)
	}
	// An equal revision does not refetch.
	if err = runtime.sendHeartbeat(context.Background(), Identity{CredentialSecret: "secret"}); err != nil {
		t.Fatal(err)
	}
	if configurationFetches.Load() != 1 {
		t.Fatalf("fetches=%d", configurationFetches.Load())
	}
}
