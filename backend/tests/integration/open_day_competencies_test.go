package integration_test

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/httpapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/inbox"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/opendays"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/trainings"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// competencyFixture is one published period with open days whose supervisor and trainee places are filled by SQL.
type competencyFixture struct {
	pool                    *pgxpool.Pool
	t                       *testing.T
	period                  uuid.UUID
	supervisors, trainees   map[uuid.UUID]uuid.UUID // open day -> requirement
	printing, laser, solder uuid.UUID               // categories
}

func newCompetencyFixture(t *testing.T, pool *pgxpool.Pool, periodStatus string) *competencyFixture {
	t.Helper()
	f := &competencyFixture{
		pool: pool, t: t, period: ids.New(),
		supervisors: map[uuid.UUID]uuid.UUID{}, trainees: map[uuid.UUID]uuid.UUID{},
	}
	f.exec(`INSERT INTO open_day_periods(id,name,starts_on,ends_on,status) VALUES($1,'Winter',$2,$3,$4)`,
		f.period, time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC), time.Date(2027, 1, 31, 0, 0, 0, 0, time.UTC), periodStatus)
	return f
}

func (f *competencyFixture) exec(sql string, args ...any) {
	f.t.Helper()
	if _, err := f.pool.Exec(testContext(f.t), sql, args...); err != nil {
		f.t.Fatalf("%s: %v", sql, err)
	}
}

func (f *competencyFixture) day(start time.Time) uuid.UUID {
	f.t.Helper()
	day := ids.New()
	f.exec(`INSERT INTO open_days(id,period_id,starts_at,ends_at) VALUES($1,$2,$3,$4)`,
		day, f.period, start, start.Add(4*time.Hour))
	f.supervisors[day], f.trainees[day] = ids.New(), ids.New()
	f.exec(`INSERT INTO open_day_staff_requirements(id,open_day_id,kind,required_count) VALUES($1,$2,'supervisor',3)`,
		f.supervisors[day], day)
	f.exec(`INSERT INTO open_day_staff_requirements(id,open_day_id,kind,required_count) VALUES($1,$2,'trainee',2)`,
		f.trainees[day], day)
	return day
}

func (f *competencyFixture) assign(day, requirement, person uuid.UUID) uuid.UUID {
	f.t.Helper()
	id := ids.New()
	f.exec(`INSERT INTO open_day_assignments(id,open_day_id,requirement_id,person_id) VALUES($1,$2,$3,$4)`,
		id, day, requirement, person)
	return id
}

func (f *competencyFixture) category(name string, sortOrder int) uuid.UUID {
	f.t.Helper()
	id := ids.New()
	f.exec(`INSERT INTO competency_categories(id,name,sort_order) VALUES($1,$2,$3)`, id, name, sortOrder)
	return id
}

func (f *competencyFixture) training(name string, categories ...uuid.UUID) uuid.UUID {
	f.t.Helper()
	id := ids.New()
	f.exec(`INSERT INTO trainings(id,name) VALUES($1,$2)`, id, name)
	for _, category := range categories {
		f.exec(`INSERT INTO training_competencies(training_id,competency_id) VALUES($1,$2)`, id, category)
	}
	return id
}

func (f *competencyFixture) record(person, training uuid.UUID, status string) {
	f.t.Helper()
	f.exec(`INSERT INTO training_records(person_id,training_id,status) VALUES($1,$2,$3)
		ON CONFLICT (person_id,training_id) DO UPDATE SET status = EXCLUDED.status`, person, training, status)
}

func labelsOf(items []trainings.Competency) string {
	labels := make([]string, 0, len(items))
	for _, item := range items {
		labels = append(labels, item.Label)
	}
	return strings.Join(labels, ",")
}

