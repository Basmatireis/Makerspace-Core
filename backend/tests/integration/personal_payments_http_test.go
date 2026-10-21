package integration_test

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/admin"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/httpapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
)

func TestOwnPaymentAndBalanceOverHTTP(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	const (
		origin        = "http://makerspace.example.test"
		adminLogin    = "own-payments@example.test"
		adminPassword = "Own payments workshop password 73"
	)
	if _, err := admin.NewService(pool).BootstrapMaster(ctx, admin.BootstrapInput{
		FirstName: "Own", LastName: "Payer", LoginEmail: adminLogin, Password: adminPassword,
	}); err != nil {
		t.Fatal(err)
	}
	baseURL, err := url.Parse(origin)
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{
		PublicBaseURL: baseURL, SessionCookieName: "makerspace_session", CSRFCookieName: "makerspace_csrf",
		SessionIdleTTL: 6 * time.Hour, SessionAbsoluteTTL: 72 * time.Hour, PasswordResetTTL: 30 * time.Minute,
	}
	handler, err := httpapi.NewHandler(pool, cfg, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	defer server.Close()
	body := map[string]any{
		"operationKey":  ids.New().String(),
		"orderIds":      []string{ids.New().String()},
		"jobIds":        []string{},
		"payments":      []map[string]any{{"method": "cash", "amount": "5", "occurredAt": time.Now().UTC()}},
		"expectedTotal": "5.00",
	}

	anonymous := newCookieClient(t)
	response := doJSON(t, anonymous, http.MethodPost, server.URL+"/api/v1/me/payments", origin, "", body)
	assertStatus(t, response, http.StatusUnauthorized)
	response.Body.Close()

	client := newCookieClient(t)
	response = doJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/login", origin, "", map[string]any{
		"email": adminLogin, "password": adminPassword,
	})
	assertStatus(t, response, http.StatusNoContent)
	response.Body.Close()
	csrf := cookieValue(t, client, server.URL, cfg.CSRFCookieName)

	response = doJSON(t, client, http.MethodGet, server.URL+"/api/v1/me/dashboard", "", "", nil)
	assertStatus(t, response, http.StatusOK)
	var dashboard openapi.PersonalDashboard
	decodeResponse(t, response, &dashboard)
	if dashboard.Balance == nil || dashboard.Balance.Total != "0.00" || dashboard.RecentOrders == nil ||
		dashboard.RecentJobs == nil {
		t.Fatalf("master dashboard = %+v, want an empty balance and recent lists", dashboard)
	}

	// Somebody else's or an unknown order is refused like any order that is not the caller's to pay.
	response = doJSON(t, client, http.MethodPost, server.URL+"/api/v1/me/payments", origin, csrf, body)
	assertStatus(t, response, http.StatusConflict)
	var refused openapi.Error
	decodeResponse(t, response, &refused)
	if refused.Code != "order_not_payable" {
		t.Fatalf("refusal = %+v", refused)
	}
	// The person is never taken from the request.
	body["personId"] = ids.New().String()
	response = doJSON(t, client, http.MethodPost, server.URL+"/api/v1/me/payments", origin, csrf, body)
	assertStatus(t, response, http.StatusBadRequest)
	response.Body.Close()
}
