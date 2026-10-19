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

func TestOrganizationEndpointsEnforcePermissionsAndAuditOverHTTP(t *testing.T) {
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
		adminLogin    = "orgs-admin@example.test"
		adminPassword = "Orgs admin workshop password 61"
	)
	if _, err = admin.NewService(pool).BootstrapMaster(ctx, admin.BootstrapInput{FirstName: "Runs", LastName: "Admin", ContactEmail: "orgs-contact@example.test", LoginEmail: adminLogin, Password: adminPassword}); err != nil {
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
		email, password := "orgs-"+suffix+"@example.test", "Orgs "+suffix+" workshop password 77"
		response := doJSON(t, adminClient, http.MethodPost, server.URL+"/api/v1/people", origin, adminCSRF, map[string]any{"firstName": "Runs", "lastName": suffix, "email": "contact-" + email})
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
		response = doJSON(t, adminClient, http.MethodPost, server.URL+"/api/v1/roles", origin, adminCSRF, map[string]any{"name": "Orgs " + suffix, "description": "Test role", "permissionGrants": grants})
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

	var personID uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT a.person_id FROM accounts a JOIN auth_identities i ON i.account_id = a.id WHERE i.identifier_normalized = $1`, adminLogin).Scan(&personID); err != nil {
		t.Fatal(err)
	}
	readerClient, readerCSRF := member("reader", "organizations.read")
	managerClient, managerCSRF := member("manager", "organizations.read", "organizations.manage")
	nobodyClient, nobodyCSRF := member("nobody", "machines.read")
	creatorClient, creatorCSRF := member("creator", "machine_jobs.create")

	// Only organizations.manage may create; the refused calls leave nothing behind.
	create := map[string]any{"name": "Atelier GmbH", "kind": "company", "addressLine": " Hauptstr. 1 ", "postalCode": "1010", "locality": "Wien", "countryCode": "at", "contactName": "Erika Muster", "contactEmail": "erika@atelier.example.test"}
	for name, who := range map[string]struct {
		client *http.Client
		csrf   string
	}{"reader": {readerClient, readerCSRF}, "nobody": {nobodyClient, nobodyCSRF}, "creator": {creatorClient, creatorCSRF}} {
		response := doJSON(t, who.client, http.MethodPost, server.URL+"/api/v1/organizations", origin, who.csrf, create)
		if response.StatusCode != http.StatusForbidden {
			t.Errorf("create as %s = %d, want 403", name, response.StatusCode)
		}
		response.Body.Close()
	}
	assertCount(t, pool, `SELECT count(*) FROM organizations`, 0)

	response := doJSON(t, managerClient, http.MethodPost, server.URL+"/api/v1/organizations", origin, managerCSRF, create)
	assertStatus(t, response, http.StatusCreated)
	var organization openapi.Organization
	decodeResponse(t, response, &organization)
	if organization.AddressLine != "Hauptstr. 1" || organization.CountryCode != "AT" || organization.ContactEmail != "erika@atelier.example.test" || organization.MemberCount != 0 {
		t.Fatalf("created organization = %+v", organization)
	}
	orgPath := "/api/v1/organizations/" + organization.Id.String()

	// Invalid details are rejected before anything is stored.
	for _, bad := range []map[string]any{{"countryCode": "A1"}, {"contactEmail": "Erika <erika@atelier.example.test>"}, {"contactEmail": "not-an-email"}} {
		payload := map[string]any{"expectedVersion": organization.Version, "name": "Atelier GmbH", "kind": "company", "active": true}
		for k, v := range bad {
			payload[k] = v
		}
		response = doJSON(t, managerClient, http.MethodPatch, server.URL+orgPath, origin, managerCSRF, payload)
		assertStatus(t, response, http.StatusUnprocessableEntity)
		response.Body.Close()
	}

	// Reading needs organizations.read.
	for _, path := range []string{"/api/v1/organizations", orgPath, orgPath + "/members"} {
		response = doJSON(t, nobodyClient, http.MethodGet, server.URL+path, "", "", nil)
		if response.StatusCode != http.StatusForbidden {
			t.Errorf("GET %s without organizations.read = %d, want 403", path, response.StatusCode)
		}
		response.Body.Close()
		response = doJSON(t, readerClient, http.MethodGet, server.URL+path, "", "", nil)
		assertStatus(t, response, http.StatusOK)
		response.Body.Close()
	}

	// Mutations need organizations.manage: a reader is refused everywhere.
	memberBody := map[string]any{"personId": personID.String()}
	mutations := []struct {
		name, method, path string
		body               any
	}{
		{"update", http.MethodPatch, orgPath, map[string]any{"expectedVersion": organization.Version, "name": "Renamed", "kind": "company", "active": true}},
		{"add member", http.MethodPost, orgPath + "/members", memberBody},
		{"remove member", http.MethodDelete, orgPath + "/members/" + personID.String(), nil},
	}
	for _, who := range []struct {
		name   string
		client *http.Client
		csrf   string
	}{{"reader", readerClient, readerCSRF}, {"nobody", nobodyClient, nobodyCSRF}, {"creator", creatorClient, creatorCSRF}} {
		for _, m := range mutations {
			response = doJSON(t, who.client, m.method, server.URL+m.path, origin, who.csrf, m.body)
			if response.StatusCode != http.StatusForbidden {
				t.Errorf("%s as %s = %d, want 403", m.name, who.name, response.StatusCode)
			}
			response.Body.Close()
		}
	}
	assertCount(t, pool, `SELECT count(*) FROM organization_members`, 0)

	// A manager adds a member; duplicates conflict, unknown people are rejected.
	response = doJSON(t, managerClient, http.MethodPost, server.URL+orgPath+"/members", origin, managerCSRF, memberBody)
	assertStatus(t, response, http.StatusCreated)
	response.Body.Close()
	response = doJSON(t, managerClient, http.MethodPost, server.URL+orgPath+"/members", origin, managerCSRF, memberBody)
	assertStatus(t, response, http.StatusConflict)
	response.Body.Close()
	response = doJSON(t, managerClient, http.MethodPost, server.URL+orgPath+"/members", origin, managerCSRF, map[string]any{"personId": uuid.Must(uuid.NewV7()).String()})
	assertStatus(t, response, http.StatusUnprocessableEntity)
	response.Body.Close()
	response = doJSON(t, readerClient, http.MethodGet, server.URL+orgPath+"/members", "", "", nil)
	assertStatus(t, response, http.StatusOK)
	var members openapi.OrganizationMemberList
	decodeResponse(t, response, &members)
	if len(members.Items) != 1 || members.Items[0].PersonId != personID {
		t.Fatalf("members = %+v", members)
	}
	response = doJSON(t, readerClient, http.MethodGet, server.URL+orgPath, "", "", nil)
	assertStatus(t, response, http.StatusOK)
	decodeResponse(t, response, &organization)
	if organization.MemberCount != 1 {
		t.Fatalf("memberCount = %d", organization.MemberCount)
	}

	// The member shows up as a suggestion on the person's billing-party entry
	// for job creators, without needing organizations.read.
	response = doJSON(t, creatorClient, http.MethodGet, server.URL+"/api/v1/billing-parties?search=Admin", "", "", nil)
	assertStatus(t, response, http.StatusOK)
	var parties openapi.BillingPartyList
	decodeResponse(t, response, &parties)
	found := false
	for _, party := range parties.Items {
		if party.Id == personID {
			found = party.MemberOrganizations != nil && len(*party.MemberOrganizations) == 1 && (*party.MemberOrganizations)[0].Id == organization.Id
		}
	}
	if !found {
		t.Fatalf("billing parties = %+v", parties)
	}

	// Filters: kind and pricing group.
	response = doJSON(t, readerClient, http.MethodGet, server.URL+"/api/v1/organizations?kind=institute", "", "", nil)
	assertStatus(t, response, http.StatusOK)
	var page openapi.OrganizationPage
	decodeResponse(t, response, &page)
	if page.Total != 0 {
		t.Fatalf("kind filter total = %d", page.Total)
	}
	response = doJSON(t, readerClient, http.MethodGet, server.URL+"/api/v1/organizations?kind=company&pricingGroupId="+uuid.Must(uuid.NewV7()).String(), "", "", nil)
	assertStatus(t, response, http.StatusOK)
	decodeResponse(t, response, &page)
	if page.Total != 0 {
		t.Fatalf("pricing group filter total = %d", page.Total)
	}

	// Omitted detail fields stay unchanged on update; an empty string clears.
	response = doJSON(t, managerClient, http.MethodPatch, server.URL+orgPath, origin, managerCSRF, map[string]any{"expectedVersion": organization.Version, "name": "Atelier GmbH", "kind": "company", "active": true, "contactName": ""})
	assertStatus(t, response, http.StatusOK)
	decodeResponse(t, response, &organization)
	if organization.ContactName != "" || organization.Locality != "Wien" || organization.Version != 2 {
		t.Fatalf("updated organization = %+v", organization)
	}
	// A stale version is refused.
	response = doJSON(t, managerClient, http.MethodPatch, server.URL+orgPath, origin, managerCSRF, map[string]any{"expectedVersion": 1, "name": "Atelier GmbH", "kind": "company", "active": true})
	assertStatus(t, response, http.StatusConflict)
	response.Body.Close()

	// Removal, then 404 for a non-member.
	response = doJSON(t, managerClient, http.MethodDelete, server.URL+orgPath+"/members/"+personID.String(), origin, managerCSRF, nil)
	assertStatus(t, response, http.StatusNoContent)
	response.Body.Close()
	response = doJSON(t, managerClient, http.MethodDelete, server.URL+orgPath+"/members/"+personID.String(), origin, managerCSRF, nil)
	assertStatus(t, response, http.StatusNotFound)
	response.Body.Close()
	response = doJSON(t, readerClient, http.MethodGet, server.URL+"/api/v1/organizations/"+uuid.Must(uuid.NewV7()).String(), "", "", nil)
	assertStatus(t, response, http.StatusNotFound)
	response.Body.Close()

	// Every mutation wrote exactly one audit event in its transaction, and no
	// event carries personal values.
	for action, want := range map[string]int{"organization.created": 1, "organization.updated": 1, "organization.member_added": 1, "organization.member_removed": 1} {
		assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action = $1 AND resource_id = $2`, want, action, organization.Id)
	}
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE resource_id = $1 AND metadata::text ILIKE '%atelier%'`, 0, organization.Id)

	// Deleting a person removes memberships; deleting an organization too.
	var otherID uuid.UUID
	if err = pool.QueryRow(ctx, `INSERT INTO people (id, first_name, last_name, email) VALUES ($1, 'Member', 'Cascade', 'cascade@example.test') RETURNING id`, uuid.Must(uuid.NewV7())).Scan(&otherID); err != nil {
		t.Fatal(err)
	}
	response = doJSON(t, managerClient, http.MethodPost, server.URL+orgPath+"/members", origin, managerCSRF, map[string]any{"personId": otherID.String()})
	assertStatus(t, response, http.StatusCreated)
	response.Body.Close()
	if _, err = pool.Exec(ctx, `DELETE FROM people WHERE id = $1`, otherID); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `SELECT count(*) FROM organization_members WHERE organization_id = $1`, 0, organization.Id)

	// Deleting needs organizations.manage and the current version, and refuses
	// organizations that history refers to.
	deletePath := server.URL + orgPath
	for name, who := range map[string]struct {
		client *http.Client
		csrf   string
	}{"reader": {readerClient, readerCSRF}, "nobody": {nobodyClient, nobodyCSRF}, "creator": {creatorClient, creatorCSRF}} {
		response = doJSON(t, who.client, http.MethodDelete, deletePath, origin, who.csrf, map[string]any{"expectedVersion": organization.Version})
		if response.StatusCode != http.StatusForbidden {
			t.Errorf("delete as %s = %d, want 403", name, response.StatusCode)
		}
		response.Body.Close()
	}
	assertCount(t, pool, `SELECT count(*) FROM organizations WHERE id = $1`, 1, organization.Id)
	response = doJSON(t, managerClient, http.MethodDelete, server.URL+"/api/v1/organizations/"+uuid.Must(uuid.NewV7()).String(), origin, managerCSRF, map[string]any{"expectedVersion": 1})
	assertStatus(t, response, http.StatusNotFound)
	response.Body.Close()
	response = doJSON(t, managerClient, http.MethodDelete, deletePath, origin, managerCSRF, map[string]any{"expectedVersion": organization.Version - 1})
	assertStatus(t, response, http.StatusConflict)
	response.Body.Close()
	assertCount(t, pool, `SELECT count(*) FROM organizations WHERE id = $1`, 1, organization.Id)

	// A referenced organization (here by a machine job) is refused with
	// organization_in_use, and the reference is untouched.
	machineTypeID, machineID, jobID := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	if _, err = pool.Exec(ctx, `INSERT INTO machine_types (id, name) VALUES ($1, 'Delete test type')`, machineTypeID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO machines (id, machine_type_id, name) VALUES ($1, $2, 'Delete test machine')`, machineID, machineTypeID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO machine_jobs (id, display_id, machine_id, customer_organization_id) VALUES ($1, 'J-2026-900001', $2, $3)`, jobID, machineID, organization.Id); err != nil {
		t.Fatal(err)
	}
	response = doJSON(t, managerClient, http.MethodDelete, deletePath, origin, managerCSRF, map[string]any{"expectedVersion": organization.Version})
	assertStatus(t, response, http.StatusConflict)
	var problem struct {
		Code string `json:"code"`
	}
	decodeResponse(t, response, &problem)
	if problem.Code != "organization_in_use" {
		t.Fatalf("code = %q, want organization_in_use", problem.Code)
	}
	assertCount(t, pool, `SELECT count(*) FROM organizations WHERE id = $1`, 1, organization.Id)
	assertCount(t, pool, `SELECT count(*) FROM machine_jobs WHERE id = $1 AND customer_organization_id = $2`, 1, jobID, organization.Id)
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action = 'organization.deleted'`, 0)
	if _, err = pool.Exec(ctx, `DELETE FROM machine_jobs WHERE id = $1`, jobID); err != nil {
		t.Fatal(err)
	}

	// Unreferenced: members and pricing assignment go with it, atomically with
	// one audit event that carries no names.
	response = doJSON(t, managerClient, http.MethodPost, server.URL+orgPath+"/members", origin, managerCSRF, memberBody)
	assertStatus(t, response, http.StatusCreated)
	response.Body.Close()
	pricingGroupID := uuid.Must(uuid.NewV7())
	if _, err = pool.Exec(ctx, `INSERT INTO pricing_groups (id, name) VALUES ($1, 'Delete test group')`, pricingGroupID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO organization_pricing_group_assignments (organization_id, pricing_group_id) VALUES ($1, $2)`, organization.Id, pricingGroupID); err != nil {
		t.Fatal(err)
	}
	response = doJSON(t, managerClient, http.MethodGet, server.URL+orgPath, "", "", nil)
	assertStatus(t, response, http.StatusOK)
	decodeResponse(t, response, &organization)
	response = doJSON(t, managerClient, http.MethodDelete, deletePath, origin, managerCSRF, map[string]any{"expectedVersion": organization.Version})
	assertStatus(t, response, http.StatusNoContent)
	response.Body.Close()
	assertCount(t, pool, `SELECT count(*) FROM organizations WHERE id = $1`, 0, organization.Id)
	assertCount(t, pool, `SELECT count(*) FROM organization_members WHERE organization_id = $1`, 0, organization.Id)
	assertCount(t, pool, `SELECT count(*) FROM organization_pricing_group_assignments WHERE organization_id = $1`, 0, organization.Id)
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action = 'organization.deleted' AND resource_id = $1 AND metadata::text NOT ILIKE '%atelier%'`, 1, organization.Id)
	response = doJSON(t, managerClient, http.MethodDelete, deletePath, origin, managerCSRF, map[string]any{"expectedVersion": organization.Version})
	assertStatus(t, response, http.StatusNotFound)
	response.Body.Close()
}
