package streaminggateway

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
)

type fakeCore struct {
	mu            sync.Mutex
	configuration Configuration
	err           error
	heartbeats    []Heartbeat
}

func (c *fakeCore) Enroll(_ context.Context, _ string, identity Identity, _ string) (Identity, error) {
	identity.Enrolled, identity.GatewayID = true, uuid.Must(uuid.NewV7())
	return identity, nil
}
func (c *fakeCore) Configuration(context.Context, string) (Configuration, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.configuration, c.err
}
func (c *fakeCore) Heartbeat(_ context.Context, _ string, input Heartbeat) (int64, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.heartbeats = append(c.heartbeats, input)
	return 0, c.err
}
func (c *fakeCore) RotateCredential(_ context.Context, _ string, identity Identity) (Identity, error) {
	return identity, nil
}
func (c *fakeCore) set(configuration Configuration, err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.configuration, c.err = configuration, err
}

type fakeGo2RTC struct {
	streams  map[string]StreamStatus
	err      error
	restarts int
	restart  error
}

func (g *fakeGo2RTC) Streams(context.Context) (map[string]StreamStatus, error) {
	return g.streams, g.err
}
func (g *fakeGo2RTC) Restart(context.Context) error { g.restarts++; return g.restart }

func testConfiguration(revision int64, names ...string) Configuration {
	configuration := Configuration{Revision: revision, ProtocolVersion: ProtocolVersion, PublicHost: "gw.example.org", Cameras: []Camera{}, TicketPublicKeys: []TicketKey{}}
	for _, name := range names {
		configuration.Cameras = append(configuration.Cameras, Camera{MachineID: uuid.Must(uuid.NewV7()).String(), Name: name, StreamName: "cam-" + name, SourceURL: "rtspx://bblp:12345678@10.0.0.9:322/streaming/live/1"})
	}
	return configuration
}

