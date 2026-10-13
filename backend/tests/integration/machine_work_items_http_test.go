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
	"github.com/Basmatireis/Makerspace-Core/backend/internal/orders"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestMachineWorkItemsBillingAndPermissionsOverHTTP(t *testing.T) {
	schemaPool := migratedPool(t)
	ctx := testContext(t)
	// The job and sqlc code paths use binary parameters, unlike the simple-protocol pool of the schema helper.
	poolConfig := schemaPool.Config().Copy()
	poolConfig.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeCacheStatement
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	const (
		origin        = "http://makerspace.example.test"
		adminLogin    = "work-items-admin@example.test"
		adminPassword = "Work items admin password 51"
	)
	if _, err := admin.NewService(pool).BootstrapMaster(ctx, admin.BootstrapInput{FirstName: "Work", LastName: "Admin", ContactEmail: "work-items-contact@example.test", LoginEmail: adminLogin, Password: adminPassword}); err != nil {
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
	member := func(suffix string, permissions ...string) *http.Client {
		t.Helper()
		email, password := "work-items-"+suffix+"@example.test", "Work items "+suffix+" workshop password 77"
		response := doJSON(t, adminClient, http.MethodPost, server.URL+"/api/v1/people", origin, adminCSRF, map[string]any{"firstName": "Work", "lastName": suffix, "email": "contact-" + email})
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
		response = doJSON(t, adminClient, http.MethodPost, server.URL+"/api/v1/roles", origin, adminCSRF, map[string]any{"name": "Work items " + suffix, "description": "Test role", "permissionGrants": grants})
		assertStatus(t, response, http.StatusCreated)
		var role openapi.Role
		decodeResponse(t, response, &role)
		response = doJSON(t, adminClient, http.MethodGet, server.URL+"/api/v1/people/"+person.Id.String(), "", "", nil)
		assertStatus(t, response, http.StatusOK)
		decodeResponse(t, response, &person)
		response = doJSON(t, adminClient, http.MethodPut, server.URL+"/api/v1/people/"+person.Id.String()+"/roles/"+role.Id.String(), origin, adminCSRF, map[string]any{"expectedVersion": person.Version})
		assertStatus(t, response, http.StatusOK)
		response.Body.Close()
		client, _ := login(email, password)
		return client
	}

	// Fixtures go through the services as the bootstrapped master.
	var accountID, personID uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT a.id, a.person_id FROM accounts a JOIN auth_identities i ON i.account_id = a.id WHERE i.identifier_normalized = $1`, adminLogin).Scan(&accountID, &personID); err != nil {
		t.Fatal(err)
	}
	master := authorization.Principal{AccountID: accountID, PersonID: personID, Master: true}
	logbook := machinelogbook.NewService(pool)
	orderService := orders.NewService(pool, logbook)
	machineType, err := logbook.CreateMachineType(ctx, master, "Printer", nil)
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
	if _, err = logbook.CreatePricingRule(ctx, master, group.ID, "machine_runtime", &machineType.ID, nil, nil, "10", nil); err != nil {
		t.Fatal(err)
	}
	start := time.Now().UTC().Add(-6 * time.Hour).Truncate(time.Second)
	newJob := func(offset time.Duration) machinelogbook.MachineJob {
		input := machinelogbook.JobInput{MachineID: machine.ID, StartsAt: start.Add(offset), EndsAt: start.Add(offset + time.Hour), Customer: machinelogbook.PartyReference{Kind: "person", ID: personID}, OperatorPersonID: personID, Outcome: "successful"}
		job, jobErr := logbook.CreateManualJob(ctx, master, input, nil)
		if jobErr != nil {
			t.Fatal(jobErr)
		}
		return job
	}
	changed, unchanged, free := newJob(0), newJob(2*time.Hour), newJob(4*time.Hour)
	for _, job := range []machinelogbook.MachineJob{changed, unchanged} {
		order, orderErr := orderService.Create(ctx, master, orders.OrderDraftInput{Customer: &orders.OrderCustomer{Kind: "person", ID: personID}, FulfillmentMode: "deferred"}, nil)
		if orderErr != nil {
			t.Fatal(orderErr)
		}
		if _, orderErr = orderService.ChangeItem(ctx, master, order.ID, uuid.Nil, orders.OrderItemInput{Kind: "machine_job", MachineJobID: job.ID, ExpectedJobVersion: job.Version, ExpectedVersion: order.Version}, "add", nil); orderErr != nil {
			t.Fatal(orderErr)
		}
	}
	title := "Edited after ordering"
	edit := machinelogbook.JobInput{MachineID: machine.ID, Title: &title, StartsAt: changed.StartsAt, EndsAt: changed.EndsAt, Customer: machinelogbook.PartyReference{Kind: "person", ID: personID}, OperatorPersonID: personID, Outcome: "successful"}
	if _, err = logbook.UpdateJobFacts(ctx, master, changed.ID, changed.Version, edit, nil); err != nil {
		t.Fatal(err)
	}

	fetch := func(client *http.Client, path string, wantStatus int, target any) {
		t.Helper()
		response := doJSON(t, client, http.MethodGet, server.URL+"/api/v1"+path, "", "", nil)
		assertStatus(t, response, wantStatus)
		if target != nil {
			decodeResponse(t, response, target)
		} else {
			response.Body.Close()
		}
	}
	type billing struct {
		State          string  `json:"state"`
		OrderID        *string `json:"orderId"`
		OrderReference *string `json:"orderReference"`
	}
	type item struct {
		ID      uuid.UUID `json:"id"`
		Kind    string    `json:"kind"`
		Status  string    `json:"status"`
		Run     string    `json:"run"`
		Billing *billing  `json:"billing"`
	}
	type page struct {
		Items    []item `json:"items"`
		Total    int64  `json:"total"`
		Page     int    `json:"page"`
		PageSize int    `json:"pageSize"`
	}
	states := func(p page) map[uuid.UUID]string {
		result := map[uuid.UUID]string{}
		for _, i := range p.Items {
			if i.Billing == nil {
				t.Fatalf("job %s has no billing", i.ID)
			}
			result[i.ID] = i.Billing.State
		}
		return result
	}

	var all page
	fetch(adminClient, "/machine-logbook/work-items?status=successful,cancelled&machineId="+machine.ID.String()+"&run=manual,printer&billing=on_order,order_outdated,not_on_order&sort=startedAt&direction=asc&pageSize=10", http.StatusOK, &all)
	if all.Total != 3 || all.Page != 1 || all.PageSize != 10 || len(all.Items) != 3 {
		t.Fatalf("work items = %+v", all)
	}
	got := states(all)
	if got[changed.ID] != "order_outdated" || got[unchanged.ID] != "on_order" || got[free.ID] != "not_on_order" {
		t.Fatalf("billing states = %v", got)
	}
	for _, i := range all.Items {
		order := i.Billing.OrderID != nil && i.Billing.OrderReference != nil
		if order != (i.Billing.State != "not_on_order") {
			t.Fatalf("master order data for %s = %+v", i.Billing.State, i.Billing)
		}
	}
	var outdated page
	fetch(adminClient, "/machine-logbook/work-items?billing=order_outdated", http.StatusOK, &outdated)
	if outdated.Total != 1 || outdated.Items[0].ID != changed.ID {
		t.Fatalf("billing filter = %+v", outdated)
	}
	fetch(adminClient, "/machine-logbook/work-items?status=bogus", http.StatusBadRequest, nil)
	fetch(adminClient, "/machine-logbook/work-items?sort=bogus", http.StatusBadRequest, nil)

	// A reader without orders.read still sees the state but not the order data.
	jobsReader := member("jobs", "machine_jobs.read")
	var restricted page
	fetch(jobsReader, "/machine-logbook/work-items?billing=on_order,order_outdated", http.StatusOK, &restricted)
	if restricted.Total != 2 {
		t.Fatalf("restricted work items = %+v", restricted)
	}
	for _, i := range restricted.Items {
		if i.Billing == nil || (i.Billing.State != "on_order" && i.Billing.State != "order_outdated") || i.Billing.OrderID != nil || i.Billing.OrderReference != nil {
			t.Fatalf("order data leaked or state missing: %+v", i.Billing)
		}
	}
	rawResponse := doJSON(t, jobsReader, http.MethodGet, server.URL+"/api/v1/machine-logbook/work-items?billing=on_order", "", "", nil)
	assertStatus(t, rawResponse, http.StatusOK)
	if body := string(readResponse(t, rawResponse)); containsOrderReference(body) {
		t.Fatalf("response body exposes an order reference: %s", body)
	}
	fetch(jobsReader, "/machine-logbook/machine-activity", http.StatusForbidden, nil)

	machinesReader := member("machines", "machines.read")
	fetch(machinesReader, "/machine-logbook/work-items", http.StatusForbidden, nil)
	var activity openapi.MachineActivityList
	fetch(machinesReader, "/machine-logbook/machine-activity", http.StatusOK, &activity)
	if len(activity.Items) != 1 || activity.Items[0].MachineId != machine.ID || activity.Items[0].Availability != openapi.MachineAvailabilityAvailable {
		t.Fatalf("machine activity = %+v", activity)
	}
	fetch(adminClient, "/machine-logbook/machine-activity", http.StatusOK, &activity)
	if len(activity.Items) != 1 || activity.Items[0].LastJobStartedAt.IsNull() {
		t.Fatalf("master machine activity = %+v", activity)
	}

	// The work-item overview fields are null for a statistics-only caller and filled for a job reader.
	statsOnly := member("stats", "statistics.read")
	var overview openapi.MachineLogbookOverview
	fetch(statsOnly, "/machine-logbook/overview", http.StatusOK, &overview)
	if !overview.RunningNow.IsNull() || !overview.ActiveItems.IsNull() || !overview.BillingIssues.IsNull() || !overview.RunningMachineNames.IsNull() {
		t.Fatalf("statistics-only overview = %+v", overview)
	}
	fetch(adminClient, "/machine-logbook/overview", http.StatusOK, &overview)
	issues, issuesErr := overview.BillingIssues.Get()
	if issuesErr != nil || issues != 1 {
		t.Fatalf("billingIssues = %d, %v", issues, issuesErr)
	}
	var statistics openapi.MachineLogbookStatistics
	fetch(statsOnly, fmt.Sprintf("/machine-logbook/statistics?from=%s&to=%s", start.Format("2006-01-02"), time.Now().UTC().Format("2006-01-02")), http.StatusOK, &statistics)
	if statistics.Totals.Jobs != 3 || statistics.RuntimeGranularity != openapi.Week || len(statistics.Machines) != 1 {
		t.Fatalf("statistics = %+v", statistics)
	}
}

func containsOrderReference(body string) bool {
	return strings.Contains(body, `"orderReference":"O-`) || strings.Contains(body, `"orderId":"`)
}
