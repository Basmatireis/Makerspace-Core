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
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestRepriceMachineJobOverHTTP(t *testing.T) {
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
		adminLogin    = "reprice-admin@example.test"
		adminPassword = "Reprice admin password 52"
	)
	if _, err = admin.NewService(pool).BootstrapMaster(ctx, admin.BootstrapInput{FirstName: "Reprice", LastName: "Admin", LoginEmail: adminLogin, Password: adminPassword}); err != nil {
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
		email, password := "reprice-"+suffix+"@example.test", "Reprice "+suffix+" workshop password 78"
		response := doJSON(
			t,
			root.client,
			http.MethodPost,
			server.URL+"/api/v1/people",
			origin,
			root.csrf,
			map[string]any{"firstName": "Reprice", "lastName": suffix, "email": "contact-" + email},
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
			map[string]any{"name": "Reprice " + suffix, "description": "Test role", "permissionGrants": grants},
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
	reader := member("reader", "machine_jobs.read")
	editor := member("editor", "machine_jobs.read", "machine_jobs.edit")

	var accountID, personID uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT a.id, a.person_id FROM accounts a JOIN auth_identities i ON i.account_id = a.id WHERE i.identifier_normalized = $1`, adminLogin).Scan(&accountID, &personID); err != nil {
		t.Fatal(err)
	}
	master := authorization.Principal{AccountID: accountID, PersonID: personID, Master: true}
	logbook := machinelogbook.NewService(pool, inbox.NewEmitter())
	machineType, err := logbook.CreateMachineType(ctx, master, "Reprice HTTP printer", "fdm_printing", nil)
	if err != nil {
		t.Fatal(err)
	}
	machine, err := logbook.CreateMachine(ctx, master, machineType.ID, "Reprice HTTP machine", "active", nil, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	group, err := logbook.CreatePricingGroup(ctx, master, "Reprice HTTP pricing", nil, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = logbook.CreatePricingRule(ctx, master, group.ID, "machine_runtime", &machineType.ID, nil, nil, "10", nil); err != nil {
		t.Fatal(err)
	}
	start := time.Now().UTC().Add(-3 * time.Hour).Truncate(time.Second)
	job, err := logbook.CreateManualJob(
		ctx,
		master,
		machinelogbook.JobInput{
			MachineID:        machine.ID,
			StartsAt:         start,
			EndsAt:           start.Add(time.Hour),
			Customer:         machinelogbook.PartyReference{Kind: "person", ID: personID},
			OperatorPersonID: personID,
			Outcome:          "successful",
			PricingGroupID:   &group.ID,
		},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	api := func(s session, method, path string, status int, body any, target any) {
		t.Helper()
		response := doJSON(t, s.client, method, server.URL+"/api/v1"+path, origin, s.csrf, body)
		assertStatus(t, response, status)
		if target != nil {
			decodeResponse(t, response, target)
		} else {
			response.Body.Close()
		}
	}
	path := "/machine-jobs/" + job.ID.String() + "/reprice"
	body := func(version int64) map[string]any { return map[string]any{"expectedVersion": version} }

	api(reader, http.MethodPost, path, http.StatusForbidden, body(job.Version), nil)
	var repriced openapi.MachineJob
	api(editor, http.MethodPost, path, http.StatusOK, body(job.Version), &repriced)
	snapshot, err := repriced.PricingSnapshot.Get()
	if err != nil || snapshot.Revision != 2 || snapshot.Reason != openapi.ManualReprice {
		t.Fatalf("repriced snapshot: %v %+v", err, snapshot)
	}
	// The first request advanced the version, so repeating it is stale.
	api(editor, http.MethodPost, path, http.StatusConflict, body(job.Version), nil)
}
