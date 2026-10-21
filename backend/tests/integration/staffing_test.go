package integration_test

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/dashboard"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/events"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/laborordnung"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/opendays"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/orders"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/people"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/roles"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/staffing"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/supervisors"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// staffingEnv wires the services the staffing features touch and builds fixtures with plain SQL.
type staffingEnv struct {
	t         *testing.T
	pool      *pgxpool.Pool
	master    authorization.Principal
	roles     *roles.Service
	people    *people.Service
	staffing  *staffing.Service
	supervise *supervisors.Service
	opendays  *opendays.Service
	events    *events.Service
	dashboard *dashboard.Service
	now       time.Time
	period    uuid.UUID
	counter   int
}

func newStaffingEnv(t *testing.T) *staffingEnv {
	t.Helper()
	pool := migratedPool(t)
	account := seedAccount(t, pool, "staffing-master", true)
	baseURL, _ := url.Parse("https://makerspace.example.test")
	cfg := config.Config{
		MakerspaceTimeZone: "Europe/Vienna",
		PublicBaseURL:      baseURL,
		ChallengeHMACKey:   []byte("staffing-limiter-key"),
	}
	staffingService, err := staffing.NewService(pool, cfg)
	if err != nil {
		t.Fatal(err)
	}
	openDaysService, err := opendays.NewService(pool, cfg)
	if err != nil {
		t.Fatal(err)
	}
	eventService, err := events.NewService(pool, cfg, nil)
	if err != nil {
		t.Fatal(err)
	}
	env := &staffingEnv{
		t:         t,
		pool:      pool,
		master:    authorization.Principal{AccountID: account.accountID, PersonID: account.personID, Master: true},
		roles:     roles.NewService(pool),
		people:    people.NewService(pool, nil),
		staffing:  staffingService,
		supervise: supervisors.NewService(pool, staffingService),
		opendays:  openDaysService,
		events:    eventService,
		now:       time.Now().UTC(),
	}
	jobs := machinelogbook.NewService(pool)
	env.dashboard = dashboard.NewService(
		pool,
		staffingService,
		openDaysService,
		eventService,
		orders.NewService(pool, jobs),
		jobs,
	)
	// One semester around today: a non-draft period containing the current date.
	env.period = env.newPeriod("Current semester", "staffing", env.now.AddDate(0, 0, -60), env.now.AddDate(0, 0, 60))
	return env
}

func (e *staffingEnv) exec(query string, args ...any) {
	e.t.Helper()
	if _, err := e.pool.Exec(testContext(e.t), query, args...); err != nil {
		e.t.Fatal(err)
	}
}

func (e *staffingEnv) newPeriod(name, status string, start, end time.Time) uuid.UUID {
	e.t.Helper()
	id := ids.New()
	e.exec(
		`INSERT INTO open_day_periods(id,name,starts_on,ends_on,status) VALUES($1,$2,$3::date,$4::date,$5)`,
		id, name, start.Format(time.DateOnly), end.Format(time.DateOnly), status,
	)
	return id
}

// role creates a role as master with the given staffing level and permissions.
func (e *staffingEnv) role(name string, level *roles.StaffingLevel, permissions ...authorization.Permission) roles.Role {
	e.t.Helper()
	grants := make([]authorization.PermissionGrant, 0, len(permissions))
	for _, permission := range permissions {
		grants = append(grants, authorization.PermissionGrant{PermissionID: permission, Scope: authorization.GrantEverywhere})
	}
	role, err := e.roles.CreateWithBehaviors(
		testContext(e.t), e.master, name, nil, grants, false, laborordnung.ModeNotRequired, level, nil,
	)
	if err != nil {
		e.t.Fatal(err)
	}
	return role
}

// person creates a person with an account holding the given roles and returns the loaded principal.
func (e *staffingEnv) person(suffix string, roleIDs ...uuid.UUID) authorization.Principal {
	e.t.Helper()
	e.counter++
	account := seedAccount(e.t, e.pool, fmt.Sprintf("%s-%d", suffix, e.counter), false)
	for _, roleID := range roleIDs {
		e.exec(`INSERT INTO person_roles(person_id,role_id) VALUES($1,$2)`, account.personID, roleID)
	}
	principal, err := authorization.LoadPermissionsFrom(
		testContext(e.t), e.pool, authorization.Principal{AccountID: account.accountID, PersonID: account.personID},
	)
	if err != nil {
		e.t.Fatal(err)
	}
	return principal
}

