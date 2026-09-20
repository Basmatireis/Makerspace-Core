package integration_test

import (
	"errors"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/roles"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/scim"
	"github.com/google/uuid"
)

func TestSCIMReconciliationRequiresProvisionalLifecycleAndDelegation(t *testing.T) {
	for _, scenario := range []string{"provisional", "established", "permitted_roles", "missing_assignment", "forbidden_subset"} {
		t.Run(scenario, func(t *testing.T) {
			pool := migratedPool(t)
			ctx := testContext(t)
			actor := seedAccount(t, pool, "operator", false)
			target := seedAccount(t, pool, "target", false)
			master := authorization.Principal{AccountID: actor.accountID, Master: true}
			service := scim.NewService(pool)
			providerID := insertSCIMOIDCProvider(t, pool, "https://delegation.example.test")
			issue, err := service.CreateConnector(ctx, master, "Delegation", &providerID, true, time.Now().Add(time.Hour), nil)
			if err != nil {
				t.Fatal(err)
			}
			connector, err := service.Authenticate(ctx, issue.BearerToken)
			if err != nil {
				t.Fatal(err)
			}
			user, err := service.CreateUser(ctx, connector, scim.UserInput{UserName: "source", ExternalID: testStringPointer("source-subject"), Active: true, GivenName: "Source", FamilyName: "Person", Emails: []scim.MultiValue{{Value: "source@example.test"}}}, nil)
			if err != nil {
				t.Fatal(err)
			}
			var source, sourcePerson uuid.UUID
			if err := pool.QueryRow(ctx, `SELECT account_id,person_id FROM scim_users WHERE id=$1`, user.ID).Scan(&source, &sourcePerson); err != nil {
				t.Fatal(err)
			}
			grants := []authorization.PermissionGrant{{PermissionID: authorization.SCIMManage, Scope: authorization.GrantEverywhere}}
			if scenario == "permitted_roles" || scenario == "forbidden_subset" {
				grants = append(grants, authorization.PermissionGrant{PermissionID: authorization.AccountsRolesAssign, Scope: authorization.GrantEverywhere})
			}
			if scenario == "permitted_roles" {
				grants = append(grants, authorization.PermissionGrant{PermissionID: authorization.PeopleReadSelf, Scope: authorization.GrantEverywhere})
			}
			roleService := roles.NewService(pool)
			actorRole, err := roleService.Create(ctx, master, "operator", nil, grants, nil)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(ctx, `INSERT INTO account_roles(account_id,role_id) VALUES ($1,$2)`, actor.accountID, actorRole.ID); err != nil {
				t.Fatal(err)
			}
			var sourceRole uuid.UUID
			if scenario != "provisional" && scenario != "established" {
				role, err := roleService.Create(ctx, master, "source role", nil, []authorization.PermissionGrant{{PermissionID: authorization.PeopleReadSelf, Scope: authorization.GrantEverywhere}}, nil)
				if err != nil {
					t.Fatal(err)
				}
				sourceRole = role.ID
				if _, err := pool.Exec(ctx, `INSERT INTO account_roles(account_id,role_id) VALUES ($1,$2)`, source, sourceRole); err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "established" {
				if _, err := pool.Exec(ctx, `UPDATE accounts SET first_authenticated_at=now() WHERE id=$1`, source); err != nil {
					t.Fatal(err)
				}
			}
			principal, err := authorization.LoadPermissionsFrom(ctx, pool, authorization.Principal{AccountID: actor.accountID})
			if err != nil {
				t.Fatal(err)
			}
			preflight, err := service.PreflightReconciliation(ctx, principal, source, target.accountID)
			if err != nil {
				t.Fatal(err)
			}
			report, err := service.Reconcile(ctx, principal, source, target.accountID, nil)
			if err != nil {
				t.Fatal(err)
			}
			allowed := scenario == "provisional" || scenario == "permitted_roles"
			if report.Completed != allowed || report.CanReconcile != allowed || preflight.CanReconcile != allowed {
				t.Fatalf("unexpected reconciliation: %#v / %#v", preflight, report)
			}
			if allowed {
				assertCount(t, pool, `SELECT count(*) FROM accounts WHERE id=$1`, 0, source)
				assertCount(t, pool, `SELECT count(*) FROM scim_users WHERE id=$1 AND account_id=$2`, 1, user.ID, target.accountID)
				if sourceRole != uuid.Nil {
					assertCount(t, pool, `SELECT count(*) FROM account_roles WHERE account_id=$1 AND role_id=$2 AND assigned_by_account_id=$3`, 1, target.accountID, sourceRole, actor.accountID)
				}
			} else {
				want := "role_transfer_forbidden"
				if scenario == "established" {
					want = "source_not_provisional"
				}
				if len(report.Conflicts) != 1 || report.Conflicts[0].Code != want {
					t.Fatalf("wrong conflict: %#v", report)
				}
				assertCount(t, pool, `SELECT count(*) FROM accounts WHERE id=$1`, 1, source)
				assertCount(t, pool, `SELECT count(*) FROM people WHERE id=$1`, 1, sourcePerson)
				assertCount(t, pool, `SELECT count(*) FROM scim_users WHERE id=$1 AND account_id=$2`, 1, user.ID, source)
				assertCount(t, pool, `SELECT count(*) FROM auth_identities WHERE account_id=$1 AND subject='source-subject'`, 1, source)
				assertCount(t, pool, `SELECT count(*) FROM account_roles WHERE account_id=$1`, 0, target.accountID)
				assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action='scim.account_reconciled'`, 0)
			}
		})
	}
}

func TestSCIMLinkedSubjectIsImmutable(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	actor := seedAccount(t, pool, "subject-admin", true)
	service := scim.NewService(pool)
	providerID := insertSCIMOIDCProvider(t, pool, "https://subject.example.test")
	issue, err := service.CreateConnector(ctx, authorization.Principal{AccountID: actor.accountID, Master: true}, "Subjects", &providerID, true, time.Now().Add(time.Hour), nil)
	if err != nil {
		t.Fatal(err)
	}
	connector, err := service.Authenticate(ctx, issue.BearerToken)
	if err != nil {
		t.Fatal(err)
	}
	user, err := service.CreateUser(ctx, connector, scim.UserInput{UserName: "subject-user", ExternalID: testStringPointer("immutable-subject"), Active: true, GivenName: "Original", FamilyName: "Person", Emails: []scim.MultiValue{{Value: "subject@example.test"}}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	changed := user.Input
	changed.ExternalID = testStringPointer("other-principal")
	changed.GivenName = "Changed"
	changed.Active = false
	_, err = service.ReplaceUser(ctx, connector, user.ID, changed, nil)
	var protocol *scim.ProtocolError
	if !errors.As(err, &protocol) || protocol.Status != 409 || protocol.SCIMType != "mutability" {
		t.Fatalf("subject replacement: %v", err)
	}
	assertCount(t, pool, `SELECT count(*) FROM scim_users su JOIN people p ON p.id=su.person_id JOIN accounts a ON a.id=su.account_id JOIN auth_identities i ON i.account_id=a.id WHERE su.id=$1 AND su.version=1 AND su.external_id='immutable-subject' AND i.subject='immutable-subject' AND i.disabled_at IS NULL AND a.status='enabled' AND p.first_name='Original'`, 1, user.ID)
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action='scim.user_updated'`, 0)
	changed.ExternalID = user.Input.ExternalID
	changed.Active = true
	updated, err := service.ReplaceUser(ctx, connector, user.ID, changed, nil)
	if err != nil || updated.Input.GivenName != "Changed" {
		t.Fatalf("ordinary update: %#v %v", updated, err)
	}
	assertCount(t, pool, `SELECT count(*) FROM auth_identities WHERE provider_id=$1 AND subject='immutable-subject'`, 1, providerID)
}
