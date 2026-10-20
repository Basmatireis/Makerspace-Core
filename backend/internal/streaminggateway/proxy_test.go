package streaminggateway

import (
	"bufio"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/streamticket"
	"github.com/google/uuid"
)

const testOrigin = "https://makerspace.example.org"

type upstreamRequest struct {
	Method, Path, RawQuery, URI string
	Header                      http.Header
	Body                        string
}

type proxyFixture struct {
	t        *testing.T
	proxy    *Proxy
	server   *httptest.Server
	upstream *httptest.Server
	mu       sync.Mutex
	seen     []upstreamRequest
	private  ed25519.PrivateKey
	kid      string
	now      time.Time
	snapshot *Snapshot
	machine  uuid.UUID
	holdWS   bool
}

func newProxyFixture(t *testing.T) *proxyFixture {
	t.Helper()
	f := &proxyFixture{t: t, now: time.Now().UTC(), machine: uuid.Must(uuid.NewV7())}
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	f.private, f.kid = private, streamticket.KeyID(public)
	f.upstream = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.seen = append(
			f.seen,
			upstreamRequest{
				Method:   r.Method,
				Path:     r.URL.Path,
				URI:      r.RequestURI,
				RawQuery: r.URL.RawQuery,
				Header:   r.Header.Clone(),
				Body:     string(body),
			},
		)
		f.mu.Unlock()
		w.Header().Set("Access-Control-Allow-Origin", "*") // go2rtc style; must be replaced
		if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			hijacker := w.(http.Hijacker)
			conn, buffer, _ := hijacker.Hijack()
			defer conn.Close()
			_, _ = buffer.WriteString(
				"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nhello",
			)
			_ = buffer.Flush()
			if f.holdWS {
				_, _ = io.Copy(io.Discard, conn) // stay open until the proxy closes the connection
			}
			return
		}
		_, _ = w.Write([]byte(`{"type":"answer","sdp":"v=0"}`))
	}))
	t.Cleanup(f.upstream.Close)
	f.snapshot = NewSnapshot(Configuration{
		Cameras:          []Camera{{MachineID: f.machine.String(), StreamName: streamticket.StreamName(f.machine)}},
		TicketPublicKeys: []TicketKey{{KeyID: f.kid, PublicKey: base64.RawURLEncoding.EncodeToString(public)}},
	})
	target, _ := url.Parse(f.upstream.URL)
	f.proxy = NewProxy(
		func() *Snapshot { return f.snapshot },
		target,
		testOrigin,
		UpstreamAuth{Username: "gwuser", Password: "gwpass"},
		func() time.Time { return f.now },
	)
	f.server = httptest.NewServer(f.proxy)
	t.Cleanup(f.server.Close)
	return f
}

func (f *proxyFixture) ticket(stream string, issuedAt time.Time) string {
	f.t.Helper()
	ticket, _, err := streamticket.Sign(f.private, f.kid, uuid.Must(uuid.NewV7()), f.machine, stream, issuedAt)
	if err != nil {
		f.t.Fatal(err)
	}
	return ticket
}

func (f *proxyFixture) stream() string { return streamticket.StreamName(f.machine) }

func (f *proxyFixture) do(method, path, body string, headers map[string]string) *http.Response {
	f.t.Helper()
	request, err := http.NewRequest(method, f.server.URL+path, strings.NewReader(body))
	if err != nil {
		f.t.Fatal(err)
	}
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		f.t.Fatal(err)
	}
	return response
}

func (f *proxyFixture) upstreamCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.seen)
}

func TestProxyForwardsWebRTCOfferWithValidTicketOnly(t *testing.T) {
	f := newProxyFixture(t)
	ticket := f.ticket(f.stream(), f.now)
	response := f.do(
		http.MethodPost,
		"/api/webrtc?src="+f.stream()+"&ticket="+ticket+"&dst=evil",
		"v=0 offer",
		map[string]string{"Origin": testOrigin, "Cookie": "session=x", "Authorization": "Bearer other"},
	)
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusOK || !strings.Contains(string(body), "answer") {
		t.Fatalf("status %d body %s", response.StatusCode, body)
	}
	if got := response.Header.Get("Access-Control-Allow-Origin"); got != testOrigin {
		t.Fatalf("CORS origin = %q, want the Core origin (not go2rtc's)", got)
	}
	if response.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("responses must not be cached")
	}
	if f.upstreamCount() != 1 {
		t.Fatalf("upstream calls = %d", f.upstreamCount())
	}
	seen := f.seen[0]
	if seen.Method != http.MethodPost || seen.Path != "/api/webrtc" || seen.RawQuery != "src="+f.stream() ||
		seen.Body != "v=0 offer" {
		t.Fatalf("upstream request = %+v", seen)
	}
	for _, header := range []string{"Cookie", "Origin"} {
		if seen.Header.Get(header) != "" {
			t.Errorf("header %s reached go2rtc", header)
		}
	}
	// The client's Authorization is dropped and replaced by the gateway's go2rtc API credentials.
	if user, pass, ok := (&http.Request{Header: seen.Header}).BasicAuth(); !ok || user != "gwuser" ||
		pass != "gwpass" ||
		strings.Contains(seen.Header.Get("Authorization"), "other") {
		t.Errorf("Authorization at go2rtc = %q", seen.Header.Get("Authorization"))
	}
	if strings.Contains(seen.RawQuery, ticket) {
		t.Fatal("the ticket reached go2rtc")
	}
}

