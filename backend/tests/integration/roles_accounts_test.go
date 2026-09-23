package integration_test

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/accounts"
	accountsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/accounts/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/people"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/roles"
	rolesdb "github.com/Basmatireis/Makerspace-Core/backend/internal/roles/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const masterRoleID = "01995ea6-6d00-7000-8000-000000000001"

type seededAccount struct {
	accountID uuid.UUID
	personID  uuid.UUID
	identity  uuid.UUID
}

func TestInitialMigrationProtectsMasterAndDeletionPrivacy(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)

	var masterCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM roles WHERE system_key = 'master'`).Scan(&masterCount); err != nil {
		t.Fatal(err)
	}
	if masterCount != 1 {
		t.Fatalf("master role count = %d, want 1", masterCount)
	}

	_, err := pool.Exec(ctx, `UPDATE roles SET description = 'changed' WHERE id = $1`, masterRoleID)
	expectPostgresCode(t, err, "23514")
	_, err = pool.Exec(ctx, `DELETE FROM roles WHERE id = $1`, masterRoleID)
	expectPostgresCode(t, err, "23514")
	_, err = pool.Exec(ctx, `INSERT INTO roles (id, name, system_key) VALUES ($1, 'master', 'master')`, uuid.Must(uuid.NewV7()))
	expectPostgresCode(t, err, "23514")
	_, err = pool.Exec(ctx, `INSERT INTO role_permission_grants (id, role_id, permission_id) VALUES (uuidv7(), $1, 'people.read.all')`, masterRoleID)
	expectPostgresCode(t, err, "23514")

	account := seedAccount(t, pool, "cascade", false)
	roleID := uuid.Must(uuid.NewV7())
	if _, err := pool.Exec(ctx, `INSERT INTO roles (id, name) VALUES ($1, 'cascade-role')`, roleID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO role_permission_grants (id, role_id, permission_id) VALUES (uuidv7(), $1, 'people.read.self')`, roleID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO account_roles (account_id, role_id) VALUES ($1, $2)`, account.accountID, roleID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO sessions (id, account_id, auth_identity_id, token_digest, csrf_digest, auth_method, idle_expires_at, absolute_expires_at)
		VALUES ($1, $2, $3, $4, $5, 'password', now() + interval '1 hour', now() + interval '2 hours')`,
		uuid.Must(uuid.NewV7()), account.accountID, account.identity, bytes.Repeat([]byte{1}, 32), bytes.Repeat([]byte{2}, 32)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO password_reset_tokens (id, account_id, token_digest, expires_at)
		VALUES ($1, $2, $3, now() + interval '30 minutes')`,
		uuid.Must(uuid.NewV7()), account.accountID, bytes.Repeat([]byte{3}, 32)); err != nil {
		t.Fatal(err)
	}
	auditID := uuid.Must(uuid.NewV7())
	if _, err := pool.Exec(ctx, `
		INSERT INTO audit_events (id, actor_type, actor_account_id, action, resource_type, resource_id)
		VALUES ($1, 'user', $2, 'account.deleted', 'account', $2)`, auditID, account.accountID); err != nil {
		t.Fatal(err)
	}

	if _, err := pool.Exec(ctx, `DELETE FROM accounts WHERE id = $1`, account.accountID); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `SELECT count(*) FROM people WHERE id = $1`, 1, account.personID)
	assertCount(t, pool, `SELECT count(*) FROM auth_identities WHERE account_id = $1`, 0, account.accountID)
	assertCount(t, pool, `SELECT count(*) FROM password_credentials WHERE auth_identity_id = $1`, 0, account.identity)
	assertCount(t, pool, `SELECT count(*) FROM sessions WHERE account_id = $1`, 0, account.accountID)
	assertCount(t, pool, `SELECT count(*) FROM password_reset_tokens WHERE account_id = $1`, 0, account.accountID)
	assertCount(t, pool, `SELECT count(*) FROM account_roles WHERE account_id = $1`, 0, account.accountID)
	assertCount(t, pool, `SELECT count(*) FROM role_permission_grants WHERE role_id = $1`, 1, roleID)

	var actorID, resourceID *uuid.UUID
	var actorType string
	if err := pool.QueryRow(ctx, `SELECT actor_type, actor_account_id, resource_id FROM audit_events WHERE id = $1`, auditID).Scan(&actorType, &actorID, &resourceID); err != nil {
		t.Fatal(err)
	}
	if actorType != "user" || actorID != nil || resourceID == nil || *resourceID != account.accountID {
		t.Fatalf("minimized audit reference mismatch: actor_type=%q actor=%v resource=%v", actorType, actorID, resourceID)
	}

	remaining := seedAccount(t, pool, "role-cascade", false)
	if _, err := pool.Exec(ctx, `INSERT INTO account_roles (account_id, role_id) VALUES ($1, $2)`, remaining.accountID, roleID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM roles WHERE id = $1`, roleID); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `SELECT count(*) FROM role_permission_grants WHERE role_id = $1`, 0, roleID)
	assertCount(t, pool, `SELECT count(*) FROM account_roles WHERE role_id = $1`, 0, roleID)

	personCascade := seedAccount(t, pool, "person-cascade", false)
	if _, err := pool.Exec(ctx, `DELETE FROM people WHERE id = $1`, personCascade.personID); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `SELECT count(*) FROM accounts WHERE id = $1`, 0, personCascade.accountID)
	assertCount(t, pool, `SELECT count(*) FROM auth_identities WHERE id = $1`, 0, personCascade.identity)
}

