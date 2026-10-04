package integration_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestPersonRolesMigrationPreservesMetadataAndRefusesLossyDown(t *testing.T) {
	pool := emptySchemaPool(t)
	ctx := testContext(t)
	paths := orderedMigrationFiles(t)
	if filepath.Base(paths[len(paths)-1]) != "00024_person_roles.sql" {
		t.Fatalf("last migration = %s, want 00024_person_roles.sql", filepath.Base(paths[len(paths)-1]))
	}
	applyMigrationFiles(t, pool, paths[:len(paths)-1])

	actor := seedAccount(t, pool, "role-migration-actor", false)
	target := seedAccount(t, pool, "role-migration-target", false)
	roleID := uuid.Must(uuid.NewV7())
	assignedAt := time.Date(2026, time.October, 4, 9, 15, 0, 123000000, time.UTC)
	if _, err := pool.Exec(ctx, `
		INSERT INTO roles(id,name) VALUES($1,'Migrated membership');
		INSERT INTO account_roles(account_id,role_id,assigned_by_account_id,assigned_at) VALUES($2,$1,$3,$4);
		INSERT INTO role_permission_grants(id,role_id,permission_id) VALUES(uuidv7(),$1,'accounts.roles.assign')`,
		roleID, target.accountID, actor.accountID, assignedAt); err != nil {
		t.Fatal(err)
	}

	content, err := os.ReadFile(paths[len(paths)-1])
	if err != nil {
		t.Fatal(err)
	}
	up, down, found := strings.Cut(string(content), "-- +goose Down")
	if !found {
		t.Fatal("00024 has no Down section")
	}
	if _, err := pool.Exec(ctx, up); err != nil {
		t.Fatal(err)
	}
	var gotActor *uuid.UUID
	var gotAssignedAt time.Time
	if err := pool.QueryRow(ctx, `SELECT assigned_by_account_id,assigned_at FROM person_roles WHERE person_id=$1 AND role_id=$2`, target.personID, roleID).Scan(&gotActor, &gotAssignedAt); err != nil {
		t.Fatal(err)
	}
	if gotActor == nil || *gotActor != actor.accountID || !gotAssignedAt.Equal(assignedAt) {
		t.Fatalf("migrated metadata actor=%v assignedAt=%v", gotActor, gotAssignedAt)
	}
	assertCount(t, pool, `SELECT count(*) FROM role_permission_grants WHERE permission_id='people.roles.assign'`, 1)
	assertCount(t, pool, `SELECT count(*) FROM role_permission_grants WHERE permission_id='accounts.roles.assign'`, 0)

	accountlessID := uuid.Must(uuid.NewV7())
	if _, err := pool.Exec(ctx, `
		INSERT INTO people(id,first_name,last_name,email) VALUES($1,'Migration','Accountless','migration-accountless@example.test');
		INSERT INTO person_roles(person_id,role_id) VALUES($1,$2)`, accountlessID, roleID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, down); err == nil || !strings.Contains(err.Error(), "cannot downgrade") {
		t.Fatalf("lossy Down error = %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM people WHERE id=$1`, accountlessID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, down); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `SELECT count(*) FROM account_roles WHERE account_id=$1 AND role_id=$2 AND assigned_by_account_id=$3`, 1, target.accountID, roleID, actor.accountID)
	assertCount(t, pool, `SELECT count(*) FROM role_permission_grants WHERE permission_id='accounts.roles.assign'`, 1)
	if _, err := pool.Exec(ctx, up); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `SELECT count(*) FROM person_roles WHERE person_id=$1 AND role_id=$2`, 1, target.personID, roleID)
}
