package integration_test

import (
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/laborordnung"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/roles"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/staffing"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/supervisors"
	"github.com/google/uuid"
)

// roleWithMinimum creates a staffing role with an open-day minimum override.
func (e *staffingEnv) roleWithMinimum(name string, staffingLevel roles.StaffingLevel, minimum int) roles.Role {
	e.t.Helper()
	openDaysRead := []authorization.PermissionGrant{
		{PermissionID: authorization.OpenDaysRead, Scope: authorization.GrantEverywhere},
	}
	role, err := e.roles.CreateWithBehaviors(
		testContext(e.t), e.master, name, nil, openDaysRead, false, laborordnung.ModeNotRequired, &staffingLevel, &minimum, nil,
	)
	if err != nil {
		e.t.Fatal(err)
	}
	return role
}

func intPtr(value int) *int { return &value }

func TestRoleOpenDayMinimumValidationAndRoundTrip(t *testing.T) {
	e := newStaffingEnv(t)
	ctx := testContext(t)
	supervisor := level(roles.StaffingSupervisor)

	created := e.roleWithMinimum("Override", roles.StaffingSupervisor, 4)
	if created.MinOpenDaysPerSemester == nil || *created.MinOpenDaysPerSemester != 4 {
		t.Fatalf("created minimum = %v, want 4", created.MinOpenDaysPerSemester)
	}
	if plain := e.role("No override", supervisor); plain.MinOpenDaysPerSemester != nil {
		t.Fatalf("role without override reports %d", *plain.MinOpenDaysPerSemester)
	}

	for name, bad := range map[string]struct {
		level   *roles.StaffingLevel
		minimum int
	}{
		"below range":           {supervisor, -1},
		"above range":           {supervisor, 21},
		"without staffing":      {nil, 3},
		"zero without staffing": {nil, 0},
	} {
		_, err := e.roles.CreateWithBehaviors(
			ctx, e.master, "Bad "+name, nil, nil, false, laborordnung.ModeNotRequired, bad.level, intPtr(bad.minimum), nil,
		)
		if err == nil {
			t.Fatalf("%s: create was accepted", name)
		}
		expectAppCode(t, err, "validation_failed")
	}

	// Zero is a valid override: the role has no minimum at all.
	zero := e.roleWithMinimum("Zero", roles.StaffingTrainee, 0)
	if zero.MinOpenDaysPerSemester == nil || *zero.MinOpenDaysPerSemester != 0 {
		t.Fatalf("zero override = %v", zero.MinOpenDaysPerSemester)
	}

	// An update that omits the field keeps it; an explicit null clears it; a value replaces it.
	name := "Renamed"
	renamed, err := e.roles.UpdateWithBehaviors(
		ctx, e.master, created.ID, created.Version, &name, false, nil, nil, nil, false, nil, false, nil, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if renamed.MinOpenDaysPerSemester == nil || *renamed.MinOpenDaysPerSemester != 4 {
		t.Fatalf("an update that omits the minimum changed it to %v", renamed.MinOpenDaysPerSemester)
	}
	replaced, err := e.roles.UpdateWithBehaviors(
		ctx, e.master, created.ID, renamed.Version, nil, false, nil, nil, nil, false, nil, true, intPtr(6), nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if replaced.MinOpenDaysPerSemester == nil || *replaced.MinOpenDaysPerSemester != 6 {
		t.Fatalf("replaced minimum = %v, want 6", replaced.MinOpenDaysPerSemester)
	}
	_, err = e.roles.UpdateWithBehaviors(
		ctx, e.master, created.ID, replaced.Version, nil, false, nil, nil, nil, false, nil, true, intPtr(21), nil,
	)
	expectAppCode(t, err, "validation_failed")
	nulled, err := e.roles.UpdateWithBehaviors(
		ctx, e.master, created.ID, replaced.Version, nil, false, nil, nil, nil, false, nil, true, nil, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if nulled.MinOpenDaysPerSemester != nil || nulled.StaffingLevel == nil {
		t.Fatalf("explicit null: minimum %v, level %v", nulled.MinOpenDaysPerSemester, nulled.StaffingLevel)
	}
	assertCount(t, e.pool,
		`SELECT count(*) FROM audit_events WHERE action='role.updated' AND resource_id=$1 AND 'minOpenDaysPerSemester'=ANY(changed_fields)`,
		2, created.ID)

	// A role that stops staffing loses its override; setting both in one request is refused.
	withOverride := e.roleWithMinimum("Loses override", roles.StaffingSupervisor, 3)
	cleared, err := e.roles.UpdateWithBehaviors(
		ctx, e.master, withOverride.ID, withOverride.Version, nil, false, nil, nil, nil, true, nil, false, nil, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if cleared.StaffingLevel != nil || cleared.MinOpenDaysPerSemester != nil {
		t.Fatalf("clearing the level left level %v, minimum %v", cleared.StaffingLevel, cleared.MinOpenDaysPerSemester)
	}
	_, err = e.roles.UpdateWithBehaviors(
		ctx, e.master, cleared.ID, cleared.Version, nil, false, nil, nil, nil, false, nil, true, intPtr(2), nil,
	)
	expectAppCode(t, err, "validation_failed")
	again := e.roleWithMinimum("Contradiction", roles.StaffingSupervisor, 3)
	_, err = e.roles.UpdateWithBehaviors(
		ctx, e.master, again.ID, again.Version, nil, false, nil, nil, nil, true, nil, true, intPtr(3), nil,
	)
	expectAppCode(t, err, "validation_failed")

	// The database refuses what the service would: no override without staffing level, nothing out of range.
	if _, err := e.pool.Exec(ctx, `UPDATE roles SET staffing_level=NULL WHERE id=$1`, zero.ID); err == nil {
		t.Fatal("database accepted an override on a role without staffing level")
	}
	if _, err := e.pool.Exec(ctx, `UPDATE roles SET min_open_days_per_semester=21 WHERE id=$1`, zero.ID); err == nil {
		t.Fatal("database accepted an override above 20")
	}
}

func TestRoleOpenDayMinimumRequiresRolesManage(t *testing.T) {
	e := newStaffingEnv(t)
	ctx := testContext(t)
	reader := e.person("roles-reader", e.role("Roles reader", nil, authorization.RolesRead).ID)
	manager := e.person("roles-manager", e.role("Roles manager", nil, authorization.RolesManage).ID)
	supervisor := level(roles.StaffingSupervisor)

	_, err := e.roles.CreateWithBehaviors(
		ctx, reader, "Denied", nil, nil, false, laborordnung.ModeNotRequired, supervisor, intPtr(3), nil,
	)
	expectAppCode(t, err, "permission_denied")
	role, err := e.roles.CreateWithBehaviors(
		ctx, manager, "Allowed", nil, nil, false, laborordnung.ModeNotRequired, supervisor, intPtr(3), nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	_, err = e.roles.UpdateWithBehaviors(
		ctx, reader, role.ID, role.Version, nil, false, nil, nil, nil, false, nil, true, intPtr(1), nil,
	)
	expectAppCode(t, err, "permission_denied")
	assertCount(t, e.pool, `SELECT count(*) FROM roles WHERE id=$1 AND min_open_days_per_semester=3`, 1, role.ID)
}

func TestStaffingStatusUsesTheLowestRoleOverride(t *testing.T) {
	e := newStaffingEnv(t)
	ctx := testContext(t)
	// The general minimum is 2 (migration default).
	generalRole := e.role("General", level(roles.StaffingSupervisor), authorization.OpenDaysRead)
	highRole := e.roleWithMinimum("High", roles.StaffingSupervisor, 4)
	lowRole := e.roleWithMinimum("Low", roles.StaffingSupervisor, 1)
	zeroRole := e.roleWithMinimum("Zero", roles.StaffingTrainee, 0)
	viewer := e.person("override-viewer", e.role("Viewer", nil, authorization.SupervisorDashboardRead).ID)

	general := e.person("general", generalRole.ID)
	high := e.person("high", highRole.ID)
	low := e.person("low", lowRole.ID)
	mixed := e.person("mixed", highRole.ID, lowRole.ID, generalRole.ID)
	generalAndHigh := e.person("general-and-high", generalRole.ID, highRole.ID)
	zero := e.person("zero", zeroRole.ID, highRole.ID)

	day := e.openDay(e.now.AddDate(0, 0, 5), 4*time.Hour, 6, 6)
	e.join(day, day.supervisorRequirement, high)
	e.join(day, day.supervisorRequirement, low)
	e.join(day, day.supervisorRequirement, mixed)

	result, err := e.supervise.Get(ctx, viewer)
	if err != nil {
		t.Fatal(err)
	}
	rows := map[uuid.UUID]supervisors.Row{}
	for _, row := range result.Supervisors {
		rows[row.PersonID] = row
	}
	cases := []struct {
		name    string
		person  authorization.Principal
		minimum int
		status  staffing.Status
		missing int
	}{
		{"no override uses the general minimum", general, 2, staffing.StatusMissing, 2},
		{"single override above general", high, 4, staffing.StatusMissing, 3},
		{"override below general is fulfilled by one booking", low, 1, staffing.StatusFulfilled, 0},
		{"lowest of several overrides wins", mixed, 1, staffing.StatusFulfilled, 0},
		{"a role without override does not raise the minimum", generalAndHigh, 4, staffing.StatusMissing, 4},
		{"override zero switches the minimum off", zero, 0, staffing.StatusFulfilled, 0},
	}
	for _, tc := range cases {
		row, ok := rows[tc.person.PersonID]
		if !ok {
			t.Fatalf("%s: person is missing from the staffing page", tc.name)
		}
		if row.Minimum != tc.minimum || row.Standing.Status != tc.status || row.Standing.Missing != tc.missing {
			t.Errorf("%s: minimum %d, status %s, missing %d; want %d, %s, %d", tc.name,
				row.Minimum, row.Standing.Status, row.Standing.Missing, tc.minimum, tc.status, tc.missing)
		}
	}
	if result.Requirements.MinOpenDaysPerSemester != 2 {
		t.Fatalf("general minimum = %d, want it untouched", result.Requirements.MinOpenDaysPerSemester)
	}

	// The personal dashboard shows the person's own target and status.
	for name, want := range map[string]struct {
		person  authorization.Principal
		minimum int
		status  staffing.Status
	}{
		"high":    {high, 4, staffing.StatusMissing},
		"low":     {low, 1, staffing.StatusFulfilled},
		"general": {general, 2, staffing.StatusMissing},
	} {
		personal, err := e.dashboard.Get(ctx, want.person)
		if err != nil {
			t.Fatal(err)
		}
		if personal.Staffing == nil || personal.Staffing.Minimum != want.minimum ||
			personal.Staffing.Standing.Status != want.status {
			t.Errorf("%s: personal staffing = %+v, want minimum %d, status %s", name,
				personal.Staffing, want.minimum, want.status)
		}
	}
}