func TestConcurrentMutationsCannotRemoveEveryEnabledMaster(t *testing.T) {
	pool := migratedPool(t)
	first := seedAccount(t, pool, "master-one", true)
	second := seedAccount(t, pool, "master-two", true)
	service := accounts.NewService(pool, config.Config{})
	principal := authorization.Principal{AccountID: first.accountID, PersonID: first.personID, Master: true}

	start := make(chan struct{})
	results := make(chan error, 2)
	for _, accountID := range []uuid.UUID{first.accountID, second.accountID} {
		go func(id uuid.UUID) {
			<-start
			_, err := service.SetStatus(context.Background(), principal, id, "disabled", 1, nil)
			results <- err
		}(accountID)
	}
	close(start)

	succeeded, blocked := 0, 0
	for range 2 {
		err := <-results
		switch {
		case err == nil:
			succeeded++
		case apperror.IsCode(err, "last_master_required"):
			blocked++
		default:
			t.Fatalf("unexpected concurrent result: %v", err)
		}
	}
	if succeeded != 1 || blocked != 1 {
		t.Fatalf("concurrent results succeeded=%d blocked=%d, want 1/1", succeeded, blocked)
	}
	assertCount(t, pool, `
		SELECT count(*) FROM accounts a
		JOIN account_roles ar ON ar.account_id = a.id
		JOIN roles r ON r.id = ar.role_id
		WHERE a.status = 'enabled' AND r.system_key = 'master'`, 1)
}

func TestRoleAssignmentReadLockSerializesPermissionMutation(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	roleID := uuid.Must(uuid.NewV7())
	if _, err := pool.Exec(ctx, `INSERT INTO roles (id, name) VALUES ($1, 'lock-test')`, roleID); err != nil {
		t.Fatal(err)
	}

	assignmentTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = assignmentTx.Rollback(context.Background()) }()
	if _, err := accountsdb.New(assignmentTx).GetRoleForAssignment(ctx, roleID); err != nil {
		t.Fatal(err)
	}

	mutationTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = mutationTx.Rollback(context.Background()) }()
	waitCtx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if _, err := rolesdb.New(mutationTx).GetRoleForMutation(waitCtx, roleID); err == nil {
		t.Fatal("role mutation unexpectedly acquired a lock while assignment held FOR SHARE")
	}

	if err := assignmentTx.Rollback(ctx); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatal(err)
	}
	verificationTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = verificationTx.Rollback(context.Background()) }()
	if _, err := rolesdb.New(verificationTx).GetRoleForMutation(ctx, roleID); err != nil {
		t.Fatalf("role mutation lock remained unavailable after assignment rollback: %v", err)
	}
}

