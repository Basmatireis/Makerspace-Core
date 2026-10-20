package streaminggateway

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRenderGo2RTCContents(t *testing.T) {
	options := DefaultRenderOptions()
	options.WebRTCCandidates = []string{"192.168.1.20:8555"}
	options.APIUsername, options.APIPassword = "gwuser", "gwpass"
	rendered := RenderGo2RTC([]Camera{
		{StreamName: "cam-b", SourceURL: "rtspx://bblp:pa%24$ss@192.168.1.31:322/streaming/live/1"},
		{StreamName: "cam-a", SourceURL: "rtspx://bblp:12345678@192.168.1.30:322/streaming/live/1"},
	}, options)
	for _, want := range []string{
		"api:\n  listen: \":1984\"\n",
		"webrtc:\n  listen: \":8555\"\n  candidates:\n    - \"192.168.1.20:8555\"\n",
		"rtsp:\n  listen: \"\"\n",
		"log:\n  level: \"error\"\n",
		"  username: \"gwuser\"\n  password: \"gwpass\"\n",
		"  allow_paths:\n    - \"/api/streams\"\n    - \"/api/webrtc\"\n    - \"/api/ws\"\n    - \"/api/restart\"\n",
		"exec:\n  allow_paths:\n    - \"/nonexistent-executable\"\n",
		"echo:\n  allow_paths:\n    - \"/nonexistent-executable\"\n",
		"  \"cam-a\":\n    - \"rtspx://bblp:12345678@192.168.1.30:322/streaming/live/1\"\n",
	} {
		if !strings.Contains(rendered, want) {
			t.Errorf("rendered config misses %q:\n%s", want, rendered)
		}
	}
	for _, forbidden := range []string{
		"static_dir",
		"ui:",
		"origin:",
		"ngrok",
		"local_auth",
		"/api/config",
		"/api/stream.mp4",
	} {
		if strings.Contains(rendered, forbidden) {
			t.Errorf("rendered config must not contain %q", forbidden)
		}
	}
	if strings.Index(rendered, "cam-a") > strings.Index(rendered, "cam-b") {
		t.Error("streams must be sorted by name")
	}
	if strings.Contains(rendered, "$") {
		t.Errorf("a literal dollar sign would be expanded by go2rtc:\n%s", rendered)
	}
	if !strings.Contains(rendered, "pa%24%24ss") {
		t.Errorf("dollar signs must be percent-encoded:\n%s", rendered)
	}
}

func TestRenderGo2RTCIsDeterministicAndEmptyIsValid(t *testing.T) {
	cameras := []Camera{
		{StreamName: "cam-a", SourceURL: "rtspx://bblp:1@10.0.0.1:322/streaming/live/1"},
		{StreamName: "cam-b", SourceURL: "rtspx://bblp:2@10.0.0.2:322/streaming/live/1"},
	}
	reversed := []Camera{cameras[1], cameras[0]}
	options := DefaultRenderOptions()
	if RenderGo2RTC(cameras, options) != RenderGo2RTC(reversed, options) {
		t.Fatal("rendering must not depend on camera order")
	}
	empty := RenderGo2RTC(nil, options)
	if !strings.Contains(empty, "streams: {}") || strings.Contains(empty, "candidates") {
		t.Fatalf("empty config = %s", empty)
	}
}

func TestRenderQuotesHostileValues(t *testing.T) {
	rendered := RenderGo2RTC(
		[]Camera{{StreamName: "cam-x", SourceURL: "rtspx://u:p\"\nstreams:\n  evil: [exec:id]@10.0.0.1:322/x"}},
		DefaultRenderOptions(),
	)
	if strings.Contains(rendered, "\n  evil") {
		t.Fatalf("a source value escaped its YAML scalar:\n%s", rendered)
	}
}

func TestParseStreamsNeverReadsProducerURLs(t *testing.T) {
	body := []byte(`{
		"cam-a": {"producers":[{"url":"rtspx://bblp:secret@10.0.0.1:322/x","receivers":[{"codec":{"codec_name":"h264","width":1920,"height":1080,"fps":30}}]}],"consumers":[{},{}]},
		"cam-b": {"producers":[{"url":"rtspx://bblp:secret@10.0.0.2:322/x"}],"consumers":null},
		"cam-c": {"producers":null,"consumers":[{}]}
	}`)
	streams, err := ParseStreams(body)
	if err != nil {
		t.Fatal(err)
	}
	a := streams["cam-a"]
	if a.Consumers != 2 || a.Receivers != 1 || a.Codec == nil || *a.Codec != "h264" || a.Width == nil ||
		*a.Width != 1920 ||
		a.FPS == nil ||
		*a.FPS != 30 {
		t.Fatalf("cam-a = %+v", a)
	}
	if HealthFor(a, true) != "live" || HealthFor(streams["cam-b"], true) != "idle" ||
		HealthFor(streams["cam-c"], true) != "unavailable" ||
		HealthFor(StreamStatus{}, false) != "unavailable" {
		t.Fatal("unexpected health mapping")
	}
}

func TestRenderRefusesVerboseLogLevels(t *testing.T) {
	for _, level := range []LogLevel{"info", "debug", "trace", "warn", ""} {
		options := DefaultRenderOptions()
		options.LogLevel = level
		if rendered := RenderGo2RTC(nil, options); !strings.Contains(rendered, "log:\n  level: \"error\"\n") {
			t.Errorf("level %q rendered as:\n%s", level, rendered)
		}
	}
	if !ValidLogLevel("error") || !ValidLogLevel("fatal") || ValidLogLevel("info") || ValidLogLevel("debug") {
		t.Fatal("only error and fatal are valid log levels")
	}
}

func TestGo2RTCClientSendsBasicAuth(t *testing.T) {
	var seen []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, pass, ok := r.BasicAuth()
		seen = append(seen, r.Method+" "+r.URL.Path+" "+user+":"+pass)
		if !ok || user != "gw" || pass != "pw" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte("{}"))
	}))
	defer server.Close()
	client, err := NewGo2RTCClient(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = client.Streams(context.Background()); err == nil {
		t.Fatal("an unauthenticated request must fail")
	}
	client.SetCredentials("gw", "pw")
	if _, err = client.Streams(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err = client.Restart(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := seen[len(seen)-1]; got != "POST /api/restart gw:pw" {
		t.Fatalf("restart request = %q", got)
	}
}
