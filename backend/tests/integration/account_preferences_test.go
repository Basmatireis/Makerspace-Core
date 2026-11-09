package integration_test

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/accountpreferences"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/admin"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/httpapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
)

func TestAccountPreferencesAreStoredValidatedAndScopedToTheAccount(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	service := accountpreferences.NewService(pool)
	alice := authorization.Principal{AccountID: seedAccount(t, pool, "prefs-alice", false).accountID}
	bob := authorization.Principal{AccountID: seedAccount(t, pool, "prefs-bob", false).accountID}

	if items, err := service.List(ctx, alice); err != nil || len(items) != 0 {
		t.Fatalf("fresh list = %v, %v", items, err)
	}
	stored, err := service.Set(ctx, alice, accountpreferences.KeyOpenDaysView, "calendar")
	if err != nil || stored.Value != "calendar" || stored.UpdatedAt.IsZero() {
		t.Fatalf("stored = %+v, %v", stored, err)
	}
	if _, err = service.Set(ctx, alice, accountpreferences.KeyOpenDaysView, "list"); err != nil {
		t.Fatal(err)
	}
	items, err := service.List(ctx, alice)
	if err != nil || len(items) != 1 || items[0].Key != accountpreferences.KeyOpenDaysView || items[0].Value != "list" {
		t.Fatalf("alice list = %+v, %v", items, err)
	}
	// Another account never sees it and keeps its own value.
	if items, err = service.List(ctx, bob); err != nil || len(items) != 0 {
		t.Fatalf("bob list = %+v, %v", items, err)
	}
	if _, err = service.Set(ctx, bob, accountpreferences.KeyOpenDaysView, "calendar"); err != nil {
		t.Fatal(err)
	}
	if items, _ = service.List(ctx, alice); len(items) != 1 || items[0].Value != "list" {
		t.Fatalf("alice after bob's write = %+v", items)
	}

	// Unknown keys and values outside the key's list are refused.
	expectAppCode(t, errOfPreference(service.Set(ctx, bob, accountpreferences.Key("theme"), "dark")), "validation_failed")
	expectAppCode(t, errOfPreference(service.Set(ctx, bob, accountpreferences.KeyOpenDaysView, "grid")), "validation_failed")
	expectAppCode(t, errOfPreference(service.Set(ctx, bob, accountpreferences.KeyOpenDaysView, "")), "validation_failed")

	// Preferences go with the account.
	if _, err = pool.Exec(ctx, `DELETE FROM accounts WHERE id = $1`, bob.AccountID); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `SELECT count(*) FROM account_preferences WHERE account_id = $1`, 0, bob.AccountID)
}

func errOfPreference(_ accountpreferences.Preference, err error) error { return err }

func TestAccountPreferencesOverHTTP(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	const (
		origin   = "http://makerspace.example.test"
		login    = "prefs@example.test"
		password = "Preference workshop password 41"
	)
	if _, err := admin.NewService(pool).BootstrapMaster(ctx, admin.BootstrapInput{
		FirstName: "Pref", LastName: "Holder", LoginEmail: login, Password: password,
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
	listURL := server.URL + "/api/v1/me/preferences"
	body := map[string]any{"value": "calendar"}

	anonymous := newCookieClient(t)
	response := doJSON(t, anonymous, http.MethodGet, listURL, origin, "", nil)
	assertStatus(t, response, http.StatusUnauthorized)
	response.Body.Close()
	response = doJSON(t, anonymous, http.MethodPut, listURL+"/openDays.view", origin, "", body)
	assertStatus(t, response, http.StatusUnauthorized)
	response.Body.Close()

	client := newCookieClient(t)
	response = doJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/login", origin, "", map[string]any{
		"email": login, "password": password,
	})
	assertStatus(t, response, http.StatusNoContent)
	response.Body.Close()
	csrf := cookieValue(t, client, server.URL, cfg.CSRFCookieName)

	response = doJSON(t, client, http.MethodPut, listURL+"/openDays.view", origin, "", body)
	assertStatus(t, response, http.StatusForbidden)
	response.Body.Close()
	response = doJSON(t, client, http.MethodPut, listURL+"/openDays.view", origin, csrf, body)
	assertStatus(t, response, http.StatusOK)
	var stored openapi.AccountPreference
	decodeResponse(t, response, &stored)
	if stored.Key != openapi.AccountPreferenceKeyOpenDaysView || stored.Value != "calendar" {
		t.Fatalf("stored = %+v", stored)
	}
	response = doJSON(t, client, http.MethodPut, listURL+"/openDays.view", origin, csrf, map[string]any{"value": "grid"})
	assertStatus(t, response, http.StatusUnprocessableEntity)
	response.Body.Close()
	response = doJSON(t, client, http.MethodPut, listURL+"/unknown.key", origin, csrf, body)
	assertStatus(t, response, http.StatusBadRequest)
	response.Body.Close()

	response = doJSON(t, client, http.MethodGet, listURL, "", "", nil)
	assertStatus(t, response, http.StatusOK)
	assertNoStoreAndRequestID(t, response)
	var list openapi.AccountPreferenceList
	decodeResponse(t, response, &list)
	if len(list.Items) != 1 || list.Items[0].Value != "calendar" {
		t.Fatalf("list = %+v", list)
	}
}
