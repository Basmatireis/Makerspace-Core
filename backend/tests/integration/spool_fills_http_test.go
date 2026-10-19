package integration_test

import (
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/admin"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/httpapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestFilamentSpoolFillsCleanupAndProductsOverHTTP(t *testing.T) {
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
		adminLogin    = "spool-fills-admin@example.test"
		adminPassword = "Spool fills admin password 51"
	)
	if _, err = admin.NewService(pool).BootstrapMaster(ctx, admin.BootstrapInput{FirstName: "Spool", LastName: "Admin", ContactEmail: "spool-fills-contact@example.test", LoginEmail: adminLogin, Password: adminPassword}); err != nil {
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

	type session struct {
		client *http.Client
		csrf   string
	}
	login := func(email, password string) session {
		client := newCookieClient(t)
		response := doJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/login", origin, "", map[string]any{"email": email, "password": password})
		assertStatus(t, response, http.StatusNoContent)
		response.Body.Close()
		return session{client, cookieValue(t, client, server.URL, cfg.CSRFCookieName)}
	}
	root := login(adminLogin, adminPassword)
	member := func(suffix string, permissions ...string) session {
		t.Helper()
		email, password := "spool-fills-"+suffix+"@example.test", "Spool fills "+suffix+" workshop password 77"
		response := doJSON(t, root.client, http.MethodPost, server.URL+"/api/v1/people", origin, root.csrf, map[string]any{"firstName": "Spool", "lastName": suffix, "email": "contact-" + email})
		assertStatus(t, response, http.StatusCreated)
		var person openapi.Person
		decodeResponse(t, response, &person)
		response = doJSON(t, root.client, http.MethodPost, server.URL+"/api/v1/people/"+person.Id.String()+"/account", origin, root.csrf, map[string]any{"loginEmail": email, "expectedVersion": person.Version})
		assertStatus(t, response, http.StatusCreated)
		var account openapi.Account
		decodeResponse(t, response, &account)
		response = doJSON(t, root.client, http.MethodPut, server.URL+"/api/v1/accounts/"+account.Id.String()+"/password", origin, root.csrf, map[string]any{"newPassword": password, "expectedVersion": account.Version})
		assertStatus(t, response, http.StatusOK)
		decodeResponse(t, response, &account)
		response = doJSON(t, root.client, http.MethodPost, server.URL+"/api/v1/accounts/"+account.Id.String()+"/enable", origin, root.csrf, map[string]any{"expectedVersion": account.Version})
		assertStatus(t, response, http.StatusOK)
		response.Body.Close()
		grants := make([]map[string]any, 0, len(permissions))
		for _, permission := range permissions {
			grants = append(grants, map[string]any{"permissionId": permission, "scope": "everywhere", "deviceTypeIds": []string{}, "minimumAssurance": "low"})
		}
		response = doJSON(t, root.client, http.MethodPost, server.URL+"/api/v1/roles", origin, root.csrf, map[string]any{"name": "Spool fills " + suffix, "description": "Test role", "permissionGrants": grants})
		assertStatus(t, response, http.StatusCreated)
		var role openapi.Role
		decodeResponse(t, response, &role)
		response = doJSON(t, root.client, http.MethodGet, server.URL+"/api/v1/people/"+person.Id.String(), "", "", nil)
		assertStatus(t, response, http.StatusOK)
		decodeResponse(t, response, &person)
		response = doJSON(t, root.client, http.MethodPut, server.URL+"/api/v1/people/"+person.Id.String()+"/roles/"+role.Id.String(), origin, root.csrf, map[string]any{"expectedVersion": person.Version})
		assertStatus(t, response, http.StatusOK)
		response.Body.Close()
		return login(email, password)
	}
	reader := member("reader", "inventory.read")
	spoolsOnly := member("spools", "inventory.read", "filament_spools.manage")
	inventoryOnly := member("inventory", "inventory.read", "inventory.manage")
	noInventoryRead := member("noread", "filament_spools.manage", "inventory.manage")

	var accountID, personID uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT a.id, a.person_id FROM accounts a JOIN auth_identities i ON i.account_id = a.id WHERE i.identifier_normalized = $1`, adminLogin).Scan(&accountID, &personID); err != nil {
		t.Fatal(err)
	}
	master := authorization.Principal{AccountID: accountID, PersonID: personID, Master: true}
	logbook := machinelogbook.NewService(pool)
	diameter := "1.75"
	plaType, err := logbook.CreateMaterialType(ctx, master, "HTTP PLA", "g", nil)
	if err != nil {
		t.Fatal(err)
	}
	material, err := logbook.CreateMaterial(ctx, master, machinelogbook.MaterialInput{Name: "HTTP PLA", MaterialTypeID: plaType.ID, FilamentDiameterMM: &diameter}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = logbook.AddPurchase(ctx, master, material.ID, material.InventoryVersion, "3000", "60", time.Now().UTC(), nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	tare := "200"
	freshMaterial, err := logbook.GetMaterial(ctx, master, material.ID)
	if err != nil {
		t.Fatal(err)
	}
	spool, err := logbook.CreateFilamentSpool(ctx, master, machinelogbook.FilamentSpoolInput{Kind: "reusable", MaterialID: material.ID, InitialNetWeightG: "1000", StockMode: "existing_stock", TareWeightG: &tare, OccurredAt: time.Now().UTC().Add(-time.Hour), ExpectedInventoryVersion: freshMaterial.InventoryVersion}, nil)
	if err != nil {
		t.Fatal(err)
	}
	api := func(s session, method, path string, status int, body any, target any) {
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
	changeBody := func(version int64, leftover any) map[string]any {
		body := map[string]any{
			"fill":              map[string]any{"materialId": material.ID, "netWeightG": "400", "source": "loose_stock"},
			"keepIdentifierIds": []string{}, "newIdentifiers": []map[string]any{{"kind": "nfc", "value": "http-tag"}},
			"occurredAt": time.Now().UTC().Format(time.RFC3339), "expectedVersion": version,
		}
		if leftover != nil {
			body["leftover"] = leftover
		}
		return body
	}
	returned := map[string]any{"basis": "system", "disposition": "returned_to_stock"}

	// Each required permission is enforced for changing the fill.
	api(reader, http.MethodPost, "/filament-spools/"+spool.ID.String()+"/fills", http.StatusForbidden, changeBody(spool.Version, returned), nil)
	api(spoolsOnly, http.MethodPost, "/filament-spools/"+spool.ID.String()+"/fills", http.StatusForbidden, changeBody(spool.Version, returned), nil)
	api(inventoryOnly, http.MethodPost, "/filament-spools/"+spool.ID.String()+"/fills", http.StatusForbidden, changeBody(spool.Version, returned), nil)
	api(root, http.MethodPost, "/filament-spools/"+spool.ID.String()+"/fills", http.StatusUnprocessableEntity, changeBody(spool.Version, nil), nil)
	var changed openapi.FilamentSpool
	api(root, http.MethodPost, "/filament-spools/"+spool.ID.String()+"/fills", http.StatusCreated, changeBody(spool.Version, returned), &changed)
	if changed.FillNumber != 2 || changed.Status != openapi.FilamentSpoolStatusLoaded || changed.RemainingQuantity != "400" || len(changed.Identifiers) != 1 {
		t.Fatalf("changed spool: %+v", changed)
	}
	var stale map[string]any
	api(root, http.MethodPost, "/filament-spools/"+spool.ID.String()+"/fills", http.StatusConflict, changeBody(spool.Version, returned), &stale)

	var detail openapi.FilamentSpool
	api(reader, http.MethodGet, "/filament-spools/"+spool.ID.String(), http.StatusOK, nil, &detail)
	if detail.Fills == nil || len(*detail.Fills) != 1 || (*detail.Fills)[0].LeftoverOutcome != openapi.LeftoverOutcomeReturnedToStock || (*detail.Fills)[0].LeftoverG != "1000" {
		t.Fatalf("fill history: %+v", detail.Fills)
	}
	var page openapi.FilamentSpoolPage
	api(reader, http.MethodGet, "/filament-spools?status=loaded&status=needs_refill&consumable=true&kind=reusable&pageSize=100", http.StatusOK, nil, &page)
	if page.Total < 1 {
		t.Fatalf("status filter: %+v", page)
	}
	api(reader, http.MethodGet, "/filament-spools?status=bogus", http.StatusBadRequest, nil, nil)
	api(reader, http.MethodGet, "/filament-spools?status=loaded,needs_refill", http.StatusBadRequest, nil, nil)

	// Empty reusable spools, nullable mount and ledger actor over the wire.
	emptyBody := map[string]any{"kind": "reusable", "label": "Http empty", "stockMode": "empty", "supplier": "Ignored shop", "occurredAt": time.Now().UTC().Format(time.RFC3339)}
	api(reader, http.MethodPost, "/filament-spools", http.StatusForbidden, emptyBody, nil)
	api(spoolsOnly, http.MethodPost, "/filament-spools", http.StatusForbidden, emptyBody, nil)
	api(inventoryOnly, http.MethodPost, "/filament-spools", http.StatusForbidden, emptyBody, nil)
	var emptyRaw map[string]any
	api(root, http.MethodPost, "/filament-spools", http.StatusCreated, emptyBody, &emptyRaw)
	if mountedOn, present := emptyRaw["mountedOn"]; !present || mountedOn != nil || emptyRaw["status"] != "needs_refill" || emptyRaw["fillId"] != nil {
		t.Fatalf("empty spool: %+v", emptyRaw)
	}
	singleEmpty := map[string]any{"label": "Http single empty", "stockMode": "empty", "occurredAt": time.Now().UTC().Format(time.RFC3339)}
	var problem map[string]any
	api(root, http.MethodPost, "/filament-spools", http.StatusUnprocessableEntity, singleEmpty, &problem)
	if problem["code"] != "empty_requires_reusable" {
		t.Fatalf("problem: %+v", problem)
	}
	api(root, http.MethodPost, "/filament-spools", http.StatusUnprocessableEntity, map[string]any{"kind": "reusable", "stockMode": "existing_stock", "occurredAt": time.Now().UTC().Format(time.RFC3339)}, nil)
	var ledger openapi.InventoryTransactionPage
	api(reader, http.MethodGet, "/filament-spools/"+spool.ID.String()+"/transactions", http.StatusOK, nil, &ledger)
	if len(ledger.Items) == 0 {
		t.Fatal("spool ledger is empty")
	}
	for _, item := range ledger.Items {
		if name, err := item.ActorName.Get(); err != nil || name != "Spool Admin" {
			t.Fatalf("ledger actor: %+v %v", item.ActorName, err)
		}
	}

	// Finish and cleanup.
	finish := map[string]any{"leftover": map[string]any{"basis": "none"}, "occurredAt": time.Now().UTC().Format(time.RFC3339), "expectedVersion": changed.Version}
	api(spoolsOnly, http.MethodPost, "/filament-spools/"+spool.ID.String()+"/finish", http.StatusForbidden, finish, nil)
	var finished openapi.FilamentSpool
	api(root, http.MethodPost, "/filament-spools/"+spool.ID.String()+"/finish", http.StatusOK, finish, &finished)
	if finished.Status != openapi.FilamentSpoolStatusNeedsRefill || finished.Mounted {
		t.Fatalf("finished: %+v", finished)
	}
	single, err := logbook.CreateFilamentSpool(ctx, master, machinelogbook.FilamentSpoolInput{MaterialID: material.ID, InitialNetWeightG: "100", StockMode: "existing_stock", OccurredAt: time.Now().UTC().Add(-time.Hour), ExpectedInventoryVersion: func() int64 { m, _ := logbook.GetMaterial(ctx, master, material.ID); return m.InventoryVersion }()}, nil)
	if err != nil {
		t.Fatal(err)
	}
	api(root, http.MethodPost, "/filament-spools/"+single.ID.String()+"/finish", http.StatusOK, map[string]any{"leftover": map[string]any{"basis": "none"}, "occurredAt": time.Now().UTC().Format(time.RFC3339), "expectedVersion": single.Version}, nil)
	dry := map[string]any{"olderThanMonths": 1, "dryRun": true}
	api(spoolsOnly, http.MethodPost, "/filament-spools/cleanup", http.StatusForbidden, dry, nil)
	api(inventoryOnly, http.MethodPost, "/filament-spools/cleanup", http.StatusForbidden, dry, nil)
	var preview openapi.CleanUpFilamentSpoolsResult
	api(root, http.MethodPost, "/filament-spools/cleanup", http.StatusOK, dry, &preview)
	if preview.Deleted || len(preview.Items) != 0 {
		t.Fatalf("nothing is old enough yet: %+v", preview)
	}
	api(root, http.MethodPost, "/filament-spools/cleanup", http.StatusUnprocessableEntity, map[string]any{"olderThanMonths": 1, "dryRun": false}, nil)
	api(root, http.MethodPost, "/filament-spools/cleanup", http.StatusBadRequest, map[string]any{"olderThanMonths": 2, "dryRun": true}, nil)
	var deleted openapi.CleanUpFilamentSpoolsResult
	api(root, http.MethodPost, "/filament-spools/cleanup", http.StatusOK, map[string]any{"olderThanMonths": 1, "dryRun": false, "spoolIds": []uuid.UUID{single.ID, spool.ID}}, &deleted)
	if !deleted.Deleted || len(deleted.Items) != 0 {
		t.Fatalf("recent and reusable spools must survive: %+v", deleted)
	}

	// Product catalog.
	product := map[string]any{"manufacturer": "Http Maker", "name": "Http PLA", "materialId": material.ID, "netWeightG": "1000", "packaging": "refill", "defaultPrice": "19.90"}
	api(reader, http.MethodPost, "/filament-products", http.StatusForbidden, product, nil)
	api(spoolsOnly, http.MethodPost, "/filament-products", http.StatusForbidden, product, nil)
	var created openapi.FilamentProduct
	api(inventoryOnly, http.MethodPost, "/filament-products", http.StatusCreated, product, &created)
	api(root, http.MethodPost, "/filament-products", http.StatusConflict, product, nil)
	var fetched openapi.FilamentProduct
	api(noInventoryRead, http.MethodGet, "/filament-products/"+created.Id.String(), http.StatusForbidden, nil, nil)
	api(noInventoryRead, http.MethodGet, "/filament-products?search=http", http.StatusForbidden, nil, nil)
	api(reader, http.MethodGet, "/filament-products/"+created.Id.String(), http.StatusOK, nil, &fetched)
	if fetched.InUseCount != 0 || !fetched.Active || fetched.MaterialName != "HTTP PLA" {
		t.Fatalf("product: %+v", fetched)
	}
	update := map[string]any{"manufacturer": "Http Maker", "name": "Http PLA", "materialId": material.ID, "netWeightG": "1000", "packaging": "spool", "active": false, "expectedVersion": created.Version}
	api(reader, http.MethodPatch, "/filament-products/"+created.Id.String(), http.StatusForbidden, update, nil)
	api(inventoryOnly, http.MethodPatch, "/filament-products/"+created.Id.String(), http.StatusOK, update, nil)
	api(inventoryOnly, http.MethodPatch, "/filament-products/"+created.Id.String(), http.StatusConflict, update, nil)
	var listed openapi.FilamentProductPage
	api(reader, http.MethodGet, "/filament-products?search=http&pageSize=10", http.StatusOK, nil, &listed)
	if listed.Total != 0 {
		t.Fatalf("inactive products are hidden by default: %+v", listed)
	}
	api(reader, http.MethodGet, "/filament-products?search=http&includeInactive=true", http.StatusOK, nil, &listed)
	if listed.Total != 1 || !strings.EqualFold(listed.Items[0].Name, "http pla") {
		t.Fatalf("includeInactive: %+v", listed)
	}
	_ = fmt.Sprint
}
