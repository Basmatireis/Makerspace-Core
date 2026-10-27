package integration_test

import (
	"archive/zip"
	"bytes"
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

func TestMachineRunOperationsRequireTheirPermissionsOverHTTP(t *testing.T) {
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
		adminLogin    = "runs-admin@example.test"
		adminPassword = "Runs admin workshop password 61"
	)
	if _, err = admin.NewService(pool).BootstrapMaster(
		ctx,
		admin.BootstrapInput{
			FirstName:  "Runs",
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
		email, password := "runs-"+suffix+"@example.test", "Runs "+suffix+" workshop password 77"
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
			map[string]any{"name": "Runs " + suffix, "description": "Test role", "permissionGrants": grants},
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
	logbook := machinelogbook.NewService(pool, inbox.NewEmitter())
	machineType, err := logbook.CreateMachineType(ctx, master, "Printer", "fdm_printing", nil)
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
		},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	run := job.Runs[0]

	readerClient, readerCSRF := member("reader", "machine_jobs.read")
	creatorClient, creatorCSRF := member("creator", "machine_jobs.read", "machine_jobs.create")
	editorClient, editorCSRF := member("editor", "machine_jobs.read", "machine_jobs.edit")
	nobodyClient, nobodyCSRF := member("nobody", "machines.read")

	runPath := "/api/v1/machine-runs/" + run.ID.String()
	jobRunsPath := "/api/v1/machine-jobs/" + job.ID.String() + "/runs"
	times := map[string]any{
		"startsAt": start.Format(time.RFC3339),
		"endsAt":   start.Add(time.Hour).Format(time.RFC3339),
		"usages":   []any{},
	}
	calls := []struct {
		name, method, path string
		body               any
		client             *http.Client
		csrf               string
	}{
		{
			"update",
			http.MethodPatch,
			runPath,
			map[string]any{"outcome": "failed", "expectedVersion": run.Version},
			nil,
			"",
		},
		{
			"delete",
			http.MethodDelete,
			runPath,
			map[string]any{"expectedVersion": run.Version, "reverseConsumption": true},
			nil,
			"",
		},
		{
			"usages",
			http.MethodPut,
			runPath + "/usages",
			map[string]any{"usages": []any{}, "expectedVersion": run.Version},
			nil,
			"",
		},
		{"cancel", http.MethodPost, runPath + "/cancellation", map[string]any{"expectedVersion": run.Version}, nil, ""},
		{
			"attach",
			http.MethodPut,
			runPath + "/job",
			map[string]any{
				"machineJobId":       job.ID.String(),
				"replaceManualRuns":  false,
				"expectedJobVersion": job.Version,
			},
			nil,
			"",
		},
		{"detach", http.MethodDelete, runPath + "/job", map[string]any{"expectedJobVersion": job.Version}, nil, ""},
		{
			"add run",
			http.MethodPost,
			jobRunsPath,
			map[string]any{"run": times, "expectedJobVersion": job.Version},
			nil,
			"",
		},
	}
	// Edit operations need machine_jobs.edit: a reader and a creator are refused.
	for _, who := range []struct {
		name   string
		client *http.Client
		csrf   string
	}{{"reader", readerClient, readerCSRF}, {"creator", creatorClient, creatorCSRF}, {"no job permission", nobodyClient, nobodyCSRF}} {
		for _, c := range calls {
			response := doJSON(t, who.client, c.method, server.URL+c.path, origin, who.csrf, c.body)
			if response.StatusCode != http.StatusForbidden {
				t.Errorf("%s %s as %s = %d, want 403", c.method, c.path, who.name, response.StatusCode)
			}
			response.Body.Close()
		}
	}
	// Creating a job from a run needs machine_jobs.create; an editor lacks it.
	fromRun := map[string]any{
		"customer":         map[string]any{"kind": "person", "id": personID.String()},
		"operatorPersonId": personID.String(),
	}
	for name, client := range map[string]*http.Client{
		"reader": readerClient,
		"editor": editorClient,
		"nobody": nobodyClient,
	} {
		csrf := map[string]string{"reader": readerCSRF, "editor": editorCSRF, "nobody": nobodyCSRF}[name]
		response := doJSON(t, client, http.MethodPost, server.URL+runPath+"/job", origin, csrf, fromRun)
		if response.StatusCode != http.StatusForbidden {
			t.Errorf("create job from run as %s = %d, want 403", name, response.StatusCode)
		}
		response.Body.Close()
	}
	// Reading runs needs machine_jobs.read.
	for _, path := range []string{"/api/v1/machine-runs", runPath} {
		response := doJSON(t, nobodyClient, http.MethodGet, server.URL+path, "", "", nil)
		if response.StatusCode != http.StatusForbidden {
			t.Errorf("GET %s without machine_jobs.read = %d, want 403", path, response.StatusCode)
		}
		response.Body.Close()
		response = doJSON(t, readerClient, http.MethodGet, server.URL+path, "", "", nil)
		assertStatus(t, response, http.StatusOK)
		response.Body.Close()
	}
	// The run was untouched by every refused call; an editor may change it.
	response := doJSON(
		t,
		editorClient,
		http.MethodPost,
		server.URL+jobRunsPath,
		origin,
		editorCSRF,
		map[string]any{
			"run": map[string]any{
				"startsAt": start.Add(2 * time.Hour).Format(time.RFC3339),
				"endsAt":   start.Add(150 * time.Minute).Format(time.RFC3339),
				"outcome":  "successful",
				"usages":   []any{},
			},
			"expectedJobVersion": job.Version,
		},
	)
	assertStatus(t, response, http.StatusCreated)
	response.Body.Close()

	// Uploading the 3MF of a recorded run is an edit too: readers, creators and members without job
	// permissions are refused, an editor may upload it (a raw body, like the other binary uploads).
	recorded := insertRecordedRun(t, pool, machine.ID)
	upload := func(client *http.Client, csrf string, body []byte) *http.Response {
		t.Helper()
		request, requestErr := http.NewRequestWithContext(
			ctx,
			http.MethodPost,
			server.URL+"/api/v1/machine-runs/"+recorded.id.String()+"/artifact",
			bytes.NewReader(body),
		)
		if requestErr != nil {
			t.Fatal(requestErr)
		}
		request.Header.Set("Content-Type", "application/octet-stream")
		request.Header.Set("X-File-Name", "Pa%C3%9Frt.gcode.3mf")
		request.Header.Set("Origin", origin)
		request.Header.Set("X-CSRF-Token", csrf)
		result, doErr := client.Do(request)
		if doErr != nil {
			t.Fatal(doErr)
		}
		return result
	}
	file := minimal3MF(t)
	for name, who := range map[string]struct {
		client *http.Client
		csrf   string
	}{"reader": {readerClient, readerCSRF}, "creator": {creatorClient, creatorCSRF}, "nobody": {nobodyClient, nobodyCSRF}} {
		response = upload(who.client, who.csrf, file)
		if response.StatusCode != http.StatusForbidden {
			t.Errorf("artifact upload as %s = %d, want 403", name, response.StatusCode)
		}
		response.Body.Close()
	}
	response = upload(editorClient, editorCSRF, []byte("not a 3MF"))
	assertStatus(t, response, http.StatusUnprocessableEntity)
	response.Body.Close()
	response = upload(editorClient, editorCSRF, file)
	assertStatus(t, response, http.StatusCreated)
	var uploaded openapi.MachineRunArtifactUploadResult
	decodeResponse(t, response, &uploaded)
	if !uploaded.Artifact.UploadedManually || uploaded.RunId != recorded.id || uploaded.NameMismatch {
		t.Fatalf("upload result = %+v", uploaded)
	}
	response = doJSON(t, readerClient, http.MethodGet, server.URL+"/api/v1/machine-runs/"+recorded.id.String()+"/recording", "", "", nil)
	assertStatus(t, response, http.StatusOK)
	var recording openapi.MachineRunRecording
	decodeResponse(t, response, &recording)
	if artifact, getErr := recording.Artifact.Get(); getErr != nil || artifact.Id != uploaded.Artifact.Id {
		t.Fatalf("recording artifact = %+v %v", artifact, getErr)
	}
}

func minimal3MF(t *testing.T) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for _, entry := range [][2]string{
		{"Metadata/slice_info.config", `<?xml version="1.0"?><config><plate id="1"/><filament id="0" type="PLA" used_mm="100" used_g="0.3" density="1.24" diameter="1.75" extruder="0"/></config>`},
		{"Metadata/plate_1.gcode", "M82\nG92 E0\n; layer: 0\nG1 E10\n"},
	} {
		file, err := writer.Create(entry[0])
		if err != nil {
			t.Fatal(err)
		}
		if _, err = file.Write([]byte(entry[1])); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}
