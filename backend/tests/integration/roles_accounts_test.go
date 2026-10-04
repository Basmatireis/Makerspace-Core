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
	peopledb "github.com/Basmatireis/Makerspace-Core/backend/internal/people/db"
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
	if _, err := pool.Exec(ctx, `INSERT INTO person_roles (person_id, role_id) VALUES ($1, $2)`, account.personID, roleID); err != nil {
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
	assertCount(t, pool, `SELECT count(*) FROM person_roles WHERE person_id = $1`, 1, account.personID)
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
	if _, err := pool.Exec(ctx, `INSERT INTO person_roles (person_id, role_id) VALUES ($1, $2)`, remaining.personID, roleID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM roles WHERE id = $1`, roleID); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `SELECT count(*) FROM role_permission_grants WHERE role_id = $1`, 0, roleID)
	assertCount(t, pool, `SELECT count(*) FROM person_roles WHERE role_id = $1`, 0, roleID)

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
		JOIN person_roles pr ON pr.person_id = a.person_id
		JOIN roles r ON r.id = pr.role_id
		WHERE a.status = 'enabled' AND r.system_key = 'master'`, 1)
}

func TestConcurrentMasterDestructiveOperationsPreserveEnabledMaster(t *testing.T) {
	for _, test := range []struct {
		name  string
		left  string
		right string
	}{
		{name: "role removal and Person deletion", left: "role", right: "person"},
		{name: "Account disablement and Account deletion", left: "disable", right: "account"},
	} {
		t.Run(test.name, func(t *testing.T) {
			pool := migratedPool(t)
			actor := seedAccount(t, pool, "destructive-actor-"+test.left, false)
			first := seedAccount(t, pool, "destructive-first-"+test.left, true)
			second := seedAccount(t, pool, "destructive-second-"+test.right, true)
			principal := authorization.Principal{AccountID: actor.accountID, PersonID: actor.personID, Master: true}
			accountService := accounts.NewService(pool, config.Config{})
			peopleService := people.NewService(pool)
			masterID := uuid.MustParse(masterRoleID)

			run := func(kind string, subject seededAccount) error {
				switch kind {
				case "role":
					_, err := peopleService.ChangeRole(context.Background(), principal, subject.personID, masterID, 1, false, nil)
					return err
				case "person":
					return peopleService.Delete(context.Background(), principal, subject.personID, 1, nil)
				case "disable":
					_, err := accountService.SetStatus(context.Background(), principal, subject.accountID, "disabled", 1, nil)
					return err
				case "account":
					return accountService.Delete(context.Background(), principal, subject.accountID, 1, nil)
				default:
					return errors.New("unknown destructive operation")
				}
			}

			start := make(chan struct{})
			results := make(chan error, 2)
			go func() { <-start; results <- run(test.left, first) }()
			go func() { <-start; results <- run(test.right, second) }()
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
				JOIN person_roles pr ON pr.person_id = a.person_id
				JOIN roles r ON r.id = pr.role_id
				WHERE a.status = 'enabled' AND r.system_key = 'master'`, 1)
		})
	}
}

func TestAccountServiceDeletionPreservesPersonRoles(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	actor := seedAccount(t, pool, "account-delete-role-actor", true)
	target := seedAccount(t, pool, "account-delete-role-target", false)
	roleID := uuid.Must(uuid.NewV7())
	if _, err := pool.Exec(ctx, `
		INSERT INTO roles(id,name) VALUES($1,'Surviving Account deletion');
		INSERT INTO person_roles(person_id,role_id) VALUES($2,$1)`, roleID, target.personID); err != nil {
		t.Fatal(err)
	}
	principal := authorization.Principal{AccountID: actor.accountID, PersonID: actor.personID, Master: true}
	if err := accounts.NewService(pool, config.Config{}).Delete(ctx, principal, target.accountID, 1, nil); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `SELECT count(*) FROM accounts WHERE id=$1`, 0, target.accountID)
	assertCount(t, pool, `SELECT count(*) FROM people WHERE id=$1`, 1, target.personID)
	assertCount(t, pool, `SELECT count(*) FROM person_roles WHERE person_id=$1 AND role_id=$2`, 1, target.personID, roleID)
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
	if _, err := peopledb.New(assignmentTx).GetRoleForAssignment(ctx, roleID); err != nil {
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
	if _, err := pool.Exec(ctx, `INSERT INTO person_roles (person_id, role_id) VALUES ($1, $2)`, actorAccount.personID, deleteRoleID); err != nil {
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
	peopleService := people.NewService(pool)
	capabilityRole, err := roleService.Create(ctx, master, "subset-manager", nil, []authorization.PermissionGrant{
		{PermissionID: authorization.PeopleRolesAssign, Scope: authorization.GrantEverywhere},
		{PermissionID: authorization.PeopleReadSelf, Scope: authorization.GrantEverywhere},
		{PermissionID: authorization.RolesManage, Scope: authorization.GrantEverywhere},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	actorView, err := peopleService.ChangeRole(ctx, master, actorAccount.personID, capabilityRole.ID, 1, true, nil)
	if err != nil {
		t.Fatal(err)
	}
	if actorView.Version != 2 {
		t.Fatalf("actor person version = %d, want 2 after capability assignment", actorView.Version)
	}

	actor, err := authorization.LoadPermissionsFrom(ctx, pool, authorization.Principal{
		AccountID: actorAccount.accountID,
		PersonID:  actorAccount.personID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if actor.Master || !actor.Has(authorization.RolesManage) || !actor.Has(authorization.PeopleRolesAssign) || !actor.Has(authorization.PeopleReadSelf) {
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

	_, err = peopleService.ChangeRole(ctx, actor, targetAccount.personID, elevatedRole.ID, 1, true, nil)
	expectAppCode(t, err, "permission_denied")
	assertPersonVersion(t, pool, targetAccount.personID, 1)
	assertCount(t, pool, `SELECT count(*) FROM person_roles WHERE person_id = $1 AND role_id = $2`, 0, targetAccount.personID, elevatedRole.ID)

	targetView, err := peopleService.ChangeRole(ctx, actor, targetAccount.personID, subsetRole.ID, 1, true, nil)
	if err != nil {
		t.Fatal(err)
	}
	if targetView.Version != 2 {
		t.Fatalf("target person version = %d, want 2 after subset assignment", targetView.Version)
	}
	assertCount(t, pool, `SELECT count(*) FROM person_roles WHERE person_id = $1 AND role_id = $2`, 1, targetAccount.personID, subsetRole.ID)

	_, err = peopleService.ChangeRole(ctx, actor, targetAccount.personID, subsetRole.ID, 1, false, nil)
	expectAppCode(t, err, "stale_write")
	assertPersonVersion(t, pool, targetAccount.personID, 2)
	assertCount(t, pool, `SELECT count(*) FROM person_roles WHERE person_id = $1 AND role_id = $2`, 1, targetAccount.personID, subsetRole.ID)
}

func TestAccountlessPersonRoleMembershipUsesPersonVersionAndAudits(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	actor := seedAccount(t, pool, "person-role-actor", true)
	principal := authorization.Principal{AccountID: actor.accountID, PersonID: actor.personID, Master: true}
	personID := uuid.Must(uuid.NewV7())
	roleID := uuid.Must(uuid.NewV7())
	pricingGroupID := uuid.Must(uuid.NewV7())
	if _, err := pool.Exec(ctx, `
		INSERT INTO people(id,first_name,last_name,email) VALUES($1,'Accountless','Member','accountless-role@example.test');
		INSERT INTO roles(id,name,profile_image_required,laborordnung_mode) VALUES($2,'Accountless policy',true,'warning');
		INSERT INTO pricing_groups(id,name) VALUES($3,'Independent pricing');
		INSERT INTO person_pricing_group_assignments(person_id,pricing_group_id,assigned_by_account_id) VALUES($1,$3,$4)`, personID, roleID, pricingGroupID, actor.accountID); err != nil {
		t.Fatal(err)
	}

	service := people.NewService(pool)
	assigned, err := service.ChangeRole(ctx, principal, personID, roleID, 1, true, nil)
	if err != nil {
		t.Fatal(err)
	}
	if assigned.Version != 2 || len(assigned.Roles) != 1 || assigned.Roles[0].ID != roleID {
		t.Fatalf("assigned Person = %#v", assigned)
	}
	assertCount(t, pool, `SELECT count(*) FROM accounts WHERE person_id=$1`, 0, personID)
	assertCount(t, pool, `SELECT count(*) FROM person_roles WHERE person_id=$1 AND role_id=$2 AND assigned_by_account_id=$3`, 1, personID, roleID, actor.accountID)
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action='person.role_assigned' AND resource_type='person' AND resource_id=$1`, 1, personID)
	required, err := service.RequiresProfileImage(ctx, personID)
	if err != nil || !required {
		t.Fatalf("accountless profile-image requirement = %v, %v", required, err)
	}
	reader := seedAccount(t, pool, "person-role-reader", false)
	readerRoleID := uuid.Must(uuid.NewV7())
	if _, err := pool.Exec(ctx, `
		INSERT INTO roles(id,name) VALUES($1,'Person role reader');
		INSERT INTO role_permission_grants(id,role_id,permission_id) VALUES(uuidv7(),$1,'people.read.all');
		INSERT INTO person_roles(person_id,role_id) VALUES($2,$1)`, readerRoleID, reader.personID); err != nil {
		t.Fatal(err)
	}
	readerPrincipal, err := authorization.LoadPermissionsFrom(ctx, pool, authorization.Principal{AccountID: reader.accountID, PersonID: reader.personID})
	if err != nil {
		t.Fatal(err)
	}
	if readerPrincipal.Has(authorization.AccountsRead) {
		t.Fatal("role-filter reader unexpectedly has accounts.read")
	}
	page, err := service.List(ctx, readerPrincipal, 1, 25, people.ListFilters{RoleIDs: []uuid.UUID{roleID}})
	if err != nil || page.Total != 1 || len(page.Items) != 1 || page.Items[0].ID != personID {
		t.Fatalf("accountless role filter = %#v, %v", page, err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM person_roles WHERE person_id=$1 AND role_id=$2`, reader.personID, readerRoleID); err != nil {
		t.Fatal(err)
	}
	reloadedReader, err := authorization.LoadPermissionsFrom(ctx, pool, authorization.Principal{AccountID: reader.accountID, PersonID: reader.personID})
	if err != nil {
		t.Fatal(err)
	}
	if reloadedReader.Has(authorization.PeopleReadAll) {
		t.Fatal("revoked Person role remained effective on the next authorization load")
	}

	idempotent, err := service.ChangeRole(ctx, principal, personID, roleID, 2, true, nil)
	if err != nil || idempotent.Version != 2 {
		t.Fatalf("idempotent assignment = %#v, %v", idempotent, err)
	}
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action='person.role_assigned' AND resource_id=$1`, 1, personID)
	if _, err := service.ChangeRole(ctx, principal, personID, roleID, 1, false, nil); !apperror.IsCode(err, "stale_write") {
		t.Fatalf("stale removal error = %v", err)
	}
	removed, err := service.ChangeRole(ctx, principal, personID, roleID, 2, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if removed.Version != 3 || len(removed.Roles) != 0 {
		t.Fatalf("removed Person = %#v", removed)
	}
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action='person.role_removed' AND resource_type='person' AND resource_id=$1`, 1, personID)
	assertCount(t, pool, `SELECT count(*) FROM person_pricing_group_assignments WHERE person_id=$1 AND pricing_group_id=$2 AND version=1`, 1, personID, pricingGroupID)
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
		var personRolesAvailable bool
		if err := pool.QueryRow(ctx, `SELECT to_regclass('person_roles') IS NOT NULL`).Scan(&personRolesAvailable); err != nil {
			t.Fatal(err)
		}
		var insertErr error
		if personRolesAvailable {
			_, insertErr = pool.Exec(ctx, `INSERT INTO person_roles (person_id, role_id) VALUES ($1, $2)`, personID, masterRoleID)
		} else {
			_, insertErr = pool.Exec(ctx, `INSERT INTO account_roles (account_id, role_id) VALUES ($1, $2)`, accountID, masterRoleID)
		}
		if insertErr != nil {
			t.Fatal(insertErr)
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

func assertPersonVersion(t *testing.T, pool *pgxpool.Pool, personID uuid.UUID, want int64) {
	t.Helper()
	var got int64
	if err := pool.QueryRow(testContext(t), `SELECT version FROM people WHERE id = $1`, personID).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("person version = %d, want %d", got, want)
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
