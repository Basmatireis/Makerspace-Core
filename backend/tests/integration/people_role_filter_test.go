package integration_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/people"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/roles"
	"github.com/google/uuid"
)

// A Supervisor-like viewer sees each person's roles in the People list, so they may filter by role without
// roles.read; role administration stays forbidden to them.
func TestPeopleRoleFilterWithoutRolesRead(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	service := people.NewService(pool, nil)
	token := strings.ReplaceAll(ids.New().String(), "-", "")[:8]

	viewer, _ := principalWithPermissions(t, pool, "role-filter-viewer-"+token, "people.read.all")
	if viewer.Has(authorization.RolesRead) {
		t.Fatal("the viewer must not hold roles.read")
	}
	filteredRoleID := ids.New()
	if _, err := pool.Exec(ctx, `INSERT INTO roles(id,name) VALUES($1,$2)`, filteredRoleID, "Role filter "+token); err != nil {
		t.Fatal(err)
	}
	member := seedAccount(t, pool, "role-filter-member-"+token, false)
	seedAccount(t, pool, "role-filter-other-"+token, false)
	if _, err := pool.Exec(
		ctx, `INSERT INTO person_roles(person_id,role_id) VALUES($1,$2)`, member.personID, filteredRoleID,
	); err != nil {
		t.Fatal(err)
	}

	options, err := service.RoleOptions(ctx, viewer)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, option := range options {
		if option.ID == filteredRoleID {
			found = option.Name == "Role filter "+token && option.SystemKey == nil
		}
	}
	if !found {
		t.Fatalf("role options %#v lack the filtered role", options)
	}

	page, err := service.List(ctx, viewer, 1, 100, people.ListFilters{
		Search: "role-filter-", RoleIDs: []uuid.UUID{filteredRoleID},
	})
	if err != nil {
		t.Fatal(err)
	}
	assertPeoplePageIDs(t, page, member.personID)

	roleService := roles.NewService(pool)
	if _, err := roleService.List(ctx, viewer, 100, ""); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("listing roles without roles.read returned %v, want permission denied", err)
	}
	if _, err := roleService.Get(ctx, viewer, filteredRoleID); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("reading a role without roles.read returned %v, want permission denied", err)
	}

	selfOnly, _ := principalWithPermissions(t, pool, "role-filter-self-"+token, "people.read.self")
	if _, err := service.RoleOptions(ctx, selfOnly); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("role options with people.read.self returned %v, want permission denied", err)
	}
	if _, err := service.List(ctx, selfOnly, 1, 100, people.ListFilters{
		RoleIDs: []uuid.UUID{filteredRoleID},
	}); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("filtering people with people.read.self returned %v, want permission denied", err)
	}
}
