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
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
)

// The privacy registry lists every declared category, keeps a disabled module's categories visible, and the
// settings are version-checked and audited.
func TestPrivacyRegistryOverHTTP(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	const (
		origin   = "http://makerspace.example.test"
		login    = "privacy-master@example.test"
		password = "Privacy master workshop password 37"
	)
	if _, err := admin.NewService(pool).BootstrapMaster(ctx, admin.BootstrapInput{
		FirstName: "Privacy", LastName: "Master", LoginEmail: login, Password: password,
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
		MakerspaceTimeZone: "Europe/Vienna", LocalStorageRoot: t.TempDir(),
	}
	handler, err := httpapi.NewHandler(pool, cfg, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	defer server.Close()

	client := newCookieClient(t)
	response := doJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/login", origin, "", map[string]any{
		"email": login, "password": password,
	})
	assertStatus(t, response, http.StatusNoContent)
	response.Body.Close()
	elevateMasterSessions(t, pool)
	csrf := cookieValue(t, client, server.URL, cfg.CSRFCookieName)
	api := func(method, path string, body any) *http.Response {
		return doJSON(t, client, method, server.URL+"/api/v1"+path, origin, csrf, body)
	}

	response = api(http.MethodGet, "/privacy/categories", nil)
	assertStatus(t, response, http.StatusOK)
	var list struct {
		Categories []struct {
			ID            string   `json:"id"`
			OwnerModuleID string   `json:"ownerModuleId"`
			Orphaned      bool     `json:"orphaned"`
			Fields        []string `json:"fields"`
			LegacyDefault *struct {
				PeriodDays int    `json:"periodDays"`
				Source     string `json:"source"`
			} `json:"legacyDefault"`
		} `json:"categories"`
	}
	decodeResponse(t, response, &list)
	byID := map[string]int{}
	for index, category := range list.Categories {
		byID[category.ID] = index
		if category.Orphaned || category.OwnerModuleID == "" || len(category.Fields) == 0 {
			t.Fatalf("category %+v", category)
		}
	}
	audits, ok := byID["audit.events"]
	if !ok || list.Categories[audits].LegacyDefault == nil || list.Categories[audits].LegacyDefault.Source != "AUDIT_RETENTION" ||
		list.Categories[audits].LegacyDefault.PeriodDays != 365 {
		t.Fatalf("audit category = %+v", list.Categories)
	}
	if _, ok := byID["signage.announcements"]; !ok {
		t.Fatal("signage category missing")
	}

	response = api(http.MethodGet, "/privacy/overview", nil)
	assertStatus(t, response, http.StatusOK)
	var overview struct {
		Categories           int  `json:"categories"`
		OrphanedCategories   int  `json:"orphanedCategories"`
		AutomaticRunsEnabled bool `json:"automaticRunsEnabled"`
	}
	decodeResponse(t, response, &overview)
	if overview.Categories != len(list.Categories) || overview.OrphanedCategories != 0 || overview.AutomaticRunsEnabled {
		t.Fatalf("overview = %+v", overview)
	}

	// Settings: defaults, update, stale write, audit.
	response = api(http.MethodGet, "/privacy/settings", nil)
	assertStatus(t, response, http.StatusOK)
	var settings struct {
		ControllerName       string `json:"controllerName"`
		AutomaticRunsEnabled bool   `json:"automaticRunsEnabled"`
		RunIntervalMinutes   int    `json:"runIntervalMinutes"`
		Version              int64  `json:"version"`
	}
	decodeResponse(t, response, &settings)
	if settings.AutomaticRunsEnabled || settings.RunIntervalMinutes != 60 || settings.Version != 1 {
		t.Fatalf("default settings = %+v", settings)
	}
	update := map[string]any{
		"controllerName": "HTU Graz", "controllerAddress": "Rechbauerstraße 12, 8010 Graz",
		"dataProtectionContact": "privacy@example.test", "automaticRunsEnabled": false, "runIntervalMinutes": 30,
		"expectedVersion": 1,
	}
	response = api(http.MethodPut, "/privacy/settings", update)
	assertStatus(t, response, http.StatusOK)
	decodeResponse(t, response, &settings)
	if settings.ControllerName != "HTU Graz" || settings.RunIntervalMinutes != 30 || settings.Version != 2 {
		t.Fatalf("updated settings = %+v", settings)
	}
	response = api(http.MethodPut, "/privacy/settings", update)
	assertStatus(t, response, http.StatusConflict)
	var problem struct {
		Code string `json:"code"`
	}
	decodeResponse(t, response, &problem)
	if problem.Code != "stale_write" {
		t.Fatalf("stale settings answered %+v", problem)
	}
	var audited int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE action = 'privacy.settings_updated'`).Scan(&audited); err != nil || audited != 1 {
		t.Fatalf("audit rows = %d err=%v", audited, err)
	}
}
