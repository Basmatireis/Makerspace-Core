package httpapi

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/auth"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

func TestCookieResponseWritesSeparateSecureCookies(t *testing.T) {
	cfg := testConfig(t)
	cfg.SessionCookieSecure = true
	cfg.SessionCookieName = "__Host-makerspace_session"
	cfg.CSRFCookieName = "__Host-makerspace_csrf"
	response := cookieNoContentResponse{
		config: cfg,
		session: &auth.Session{
			Token: "session-token", CSRFToken: "csrf-token", AbsoluteExpiry: time.Now().Add(72 * time.Hour),
		},
	}
	recorder := httptest.NewRecorder()
	if err := response.VisitLoginResponse(recorder); err != nil {
		t.Fatal(err)
	}
	result := recorder.Result()
	defer result.Body.Close()
	if result.StatusCode != http.StatusNoContent {
		t.Fatalf("status = %d", result.StatusCode)
	}
	if values := result.Header.Values("Set-Cookie"); len(values) != 2 {
		t.Fatalf("Set-Cookie count = %d, want 2", len(values))
	}
	cookies := result.Cookies()
	if len(cookies) != 2 {
		t.Fatalf("parsed cookie count = %d", len(cookies))
	}
	byName := map[string]*http.Cookie{}
	for _, cookie := range cookies {
		byName[cookie.Name] = cookie
	}
	session := byName[cfg.SessionCookieName]
	csrf := byName[cfg.CSRFCookieName]
	if session == nil || csrf == nil {
		t.Fatalf("missing expected cookies: %#v", byName)
	}
	if !session.HttpOnly || csrf.HttpOnly {
		t.Fatal("session must be HttpOnly and CSRF must be readable")
	}
	for _, cookie := range []*http.Cookie{session, csrf} {
		if !cookie.Secure || cookie.Path != "/" || cookie.Domain != "" || cookie.SameSite != http.SameSiteLaxMode || cookie.MaxAge <= 0 {
			t.Fatalf("invalid cookie attributes: %#v", cookie)
		}
	}
	if result.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("authentication response was cacheable")
	}
}

func TestCookieResponseClearsBothCookies(t *testing.T) {
	cfg := testConfig(t)
	recorder := httptest.NewRecorder()
	response := cookieNoContentResponse{config: cfg, clear: true}
	if err := response.VisitLogoutResponse(recorder); err != nil {
		t.Fatal(err)
	}
	cookies := recorder.Result().Cookies()
	if len(cookies) != 2 {
		t.Fatalf("cookie count = %d, want 2", len(cookies))
	}
	for _, cookie := range cookies {
		if cookie.MaxAge >= 0 || cookie.Value != "" {
			t.Fatalf("cookie was not expired: %#v", cookie)
		}
	}
}

func TestRequestMetadataAlwaysGeneratesUUIDv7(t *testing.T) {
	supplied := uuid.Must(uuid.NewV7())
	var gotID uuid.UUID
	var gotSource string
	handler := requestMetadataMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotID = *requestIDPointer(r.Context())
		gotSource = sourceAddress(r.Context())
		w.WriteHeader(http.StatusNoContent)
	}), nil)
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.RemoteAddr = "192.0.2.8:45123"
	request.Header.Set(requestIDHeaderName, supplied.String())
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if gotID == supplied || recorder.Header().Get(requestIDHeaderName) != gotID.String() {
		t.Fatalf("request ID mismatch: got %s", gotID)
	}
	if gotID.Version() != 7 {
		t.Fatalf("generated request ID is not UUIDv7: %s", gotID)
	}
	if gotSource != "192.0.2.8" {
		t.Fatalf("source = %q", gotSource)
	}
}

func TestOriginMiddlewareRequiresExactOriginForUnsafeRequests(t *testing.T) {
	cfg := testConfig(t)
	server := &Server{config: cfg}
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	handler := requestMetadataMiddleware(server.originMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}), logger), nil)

	for _, origin := range []string{"", "https://example.test", "http://localhost:5173.evil.test"} {
		request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", nil)
		request.Header.Set("Origin", origin)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusForbidden {
			t.Fatalf("origin %q status = %d", origin, recorder.Code)
		}
		var response openapi.Error
		if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		if response.Code != "origin_invalid" || response.RequestId == "" {
			t.Fatalf("unexpected error: %#v", response)
		}
	}

	request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", nil)
	request.Header.Set("Origin", "http://localhost:5173")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("exact origin status = %d", recorder.Code)
	}

	request = httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("safe request status = %d", recorder.Code)
	}
}

