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
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestMaterialTypeEndpointsEnforcePermissionsAndAuditOverHTTP(t *testing.T) {
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
		adminLogin    = "types-admin@example.test"
		adminPassword = "Types admin workshop password 61"
	)
	if _, err = admin.NewService(pool).BootstrapMaster(
		ctx,
		admin.BootstrapInput{
			FirstName:    "Runs",
			LastName:     "Admin",
			LoginEmail:   adminLogin,
			Password:     adminPassword,
		},
	); err != nil {
		t.Fatal(err)
	}
	baseURL, err := url.Parse(origin)
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{
		PublicBaseURL:      baseURL,
		SessionCookieName:  "makerspace_session",
		CSRFCookieName:     "makerspace_csrf",
		SessionIdleTTL:     6 * time.Hour,
		SessionAbsoluteTTL: 72 * time.Hour,
		PasswordResetTTL:   30 * time.Minute,
	}
	handler, err := httpapi.NewHandler(pool, cfg, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	defer server.Close()

	login := func(email, password string) (*http.Client, string) {
		client := newCookieClient(t)
		response := doJSON(
			t,
			client,
			http.MethodPost,
			server.URL+"/api/v1/auth/login",
			origin,
			"",
			map[string]any{"email": email, "password": password},
		)
		assertStatus(t, response, http.StatusNoContent)
		response.Body.Close()
		return client, cookieValue(t, client, server.URL, cfg.CSRFCookieName)
	}
	adminClient, adminCSRF := login(adminLogin, adminPassword)
	member := func(suffix string, permissions ...string) (*http.Client, string) {
		t.Helper()
		email, password := "types-"+suffix+"@example.test", "Types "+suffix+" workshop password 77"
		response := doJSON(
			t,
			adminClient,
			http.MethodPost,
			server.URL+"/api/v1/people",
			origin,
			adminCSRF,
			map[string]any{"firstName": "Runs", "lastName": suffix, "email": "contact-" + email},
		)
		assertStatus(t, response, http.StatusCreated)
		var person openapi.Person
		decodeResponse(t, response, &person)
		response = doJSON(
			t,
			adminClient,
			http.MethodPost,
			server.URL+"/api/v1/people/"+person.Id.String()+"/account",
			origin,
			adminCSRF,
			map[string]any{"loginEmail": email, "expectedVersion": person.Version},
		)
		assertStatus(t, response, http.StatusCreated)
		var account openapi.Account
		decodeResponse(t, response, &account)
		response = doJSON(
			t,
			adminClient,
			http.MethodPut,
			server.URL+"/api/v1/accounts/"+account.Id.String()+"/password",
			origin,
			adminCSRF,
			map[string]any{"newPassword": password, "expectedVersion": account.Version},
		)
		assertStatus(t, response, http.StatusOK)
		decodeResponse(t, response, &account)
		response = doJSON(
			t,
			adminClient,
			http.MethodPost,
			server.URL+"/api/v1/accounts/"+account.Id.String()+"/enable",
			origin,
			adminCSRF,
			map[string]any{"expectedVersion": account.Version},
		)
		assertStatus(t, response, http.StatusOK)
		response.Body.Close()
		grants := make([]map[string]any, 0, len(permissions))
		for _, permission := range permissions {
			grants = append(
				grants,
				map[string]any{
					"permissionId":     permission,
					"scope":            "everywhere",
					"deviceTypeIds":    []string{},
					"minimumAssurance": "low",
				},
			)
		}
		response = doJSON(
			t,
			adminClient,
			http.MethodPost,
			server.URL+"/api/v1/roles",
			origin,
			adminCSRF,
			map[string]any{"name": "Types " + suffix, "description": "Test role", "permissionGrants": grants},
		)
		assertStatus(t, response, http.StatusCreated)
		var role openapi.Role
		decodeResponse(t, response, &role)
		response = doJSON(t, adminClient, http.MethodGet, server.URL+"/api/v1/people/"+person.Id.String(), "", "", nil)
		assertStatus(t, response, http.StatusOK)
		decodeResponse(t, response, &person)
		response = doJSON(
			t,
			adminClient,
			http.MethodPut,
			server.URL+"/api/v1/people/"+person.Id.String()+"/roles/"+role.Id.String(),
			origin,
			adminCSRF,
			map[string]any{"expectedVersion": person.Version},
		)
		assertStatus(t, response, http.StatusOK)
		response.Body.Close()
		return login(email, password)
	}

	readerClient, readerCSRF := member("reader", "inventory.read")
	managerClient, managerCSRF := member("manager", "inventory.read", "inventory.manage")
	nobodyClient, nobodyCSRF := member("nobody", "machines.read")
	_ = adminCSRF

	base := server.URL + "/api/v1/material-types"
	// Reading needs inventory.read; writing needs inventory.manage.
	response := doJSON(t, nobodyClient, http.MethodGet, base, "", "", nil)
	assertStatus(t, response, http.StatusForbidden)
	response.Body.Close()
	create := map[string]any{"name": "PLA", "kind": "filament", "unit": "g", "processes": []string{"fdm_printing"}}
	for name, who := range map[string]struct {
		client *http.Client
		csrf   string
	}{"reader": {readerClient, readerCSRF}, "nobody": {nobodyClient, nobodyCSRF}} {
		response = doJSON(t, who.client, http.MethodPost, base, origin, who.csrf, create)
		if response.StatusCode != http.StatusForbidden {
			t.Errorf("create as %s = %d, want 403", name, response.StatusCode)
		}
		response.Body.Close()
	}
	assertCount(t, pool, `SELECT count(*) FROM material_types WHERE name = 'PLA'`, 0)

	response = doJSON(t, managerClient, http.MethodPost, base, origin, managerCSRF, create)
	assertStatus(t, response, http.StatusCreated)
	var created openapi.MaterialType
	decodeResponse(t, response, &created)
	if created.Name != "PLA" || created.Unit != "g" || !created.Active || created.MaterialCount != 0 {
		t.Fatalf("created = %+v", created)
	}
	if len(created.Processes) != 1 || created.Processes[0] != openapi.MachineProcessFdmPrinting {
		t.Fatalf("processes = %v", created.Processes)
	}
	response = doJSON(
		t,
		managerClient,
		http.MethodPost,
		base,
		origin,
		managerCSRF,
		map[string]any{"name": "No process", "kind": "consumable", "unit": "g", "processes": []string{}},
	)
	assertStatus(t, response, http.StatusUnprocessableEntity)
	response.Body.Close()
	response = doJSON(
		t,
		managerClient,
		http.MethodPost,
		base,
		origin,
		managerCSRF,
		map[string]any{"name": "pla", "kind": "filament", "unit": "g", "processes": []string{"fdm_printing"}},
	)
	assertStatus(t, response, http.StatusConflict)
	response.Body.Close()

	response = doJSON(t, readerClient, http.MethodGet, base, "", "", nil)
	assertStatus(t, response, http.StatusOK)
	var list openapi.MaterialTypeList
	decodeResponse(t, response, &list)
	if len(list.Items) != 1 || list.Items[0].Id != created.Id {
		t.Fatalf("list = %+v", list)
	}
	path := base + "/" + created.Id.String()
	update := map[string]any{"name": "PLA+", "unit": "g", "active": true, "expectedVersion": created.Version}
	response = doJSON(t, readerClient, http.MethodPatch, path, origin, readerCSRF, update)
	assertStatus(t, response, http.StatusForbidden)
	response.Body.Close()
	response = doJSON(t, managerClient, http.MethodPatch, path, origin, managerCSRF, update)
	assertStatus(t, response, http.StatusOK)
	decodeResponse(t, response, &created)

	// Materials follow the type's unit over HTTP and the colour code is validated.
	material := map[string]any{"name": "PLA Red", "materialTypeId": created.Id, "unit": "ml"}
	response = doJSON(t, managerClient, http.MethodPost, server.URL+"/api/v1/materials", origin, managerCSRF, material)
	assertStatus(t, response, http.StatusUnprocessableEntity)
	response.Body.Close()
	material = map[string]any{
		"name":           "PLA Red",
		"materialTypeId": created.Id,
		"colorName":      "Red",
		"colorHex":       "#C62828",
	}
	response = doJSON(t, managerClient, http.MethodPost, server.URL+"/api/v1/materials", origin, managerCSRF, material)
	assertStatus(t, response, http.StatusCreated)
	var m openapi.Material
	decodeResponse(t, response, &m)
	if m.Unit != "g" || m.MaterialTypeName != "PLA+" || m.ColorHex.GetOrEmpty() != "#C62828" {
		t.Fatalf("material = %+v", m)
	}
	response = doJSON(
		t,
		managerClient,
		http.MethodPatch,
		server.URL+"/api/v1/materials/"+m.Id.String(),
		origin,
		managerCSRF,
		map[string]any{
			"name":            "PLA Red",
			"materialTypeId":  created.Id,
			"colorName":       "Crimson",
			"colorHex":        "#B71C1C",
			"active":          true,
			"expectedVersion": m.Version,
		},
	)
	assertStatus(t, response, http.StatusOK)
	decodeResponse(t, response, &m)
	if m.ColorName.GetOrEmpty() != "Crimson" || m.ColorHex.GetOrEmpty() != "#B71C1C" {
		t.Fatalf("updated material = %+v", m)
	}
	material["colorHex"] = "#c62828"
	response = doJSON(t, managerClient, http.MethodPost, server.URL+"/api/v1/materials", origin, managerCSRF, material)
	if response.StatusCode != http.StatusBadRequest && response.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("lower-case colour code = %d", response.StatusCode)
	}
	response.Body.Close()

	// In use: delete answers 409 material_type_in_use; reader cannot delete.
	response = doJSON(
		t,
		readerClient,
		http.MethodDelete,
		path,
		origin,
		readerCSRF,
		map[string]any{"expectedVersion": created.Version},
	)
	assertStatus(t, response, http.StatusForbidden)
	response.Body.Close()
	response = doJSON(
		t,
		managerClient,
		http.MethodDelete,
		path,
		origin,
		managerCSRF,
		map[string]any{"expectedVersion": created.Version},
	)
	assertStatus(t, response, http.StatusConflict)
	var problem struct {
		Code string `json:"code"`
	}
	decodeResponse(t, response, &problem)
	if problem.Code != "material_type_in_use" {
		t.Fatalf("code = %q", problem.Code)
	}
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action = 'material_type.deleted'`, 0)

	// Unused: deleted with one audit event.
	response = doJSON(
		t,
		managerClient,
		http.MethodPost,
		base,
		origin,
		managerCSRF,
		map[string]any{"name": "Unused", "kind": "consumable", "unit": "m", "processes": []string{"embroidery"}},
	)
	assertStatus(t, response, http.StatusCreated)
	var unused openapi.MaterialType
	decodeResponse(t, response, &unused)
	response = doJSON(
		t,
		managerClient,
		http.MethodDelete,
		base+"/"+unused.Id.String(),
		origin,
		managerCSRF,
		map[string]any{"expectedVersion": unused.Version},
	)
	assertStatus(t, response, http.StatusNoContent)
	response.Body.Close()
	assertCount(
		t,
		pool,
		`SELECT count(*) FROM audit_events WHERE action = 'material_type.deleted' AND resource_id = $1`,
		1,
		unused.Id,
	)
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action = 'material_type.created'`, 2)
	_ = uuid.Nil
}
