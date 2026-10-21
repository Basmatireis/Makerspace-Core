package localupdater

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestReleaseVersionsAreStrict(t *testing.T) {
	for _, version := range []string{"0.8.3", "1.0.0", "10.20.30", "0.0.0"} {
		if !ValidVersion(version) {
			t.Errorf("%q should be valid", version)
		}
	}
	for _, version := range []string{
		"", "dev", "v0.8.3", "0.8", "0.8.3.1", "0.8.3-rc.1", "0.8.3+build", "01.2.3", "1.02.3", " 0.8.3",
		"0.8.3\n", "1234567890.0.0", "latest", "0.8.3;rm -rf /", "../0.8.3",
	} {
		if ValidVersion(version) {
			t.Errorf("%q should be invalid", version)
		}
	}
	cases := []struct {
		a, b string
		want int
	}{{"0.8.3", "0.8.3", 0}, {"0.8.4", "0.8.3", 1}, {"0.10.0", "0.9.9", 1}, {"1.0.0", "0.99.99", 1}, {"0.8.2", "0.8.10", -1}}
	for _, c := range cases {
		if got, ok := CompareVersions(c.a, c.b); !ok || got != c.want {
			t.Errorf("compare %s %s = %d %v", c.a, c.b, got, ok)
		}
	}
	if _, ok := CompareVersions("dev", "0.8.3"); ok {
		t.Error("a development build must not compare")
	}
	if Newer("0.8.3", "dev") || Newer("0.8.3", "0.8.3") || !Newer("0.8.4", "0.8.3") {
		t.Error("Newer")
	}
}

func TestRewriteEnvChangesOnlyTheVersionAndDigestPins(t *testing.T) {
	original := "# Release\nMAKERSPACE_VERSION=0.8.2\r\n" +
		"PRINTER_CONNECTOR_DIGEST=@sha256:abc\n" +
		"STREAMING_GATEWAY_DIGEST=\n" +
		"#LOCAL_UPDATER_DIGEST=@sha256:old\n" +
		"CORE_URL=https://makerspace.example.org\n" +
		"CONNECTOR_ENROLLMENT_SECRET=keep-me"
	rewritten, err := RewriteEnv(original, "0.8.3")
	if err != nil {
		t.Fatal(err)
	}
	want := "# Release\nMAKERSPACE_VERSION=0.8.3\r\n" +
		"#PRINTER_CONNECTOR_DIGEST=@sha256:abc # pinned the previous release; cleared by the local updater for 0.8.3\n" +
		"STREAMING_GATEWAY_DIGEST=\n" +
		"#LOCAL_UPDATER_DIGEST=@sha256:old\n" +
		"CORE_URL=https://makerspace.example.org\n" +
		"CONNECTOR_ENROLLMENT_SECRET=keep-me"
	if rewritten != want {
		t.Fatalf("rewritten:\n%q\nwant:\n%q", rewritten, want)
	}
	if version, err := EnvVersion(rewritten); err != nil || version != "0.8.3" {
		t.Fatalf("version after rewrite: %q %v", version, err)
	}
	if version, err := EnvVersion("MAKERSPACE_VERSION=\"0.8.2\"\n"); err != nil || version != "0.8.2" {
		t.Fatalf("quoted version: %q %v", version, err)
	}
	for _, invalid := range []string{
		"CORE_URL=x\n",
		"MAKERSPACE_VERSION=0.8.2\nMAKERSPACE_VERSION=0.8.3\n",
		"MAKERSPACE_VERSION=latest\n",
		"MAKERSPACE_VERSION=${OTHER}\n",
	} {
		if _, err := RewriteEnv(invalid, "0.8.3"); err == nil {
			t.Errorf("%q should be refused", invalid)
		}
	}
	if _, err := RewriteEnv("MAKERSPACE_VERSION=0.8.2\n", "0.8.3\nMAKERSPACE_IMAGE_PREFIX=evil"); err == nil {
		t.Error("a version with a line break must be refused")
	}
}

type fakeRunner struct {
	calls    [][]string
	failPull bool
	failUp   bool
	envSeen  []string
	envPath  string
}

