package printerconnector

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/localupdater"
	"github.com/gorilla/websocket"
)

const (
	testCameraID      = "0198f2a4-0000-7000-8000-000000000001"
	testOtherCameraID = "0198f2a4-0000-7000-8000-000000000002"
)

func testCameraAssignment(id, ip, accessCode string) RuntimeAssignment {
	return RuntimeAssignment{
		ID:          id,
		AdapterKind: AdapterBambuH2D,
		Settings:    map[string]any{"ipAddress": ip, "serialNumber": "01P00A123456789"},
		Secrets:     map[string]string{"lanAccessCode": accessCode},
		Enabled:     true, CameraStreaming: true,
	}
}

// fakeGo2RTC stands in for go2rtc's HTTP API: stream list, restart and the MSE websocket.
type fakeGo2RTC struct {
	*httptest.Server
	mu       sync.Mutex
	streams  string
	restarts atomic.Int32
	// onWebsocket runs for every accepted /api/ws connection.
	onWebsocket func(conn *websocket.Conn, source string)
	auth        chan string
}

func newFakeGo2RTC(t *testing.T, username, password string) *fakeGo2RTC {
	t.Helper()
	fake := &fakeGo2RTC{streams: `{}`, auth: make(chan string, 16)}
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	fake.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, pass, ok := r.BasicAuth()
		if !ok || user != username || pass != password {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/api/streams":
			fake.mu.Lock()
			body := fake.streams
			fake.mu.Unlock()
			_, _ = io.WriteString(w, body)
		case "/api/restart":
			fake.restarts.Add(1)
		case "/api/ws":
			conn, err := upgrader.Upgrade(w, r, nil)
			if err != nil {
				return
			}
			fake.auth <- user
			if fake.onWebsocket != nil {
				fake.onWebsocket(conn, r.URL.Query().Get("src"))
			}
			_ = conn.Close()
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(fake.Close)
	return fake
}

func (f *fakeGo2RTC) setStreams(body string) {
	f.mu.Lock()
	f.streams = body
	f.mu.Unlock()
}

// newTestCameraRuntime opens a store and a runtime with camera streaming against a fake go2rtc that uses the
// credentials stored for it.
func newTestCameraRuntime(t *testing.T, core *Client) (*Runtime, *fakeGo2RTC, string) {
	t.Helper()
	dir := t.TempDir()
	store, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	credentials, err := store.go2rtcCredentials(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	fake := newFakeGo2RTC(t, credentials.Username, credentials.Password)
	runtime := NewRuntime(store, core, dir, Enrollment{}, localupdater.Exchange{}, discardLogger())
	configFile := filepath.Join(dir, "go2rtc", "go2rtc.yaml")
	if err = runtime.EnableCameras(context.Background(), CameraOptions{APIURL: fake.URL, ConfigFile: configFile}); err != nil {
		t.Fatal(err)
	}
	return runtime, fake, configFile
}

func TestGo2RTCCredentialsAreGeneratedOnceAndStoredSealed(t *testing.T) {
	dir := t.TempDir()
	store, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	first, err := store.go2rtcCredentials(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if first.Username == "" || len(first.Password) < 32 {
		t.Fatalf("credentials = %+v", first)
	}
	var raw []byte
	if err = store.db.QueryRow(`SELECT value FROM metadata WHERE key='go2rtc_api'`).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), first.Password) {
		t.Fatal("the password must be stored sealed")
	}
	_ = store.Close()
	reopened, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reopened.Close() }()
	second, err := reopened.go2rtcCredentials(context.Background())
	if err != nil || second != first {
		t.Fatalf("credentials changed across restarts: %+v %v", second, err)
	}
}

func TestApplyRendersOnlyCameraStreamingAssignmentsAndRestartsOnChange(t *testing.T) {
	runtime, fake, configFile := newTestCameraRuntime(t, nil)
	ctx := context.Background()
	disabled := testCameraAssignment(testOtherCameraID, "192.168.1.31", "87654321")
	disabled.CameraStreaming = false
	simulator := testCameraAssignment("0198f2a4-0000-7000-8000-000000000003", "192.168.1.32", "x")
	simulator.AdapterKind = AdapterSimulator
	assignments := []RuntimeAssignment{testCameraAssignment(testCameraID, "192.168.1.30", "12345678"), disabled, simulator}

	runtime.cameras.Apply(ctx, assignments)
	rendered, err := os.ReadFile(configFile)
	if err != nil {
		t.Fatal(err)
	}
	text := string(rendered)
	if !strings.Contains(text, "\"cam-"+testCameraID+"\"") || !strings.Contains(text, "192.168.1.30:322") {
		t.Fatalf("configured camera missing:\n%s", text)
	}
	if strings.Contains(text, testOtherCameraID) || strings.Contains(text, "192.168.1.31") || strings.Contains(text, "192.168.1.32") {
		t.Fatalf("only assignments with cameraStreaming on a Bambu adapter are rendered:\n%s", text)
	}
	info, err := os.Stat(configFile)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("config file mode = %v, %v", info.Mode().Perm(), err)
	}
	if fake.restarts.Load() != 1 {
		t.Fatalf("restarts = %d, want 1", fake.restarts.Load())
	}

	runtime.cameras.Apply(ctx, assignments)
	if fake.restarts.Load() != 1 {
		t.Fatalf("an unchanged configuration must not restart go2rtc, restarts = %d", fake.restarts.Load())
	}
	assignments[0] = testCameraAssignment(testCameraID, "192.168.1.30", "changed01")
	runtime.cameras.Apply(ctx, assignments)
	if fake.restarts.Load() != 2 {
		t.Fatalf("a changed access code must restart go2rtc, restarts = %d", fake.restarts.Load())
	}
	if got := runtime.cameras.relay.Viewers("cam-" + testCameraID); got != 0 {
		t.Fatalf("viewers = %d", got)
	}
}