func TestHandlerValidatesContractAndProtectsRoutes(t *testing.T) {
	cfg := testConfig(t)
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	handler, err := NewHandler(nil, cfg, logger)
	if err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodGet, "/api/v1/health/live", nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || recorder.Header().Get(requestIDHeaderName) == "" {
		t.Fatalf("liveness status=%d request-id=%q", recorder.Code, recorder.Header().Get(requestIDHeaderName))
	}

	request = httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewBufferString(`{"email":`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", "http://localhost:5173")
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest || recorder.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("invalid contract status=%d cache=%q", recorder.Code, recorder.Header().Get("Cache-Control"))
	}

	request = httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnauthorized || recorder.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("protected status=%d cache=%q", recorder.Code, recorder.Header().Get("Cache-Control"))
	}

	for _, path := range []string{
		"/api/v1/managed-devices",
		"/api/v1/managed-devices/0192f6f8-743e-7c77-a349-cd07c3e8a921/token",
	} {
		request = httptest.NewRequest(http.MethodPost, path, bytes.NewBufferString(`{}`))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Origin", "http://localhost:5173")
		recorder = httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		if recorder.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("one-time-secret path %s error was cacheable", path)
		}
	}

	request = httptest.NewRequest(http.MethodGet, "/api/v1/not-a-route", nil)
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("unknown path status=%d", recorder.Code)
	}
}

func TestAccessLogIncludesPathOnlyForUnmatchedRequests(t *testing.T) {
	identifier := "0192f6f8-743e-7c77-a349-cd07c3e8a921"

	matched, matchedRaw := recordedAPIRequestLog(t, http.MethodGet, "/api/v1/people/"+identifier)
	if matched["route"] != "/api/v1/people/{personId}" {
		t.Fatalf("matched route = %q", matched["route"])
	}
	if _, exists := matched["path"]; exists {
		t.Fatalf("matched request exposed a path: %#v", matched)
	}
	if strings.Contains(matchedRaw, identifier) {
		t.Fatalf("matched request log exposed identifier: %s", matchedRaw)
	}

	const querySecret = "must-not-appear-in-request-log"
	unmatched, unmatchedRaw := recordedAPIRequestLog(t, http.MethodGet, "/wp-login.php?probe="+querySecret)
	if unmatched["route"] != "unmatched" || unmatched["path"] != "/wp-login.php" {
		t.Fatalf("unexpected unmatched request log: %#v", unmatched)
	}
	if strings.Contains(unmatchedRaw, querySecret) || strings.Contains(unmatchedRaw, "probe=") {
		t.Fatalf("unmatched request log exposed query string: %s", unmatchedRaw)
	}
}

func TestAccessLogUsesOpenAPIOperationForMatchedRequest(t *testing.T) {
	cfg := testConfig(t)
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, nil))
	handler, err := NewHandler(nil, cfg, logger)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/health/live", nil)
	request.RemoteAddr = "192.0.2.8:45123"
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	entry := decodeRequestLog(t, output.String())
	if entry["route"] != "GetLiveness" {
		t.Fatalf("route = %q, want GetLiveness", entry["route"])
	}
	if _, exists := entry["path"]; exists {
		t.Fatalf("matched request exposed a path: %#v", entry)
	}
}

