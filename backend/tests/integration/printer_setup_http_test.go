package integration_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/admin"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/httpapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const liveStatusBody = `{"protocolVersion":1,"configurationVersion":%d,"observedAt":"%s","status":{
"state":"printing",
"job":{"fileName":"Benchy","progressPercent":42,"layer":80,"totalLayers":191,"remainingMinutes":37},
"temperatures":{"extruders":[{"extruderId":0,"side":"right","currentC":219.0,"targetC":220.0},{"extruderId":1,"side":"left","currentC":31.0,"targetC":null}],"bedC":59.6,"bedTargetC":60.0,"chamberC":null},
"nozzles":[{"extruderId":0,"side":"right","diameterMm":0.4,"type":"HS01"},{"extruderId":1,"side":null,"diameterMm":null,"type":null}],
"units":[{"externalId":"0","kind":"ams","label":"AMS 0","humidityPercent":32,"temperatureC":32.4,"trays":[
  {"externalId":"0","materialType":"PETG","subBrand":null,"colorHex":"FFF144","remainPercent":55,"rfid":true,"empty":false},
  {"externalId":"1","materialType":null,"subBrand":null,"colorHex":null,"remainPercent":null,"rfid":false,"empty":true}]},
 {"externalId":"254","kind":"external","label":"External spool 254","humidityPercent":null,"temperatureC":null,"trays":[
  {"externalId":"254","materialType":"PLA","subBrand":null,"colorHex":"FFFFFF","remainPercent":null,"rfid":false,"empty":false}]}],
