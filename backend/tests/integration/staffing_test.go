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
	"github.com/Basmatireis/Makerspace-Core/backend/internal/inbox"
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
	openDaysService, err := opendays.NewService(pool, inbox.NewEmitter(), cfg)
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
	jobs := machinelogbook.NewService(pool, inbox.NewEmitter())
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

// role creates an extra role as master with the given permissions. With a membership it returns that membership
// role instead, after adding the permissions to it.
func (e *staffingEnv) role(name string, membership *roles.Membership, permissions ...authorization.Permission) roles.Role {
	e.t.Helper()
	ctx := testContext(e.t)
	grants := make([]authorization.PermissionGrant, 0, len(permissions))
	for _, permission := range permissions {
		grants = append(grants, authorization.PermissionGrant{PermissionID: permission, Scope: authorization.GrantEverywhere})
	}
	if membership != nil {
		role := e.membershipRole(*membership)
		have := map[authorization.Permission]bool{}
		for _, grant := range role.PermissionGrants {
			have[grant.PermissionID] = true
		}
		merged := append([]authorization.PermissionGrant(nil), role.PermissionGrants...)
		for _, grant := range grants {
			if !have[grant.PermissionID] {
				merged = append(merged, grant)
			}
		}
		if len(merged) == len(role.PermissionGrants) {
			return role
		}
		for index := range merged {
			merged[index].ID = uuid.Nil
		}
		updated, err := e.roles.ReplacePermissions(ctx, e.master, role.ID, role.Version, merged, nil)
		if err != nil {
			e.t.Fatal(err)
		}
		return updated
	}
	role, err := e.roles.CreateWithBehaviors(ctx, e.master, name, nil, grants, false, laborordnung.ModeNotRequired, nil)
	if err != nil {
		e.t.Fatal(err)
	}
	return role
}

// membershipRole loads the membership system role.
func (e *staffingEnv) membershipRole(membership roles.Membership) roles.Role {
	e.t.Helper()
	var id uuid.UUID
	if err := e.pool.QueryRow(testContext(e.t), `SELECT id FROM roles WHERE system_key=$1`, string(membership)).Scan(&id); err != nil {
		e.t.Fatal(err)
	}
	role, err := e.roles.Get(testContext(e.t), e.master, id)
	if err != nil {
		e.t.Fatal(err)
	}
	return role
}