func newTestGateway(t *testing.T) (*Gateway, *fakeCore, *fakeGo2RTC, Options) {
	t.Helper()
	dir := t.TempDir()
	store, err := OpenStore(filepath.Join(dir, "data"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	options := Options{DataDir: filepath.Join(dir, "data"), ConfigFile: filepath.Join(dir, "g2r", "go2rtc.yaml"), Render: DefaultRenderOptions(), AllowedOrigin: testOrigin}
	core, g2r := &fakeCore{}, &fakeGo2RTC{streams: map[string]StreamStatus{}}
	return New(store, core, g2r, options, slog.New(slog.NewTextHandler(io.Discard, nil))), core, g2r, options
}

func TestConfigurationIsRetainedWhileCoreIsUnreachable(t *testing.T) {
	g, core, g2r, options := newTestGateway(t)
	ctx := context.Background()
	core.set(testConfiguration(7, "a", "b"), nil)
	if err := g.Sync(ctx, Identity{CredentialSecret: "x"}); err != nil {
		t.Fatal(err)
	}
	written, err := os.ReadFile(options.ConfigFile)
	if err != nil || !strings.Contains(string(written), "cam-a") || !strings.Contains(string(written), "cam-b") {
		t.Fatalf("go2rtc config not written: %v\n%s", err, written)
	}
	if _, ok := g.Snapshot().Streams["cam-a"]; !ok || g2r.restarts != 1 {
		t.Fatalf("snapshot %v restarts %d", g.Snapshot().Streams, g2r.restarts)
	}
	for _, failure := range []error{errors.New("dial tcp: connection refused"), &CoreError{Status: 503, Code: "unavailable"}, &CoreError{Status: 500, Code: "internal"}} {
		core.set(Configuration{}, failure)
		if err = g.Sync(ctx, Identity{CredentialSecret: "x"}); err == nil {
			t.Fatal("sync should report the failure")
		}
		if _, ok := g.Snapshot().Streams["cam-a"]; !ok {
			t.Fatalf("configuration lost after %v", failure)
		}
		after, _ := os.ReadFile(options.ConfigFile)
		if string(after) != string(written) || g2r.restarts != 1 {
			t.Fatal("go2rtc was reconfigured while Core was unreachable")
		}
	}
	heartbeat := g.BuildHeartbeat(ctx)
	if heartbeat.HealthState != "connected" && heartbeat.HealthSummary == nil {
		t.Fatalf("heartbeat = %+v", heartbeat)
	}
	if heartbeat.HealthSummary == nil || *heartbeat.HealthSummary != "core_error" {
		t.Fatalf("the last sync failure should be visible, got %+v", heartbeat.HealthSummary)
	}
}

func TestConfigurationSurvivesRestartOfTheDaemon(t *testing.T) {
	g, core, _, options := newTestGateway(t)
	core.set(testConfiguration(3, "a"), nil)
	if err := g.Sync(context.Background(), Identity{CredentialSecret: "x"}); err != nil {
		t.Fatal(err)
	}
	g.store.Close()
	reopened, err := OpenStore(options.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if cached := reopened.Configuration(); cached == nil || cached.Revision != 3 || len(cached.Cameras) != 1 {
		t.Fatalf("cached configuration = %+v", cached)
	}
	raw, _ := os.ReadFile(filepath.Join(options.DataDir, "state.enc"))
	if strings.Contains(string(raw), "12345678") || strings.Contains(string(raw), "rtspx") {
		t.Fatal("state file must be encrypted")
	}
}

func TestGo2RTCRestartsOnlyWhenTheRenderedConfigChanges(t *testing.T) {
	g, core, g2r, _ := newTestGateway(t)
	ctx := context.Background()
	configuration := testConfiguration(1, "a")
	core.set(configuration, nil)
	_ = g.Sync(ctx, Identity{})
	// Same cameras, new revision and a rotated key: go2rtc is not touched.
	configuration.Revision = 2
	configuration.TicketPublicKeys = []TicketKey{{KeyID: "kid12345", PublicKey: "AAAA"}}
	core.set(configuration, nil)
	_ = g.Sync(ctx, Identity{})
	if g2r.restarts != 1 {
		t.Fatalf("restarts = %d, want 1", g2r.restarts)
	}
	core.set(testConfiguration(3, "a", "b"), nil)
	_ = g.Sync(ctx, Identity{})
	if g2r.restarts != 2 {
		t.Fatalf("restarts = %d, want 2", g2r.restarts)
	}
}

func TestRestartFailureIsRetriedAndDownGo2RTCIsNot(t *testing.T) {
	g, core, g2r, _ := newTestGateway(t)
	ctx := context.Background()
	g2r.restart = ErrGo2RTCDown
	core.set(testConfiguration(1, "a"), nil)
	_ = g.Sync(ctx, Identity{})
	_ = g.Sync(ctx, Identity{})
	if g2r.restarts != 1 {
		t.Fatalf("a go2rtc that is not running reads the file itself; restarts = %d", g2r.restarts)
	}
	g2r.restart = errors.New("boom")
	core.set(testConfiguration(2, "b"), nil)
	for range 6 {
		_ = g.Sync(ctx, Identity{})
	}
	if g2r.restarts != 1+maxRestartAttempts {
		t.Fatalf("restart attempts = %d, want bounded at %d", g2r.restarts-1, maxRestartAttempts)
	}
}

func TestRevokedCredentialSwitchesStreamingOff(t *testing.T) {
	g, core, _, options := newTestGateway(t)
	ctx := context.Background()
	core.set(testConfiguration(1, "a"), nil)
	_ = g.Sync(ctx, Identity{})
	core.set(Configuration{}, &CoreError{Status: http.StatusUnauthorized, Code: "unauthenticated"})
	for range authFailuresBeforeShutdown - 1 {
		_ = g.Sync(ctx, Identity{})
	}
	if _, ok := g.Snapshot().Streams["cam-a"]; !ok {
		t.Fatal("a single 401 must not switch streaming off")
	}
	_ = g.Sync(ctx, Identity{})
	if len(g.Snapshot().Streams) != 0 || len(g.Snapshot().Keys) != 0 {
		t.Fatal("repeated 401 means revoked: serve nothing")
	}
	written, _ := os.ReadFile(options.ConfigFile)
	if strings.Contains(string(written), "cam-a") || strings.Contains(string(written), "12345678") {
		t.Fatal("camera credentials must be removed from the go2rtc config")
	}
	if cached := g.store.Configuration(); cached == nil || len(cached.Cameras) != 0 {
		t.Fatal("the stored configuration must be cleared too")
	}
}

func TestHeartbeatReportsCameraHealth(t *testing.T) {
	g, core, g2r, _ := newTestGateway(t)
	ctx := context.Background()
	configuration := testConfiguration(1, "live", "idle", "gone")
	core.set(configuration, nil)
	_ = g.Sync(ctx, Identity{})
	codec := "h264"
	g2r.streams = map[string]StreamStatus{
		"cam-live": {Producers: 1, Receivers: 1, Consumers: 2, Codec: &codec},
		"cam-idle": {Producers: 1},
	}
	heartbeat := g.BuildHeartbeat(ctx)
	health := map[string]CameraHealth{}
	for _, camera := range heartbeat.Cameras {
		for _, c := range configuration.Cameras {
			if c.MachineID == camera.MachineID {
				health[c.Name] = camera
			}
		}
	}
	if health["live"].Health != "live" || health["live"].Viewers != 2 || health["idle"].Health != "idle" || health["gone"].Health != "unavailable" || heartbeat.HealthState != "connected" {
		t.Fatalf("heartbeat = %+v", heartbeat)
	}
	g2r.err = ErrGo2RTCDown
	down := g.BuildHeartbeat(ctx)
	if down.HealthState != "degraded" || down.HealthSummary == nil || *down.HealthSummary != "go2rtc_unreachable" {
		t.Fatalf("down heartbeat = %+v", down)
	}
	for _, camera := range down.Cameras {
		if camera.Health != "unavailable" {
			t.Fatalf("camera %+v must be unavailable while go2rtc is down", camera)
		}
	}
}

func TestEnrollmentUsesSecretFileOnceAndPersistsIdentity(t *testing.T) {
	g, _, _, options := newTestGateway(t)
	secretFile := filepath.Join(t.TempDir(), "enrollment")
	if err := os.WriteFile(secretFile, []byte("  one-time-secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	g.options.EnrollmentFile = secretFile
	identity, err := g.ensureIdentity(context.Background())
	if err != nil || !identity.Enrolled || identity.GatewayID == uuid.Nil {
		t.Fatalf("identity %+v err %v", identity, err)
	}
	if err = os.Remove(secretFile); err != nil {
		t.Fatal(err)
	}
	again, err := g.ensureIdentity(context.Background())
	if err != nil || again.CredentialID != identity.CredentialID {
		t.Fatalf("second start must not need the enrollment file: %v", err)
	}
	raw, _ := os.ReadFile(filepath.Join(options.DataDir, "state.enc"))
	if strings.Contains(string(raw), identity.CredentialSecret) {
		t.Fatal("credential must not be stored in plain text")
	}
}

func TestHealthcheckGoesStale(t *testing.T) {
	g, _, _, options := newTestGateway(t)
	if err := CheckHealth(options.DataDir); err == nil {
		t.Fatal("no health file means unhealthy")
	}
	if err := g.writeHealth("healthy"); err != nil {
		t.Fatal(err)
	}
	if err := CheckHealth(options.DataDir); err != nil {
		t.Fatal(err)
	}
	if err := g.writeHealth("failing"); err != nil {
		t.Fatal(err)
	}
	if err := CheckHealth(options.DataDir); err == nil {
		t.Fatal("non-healthy status must fail")
	}
}
