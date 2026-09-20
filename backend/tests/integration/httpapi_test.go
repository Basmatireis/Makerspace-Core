package integration_test

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/admin"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/httpapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/google/uuid"
)

func TestHTTPVerticalSliceAndSensitiveFieldRedaction(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	const (
		origin         = "http://makerspace.example.test"
		adminLogin     = "http-admin@example.test"
		adminPassword  = "HTTP admin workshop password 51"
		memberLogin    = "http-member@example.test"
		memberPassword = "HTTP member workshop password 62"
	)
	if _, err := admin.NewService(pool).BootstrapMaster(ctx, admin.BootstrapInput{
		FirstName: "HTTP", LastName: "Administrator", ContactEmail: "http-contact@example.test",
		LoginEmail: adminLogin, Password: adminPassword,
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

	adminClient := newCookieClient(t)
	response := doJSON(t, adminClient, http.MethodPost, server.URL+"/api/v1/auth/login", origin, "", map[string]any{
		"email": adminLogin, "password": adminPassword,
	})
	assertStatus(t, response, http.StatusNoContent)
	assertNoStoreAndRequestID(t, response)
	response.Body.Close()
	adminCSRF := cookieValue(t, adminClient, server.URL, cfg.CSRFCookieName)
	if cookieValue(t, adminClient, server.URL, cfg.SessionCookieName) == "" || adminCSRF == "" {
		t.Fatal("login did not establish both session and CSRF cookies")
	}

	response = doJSON(t, adminClient, http.MethodPost, server.URL+"/api/v1/people", origin, "wrong-csrf-token", map[string]any{
		"firstName": "Blocked", "lastName": "Request", "email": "blocked-csrf@example.test",
	})
	assertStatus(t, response, http.StatusForbidden)
	var csrfDenied openapi.Error
	decodeResponse(t, response, &csrfDenied)
	if csrfDenied.Code != "csrf_invalid" {
		t.Fatalf("unexpected CSRF denial: %#v", csrfDenied)
	}
	response = doJSON(t, adminClient, http.MethodPost, server.URL+"/api/v1/people", "", adminCSRF, map[string]any{
		"firstName": "Blocked", "lastName": "Origin", "email": "blocked-origin@example.test",
	})
	assertStatus(t, response, http.StatusForbidden)
	var originDenied openapi.Error
	decodeResponse(t, response, &originDenied)
	if originDenied.Code != "origin_invalid" {
		t.Fatalf("unexpected Origin denial: %#v", originDenied)
	}

	response = doJSON(t, adminClient, http.MethodGet, server.URL+"/api/v1/auth/me", "", "", nil)
	assertStatus(t, response, http.StatusOK)
	var current openapi.CurrentUser
	decodeResponse(t, response, &current)
	loginEmail, loginEmailErr := current.Account.LoginEmail.Get()
	if loginEmailErr != nil || loginEmail != openapi.Email(adminLogin) || len(current.Permissions) != len(authorization.Registry()) {
		t.Fatalf("unexpected master identity or permission set: %#v", current)
	}
	response = doJSON(t, adminClient, http.MethodGet, server.URL+"/api/v1/roles/effective-permissions?authenticationAssurance=normal", "", "", nil)
	assertStatus(t, response, http.StatusOK)
	var evaluations openapi.RoleEffectivePermissionEvaluationList
	decodeResponse(t, response, &evaluations)
	var masterRoleID uuid.UUID
	var masterRoleVersion int64
	if err := pool.QueryRow(ctx, `SELECT id, version FROM roles WHERE system_key = 'master'`).Scan(&masterRoleID, &masterRoleVersion); err != nil {
		t.Fatal(err)
	}
	foundMasterEvaluation := false
	for _, evaluation := range evaluations.Items {
		if uuid.UUID(evaluation.RoleId) != masterRoleID {
			continue
		}
		foundMasterEvaluation = true
		if evaluation.RoleVersion != masterRoleVersion || len(evaluation.PermissionIds) != len(authorization.Registry()) {
			t.Fatalf("unexpected master effective evaluation: %#v", evaluation)
		}
	}
	if !foundMasterEvaluation {
		t.Fatal("effective permission response omitted the master role")
	}
	response = doJSON(t, adminClient, http.MethodGet, server.URL+"/api/v1/roles/effective-permissions?authenticationAssurance=invalid", "", "", nil)
	assertStatus(t, response, http.StatusBadRequest)
	response.Body.Close()
	response = doJSON(t, adminClient, http.MethodGet, server.URL+"/api/v1/roles/effective-permissions?authenticationAssurance=normal&deviceTypeId="+uuid.Must(uuid.NewV7()).String(), "", "", nil)
	assertStatus(t, response, http.StatusNotFound)
	response.Body.Close()

	response = doJSON(t, adminClient, http.MethodPost, server.URL+"/api/v1/people", origin, adminCSRF, map[string]any{
		"firstName": "Grace", "lastName": "Hopper", "email": "grace-contact@example.test", "matriculationNumber": "M-0042",
	})
	assertStatus(t, response, http.StatusCreated)
	var person openapi.Person
	decodeResponse(t, response, &person)
	if !person.MatriculationNumber.IsSpecified() || person.MatriculationNumber.GetOrEmpty() != "M-0042" {
		t.Fatalf("master response lost matriculation: %#v", person.MatriculationNumber)
	}
	response = doJSON(t, adminClient, http.MethodPatch, server.URL+"/api/v1/people/"+person.Id.String(), origin, adminCSRF, map[string]any{
		"firstName": "Stale", "expectedVersion": person.Version + 1,
	})
	assertStatus(t, response, http.StatusConflict)
	var staleWrite openapi.Error
	decodeResponse(t, response, &staleWrite)
	if staleWrite.Code != "stale_write" {
		t.Fatalf("unexpected optimistic-concurrency response: %#v", staleWrite)
	}

	response = doJSON(t, adminClient, http.MethodPost, server.URL+"/api/v1/people/"+person.Id.String()+"/account", origin, adminCSRF, map[string]any{
		"loginEmail": memberLogin, "expectedVersion": person.Version,
	})
	assertStatus(t, response, http.StatusCreated)
	var account openapi.Account
	decodeResponse(t, response, &account)
	if account.Status != openapi.AccountStatusDisabled || account.PasswordStatus != openapi.PasswordStatusNotSet {
		t.Fatalf("new account state = %s/%s", account.Status, account.PasswordStatus)
	}

	response = doJSON(t, adminClient, http.MethodPut, server.URL+"/api/v1/accounts/"+account.Id.String()+"/password", origin, adminCSRF, map[string]any{
		"newPassword": memberPassword, "expectedVersion": account.Version,
	})
	assertStatus(t, response, http.StatusOK)
	decodeResponse(t, response, &account)
	response = doJSON(t, adminClient, http.MethodPost, server.URL+"/api/v1/accounts/"+account.Id.String()+"/enable", origin, adminCSRF, map[string]any{
		"expectedVersion": account.Version,
	})
	assertStatus(t, response, http.StatusOK)
	decodeResponse(t, response, &account)

	response = doJSON(t, adminClient, http.MethodPost, server.URL+"/api/v1/roles", origin, adminCSRF, map[string]any{
		"name": "Member self-service", "description": "May read and update only the linked person",
		"permissionGrants": []map[string]any{{"permissionId": "people.read.self", "scope": "everywhere", "deviceTypeIds": []string{}, "minimumAssurance": "low"}, {"permissionId": "people.update.self", "scope": "everywhere", "deviceTypeIds": []string{}, "minimumAssurance": "low"}},
	})
	assertStatus(t, response, http.StatusCreated)
	var role openapi.Role
	decodeResponse(t, response, &role)

	response = doJSON(t, adminClient, http.MethodPut, server.URL+"/api/v1/accounts/"+account.Id.String()+"/roles/"+role.Id.String(), origin, adminCSRF, map[string]any{
		"expectedVersion": account.Version,
	})
	assertStatus(t, response, http.StatusOK)
	decodeResponse(t, response, &account)

	memberClient := newCookieClient(t)
	response = doJSON(t, memberClient, http.MethodPost, server.URL+"/api/v1/auth/login", origin, "", map[string]any{
		"email": memberLogin, "password": memberPassword,
	})
	assertStatus(t, response, http.StatusNoContent)
	response.Body.Close()
	memberCSRF := cookieValue(t, memberClient, server.URL, cfg.CSRFCookieName)
	response = doJSON(t, memberClient, http.MethodGet, server.URL+"/api/v1/roles/effective-permissions?authenticationAssurance=normal", "", "", nil)
	assertStatus(t, response, http.StatusForbidden)
	response.Body.Close()

	response = doJSON(t, memberClient, http.MethodGet, server.URL+"/api/v1/people/"+person.Id.String(), "", "", nil)
	assertStatus(t, response, http.StatusOK)
	rawPerson := readResponse(t, response)
	if bytes.Contains(rawPerson, []byte("matriculationNumber")) || bytes.Contains(rawPerson, []byte("M-0042")) {
		t.Fatalf("matriculation leaked without dedicated permission: %s", rawPerson)
	}
	if !bytes.Contains(rawPerson, []byte("grace-contact@example.test")) {
		t.Fatalf("ordinary self-readable contact field was unexpectedly hidden: %s", rawPerson)
	}

	response = doJSON(t, memberClient, http.MethodPatch, server.URL+"/api/v1/people/"+person.Id.String(), origin, memberCSRF, map[string]any{
		"lastName": "Hopper-Updated", "expectedVersion": person.Version,
	})
	assertStatus(t, response, http.StatusOK)
	var updated openapi.Person
	decodeResponse(t, response, &updated)
	if updated.LastName != "Hopper-Updated" || updated.MatriculationNumber.IsSpecified() {
		t.Fatalf("unexpected self-update response: %#v", updated)
	}

	response = doJSON(t, memberClient, http.MethodGet, server.URL+"/api/v1/people", "", "", nil)
	assertStatus(t, response, http.StatusForbidden)
	var denied openapi.Error
	decodeResponse(t, response, &denied)
	if denied.Code != "permission_denied" || denied.RequestId == "" {
		t.Fatalf("unexpected cross-person denial: %#v", denied)
	}

	response = doJSON(t, adminClient, http.MethodDelete, server.URL+"/api/v1/accounts/"+account.Id.String()+"/roles/"+role.Id.String(), origin, adminCSRF, map[string]any{
		"expectedVersion": account.Version,
	})
	assertStatus(t, response, http.StatusOK)
	decodeResponse(t, response, &account)
	response = doJSON(t, memberClient, http.MethodGet, server.URL+"/api/v1/people/"+person.Id.String(), "", "", nil)
	assertStatus(t, response, http.StatusForbidden)
	response.Body.Close()

	response = doJSON(t, memberClient, http.MethodPost, server.URL+"/api/v1/auth/logout", origin, memberCSRF, nil)
	assertStatus(t, response, http.StatusNoContent)
	assertNoStoreAndRequestID(t, response)
	response.Body.Close()
	if hasCookie(memberClient, server.URL, cfg.SessionCookieName) || hasCookie(memberClient, server.URL, cfg.CSRFCookieName) {
		t.Fatal("logout did not clear session and CSRF cookies")
	}
	response = doJSON(t, memberClient, http.MethodGet, server.URL+"/api/v1/auth/me", "", "", nil)
	assertStatus(t, response, http.StatusUnauthorized)
	response.Body.Close()

	response = doJSON(t, memberClient, http.MethodPost, server.URL+"/api/v1/auth/login", origin, "", map[string]any{
		"email": memberLogin, "password": memberPassword,
	})
	assertStatus(t, response, http.StatusNoContent)
	response.Body.Close()
	response = doJSON(t, adminClient, http.MethodPost, server.URL+"/api/v1/accounts/"+account.Id.String()+"/disable", origin, adminCSRF, map[string]any{
		"expectedVersion": account.Version,
	})
	assertStatus(t, response, http.StatusOK)
	decodeResponse(t, response, &account)
	response = doJSON(t, memberClient, http.MethodGet, server.URL+"/api/v1/auth/me", "", "", nil)
	assertStatus(t, response, http.StatusUnauthorized)
	response.Body.Close()
}

func newCookieClient(t *testing.T) *http.Client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	return &http.Client{Jar: jar, Timeout: 10 * time.Second}
}

func doJSON(t *testing.T, client *http.Client, method, endpoint, origin, csrf string, body any) *http.Response {
	t.Helper()
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(testContext(t), method, endpoint, reader)
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if origin != "" {
		request.Header.Set("Origin", origin)
	}
	if csrf != "" {
		request.Header.Set("X-CSRF-Token", csrf)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func assertStatus(t *testing.T, response *http.Response, expected int) {
	t.Helper()
	if response.StatusCode == expected {
		return
	}
	body := readResponse(t, response)
	t.Fatalf("status = %d, want %d; response=%s", response.StatusCode, expected, strings.TrimSpace(string(body)))
}

func assertNoStoreAndRequestID(t *testing.T, response *http.Response) {
	t.Helper()
	if response.Header.Get("Cache-Control") != "no-store" || response.Header.Get("X-Request-ID") == "" {
		t.Fatalf("missing security headers: %#v", response.Header)
	}
}

func decodeResponse(t *testing.T, response *http.Response, target any) {
	t.Helper()
	defer response.Body.Close()
	if err := json.NewDecoder(response.Body).Decode(target); err != nil {
		t.Fatal(err)
	}
}

func readResponse(t *testing.T, response *http.Response) []byte {
	t.Helper()
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func cookieValue(t *testing.T, client *http.Client, rawURL, name string) string {
	t.Helper()
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	for _, cookie := range client.Jar.Cookies(parsed) {
		if cookie.Name == name {
			return cookie.Value
		}
	}
	t.Fatalf("cookie %q was not found", name)
	return ""
}

func hasCookie(client *http.Client, rawURL, name string) bool {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return false
	}
	for _, cookie := range client.Jar.Cookies(parsed) {
		if cookie.Name == name {
			return true
		}
	}
	return false
}

func TestAnonymousRecoveryResponsesRemainUniform(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	seedAccount(t, pool, "recovery-enabled", false)
	disabled := seedAccount(t, pool, "recovery-disabled", false)
	if _, err := pool.Exec(ctx, `UPDATE accounts SET status='disabled' WHERE id=$1`, disabled.accountID); err != nil {
		t.Fatal(err)
	}
	cfg := integrationConfig(t)
	handler, err := httpapi.NewHandler(pool, cfg, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	defer server.Close()
	// Repeated requests also exercise both identifier and source rate limits.
	for attempt := 0; attempt < 12; attempt++ {
		for _, email := range []string{"recovery-enabled@example.test", "recovery-disabled@example.test", "unknown@example.test"} {
			response := doJSON(t, server.Client(), http.MethodPost, server.URL+"/api/v1/auth/password-reset/request", cfg.PublicBaseURL.String(), "", map[string]string{"email": email})
			body, err := io.ReadAll(response.Body)
			response.Body.Close()
			if err != nil || response.StatusCode != http.StatusAccepted || len(body) != 0 {
				t.Fatalf("nonuniform recovery response: %d %q %v", response.StatusCode, body, err)
			}
			if response.Header.Get("Cache-Control") != "no-store" {
				t.Fatal("recovery response can be cached")
			}
		}
	}
}