type openDayFixture struct {
	id, supervisorRequirement, traineeRequirement uuid.UUID
}

// openDay creates a scheduled open day of the environment's period with the given staffing needs. Eligible roles
// are attached to both requirements.
func (e *staffingEnv) openDay(
	startsAt time.Time,
	length time.Duration,
	supervisors, trainees int,
	eligible ...uuid.UUID,
) openDayFixture {
	e.t.Helper()
	fixture := openDayFixture{id: ids.New(), supervisorRequirement: ids.New(), traineeRequirement: ids.New()}
	e.exec(
		`INSERT INTO open_days(id,period_id,starts_at,ends_at) VALUES($1,$2,$3,$4)`,
		fixture.id, e.period, startsAt, startsAt.Add(length),
	)
	e.exec(
		`INSERT INTO open_day_staff_requirements(id,open_day_id,kind,required_count) VALUES($1,$2,'supervisor',$3),($4,$2,'trainee',$5)`,
		fixture.supervisorRequirement, fixture.id, supervisors, fixture.traineeRequirement, trainees,
	)
	for _, roleID := range eligible {
		e.exec(
			`INSERT INTO open_day_staff_requirement_roles(requirement_id,role_id) VALUES($1,$3),($2,$3)`,
			fixture.supervisorRequirement, fixture.traineeRequirement, roleID,
		)
	}
	return fixture
}

func (e *staffingEnv) join(day openDayFixture, requirement uuid.UUID, p authorization.Principal) {
	e.t.Helper()
	e.exec(
		`INSERT INTO open_day_assignments(id,open_day_id,requirement_id,person_id) VALUES($1,$2,$3,$4)`,
		ids.New(), day.id, requirement, p.PersonID,
	)
}

func level(value roles.StaffingLevel) *roles.StaffingLevel { return &value }