func (f *fakeRunner) Run(_ context.Context, _ string, args ...string) ([]byte, error) {
	f.calls = append(f.calls, args)
	content, _ := os.ReadFile(f.envPath)
	f.envSeen = append(f.envSeen, string(content))
	if len(args) > 3 && args[3] == "pull" && f.failPull {
		return []byte("manifest unknown"), errors.New("exit status 1")
	}
	if len(args) > 3 && args[3] == "up" && f.failUp {
		return nil, errors.New("exit status 1")
	}
	return nil, nil
}

type updaterHarness struct {
	t        *testing.T
	updater  *Updater
	runner   *fakeRunner
	project  string
	exchange Exchange
}

func newUpdaterHarness(t *testing.T, env string) *updaterHarness {
	t.Helper()
	root, project := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(project, ".env"), []byte(env), 0o600); err != nil {
		t.Fatal(err)
	}
	runner := &fakeRunner{envPath: filepath.Join(project, ".env")}
	updater, err := New(
		Config{
			ExchangeRoot: root,
			Components:   []Component{ComponentPrinterConnector},
			Services:     []string{"connector"},
			ProjectDir:   project,
			Version:      "0.8.2",
		},
		runner,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
	)
	if err != nil {
		t.Fatal(err)
	}
	if err = updater.Prepare(); err != nil {
		t.Fatal(err)
	}
	h := &updaterHarness{t: t, updater: updater, runner: runner, project: project}
	h.exchange = NewExchange(root, ComponentPrinterConnector)
	return h
}

func (h *updaterHarness) env() string {
	h.t.Helper()
	content, err := os.ReadFile(filepath.Join(h.project, ".env"))
	if err != nil {
		h.t.Fatal(err)
	}
	return string(content)
}

func (h *updaterHarness) submit(version string) uuid.UUID {
	h.t.Helper()
	id := uuid.Must(uuid.NewV7())
	if err := h.exchange.Submit(Request{RequestID: id, Version: version}); err != nil {
		h.t.Fatal(err)
	}
	return id
}

func TestServiceHandsRequestsOnlyToAPresentUpdater(t *testing.T) {
	root := t.TempDir()
	exchange := NewExchange(root, ComponentStreamingGateway)
	if exchange.Available() || exchange.Report().Available {
		t.Fatal("no updater runs")
	}
	if err := exchange.Submit(Request{RequestID: uuid.Must(uuid.NewV7()), Version: "0.8.3"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "streaming-gateway", requestFile)); !os.IsNotExist(err) {
		t.Fatalf("a request was written without an updater: %v", err)
	}
	if err := exchange.Submit(Request{RequestID: uuid.Must(uuid.NewV7()), Version: "dev"}); err == nil {
		t.Fatal("a development version must be refused")
	}
	// A stale presence file means the updater stopped.
	dir := filepath.Join(root, "streaming-gateway")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := writeJSON(dir, presenceFile, Presence{Version: "0.8.2", UpdatedAt: time.Now().Add(-time.Hour)}, 0o644); err != nil {
		t.Fatal(err)
	}
	if exchange.Available() {
		t.Fatal("a stale presence counts as available")
	}
}

func TestUpdaterInstallsANewerReleaseOnce(t *testing.T) {
	h := newUpdaterHarness(t, "MAKERSPACE_VERSION=0.8.2\nPRINTER_CONNECTOR_DIGEST=@sha256:abc\n")
	h.updater.Poll(t.Context())
	if !h.exchange.Available() {
		t.Fatal("presence missing after a poll")
	}
	id := h.submit("0.8.3")
	h.updater.Poll(t.Context())
	result := h.exchange.Result()
	if result == nil || result.RequestID != id || result.Status != StatusSucceeded || result.Reason != "" {
		t.Fatalf("result: %+v", result)
	}
	if !strings.Contains(h.env(), "MAKERSPACE_VERSION=0.8.3\n") || !strings.Contains(h.env(), "#PRINTER_CONNECTOR_DIGEST=") {
		t.Fatalf(".env: %q", h.env())
	}
	info, err := os.Stat(filepath.Join(h.project, ".env"))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf(".env mode: %v %v", info.Mode(), err)
	}
	want := [][]string{
		{"compose", "--project-directory", h.project, "pull", "connector"},
		{"compose", "--project-directory", h.project, "up", "-d", "--no-build", "connector"},
	}
	if len(h.runner.calls) != 2 || strings.Join(h.runner.calls[0], " ") != strings.Join(want[0], " ") ||
		strings.Join(h.runner.calls[1], " ") != strings.Join(want[1], " ") {
		t.Fatalf("calls: %v", h.runner.calls)
	}
	if !strings.Contains(h.runner.envSeen[0], "0.8.3") {
		t.Fatal("compose pull ran before .env was rewritten")
	}
	// The same request is never handled twice.
	h.updater.Poll(t.Context())
	if len(h.runner.calls) != 2 {
		t.Fatalf("handled again: %v", h.runner.calls)
	}
	report := h.exchange.Report()
	if !report.Available || report.Result == nil || report.Result.RequestID != id || report.Result.Status != StatusSucceeded {
		t.Fatalf("report: %+v", report)
	}
}

