package integration_test

import (
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/laborordnung"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/people"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/roles"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

const hourDuration = time.Hour

func membershipOf(t *testing.T, e *staffingEnv, personID uuid.UUID) string {
	t.Helper()
	var key string
	if err := e.pool.QueryRow(testContext(t), `SELECT r.system_key FROM person_roles pr JOIN roles r ON r.id=pr.role_id
		WHERE pr.person_id=$1 AND r.system_key IN ('supervisor','trainee','visitor')`, personID).Scan(&key); err != nil {
		t.Fatal(err)
	}
	return key
}

func TestEveryPersonHoldsExactlyOneMembership(t *testing.T) {
	e := newStaffingEnv(t)
	ctx := testContext(t)
	person := e.person("new-person")
	if got := membershipOf(t, e, person.PersonID); got != "visitor" {
		t.Fatalf("a new person's membership = %s, want visitor", got)
	}
	supervisorRole := e.membershipRole(roles.MembershipSupervisor)
	visitorRole := e.membershipRole(roles.MembershipVisitor)
	// A second membership fails at commit; so does removing the only one.
	if _, err := e.pool.Exec(ctx, `INSERT INTO person_roles(person_id,role_id) VALUES($1,$2)`, person.PersonID, supervisorRole.ID); err == nil {
		t.Fatal("a second membership role was accepted")
	}
	if _, err := e.pool.Exec(ctx, `DELETE FROM person_roles WHERE person_id=$1 AND role_id=$2`, person.PersonID, visitorRole.ID); err == nil {
		t.Fatal("removing the only membership role was accepted")
	}
	// Inside one transaction the switch may pass through zero or two memberships.
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO person_roles(person_id,role_id) VALUES($1,$2)`, person.PersonID, supervisorRole.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM person_roles WHERE person_id=$1 AND role_id=$2`, person.PersonID, visitorRole.ID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	// Deleting a person removes their membership without tripping the check.
	e.exec(`DELETE FROM accounts WHERE person_id=$1`, person.PersonID)
	e.exec(`DELETE FROM people WHERE id=$1`, person.PersonID)
	// The helper keeps the highest membership after roles were united.
	other := e.person("normalized")
	tx, err = e.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO person_roles(person_id,role_id) VALUES($1,$2)`, other.PersonID, supervisorRole.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `SELECT normalize_person_membership($1)`, other.PersonID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if got := membershipOf(t, e, other.PersonID); got != "supervisor" {
		t.Fatalf("normalized membership = %s, want supervisor", got)
	}
}

func TestMembershipRolesCannotBeRenamedOrDeletedButStayEditable(t *testing.T) {
	e := newStaffingEnv(t)
	ctx := testContext(t)
	trainee := e.membershipRole(roles.MembershipTrainee)
	name := "Apprentice"
	_, err := e.roles.Update(ctx, e.master, trainee.ID, trainee.Version, &name, false, nil, nil)
	expectAppCode(t, err, "membership_role_protected")
	expectAppCode(t, e.roles.Delete(ctx, e.master, trainee.ID, trainee.Version, nil), "membership_role_protected")
	same := "Trainee"
	updated, err := e.roles.UpdateWithBehaviors(ctx, e.master, trainee.ID, trainee.Version, &same, true,
		ptr("New supervisors"), ptr(true), ptr(laborordnung.ModeWarning), nil)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Description == nil || !updated.ProfileImageRequired || updated.SystemKey == nil {
		t.Fatalf("updated membership role = %+v", updated)
	}
	if _, err := e.roles.ReplacePermissions(ctx, e.master, trainee.ID, updated.Version, []authorization.PermissionGrant{
		{PermissionID: authorization.OpenDaysRead, Scope: authorization.GrantEverywhere},
	}, nil); err != nil {
		t.Fatalf("membership permissions are not editable: %v", err)
	}
	if _, err := e.pool.Exec(ctx, `UPDATE roles SET name='Lehrling' WHERE id=$1`, trainee.ID); err == nil {
		t.Fatal("the database renamed a membership role")
	}
	if _, err := e.pool.Exec(ctx, `DELETE FROM roles WHERE id=$1`, trainee.ID); err == nil {
		t.Fatal("the database deleted a membership role")
	}
	if _, err := e.pool.Exec(ctx, `UPDATE roles SET system_key=NULL WHERE id=$1`, trainee.ID); err == nil {
		t.Fatal("the database cleared a membership role's key")
	}
	master := e.pool.QueryRow(ctx, `SELECT id FROM roles WHERE system_key='master'`)
	var masterID uuid.UUID
	if err := master.Scan(&masterID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.pool.Exec(ctx, `UPDATE roles SET description='x' WHERE id=$1`, masterID); err == nil {
		t.Fatal("the database changed the master role")
	}
}

func TestChangeMembershipAuthorizationAndEffects(t *testing.T) {
	e := newStaffingEnv(t)
	ctx := testContext(t)
	supervisorRole := e.role("", level(roles.MembershipSupervisor), authorization.OpenDaysRead, authorization.OpenDaysSignup)
	e.role("", level(roles.MembershipTrainee), authorization.OpenDaysRead)
	assigner := e.person("membership-assigner", e.role("Assigner", nil, authorization.PeopleRolesAssign,
		authorization.OpenDaysRead, authorization.OpenDaysSignup).ID)
	limited := e.person("membership-limited", e.role("Limited", nil, authorization.PeopleRolesAssign).ID)
	denied := e.person("membership-denied")
	subject := e.person("membership-subject")

	_, err := e.people.ChangeMembership(ctx, denied, subject.PersonID, roles.MembershipTrainee, 1, nil)
	expectAppCode(t, err, "permission_denied")
	// Privilege subset: the Trainee role carries open_days.read, which this actor lacks.
	_, err = e.people.ChangeMembership(ctx, limited, subject.PersonID, roles.MembershipTrainee, 1, nil)
	expectAppCode(t, err, "permission_denied")
	_, err = e.people.ChangeMembership(ctx, assigner, subject.PersonID, "lead", 1, nil)
	expectAppCode(t, err, "validation_failed")
	_, err = e.people.ChangeMembership(ctx, assigner, subject.PersonID, roles.MembershipTrainee, 9, nil)
	expectAppCode(t, err, "stale_write")
	assertCount(t, e.pool, `SELECT count(*) FROM audit_events WHERE action='person.membership_changed'`, 0)

	changed, err := e.people.ChangeMembership(ctx, assigner, subject.PersonID, roles.MembershipTrainee, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	if changed.Version != 2 || membershipOf(t, e, subject.PersonID) != "trainee" {
		t.Fatalf("changed person = %+v", changed)
	}
	assertCount(t, e.pool, `SELECT count(*) FROM audit_events WHERE action='person.membership_changed' AND resource_id=$1
		AND metadata->>'fromMembership'='visitor' AND metadata->>'toMembership'='trainee'`, 1, subject.PersonID)

	// Assigning a membership role through the generic endpoint switches the membership.
	promoted, err := e.people.ChangeRole(ctx, assigner, subject.PersonID, supervisorRole.ID, changed.Version, true, nil)
	if err != nil {
		t.Fatal(err)
	}
	if membershipOf(t, e, subject.PersonID) != "supervisor" {
		t.Fatal("assigning the Supervisor role did not switch the membership")
	}
	// Removing a membership role on its own is refused.
	_, err = e.people.ChangeRole(ctx, assigner, subject.PersonID, supervisorRole.ID, promoted.Version, false, nil)
	expectAppCode(t, err, "membership_required")

	// Becoming a visitor frees upcoming open days but keeps the ended ones.
	past := e.openDay(e.now.AddDate(0, 0, -3), 4*hourDuration, 1, 0)
	future := e.openDay(e.now.AddDate(0, 0, 3), 4*hourDuration, 1, 0)
	e.join(past, past.supervisorRequirement, subject)
	e.join(future, future.supervisorRequirement, subject)
	if _, err := e.people.ChangeMembership(ctx, e.master, subject.PersonID, roles.MembershipVisitor, promoted.Version, nil); err != nil {
		t.Fatal(err)
	}
	assertCount(t, e.pool, `SELECT count(*) FROM open_day_assignments WHERE person_id=$1 AND open_day_id=$2`, 0, subject.PersonID, future.id)
	assertCount(t, e.pool, `SELECT count(*) FROM open_day_assignments WHERE person_id=$1 AND open_day_id=$2`, 1, subject.PersonID, past.id)
}

func TestOpenDayEligibilityFollowsMembershipAndRoleRestriction(t *testing.T) {
	e := newStaffingEnv(t)
	ctx := testContext(t)
	supervisorRole := e.role("", level(roles.MembershipSupervisor), authorization.OpenDaysRead, authorization.OpenDaysSignup)
	trainee := e.person("eligibility-trainee", e.role("", level(roles.MembershipTrainee), authorization.OpenDaysRead,
		authorization.OpenDaysSignup).ID)
	keyHolder := e.role("Key holder", nil)
	supervisor := e.person("eligibility-supervisor", supervisorRole.ID)
	restrictedSupervisor := e.person("eligibility-key", supervisorRole.ID, keyHolder.ID)
	open := e.openDay(e.now.AddDate(0, 0, 4), 4*hourDuration, 2, 1)
	restricted := e.openDay(e.now.AddDate(0, 0, 8), 4*hourDuration, 2, 1, keyHolder.ID)

	if _, err := e.opendays.Join(ctx, trainee, open.id, open.supervisorRequirement, nil); err == nil {
		t.Fatal("a trainee joined a supervisor place")
	}
	if _, err := e.opendays.Join(ctx, supervisor, open.id, open.supervisorRequirement, nil); err != nil {
		t.Fatalf("a supervisor cannot join an unrestricted supervisor place: %v", err)
	}
	if _, err := e.opendays.Join(ctx, supervisor, restricted.id, restricted.supervisorRequirement, nil); err == nil {
		t.Fatal("a supervisor without the restricting role joined")
	}
	if _, err := e.opendays.Join(ctx, restrictedSupervisor, restricted.id, restricted.supervisorRequirement, nil); err != nil {
		t.Fatalf("a supervisor with the restricting role cannot join: %v", err)
	}
}

func TestPeopleMergeKeepsTheHighestMembership(t *testing.T) {
	e := newStaffingEnv(t)
	ctx := testContext(t)
	actor, _ := principalWithPermissions(t, e.pool, "membership-merge-actor", mergePermissions...)
	target := insertPlainPerson(t, e.pool, "membership-merge-target@example.test")
	source := e.person("membership-merge-source", e.membershipRole(roles.MembershipTrainee).ID)
	period := e.period
	e.exec(`INSERT INTO staffing_excusals(period_id,person_id,reason) VALUES($1,$2,'source')`, period, source.PersonID)
	service := people.NewService(e.pool, nil)
	result, err := service.Merge(ctx, actor, people.MergeInput{
		MergeSelection:   people.MergeSelection{TargetPersonID: target, SourcePersonIDs: []uuid.UUID{source.PersonID}},
		ExpectedVersions: mergeVersions(t, e.pool, target, source.PersonID),
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := membershipOf(t, e, result.Person.ID); got != "trainee" {
		t.Fatalf("merged membership = %s, want trainee", got)
	}
	assertCount(t, e.pool, `SELECT count(*) FROM staffing_excusals WHERE person_id=$1 AND reason='source'`, 1, target)
}

// Migration 00109 chooses the membership roles from the staffing data, gives every person one membership and turns
// role minimums of remaining extra roles into exceptions; its Down restores the staffing levels.
func TestMembershipMigrationMapsRolesPeopleAndRules(t *testing.T) {
	pool := emptySchemaPool(t)
	ctx := testContext(t)
	var before, target []string
	for _, path := range allMigrationFiles(t) {
		switch {
		case baseName(path) < "00109_":
			before = append(before, path)
		case baseName(path) == "00109_membership_roles_and_staffing_rules.sql":
			target = append(target, path)
		}
	}
	if len(target) != 1 {
		t.Fatalf("membership migration files = %v", target)
	}
	applyMigrationFiles(t, pool, before)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, query, args...); err != nil {
			t.Fatalf("%v\n%s", err, query)
		}
	}
	betreuer, leads, lehrling, guests, board, clash := ids.New(), ids.New(), ids.New(), ids.New(), ids.New(), ids.New()
	exec(`INSERT INTO roles(id,name,staffing_level,min_open_days_per_semester) VALUES
		($1,'Betreuer','supervisor',NULL),($2,'Leads','supervisor',1),($3,'Lehrling','trainee',3),
		($4,'Gäste',NULL,NULL),($5,'Vorstand','trainee',0),($6,'visitor',NULL,NULL)`,
		betreuer, leads, lehrling, guests, board, clash)
	exec(`UPDATE open_day_requirements SET supervisor_role_id=$1, min_open_days_per_semester=2`, betreuer)
	exec(`UPDATE visitor_enrollment_configuration SET initial_role_id=$1`, guests)
	person := func(roleIDs ...uuid.UUID) uuid.UUID {
		id := ids.New()
		exec(`INSERT INTO people(id,first_name,last_name,email) VALUES($1,'A','B',$2)`, id, id.String()+"@example.test")
		for _, roleID := range roleIDs {
			exec(`INSERT INTO person_roles(person_id,role_id) VALUES($1,$2)`, id, roleID)
		}
		return id
	}
	lead := person(leads)
	apprentice := person(lehrling, guests)
	boardMember := person(board)
	nobody := person()
	day, requirement := ids.New(), ids.New()
	periodID := ids.New()
	exec(`INSERT INTO open_day_periods(id,name,starts_on,ends_on,status) VALUES($1,'P','2026-01-01','2026-02-01','staffing')`, periodID)
	exec(`INSERT INTO open_days(id,period_id,starts_at,ends_at) VALUES($1,$2,'2026-01-10T10:00:00Z','2026-01-10T14:00:00Z')`, day, periodID)
	exec(`INSERT INTO open_day_staff_requirements(id,open_day_id,kind,required_count) VALUES($1,$2,'supervisor',1)`, requirement, day)
	exec(`INSERT INTO open_day_staff_requirement_roles(requirement_id,role_id) VALUES($1,$2),($1,$3)`, requirement, betreuer, leads)

	applyMigrationFiles(t, pool, target)
	assertCount(t, pool, `SELECT count(*) FROM roles WHERE id=$1 AND system_key='supervisor' AND name='Supervisor'`, 1, betreuer)
	assertCount(t, pool, `SELECT count(*) FROM roles WHERE id=$1 AND system_key='visitor' AND name='Visitor'`, 1, guests)
	assertCount(t, pool, `SELECT count(*) FROM roles WHERE id=$1 AND name='Visitor (custom)' AND system_key IS NULL`, 1, clash)
	// Two trainee-level roles: a new Trainee role is created.
	assertCount(t, pool, `SELECT count(*) FROM roles WHERE system_key='trainee' AND name='Trainee' AND id NOT IN ($1,$2)`, 1, lehrling, board)
	membership := func(personID uuid.UUID, key string) {
		t.Helper()
		assertCount(t, pool, `SELECT count(*) FROM person_roles pr JOIN roles r ON r.id=pr.role_id
			WHERE pr.person_id=$1 AND r.system_key IN ('supervisor','trainee','visitor')`, 1, personID)
		assertCount(t, pool, `SELECT count(*) FROM person_roles pr JOIN roles r ON r.id=pr.role_id
			WHERE pr.person_id=$1 AND r.system_key=$2`, 1, personID, key)
	}
	membership(lead, "supervisor")
	membership(apprentice, "trainee")
	membership(boardMember, "trainee")
	membership(nobody, "visitor")
	assertCount(t, pool, `SELECT count(*) FROM person_roles WHERE person_id=$1 AND role_id=$2`, 1, lead, leads)
	assertCount(t, pool, `SELECT count(*) FROM staffing_rule_exceptions`, 3)
	assertCount(t, pool, `SELECT count(*) FROM staffing_rule_exceptions WHERE role_id=$1 AND minimum=0`, 1, board)
	assertCount(t, pool, `SELECT count(*) FROM staffing_rules WHERE supervisor_minimum=2 AND trainee_minimum=2 AND trainee_ready_after=3`, 1)
	assertCount(t, pool, `SELECT count(*) FROM open_day_staff_requirement_roles WHERE requirement_id=$1`, 1, requirement)
	newcomer := person()
	membership(newcomer, "visitor")

	down := migrationDownSection(t, target[0])
	if _, err := pool.Exec(ctx, down); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `SELECT count(*) FROM roles WHERE id=$1 AND staffing_level='supervisor' AND system_key IS NULL`, 1, betreuer)
	assertCount(t, pool, `SELECT count(*) FROM open_day_requirements WHERE supervisor_role_id=$1`, 1, betreuer)
	assertCount(t, pool, `SELECT count(*) FROM visitor_enrollment_configuration WHERE initial_role_id=$1`, 1, guests)
	applyMigrationFiles(t, pool, target)
	assertCount(t, pool, `SELECT count(*) FROM roles WHERE id=$1 AND system_key='supervisor'`, 1, betreuer)
}

// makeMasterHoldersSupervisors gives everyone holding the master role the supervisor membership, which open-day
// places of kind supervisor require besides their eligible roles.
func makeMasterHoldersSupervisors(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	if _, err := pool.Exec(testContext(t), `UPDATE person_roles pr SET role_id=(SELECT id FROM roles WHERE system_key='supervisor')
		FROM roles r
		WHERE r.id=pr.role_id AND r.system_key IN ('visitor','trainee')
		  AND pr.person_id IN (SELECT m.person_id FROM person_roles m JOIN roles mr ON mr.id=m.role_id WHERE mr.system_key='master')`); err != nil {
		t.Fatal(err)
	}
}