func TestRoleStaffingLevelRoundTripAndValidation(t *testing.T) {
	e := newStaffingEnv(t)
	ctx := testContext(t)
	role := e.role("Level round trip", level(roles.StaffingTrainee))
	if role.StaffingLevel == nil || *role.StaffingLevel != roles.StaffingTrainee {
		t.Fatalf("created staffing level = %v, want trainee", role.StaffingLevel)
	}
	name := "Renamed"
	renamed, err := e.roles.UpdateWithBehaviors(ctx, e.master, role.ID, role.Version, &name, false, nil, nil, nil, false, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if renamed.StaffingLevel == nil || *renamed.StaffingLevel != roles.StaffingTrainee {
		t.Fatalf("an update that omits the level changed it to %v", renamed.StaffingLevel)
	}
	promoted, err := e.roles.UpdateWithBehaviors(
		ctx, e.master, role.ID, renamed.Version, nil, false, nil, nil, nil, true, level(roles.StaffingSupervisor), nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if promoted.StaffingLevel == nil || *promoted.StaffingLevel != roles.StaffingSupervisor {
		t.Fatalf("updated staffing level = %v, want supervisor", promoted.StaffingLevel)
	}
	_, err = e.roles.UpdateWithBehaviors(
		ctx, e.master, role.ID, promoted.Version, nil, false, nil, nil, nil, true, level("lead"), nil,
	)
	expectAppCode(t, err, "validation_failed")
	cleared, err := e.roles.UpdateWithBehaviors(
		ctx, e.master, role.ID, promoted.Version, nil, false, nil, nil, nil, true, nil, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if cleared.StaffingLevel != nil {
		t.Fatalf("explicit null kept staffing level %v", *cleared.StaffingLevel)
	}
	_, err = e.roles.CreateWithBehaviors(
		ctx, e.master, "Bad level", nil, nil, false, laborordnung.ModeNotRequired, level("lead"), nil,
	)
	expectAppCode(t, err, "validation_failed")
}

func TestStaffingLevelMigrationBackfillsFromSupervisorDashboardAndRestoresIt(t *testing.T) {
	pool := emptySchemaPool(t)
	ctx := testContext(t)
	var before, target []string
	for _, path := range allMigrationFiles(t) {
		switch {
		case baseName(path) < "00058_":
			before = append(before, path)
		case baseName(path) == "00058_staffing_levels_and_requirements.sql":
			target = append(target, path)
		}
	}
	if len(target) != 1 {
		t.Fatalf("staffing migration files = %v", target)
	}
	applyMigrationFiles(t, pool, before)
	flagged, plain := ids.New(), ids.New()
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO roles(id,name,supervisor_dashboard) VALUES($1,'Flagged',true),($2,'Plain',false)`,
		flagged, plain,
	); err != nil {
		t.Fatal(err)
	}
	applyMigrationFiles(t, pool, target)
	assertCount(t, pool, `SELECT count(*) FROM roles WHERE id=$1 AND staffing_level='supervisor'`, 1, flagged)
	assertCount(t, pool, `SELECT count(*) FROM roles WHERE id=$1 AND staffing_level IS NULL`, 1, plain)
	assertCount(t, pool, `SELECT count(*) FROM open_day_requirements WHERE min_open_days_per_semester=2 AND trainee_open_days_for_promotion=3 AND supervisor_role_id IS NULL`, 1)
	if _, err := pool.Exec(ctx, `UPDATE roles SET staffing_level='lead' WHERE id=$1`, plain); err == nil {
		t.Fatal("staffing level outside the enum was accepted")
	}

	down := migrationDownSection(t, target[0])
	if _, err := pool.Exec(ctx, down); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `SELECT count(*) FROM roles WHERE id=$1 AND supervisor_dashboard`, 1, flagged)
	assertCount(t, pool, `SELECT count(*) FROM roles WHERE id=$1 AND NOT supervisor_dashboard`, 1, plain)
	assertCount(t, pool, `SELECT count(*) FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='open_day_requirements'`, 0)
	applyMigrationFiles(t, pool, target)
	assertCount(t, pool, `SELECT count(*) FROM roles WHERE id=$1 AND staffing_level='supervisor'`, 1, flagged)
}

func TestOpenDayRequirementsPermissionsVersionAndValidation(t *testing.T) {
	e := newStaffingEnv(t)
	ctx := testContext(t)
	supervisorRole := e.role("Supervisors", level(roles.StaffingSupervisor))
	traineeRole := e.role("Trainees", level(roles.StaffingTrainee))
	plainRole := e.role("Plain", nil)
	reader := e.person("req-reader", e.role("Reader", nil, authorization.OpenDaysRead).ID)
	manager := e.person("req-manager", e.role("Manager", nil, authorization.OpenDaysRead, authorization.OpenDaysManage).ID)
	nobody := e.person("req-nobody")

	if _, err := e.staffing.Requirements(ctx, nobody); err == nil {
		t.Fatal("a principal without open_days.read read the requirements")
	}
	current, err := e.staffing.Requirements(ctx, reader)
	if err != nil {
		t.Fatal(err)
	}
	if current.MinOpenDaysPerSemester != 2 || current.TraineeOpenDaysForPromotion != 3 ||
		current.SupervisorRoleID != nil || current.Version != 1 {
		t.Fatalf("default requirements = %+v", current)
	}

	input := staffing.UpdateInput{
		ExpectedVersion: current.Version, MinOpenDaysPerSemester: 3, TraineeOpenDaysForPromotion: 4,
		SupervisorRoleID: &supervisorRole.ID,
	}
	_, err = e.staffing.UpdateRequirements(ctx, reader, input, nil)
	expectAppCode(t, err, "permission_denied")
	assertCount(t, e.pool, `SELECT count(*) FROM audit_events WHERE action='open_day_requirements.updated'`, 0)

	updated, err := e.staffing.UpdateRequirements(ctx, manager, input, nil)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Version != 2 || updated.MinOpenDaysPerSemester != 3 || updated.TraineeOpenDaysForPromotion != 4 ||
		updated.SupervisorRoleID == nil || *updated.SupervisorRoleID != supervisorRole.ID {
		t.Fatalf("updated requirements = %+v", updated)
	}
	assertCount(t, e.pool, `SELECT count(*) FROM audit_events WHERE action='open_day_requirements.updated'`, 1)

	_, err = e.staffing.UpdateRequirements(ctx, manager, input, nil)
	expectAppCode(t, err, "stale_write")

	invalid := []staffing.UpdateInput{
		{ExpectedVersion: 2, MinOpenDaysPerSemester: -1, TraineeOpenDaysForPromotion: 3},
		{ExpectedVersion: 2, MinOpenDaysPerSemester: 21, TraineeOpenDaysForPromotion: 3},
		{ExpectedVersion: 2, MinOpenDaysPerSemester: 2, TraineeOpenDaysForPromotion: 0},
		{ExpectedVersion: 2, MinOpenDaysPerSemester: 2, TraineeOpenDaysForPromotion: 21},
		{ExpectedVersion: 2, MinOpenDaysPerSemester: 2, TraineeOpenDaysForPromotion: 3, SupervisorRoleID: &traineeRole.ID},
		{ExpectedVersion: 2, MinOpenDaysPerSemester: 2, TraineeOpenDaysForPromotion: 3, SupervisorRoleID: &plainRole.ID},
		{ExpectedVersion: 2, MinOpenDaysPerSemester: 2, TraineeOpenDaysForPromotion: 3, SupervisorRoleID: ptr(ids.New())},
	}
	for index, bad := range invalid {
		_, err = e.staffing.UpdateRequirements(ctx, manager, bad, nil)
		if err == nil {
			t.Fatalf("invalid input %d was accepted", index)
		}
		expectAppCode(t, err, "validation_failed")
	}
	assertCount(t, e.pool, `SELECT count(*) FROM open_day_requirements WHERE version=2 AND supervisor_role_id=$1`, 1, supervisorRole.ID)

	// A role that stops being a supervisor role can no longer be the promotion role.
	if _, err = e.roles.UpdateWithBehaviors(
		ctx, e.master, supervisorRole.ID, supervisorRole.Version, nil, false, nil, nil, nil, true, level(roles.StaffingTrainee), nil,
	); err != nil {
		t.Fatal(err)
	}
	assertCount(t, e.pool, `SELECT count(*) FROM open_day_requirements WHERE supervisor_role_id IS NULL`, 1)
	cleared, err := e.staffing.Requirements(ctx, reader)
	if err != nil {
		t.Fatal(err)
	}
	if cleared.SupervisorRoleID != nil {
		t.Fatal("the requirements still point at a role that is no longer a supervisor role")
	}
}

func TestSupervisorDashboardShowsSemesterStandingPerPerson(t *testing.T) {
	e := newStaffingEnv(t)
	ctx := testContext(t)
	supervisorRole := e.role("Supervisors", level(roles.StaffingSupervisor), authorization.OpenDaysRead)
	traineeRole := e.role("Trainees", level(roles.StaffingTrainee), authorization.OpenDaysRead)
	viewer := e.person("dashboard-viewer", e.role("Viewer", nil, authorization.SupervisorDashboardRead).ID)
	if _, err := e.supervise.Get(ctx, e.person("dashboard-denied")); err == nil {
		t.Fatal("dashboard was readable without supervisor_dashboard.read")
	}

	fulfilled := e.person("fulfilled", supervisorRole.ID)
	missing := e.person("missing", supervisorRole.ID)
	ready := e.person("ready", traineeRole.ID)
	bystander := e.person("bystander")
	hour := time.Hour
	ended1 := e.openDay(e.now.AddDate(0, 0, -20), 4*hour, 1, 1)
	ended2 := e.openDay(e.now.AddDate(0, 0, -10), 4*hour, 1, 1)
	ended3 := e.openDay(e.now.AddDate(0, 0, -5), 4*hour, 1, 1)
	upcoming := e.openDay(e.now.AddDate(0, 0, 5), 4*hour, 2, 1)
	cancelled := e.openDay(e.now.AddDate(0, 0, 6), 4*hour, 1, 0)
	e.exec(`UPDATE open_days SET status='cancelled' WHERE id=$1`, cancelled.id)
	// A past semester must not leak into the current numbers, but counts for "last open day".
	pastPeriod := e.newPeriod("Past", "published", e.now.AddDate(0, 0, -400), e.now.AddDate(0, 0, -300))
	pastDay, pastRequirement := ids.New(), ids.New()
	pastStart := e.now.AddDate(0, 0, -350)
	e.exec(`INSERT INTO open_days(id,period_id,starts_at,ends_at) VALUES($1,$2,$3,$4)`, pastDay, pastPeriod, pastStart, pastStart.Add(4*hour))
	e.exec(`INSERT INTO open_day_staff_requirements(id,open_day_id,kind,required_count) VALUES($1,$2,'supervisor',1)`, pastRequirement, pastDay)
	e.exec(`INSERT INTO open_day_assignments(id,open_day_id,requirement_id,person_id) VALUES($1,$2,$3,$4)`, ids.New(), pastDay, pastRequirement, missing.PersonID)

	// fulfilled: one ended + one booked (signing up is enough); ready: three ended as trainee;
	// missing: only the cancelled day, which must not count.
	e.join(ended1, ended1.supervisorRequirement, fulfilled)
	e.join(upcoming, upcoming.supervisorRequirement, fulfilled)
	e.join(ended1, ended1.traineeRequirement, ready)
	e.join(ended2, ended2.traineeRequirement, ready)
	e.join(ended3, ended3.traineeRequirement, ready)
	e.join(cancelled, cancelled.supervisorRequirement, missing)
	e.join(upcoming, upcoming.traineeRequirement, bystander)

	result, err := e.supervise.Get(ctx, viewer)
	if err != nil {
		t.Fatal(err)
	}
	if result.Semester == nil || result.Semester.ID != e.period {
		t.Fatalf("semester = %+v, want the current period", result.Semester)
	}
	if result.Requirements.MinOpenDaysPerSemester != 2 || result.Requirements.SupervisorRoleID != nil {
		t.Fatalf("requirements = %+v", result.Requirements)
	}
	byPerson := map[uuid.UUID]supervisors.Row{}
	for _, row := range result.Supervisors {
		byPerson[row.PersonID] = row
	}
	if len(byPerson) != 3 {
		t.Fatalf("listed %d people, want the three with a staffing level", len(byPerson))
	}
	if row := byPerson[fulfilled.PersonID]; row.Kind != roles.StaffingSupervisor || row.Counts.Staffed != 1 ||
		row.Counts.Booked != 1 || row.Standing.Status != staffing.StatusFulfilled || row.LastOpenDayAt == nil {
		t.Fatalf("fulfilled row = %+v", row)
	}
	var fulfilledVersion int64
	if err := e.pool.QueryRow(ctx, `SELECT version FROM people WHERE id=$1`, fulfilled.PersonID).Scan(&fulfilledVersion); err != nil {
		t.Fatal(err)
	}
	if byPerson[fulfilled.PersonID].PersonVersion != fulfilledVersion {
		t.Fatalf("person version = %d, want %d", byPerson[fulfilled.PersonID].PersonVersion, fulfilledVersion)
	}
	if row := byPerson[missing.PersonID]; row.Counts.Staffed != 0 || row.Counts.Booked != 0 ||
		row.Standing.Status != staffing.StatusMissing || row.Standing.Missing != 2 ||
		row.LastOpenDayAt == nil || !row.LastOpenDayAt.Equal(pastStart.Truncate(time.Microsecond)) {
		t.Fatalf("missing row = %+v", row)
	}
	if row := byPerson[ready.PersonID]; row.Kind != roles.StaffingTrainee || row.Counts.Staffed != 3 ||
		row.Counts.StaffedAsTrainee != 3 || row.Standing.Status != staffing.StatusReady {
		t.Fatalf("ready row = %+v", row)
	}
	if result.Totals.Supervisors != 3 {
		t.Fatalf("totals = %+v", result.Totals)
	}
}

func TestSupervisorKindWinsAndPromotionRequiresATrainee(t *testing.T) {
	e := newStaffingEnv(t)
	ctx := testContext(t)
	supervisorRole := e.role("Supervisors", level(roles.StaffingSupervisor), authorization.OpenDaysRead)
	traineeRole := e.role("Trainees", level(roles.StaffingTrainee), authorization.OpenDaysRead)
	both := e.person("both-levels", traineeRole.ID, supervisorRole.ID)
	kind, err := e.staffing.PersonKind(ctx, both.PersonID)
	if err != nil {
		t.Fatal(err)
	}
	if kind == nil || *kind != roles.StaffingSupervisor {
		t.Fatalf("kind = %v, want supervisor", kind)
	}
	none, err := e.staffing.PersonKind(ctx, e.person("no-level").PersonID)
	if err != nil || none != nil {
		t.Fatalf("kind of a person without staffing roles = %v (%v), want nil", none, err)
	}
}

func TestPromotionReplacesTraineeRolesWithTheConfiguredSupervisorRole(t *testing.T) {
	e := newStaffingEnv(t)
	ctx := testContext(t)
	supervisorRole := e.role("Supervisors", level(roles.StaffingSupervisor), authorization.OpenDaysRead)
	traineeRole := e.role("Trainees", level(roles.StaffingTrainee), authorization.OpenDaysRead)
	extraRole := e.role("Extra", nil, authorization.OpenDaysSignup)
	assigner := e.person("assigner", e.role("Assigner", nil, authorization.PeopleRolesAssign, authorization.OpenDaysRead, authorization.OpenDaysSignup).ID)
	denied := e.person("promotion-denied")
	trainee := e.person("trainee", traineeRole.ID, extraRole.ID)
	supervisor := e.person("supervisor", supervisorRole.ID)
	plain := e.person("plain-member", extraRole.ID)

	// Not configured yet.
	_, err := e.people.PromoteToSupervisor(ctx, assigner, trainee.PersonID, 1, nil)
	expectAppCode(t, err, "promotion_role_not_configured")
	assertCount(t, e.pool, `SELECT count(*) FROM person_roles WHERE person_id=$1 AND role_id=$2`, 1, trainee.PersonID, traineeRole.ID)

	requirements, err := e.staffing.Requirements(ctx, e.master)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = e.staffing.UpdateRequirements(ctx, e.master, staffing.UpdateInput{
		ExpectedVersion: requirements.Version, MinOpenDaysPerSemester: 2, TraineeOpenDaysForPromotion: 3,
		SupervisorRoleID: &supervisorRole.ID,
	}, nil); err != nil {
		t.Fatal(err)
	}

	_, err = e.people.PromoteToSupervisor(ctx, denied, trainee.PersonID, 1, nil)
	expectAppCode(t, err, "permission_denied")
	_, err = e.people.PromoteToSupervisor(ctx, assigner, supervisor.PersonID, 1, nil)
	expectAppCode(t, err, "not_a_trainee")
	_, err = e.people.PromoteToSupervisor(ctx, assigner, plain.PersonID, 1, nil)
	expectAppCode(t, err, "not_a_trainee")
	_, err = e.people.PromoteToSupervisor(ctx, assigner, trainee.PersonID, 7, nil)
	expectAppCode(t, err, "stale_write")
	assertCount(t, e.pool, `SELECT count(*) FROM audit_events WHERE action='person.promoted_to_supervisor'`, 0)

	// Privilege subset: the supervisor role carries open_days.read, which this actor lacks.
	limited := e.person("limited-assigner", e.role("Limited assigner", nil, authorization.PeopleRolesAssign).ID)
	_, err = e.people.PromoteToSupervisor(ctx, limited, trainee.PersonID, 1, nil)
	expectAppCode(t, err, "permission_denied")
	assertCount(t, e.pool, `SELECT count(*) FROM person_roles WHERE person_id=$1 AND role_id=$2`, 1, trainee.PersonID, traineeRole.ID)

	promoted, err := e.people.PromoteToSupervisor(ctx, assigner, trainee.PersonID, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	if promoted.Version != 2 {
		t.Fatalf("promoted version = %d, want 2", promoted.Version)
	}
	assertCount(t, e.pool, `SELECT count(*) FROM person_roles WHERE person_id=$1 AND role_id=$2`, 0, trainee.PersonID, traineeRole.ID)
	assertCount(t, e.pool, `SELECT count(*) FROM person_roles WHERE person_id=$1 AND role_id=$2`, 1, trainee.PersonID, supervisorRole.ID)
	assertCount(t, e.pool, `SELECT count(*) FROM person_roles WHERE person_id=$1 AND role_id=$2`, 1, trainee.PersonID, extraRole.ID)
	assertCount(t, e.pool, `SELECT count(*) FROM audit_events WHERE action='person.promoted_to_supervisor' AND resource_id=$1`, 1, trainee.PersonID)
	// Promoting again fails: the person is a supervisor now.
	_, err = e.people.PromoteToSupervisor(ctx, assigner, trainee.PersonID, 2, nil)
	expectAppCode(t, err, "not_a_trainee")
}

func allMigrationFiles(t *testing.T) []string {
	t.Helper()
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate integration test source")
	}
	paths, err := filepath.Glob(filepath.Join(filepath.Dir(filename), "..", "..", "migrations", "*.sql"))
	if err != nil || len(paths) == 0 {
		t.Fatalf("locate migrations: %v", err)
	}
	sort.Strings(paths)
	return paths
}

func baseName(path string) string { return filepath.Base(path) }

func migrationDownSection(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	_, down, found := strings.Cut(string(raw), "-- +goose Down")
	if !found {
		t.Fatalf("migration %s has no Down section", baseName(path))
	}
	return down
}