func TestProxyAcceptsBearerTicket(t *testing.T) {
	f := newProxyFixture(t)
	response := f.do(
		http.MethodPost,
		"/api/webrtc?src="+f.stream(),
		"offer",
		map[string]string{"Authorization": "Bearer " + f.ticket(f.stream(), f.now)},
	)
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
}

func TestProxyRejectsMissingBadAndMismatchedTickets(t *testing.T) {
	f := newProxyFixture(t)
	other := streamticket.StreamName(uuid.Must(uuid.NewV7()))
	expired := f.ticket(f.stream(), f.now.Add(-streamticket.TTL-streamticket.ClockSkew-time.Second))
	justExpired := f.ticket(f.stream(), f.now.Add(-streamticket.TTL-10*time.Second)) // inside the 30 s skew
	_, strangerKey, _ := ed25519.GenerateKey(rand.Reader)
	forged, _, _ := streamticket.Sign(strangerKey, f.kid, uuid.Must(uuid.NewV7()), f.machine, f.stream(), f.now)
	cases := map[string]struct {
		query string
		want  int
	}{
		"no ticket":             {"src=" + f.stream(), http.StatusUnauthorized},
		"garbage":               {"src=" + f.stream() + "&ticket=abc", http.StatusUnauthorized},
		"expired":               {"src=" + f.stream() + "&ticket=" + expired, http.StatusUnauthorized},
		"within clock skew":     {"src=" + f.stream() + "&ticket=" + justExpired, http.StatusOK},
		"ticket for other src":  {"src=" + f.stream() + "&ticket=" + f.ticket(other, f.now), http.StatusUnauthorized},
		"wrong signing key":     {"src=" + f.stream() + "&ticket=" + forged, http.StatusUnauthorized},
		"valid ticket, unknown": {"src=" + other + "&ticket=" + f.ticket(other, f.now), http.StatusNotFound},
		"url as src": {
			"src=rtsp://10.0.0.1/x&ticket=" + f.ticket("rtsp://10.0.0.1/x", f.now),
			http.StatusNotFound,
		},
		"exec as src": {"src=exec:id&ticket=" + f.ticket("exec:id", f.now), http.StatusNotFound},
		"two src values": {
			"src=" + f.stream() + "&src=" + other + "&ticket=" + f.ticket(f.stream(), f.now),
			http.StatusNotFound,
		},
		"no src": {"ticket=" + f.ticket(f.stream(), f.now), http.StatusNotFound},
	}
	for name, c := range cases {
		before := f.upstreamCount()
		response := f.do(http.MethodPost, "/api/webrtc?"+c.query, "offer", nil)
		response.Body.Close()
		if response.StatusCode != c.want {
			t.Errorf("%s: status %d, want %d", name, response.StatusCode, c.want)
		}
		if c.want != http.StatusOK && f.upstreamCount() != before {
			t.Errorf("%s: request reached go2rtc", name)
		}
	}
}

func TestProxyExposesNothingElse(t *testing.T) {
	f := newProxyFixture(t)
	ticket := "&ticket=" + f.ticket(f.stream(), f.now)
	for _, path := range []string{"/", "/api", "/api/streams", "/api/streams?src=" + f.stream() + ticket, "/api/config", "/api/restart", "/api/webrtc/", "/api/ws/x", "/api/exit", "/index.html", "/static/x", "/api/frame.jpeg?src=" + f.stream() + ticket, "/api/stream.mp4?src=" + f.stream() + ticket, "/api/../api/streams", "//api/webrtc"} {
		for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodDelete} {
			response := f.do(method, path, "x", nil)
			response.Body.Close()
			if response.StatusCode != http.StatusNotFound && response.StatusCode != http.StatusMovedPermanently &&
				response.StatusCode != http.StatusMethodNotAllowed {
				t.Errorf("%s %s = %d", method, path, response.StatusCode)
			}
		}
	}
	if f.upstreamCount() != 0 {
		t.Fatalf("%d requests reached go2rtc", f.upstreamCount())
	}
	// Wrong method on an allowed path.
	response := f.do(http.MethodGet, "/api/webrtc?src="+f.stream()+ticket, "", nil)
	response.Body.Close()
	if response.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("GET /api/webrtc = %d", response.StatusCode)
	}
	response = f.do(http.MethodGet, "/api/ws?src="+f.stream()+ticket, "", nil) // no Upgrade header
	response.Body.Close()
	if response.StatusCode != http.StatusMethodNotAllowed || f.upstreamCount() != 0 {
		t.Fatalf("plain GET /api/ws = %d", response.StatusCode)
	}
}

