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
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPriceQuoteOverHTTP(t *testing.T) {
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
		adminLogin    = "price-quote-admin@example.test"
		adminPassword = "Price quote admin password 51"
	)
	if _, err = admin.NewService(pool).BootstrapMaster(ctx, admin.BootstrapInput{FirstName: "Quote", LastName: "Admin", LoginEmail: adminLogin, Password: adminPassword}); err != nil {
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
		return session{client, cookieValue(t, client, server.URL, cfg.CSRFCookieName)}
	}
	root := login(adminLogin, adminPassword)
	member := func(suffix string, permissions ...string) session {
		t.Helper()
		email, password := "price-quote-"+suffix+"@example.test", "Price quote "+suffix+" workshop password 77"
		response := doJSON(
			t,
			root.client,
			http.MethodPost,
			server.URL+"/api/v1/people",
			origin,
			root.csrf,
			map[string]any{"firstName": "Quote", "lastName": suffix, "email": "contact-" + email},
		)
		assertStatus(t, response, http.StatusCreated)
		var person openapi.Person
		decodeResponse(t, response, &person)
		response = doJSON(
			t,
			root.client,
			http.MethodPost,
			server.URL+"/api/v1/people/"+person.Id.String()+"/account",
			origin,
			root.csrf,
			map[string]any{"loginEmail": email, "expectedVersion": person.Version},
		)
		assertStatus(t, response, http.StatusCreated)
		var account openapi.Account
		decodeResponse(t, response, &account)
		response = doJSON(
			t,
			root.client,
			http.MethodPut,
			server.URL+"/api/v1/accounts/"+account.Id.String()+"/password",
			origin,
			root.csrf,
			map[string]any{"newPassword": password, "expectedVersion": account.Version},
		)
		assertStatus(t, response, http.StatusOK)
		decodeResponse(t, response, &account)
		response = doJSON(
			t,
			root.client,
			http.MethodPost,
			server.URL+"/api/v1/accounts/"+account.Id.String()+"/enable",
			origin,
			root.csrf,
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
			root.client,
			http.MethodPost,
			server.URL+"/api/v1/roles",
			origin,
			root.csrf,
			map[string]any{"name": "Price quote " + suffix, "description": "Test role", "permissionGrants": grants},
		)
		assertStatus(t, response, http.StatusCreated)
		var role openapi.Role
		decodeResponse(t, response, &role)
		response = doJSON(t, root.client, http.MethodGet, server.URL+"/api/v1/people/"+person.Id.String(), "", "", nil)
		assertStatus(t, response, http.StatusOK)
		decodeResponse(t, response, &person)
		response = doJSON(
			t,
			root.client,
			http.MethodPut,
			server.URL+"/api/v1/people/"+person.Id.String()+"/roles/"+role.Id.String(),
			origin,
			root.csrf,
			map[string]any{"expectedVersion": person.Version},
		)
		assertStatus(t, response, http.StatusOK)
		response.Body.Close()
		return login(email, password)
	}
	pricingOnly := member("pricing", "pricing.read")
	full := member("full", "pricing.read", "machines.read", "inventory.read")
	noPricing := member("nopricing", "machines.read", "inventory.read")

	var accountID, personID uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT a.id, a.person_id FROM accounts a JOIN auth_identities i ON i.account_id = a.id WHERE i.identifier_normalized = $1`, adminLogin).Scan(&accountID, &personID); err != nil {
		t.Fatal(err)
	}
	master := authorization.Principal{AccountID: accountID, PersonID: personID, Master: true}
	logbook := machinelogbook.NewService(pool)
	machineType, err := logbook.CreateMachineType(ctx, master, "Quote printer", "fdm_printing", nil)
	if err != nil {
		t.Fatal(err)
	}
	machine, err := logbook.CreateMachine(ctx, master, machineType.ID, "Quote machine", "active", nil, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	materialType, err := logbook.CreateMaterialType(ctx, master, "Quote PLA", "filament", "g", []string{"fdm_printing"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	salePrice := "2"
	material, err := logbook.CreateMaterial(
		ctx,
		master,
		machinelogbook.MaterialInput{Name: "Quote PLA", MaterialTypeID: materialType.ID, SalePrice: &salePrice},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	group, err := logbook.CreatePricingGroup(ctx, master, "Quote group", nil, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = logbook.CreatePricingRule(ctx, master, group.ID, "machine_runtime", &machineType.ID, nil, nil, "12", nil); err != nil {
		t.Fatal(err)
	}
	if _, err = logbook.CreatePricingRule(ctx, master, group.ID, "material", nil, &materialType.ID, nil, "0.5", nil); err != nil {
		t.Fatal(err)
	}
	get := func(s session, query string, status int, target any) {
		t.Helper()
		response := doJSON(t, s.client, http.MethodGet, server.URL+"/api/v1/pricing/quote?"+query, "", "", nil)
		assertStatus(t, response, status)
		if target != nil {
			decodeResponse(t, response, target)
		} else {
			response.Body.Close()
		}
	}
	combined := "machineId=" + machine.ID.String() + "&hours=1.5&materialId=" + material.ID.String() + "&quantity=10"

	var quote openapi.PriceQuote
	get(full, combined, http.StatusOK, &quote)
	if quote.Machine.GetOrEmpty().Id != machine.ID || quote.Material.GetOrEmpty().Id != material.ID ||
		quote.SaleAmount.GetOrEmpty() != "20" || quote.Hours.GetOrEmpty() != "1.5" {
		t.Fatalf("unexpected quote: %+v", quote)
	}
	found := false
	for _, g := range quote.Groups {
		if g.PricingGroupId == group.ID {
			found = true
			if g.MachineAmount.GetOrEmpty() != "18" || g.MaterialAmount.GetOrEmpty() != "5" ||
				g.Total.GetOrEmpty() != "23" || !g.Complete {
				t.Fatalf("unexpected group: %+v", g)
			}
		}
	}
	if !found {
		t.Fatal("pricing group missing from quote")
	}

	get(noPricing, combined, http.StatusForbidden, nil)
	get(pricingOnly, combined, http.StatusForbidden, nil)
	get(pricingOnly, "machineId="+machine.ID.String()+"&hours=1", http.StatusForbidden, nil)
	get(full, "hours=1", http.StatusUnprocessableEntity, nil)
	get(full, "", http.StatusUnprocessableEntity, nil)
	get(full, "machineId="+machine.ID.String()+"&hours=-1", http.StatusUnprocessableEntity, nil)
	get(full, "machineId="+ids.New().String()+"&hours=1", http.StatusNotFound, nil)
	get(full, "machineId="+machine.ID.String(), http.StatusUnprocessableEntity, nil)
}