func TestAccessLogResolvesClientIP(t *testing.T) {
	trustedIPv4 := netip.MustParsePrefix("10.0.0.0/8")
	trustedPrivate := netip.MustParsePrefix("192.168.0.0/16")
	trustedIPv6 := netip.MustParsePrefix("2001:db8:abcd::/48")
	tests := []struct {
		name           string
		remoteAddress  string
		trustedProxies []netip.Prefix
		headers        http.Header
		want           string
	}{
		{
			name:          "direct IPv4 request",
			remoteAddress: "192.0.2.8:45123",
			want:          "192.0.2.8",
		},
		{
			name:          "untrusted peer cannot spoof X-Forwarded-For",
			remoteAddress: "192.0.2.8:45123",
			headers:       http.Header{forwardedForHeader: {"1.2.3.4"}},
			want:          "192.0.2.8",
		},
		{
			name:           "trusted proxy forwards client",
			remoteAddress:  "10.0.0.9:8080",
			trustedProxies: []netip.Prefix{trustedIPv4},
			headers:        http.Header{forwardedForHeader: {"198.51.100.42"}},
			want:           "198.51.100.42",
		},
		{
			name:           "trusted proxy chain ignores spoofed leftmost entry",
			remoteAddress:  "10.0.0.9:8080",
			trustedProxies: []netip.Prefix{trustedIPv4, trustedPrivate},
			headers:        http.Header{forwardedForHeader: {"1.2.3.4, 203.0.113.7, 192.168.1.5"}},
			want:           "203.0.113.7",
		},
		{
			name:           "trusted IPv6 proxy forwards IPv6 client",
			remoteAddress:  "[2001:db8:abcd::10]:8080",
			trustedProxies: []netip.Prefix{trustedIPv6},
			headers:        http.Header{forwardedForHeader: {"2001:db8:1::42"}},
			want:           "2001:db8:1::42",
		},
		{
			name:           "malformed chain falls back to peer",
			remoteAddress:  "10.0.0.9:8080",
			trustedProxies: []netip.Prefix{trustedIPv4},
			headers:        http.Header{forwardedForHeader: {"198.51.100.42, not-an-ip"}},
			want:           "10.0.0.9",
		},
		{
			name:           "other forwarding headers are ignored",
			remoteAddress:  "10.0.0.9:8080",
			trustedProxies: []netip.Prefix{trustedIPv4},
			headers: http.Header{
				"X-Real-IP": {"198.51.100.42"},
				"Forwarded": {"for=198.51.100.42"},
			},
			want: "10.0.0.9",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			router := chi.NewRouter()
			router.Get("/known", func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusNoContent)
			})
			entry, _ := recordedRequestLog(t, router, http.MethodGet, "/known", test.remoteAddress, test.headers, test.trustedProxies)
			if entry["client_ip"] != test.want {
				t.Fatalf("client_ip = %q, want %q", entry["client_ip"], test.want)
			}
		})
	}
}

func TestAccessLogBoundsPathAndUserAgent(t *testing.T) {
	router := chi.NewRouter()
	longPath := "/" + strings.Repeat("p", maxLogPathBytes*2)
	longUserAgent := strings.Repeat("u", maxUserAgentBytes*2)
	headers := http.Header{"User-Agent": {longUserAgent}}

	entry, _ := recordedRequestLog(t, router, http.MethodGet, longPath, "192.0.2.8:45123", headers, nil)
	path, ok := entry["path"].(string)
	if !ok || len(path) > maxLogPathBytes || !strings.HasSuffix(path, "…") {
		t.Fatalf("path was not bounded correctly: length=%d value=%q", len(path), path)
	}
	userAgent, ok := entry["user_agent"].(string)
	if !ok || len(userAgent) > maxUserAgentBytes || !strings.HasSuffix(userAgent, "…") {
		t.Fatalf("User-Agent was not bounded correctly: length=%d value=%q", len(userAgent), userAgent)
	}
}

func recordedAPIRequestLog(t *testing.T, method, target string) (map[string]any, string) {
	t.Helper()
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, nil))
	handler, err := NewHandler(nil, testConfig(t), logger)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(method, target, nil)
	request.RemoteAddr = "192.0.2.8:45123"
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return decodeRequestLog(t, output.String()), output.String()
}

func recordedRequestLog(t *testing.T, router *chi.Mux, method, target, remoteAddress string, headers http.Header, trustedProxies []netip.Prefix) (map[string]any, string) {
	t.Helper()
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, nil))
	var handler http.Handler = router
	handler = accessLogMiddleware(handler, logger, trustedProxies)
	handler = requestMetadataMiddleware(handler, router)

	request := httptest.NewRequest(method, target, nil)
	request.RemoteAddr = remoteAddress
	request.Header = headers.Clone()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return decodeRequestLog(t, output.String()), output.String()
}

func decodeRequestLog(t *testing.T, raw string) map[string]any {
	t.Helper()
	var entry map[string]any
	if err := json.Unmarshal([]byte(raw), &entry); err != nil {
		t.Fatalf("decode request log: %v\n%s", err, raw)
	}
	return entry
}

func testConfig(t *testing.T) config.Config {
	t.Helper()
	base, err := url.Parse("http://localhost:5173")
	if err != nil {
		t.Fatal(err)
	}
	return config.Config{
		PublicBaseURL: base, SessionCookieName: "makerspace_session", CSRFCookieName: "makerspace_csrf",
		SessionIdleTTL: 6 * time.Hour, SessionAbsoluteTTL: 72 * time.Hour, PasswordResetTTL: 30 * time.Minute,
	}
}
