package integration_test

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/admin"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/httpapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/orders"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printerconnectors"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printing"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestDeletionAndEventClearingOverHTTP(t *testing.T) {
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
		adminLogin    = "del-admin@example.test"
		adminPassword = "Del admin workshop password 61"
	)
	if _, err = admin.NewService(pool).BootstrapMaster(
		ctx,
		admin.BootstrapInput{
			FirstName:  "Del",
			LastName:   "Admin",
			LoginEmail: adminLogin,
			Password:   adminPassword,
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
		email, password := "del-"+suffix+"@example.test", "Del "+suffix+" workshop password 77"
		response := doJSON(
			t,
			adminClient,
			http.MethodPost,
			server.URL+"/api/v1/people",
			origin,
			adminCSRF,
			map[string]any{"firstName": "Del", "lastName": suffix, "email": "contact-" + email},
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
			map[string]any{"name": "Del " + suffix, "description": "Test role", "permissionGrants": grants},
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

	var accountID, personID uuid.UUID
	if err = pool.QueryRow(
		ctx,
		`SELECT a.id, a.person_id FROM accounts a JOIN auth_identities i ON i.account_id = a.id WHERE i.identifier_normalized = $1`,
		adminLogin,
	).Scan(&accountID, &personID); err != nil {
		t.Fatal(err)
	}
	master := authorization.Principal{AccountID: accountID, PersonID: personID, Master: true}
	logbook := machinelogbook.NewService(pool)
	orderService := orders.NewService(pool, logbook)
	machineType, err := logbook.CreateMachineType(ctx, master, "Printer", "other", nil)
	if err != nil {
		t.Fatal(err)
	}
	machine, err := logbook.CreateMachine(ctx, master, machineType.ID, "Printer 1", "active", nil, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	group, err := logbook.CreatePricingGroup(ctx, master, "Standard", nil, true, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = logbook.CreatePricingRule(
		ctx,
		master,
		group.ID,
		"machine_runtime",
		&machineType.ID,
		nil,
		nil,
		"10",
		nil,
	); err != nil {
		t.Fatal(err)
	}
	start := time.Now().UTC().Add(-8 * time.Hour).Truncate(time.Second)
	newJob := func(offset time.Duration) machinelogbook.MachineJob {
		input := machinelogbook.JobInput{
			MachineID:        machine.ID,
			StartsAt:         start.Add(offset),
			EndsAt:           start.Add(offset + time.Hour),
			Customer:         machinelogbook.PartyReference{Kind: "person", ID: personID},
			OperatorPersonID: personID,
			Outcome:          "successful",
		}
		job, jobErr := logbook.CreateManualJob(ctx, master, input, nil)
		if jobErr != nil {
			t.Fatal(jobErr)
		}
		return job
	}
	free, ordered, protected := newJob(0), newJob(2*time.Hour), newJob(4*time.Hour)
	order, err := orderService.Create(
		ctx,
		master,
		orders.OrderDraftInput{
			Customer:        &orders.OrderCustomer{Kind: "person", ID: personID},
			FulfillmentMode: "deferred",
		},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = orderService.ChangeItem(
		ctx,
		master,
		order.ID,
		uuid.Nil,
		orders.OrderItemInput{
			Kind:               "machine_job",
			MachineJobID:       ordered.ID,
			ExpectedJobVersion: ordered.Version,
			ExpectedVersion:    order.Version,
		},
		"add",
		nil,
	); err != nil {
		t.Fatal(err)
	}

	editorClient, editorCSRF := member("editor", "machine_jobs.read", "machine_jobs.edit", "printer_connectors.read")
	deleterClient, deleterCSRF := member("deleter", "machine_jobs.read", "machine_jobs.delete")
	managerClient, managerCSRF := member("manager", "printer_connectors.read", "printer_connectors.manage")

	deleteBody := func(version int64) map[string]any {
		return map[string]any{"expectedVersion": version, "reverseConsumption": false, "deleteRecordedRuns": false}
	}
	jobPath := func(id uuid.UUID) string { return server.URL + "/api/v1/machine-jobs/" + id.String() }
	// Editing is not deleting.
	response := doJSON(
		t,
		editorClient,
		http.MethodDelete,
		jobPath(free.ID),
		origin,
		editorCSRF,
		deleteBody(free.Version),
	)
	assertStatus(t, response, http.StatusForbidden)
	response.Body.Close()
	// A job on an order cannot be deleted.
	response = doJSON(
		t,
		deleterClient,
		http.MethodDelete,
		jobPath(ordered.ID),
		origin,
		deleterCSRF,
		deleteBody(ordered.Version),
	)
	assertStatus(t, response, http.StatusConflict)
	var problem struct {
		Code string `json:"code"`
	}
	decodeResponse(t, response, &problem)
	if problem.Code != "job_on_order" {
		t.Fatalf("error code = %q, want job_on_order", problem.Code)
	}
	// A manual run can be removed with machine_jobs.edit; the job keeps another run.
	withTwo, err := logbook.AddManualRun(
		ctx,
		master,
		protected.ID,
		protected.Version,
		machinelogbook.ManualRunInput{StartsAt: start.Add(5 * time.Hour), EndsAt: start.Add(6 * time.Hour)},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	extra := withTwo.Runs[1]
	response = doJSON(
		t,
		editorClient,
		http.MethodDelete,
		server.URL+"/api/v1/machine-runs/"+extra.ID.String(),
		origin,
		editorCSRF,
		map[string]any{"expectedVersion": extra.Version, "reverseConsumption": false},
	)
	assertStatus(t, response, http.StatusNoContent)
	response.Body.Close()
	// Recorded runs need machine_jobs.delete: edit-only is refused, delete succeeds.
	recordedRun := insertRecordedRun(t, pool, machine.ID)
	response = doJSON(
		t,
		editorClient,
		http.MethodDelete,
		server.URL+"/api/v1/machine-runs/"+recordedRun.id.String(),
		origin,
		editorCSRF,
		map[string]any{"expectedVersion": recordedRun.version, "reverseConsumption": false},
	)
	assertStatus(t, response, http.StatusForbidden)
	response.Body.Close()
	response = doJSON(
		t,
		deleterClient,
		http.MethodDelete,
		server.URL+"/api/v1/machine-runs/"+recordedRun.id.String(),
		origin,
		deleterCSRF,
		map[string]any{"expectedVersion": recordedRun.version, "reverseConsumption": false},
	)
	assertStatus(t, response, http.StatusNoContent)
	response.Body.Close()
	// The only run of a job cannot be deleted.
	response = doJSON(
		t,
		deleterClient,
		http.MethodDelete,
		server.URL+"/api/v1/machine-runs/"+protected.Runs[0].ID.String(),
		origin,
		deleterCSRF,
		map[string]any{"expectedVersion": protected.Runs[0].Version, "reverseConsumption": true},
	)
	assertStatus(t, response, http.StatusConflict)
	response.Body.Close()
	// Stale version.
	response = doJSON(
		t,
		deleterClient,
		http.MethodDelete,
		jobPath(free.ID),
		origin,
		deleterCSRF,
		deleteBody(free.Version+5),
	)
	assertStatus(t, response, http.StatusConflict)
	response.Body.Close()
	// Deleting works and the job is gone.
	response = doJSON(
		t,
		deleterClient,
		http.MethodDelete,
		jobPath(free.ID),
		origin,
		deleterCSRF,
		deleteBody(free.Version),
	)
	assertStatus(t, response, http.StatusNoContent)
	response.Body.Close()
	response = doJSON(t, deleterClient, http.MethodGet, jobPath(free.ID), "", "", nil)
	assertStatus(t, response, http.StatusNotFound)
	response.Body.Close()
	response = doJSON(
		t,
		deleterClient,
		http.MethodGet,
		server.URL+"/api/v1/machine-jobs?machineId="+machine.ID.String(),
		"",
		"",
		nil,
	)
	assertStatus(t, response, http.StatusOK)
	var page struct {
		Items []struct {
			ID uuid.UUID `json:"id"`
		} `json:"items"`
		Total int64 `json:"total"`
	}
	decodeResponse(t, response, &page)
	if page.Total != 2 {
		t.Fatalf("jobs after deletion = %d", page.Total)
	}
	for _, item := range page.Items {
		if item.ID == free.ID {
			t.Fatal("deleted job is listed")
		}
	}

	// Clearing connector events needs printer_connectors.manage.
	connector, err := printerconnectors.NewService(pool, printing.NewService(pool), nil)
	if err != nil {
		t.Fatal(err)
	}
	created, err := connector.Create(ctx, master, "Clear connector", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	clearPath := server.URL + "/api/v1/printer-connectors/" + created.ID.String() + "/events/clear"
	response = doJSON(t, editorClient, http.MethodPost, clearPath, origin, editorCSRF, nil)
	assertStatus(t, response, http.StatusForbidden)
	response.Body.Close()
	response = doJSON(t, managerClient, http.MethodPost, clearPath, origin, managerCSRF, nil)
	assertStatus(t, response, http.StatusOK)
	var cleared struct {
		EventsClearedAt     *time.Time `json:"eventsClearedAt"`
		EventsClearedByName *string    `json:"eventsClearedByName"`
	}
	decodeResponse(t, response, &cleared)
	if cleared.EventsClearedAt == nil || cleared.EventsClearedByName == nil {
		t.Fatalf("cleared connector = %+v", cleared)
	}
	response = doJSON(
		t,
		managerClient,
		http.MethodGet,
		server.URL+"/api/v1/printer-connectors/"+created.ID.String()+"/events?includeCleared=true",
		"",
		"",
		nil,
	)
	assertStatus(t, response, http.StatusOK)
	response.Body.Close()
}

type recordedRunFixture struct {
	id      uuid.UUID
	version int64
}

// insertRecordedRun stores an unassigned recorded run the way connector ingest leaves it.
func insertRecordedRun(t *testing.T, pool *pgxpool.Pool, machineID uuid.UUID) recordedRunFixture {
	t.Helper()
	ctx := testContext(t)
	connectorID, assignmentID, runID := ids.New(), ids.New(), ids.New()
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO printer_connectors (id, name, lifecycle) VALUES ($1, 'Delete test connector', 'active')`,
		connectorID,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO printer_profiles (machine_id) VALUES ($1) ON CONFLICT DO NOTHING`,
		machineID,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO printer_connector_assignments (id, connector_id, machine_id, adapter_kind) VALUES ($1, $2, $3, 'simulator')`,
		assignmentID,
		connectorID,
		machineID,
	); err != nil {
		t.Fatal(err)
	}
	seen := time.Now().UTC().Add(-3 * time.Hour)
	if _, err := pool.Exec(ctx, `INSERT INTO machine_runs (id, display_id, source, assignment_id, machine_id, state, first_observed_at, last_observed_at, started_at, ended_at)
		VALUES ($1, 'R-2032-' || lpad((('x' || substr(replace($1::uuid::text, '-', ''), 17, 7))::bit(28)::int)::text, 9, '0'), 'recorded', $2, $3, 'finished', $4, $5, $4, $5)`, runID, assignmentID, machineID, seen, seen.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	var version int64
	if err := pool.QueryRow(ctx, `SELECT version FROM machine_runs WHERE id = $1`, runID).Scan(&version); err != nil {
		t.Fatal(err)
	}
	return recordedRunFixture{id: runID, version: version}
}
