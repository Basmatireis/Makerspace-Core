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
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/httpapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestHTTPManagedDeviceContextAndScopedAuthorization(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	actor := seedAccount(t, pool, "device-http-actor", false)
	admin := seedAccount(t, pool, "device-http-admin", true)
	adminPrincipal := authorization.Principal{AccountID: admin.accountID, PersonID: admin.personID, Master: true}
	deviceService := manageddevices.NewService(pool)

	reception, err := deviceService.CreateType(ctx, adminPrincipal, "Reception", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	workshop, err := deviceService.CreateType(ctx, adminPrincipal, "Workshop", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	receptionDevice, err := deviceService.Create(ctx, adminPrincipal, "Front desk", reception.ID, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	workshopDevice, err := deviceService.Create(ctx, adminPrincipal, "Bench terminal", workshop.ID, nil, nil)
	if err != nil {
		t.Fatal(err)
	}

	roleID := uuid.Must(uuid.NewV7())
	rolesReadGrantID := uuid.Must(uuid.NewV7())
	manageGrantID := uuid.Must(uuid.NewV7())
	if _, err = pool.Exec(ctx, `
		INSERT INTO roles(id, name) VALUES($1, 'Reception operator');
		INSERT INTO role_permission_grants(id, role_id, permission_id, scope)
		VALUES ($4, $1, 'roles.read', 'device_type'), ($5, $1, 'managed_devices.manage', 'device_type');
		INSERT INTO role_permission_grant_device_types(grant_id, device_type_id)
		VALUES ($4, $2), ($5, $2);
		INSERT INTO person_roles(person_id, role_id) VALUES($3, $1)`,
		roleID, reception.ID, actor.personID, rolesReadGrantID, manageGrantID,
	); err != nil {
		t.Fatal(err)
	}

	sessionToken, csrfToken := insertTestSession(t, pool, actor)
	origin := "http://makerspace.example.test"
	server := newManagedDeviceHTTPServer(t, pool, origin)
	defer server.Close()
	client := clientWithSession(t, server.URL, sessionToken, csrfToken)

	response := doJSONWithDevice(t, client, http.MethodGet, server.URL+"/api/v1/permissions", "", "", "", nil)
	assertStatus(t, response, http.StatusForbidden)
	response.Body.Close()
	response = doJSONWithDevice(t, client, http.MethodGet, server.URL+"/api/v1/permissions", "", "", "malformed-or-unknown", nil)
	assertStatus(t, response, http.StatusForbidden)
	response.Body.Close()
	workshopSession, workshopCSRF := insertTestSession(t, pool, actor, workshopDevice.Device.ID)
	workshopClient := clientWithSession(t, server.URL, workshopSession, workshopCSRF)
	response = doJSONWithDevice(t, workshopClient, http.MethodGet, server.URL+"/api/v1/permissions", "", "", workshopDevice.Token, nil)
	assertStatus(t, response, http.StatusForbidden)
	response.Body.Close()

	receptionSession, receptionCSRF := insertTestSession(t, pool, actor, receptionDevice.Device.ID)
	receptionClient := clientWithSession(t, server.URL, receptionSession, receptionCSRF)
	response = doJSONWithDevice(t, receptionClient, http.MethodGet, server.URL+"/api/v1/permissions", "", "", receptionDevice.Token, nil)
	assertStatus(t, response, http.StatusOK)
	response.Body.Close()
	response = doJSONWithDevice(t, receptionClient, http.MethodGet, server.URL+"/api/v1/managed-device-types/"+reception.ID.String(), "", "", receptionDevice.Token, nil)
	assertStatus(t, response, http.StatusOK)
	response.Body.Close()
	response = doJSONWithDevice(t, receptionClient, http.MethodGet, server.URL+"/api/v1/auth/me", "", "", receptionDevice.Token, nil)
	assertStatus(t, response, http.StatusOK)
	var current openapi.CurrentUser
	decodeResponse(t, response, &current)
	if current.ManagedDevice.IsNull() || current.ManagedDevice.GetOrEmpty().Id != receptionDevice.Device.ID {
		t.Fatalf("current device = %#v", current.ManagedDevice)
	}
	if !containsPermission(current.Permissions, openapi.RolesRead) {
		t.Fatalf("effective permissions = %v", current.Permissions)
	}

	response = doJSONWithDevice(t, receptionClient, http.MethodPost, server.URL+"/api/v1/managed-device-types", origin, receptionCSRF, receptionDevice.Token, map[string]any{
		"name": "Temporary type", "description": nil,
	})
	assertStatus(t, response, http.StatusCreated)
	response.Body.Close()

	unauthenticated := newCookieClient(t)
	response = doJSONWithDevice(t, unauthenticated, http.MethodGet, server.URL+"/api/v1/auth/me", "", "", receptionDevice.Token, nil)
	assertStatus(t, response, http.StatusUnauthorized)
	response.Body.Close()

	revoked, err := deviceService.Revoke(ctx, adminPrincipal, receptionDevice.Device.ID, receptionDevice.Device.Version, nil)
	if err != nil || revoked.RevokedAt == nil {
		t.Fatalf("revoke: device=%#v err=%v", revoked, err)
	}
	response = doJSONWithDevice(t, receptionClient, http.MethodGet, server.URL+"/api/v1/permissions", "", "", receptionDevice.Token, nil)
	assertStatus(t, response, http.StatusUnauthorized)
	response.Body.Close()
}

func TestManagedDeviceHardwareReportUsesAuthenticatedIdentityAndApplicationModes(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	admin := seedAccount(t, pool, "hardware-report-admin", true)
	principal := authorization.Principal{AccountID: admin.accountID, PersonID: admin.personID, Master: true}
	service := manageddevices.NewService(pool)
	deviceType, err := service.CreateType(ctx, principal, "Android terminal", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	var policyID uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT id FROM session_policies WHERE name='Entrance terminal'`).Scan(&policyID); err != nil {
		t.Fatal(err)
	}
	visitor, err := service.CreateConfigured(ctx, principal, "Visitor-only tablet", deviceType.ID, nil, manageddevices.DeviceSettings{
		SessionPolicyID: &policyID, TerminalEnabled: true, AllowedApplicationModes: []string{"visitor_terminal"},
		CheckInAssurance: "low", CheckOutAssurance: "low", CheckoutMode: "verified", Capabilities: []string{"nfc"},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	staff, err := service.CreateConfigured(ctx, principal, "Staff tablet", deviceType.ID, nil, manageddevices.DeviceSettings{
		SessionPolicyID: &policyID, AllowedApplicationModes: []string{"staff_ui"}, CheckInAssurance: "low", CheckOutAssurance: "low", CheckoutMode: "verified",
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `UPDATE managed_devices SET allowed_app_modes=ARRAY['maintenance']::text[] WHERE id=$1`, staff.Device.ID); err == nil {
		t.Fatal("database accepted an unsupported application mode")
	}
	if _, err = pool.Exec(ctx, `UPDATE managed_devices SET terminal_enabled=true, allowed_app_modes=ARRAY['staff_ui']::text[] WHERE id=$1`, staff.Device.ID); err == nil {
		t.Fatal("database accepted a terminal without visitor_terminal mode")
	}
	origin := "http://makerspace.example.test"
	server := newManagedDeviceHTTPServer(t, pool, origin)
	defer server.Close()
	client := newCookieClient(t)

	response := doJSONWithDevice(t, client, http.MethodPut, server.URL+"/api/v1/managed-devices/self/hardware", "https://foreign.example.test", "", visitor.Token, map[string]any{
		"platform": "android", "bridgeVersion": "1.0.0", "capabilities": []string{"nfc", "camera"},
	})
	assertStatus(t, response, http.StatusForbidden)
	response.Body.Close()

	response = doJSONWithDevice(t, client, http.MethodPut, server.URL+"/api/v1/managed-devices/self/hardware", "", "", visitor.Token, map[string]any{
		"platform": "android", "bridgeVersion": "1.0.0", "capabilities": []string{"nfc", "camera"},
	})
	assertStatus(t, response, http.StatusOK)
	var hardware openapi.DeviceHardwareContext
	decodeResponse(t, response, &hardware)
	if hardware.DeviceId != visitor.Device.ID || len(hardware.ReportedCapabilities) != 2 || len(hardware.EffectiveCapabilities) != 1 || hardware.EffectiveCapabilities[0] != openapi.Nfc {
		t.Fatalf("unexpected hardware context: %#v", hardware)
	}
	var reportDeviceID uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT managed_device_id FROM managed_device_hardware_reports WHERE managed_device_id=$1`, visitor.Device.ID).Scan(&reportDeviceID); err != nil || reportDeviceID != visitor.Device.ID {
		t.Fatalf("hardware report identity=%s err=%v", reportDeviceID, err)
	}
	var auditCount int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE resource_id=$1 AND action='managed_device.hardware_reported'`, visitor.Device.ID).Scan(&auditCount); err != nil || auditCount != 1 {
		t.Fatalf("hardware audit count=%d err=%v", auditCount, err)
	}
	response = doJSONWithDevice(t, client, http.MethodPut, server.URL+"/api/v1/managed-devices/self/hardware", "", "", "not-a-valid-device-token", map[string]any{
		"platform": "android", "bridgeVersion": "1.0.0", "capabilities": []string{"nfc"},
	})
	assertStatus(t, response, http.StatusUnauthorized)
	response.Body.Close()

	response = doJSONWithDevice(t, client, http.MethodPut, server.URL+"/api/v1/managed-devices/self/hardware", origin, "", staff.Token, map[string]any{
		"deviceId": visitor.Device.ID, "platform": "android", "bridgeVersion": "1.0.0", "capabilities": []string{"nfc"},
	})
	assertStatus(t, response, http.StatusBadRequest)
	response.Body.Close()
	response = doJSONWithDevice(t, client, http.MethodGet, server.URL+"/api/v1/managed-devices/self/hardware", "", "", "", nil)
	assertStatus(t, response, http.StatusUnauthorized)
	response.Body.Close()

	login := map[string]any{"email": "nobody@example.test", "password": "not-the-password"}
	response = doJSONWithDevice(t, client, http.MethodPost, server.URL+"/api/v1/auth/login", origin, "", visitor.Token, login)
	assertStatus(t, response, http.StatusForbidden)
	response.Body.Close()
	response = doJSONWithDevice(t, client, http.MethodPost, server.URL+"/api/v1/auth/login", origin, "", staff.Token, login)
	assertStatus(t, response, http.StatusUnauthorized)
	response.Body.Close()
}

func insertTestSession(t *testing.T, pool *pgxpool.Pool, account seededAccount, managedDevice ...uuid.UUID) (string, string) {
	t.Helper()
	ctx := testContext(t)
	sessionToken, sessionDigest, err := security.NewOpaqueToken()
	if err != nil {
		t.Fatal(err)
	}
	csrfToken, csrfDigest, err := security.NewOpaqueToken()
	if err != nil {
		t.Fatal(err)
	}
	var managedDeviceID *uuid.UUID
	if len(managedDevice) > 0 {
		managedDeviceID = &managedDevice[0]
	}
	if _, err = pool.Exec(ctx, `
		INSERT INTO sessions(id, account_id, auth_identity_id, token_digest, csrf_digest, auth_method, idle_expires_at, absolute_expires_at, managed_device_id)
		VALUES($1, $2, $3, $4, $5, 'password', now() + interval '1 hour', now() + interval '2 hours', $6)`,
		uuid.Must(uuid.NewV7()), account.accountID, account.identity, sessionDigest, csrfDigest, managedDeviceID,
	); err != nil {
		t.Fatal(err)
	}
	return sessionToken, csrfToken
}

func newManagedDeviceHTTPServer(t *testing.T, pool *pgxpool.Pool, origin string) *httptest.Server {
	t.Helper()
	baseURL, err := url.Parse(origin)
	if err != nil {
		t.Fatal(err)
	}
	handler, err := httpapi.NewHandler(pool, config.Config{
		PublicBaseURL: baseURL, SessionCookieName: "makerspace_session", CSRFCookieName: "makerspace_csrf",
		ManagedDeviceCookieName: "makerspace_device",
		SessionIdleTTL:          time.Hour, SessionAbsoluteTTL: 2 * time.Hour, PasswordResetTTL: 30 * time.Minute,
	}, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	return httptest.NewServer(handler)
}

func clientWithSession(t *testing.T, serverURL, sessionToken, csrfToken string) *http.Client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(serverURL)
	if err != nil {
		t.Fatal(err)
	}
	jar.SetCookies(parsed, []*http.Cookie{{Name: "makerspace_session", Value: sessionToken}, {Name: "makerspace_csrf", Value: csrfToken}})
	return &http.Client{Jar: jar, Timeout: 10 * time.Second}
}

func doJSONWithDevice(t *testing.T, client *http.Client, method, endpoint, origin, csrf, deviceToken string, body any) *http.Response {
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
	if deviceToken != "" {
		request.Header.Set("X-Managed-Device-Token", deviceToken)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func containsPermission(values []openapi.PermissionId, wanted openapi.PermissionId) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}