func TestProxyCORS(t *testing.T) {
	f := newProxyFixture(t)
	ticket := f.ticket(f.stream(), f.now)
	response := f.do(
		http.MethodOptions,
		"/api/webrtc?src="+f.stream(),
		"",
		map[string]string{"Origin": testOrigin, "Access-Control-Request-Method": "POST"},
	)
	response.Body.Close()
	if response.StatusCode != http.StatusNoContent ||
		response.Header.Get("Access-Control-Allow-Origin") != testOrigin ||
		!strings.Contains(response.Header.Get("Access-Control-Allow-Methods"), "POST") {
		t.Fatalf("preflight = %d %v", response.StatusCode, response.Header)
	}
	foreign := f.do(
		http.MethodOptions,
		"/api/webrtc?src="+f.stream(),
		"",
		map[string]string{"Origin": "https://evil.example"},
	)
	foreign.Body.Close()
	if foreign.StatusCode != http.StatusForbidden || foreign.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("foreign preflight = %d", foreign.StatusCode)
	}
	post := f.do(
		http.MethodPost,
		"/api/webrtc?src="+f.stream()+"&ticket="+ticket,
		"offer",
		map[string]string{"Origin": "https://evil.example"},
	)
	post.Body.Close()
	if post.StatusCode != http.StatusForbidden || f.upstreamCount() != 0 {
		t.Fatalf("foreign origin POST = %d", post.StatusCode)
	}
	unknown := f.do(http.MethodOptions, "/api/webrtc?src=cam-unknown", "", map[string]string{"Origin": testOrigin})
	unknown.Body.Close()
	if unknown.StatusCode != http.StatusNotFound {
		t.Fatalf("preflight for unknown stream = %d", unknown.StatusCode)
	}
}

func TestProxyUpgradesWebSocketWithoutTheTicket(t *testing.T) {
	f := newProxyFixture(t)
	ticket := f.ticket(f.stream(), f.now)
	address := strings.TrimPrefix(f.server.URL, "http://")
	connection, err := net.Dial("tcp", address)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	request := "GET /api/ws?src=" + f.stream() + "&ticket=" + ticket + " HTTP/1.1\r\nHost: " + address + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nOrigin: " + testOrigin + "\r\n\r\n"
	if _, err = connection.Write([]byte(request)); err != nil {
		t.Fatal(err)
	}
	_ = connection.SetReadDeadline(time.Now().Add(5 * time.Second))
	reader := bufio.NewReader(connection)
	response, err := http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("status = %d", response.StatusCode)
	}
	if f.upstreamCount() != 1 || f.seen[0].Path != "/api/ws" || f.seen[0].RawQuery != "src="+f.stream() ||
		f.seen[0].Header.Get("Origin") != "" {
		t.Fatalf("upstream = %+v", f.seen)
	}
	// Without a ticket the upgrade is refused before it reaches go2rtc.
	bare := f.do(
		http.MethodGet,
		"/api/ws?src="+f.stream(),
		"",
		map[string]string{"Upgrade": "websocket", "Connection": "Upgrade"},
	)
	bare.Body.Close()
	if bare.StatusCode != http.StatusUnauthorized || f.upstreamCount() != 1 {
		t.Fatalf("ticketless upgrade = %d", bare.StatusCode)
	}
}

func TestRetiredKeysStopWorkingEvenOffline(t *testing.T) {
	f := newProxyFixture(t)
	until := f.now.Add(10 * time.Minute)
	f.snapshot.Keys[0].ValidUntil = &until
	ticket := f.ticket(f.stream(), f.now)
	check := func() int {
		response := f.do(http.MethodPost, "/api/webrtc?src="+f.stream()+"&ticket="+ticket, "offer", nil)
		response.Body.Close()
		return response.StatusCode
	}
	if check() != http.StatusOK {
		t.Fatal("a key inside its validity must work")
	}
	f.now = f.now.Add(11 * time.Minute)
	if got := check(); got != http.StatusUnauthorized {
		t.Fatalf("after validity: %d, want 401", got)
	}
}