func TestOpenDayCompetenciesFollowAssignmentsAndRecords(t *testing.T) {
	pool := statementPool(t)
	ctx := testContext(t)
	f := newCompetencyFixture(t, pool, "published")
	f.printing = f.category("3D printing", 10)
	f.laser = f.category("Laser cutting", 20)
	f.solder = f.category("Electronics", 20)
	h2d := f.training("Bambu Lab H2D", f.printing)
	x1c := f.training("Bambu Lab X1C", f.printing)
	speedy := f.training("Trotec Speedy", f.laser)
	soldering := f.training("Soldering", f.solder)

	alice := insertPlainPerson(t, pool, "alice-competency@example.test")
	bob := insertPlainPerson(t, pool, "bob-competency@example.test")
	carol := insertPlainPerson(t, pool, "carol-competency@example.test")
	dave := insertPlainPerson(t, pool, "dave-competency@example.test")
	trainee := insertPlainPerson(t, pool, "trainee-competency@example.test")
	f.record(alice, h2d, "trained") // A: H2D trained, X1C not trained
	f.record(bob, speedy, "trainer")
	f.record(carol, x1c, "trained")
	f.record(trainee, soldering, "trainer")

	day := f.day(time.Date(2026, 10, 27, 15, 0, 0, 0, time.UTC))
	empty := f.day(time.Date(2026, 11, 3, 15, 0, 0, 0, time.UTC))
	cancelled := f.day(time.Date(2026, 11, 10, 15, 0, 0, 0, time.UTC))
	f.assign(day, f.supervisors[day], alice)
	f.assign(day, f.supervisors[day], bob)
	carolAssignment := f.assign(day, f.supervisors[day], carol)
	f.assign(day, f.supervisors[day], dave) // C: assigned without any training
	f.assign(day, f.trainees[day], trainee) // trainee places never count
	f.assign(cancelled, f.supervisors[cancelled], bob)
	f.exec(`UPDATE open_days SET status = 'cancelled' WHERE id = $1`, cancelled)

	resolve := func() map[uuid.UUID][]trainings.Competency {
		t.Helper()
		result, err := trainings.OpenDayCompetencies(ctx, pool, []uuid.UUID{day, empty, cancelled})
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	expect := func(when, want string) {
		t.Helper()
		got := resolve()
		if labelsOf(got[day]) != want {
			t.Fatalf("%s: competencies = %q, want %q", when, labelsOf(got[day]), want)
		}
		if len(got[empty]) != 0 || len(got[cancelled]) != 0 {
			t.Fatalf("%s: empty or cancelled day has competencies: %+v", when, got)
		}
	}
	// 3D printing once although Alice and Carol both qualify; ordered by sort order, then name.
	expect("initial", "3D printing,Laser cutting")

	// Bob losing the trainer right keeps the public competency.
	f.record(bob, speedy, "trained")
	expect("trainer to trained", "3D printing,Laser cutting")
	// Removing Carol keeps 3D printing because Alice covers it.
	f.exec(`DELETE FROM open_day_assignments WHERE id = $1`, carolAssignment)
	expect("assignment removed", "3D printing,Laser cutting")
	// A training mapped to another category adds it.
	f.exec(`INSERT INTO training_competencies(training_id,competency_id) VALUES($1,$2)`, h2d, f.solder)
	expect("category added", "3D printing,Electronics,Laser cutting")
	// Inactive categories and trainings do not count; their records stay.
	f.exec(`UPDATE competency_categories SET active = false WHERE id = $1`, f.solder)
	f.exec(`UPDATE trainings SET active = false WHERE id = $1`, speedy)
	expect("deactivated", "3D printing")
	assertCount(t, pool, `SELECT count(*) FROM training_records WHERE training_id = $1`, 1, speedy)
	// Not trained is the absence of a record.
	f.exec(`DELETE FROM training_records WHERE person_id = $1`, alice)
	expect("record removed", "")

	// The open-day service exposes the same result internally and publicly.
	f.record(alice, h2d, "trained")
	service, err := opendays.NewService(pool, inbox.NewEmitter(), config.Config{})
	if err != nil {
		t.Fatal(err)
	}
	reader, _ := principalWithPermissions(t, pool, "competency-reader", "open_days.read")
	internal, err := service.GetOpenDay(ctx, reader, day)
	if err != nil {
		t.Fatal(err)
	}
	if labelsOf(internal.Competencies) != "3D printing" {
		t.Fatalf("internal = %+v", internal.Competencies)
	}
	schedule, err := service.GetSchedule(ctx, reader, f.period)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range schedule.Items {
		if item.Competencies == nil || (item.ID == day) != (len(item.Competencies) == 1) {
			t.Fatalf("schedule item %s = %+v", item.ID, item.Competencies)
		}
	}
	public, err := service.ListPublic(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(public) != 3 || labelsOf(public[0].Competencies) != "3D printing" || public[1].Competencies == nil {
		t.Fatalf("public = %+v", public)
	}
	ics, err := service.PublicICS(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(ics), "DESCRIPTION:Planned support: 3D printing") ||
		strings.Count(string(ics), "DESCRIPTION:") != 1 {
		t.Fatalf("ics = %s", ics)
	}
}

func TestPublicOpenDayCompetenciesExposeNoPeopleOrTrainings(t *testing.T) {
	pool := statementPool(t)
	f := newCompetencyFixture(t, pool, "published")
	printing := f.category("3D printing", 0)
	h2d := f.training("Secret training name H2D", printing)
	trainer := insertPlainPerson(t, pool, "public-trainer@example.test")
	f.exec(`UPDATE people SET first_name = 'Trainerfirst', last_name = 'Trainerlast' WHERE id = $1`, trainer)
	f.record(trainer, h2d, "trainer")
	f.exec(`UPDATE training_records SET notes = 'Internal note text' WHERE person_id = $1`, trainer)
	day := f.day(time.Date(2026, 10, 27, 15, 0, 0, 0, time.UTC))
	f.assign(day, f.supervisors[day], trainer)
	// An unpublished period never reaches the public calendar.
	hidden := newCompetencyFixture(t, pool, "staffing")
	hiddenDay := hidden.day(time.Date(2026, 12, 1, 15, 0, 0, 0, time.UTC))
	hidden.assign(hiddenDay, hidden.supervisors[hiddenDay], trainer)

	handler, err := httpapi.NewHandler(pool, integrationConfig(t), slog.New(slog.NewJSONHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	defer server.Close()
	for _, path := range []string{"/api/v1/public/open-days", "/api/v1/public/open-days/calendar.ics"} {
		response := doJSON(t, http.DefaultClient, http.MethodGet, server.URL+path, "", "", nil)
		assertStatus(t, response, http.StatusOK)
		body := string(readResponse(t, response))
		if !strings.Contains(body, "3D printing") {
			t.Fatalf("%s lacks the competency: %s", path, body)
		}
		for _, forbidden := range []string{
			trainer.String(), h2d.String(), "Secret training", "Trainerfirst", "Trainerlast", "trainer",
			"Internal note", "trained", hiddenDay.String(), "public-trainer",
		} {
			if strings.Contains(body, forbidden) {
				t.Fatalf("%s exposes %q: %s", path, forbidden, body)
			}
		}
	}
}
