package integration_test

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/inbox"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

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

func TestMachineUpdateAndDeletionOverHTTP(t *testing.T) {
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
		adminLogin    = "mdel-admin@example.test"
		adminPassword = "Mdel admin workshop password 61"
	)
	if _, err = admin.NewService(pool).BootstrapMaster(
		ctx,
		admin.BootstrapInput{
			FirstName:  "Mdel",
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
	member := func(suffix string, permissions ...string) session {
		t.Helper()
		email, password := "mdel-"+suffix+"@example.test", "Mdel "+suffix+" workshop password 77"
		var person openapi.Person
		api(
			root,
			http.MethodPost,
			"/people",
			http.StatusCreated,
			map[string]any{"firstName": "Mdel", "lastName": suffix, "email": "contact-" + email},
			&person,
		)
		var account openapi.Account
		api(
			root,
			http.MethodPost,
			"/people/"+person.Id.String()+"/account",
			http.StatusCreated,
			map[string]any{"loginEmail": email, "expectedVersion": person.Version},
			&account,
		)
		api(
			root,
			http.MethodPut,
			"/accounts/"+account.Id.String()+"/password",
			http.StatusOK,
			map[string]any{"newPassword": password, "expectedVersion": account.Version},
			&account,
		)
		api(
			root,
			http.MethodPost,
			"/accounts/"+account.Id.String()+"/enable",
			http.StatusOK,
			map[string]any{"expectedVersion": account.Version},
			nil,
		)
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
		var role openapi.Role
		api(
			root,
			http.MethodPost,
			"/roles",
			http.StatusCreated,
			map[string]any{"name": "Mdel " + suffix, "description": "Test role", "permissionGrants": grants},
			&role,
		)
		api(root, http.MethodGet, "/people/"+person.Id.String(), http.StatusOK, nil, &person)
		api(
			root,
			http.MethodPut,
			"/people/"+person.Id.String()+"/roles/"+role.Id.String(),
			http.StatusOK,
			map[string]any{"expectedVersion": person.Version},
			nil,
		)
		return login(email, password)
	}
	reader := member("reader", "machines.read")
	manager := member("manager", "machines.read", "machines.manage")
	connectorManager := member("connectors", "machines.read", "machines.manage", "printer_connectors.manage")

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
	machineType, err := logbook.CreateMachineType(ctx, master, "Delete printer", "fdm_printing", nil)
	if err != nil {
		t.Fatal(err)
	}
	newMachine := func(name string) openapi.Machine {
		t.Helper()
		var machine openapi.Machine
		api(
			manager,
			http.MethodPost,
			"/machines",
			http.StatusCreated,
			map[string]any{
				"name":                       name,
				"machineTypeId":              machineType.ID,
				"status":                     "active",
				"automaticCollectionEnabled": false,
			},
			&machine,
		)
		return machine
	}
	version := func(machine openapi.Machine) map[string]any {
		return map[string]any{"expectedVersion": machine.Version}
	}
	gone := func(machine openapi.Machine) {
		t.Helper()
		api(root, http.MethodGet, "/machines/"+machine.Id.String(), http.StatusNotFound, nil, nil)
	}

	// Updating a machine passes request validation (expectedVersion used to be rejected by the closed allOf base).
	plain := newMachine("Plain printer")
	update := map[string]any{
		"name":                       "Plain printer renamed",
		"machineTypeId":              machineType.ID,
		"status":                     "maintenance",
		"automaticCollectionEnabled": true,
		"externalIdentifier":         "SN-1",
		"expectedVersion":            plain.Version,
	}
	api(reader, http.MethodPatch, "/machines/"+plain.Id.String(), http.StatusForbidden, update, nil)
	api(manager, http.MethodPatch, "/machines/"+plain.Id.String(), http.StatusOK, update, &plain)
	if plain.Name != "Plain printer renamed" || plain.Status != "maintenance" ||
		plain.ExternalIdentifier.MustGet() != "SN-1" {
		t.Fatalf("updated machine: %+v", plain)
	}
	api(manager, http.MethodPatch, "/machines/"+plain.Id.String(), http.StatusConflict, update, nil)

	// A machine without history is deleted by machines.manage, with optimistic concurrency and an audit event.
	api(reader, http.MethodDelete, "/machines/"+plain.Id.String(), http.StatusForbidden, version(plain), nil)
	api(
		manager,
		http.MethodDelete,
		"/machines/"+plain.Id.String(),
		http.StatusConflict,
		map[string]any{"expectedVersion": plain.Version - 1},
		nil,
	)
	api(manager, http.MethodDelete, "/machines/"+plain.Id.String(), http.StatusNoContent, version(plain), nil)
	gone(plain)
	var audits int
	if err = pool.QueryRow(
		ctx,
		`SELECT count(*) FROM audit_events WHERE action = 'machine.deleted' AND resource_id = $1`,
		plain.Id,
	).Scan(&audits); err != nil ||
		audits != 1 {
		t.Fatalf("machine.deleted audit events = %d, %v", audits, err)
	}

	// Jobs block the deletion until they are deleted; their tombstones go with the machine.
	worked := newMachine("Worked printer")
	if _, err = logbook.CreatePricingGroup(ctx, master, "Standard", nil, true, nil); err != nil {
		t.Fatal(err)
	}
	start := time.Now().UTC().Add(-4 * time.Hour).Truncate(time.Second)
	job, err := logbook.CreateManualJob(
		ctx,
		master,
		machinelogbook.JobInput{
			MachineID:        worked.Id,
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
	var problem map[string]any
	api(manager, http.MethodDelete, "/machines/"+worked.Id.String(), http.StatusConflict, version(worked), &problem)
	if problem["code"] != "machine_in_use" {
		t.Fatalf("in-use problem: %+v", problem)
	}
	if err = logbook.DeleteJob(
		ctx,
		master,
		job.ID,
		machinelogbook.DeleteJobInput{ExpectedVersion: job.Version},
		nil,
	); err != nil {
		t.Fatal(err)
	}
	api(manager, http.MethodDelete, "/machines/"+worked.Id.String(), http.StatusNoContent, version(worked), nil)
	gone(worked)
	var jobs int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM machine_jobs WHERE id = $1`, job.ID).Scan(&jobs); err != nil ||
		jobs != 0 {
		t.Fatalf("job tombstones left = %d, %v", jobs, err)
	}

	// A connected machine also needs printer_connectors.manage; its connector is told to drop the assignment.
	connected := newMachine("Connected printer")
	run := insertRecordedRun(t, pool, connected.Id)
	api(
		connectorManager,
		http.MethodDelete,
		"/machines/"+connected.Id.String(),
		http.StatusConflict,
		version(connected),
		&problem,
	)
	if problem["code"] != "machine_in_use" {
		t.Fatalf("recorded run problem: %+v", problem)
	}
	if _, err = pool.Exec(ctx, `UPDATE machine_runs SET deleted_at = now() WHERE id = $1`, run.id); err != nil {
		t.Fatal(err)
	}
	var connectorID uuid.UUID
	var revision int64
	if err = pool.QueryRow(
		ctx,
		`SELECT c.id, c.configuration_revision FROM printer_connectors c JOIN printer_connector_assignments a ON a.connector_id = c.id WHERE a.machine_id = $1`,
		connected.Id,
	).Scan(&connectorID, &revision); err != nil {
		t.Fatal(err)
	}
	api(manager, http.MethodDelete, "/machines/"+connected.Id.String(), http.StatusForbidden, version(connected), nil)
	api(
		connectorManager,
		http.MethodDelete,
		"/machines/"+connected.Id.String(),
		http.StatusNoContent,
		version(connected),
		nil,
	)
	gone(connected)
	var after int64
	var assignments int
	if err = pool.QueryRow(
		ctx,
		`SELECT configuration_revision, (SELECT count(*) FROM printer_connector_assignments WHERE connector_id = $1) FROM printer_connectors WHERE id = $1`,
		connectorID,
	).Scan(&after, &assignments); err != nil {
		t.Fatal(err)
	}
	if after != revision+1 || assignments != 0 {
		t.Fatalf("connector revision %d -> %d, assignments left %d", revision, after, assignments)
	}

	// A mounted spool blocks the deletion; once unmounted, the slot and its mount history go with the machine.
	loaded := newMachine("Loaded printer")
	var profile struct {
		Slots []struct {
			Id uuid.UUID `json:"id"`
		} `json:"slots"`
	}
	api(
		root,
		http.MethodPut,
		"/machines/"+loaded.Id.String()+"/printer/setup",
		http.StatusOK,
		map[string]any{"expectedVersion": nil, "enabled": true, "model": "bambu_h2d", "inputUnits": []any{
			map[string]any{
				"name":               "AMS",
				"nozzle":             "left",
				"externalIdentifier": "0",
				"slots": []any{
					map[string]any{"name": "Slot 1", "status": "available", "externalIdentifier": "0"},
				},
			},
		}},
		&profile,
	)
	if len(profile.Slots) != 1 {
		t.Fatalf("profile slots: %+v", profile)
	}
	var spool struct {
		Id uuid.UUID `json:"id"`
	}
	api(
		root,
		http.MethodPost,
		"/filament-spools",
		http.StatusCreated,
		map[string]any{
			"kind":       "reusable",
			"label":      "Mdel spool",
			"stockMode":  "empty",
			"occurredAt": time.Now().UTC().Format(time.RFC3339),
		},
		&spool,
	)
	slotPath := "/printer-slots/" + profile.Slots[0].Id.String()
	// Stored the way a mount leaves it; mounting over the API needs a spool with an open fill.
	if _, err = pool.Exec(
		ctx,
		`INSERT INTO printer_spool_assignments (id, slot_id, spool_id, mounted_at, source) VALUES ($1, $2, $3, now() - interval '1 hour', 'manual')`,
		ids.New(),
		profile.Slots[0].Id,
		spool.Id,
	); err != nil {
		t.Fatal(err)
	}
	api(manager, http.MethodDelete, "/machines/"+loaded.Id.String(), http.StatusConflict, version(loaded), &problem)
	if problem["code"] != "machine_has_mounted_spools" {
		t.Fatalf("mounted problem: %+v", problem)
	}
	api(root, http.MethodPost, slotPath+"/unmount", http.StatusOK, nil, nil)
	api(manager, http.MethodDelete, "/machines/"+loaded.Id.String(), http.StatusNoContent, version(loaded), nil)
	gone(loaded)
	api(root, http.MethodGet, "/filament-spools/"+spool.Id.String(), http.StatusOK, nil, nil)
}
