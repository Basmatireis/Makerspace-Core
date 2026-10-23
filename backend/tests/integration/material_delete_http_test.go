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
	"github.com/Basmatireis/Makerspace-Core/backend/internal/httpapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/inbox"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/google/uuid"
)

func TestDeleteMaterialOverHTTP(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	const (
		origin        = "http://makerspace.example.test"
		adminLogin    = "material-delete-admin@example.test"
		adminPassword = "Material delete admin password 51"
		readerLogin   = "material-delete-reader@example.test"
		readerPass    = "Material delete reader password 77"
	)
	if _, err := admin.NewService(pool).BootstrapMaster(ctx, admin.BootstrapInput{
		FirstName: "Delete", LastName: "Admin", LoginEmail: adminLogin, Password: adminPassword,
	}); err != nil {
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

	type session struct {
		client *http.Client
		csrf   string
	}
	login := func(email, password string) session {
		client := newCookieClient(t)
		response := doJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/login", origin, "",
			map[string]any{"email": email, "password": password})
		assertStatus(t, response, http.StatusNoContent)
		response.Body.Close()
		return session{client, cookieValue(t, client, server.URL, cfg.CSRFCookieName)}
	}
	root := login(adminLogin, adminPassword)
	post := func(s session, method, path string, status int, body any, target any) {
		t.Helper()
		csrf, requestOrigin := s.csrf, origin
		if method == http.MethodGet {
			csrf, requestOrigin = "", ""
		}
		response := doJSON(t, s.client, method, server.URL+"/api/v1"+path, requestOrigin, csrf, body)
		assertStatus(t, response, status)
		if target != nil {
			decodeResponse(t, response, target)
		} else {
			response.Body.Close()
		}
	}

	// A member whose role only reads the inventory.
	var person openapi.Person
	post(root, http.MethodPost, "/people", http.StatusCreated,
		map[string]any{"firstName": "Delete", "lastName": "Reader", "email": "contact-" + readerLogin}, &person)
	var account openapi.Account
	post(root, http.MethodPost, "/people/"+person.Id.String()+"/account", http.StatusCreated,
		map[string]any{"loginEmail": readerLogin, "expectedVersion": person.Version}, &account)
	post(root, http.MethodPut, "/accounts/"+account.Id.String()+"/password", http.StatusOK,
		map[string]any{"newPassword": readerPass, "expectedVersion": account.Version}, &account)
	post(root, http.MethodPost, "/accounts/"+account.Id.String()+"/enable", http.StatusOK,
		map[string]any{"expectedVersion": account.Version}, nil)
	var role openapi.Role
	post(root, http.MethodPost, "/roles", http.StatusCreated, map[string]any{
		"name": "Material delete reader", "description": "Test role",
		"permissionGrants": []map[string]any{{
			"permissionId": "inventory.read", "scope": "everywhere", "deviceTypeIds": []string{}, "minimumAssurance": "low",
		}},
	}, &role)
	post(root, http.MethodGet, "/people/"+person.Id.String(), http.StatusOK, nil, &person)
	post(root, http.MethodPut, "/people/"+person.Id.String()+"/roles/"+role.Id.String(), http.StatusOK,
		map[string]any{"expectedVersion": person.Version}, nil)
	reader := login(readerLogin, readerPass)

	var accountID, personID uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT a.id, a.person_id FROM accounts a JOIN auth_identities i ON i.account_id = a.id WHERE i.identifier_normalized = $1`, adminLogin).Scan(&accountID, &personID); err != nil {
		t.Fatal(err)
	}
	master := authorization.Principal{AccountID: accountID, PersonID: personID, Master: true}
	logbook := machinelogbook.NewService(pool, inbox.NewEmitter())
	diameter := "1.75"
	materialType, err := logbook.CreateMaterialType(ctx, master, "Delete PLA", "filament", "g", []string{"fdm_printing"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	create := func(name string) machinelogbook.Material {
		m, createErr := logbook.CreateMaterial(
			ctx, master,
			machinelogbook.MaterialInput{Name: name, MaterialTypeID: materialType.ID, FilamentDiameterMM: &diameter}, nil,
		)
		if createErr != nil {
			t.Fatal(createErr)
		}
		return m
	}
	unused, used := create("Delete unused PLA"), create("Delete used PLA")
	if _, err = logbook.AddPurchase(ctx, master, used.ID, used.InventoryVersion, "1000", "20", time.Now().UTC(), nil, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	used, err = logbook.GetMaterial(ctx, master, used.ID)
	if err != nil {
		t.Fatal(err)
	}
	body := func(m machinelogbook.Material) map[string]any { return map[string]any{"expectedVersion": m.Version} }

	var read openapi.Material
	post(reader, http.MethodGet, "/materials/"+unused.ID.String(), http.StatusOK, nil, &read)
	if read.Deletable == nil || !*read.Deletable {
		t.Fatalf("unused article must be deletable: %+v", read.Deletable)
	}
	post(reader, http.MethodGet, "/materials/"+used.ID.String(), http.StatusOK, nil, &read)
	if read.Deletable == nil || *read.Deletable {
		t.Fatalf("used article must not be deletable: %+v", read.Deletable)
	}

	// Only inventory.manage deletes; the reader is refused before anything is touched.
	post(reader, http.MethodDelete, "/materials/"+unused.ID.String(), http.StatusForbidden, body(unused), nil)
	post(root, http.MethodDelete, "/materials/"+unused.ID.String(), http.StatusConflict,
		map[string]any{"expectedVersion": unused.Version + 1}, nil)

	var refused openapi.Error
	post(root, http.MethodDelete, "/materials/"+used.ID.String(), http.StatusConflict, body(used), &refused)
	if refused.Code != "material_in_use" || refused.Details == nil || (*refused.Details)["uses"] == nil {
		t.Fatalf("in-use refusal: %+v", refused)
	}

	post(root, http.MethodDelete, "/materials/"+unused.ID.String(), http.StatusNoContent, body(unused), nil)
	post(root, http.MethodGet, "/materials/"+unused.ID.String(), http.StatusNotFound, nil, nil)
	post(root, http.MethodGet, "/materials/"+used.ID.String(), http.StatusOK, nil, nil)
}