func TestEmptySnapshotServesNothing(t *testing.T) {
	f := newProxyFixture(t)
	ticket := f.ticket(f.stream(), f.now)
	f.snapshot = NewSnapshot(Configuration{})
	response := f.do(http.MethodPost, "/api/webrtc?src="+f.stream()+"&ticket="+ticket, "offer", nil)
	response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized && response.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d", response.StatusCode)
	}
	if f.upstreamCount() != 0 {
		t.Fatal("request reached go2rtc")
	}
}

func TestProxyRefusesTicketsOfRevokedDisplays(t *testing.T) {
	f := newProxyFixture(t)
	display := uuid.Must(uuid.NewV7())
	ticket, _, err := streamticket.Sign(f.private, f.kid, display, f.machine, f.stream(), f.now)
	if err != nil {
		t.Fatal(err)
	}
	post := func() int {
		response := f.do(http.MethodPost, "/api/webrtc?src="+f.stream()+"&ticket="+ticket, "offer", nil)
		response.Body.Close()
		return response.StatusCode
	}
	if post() != http.StatusOK {
		t.Fatal("ticket of a regular display must work")
	}
	f.snapshot.RevokedDisplays = map[uuid.UUID]struct{}{display: {}}
	before := f.upstreamCount()
	if got := post(); got != http.StatusUnauthorized || f.upstreamCount() != before {
		t.Fatalf("revoked display: status %d, upstream calls %d -> %d", got, before, f.upstreamCount())
	}
}

func TestProxyClosesWebSocketWhenTheTicketExpires(t *testing.T) {
	f := newProxyFixture(t)
	f.holdWS = true
	// The ticket has about 1.5 s left: inside the expiry the upgrade is accepted, afterwards the
	// connection is closed by the proxy.
	ticket := f.ticket(f.stream(), time.Now().UTC().Add(-streamticket.TTL+1500*time.Millisecond))
	f.now = time.Now().UTC()
	address := strings.TrimPrefix(f.server.URL, "http://")
	connection, err := net.Dial("tcp", address)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	request := "GET /api/ws?src=" + f.stream() + "&ticket=" + ticket + " HTTP/1.1\r\nHost: " + address + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
	if _, err = connection.Write([]byte(request)); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(connection)
	_ = connection.SetReadDeadline(time.Now().Add(5 * time.Second))
	response, err := http.ReadResponse(reader, nil)
	if err != nil || response.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("upgrade: %v %v", response, err)
	}
	started := time.Now()
	_ = connection.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err = io.Copy(io.Discard, reader); err != nil && !strings.Contains(err.Error(), "reset") {
		t.Fatalf("connection was not closed cleanly: %v", err)
	}
	if elapsed := time.Since(started); elapsed > 3*time.Second {
		t.Fatalf("connection stayed open %v after the ticket expired", elapsed)
	}
}

func TestProxyForwardsOnlyTheConstantPath(t *testing.T) {
	f := newProxyFixture(t)
	ticket := f.ticket(f.stream(), f.now)
	response := f.do(http.MethodPost, "/api%2Fwebrtc?src="+f.stream()+"&ticket="+ticket, "offer", nil)
	response.Body.Close()
	if response.StatusCode == http.StatusOK {
		if f.seen[0].URI != "/api/webrtc?src="+f.stream() {
			t.Fatalf("upstream request URI = %q", f.seen[0].URI)
		}
	}
}

func TestNormalizeOrigin(t *testing.T) {
	for in, want := range map[string]string{
		"https://Core.Example.org:443":  "https://core.example.org",
		"https://core.example.org":      "https://core.example.org",
		"http://core.example.org:80":    "http://core.example.org",
		"https://core.example.org:8443": "https://core.example.org:8443",
		"http://core.example.org:443":   "http://core.example.org:443",
		"HTTPS://[::1]:443":             "https://[::1]",
		"null":                          "null",
	} {
		if got := NormalizeOrigin(in); got != want {
			t.Errorf("NormalizeOrigin(%q) = %q, want %q", in, got, want)
		}
	}
	f := newProxyFixture(t)
	f.proxy.allowedOrigin = NormalizeOrigin("https://MAKERSPACE.example.org:443")
	response := f.do(
		http.MethodOptions,
		"/api/webrtc?src="+f.stream(),
		"",
		map[string]string{"Origin": "https://makerspace.example.org"},
	)
	response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		t.Fatalf("default-port origin = %d", response.StatusCode)
	}
}
