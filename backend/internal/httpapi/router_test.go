package httpapi

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/auth"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
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
	}))
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
	}), logger))

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

	request = httptest.NewRequest(http.MethodGet, "/api/v1/not-a-route", nil)
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("unknown path status=%d", recorder.Code)
	}
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
