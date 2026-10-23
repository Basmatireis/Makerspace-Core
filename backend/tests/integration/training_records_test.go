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
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/trainings"
	"github.com/google/uuid"
)

func insertTraining(t *testing.T, service *trainings.Service, manager authorization.Principal, name string) trainings.Training {
	t.Helper()
	training, err := service.CreateTraining(testContext(t), manager, trainings.TrainingInput{Name: name, Active: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	return training
}

func recordFor(t *testing.T, records []trainings.Record, trainingID uuid.UUID) trainings.Record {
	t.Helper()
	for _, record := range records {
		if record.TrainingID == trainingID {
			return record
		}
	}
	t.Fatalf("no entry for training %s in %+v", trainingID, records)
	return trainings.Record{}
}

func TestTrainingRecordScopesAndSelfChange(t *testing.T) {
	pool := statementPool(t)
	ctx := testContext(t)
	service := trainings.NewService(pool)
	manager, _ := principalWithPermissions(t, pool, "records-manager", "trainings.manage")
	selfReader, self := principalWithPermissions(t, pool, "records-self", "training_records.read.self")
	allReader, _ := principalWithPermissions(t, pool, "records-all", "training_records.read.all")
	updater, updaterSeed := principalWithPermissions(t, pool, "records-updater", "training_records.update")
	nobody, _ := principalWithPermissions(t, pool, "records-nobody", "people.read.all")
	other := insertPlainPerson(t, pool, "records-other@example.test")
	laser := insertTraining(t, service, manager, "Trotec Speedy")

	notes := "Needs a refresher on focus"
	for _, personID := range []uuid.UUID{self.personID, other} {
		if _, err := service.SetRecord(ctx, updater, personID, laser.ID, trainings.RecordInput{
			Status: trainings.StatusTrained, Notes: &notes,
		}, nil); err != nil {
			t.Fatal(err)
		}
	}

	// Self readers see their own status without internal notes, nobody else's.
	own, err := service.ListPersonRecords(ctx, selfReader, self.personID)
	if err != nil {
		t.Fatal(err)
	}
	if entry := recordFor(t, own, laser.ID); entry.Status != trainings.StatusTrained || entry.Notes != nil {
		t.Fatalf("own entry = %+v", entry)
	}
	_, err = service.ListPersonRecords(ctx, selfReader, other)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")
	_, err = service.ListPersonRecords(ctx, nobody, other)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")

	// Readers of all records and updaters see notes.
	for _, principal := range []authorization.Principal{allReader, updater} {
		records, err := service.ListPersonRecords(ctx, principal, other)
		if err != nil {
			t.Fatal(err)
		}
		if entry := recordFor(t, records, laser.ID); entry.Notes == nil || *entry.Notes != notes {
			t.Fatalf("entry = %+v", entry)
		}
	}
	_, err = service.ListPersonRecords(ctx, allReader, ids.New())
	requireAppError(t, err, http.StatusNotFound, "")

	// Only updaters write, and never their own status.
	for _, principal := range []authorization.Principal{selfReader, allReader, manager, nobody} {
		_, err = service.SetRecord(ctx, principal, other, laser.ID, trainings.RecordInput{
			Status: trainings.StatusNotTrained, ExpectedVersion: int64Pointer(1),
		}, nil)
		requireAppError(t, err, http.StatusForbidden, "permission_denied")
	}
	_, err = service.SetRecord(ctx, updater, updaterSeed.personID, laser.ID,
		trainings.RecordInput{Status: trainings.StatusTrainer}, nil)
	requireAppError(t, err, http.StatusForbidden, "training_record_self")
	assertCount(t, pool, `SELECT count(*) FROM training_records WHERE person_id = $1`, 0, updaterSeed.personID)
	_, err = service.SetRecord(ctx, updater, ids.New(), laser.ID, trainings.RecordInput{Status: trainings.StatusTrained}, nil)
	requireAppError(t, err, http.StatusNotFound, "")
	_, err = service.SetRecord(ctx, updater, other, ids.New(), trainings.RecordInput{Status: trainings.StatusTrained}, nil)
	requireAppError(t, err, http.StatusNotFound, "")
}

func TestTrainingRecordTransitionsVersionsAndAudit(t *testing.T) {
	pool := statementPool(t)
	ctx := testContext(t)
	service := trainings.NewService(pool)
	manager, _ := principalWithPermissions(t, pool, "transitions-manager", "trainings.manage")
	updater, _ := principalWithPermissions(t, pool, "transitions-updater", "training_records.update")
	person := insertPlainPerson(t, pool, "transitions-person@example.test")
	h2d := insertTraining(t, service, manager, "Bambu Lab H2D")
	x1c := insertTraining(t, service, manager, "Bambu Lab X1C")

	// Without a record every active training is not trained and has no version.
	records, err := service.ListPersonRecords(ctx, updater, person)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 2 {
		t.Fatalf("records = %+v", records)
	}
	for _, record := range records {
		if record.Status != trainings.StatusNotTrained || record.Version != nil || record.UpdatedAt != nil {
			t.Fatalf("default record = %+v", record)
		}
	}

	set := func(input trainings.RecordInput) (trainings.Record, error) {
		return service.SetRecord(ctx, updater, person, h2d.ID, input, nil)
	}
	for name, input := range map[string]trainings.RecordInput{
		"unknown status":     {Status: "in_training"},
		"empty status":       {Status: ""},
		"not trained notes":  {Status: trainings.StatusNotTrained, Notes: stringPointer("x")},
		"future completion":  {Status: trainings.StatusTrained, CompletedOn: timePointer(time.Now().AddDate(0, 0, 3))},
		"non-positive check": {Status: trainings.StatusTrained, ExpectedVersion: int64Pointer(0)},
	} {
		_, err := set(input)
		if err == nil {
			t.Fatalf("%s accepted", name)
		}
		requireAppError(t, err, http.StatusUnprocessableEntity, "")
	}
	// A caller who claims to have seen a record that does not exist is stale.
	_, err = set(trainings.RecordInput{Status: trainings.StatusTrained, ExpectedVersion: int64Pointer(1)})
	requireAppError(t, err, http.StatusConflict, "stale_write")
	// Not trained without a record changes nothing and is not audited.
	if record, err := set(trainings.RecordInput{Status: trainings.StatusNotTrained}); err != nil ||
		record.Status != trainings.StatusNotTrained {
		t.Fatalf("noop = %+v, %v", record, err)
	}
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE resource_type = 'training_record'`, 0)

	completed := time.Date(2026, 9, 14, 0, 0, 0, 0, time.UTC)
	record, err := set(trainings.RecordInput{
		Status: trainings.StatusTrained, CompletedOn: &completed, Notes: stringPointer("Confidential remark"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if record.Status != trainings.StatusTrained || record.Version == nil || *record.Version != 1 ||
		record.CompletedOn == nil || !record.CompletedOn.Equal(completed) {
		t.Fatalf("trained = %+v", record)
	}
	// A second writer who also saw no record loses.
	_, err = set(trainings.RecordInput{Status: trainings.StatusTrainer})
	requireAppError(t, err, http.StatusConflict, "stale_write")
	_, err = set(trainings.RecordInput{Status: trainings.StatusTrainer, ExpectedVersion: int64Pointer(7)})
	requireAppError(t, err, http.StatusConflict, "stale_write")

	record, err = set(trainings.RecordInput{
		Status: trainings.StatusTrainer, CompletedOn: &completed, Notes: stringPointer("Confidential remark"),
		ExpectedVersion: record.Version,
	})
	if err != nil || record.Status != trainings.StatusTrainer || *record.Version != 2 {
		t.Fatalf("trainer = %+v, %v", record, err)
	}
	// Back to trained keeps the person qualified; only the trainer right goes.
	record, err = set(trainings.RecordInput{
		Status: trainings.StatusTrained, CompletedOn: &completed, ExpectedVersion: record.Version,
	})
	if err != nil || record.Status != trainings.StatusTrained || record.Notes != nil {
		t.Fatalf("trained again = %+v, %v", record, err)
	}
	// An unchanged status writes nothing.
	unchanged, err := set(trainings.RecordInput{
		Status: trainings.StatusTrained, CompletedOn: &completed, ExpectedVersion: record.Version,
	})
	if err != nil || *unchanged.Version != *record.Version {
		t.Fatalf("unchanged = %+v, %v", unchanged, err)
	}
	if _, err := set(trainings.RecordInput{Status: trainings.StatusNotTrained, ExpectedVersion: record.Version}); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `SELECT count(*) FROM training_records`, 0)

	var actions []string
	rows, err := pool.Query(ctx, `SELECT action FROM audit_events WHERE resource_type = 'training_record'
		AND resource_id = $1 AND metadata->>'trainingId' = $2 AND metadata->>'personId' = $1::text
		ORDER BY occurred_at, id`, person, h2d.ID.String())
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var action string
		if err := rows.Scan(&action); err != nil {
			t.Fatal(err)
		}
		actions = append(actions, action)
	}
	rows.Close()
	want := []string{"training_record.trained", "training_record.trainer", "training_record.trained", "training_record.removed"}
	if len(actions) != len(want) {
		t.Fatalf("actions = %v", actions)
	}
	for i := range want {
		if actions[i] != want[i] {
			t.Fatalf("actions = %v, want %v", actions, want)
		}
	}
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE metadata::text LIKE '%Confidential%'`, 0)

	// Inactive trainings take no new status but keep, show and allow correcting existing records.
	if _, err := service.SetRecord(ctx, updater, person, x1c.ID, trainings.RecordInput{Status: trainings.StatusTrained}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := service.UpdateTraining(ctx, manager, x1c.ID, x1c.Version, trainings.TrainingInput{Name: x1c.Name}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := service.UpdateTraining(ctx, manager, h2d.ID, h2d.Version, trainings.TrainingInput{Name: h2d.Name}, nil); err != nil {
		t.Fatal(err)
	}
	records, err = service.ListPersonRecords(ctx, updater, person)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 || records[0].TrainingID != x1c.ID || records[0].TrainingActive {
		t.Fatalf("records with inactive trainings = %+v", records)
	}
	_, err = service.SetRecord(ctx, updater, person, h2d.ID, trainings.RecordInput{Status: trainings.StatusTrained}, nil)
	requireAppError(t, err, http.StatusConflict, "training_inactive")
	_, err = service.SetRecord(ctx, updater, person, x1c.ID, trainings.RecordInput{
		Status: trainings.StatusTrainer, ExpectedVersion: records[0].Version,
	}, nil)
	requireAppError(t, err, http.StatusConflict, "training_inactive")
	corrected, err := service.SetRecord(ctx, updater, person, x1c.ID, trainings.RecordInput{
		Status: trainings.StatusTrained, CompletedOn: &completed, ExpectedVersion: records[0].Version,
	}, nil)
	if err != nil || corrected.CompletedOn == nil {
		t.Fatalf("correction = %+v, %v", corrected, err)
	}
	if _, err := service.SetRecord(ctx, updater, person, x1c.ID, trainings.RecordInput{
		Status: trainings.StatusNotTrained, ExpectedVersion: corrected.Version,
	}, nil); err != nil {
		t.Fatal(err)
	}
}

func TestTrainingRecordsOverHTTP(t *testing.T) {
	pool := statementPool(t)
	ctx := testContext(t)
	const (
		origin        = "http://makerspace.example.test"
		adminLogin    = "records-admin@example.test"
		adminPassword = "Records admin workshop password 65"
	)
	masterAccount, err := admin.NewService(pool).BootstrapMaster(ctx, admin.BootstrapInput{
		FirstName: "Records", LastName: "Admin", LoginEmail: adminLogin, Password: adminPassword,
	})
	if err != nil {
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
	client := newCookieClient(t)
	response := doJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/login", origin, "",
		map[string]any{"email": adminLogin, "password": adminPassword})
	assertStatus(t, response, http.StatusNoContent)
	response.Body.Close()
	csrf := cookieValue(t, client, server.URL, cfg.CSRFCookieName)

	response = doJSON(t, client, http.MethodPost, server.URL+"/api/v1/trainings", origin, csrf, map[string]any{
		"name": "Soldering basics", "active": true, "sortOrder": 0, "competencyIds": []string{}, "machineTypeIds": []string{},
	})
	assertStatus(t, response, http.StatusCreated)
	var training openapi.Training
	decodeResponse(t, response, &training)
	person := insertPlainPerson(t, pool, "records-http@example.test")
	base := server.URL + "/api/v1/people/" + person.String() + "/training-records"

	response = doJSON(t, client, http.MethodGet, base, "", "", nil)
	assertStatus(t, response, http.StatusOK)
	assertNoStoreAndRequestID(t, response)
	var list openapi.TrainingRecordList
	decodeResponse(t, response, &list)
	if len(list.Items) != 1 || list.Items[0].Status != openapi.TrainingStatusNotTrained || !list.Items[0].Version.IsNull() {
		t.Fatalf("list = %+v", list)
	}

	path := base + "/" + training.Id.String()
	response = doJSON(t, client, http.MethodPut, path, origin, csrf, map[string]any{"status": "trained_maybe"})
	if response.StatusCode != http.StatusBadRequest && response.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("invalid status = %d", response.StatusCode)
	}
	response.Body.Close()
	response = doJSON(t, client, http.MethodPut, path, origin, csrf,
		map[string]any{"status": "trainer", "completedOn": "2026-10-01", "notes": "Gave the October session"})
	assertStatus(t, response, http.StatusOK)
	var record openapi.TrainingRecord
	decodeResponse(t, response, &record)
	if record.Status != openapi.TrainingStatusTrainer || record.Version.MustGet() != 1 ||
		record.CompletedOn.MustGet().String() != "2026-10-01" || record.Notes.MustGet() != "Gave the October session" {
		t.Fatalf("record = %+v", record)
	}
	response = doJSON(t, client, http.MethodPut, path, origin, csrf,
		map[string]any{"status": "not_trained", "expectedVersion": record.Version.MustGet()})
	assertStatus(t, response, http.StatusOK)
	decodeResponse(t, response, &record)
	if record.Status != openapi.TrainingStatusNotTrained || !record.Version.IsNull() {
		t.Fatalf("removed = %+v", record)
	}

	// The master is bound by the self-change rule too.
	var masterPerson uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT person_id FROM accounts WHERE id = $1`, masterAccount).Scan(&masterPerson); err != nil {
		t.Fatal(err)
	}
	response = doJSON(t, client, http.MethodPut,
		server.URL+"/api/v1/people/"+masterPerson.String()+"/training-records/"+training.Id.String(), origin, csrf,
		map[string]any{"status": "trained"})
	assertStatus(t, response, http.StatusForbidden)
	var problem struct {
		Code string `json:"code"`
	}
	decodeResponse(t, response, &problem)
	if problem.Code != "training_record_self" {
		t.Fatalf("code = %q", problem.Code)
	}
}

func int64Pointer(value int64) *int64 { return &value }

func timePointer(value time.Time) *time.Time { return &value }