"activeTray":{"unitExternalId":"0","trayExternalId":"0"},
"errors":[{"sourceFamily":"hms","code":"196610","observedAt":"%s"}],
"firmwareVersion":null,"wifiSignalDbm":-39%s}}`

func TestPrinterSetupAndLiveStatusOverHTTP(t *testing.T) {
	schemaPool := migratedPool(t)
	ctx := testContext(t)
	poolConfig := schemaPool.Config().Copy()
	poolConfig.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeCacheStatement
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	const (
		origin        = "http://makerspace.example.test"
		adminLogin    = "setup-admin@example.test"
		adminPassword = "Setup admin workshop password 61"
	)
	if _, err = admin.NewService(pool).BootstrapMaster(ctx, admin.BootstrapInput{FirstName: "Setup", LastName: "Admin", ContactEmail: "setup-contact@example.test", LoginEmail: adminLogin, Password: adminPassword}); err != nil {
		t.Fatal(err)
	}
	baseURL, err := url.Parse(origin)
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{PublicBaseURL: baseURL, SessionCookieName: "makerspace_session", CSRFCookieName: "makerspace_csrf", SessionIdleTTL: 6 * time.Hour, SessionAbsoluteTTL: 72 * time.Hour, PasswordResetTTL: 30 * time.Minute}
	handler, err := httpapi.NewHandler(pool, cfg, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	defer server.Close()

	login := func(email, password string) (*http.Client, string) {
		client := newCookieClient(t)
		response := doJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/login", origin, "", map[string]any{"email": email, "password": password})
		assertStatus(t, response, http.StatusNoContent)
		response.Body.Close()
		return client, cookieValue(t, client, server.URL, cfg.CSRFCookieName)
	}
	adminClient, adminCSRF := login(adminLogin, adminPassword)
	member := func(suffix string, permissions ...string) (*http.Client, string) {
		t.Helper()
		email, password := "setup-"+suffix+"@example.test", "Setup "+suffix+" workshop password 77"
		response := doJSON(t, adminClient, http.MethodPost, server.URL+"/api/v1/people", origin, adminCSRF, map[string]any{"firstName": "Setup", "lastName": suffix, "email": "contact-" + email})
		assertStatus(t, response, http.StatusCreated)
		var person openapi.Person
		decodeResponse(t, response, &person)
		response = doJSON(t, adminClient, http.MethodPost, server.URL+"/api/v1/people/"+person.Id.String()+"/account", origin, adminCSRF, map[string]any{"loginEmail": email, "expectedVersion": person.Version})
		assertStatus(t, response, http.StatusCreated)
		var account openapi.Account
		decodeResponse(t, response, &account)
		response = doJSON(t, adminClient, http.MethodPut, server.URL+"/api/v1/accounts/"+account.Id.String()+"/password", origin, adminCSRF, map[string]any{"newPassword": password, "expectedVersion": account.Version})
		assertStatus(t, response, http.StatusOK)
		decodeResponse(t, response, &account)
		response = doJSON(t, adminClient, http.MethodPost, server.URL+"/api/v1/accounts/"+account.Id.String()+"/enable", origin, adminCSRF, map[string]any{"expectedVersion": account.Version})
		assertStatus(t, response, http.StatusOK)
		response.Body.Close()
		grants := make([]map[string]any, 0, len(permissions))
		for _, permission := range permissions {
			grants = append(grants, map[string]any{"permissionId": permission, "scope": "everywhere", "deviceTypeIds": []string{}, "minimumAssurance": "low"})
		}
		response = doJSON(t, adminClient, http.MethodPost, server.URL+"/api/v1/roles", origin, adminCSRF, map[string]any{"name": "Setup " + suffix, "description": "Test role", "permissionGrants": grants})
		assertStatus(t, response, http.StatusCreated)
		var role openapi.Role
		decodeResponse(t, response, &role)
		response = doJSON(t, adminClient, http.MethodGet, server.URL+"/api/v1/people/"+person.Id.String(), "", "", nil)
		assertStatus(t, response, http.StatusOK)
		decodeResponse(t, response, &person)
		response = doJSON(t, adminClient, http.MethodPut, server.URL+"/api/v1/people/"+person.Id.String()+"/roles/"+role.Id.String(), origin, adminCSRF, map[string]any{"expectedVersion": person.Version})
		assertStatus(t, response, http.StatusOK)
		response.Body.Close()
		return login(email, password)
	}
	readerClient, readerCSRF := member("reader", "machines.read")
	managerClient, managerCSRF := member("manager", "machines.read", "machines.manage")
	nobodyClient, nobodyCSRF := member("nobody", "machine_jobs.read")

	var accountID, personID uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT a.id, a.person_id FROM accounts a JOIN auth_identities i ON i.account_id = a.id WHERE i.identifier_normalized = $1`, adminLogin).Scan(&accountID, &personID); err != nil {
		t.Fatal(err)
	}
	master := authorization.Principal{AccountID: accountID, PersonID: personID, Master: true}
	logbook := machinelogbook.NewService(pool)
	machineType, err := logbook.CreateMachineType(ctx, master, "Setup printer", true, nil)
	if err != nil {
		t.Fatal(err)
	}
	machine, err := logbook.CreateMachine(ctx, master, machineType.ID, "Setup printer 1", "active", nil, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	setupPath := "/api/v1/machines/" + machine.ID.String() + "/printer/setup"
	livePath := "/api/v1/machines/" + machine.ID.String() + "/printer/live-status"
	setupBody := func(expected any) map[string]any {
		return map[string]any{"expectedVersion": expected, "enabled": true, "model": "bambu_h2d", "inputUnits": []any{
			map[string]any{"name": "AMS 2 Pro", "nozzle": "left", "externalIdentifier": "0", "slots": []any{
				map[string]any{"name": "Slot 1", "status": "available", "externalIdentifier": "0"},
				map[string]any{"name": "Slot 2", "status": "available", "externalIdentifier": nil},
			}},
		}}
	}

	// Only machines.manage may save a setup.
	for name, who := range map[string]struct {
		client *http.Client
		csrf   string
	}{"reader": {readerClient, readerCSRF}, "no machines permission": {nobodyClient, nobodyCSRF}} {
		response := doJSON(t, who.client, http.MethodPut, server.URL+setupPath, origin, who.csrf, setupBody(nil))
		if response.StatusCode != http.StatusForbidden {
			t.Errorf("save setup as %s = %d, want 403", name, response.StatusCode)
		}
		response.Body.Close()
	}
	response := doJSON(t, managerClient, http.MethodPut, server.URL+setupPath, origin, managerCSRF, setupBody(nil))
	assertStatus(t, response, http.StatusOK)
	var profile openapi.PrinterProfile
	decodeResponse(t, response, &profile)
	if profile.Version != 1 || len(profile.InputUnits) != 1 || len(profile.Slots) != 2 || !profile.Model.IsSpecified() || profile.Model.MustGet() != openapi.BambuH2d || profile.InputUnits[0].Nozzle.MustGet() != openapi.Left {
		t.Fatalf("saved profile = %+v", profile)
	}
	response = doJSON(t, managerClient, http.MethodPut, server.URL+setupPath, origin, managerCSRF, setupBody(nil))
	assertStatus(t, response, http.StatusConflict)
	response.Body.Close()
	duplicate := setupBody(profile.Version)
	duplicate["inputUnits"].([]any)[0].(map[string]any)["slots"].([]any)[1].(map[string]any)["externalIdentifier"] = "0"
	response = doJSON(t, managerClient, http.MethodPut, server.URL+setupPath, origin, managerCSRF, duplicate)
	assertStatus(t, response, http.StatusUnprocessableEntity)
	response.Body.Close()

	// Live status is readable with machines.read and absent until a connector reports.
	for _, who := range []struct {
		name   string
		client *http.Client
		status int
	}{{"reader", readerClient, http.StatusNotFound}, {"no machines permission", nobodyClient, http.StatusForbidden}} {
		response = doJSON(t, who.client, http.MethodGet, server.URL+livePath, "", "", nil)
		if response.StatusCode != who.status {
			t.Errorf("live status as %s = %d, want %d", who.name, response.StatusCode, who.status)
		}
		response.Body.Close()
	}

	// Enroll a connector over HTTP and assign it to the printer.
	response = doJSON(t, adminClient, http.MethodPost, server.URL+"/api/v1/printer-connectors", origin, adminCSRF, map[string]any{"name": "Setup connector", "locationLabel": nil})
	assertStatus(t, response, http.StatusCreated)
	var connector openapi.PrinterConnector
	decodeResponse(t, response, &connector)
	response = doJSON(t, adminClient, http.MethodPost, server.URL+"/api/v1/printer-connectors/"+connector.Id.String()+"/enrollments", origin, adminCSRF, nil)
	assertStatus(t, response, http.StatusCreated)
	var enrollment openapi.PrinterConnectorEnrollmentIssue
	decodeResponse(t, response, &enrollment)
	credentialSecret, _, err := security.NewOpaqueToken()
	if err != nil {
		t.Fatal(err)
	}
	bearer := func(method, path, token string, body any) *http.Response {
		t.Helper()
		var reader io.Reader
		if body != nil {
			encoded, marshalErr := json.Marshal(body)
			if marshalErr != nil {
				t.Fatal(marshalErr)
			}
			reader = bytes.NewReader(encoded)
		}
		return bearerRaw(t, method, server.URL+path, token, reader)
	}
	response = bearer(http.MethodPost, "/api/v1/printer-connector/enroll", *enrollment.EnrollmentSecret, map[string]any{"credentialId": uuid.Must(uuid.NewV7()).String(), "credentialSecret": credentialSecret, "softwareVersion": "test", "protocolVersion": 1})
	assertStatus(t, response, http.StatusOK)
	response.Body.Close()
	response = doJSON(t, adminClient, http.MethodPost, server.URL+"/api/v1/printer-connectors/"+connector.Id.String()+"/assignments", origin, adminCSRF, map[string]any{"machineId": machine.ID.String(), "adapterKind": "simulator", "adapterSchemaVersion": 1, "settings": map[string]any{"scenario": "idle"}, "secrets": map[string]any{}, "enabled": true})
	assertStatus(t, response, http.StatusCreated)
	var assignment openapi.PrinterConnectorAssignment
	decodeResponse(t, response, &assignment)

	statusPath := "/api/v1/printer-connector/self/assignments/" + assignment.Id.String() + "/status"
	now := time.Now().UTC()
	report := func(version int64, observedAt time.Time, extra string) *http.Response {
		body := bytes.NewReader([]byte(sprintfLiveStatus(version, observedAt, extra)))
		return bearerRaw(t, http.MethodPut, server.URL+statusPath, credentialSecret, body)
	}
	response = report(assignment.ConfigurationVersion, now, "")
	assertStatus(t, response, http.StatusNoContent)
	response.Body.Close()
	// An unknown field is not part of the contract, a stale version is a conflict, a user session is not a connector.
	response = report(assignment.ConfigurationVersion, now, `,"ipAddress":"192.168.1.5"`)
	if response.StatusCode != http.StatusBadRequest {
		t.Errorf("snapshot with an unknown field = %d, want 400", response.StatusCode)
	}
	response.Body.Close()
	response = report(assignment.ConfigurationVersion+1, now, "")
	assertStatus(t, response, http.StatusConflict)
	response.Body.Close()
	response = bearerRaw(t, http.MethodPut, server.URL+statusPath, "not-a-connector-credential", bytes.NewReader([]byte(sprintfLiveStatus(assignment.ConfigurationVersion, now, ""))))
	assertStatus(t, response, http.StatusUnauthorized)
	response.Body.Close()
	response = doJSON(t, adminClient, http.MethodPut, server.URL+statusPath, origin, adminCSRF, map[string]any{})
	if response.StatusCode < 400 {
		t.Errorf("a user session reached the connector endpoint: %d", response.StatusCode)
	}
	response.Body.Close()

	response = doJSON(t, readerClient, http.MethodGet, server.URL+livePath, "", "", nil)
	assertStatus(t, response, http.StatusOK)
	var live openapi.PrinterLiveStatus
	decodeResponse(t, response, &live)
	if live.AssignmentId != assignment.Id || live.Status.State != openapi.PrinterLiveStatusStatePrinting || len(live.Status.Units) != 2 || len(live.Status.Units[0].Trays) != 2 ||
		live.Status.Units[0].Trays[0].ColorHex.MustGet() != "FFF144" || live.Status.ActiveTray.MustGet().TrayExternalId != "0" || live.Status.WifiSignalDbm.MustGet() != -39 || len(live.Status.Errors) != 1 {
		t.Fatalf("live status = %+v", live)
	}
}

func bearerRaw(t *testing.T, method, endpoint, token string, body io.Reader) *http.Response {
	t.Helper()
	request, err := http.NewRequestWithContext(testContext(t), method, endpoint, body)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func sprintfLiveStatus(version int64, observedAt time.Time, extra string) string {
	stamp := observedAt.Format(time.RFC3339Nano)
	return fmt.Sprintf(liveStatusBody, version, stamp, stamp, extra)
}
