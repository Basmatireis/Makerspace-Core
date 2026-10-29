package printerconnector

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func testRenderOptions() go2rtcRenderOptions {
	return go2rtcRenderOptions{APIListen: ":1984", LogLevel: LogLevelError, APIUsername: "gwuser", APIPassword: "gwpass"}
}

func TestRenderGo2RTCContents(t *testing.T) {
	rendered, err := renderGo2RTC([]camera{
		{StreamName: "cam-b", SourceURL: "rtspx://bblp:pa%24$ss@192.168.1.31:322/streaming/live/1"},
		{StreamName: "cam-a", SourceURL: "rtspx://bblp:12345678@192.168.1.30:322/streaming/live/1"},
	}, testRenderOptions())
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"api:\n  listen: \":1984\"\n",
		"  username: \"gwuser\"\n  password: \"gwpass\"\n",
		"  allow_paths:\n    - \"/api/streams\"\n    - \"/api/ws\"\n    - \"/api/restart\"\n",
		"log:\n  level: \"error\"\n",
		"exec:\n  allow_paths:\n    - \"/nonexistent-executable\"\n",
		"echo:\n  allow_paths:\n    - \"/nonexistent-executable\"\n",
		"rtsp:\n  listen: \"\"\n",
		"srtp:\n  listen: \"\"\n",
		"webrtc:\n  listen: \"\"\n",
		"  \"cam-a\":\n    - \"rtspx://bblp:12345678@192.168.1.30:322/streaming/live/1\"\n",
	} {
		if !strings.Contains(rendered, want) {
			t.Errorf("rendered config misses %q:\n%s", want, rendered)
		}
	}
	for _, forbidden := range []string{"static_dir", "ui:", "origin:", "ngrok", "/api/config", "/api/webrtc", "candidates"} {
		if strings.Contains(rendered, forbidden) {
			t.Errorf("rendered config must not contain %q", forbidden)
		}
	}
	if strings.Index(rendered, "cam-a") > strings.Index(rendered, "cam-b") {
		t.Error("streams must be sorted by name")
	}
	if strings.Contains(rendered, "$") || !strings.Contains(rendered, "pa%24%24ss") {
		t.Errorf("dollar signs must be percent-encoded because go2rtc expands them:\n%s", rendered)
	}
}

func TestRenderGo2RTCIsDeterministicAndEmptyIsValid(t *testing.T) {
	cameras := []camera{
		{StreamName: "cam-a", SourceURL: "rtspx://bblp:1@10.0.0.1:322/streaming/live/1"},
		{StreamName: "cam-b", SourceURL: "rtspx://bblp:2@10.0.0.2:322/streaming/live/1"},
	}
	first, _ := renderGo2RTC(cameras, testRenderOptions())
	second, _ := renderGo2RTC([]camera{cameras[1], cameras[0]}, testRenderOptions())
	if first != second {
		t.Fatal("rendering must not depend on camera order")
	}
	empty, _ := renderGo2RTC(nil, testRenderOptions())
	if !strings.Contains(empty, "streams: {}") || !strings.Contains(empty, "password") {
		t.Fatalf("empty config = %s", empty)
	}
}

func TestRenderRefusesAnUnauthenticatedAPIAndBadLogLevel(t *testing.T) {
	if _, err := renderGo2RTC(nil, go2rtcRenderOptions{}); err == nil {
		t.Fatal("a configuration without API credentials must not render")
	}
	options := testRenderOptions()
	options.LogLevel = "debug"
	rendered, _ := renderGo2RTC(nil, options)
	if !strings.Contains(rendered, "level: \"error\"") || strings.Contains(rendered, "debug") {
		t.Fatalf("verbose log levels log access codes and must be replaced:\n%s", rendered)
	}
	if !ValidLogLevel(LogLevelFatal) || ValidLogLevel("info") || ValidLogLevel("trace") {
		t.Fatal("only error and fatal are valid log levels")
	}
}

func TestRenderQuotesHostileValues(t *testing.T) {
	rendered, _ := renderGo2RTC(
		[]camera{{StreamName: "cam-x", SourceURL: "rtspx://u:p\"\nstreams:\n  evil: [exec:id]@10.0.0.1:322/x"}},
		testRenderOptions(),
	)
	if strings.Contains(rendered, "\n  evil") {
		t.Fatalf("a source value escaped its YAML scalar:\n%s", rendered)
	}
}

