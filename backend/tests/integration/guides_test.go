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
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/guides"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/httpapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
)

func TestGuideProgressIsScopedToEachAccount(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	service := guides.NewService(pool)
	alice := authorization.Principal{AccountID: seedAccount(t, pool, "guides-alice", false).accountID}
	bob := authorization.Principal{AccountID: seedAccount(t, pool, "guides-bob", false).accountID}

	if items, err := service.List(ctx, alice); err != nil || len(items) != 0 {
		t.Fatalf("fresh list = %v, %v", items, err)
	}
	first, err := service.Set(ctx, alice, "welcome", guides.StatusDismissed)
	if err != nil {
		t.Fatal(err)
	}
	if first.GuideID != "welcome" || first.Status != guides.StatusDismissed || first.UpdatedAt.IsZero() {
		t.Fatalf("stored progress = %+v", first)
	}
	// A second write overwrites the status and moves updated_at; there is still one row.
	second, err := service.Set(ctx, alice, "welcome", guides.StatusCompleted)
	if err != nil {
		t.Fatal(err)
	}
	if second.Status != guides.StatusCompleted || second.UpdatedAt.Before(first.UpdatedAt) {
		t.Fatalf("overwritten progress = %+v after %+v", second, first)
	}
	if _, err := service.Set(ctx, alice, "open-days-1", guides.StatusDismissed); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Set(ctx, bob, "welcome", guides.StatusDismissed); err != nil {
		t.Fatal(err)
	}

	items, err := service.List(ctx, alice)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 || items[0].GuideID != "open-days-1" || items[0].Status != guides.StatusDismissed ||
		items[1].GuideID != "welcome" || items[1].Status != guides.StatusCompleted {
		t.Fatalf("alice list = %+v", items)
	}
	if items, err = service.List(ctx, bob); err != nil || len(items) != 1 || items[0].Status != guides.StatusDismissed {
		t.Fatalf("bob list = %+v, %v", items, err)
	}

	// Resetting deletes the caller's rows only.
	if err := service.Reset(ctx, alice); err != nil {
		t.Fatal(err)
	}
	if items, _ = service.List(ctx, alice); len(items) != 0 {
		t.Fatalf("alice after reset = %+v", items)
	}
	if items, _ = service.List(ctx, bob); len(items) != 1 {
		t.Fatalf("bob after alice's reset = %+v", items)
	}

	// The service refuses what the database would refuse.
	expectAppCode(t, errOf(service.Set(ctx, bob, "Bad_Id", guides.StatusCompleted)), "validation_failed")
	expectAppCode(t, errOf(service.Set(ctx, bob, "welcome", guides.Status("seen"))), "validation_failed")

	// Progress goes with the account.
	if _, err := pool.Exec(ctx, `DELETE FROM accounts WHERE id = $1`, bob.AccountID); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `SELECT count(*) FROM account_guide_progress WHERE account_id = $1`, 0, bob.AccountID)
}

func errOf(_ guides.Progress, err error) error { return err }

func TestGuideProgressOverHTTP(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	const (
		origin        = "http://makerspace.example.test"
		adminLogin    = "guides@example.test"
		adminPassword = "Guided tours workshop password 41"
	)
	if _, err := admin.NewService(pool).BootstrapMaster(ctx, admin.BootstrapInput{
		FirstName: "Guide", LastName: "Walker", LoginEmail: adminLogin, Password: adminPassword,
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
	guidesURL := server.URL + "/api/v1/me/guides"
	body := map[string]any{"status": "completed"}

	anonymous := newCookieClient(t)
	for _, call := range []struct{ method, path string }{
		{http.MethodGet, guidesURL}, {http.MethodPut, guidesURL + "/welcome"}, {http.MethodDelete, guidesURL},
	} {
		var payload any
		if call.method == http.MethodPut {
			payload = body
		}
		response := doJSON(t, anonymous, call.method, call.path, origin, "", payload)
		assertStatus(t, response, http.StatusUnauthorized)
		response.Body.Close()
	}

	client := newCookieClient(t)
	response := doJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/login", origin, "", map[string]any{
		"email": adminLogin, "password": adminPassword,
	})
	assertStatus(t, response, http.StatusNoContent)
	response.Body.Close()
	csrf := cookieValue(t, client, server.URL, cfg.CSRFCookieName)

	// Unsafe methods need the CSRF header.
	response = doJSON(t, client, http.MethodPut, guidesURL+"/welcome", origin, "", body)
	assertStatus(t, response, http.StatusForbidden)
	response.Body.Close()
	response = doJSON(t, client, http.MethodDelete, guidesURL, origin, "", nil)
	assertStatus(t, response, http.StatusForbidden)
	response.Body.Close()

	response = doJSON(t, client, http.MethodPut, guidesURL+"/welcome", origin, csrf, body)
	assertStatus(t, response, http.StatusOK)
	var stored openapi.GuideProgress
	decodeResponse(t, response, &stored)
	if stored.GuideId != "welcome" || stored.Status != openapi.GuideProgressStatusCompleted || stored.UpdatedAt.IsZero() {
		t.Fatalf("stored = %+v", stored)
	}
	response = doJSON(t, client, http.MethodPut, guidesURL+"/welcome", origin, csrf, map[string]any{"status": "dismissed"})
	assertStatus(t, response, http.StatusOK)
	response.Body.Close()

	response = doJSON(t, client, http.MethodGet, guidesURL, "", "", nil)
	assertStatus(t, response, http.StatusOK)
	assertNoStoreAndRequestID(t, response)
	var list openapi.GuideProgressList
	decodeResponse(t, response, &list)
	if len(list.Items) != 1 || list.Items[0].GuideId != "welcome" || list.Items[0].Status != openapi.GuideProgressStatusDismissed {
		t.Fatalf("list = %+v", list)
	}

	// Malformed guide ids, statuses and unknown properties (an account id, say) never reach the service.
	for _, bad := range []struct {
		path string
		body any
	}{
		{"/Welcome", body}, {"/-welcome", body}, {"/welcome_tour", body},
		{"/welcome", map[string]any{"status": "seen"}},
		{"/welcome", map[string]any{"status": "completed", "accountId": "x"}},
		{"/welcome", map[string]any{}},
	} {
		response = doJSON(t, client, http.MethodPut, guidesURL+bad.path, origin, csrf, bad.body)
		assertStatus(t, response, http.StatusBadRequest)
		response.Body.Close()
	}

	response = doJSON(t, client, http.MethodDelete, guidesURL, origin, csrf, nil)
	assertStatus(t, response, http.StatusNoContent)
	response.Body.Close()
	response = doJSON(t, client, http.MethodGet, guidesURL, "", "", nil)
	assertStatus(t, response, http.StatusOK)
	list = openapi.GuideProgressList{}
	decodeResponse(t, response, &list)
	if list.Items == nil || len(list.Items) != 0 {
		t.Fatalf("list after reset = %+v", list)
	}
}