func TestApplyDoesNotRestartWhenTheFileAlreadyMatches(t *testing.T) {
	runtime, fake, configFile := newTestCameraRuntime(t, nil)
	ctx := context.Background()
	assignments := []RuntimeAssignment{testCameraAssignment(testCameraID, "192.168.1.30", "12345678")}
	runtime.cameras.Apply(ctx, assignments)
	// A restarted connector finds the file it wrote and leaves go2rtc alone.
	again, err := newCameraService(ctx, runtime.store, nil, func() string { return "" },
		CameraOptions{APIURL: fake.URL, ConfigFile: configFile}, discardLogger())
	if err != nil {
		t.Fatal(err)
	}
	again.Apply(ctx, assignments)
	if fake.restarts.Load() != 1 {
		t.Fatalf("restarts = %d, want 1", fake.restarts.Load())
	}
}

func TestCameraServiceRejectsVerboseLogLevelAndMissingFile(t *testing.T) {
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	ctx := context.Background()
	if _, err = newCameraService(ctx, store, nil, nil, CameraOptions{APIURL: "http://go2rtc:1984"}, discardLogger()); err == nil {
		t.Fatal("a configuration file is required")
	}
	if _, err = newCameraService(ctx, store, nil, nil,
		CameraOptions{APIURL: "http://go2rtc:1984", ConfigFile: "/tmp/x.yaml", LogLevel: "debug"}, discardLogger()); err == nil {
		t.Fatal("a verbose log level would log access codes")
	}
}

func TestHealthReportsEachConfiguredCamera(t *testing.T) {
	runtime, fake, _ := newTestCameraRuntime(t, nil)
	ctx := context.Background()
	if runtime.cameras.Health(ctx) != nil {
		t.Fatal("without cameras nothing is reported")
	}
	runtime.cameras.Apply(ctx, []RuntimeAssignment{
		testCameraAssignment(testCameraID, "192.168.1.30", "12345678"),
		testCameraAssignment(testOtherCameraID, "192.168.1.31", "12345678"),
	})
	fake.setStreams(`{"cam-` + testCameraID + `":{"producers":[{"url":"rtspx://x","receivers":[{}]}],"consumers":[{}]},` +
		`"cam-` + testOtherCameraID + `":{"producers":[{"url":"rtspx://y"}],"consumers":null}}`)
	health := runtime.cameras.Health(ctx)
	if len(health) != 2 || health[0].AssignmentID != testCameraID || health[0].Health != CameraLive ||
		health[1].AssignmentID != testOtherCameraID || health[1].Health != CameraIdle {
		t.Fatalf("health = %+v", health)
	}
	fake.setStreams(`{}`)
	if health = runtime.cameras.Health(ctx); health[0].Health != CameraUnavailable {
		t.Fatalf("a stream go2rtc does not know is unavailable: %+v", health)
	}
	fake.Close()
	for _, item := range runtime.cameras.Health(ctx) {
		if item.Health != CameraUnavailable {
			t.Fatalf("an unreachable go2rtc makes every camera unavailable: %+v", item)
		}
	}
}

func TestHeartbeatCarriesCameraHealthOnlyWhenStreamingIsEnabled(t *testing.T) {
	var mu sync.Mutex
	var bodies []map[string]any
	core := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		bodies = append(bodies, body)
		mu.Unlock()
		_, _ = w.Write([]byte(`{"configurationRevision":0}`))
	}))
	defer core.Close()
	client, err := NewClient(core.URL, true)
	if err != nil {
		t.Fatal(err)
	}

	plainDir := t.TempDir()
	plainStore, err := OpenStore(plainDir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = plainStore.Close() }()
	plain := NewRuntime(plainStore, client, plainDir, Enrollment{}, localupdater.Exchange{}, discardLogger())
	if err = plain.sendHeartbeat(context.Background(), Identity{CredentialSecret: "token"}); err != nil {
		t.Fatal(err)
	}

	runtime, fake, _ := newTestCameraRuntime(t, client)
	ctx := context.Background()
	runtime.cameras.Apply(ctx, []RuntimeAssignment{testCameraAssignment(testCameraID, "192.168.1.30", "12345678")})
	fake.setStreams(`{"cam-` + testCameraID + `":{"producers":[{"url":"rtspx://x","receivers":[{}]}],"consumers":[{}]}}`)
	if err = runtime.sendHeartbeat(ctx, Identity{CredentialSecret: "token"}); err != nil {
		t.Fatal(err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(bodies) != 2 {
		t.Fatalf("heartbeats = %d", len(bodies))
	}
	if _, present := bodies[0]["cameras"]; present {
		t.Fatalf("a connector without streaming reports no cameras: %v", bodies[0])
	}
	cameras, _ := bodies[1]["cameras"].([]any)
	if len(cameras) != 1 {
		t.Fatalf("cameras = %v", bodies[1]["cameras"])
	}
	entry, _ := cameras[0].(map[string]any)
	if entry["assignmentId"] != testCameraID || entry["health"] != "live" || entry["viewers"] != float64(0) {
		t.Fatalf("camera entry = %v", entry)
	}
	if strings.Contains(string(mustMarshalJSON(t, bodies[1])), "12345678") {
		t.Fatal("the access code must never reach Core")
	}
}

func mustMarshalJSON(t *testing.T, value any) []byte {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}