func TestPersonDeletionSerializesConcurrentAccountCreation(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	actorAccount := seedAccount(t, pool, "delete-race-actor", false)
	deleteRoleID := uuid.Must(uuid.NewV7())
	if _, err := pool.Exec(ctx, `INSERT INTO roles (id, name) VALUES ($1, 'person-deleter')`, deleteRoleID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO role_permission_grants (id, role_id, permission_id) VALUES (uuidv7(), $1, 'people.delete')`, deleteRoleID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO account_roles (account_id, role_id) VALUES ($1, $2)`, actorAccount.accountID, deleteRoleID); err != nil {
		t.Fatal(err)
	}
	principal, err := authorization.LoadPermissionsFrom(ctx, pool, authorization.Principal{
		AccountID: actorAccount.accountID,
		PersonID:  actorAccount.personID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !principal.Has(authorization.PeopleDelete) || principal.Has(authorization.AccountsDelete) {
		t.Fatalf("unexpected deletion permissions: %v", principal.PermissionIDs())
	}

	targetPersonID := uuid.Must(uuid.NewV7())
	if _, err := pool.Exec(ctx, `INSERT INTO people (id, first_name, last_name, email) VALUES ($1, 'Race', 'Target', 'delete-race-target@example.test')`, targetPersonID); err != nil {
		t.Fatal(err)
	}
	creationTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = creationTx.Rollback(context.Background()) }()
	creationQueries := accountsdb.New(creationTx)
	if _, err := creationQueries.GetPersonVersionForAccountCreation(ctx, targetPersonID); err != nil {
		t.Fatal(err)
	}
	targetAccountID := uuid.Must(uuid.NewV7())
	if _, err := creationQueries.CreateAccount(ctx, accountsdb.CreateAccountParams{ID: targetAccountID, PersonID: targetPersonID, Status: "disabled"}); err != nil {
		t.Fatal(err)
	}
	if _, err := creationQueries.CreateAuthIdentity(ctx, accountsdb.CreateAuthIdentityParams{
		ID: uuid.Must(uuid.NewV7()), AccountID: targetAccountID,
		IdentifierDisplay: "delete-race-login@example.test", IdentifierNormalized: "delete-race-login@example.test",
	}); err != nil {
		t.Fatal(err)
	}

	result := make(chan error, 1)
	go func() {
		deleteCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		result <- people.NewService(pool).Delete(deleteCtx, principal, targetPersonID, 1, nil)
	}()
	select {
	case err := <-result:
		t.Fatalf("Person deletion returned before concurrent Account creation committed: %v", err)
	case <-time.After(200 * time.Millisecond):
	}

	if err := creationTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		expectAppCode(t, err, "permission_denied")
	case <-time.After(5 * time.Second):
		t.Fatal("Person deletion did not finish after concurrent Account creation committed")
	}
	assertCount(t, pool, `SELECT count(*) FROM people WHERE id = $1`, 1, targetPersonID)
	assertCount(t, pool, `SELECT count(*) FROM accounts WHERE id = $1`, 1, targetAccountID)
}