func TestUpdaterRestoresTheEnvAndDoesNotRetryAFailedPull(t *testing.T) {
	original := "MAKERSPACE_VERSION=0.8.2\nCORE_URL=https://makerspace.example.org\n"
	h := newUpdaterHarness(t, original)
	h.runner.failPull = true
	h.updater.Poll(t.Context())
	id := h.submit("0.8.3")
	h.updater.Poll(t.Context())
	result := h.exchange.Result()
	if result == nil || result.RequestID != id || result.Status != StatusFailed || result.Reason != ReasonPullFailed {
		t.Fatalf("result: %+v", result)
	}
	if h.env() != original {
		t.Fatalf(".env not restored: %q", h.env())
	}
	for range 3 {
		h.updater.Poll(t.Context())
	}
	if len(h.runner.calls) != 1 {
		t.Fatalf("a failed request was retried: %v", h.runner.calls)
	}
	// Only a new request (a new click in Core) tries again.
	h.runner.failPull = false
	second := h.submit("0.8.3")
	h.updater.Poll(t.Context())
	if result = h.exchange.Result(); result == nil || result.RequestID != second || result.Status != StatusSucceeded {
		t.Fatalf("second result: %+v", result)
	}
}

func TestUpdaterRecreatesThePreviousReleaseWhenUpFails(t *testing.T) {
	original := "MAKERSPACE_VERSION=0.8.2\n"
	h := newUpdaterHarness(t, original)
	h.runner.failUp = true
	h.updater.Poll(t.Context())
	h.submit("0.8.3")
	h.updater.Poll(t.Context())
	if result := h.exchange.Result(); result == nil || result.Status != StatusFailed || result.Reason != ReasonUpFailed {
		t.Fatalf("result: %+v", result)
	}
	if h.env() != original || len(h.runner.calls) != 3 || !strings.Contains(h.runner.envSeen[2], "0.8.2") {
		t.Fatalf("env %q calls %v", h.env(), h.runner.calls)
	}
}

func TestUpdaterRefusesDowngradesAndForgedRequests(t *testing.T) {
	h := newUpdaterHarness(t, "MAKERSPACE_VERSION=0.8.3\n")
	h.updater.Poll(t.Context())
	h.submit("0.8.2")
	h.updater.Poll(t.Context())
	if result := h.exchange.Result(); result == nil || result.Status != StatusFailed || result.Reason != ReasonDowngradeRefused {
		t.Fatalf("downgrade: %+v", result)
	}
	h.submit("0.8.3")
	h.updater.Poll(t.Context())
	if result := h.exchange.Result(); result == nil || result.Status != StatusSucceeded || result.Reason != ReasonAlreadyInstalled {
		t.Fatalf("same version: %+v", result)
	}
	// A request file written past the service's validation (or with extra fields) is not followed.
	dir := filepath.Join(h.updater.config.ExchangeRoot, string(ComponentPrinterConnector))
	forged := map[string]any{"requestId": uuid.Must(uuid.NewV7()), "version": "9.9.9", "image": "evil/image"}
	data, _ := json.Marshal(forged)
	if err := os.WriteFile(filepath.Join(dir, requestFile), data, 0o644); err != nil {
		t.Fatal(err)
	}
	h.updater.Poll(t.Context())
	forgedVersion := Request{RequestID: uuid.Must(uuid.NewV7()), Version: "9.9.9 --all"}
	data, _ = json.Marshal(forgedVersion)
	if err := os.WriteFile(filepath.Join(dir, requestFile), data, 0o644); err != nil {
		t.Fatal(err)
	}
	h.updater.Poll(t.Context())
	if result := h.exchange.Result(); result == nil || result.RequestID != forgedVersion.RequestID || result.Reason != ReasonInvalidRequest {
		t.Fatalf("forged version: %+v", result)
	}
	if len(h.runner.calls) != 0 || h.env() != "MAKERSPACE_VERSION=0.8.3\n" {
		t.Fatalf("forged requests ran compose: %v %q", h.runner.calls, h.env())
	}
}

