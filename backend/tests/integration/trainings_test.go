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
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// statementPool is a migrated pool in the production query mode, which encodes UUID arrays.
func statementPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	schemaPool := migratedPool(t)
	poolConfig := schemaPool.Config().Copy()
	poolConfig.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeCacheStatement
	pool, err := pgxpool.NewWithConfig(testContext(t), poolConfig)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestTrainingCatalogPermissionsLinksAndDeletion(t *testing.T) {
	pool := statementPool(t)
	ctx := testContext(t)
	service := trainings.NewService(pool)
	manager, _ := principalWithPermissions(t, pool, "training-manager", "trainings.manage")
	selfReader, _ := principalWithPermissions(t, pool, "training-self", "training_records.read.self")
	allReader, _ := principalWithPermissions(t, pool, "training-all", "training_records.read.all")
	updater, _ := principalWithPermissions(t, pool, "training-updater", "training_records.update")
	nobody, _ := principalWithPermissions(t, pool, "training-nobody", "machines.read")

	// Writing the catalogue needs trainings.manage; the record permissions only read it.
	category := trainings.CompetencyCategoryInput{Name: " 3D printing ", Active: true, SortOrder: 10}
	for name, principal := range map[string]authorization.Principal{
		"self": selfReader, "all": allReader, "updater": updater, "nobody": nobody,
	} {
		_, err := service.CreateCompetencyCategory(ctx, principal, category, nil)
		requireAppError(t, err, http.StatusForbidden, "permission_denied")
		_, err = service.CreateTraining(ctx, principal, trainings.TrainingInput{Name: "Laser", Active: true}, nil)
		requireAppError(t, err, http.StatusForbidden, "permission_denied")
		if name == "nobody" || name == "updater" {
			_, err = service.ListTrainings(ctx, principal)
			requireAppError(t, err, http.StatusForbidden, "permission_denied")
			_, err = service.ListCompetencyCategories(ctx, principal)
			requireAppError(t, err, http.StatusForbidden, "permission_denied")
		}
	}
	assertCount(t, pool, `SELECT count(*) FROM competency_categories`, 0)
	assertCount(t, pool, `SELECT count(*) FROM trainings`, 0)

	printing, err := service.CreateCompetencyCategory(ctx, manager, category, nil)
	if err != nil {
		t.Fatal(err)
	}
	if printing.Name != "3D printing" || !printing.Active || printing.SortOrder != 10 || printing.Version != 1 {
		t.Fatalf("category = %+v", printing)
	}
	_, err = service.CreateCompetencyCategory(ctx, manager, trainings.CompetencyCategoryInput{Name: "3d PRINTING"}, nil)
	requireAppError(t, err, http.StatusConflict, "competency_category_exists")
	_, err = service.CreateCompetencyCategory(ctx, manager, trainings.CompetencyCategoryInput{Name: "  "}, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "")
	laser, err := service.CreateCompetencyCategory(
		ctx, manager, trainings.CompetencyCategoryInput{Name: "Laser cutting", Active: true, SortOrder: 20}, nil,
	)
	if err != nil {
		t.Fatal(err)
	}

	machineTypeID := ids.New()
	if _, err := pool.Exec(ctx, `INSERT INTO machine_types(id,name,process) VALUES($1,'Bambu Lab H2D','fdm_printing')`,
		machineTypeID); err != nil {
		t.Fatal(err)
	}
	_, err = service.CreateTraining(ctx, manager, trainings.TrainingInput{
		Name: "H2D", Active: true, CompetencyIDs: []uuid.UUID{ids.New()},
	}, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "")
	_, err = service.CreateTraining(ctx, manager, trainings.TrainingInput{
		Name: "H2D", Active: true, MachineTypeIDs: []uuid.UUID{ids.New()},
	}, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "")
	assertCount(t, pool, `SELECT count(*) FROM trainings`, 0)

	h2d, err := service.CreateTraining(ctx, manager, trainings.TrainingInput{
		Name:           "Bambu Lab H2D – operation",
		Active:         true,
		CompetencyIDs:  []uuid.UUID{printing.ID, printing.ID},
		MachineTypeIDs: []uuid.UUID{machineTypeID},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(h2d.CompetencyIDs) != 1 || h2d.CompetencyIDs[0] != printing.ID || len(h2d.MachineTypeIDs) != 1 {
		t.Fatalf("training = %+v", h2d)
	}

	// Readers with a record permission see the catalogue.
	for _, principal := range []authorization.Principal{selfReader, allReader, manager} {
		items, err := service.ListTrainings(ctx, principal)
		if err != nil || len(items) != 1 || items[0].ID != h2d.ID {
			t.Fatalf("trainings = %+v, %v", items, err)
		}
		categories, err := service.ListCompetencyCategories(ctx, principal)
		if err != nil || len(categories) != 2 || categories[0].ID != printing.ID || categories[0].TrainingCount != 1 {
			t.Fatalf("categories = %+v, %v", categories, err)
		}
	}

	// An update replaces both link lists, checks the version and audits the changed field names only.
	_, err = service.UpdateTraining(ctx, manager, h2d.ID, h2d.Version+1, trainings.TrainingInput{Name: "x"}, nil)
	requireAppError(t, err, http.StatusConflict, "stale_write")
	description := "Internal note"
	h2d, err = service.UpdateTraining(ctx, manager, h2d.ID, h2d.Version, trainings.TrainingInput{
		Name:          "Bambu Lab H2D – operation",
		Description:   &description,
		Active:        true,
		CompetencyIDs: []uuid.UUID{printing.ID, laser.ID},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(h2d.CompetencyIDs) != 2 || len(h2d.MachineTypeIDs) != 0 || h2d.Version != 2 {
		t.Fatalf("updated training = %+v", h2d)
	}
	var changed []string
	if err := pool.QueryRow(ctx, `SELECT changed_fields FROM audit_events WHERE action='training.updated'`).
		Scan(&changed); err != nil {
		t.Fatal(err)
	}
	if len(changed) != 3 || changed[0] != "description" || changed[1] != "competencyIds" ||
		changed[2] != "machineTypeIds" {
		t.Fatalf("changed fields = %v", changed)
	}
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE metadata::text LIKE '%Internal note%'`, 0)

	// A category fed by a training cannot be deleted; it can be deactivated.
	err = service.DeleteCompetencyCategory(ctx, manager, laser.ID, laser.Version, nil)
	requireAppError(t, err, http.StatusConflict, "competency_category_in_use")
	laser, err = service.UpdateCompetencyCategory(ctx, manager, laser.ID, laser.Version,
		trainings.CompetencyCategoryInput{Name: "Laser cutting", Active: false, SortOrder: 20}, nil)
	if err != nil || laser.Active {
		t.Fatalf("deactivate = %+v, %v", laser, err)
	}
	err = service.DeleteCompetencyCategory(ctx, updater, laser.ID, laser.Version, nil)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")

	// A training with records cannot be deleted; without records it can.
	personID := insertPlainPerson(t, pool, "trained-person@example.test")
	if _, err := pool.Exec(ctx, `INSERT INTO training_records(person_id,training_id,status) VALUES($1,$2,'trained')`,
		personID, h2d.ID); err != nil {
		t.Fatal(err)
	}
	err = service.DeleteTraining(ctx, manager, h2d.ID, h2d.Version, nil)
	requireAppError(t, err, http.StatusConflict, "training_in_use")
	if _, err := pool.Exec(ctx, `DELETE FROM training_records WHERE person_id=$1`, personID); err != nil {
		t.Fatal(err)
	}
	if err := service.DeleteTraining(ctx, manager, h2d.ID, h2d.Version, nil); err != nil {
		t.Fatal(err)
	}
	if err := service.DeleteCompetencyCategory(ctx, manager, laser.ID, laser.Version, nil); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `SELECT count(*) FROM training_competencies`, 0)
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action IN ('training.deleted','competency_category.deleted')`, 2)
}

func TestTrainingRecordStatusIsConstrained(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	personID := insertPlainPerson(t, pool, "status-person@example.test")
	trainingID := ids.New()
	if _, err := pool.Exec(ctx, `INSERT INTO trainings(id,name) VALUES($1,'Soldering')`, trainingID); err != nil {
		t.Fatal(err)
	}
	// Not trained is the absence of a record, so only trained and trainer are stored.
	for _, status := range []string{"not_trained", "in_training", ""} {
		_, err := pool.Exec(ctx, `INSERT INTO training_records(person_id,training_id,status) VALUES($1,$2,$3)`,
			personID, trainingID, status)
		expectPostgresCode(t, err, "23514")
	}
	if _, err := pool.Exec(ctx, `INSERT INTO training_records(person_id,training_id,status) VALUES($1,$2,'trainer')`,
		personID, trainingID); err != nil {
		t.Fatal(err)
	}
	// Hard-deleting the person removes their records.
	if _, err := pool.Exec(ctx, `DELETE FROM people WHERE id=$1`, personID); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `SELECT count(*) FROM training_records`, 0)
}

func TestTrainingCatalogOverHTTP(t *testing.T) {
	pool := statementPool(t)
	ctx := testContext(t)
	const (
		origin        = "http://makerspace.example.test"
		adminLogin    = "trainings-admin@example.test"
		adminPassword = "Trainings admin workshop password 64"
	)
	if _, err := admin.NewService(pool).BootstrapMaster(ctx, admin.BootstrapInput{
		FirstName: "Trainings", LastName: "Admin", LoginEmail: adminLogin, Password: adminPassword,
	}); err != nil {
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

	response = doJSON(t, client, http.MethodPost, server.URL+"/api/v1/competency-categories", origin, csrf,
		map[string]any{"name": "Electronics", "active": true, "sortOrder": 0})
	assertStatus(t, response, http.StatusCreated)
	var category openapi.CompetencyCategory
	decodeResponse(t, response, &category)
	if category.Name != "Electronics" || category.Description.IsSpecified() && !category.Description.IsNull() {
		t.Fatalf("category = %+v", category)
	}
	response = doJSON(t, client, http.MethodPost, server.URL+"/api/v1/trainings", origin, csrf, map[string]any{
		"name": "Soldering basics", "active": true, "sortOrder": 0,
		"competencyIds": []string{category.Id.String()}, "machineTypeIds": []string{},
	})
	assertStatus(t, response, http.StatusCreated)
	var training openapi.Training
	decodeResponse(t, response, &training)
	response = doJSON(t, client, http.MethodPatch, server.URL+"/api/v1/trainings/"+training.Id.String(), origin, csrf,
		map[string]any{
			"expectedVersion": training.Version, "name": "Soldering basics", "description": "Iron and fumes",
			"active": false, "sortOrder": 5, "competencyIds": []string{}, "machineTypeIds": []string{},
		})
	assertStatus(t, response, http.StatusOK)
	decodeResponse(t, response, &training)
	if training.Active || training.SortOrder != 5 || len(training.CompetencyIds) != 0 ||
		training.Description.MustGet() != "Iron and fumes" {
		t.Fatalf("training = %+v", training)
	}
	// Unknown fields are rejected by the contract.
	response = doJSON(t, client, http.MethodPost, server.URL+"/api/v1/competency-categories", origin, csrf,
		map[string]any{"name": "Other", "active": true, "sortOrder": 0, "trainer": true})
	if response.StatusCode != http.StatusBadRequest && response.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("unknown field = %d", response.StatusCode)
	}
	response.Body.Close()
	response = doJSON(t, client, http.MethodGet, server.URL+"/api/v1/trainings", "", "", nil)
	assertStatus(t, response, http.StatusOK)
	assertNoStoreAndRequestID(t, response)
	var list openapi.TrainingList
	decodeResponse(t, response, &list)
	if len(list.Items) != 1 || list.Items[0].Id != training.Id {
		t.Fatalf("list = %+v", list)
	}
	response = doJSON(t, client, http.MethodDelete, server.URL+"/api/v1/trainings/"+training.Id.String(), origin, csrf,
		map[string]any{"expectedVersion": training.Version})
	assertStatus(t, response, http.StatusNoContent)
	response.Body.Close()
}
