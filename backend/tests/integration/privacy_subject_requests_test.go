package integration_test

import (
	"archive/zip"
	"bytes"
	"errors"
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
	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/httpapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/people"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/storage"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/subjectrequests"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type subjectRequestJSON struct {
	ID              uuid.UUID `json:"id"`
	Kind            string    `json:"kind"`
	Status          string    `json:"status"`
	PersonID        *string   `json:"personId"`
	Reference       string    `json:"reference"`
	ReceivedAt      time.Time `json:"receivedAt"`
	DueAt           time.Time `json:"dueAt"`
	ExportAvailable bool      `json:"exportAvailable"`
	Version         int64     `json:"version"`
	Assessment      *struct {
		Categories []struct {
			CategoryID string  `json:"categoryId"`
			Records    int64   `json:"records"`
			Outcome    *string `json:"outcome"`
		} `json:"categories"`
		Blockers            []string `json:"blockers"`
		OpenHolds           int      `json:"openHolds"`
		UncoveredCategories []string `json:"uncoveredCategories"`
	} `json:"assessment"`
	Result *struct {
		Categories []struct {
			CategoryID string  `json:"categoryId"`
			Records    int64   `json:"records"`
			Outcome    *string `json:"outcome"`
		} `json:"categories"`
	} `json:"result"`
	Steps []struct {
		Status string `json:"status"`
		Note   string `json:"note"`
	} `json:"steps"`
}

func (r subjectRequestJSON) category(id string) (int64, string) {
	if r.Result != nil {
		for _, category := range r.Result.Categories {
			if category.CategoryID == id {
				outcome := ""
				if category.Outcome != nil {
					outcome = *category.Outcome
				}
				return category.Records, outcome
			}
		}
	}
	if r.Assessment != nil {
		for _, category := range r.Assessment.Categories {
			if category.CategoryID == id {
				outcome := ""
				if category.Outcome != nil {
					outcome = *category.Outcome
				}
				return category.Records, outcome
			}
		}
	}
	return -1, ""
}