func TestUpdaterFailsAnInterruptedUpdateInsteadOfResumingIt(t *testing.T) {
	h := newUpdaterHarness(t, "MAKERSPACE_VERSION=0.8.2\n")
	dir := filepath.Join(h.updater.config.ExchangeRoot, string(ComponentPrinterConnector))
	id := uuid.Must(uuid.NewV7())
	if err := writeJSON(dir, requestFile, Request{RequestID: id, Version: "0.8.3"}, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := writeJSON(dir, resultFile, Result{RequestID: id, Version: "0.8.3", Status: StatusInProgress}, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := h.updater.Prepare(); err != nil {
		t.Fatal(err)
	}
	h.updater.Poll(t.Context())
	if result := h.exchange.Result(); result == nil || result.Status != StatusFailed || result.Reason != ReasonInterrupted {
		t.Fatalf("result: %+v", result)
	}
	if len(h.runner.calls) != 0 {
		t.Fatalf("interrupted update was resumed: %v", h.runner.calls)
	}
}

func TestUpdaterConfigurationIsValidated(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	base := Config{ExchangeRoot: "/x", Components: []Component{ComponentPrinterConnector}, Services: []string{"connector"}, ProjectDir: "/srv/bundle"}
	for name, change := range map[string]func(*Config){
		"service with options": func(c *Config) { c.Services = []string{"--all"} },
		"no services":          func(c *Config) { c.Services = nil },
		"unknown component":    func(c *Config) { c.Components = []Component{"backend"} },
		"relative project":     func(c *Config) { c.ProjectDir = "bundle" },
		"unclean project":      func(c *Config) { c.ProjectDir = "/srv/../etc" },
	} {
		config := base
		change(&config)
		if _, err := New(config, &fakeRunner{}, logger); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if _, err := New(base, &fakeRunner{}, logger); err != nil {
		t.Fatal(err)
	}
}

type inspectRunner struct{ output string }

func (r inspectRunner) Run(context.Context, string, ...string) ([]byte, error) {
	return []byte(r.output), nil
}

func TestProjectDirectoryMapsTheHostPathOntoTheMount(t *testing.T) {
	mount := t.TempDir()
	host := filepath.Join(t.TempDir(), "srv", "makerspace-connector")
	output := `[{"Type":"volume","Source":"/var/lib/docker/volumes/x","Destination":"/var/lib/makerspace-updater"},` +
		`{"Type":"bind","Source":"` + host + `","Destination":"` + mount + `"}]`
	dir, err := ProjectDirectory(t.Context(), inspectRunner{output}, "0123456789ab", mount)
	if err != nil || dir != host {
		t.Fatalf("dir %q err %v", dir, err)
	}
	if target, err := os.Readlink(host); err != nil || target != mount {
		t.Fatalf("link %q %v", target, err)
	}
	// Running again (after a restart of the process) finds the same link.
	if again, err := ProjectDirectory(t.Context(), inspectRunner{output}, "0123456789ab", mount); err != nil || again != host {
		t.Fatalf("again %q %v", again, err)
	}
	if _, err = ProjectDirectory(t.Context(), inspectRunner{"[]"}, "0123456789ab", mount); err == nil {
		t.Fatal("a missing bind mount must fail")
	}
	if _, err = ProjectDirectory(t.Context(), inspectRunner{output}, "--format=x", mount); err == nil {
		t.Fatal("an option as container id must fail")
	}
	occupied := t.TempDir()
	output = `[{"Type":"bind","Source":"` + occupied + `","Destination":"` + mount + `"}]`
	if _, err = ProjectDirectory(t.Context(), inspectRunner{output}, "0123456789ab", mount); err == nil {
		t.Fatal("an existing directory at the host path must fail")
	}
}
