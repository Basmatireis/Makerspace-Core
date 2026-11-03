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

type cashRegisterHTTP struct {
	server *httptest.Server
	client *http.Client
	csrf   string
	origin string
}

func newCashRegisterHTTP(t *testing.T) cashRegisterHTTP {
	t.Helper()
	pool := migratedPool(t)
	ctx := testContext(t)
	const (
		origin        = "http://makerspace.example.test"
		adminLogin    = "cash-register@example.test"
		adminPassword = "Cash register workshop password 58"
	)
	if _, err := admin.NewService(pool).BootstrapMaster(ctx, admin.BootstrapInput{
		FirstName: "Cash", LastName: "Counter", LoginEmail: adminLogin, Password: adminPassword,
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
		MakerspaceTimeZone: "Europe/Vienna",
	}
	handler, err := httpapi.NewHandler(pool, cfg, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client := newCookieClient(t)
	response := doJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/login", origin, "", map[string]any{
		"email": adminLogin, "password": adminPassword,
	})
	assertStatus(t, response, http.StatusNoContent)
	response.Body.Close()
	return cashRegisterHTTP{
		server: server,
		client: client,
		csrf:   cookieValue(t, client, server.URL, cfg.CSRFCookieName),
		origin: origin,
	}
}

func TestCashCountsOverHTTP(t *testing.T) {
	h := newCashRegisterHTTP(t)
	countsURL := h.server.URL + "/api/v1/payments/cash-counts"
	body := map[string]any{
		"operationKey":  ids.New().String(),
		"countedAmount": "0",
		"countedAt":     time.Now().UTC().Add(-time.Minute),
	}

	anonymous := newCookieClient(t)
	response := doJSON(t, anonymous, http.MethodGet, countsURL, "", "", nil)
	assertStatus(t, response, http.StatusUnauthorized)
	response.Body.Close()
	response = doJSON(t, h.client, http.MethodPost, countsURL, h.origin, "", body)
	assertStatus(t, response, http.StatusForbidden)
	response.Body.Close()

	response = doJSON(t, h.client, http.MethodPost, countsURL, h.origin, h.csrf, body)
	assertStatus(t, response, http.StatusCreated)
	var count openapi.CashCount
	decodeResponse(t, response, &count)
	if count.Difference != "0.00" || !count.Reason.IsNull() || !count.Correction.IsNull() || count.RecordedBy.IsNull() {
		t.Fatalf("count = %+v", count)
	}

	// More cash than expected needs a reason, and then books a correction.
	surplus := map[string]any{
		"operationKey":  ids.New().String(),
		"countedAmount": "1.20",
		"countedAt":     time.Now().UTC(),
	}
	response = doJSON(t, h.client, http.MethodPost, countsURL, h.origin, h.csrf, surplus)
	assertStatus(t, response, http.StatusUnprocessableEntity)
	var refused openapi.Error
	decodeResponse(t, response, &refused)
	if refused.Code != "cash_count_reason_required" {
		t.Fatalf("refusal = %+v", refused)
	}
	surplus["reason"] = "receipt_not_recorded"
	response = doJSON(t, h.client, http.MethodPost, countsURL, h.origin, h.csrf, surplus)
	assertStatus(t, response, http.StatusCreated)
	decodeResponse(t, response, &count)
	if count.Difference != "1.20" || count.Correction.IsNull() {
		t.Fatalf("surplus count = %+v", count)
	}

	response = doJSON(t, h.client, http.MethodGet, countsURL+"?pageSize=1", "", "", nil)
	assertStatus(t, response, http.StatusOK)
	var page openapi.CashCountPage
	decodeResponse(t, response, &page)
	if page.Total != 2 || len(page.Items) != 1 || page.Items[0].Id != count.Id {
		t.Fatalf("page = %+v", page)
	}
	response = doJSON(t, h.client, http.MethodGet, h.server.URL+"/api/v1/payments/cash-register", "", "", nil)
	assertStatus(t, response, http.StatusOK)
	var register openapi.CashRegister
	decodeResponse(t, response, &register)
	last, err := register.LastCount.Get()
	if register.Expected != "1.20" || register.Corrections != "-1.20" || err != nil || last.Id != count.Id {
		t.Fatalf("register = %+v", register)
	}

	journalURL := h.server.URL + "/api/v1/payments/cash-journal"
	response = doJSON(t, anonymous, http.MethodGet, journalURL, "", "", nil)
	assertStatus(t, response, http.StatusUnauthorized)
	response.Body.Close()
	today := time.Now().In(mustVienna(t)).Format("2006-01-02")
	response = doJSON(t, h.client, http.MethodGet,
		journalURL+"?from="+today+"&to="+today+"&kind=count&kind=correction&direction=desc", "", "", nil)
	assertStatus(t, response, http.StatusOK)
	var journal openapi.CashJournal
	decodeResponse(t, response, &journal)
	if journal.Total != 3 || len(journal.Items) != 3 || journal.Items[0].Kind != openapi.CashJournalKindCorrection ||
		journal.Items[0].BalanceAfter != "1.20" || journal.Facts.Counts != 2 || journal.Register.Expected != "1.20" {
		t.Fatalf("journal = %+v", journal)
	}
	response = doJSON(t, h.client, http.MethodGet, journalURL+"?from=2026-11-02&to=2026-11-01", "", "", nil)
	assertStatus(t, response, http.StatusUnprocessableEntity)
	response.Body.Close()
}

func mustVienna(t *testing.T) *time.Location {
	t.Helper()
	location, err := time.LoadLocation("Europe/Vienna")
	if err != nil {
		t.Fatal(err)
	}
	return location
}