// person creates a person with an account holding the given roles and returns the loaded principal. A membership
// role replaces the Visitor membership every new person starts with.
func (e *staffingEnv) person(suffix string, roleIDs ...uuid.UUID) authorization.Principal {
	e.t.Helper()
	e.counter++
	account := seedAccount(e.t, e.pool, fmt.Sprintf("%s-%d", suffix, e.counter), false)
	for _, roleID := range roleIDs {
		e.exec(`WITH replaced AS (
			DELETE FROM person_roles pr USING roles r, roles added
			WHERE pr.person_id=$1 AND r.id=pr.role_id AND added.id=$2 AND r.id<>added.id
			  AND r.system_key IN ('supervisor','trainee','visitor') AND added.system_key IN ('supervisor','trainee','visitor')
		)
		INSERT INTO person_roles(person_id,role_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, account.personID, roleID)
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

func level(value roles.Membership) *roles.Membership { return &value }

func defaultRulesInput(version int64) staffing.UpdateInput {
	return staffing.UpdateInput{
		ExpectedVersion: version, SupervisorMinimum: 2, TraineeMinimum: 2, TraineeReadyAfter: 3, WarningWindowDays: 14,
		CountBy: staffing.CountByTimeslot, DefaultDeadline: staffing.DeadlinePeriodEnd,
	}
}

func TestStaffingRulesPermissionsVersionExceptionsAndValidation(t *testing.T) {
	e := newStaffingEnv(t)
	ctx := testContext(t)
	board := e.role("Board", nil)
	reader := e.person("rules-reader", e.role("Reader", nil, authorization.SupervisorDashboardRead).ID)
	manager := e.person("rules-manager", e.role("Manager", nil, authorization.OpenDaysManage).ID)
	openDaysReader := e.person("rules-open-days", e.role("Open days", nil, authorization.OpenDaysRead).ID)

	if _, err := e.staffing.Rules(ctx, openDaysReader); err == nil {
		t.Fatal("open_days.read alone read the staffing rules")
	}
	current, err := e.staffing.Rules(ctx, reader)
	if err != nil {
		t.Fatal(err)
	}
	if current.SupervisorMinimum != 2 || current.TraineeMinimum != 2 || current.TraineeReadyAfter != 3 ||
		current.WarningWindowDays != 14 || current.CountBy != staffing.CountByTimeslot ||
		current.DefaultDeadline != staffing.DeadlinePeriodEnd || len(current.Exceptions) != 0 || current.Version != 1 {
		t.Fatalf("default rules = %+v", current)
	}
	if _, err := e.staffing.Rules(ctx, manager); err != nil {
		t.Fatalf("open_days.manage cannot read the rules: %v", err)
	}

	input := defaultRulesInput(current.Version)
	input.SupervisorMinimum, input.TraineeMinimum, input.WarningWindowDays = 3, 1, 21
	input.DefaultDeadline = staffing.DeadlineTwoWeeksBeforeEnd
	input.Exceptions = []staffing.ExceptionInput{{RoleID: board.ID, Minimum: 0}}
	_, err = e.staffing.UpdateRules(ctx, reader, input, nil)
	expectAppCode(t, err, "permission_denied")
	assertCount(t, e.pool, `SELECT count(*) FROM audit_events WHERE action='staffing_rules.updated'`, 0)

	updated, err := e.staffing.UpdateRules(ctx, manager, input, nil)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Version != 2 || updated.SupervisorMinimum != 3 || updated.TraineeMinimum != 1 ||
		len(updated.Exceptions) != 1 || updated.Exceptions[0].RoleName != "Board" || updated.Exceptions[0].Minimum != 0 {
		t.Fatalf("updated rules = %+v", updated)
	}
	assertCount(t, e.pool, `SELECT count(*) FROM audit_events WHERE action='staffing_rules.updated'
		AND changed_fields @> ARRAY['supervisorMinimum','exceptions']`, 1)

	_, err = e.staffing.UpdateRules(ctx, manager, input, nil)
	expectAppCode(t, err, "stale_write")

	supervisorRole := e.membershipRole(roles.MembershipSupervisor)
	invalid := []func(*staffing.UpdateInput){
		func(in *staffing.UpdateInput) { in.SupervisorMinimum = -1 },
		func(in *staffing.UpdateInput) { in.TraineeMinimum = 21 },
		func(in *staffing.UpdateInput) { in.TraineeReadyAfter = 0 },
		func(in *staffing.UpdateInput) { in.WarningWindowDays = 61 },
		func(in *staffing.UpdateInput) { in.CountBy = "week" },
		func(in *staffing.UpdateInput) { in.DefaultDeadline = "never" },
		func(in *staffing.UpdateInput) {
			in.Exceptions = []staffing.ExceptionInput{{RoleID: board.ID, Minimum: 21}}
		},
		func(in *staffing.UpdateInput) {
			in.Exceptions = []staffing.ExceptionInput{{RoleID: board.ID, Minimum: 1}, {RoleID: board.ID, Minimum: 2}}
		},
		func(in *staffing.UpdateInput) { in.Exceptions = []staffing.ExceptionInput{{RoleID: supervisorRole.ID}} },
		func(in *staffing.UpdateInput) { in.Exceptions = []staffing.ExceptionInput{{RoleID: ids.New()}} },
	}
	for index, mutate := range invalid {
		bad := defaultRulesInput(2)
		mutate(&bad)
		_, err = e.staffing.UpdateRules(ctx, manager, bad, nil)
		expectAppCode(t, err, "validation_failed")
		if err == nil {
			t.Fatalf("invalid input %d was accepted", index)
		}
	}
	if _, err := e.pool.Exec(ctx, `INSERT INTO staffing_rule_exceptions(role_id,minimum) VALUES($1,1)`, supervisorRole.ID); err == nil {
		t.Fatal("the database accepted an exception for a membership role")
	}
	assertCount(t, e.pool, `SELECT count(*) FROM staffing_rules WHERE version=2 AND supervisor_minimum=3`, 1)
}

func TestSupervisorDashboardShowsSemesterStandingPerPerson(t *testing.T) {
	e := newStaffingEnv(t)
	ctx := testContext(t)
	supervisorRole := e.role("", level(roles.MembershipSupervisor), authorization.OpenDaysRead)
	traineeRole := e.role("", level(roles.MembershipTrainee), authorization.OpenDaysRead)
	board := e.role("Board", nil)
	viewer := e.person("dashboard-viewer", e.role("Viewer", nil, authorization.SupervisorDashboardRead).ID)
	leitung := e.person("dashboard-leitung",
		e.role("Leitung", nil, authorization.SupervisorDashboardRead, authorization.OpenDaysManage).ID)
	if _, err := e.supervise.Get(ctx, e.person("dashboard-denied"), nil); err == nil {
		t.Fatal("dashboard was readable without supervisor_dashboard.read")
	}

	fulfilled := e.person("fulfilled", supervisorRole.ID)
	missing := e.person("missing", supervisorRole.ID)
	ready := e.person("ready", traineeRole.ID)
	exempt := e.person("exempt", supervisorRole.ID, board.ID)
	excused := e.person("excused", supervisorRole.ID)
	visitor := e.person("visitor")
	rules, err := e.staffing.Rules(ctx, e.master)
	if err != nil {
		t.Fatal(err)
	}
	withException := defaultRulesInput(rules.Version)
	withException.Exceptions = []staffing.ExceptionInput{{RoleID: board.ID, Minimum: 0}}
	if _, err := e.staffing.UpdateRules(ctx, e.master, withException, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := e.staffing.SetExcusal(ctx, e.master, e.period, excused.PersonID, "  Semester abroad  ", nil); err != nil {
		t.Fatal(err)
	}

	hour := time.Hour
	ended1 := e.openDay(e.now.AddDate(0, 0, -20), 4*hour, 1, 1)
	ended2 := e.openDay(e.now.AddDate(0, 0, -10), 4*hour, 1, 1)
	ended3 := e.openDay(e.now.AddDate(0, 0, -5), 4*hour, 1, 1)
	upcoming := e.openDay(e.now.AddDate(0, 0, 5), 4*hour, 2, 1)
	cancelled := e.openDay(e.now.AddDate(0, 0, 6), 4*hour, 1, 0)
	e.exec(`UPDATE open_days SET status='cancelled' WHERE id=$1`, cancelled.id)
	pastPeriod := e.newPeriod("Past", "published", e.now.AddDate(0, 0, -400), e.now.AddDate(0, 0, -300))
	pastDay, pastRequirement := ids.New(), ids.New()
	pastStart := e.now.AddDate(0, 0, -350)
	e.exec(`INSERT INTO open_days(id,period_id,starts_at,ends_at) VALUES($1,$2,$3,$4)`, pastDay, pastPeriod, pastStart, pastStart.Add(4*hour))
	e.exec(`INSERT INTO open_day_staff_requirements(id,open_day_id,kind,required_count) VALUES($1,$2,'supervisor',1)`, pastRequirement, pastDay)
	e.exec(`INSERT INTO open_day_assignments(id,open_day_id,requirement_id,person_id) VALUES($1,$2,$3,$4)`, ids.New(), pastDay, pastRequirement, missing.PersonID)

	e.join(ended1, ended1.supervisorRequirement, fulfilled)
	e.join(upcoming, upcoming.supervisorRequirement, fulfilled)
	e.join(ended1, ended1.traineeRequirement, ready)
	e.join(ended2, ended2.traineeRequirement, ready)
	e.join(ended3, ended3.traineeRequirement, ready)
	e.join(cancelled, cancelled.supervisorRequirement, missing)

	result, err := e.supervise.Get(ctx, viewer, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.Semester == nil || result.Semester.ID != e.period || result.Rules.SupervisorMinimum != 2 {
		t.Fatalf("semester = %+v, rules = %+v", result.Semester, result.Rules)
	}
	byPerson := map[uuid.UUID]supervisors.Row{}
	for _, row := range result.Supervisors {
		byPerson[row.PersonID] = row
	}
	if len(byPerson) != 5 {
		t.Fatalf("listed %d people, want the five supervisors and trainees", len(byPerson))
	}
	if _, listed := byPerson[visitor.PersonID]; listed {
		t.Fatal("a visitor is listed")
	}
	if row := byPerson[fulfilled.PersonID]; row.Membership != roles.MembershipSupervisor || row.Counts.Staffed != 1 ||
		row.Counts.Booked != 1 || row.Standing.Status != staffing.StatusFulfilled || row.LastOpenDayAt == nil ||
		row.NextAssignment == nil || row.NextAssignment.OpenDayID != upcoming.id || row.Minimum.Source != staffing.SourceMembership {
		t.Fatalf("fulfilled row = %+v", row)
	}
	if row := byPerson[missing.PersonID]; row.Standing.Status != staffing.StatusMissing || row.Standing.Missing != 2 ||
		row.LastOpenDayAt == nil || !row.LastOpenDayAt.Equal(pastStart.Truncate(time.Microsecond)) || row.NextAssignment != nil {
		t.Fatalf("missing row = %+v", row)
	}
	if row := byPerson[ready.PersonID]; row.Membership != roles.MembershipTrainee || row.Counts.StaffedAsTrainee != 3 ||
		row.Standing.Status != staffing.StatusReady {
		t.Fatalf("ready row = %+v", row)
	}
	if row := byPerson[exempt.PersonID]; row.Minimum.Value != 0 || row.Minimum.Source != staffing.SourceException ||
		row.Minimum.ExceptionRole == nil || *row.Minimum.ExceptionRole != "Board" ||
		row.Standing.Status != staffing.StatusNoMinimum || len(row.ExtraRoles) != 1 || row.ExtraRoles[0] != "Board" {
		t.Fatalf("exempt row = %+v", row)
	}
	if row := byPerson[excused.PersonID]; row.Excusal == nil || row.Excusal.Reason != "Semester abroad" ||
		row.Minimum.Source != staffing.SourceExcused || row.Standing.Status != staffing.StatusExcused {
		t.Fatalf("excused row = %+v", row)
	}

	// The excusal belongs to its period: the past semester evaluates the person normally.
	past, err := e.supervise.Get(ctx, viewer, &pastPeriod)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range past.Supervisors {
		if row.PersonID == excused.PersonID && row.Excusal != nil {
			t.Fatal("an excusal leaked into another period")
		}
		if row.PersonID == missing.PersonID && row.Counts.Staffed != 1 {
			t.Fatalf("past period counts = %+v", row.Counts)
		}
	}
	draft := e.newPeriod("Draft", "draft", e.now.AddDate(0, 0, 100), e.now.AddDate(0, 0, 200))
	_, err = e.supervise.Get(ctx, viewer, &draft)
	expectAppCode(t, err, "not_found")
	if _, err := e.supervise.Get(ctx, leitung, &draft); err != nil {
		t.Fatalf("open_days.manage cannot evaluate a draft period: %v", err)
	}
}

func TestStaffingExcusalsNeedOpenDaysManageAndAreAuditedWithoutReason(t *testing.T) {
	e := newStaffingEnv(t)
	ctx := testContext(t)
	supervisor := e.person("excusal-subject", e.role("", level(roles.MembershipSupervisor)).ID)
	reader := e.person("excusal-reader", e.role("Reader", nil, authorization.SupervisorDashboardRead).ID)
	manager := e.person("excusal-manager", e.role("Manager", nil, authorization.OpenDaysManage).ID)

	_, err := e.staffing.SetExcusal(ctx, reader, e.period, supervisor.PersonID, "private reason", nil)
	expectAppCode(t, err, "permission_denied")
	_, err = e.staffing.SetExcusal(ctx, manager, e.period, supervisor.PersonID, strings.Repeat("x", 501), nil)
	expectAppCode(t, err, "validation_failed")
	_, err = e.staffing.SetExcusal(ctx, manager, ids.New(), supervisor.PersonID, "", nil)
	expectAppCode(t, err, "not_found")
	_, err = e.staffing.SetExcusal(ctx, manager, e.period, ids.New(), "", nil)
	expectAppCode(t, err, "not_found")

	if _, err := e.staffing.SetExcusal(ctx, manager, e.period, supervisor.PersonID, "private reason", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := e.staffing.SetExcusal(ctx, manager, e.period, supervisor.PersonID, "changed reason", nil); err != nil {
		t.Fatal(err)
	}
	assertCount(t, e.pool, `SELECT count(*) FROM staffing_excusals WHERE person_id=$1 AND reason='changed reason'`, 1, supervisor.PersonID)
	assertCount(t, e.pool, `SELECT count(*) FROM audit_events WHERE action='staffing_excusal.saved' AND resource_id=$1`, 2, supervisor.PersonID)
	assertCount(t, e.pool, `SELECT count(*) FROM audit_events WHERE metadata::text LIKE '%reason%'`, 0)

	expectAppCode(t, e.staffing.RemoveExcusal(ctx, reader, e.period, supervisor.PersonID, nil), "permission_denied")
	if err := e.staffing.RemoveExcusal(ctx, manager, e.period, supervisor.PersonID, nil); err != nil {
		t.Fatal(err)
	}
	expectAppCode(t, e.staffing.RemoveExcusal(ctx, manager, e.period, supervisor.PersonID, nil), "not_found")
	assertCount(t, e.pool, `SELECT count(*) FROM audit_events WHERE action='staffing_excusal.removed'`, 1)

	// Excusals go with their period and their person.
	if _, err := e.staffing.SetExcusal(ctx, manager, e.period, supervisor.PersonID, "", nil); err != nil {
		t.Fatal(err)
	}
	e.exec(`DELETE FROM open_day_periods WHERE id=$1`, e.period)
	assertCount(t, e.pool, `SELECT count(*) FROM staffing_excusals`, 0)
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