func TestCameraSourceUsesAssignmentSettingsAndSecrets(t *testing.T) {
	assignment := testCameraAssignment("0198f2a4-0000-7000-8000-000000000001", "192.168.1.30", "pa$s:w@rd")
	source, err := cameraSource(assignment)
	if err != nil {
		t.Fatal(err)
	}
	if source.StreamName != "cam-0198f2a4-0000-7000-8000-000000000001" {
		t.Fatalf("stream name = %q", source.StreamName)
	}
	if want := "rtspx://bblp:pa$s%3Aw%40rd@192.168.1.30:322/streaming/live/1"; source.SourceURL != want {
		t.Fatalf("source = %q, want %q", source.SourceURL, want)
	}
	assignment.AdapterKind = AdapterSimulator
	if _, err = cameraSource(assignment); err == nil {
		t.Fatal("only Bambu adapters have a camera source")
	}
	assignment.AdapterKind = AdapterBambuX1C
	assignment.Settings = map[string]any{"ipAddress": "not-an-ip", "serialNumber": "01P00A123456789"}
	if _, err = cameraSource(assignment); err == nil {
		t.Fatal("an invalid printer address must be refused")
	}
}

func TestParseStreamsAndHealth(t *testing.T) {
	statuses, err := parseStreams([]byte(`{
		"cam-live": {"producers":[{"url":"rtspx://bblp:secret@10.0.0.1","receivers":[{"codec":{}}]}],"consumers":[{}]},
		"cam-idle": {"producers":[{"url":"rtspx://bblp:secret@10.0.0.2"}],"consumers":null},
		"cam-down": {"producers":[{"url":"rtspx://bblp:secret@10.0.0.3"}],"consumers":[{}]}
	}`))
	if err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]CameraHealthState{
		"cam-live": CameraLive, "cam-idle": CameraIdle, "cam-down": CameraUnavailable, "cam-missing": CameraUnavailable,
	} {
		status, known := statuses[name]
		if got := cameraHealthFor(status, known); got != want {
			t.Errorf("%s health = %s, want %s", name, got, want)
		}
	}
}

func TestGo2RTCClientAuthenticatesAndMapsWebsocketURL(t *testing.T) {
	var seen []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, password, ok := r.BasicAuth()
		if !ok || user != "u" || password != "p" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		seen = append(seen, r.Method+" "+r.URL.Path)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()
	client, err := newGo2RTCClient(server.URL+"/", "u", "p")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = client.streams(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err = client.restart(context.Background()); err != nil {
		t.Fatal(err)
	}
	if strings.Join(seen, ",") != "GET /api/streams,POST /api/restart" {
		t.Fatalf("requests = %v", seen)
	}
	if got := client.websocketURL("cam-a"); got != "ws"+strings.TrimPrefix(server.URL, "http")+"/api/ws?src=cam-a" {
		t.Fatalf("websocket url = %q", got)
	}
	server.Close()
	if _, err = client.streams(context.Background()); !errors.Is(err, errGo2RTCDown) {
		t.Fatalf("a stopped go2rtc must be reported as down, got %v", err)
	}
	if _, err = newGo2RTCClient("ftp://x", "u", "p"); err == nil {
		t.Fatal("a non-http URL must be refused")
	}
}

func TestCoreWebsocketURLFollowsTheRESTSchemeRule(t *testing.T) {
	plain, err := NewClient("http://core.test:8080/", true)
	if err != nil {
		t.Fatal(err)
	}
	if got := plain.websocketURL(controlPath); got != "ws://core.test:8080/api/v1/printer-connector/self/stream-control" {
		t.Fatalf("url = %q", got)
	}
	secure, err := NewClient("https://core.test", false)
	if err != nil {
		t.Fatal(err)
	}
	if got := secure.websocketURL(sessionPath + "x"); got != "wss://core.test/api/v1/printer-connector/self/stream-sessions/x" {
		t.Fatalf("url = %q", got)
	}
	if _, err = NewClient("http://core.test", false); err == nil {
		t.Fatal("plain HTTP needs CONNECTOR_ALLOW_HTTP")
	}
}