// seedSubject creates a person with an account and some history across modules.
func seedSubject(t *testing.T, pool *pgxpool.Pool, suffix, orderReference string) seededAccount {
	t.Helper()
	ctx := testContext(t)
	subject := seedAccount(t, pool, suffix, false)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO visits(id,person_id,checked_in_at,checked_out_at,status,check_in_method,check_in_assurance,
		check_out_method,check_out_assurance,admission_decision)
		VALUES($1,$2,now()-interval '2 days',now()-interval '2 days'+interval '3 hours','checked_out','supervisor','normal','supervisor','normal','admitted')`,
		ids.New(), subject.personID)
	trainingID := ids.New()
	exec(`INSERT INTO trainings(id,name) VALUES($1,$2)`, trainingID, "Laser cutter "+suffix)
	exec(`INSERT INTO training_records(person_id,training_id,status) VALUES($1,$2,'trained')`, subject.personID, trainingID)
	exec(`INSERT INTO orders(id,reference,customer_kind,customer_person_id,fulfillment_mode) VALUES($1,$2,'person',$3,'immediate')`,
		ids.New(), orderReference, subject.personID)
	return subject
}

// The data-subject request lifecycle over HTTP: record, verify identity, assess, approve, execute an access
// export and an erasure, with holds, blockers and the audit trail.
func TestSubjectRequestsOverHTTP(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	const (
		origin   = "http://makerspace.example.test"
		login    = "dsar-master@example.test"
		password = "Privacy master workshop password 41"
	)
	if _, err := admin.NewService(pool).BootstrapMaster(ctx, admin.BootstrapInput{
		FirstName: "Dsar", LastName: "Master", LoginEmail: login, Password: password,
	}); err != nil {
		t.Fatal(err)
	}
	baseURL, _ := url.Parse(origin)
	cfg := config.Config{
		PublicBaseURL: baseURL, SessionCookieName: "makerspace_session", CSRFCookieName: "makerspace_csrf",
		SessionIdleTTL: 6 * time.Hour, SessionAbsoluteTTL: 72 * time.Hour, PasswordResetTTL: 30 * time.Minute,
		MakerspaceTimeZone: "Europe/Vienna", LocalStorageRoot: t.TempDir(),
	}
	handler, err := httpapi.NewHandler(pool, cfg, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	defer server.Close()
	client := newCookieClient(t)
	response := doJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/login", origin, "", map[string]any{"email": login, "password": password})
	assertStatus(t, response, http.StatusNoContent)
	response.Body.Close()
	elevateMasterSessions(t, pool)
	csrf := cookieValue(t, client, server.URL, cfg.CSRFCookieName)
	api := func(method, path string, body any) *http.Response {
		return doJSON(t, client, method, server.URL+"/api/v1"+path, origin, csrf, body)
	}
	var problem struct {
		Code string `json:"code"`
	}
	expectCode := func(response *http.Response, status int, code string) {
		t.Helper()
		assertStatus(t, response, status)
		decodeResponse(t, response, &problem)
		if problem.Code != code {
			t.Fatalf("code = %q, want %q", problem.Code, code)
		}
	}

	subject := seedSubject(t, pool, "dsar-access-subject", "O-2026-000101")
	received := time.Now().UTC().Add(-time.Hour).Truncate(time.Second)
	response = api(http.MethodPost, "/privacy/requests", map[string]any{
		"kind": "access", "personId": subject.personID, "channel": "email", "receivedAt": received, "reference": "T-1001",
	})
	assertStatus(t, response, http.StatusCreated)
	var request subjectRequestJSON
	decodeResponse(t, response, &request)
	if request.Status != "received" || request.Reference != "T-1001" || !request.DueAt.Equal(received.Add(30*24*time.Hour)) ||
		len(request.Steps) != 1 || request.Steps[0].Status != "received" {
		t.Fatalf("created = %+v", request)
	}
	transition := func(id uuid.UUID, status, note string, version int64) *http.Response {
		return api(http.MethodPost, "/privacy/requests/"+id.String()+"/transition", map[string]any{
			"status": status, "note": note, "expectedVersion": version,
		})
	}
	// Order of steps is enforced, and the identity check needs a note.
	expectCode(transition(request.ID, "assessed", "", request.Version), http.StatusConflict, "request_state_invalid")
	expectCode(transition(request.ID, "identity_verified", "", request.Version), http.StatusUnprocessableEntity, "validation_failed")
	expectCode(transition(request.ID, "identity_verified", "Checked the student card in person", request.Version+1), http.StatusConflict, "stale_write")
	response = transition(request.ID, "identity_verified", "Checked the student card in person", request.Version)
	assertStatus(t, response, http.StatusOK)
	decodeResponse(t, response, &request)
	response = transition(request.ID, "assessed", "", request.Version)
	assertStatus(t, response, http.StatusOK)
	decodeResponse(t, response, &request)
	if request.Status != "assessed" || request.Assessment == nil || len(request.Assessment.UncoveredCategories) != 0 {
		t.Fatalf("assessed = %+v", request)
	}
	for id, want := range map[string]int64{"people.identity": 1, "attendance.visits": 1, "trainings.records": 1, "orders.financial_records": 1, "accounts.credentials": 1} {
		if records, _ := request.category(id); records != want {
			t.Fatalf("assessment of %s = %d, want %d", id, records, want)
		}
	}
	// The master verified the identity and approves: the master bypass covers the four-eyes rule.
	response = transition(request.ID, "approved", "", request.Version)
	assertStatus(t, response, http.StatusOK)
	decodeResponse(t, response, &request)
	response = api(http.MethodGet, "/privacy/requests/"+request.ID.String()+"/export", nil)
	assertStatus(t, response, http.StatusNotFound)
	response.Body.Close()
	response = api(http.MethodPost, "/privacy/requests/"+request.ID.String()+"/execute", map[string]any{"expectedVersion": request.Version})
	assertStatus(t, response, http.StatusOK)
	decodeResponse(t, response, &request)
	if request.Status != "completed" || !request.ExportAvailable || request.Result == nil {
		t.Fatalf("executed access = %+v", request)
	}
	response = api(http.MethodGet, "/privacy/requests/"+request.ID.String()+"/export", nil)
	assertStatus(t, response, http.StatusOK)
	if got := response.Header.Get("Content-Type"); !strings.HasPrefix(got, "application/zip") {
		t.Fatalf("content type = %q", got)
	}
	archive, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	reader, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		t.Fatal(err)
	}
	entries := map[string]string{}
	for _, file := range reader.File {
		opened, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		content, err := io.ReadAll(opened)
		opened.Close()
		if err != nil {
			t.Fatal(err)
		}
		entries[file.Name] = string(content)
	}
	if !strings.Contains(entries["manifest.json"], `"requestId": "`+request.ID.String()+`"`) ||
		!strings.Contains(entries["data/people.identity.json"], "dsar-access-subject@example.test") ||
		!strings.Contains(entries["data/attendance.visits.json"], `"status": "checked_out"`) ||
		!strings.Contains(entries["data/trainings.records.json"], "Laser cutter") ||
		!strings.Contains(entries["data/orders.financial_records.json"], "O-2026-") ||
		strings.Contains(entries["data/accounts.credentials.json"], "integration-test-hash") {
		t.Fatalf("archive entries = %v", entries)
	}
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action='privacy.subject_request_export_downloaded' AND resource_id=$1`, 1, request.ID)
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action='privacy.subject_request_executed' AND resource_id=$1 AND metadata ? 'countRecords'`, 1, request.ID)
	expectCode(api(http.MethodPost, "/privacy/requests/"+request.ID.String()+"/execute", map[string]any{"expectedVersion": request.Version}), http.StatusConflict, "request_state_invalid")

	// Erasure: a hold blocks it, then the person is deleted and the financial records stay without the link.
	response = api(http.MethodPost, "/privacy/requests", map[string]any{
		"kind": "erasure", "personId": subject.personID, "channel": "letter", "receivedAt": received, "reference": "T-1002",
	})
	assertStatus(t, response, http.StatusCreated)
	var erasure subjectRequestJSON
	decodeResponse(t, response, &erasure)
	response = transition(erasure.ID, "identity_verified", "Letter signature matched the Lab Rules confirmation", erasure.Version)
	assertStatus(t, response, http.StatusOK)
	decodeResponse(t, response, &erasure)
	response = api(http.MethodPost, "/privacy/holds", map[string]any{"personId": subject.personID, "reason": "Open dispute"})
	assertStatus(t, response, http.StatusCreated)
	var hold struct {
		ID uuid.UUID `json:"id"`
	}
	decodeResponse(t, response, &hold)
	response = transition(erasure.ID, "assessed", "", erasure.Version)
	assertStatus(t, response, http.StatusOK)
	decodeResponse(t, response, &erasure)
	if erasure.Assessment == nil || erasure.Assessment.OpenHolds != 1 || len(erasure.Assessment.Blockers) != 0 {
		t.Fatalf("erasure assessment = %+v", erasure.Assessment)
	}
	if _, outcome := erasure.category("orders.financial_records"); outcome != "retained_legal" {
		t.Fatalf("orders outcome = %q", outcome)
	}
	if _, outcome := erasure.category("people.identity"); outcome != "erased" {
		t.Fatalf("identity outcome = %q", outcome)
	}
	response = transition(erasure.ID, "approved", "", erasure.Version)
	assertStatus(t, response, http.StatusOK)
	decodeResponse(t, response, &erasure)
	expectCode(api(http.MethodPost, "/privacy/requests/"+erasure.ID.String()+"/execute", map[string]any{"expectedVersion": erasure.Version}), http.StatusConflict, "erasure_on_hold")
	response = api(http.MethodPost, "/privacy/holds/"+hold.ID.String()+"/release", nil)
	assertStatus(t, response, http.StatusOK)
	response.Body.Close()
	response = api(http.MethodPost, "/privacy/requests/"+erasure.ID.String()+"/execute", map[string]any{"expectedVersion": erasure.Version})
	assertStatus(t, response, http.StatusOK)
	decodeResponse(t, response, &erasure)
	if erasure.Status != "partially_completed" || erasure.PersonID != nil || erasure.ExportAvailable {
		t.Fatalf("executed erasure = %+v", erasure)
	}
	assertCount(t, pool, `SELECT count(*) FROM people WHERE id=$1`, 0, subject.personID)
	assertCount(t, pool, `SELECT count(*) FROM accounts WHERE id=$1`, 0, subject.accountID)
	assertCount(t, pool, `SELECT count(*) FROM orders WHERE customer_person_id IS NULL AND reference LIKE 'O-2026-%'`, 1)
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action='person.deleted' AND resource_id=$1`, 1, subject.personID)
	steps := make([]string, 0, len(erasure.Steps))
	for _, step := range erasure.Steps {
		steps = append(steps, step.Status)
	}
	if strings.Join(steps, ",") != "received,identity_verified,assessed,approved,executing,partially_completed" {
		t.Fatalf("steps = %v", steps)
	}
	// The access request lost its person link with the deletion but keeps its counts.
	response = api(http.MethodGet, "/privacy/requests/"+request.ID.String(), nil)
	assertStatus(t, response, http.StatusOK)
	decodeResponse(t, response, &request)
	if request.PersonID != nil || request.Status != "completed" {
		t.Fatalf("access request after erasure = %+v", request)
	}
	response = api(http.MethodGet, "/privacy/requests", nil)
	assertStatus(t, response, http.StatusOK)
	var list struct {
		Requests []subjectRequestJSON `json:"requests"`
	}
	decodeResponse(t, response, &list)
	if len(list.Requests) != 2 {
		t.Fatalf("listed %d requests", len(list.Requests))
	}

	// Processing activities: create, version-checked update and delete, unknown categories refused.
	expectCode(api(http.MethodPost, "/privacy/processing-activities", map[string]any{
		"name": "Attendance", "purpose": "p", "legalBasis": "l", "categoryIds": []string{"nope.nope"}, "recipients": "", "retentionNote": "",
	}), http.StatusUnprocessableEntity, "validation_failed")
	response = api(http.MethodPost, "/privacy/processing-activities", map[string]any{
		"name": "Attendance", "purpose": "Access control", "legalBasis": "Art. 6(1)(b)", "categoryIds": []string{"attendance.visits"},
		"recipients": "", "retentionNote": "90 days",
	})
	assertStatus(t, response, http.StatusCreated)
	var activity struct {
		ID          uuid.UUID `json:"id"`
		Version     int64     `json:"version"`
		CategoryIDs []string  `json:"categoryIds"`
	}
	decodeResponse(t, response, &activity)
	update := map[string]any{
		"name": "Attendance and surveys", "purpose": "Access control", "legalBasis": "Art. 6(1)(b)",
		"categoryIds": []string{"attendance.visits", "surveys.invitations"}, "recipients": "", "retentionNote": "", "expectedVersion": activity.Version,
	}
	response = api(http.MethodPut, "/privacy/processing-activities/"+activity.ID.String(), update)
	assertStatus(t, response, http.StatusOK)
	decodeResponse(t, response, &activity)
	if activity.Version != 2 || len(activity.CategoryIDs) != 2 {
		t.Fatalf("updated activity = %+v", activity)
	}
	expectCode(api(http.MethodPut, "/privacy/processing-activities/"+activity.ID.String(), update), http.StatusConflict, "stale_write")
	response = api(http.MethodDelete, "/privacy/processing-activities/"+activity.ID.String(), map[string]any{"expectedVersion": 2})
	assertStatus(t, response, http.StatusNoContent)
	response.Body.Close()
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action LIKE 'privacy.processing_activity_%'`, 3)

	// Retention removes closed requests and their export archives once they are old enough.
	if _, err := pool.Exec(ctx, `UPDATE privacy_subject_requests SET completed_at = now() - interval '400 days'`); err != nil {
		t.Fatal(err)
	}
	if affected := applyRetention(t, pool, subjectrequests.RetentionHandler(), time.Now().Add(-365*24*time.Hour)); affected != 2 {
		t.Fatalf("retention affected %d, want 2", affected)
	}
	assertCount(t, pool, `SELECT count(*) FROM privacy_subject_requests`, 0)
	assertCount(t, pool, `SELECT count(*) FROM files WHERE original_filename LIKE 'subject-request-%'`, 0)
	assertCount(t, pool, `SELECT count(*) FROM file_blob_deletions`, 1)
}

// Authorization: reads need privacy.requests.manage, execution privacy.requests.execute, and an erasure also
// needs people.delete; the four-eyes rule separates the identity check from the approval.
func TestSubjectRequestsAuthorization(t *testing.T) {
	env := newStaffingEnv(t)
	ctx := testContext(t)
	pool := env.pool
	store, err := storage.NewLocal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	fileService := files.NewService(pool, store)
	engine := retentionEngine(t, pool, 365*24*time.Hour, 180*24*time.Hour)
	service := subjectrequests.NewService(pool, engine, people.NewService(pool, fileService), fileService)

	manager := env.person("dsar-manager", env.role("Request managers", nil, authorization.PrivacyRequestsManage).ID)
	approver := env.person("dsar-approver", env.role("Request approvers", nil, authorization.PrivacyRequestsManage).ID)
	executor := env.person("dsar-executor", env.role("Request executors", nil, authorization.PrivacyRequestsExecute).ID)
	nobody := env.person("dsar-nobody")
	subject := seedSubject(t, pool, "dsar-authz-subject", "O-2026-000102")

	if _, err := service.List(ctx, nobody); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("list without permission = %v", err)
	}
	if _, err := service.Create(ctx, executor, subjectrequests.Input{Kind: "erasure", PersonID: subject.personID, Channel: "email", ReceivedAt: time.Now()}, nil); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("create with execute only = %v", err)
	}
	request, err := service.Create(ctx, manager, subjectrequests.Input{Kind: "erasure", PersonID: subject.personID, Channel: "email", ReceivedAt: time.Now()}, nil)
	if err != nil {
		t.Fatal(err)
	}
	request, err = service.Transition(ctx, manager, request.ID, "identity_verified", "Known member, checked in person", request.Version, nil)
	if err != nil {
		t.Fatal(err)
	}
	request, err = service.Transition(ctx, manager, request.ID, "assessed", "", request.Version, nil)
	if err != nil {
		t.Fatal(err)
	}
	// The manager lacks accounts.delete, which the assessment reports as a blocker without failing.
	if request.Assessment == nil || len(request.Assessment.Blockers) != 1 || request.Assessment.Blockers[0] != "accounts_delete_required" {
		t.Fatalf("assessment = %+v", request.Assessment)
	}
	if _, err := service.Transition(ctx, manager, request.ID, "approved", "", request.Version, nil); !apperror.IsCode(err, "request_four_eyes") {
		t.Fatalf("self approval = %v", err)
	}
	request, err = service.Transition(ctx, approver, request.ID, "approved", "", request.Version, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Execute(ctx, manager, request.ID, request.Version, nil); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("execute without execute permission = %v", err)
	}
	if _, err := service.Execute(ctx, executor, request.ID, request.Version, nil); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("erasure without people.delete = %v", err)
	}
	assertCount(t, pool, `SELECT count(*) FROM people WHERE id=$1`, 1, subject.personID)
	if _, _, err := service.OpenExport(ctx, manager, request.ID, nil); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("export without execute permission = %v", err)
	}
	// The master executes: deletion permissions included.
	executed, err := service.Execute(ctx, env.master, request.ID, request.Version, nil)
	if err != nil {
		t.Fatal(err)
	}
	if executed.Status != "partially_completed" || executed.PersonID != nil {
		t.Fatalf("executed = %+v", executed)
	}
	assertCount(t, pool, `SELECT count(*) FROM people WHERE id=$1`, 0, subject.personID)
}