func TestNonMasterRolePrivilegeSubsetIsEnforced(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	masterAccount := seedAccount(t, pool, "subset-master", true)
	actorAccount := seedAccount(t, pool, "subset-actor", false)
	targetAccount := seedAccount(t, pool, "subset-target", false)

	master, err := authorization.LoadPermissionsFrom(ctx, pool, authorization.Principal{
		AccountID: masterAccount.accountID,
		PersonID:  masterAccount.personID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !master.Master {
		t.Fatal("seeded master principal was not loaded as master")
	}

	roleService := roles.NewService(pool)
	accountService := accounts.NewService(pool, config.Config{})
	capabilityRole, err := roleService.Create(ctx, master, "subset-manager", nil, []authorization.PermissionGrant{
		{PermissionID: authorization.AccountsRolesAssign, Scope: authorization.GrantEverywhere},
		{PermissionID: authorization.PeopleReadSelf, Scope: authorization.GrantEverywhere},
		{PermissionID: authorization.RolesManage, Scope: authorization.GrantEverywhere},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	actorView, err := accountService.ChangeRole(ctx, master, actorAccount.accountID, capabilityRole.ID, 1, true, nil)
	if err != nil {
		t.Fatal(err)
	}
	if actorView.Version != 2 {
		t.Fatalf("actor account version = %d, want 2 after capability assignment", actorView.Version)
	}

	actor, err := authorization.LoadPermissionsFrom(ctx, pool, authorization.Principal{
		AccountID: actorAccount.accountID,
		PersonID:  actorAccount.personID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if actor.Master || !actor.Has(authorization.RolesManage) || !actor.Has(authorization.AccountsRolesAssign) || !actor.Has(authorization.PeopleReadSelf) {
		t.Fatalf("unexpected non-master permissions: master=%v permissions=%v", actor.Master, actor.PermissionIDs())
	}
	if actor.Has(authorization.PeopleDelete) {
		t.Fatal("non-master actor unexpectedly has people.delete")
	}

	_, err = roleService.Create(ctx, actor, "forbidden-elevated-role", nil, []authorization.PermissionGrant{{PermissionID: authorization.PeopleDelete, Scope: authorization.GrantEverywhere}}, nil)
	expectAppCode(t, err, "permission_denied")
	assertCount(t, pool, `SELECT count(*) FROM roles WHERE name = 'forbidden-elevated-role'`, 0)

	elevatedRole, err := roleService.Create(ctx, master, "elevated-role", nil, []authorization.PermissionGrant{{PermissionID: authorization.PeopleDelete, Scope: authorization.GrantEverywhere}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = roleService.ReplacePermissions(ctx, actor, elevatedRole.ID, elevatedRole.Version, []authorization.PermissionGrant{{PermissionID: authorization.PeopleReadSelf, Scope: authorization.GrantEverywhere}}, nil)
	expectAppCode(t, err, "permission_denied")
	assertRoleVersion(t, pool, elevatedRole.ID, elevatedRole.Version)

	subsetRole, err := roleService.Create(ctx, actor, "self-reader", nil, []authorization.PermissionGrant{{PermissionID: authorization.PeopleReadSelf, Scope: authorization.GrantEverywhere}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if subsetRole.Version != 1 {
		t.Fatalf("new subset role version = %d, want 1", subsetRole.Version)
	}
	_, err = roleService.ReplacePermissions(ctx, actor, subsetRole.ID, subsetRole.Version, []authorization.PermissionGrant{{PermissionID: authorization.PeopleDelete, Scope: authorization.GrantEverywhere}}, nil)
	expectAppCode(t, err, "permission_denied")
	assertRoleVersion(t, pool, subsetRole.ID, 1)

	configuredSubsetRole, err := roleService.ReplacePermissions(ctx, actor, subsetRole.ID, subsetRole.Version, []authorization.PermissionGrant{{PermissionID: authorization.PeopleReadSelf, Scope: authorization.GrantEverywhere}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if configuredSubsetRole.Version != 2 {
		t.Fatalf("configured subset role version = %d, want 2", configuredSubsetRole.Version)
	}
	_, err = roleService.ReplacePermissions(ctx, actor, subsetRole.ID, subsetRole.Version, []authorization.PermissionGrant{{PermissionID: authorization.PeopleReadSelf, Scope: authorization.GrantEverywhere}}, nil)
	expectAppCode(t, err, "stale_write")
	assertRoleVersion(t, pool, subsetRole.ID, 2)

	_, err = accountService.ChangeRole(ctx, actor, targetAccount.accountID, elevatedRole.ID, 1, true, nil)
	expectAppCode(t, err, "permission_denied")
	assertAccountVersion(t, pool, targetAccount.accountID, 1)
	assertCount(t, pool, `SELECT count(*) FROM account_roles WHERE account_id = $1 AND role_id = $2`, 0, targetAccount.accountID, elevatedRole.ID)

	targetView, err := accountService.ChangeRole(ctx, actor, targetAccount.accountID, subsetRole.ID, 1, true, nil)
	if err != nil {
		t.Fatal(err)
	}
	if targetView.Version != 2 {
		t.Fatalf("target account version = %d, want 2 after subset assignment", targetView.Version)
	}
	assertCount(t, pool, `SELECT count(*) FROM account_roles WHERE account_id = $1 AND role_id = $2`, 1, targetAccount.accountID, subsetRole.ID)

	_, err = accountService.ChangeRole(ctx, actor, targetAccount.accountID, subsetRole.ID, 1, false, nil)
	expectAppCode(t, err, "stale_write")
	assertAccountVersion(t, pool, targetAccount.accountID, 2)
	assertCount(t, pool, `SELECT count(*) FROM account_roles WHERE account_id = $1 AND role_id = $2`, 1, targetAccount.accountID, subsetRole.ID)
}

func TestRoleEffectivePermissionEvaluationUsesConfiguredContext(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	masterAccount := seedAccount(t, pool, "evaluation-master", true)
	master, err := authorization.LoadPermissionsFrom(ctx, pool, authorization.Principal{
		AccountID: masterAccount.accountID,
		PersonID:  masterAccount.personID,
	})
	if err != nil {
		t.Fatal(err)
	}
	deviceTypeID := uuid.Must(uuid.NewV7())
	if _, err := pool.Exec(ctx, `INSERT INTO device_types (id, name) VALUES ($1, 'Evaluation terminal')`, deviceTypeID); err != nil {
		t.Fatal(err)
	}
	roleService := roles.NewService(pool)
	role, err := roleService.Create(ctx, master, "context-reader", nil, []authorization.PermissionGrant{
		{PermissionID: authorization.PeopleReadSelf, Scope: authorization.GrantEverywhere, MinimumAssurance: authorization.AssuranceLow},
		{PermissionID: authorization.PeopleReadAll, Scope: authorization.GrantSelectedDeviceTypes, DeviceTypeIDs: []uuid.UUID{deviceTypeID}, MinimumAssurance: authorization.AssuranceNormal},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}

	unmanaged, err := roleService.EvaluatePermissions(ctx, master, authorization.EvaluationContext{Assurance: authorization.AssuranceNormal})
	if err != nil {
		t.Fatal(err)
	}
	assertEvaluatedPermissions(t, unmanaged, role.ID, role.Version, []authorization.Permission{authorization.PeopleReadSelf})
	managed, err := roleService.EvaluatePermissions(ctx, master, authorization.EvaluationContext{Assurance: authorization.AssuranceNormal, DeviceTypeID: &deviceTypeID})
	if err != nil {
		t.Fatal(err)
	}
	assertEvaluatedPermissions(t, managed, role.ID, role.Version, []authorization.Permission{authorization.PeopleReadAll, authorization.PeopleReadSelf})
	if _, err := roleService.EvaluatePermissions(ctx, authorization.Principal{}, authorization.EvaluationContext{Assurance: authorization.AssuranceNormal}); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("unauthorized evaluation error = %v, want permission_denied", err)
	}
	if _, err := roleService.EvaluatePermissions(ctx, master, authorization.EvaluationContext{Assurance: authorization.Assurance("invalid")}); !apperror.IsCode(err, "invalid_request") {
		t.Fatalf("invalid assurance error = %v, want invalid_request", err)
	}
}

func assertEvaluatedPermissions(t *testing.T, evaluations []roles.EffectivePermissionEvaluation, roleID uuid.UUID, roleVersion int64, want []authorization.Permission) {
	t.Helper()
	for _, evaluation := range evaluations {
		if evaluation.RoleID != roleID {
			continue
		}
		if evaluation.RoleVersion != roleVersion {
			t.Fatalf("evaluated role version = %d, want %d", evaluation.RoleVersion, roleVersion)
		}
		if len(evaluation.PermissionIDs) != len(want) {
			t.Fatalf("evaluated permissions = %v, want %v", evaluation.PermissionIDs, want)
		}
		for index := range want {
			if evaluation.PermissionIDs[index] != want[index] {
				t.Fatalf("evaluated permissions = %v, want %v", evaluation.PermissionIDs, want)
			}
		}
		return
	}
	t.Fatalf("role %s missing from evaluation", roleID)
}

func migratedPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := testContext(t)
	adminPool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	schema := "makerspace_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := adminPool.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		adminPool.Close()
		t.Fatal(err)
	}

	poolConfig, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		adminPool.Close()
		t.Fatal(err)
	}
	poolConfig.ConnConfig.RuntimeParams["search_path"] = schema
	poolConfig.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		adminPool.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, _ = adminPool.Exec(cleanupCtx, "DROP SCHEMA "+identifier+" CASCADE")
		adminPool.Close()
	})

	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate integration test source")
	}
	migrations, err := filepath.Glob(filepath.Join(filepath.Dir(filename), "..", "..", "migrations", "*.sql"))
	if err != nil || len(migrations) == 0 {
		t.Fatalf("locate migrations: %v", err)
	}
	for _, path := range migrations {
		migration, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		up, _, found := strings.Cut(string(migration), "-- +goose Down")
		if !found {
			t.Fatalf("migration %s has no Goose Down section", filepath.Base(path))
		}
		if _, err := pool.Exec(ctx, up); err != nil {
			t.Fatalf("apply migration %s: %v", filepath.Base(path), err)
		}
	}
	return pool
}

func seedAccount(t *testing.T, pool *pgxpool.Pool, suffix string, master bool) seededAccount {
	t.Helper()
	ctx := testContext(t)
	personID := uuid.Must(uuid.NewV7())
	accountID := uuid.Must(uuid.NewV7())
	identityID := uuid.Must(uuid.NewV7())
	email := suffix + "@example.test"
	if _, err := pool.Exec(ctx, `INSERT INTO people (id, first_name, last_name, email) VALUES ($1, 'Test', 'Person', $2)`, personID, email); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO accounts (id, person_id, status) VALUES ($1, $2, 'enabled')`, accountID, personID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO auth_identities (id, account_id, kind, identifier_display, identifier_normalized)
		VALUES ($1, $2, 'password', $3, $3)`, identityID, accountID, email); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO password_credentials (auth_identity_id, password_hash) VALUES ($1, 'integration-test-hash')`, identityID); err != nil {
		t.Fatal(err)
	}
	if master {
		if _, err := pool.Exec(ctx, `INSERT INTO account_roles (account_id, role_id) VALUES ($1, $2)`, accountID, masterRoleID); err != nil {
			t.Fatal(err)
		}
	}
	return seededAccount{accountID: accountID, personID: personID, identity: identityID}
}

func assertCount(t *testing.T, pool *pgxpool.Pool, query string, want int, args ...any) {
	t.Helper()
	var got int
	if err := pool.QueryRow(testContext(t), query, args...).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("count = %d, want %d for %q", got, want, query)
	}
}

func assertAccountVersion(t *testing.T, pool *pgxpool.Pool, accountID uuid.UUID, want int64) {
	t.Helper()
	var got int64
	if err := pool.QueryRow(testContext(t), `SELECT version FROM accounts WHERE id = $1`, accountID).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("account version = %d, want %d", got, want)
	}
}

func assertRoleVersion(t *testing.T, pool *pgxpool.Pool, roleID uuid.UUID, want int64) {
	t.Helper()
	var got int64
	if err := pool.QueryRow(testContext(t), `SELECT version FROM roles WHERE id = $1`, roleID).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("role version = %d, want %d", got, want)
	}
}

func expectAppCode(t *testing.T, err error, code string) {
	t.Helper()
	if !apperror.IsCode(err, code) {
		t.Fatalf("error = %v, want application code %s", err, code)
	}
}

func expectPostgresCode(t *testing.T, err error, code string) {
	t.Helper()
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != code {
		t.Fatalf("error = %v, want PostgreSQL code %s", err, code)
	}
}

func testContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	t.Cleanup(cancel)
	return ctx
}
