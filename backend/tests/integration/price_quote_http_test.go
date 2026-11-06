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
	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules"
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
	logbook := machinelogbook.NewService(pool, notifyrules.NewSystemEvents(nil))
	process, err := logbook.CreateProcess(ctx, master, "Quote printer", machinelogbook.IntegrationFDMPrinter, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	machine, err := logbook.CreateMachine(ctx, master, process.ID, "Quote machine", "active", nil, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	materialType, err := logbook.CreateMaterialType(ctx, master, "Quote PLA", "filament", "g", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	material, err := logbook.CreateMaterial(
		ctx,
		master,
		machinelogbook.MaterialInput{Name: "Quote PLA", MaterialTypeID: materialType.ID},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	group, err := logbook.CreatePricingGroup(ctx, master, "Quote group", nil, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = logbook.CreatePricingRule(ctx, master, group.ID, "machine_runtime", &process.ID, nil, nil, "12", nil); err != nil {
		t.Fatal(err)
	}
	if _, err = logbook.CreatePricingRule(ctx, master, group.ID, "material", nil, &materialType.ID, nil, "0.5", nil); err != nil {
		t.Fatal(err)
	}
	if _, err = logbook.CreateStockArticlePricingRule(ctx, master, group.ID, material.ID, "2", nil); err != nil {
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
		quote.Hours.GetOrEmpty() != "1.5" {
		t.Fatalf("unexpected quote: %+v", quote)
	}
	found := false
	for _, g := range quote.Groups {
		if g.PricingGroupId == group.ID {
			found = true
			// The article's own rate wins over its type's rate with a machine too.
			if g.MachineAmount.GetOrEmpty() != "18" || g.MaterialAmount.GetOrEmpty() != "20" ||
				g.Total.GetOrEmpty() != "38" || !g.Complete ||
				g.MaterialPriceSource.GetOrEmpty() != openapi.MaterialPriceSourceStockArticle {
				t.Fatalf("unexpected group: %+v", g)
			}
		}
	}
	if !found {
		t.Fatal("pricing group missing from quote")
	}
	// Without a machine the article is priced as a sale from stock.
	get(full, "materialId="+material.ID.String()+"&quantity=10", http.StatusOK, &quote)
	for _, g := range quote.Groups {
		if g.PricingGroupId == group.ID && (g.MaterialAmount.GetOrEmpty() != "20" ||
			g.MaterialPriceSource.GetOrEmpty() != openapi.MaterialPriceSourceStockArticle) {
			t.Fatalf("stock sale quote: %+v", g)
		}
	}

	// A variant's rate prices its articles before the type's rate.
	adminSession := login(adminLogin, adminPassword)
	post := func(path string, body map[string]any, status int, target any) {
		t.Helper()
		response := doJSON(t, adminSession.client, http.MethodPost, server.URL+"/api/v1"+path, origin, adminSession.csrf, body)
		assertStatus(t, response, status)
		if target != nil {
			decodeResponse(t, response, target)
		} else {
			response.Body.Close()
		}
	}
	var silk openapi.MaterialTypeVariant
	post("/material-types/"+materialType.ID.String()+"/variants", map[string]any{"name": "Silk"}, http.StatusCreated, &silk)
	var silkArticle openapi.Material
	post(
		"/materials",
		map[string]any{"materialTypeId": materialType.ID, "variant": " silk ", "colorName": "Gold"},
		http.StatusCreated,
		&silkArticle,
	)
	if silkArticle.VariantId.GetOrEmpty() != silk.Id || silkArticle.Variant.GetOrEmpty() != "Silk" ||
		silkArticle.Name != "Quote PLA Silk · Gold" {
		t.Fatalf("variant article = %+v", silkArticle)
	}
	variantRule := map[string]any{
		"kind": "material", "materialTypeId": materialType.ID, "materialTypeVariantId": silk.Id, "rate": "0.8",
	}
	var rule openapi.PricingRule
	post("/pricing-groups/"+group.ID.String()+"/rules", variantRule, http.StatusCreated, &rule)
	if rule.MaterialTypeVariantId.GetOrEmpty() != silk.Id || rule.MaterialTypeVariantName.GetOrEmpty() != "Silk" {
		t.Fatalf("variant rule = %+v", rule)
	}
	post("/pricing-groups/"+group.ID.String()+"/rules", variantRule, http.StatusConflict, nil)
	post(
		"/pricing-groups/"+group.ID.String()+"/rules",
		map[string]any{"kind": "stock_article", "materialId": material.ID, "materialTypeVariantId": silk.Id, "rate": "1"},
		http.StatusUnprocessableEntity,
		nil,
	)
	for _, query := range []string{
		"materialId=" + silkArticle.Id.String() + "&quantity=10",
		"machineId=" + machine.ID.String() + "&hours=0&materialId=" + silkArticle.Id.String() + "&quantity=10",
	} {
		get(full, query, http.StatusOK, &quote)
		if quote.Material.GetOrEmpty().Variant.GetOrEmpty() != "Silk" {
			t.Fatalf("quote material = %+v", quote.Material)
		}
		for _, g := range quote.Groups {
			if g.PricingGroupId == group.ID && (g.MaterialAmount.GetOrEmpty() != "8" ||
				g.MaterialPriceSource.GetOrEmpty() != openapi.MaterialPriceSourceMaterialTypeVariant) {
				t.Fatalf("variant quote %s: %+v", query, g)
			}
		}
	}
	response := doJSON(t, full.client, http.MethodGet, server.URL+"/api/v1/materials/"+silkArticle.Id.String(), "", "", nil)
	assertStatus(t, response, http.StatusOK)
	decodeResponse(t, response, &silkArticle)
	priced := false
	for _, p := range silkArticle.Prices {
		if p.PricingGroupId == group.ID {
			priced = p.Rate == "0.8" && p.Source == openapi.MaterialPriceSourceMaterialTypeVariant
		}
	}
	if !priced {
		t.Fatalf("variant article prices = %+v", silkArticle.Prices)
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
