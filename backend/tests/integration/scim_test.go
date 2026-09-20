package integration_test

import (
	"bytes"
	"errors"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/admin"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/scim"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestSCIMCannotDeprovisionLastEnabledMaster(t *testing.T) {
	for _, operation := range []string{"disable", "delete"} {
		t.Run(operation, func(t *testing.T) {
			pool := migratedPool(t)
			ctx := testContext(t)
			operator := seedAccount(t, pool, "scim-operator", false)
			principal := authorization.Principal{AccountID: operator.accountID, Master: true}
			providerID := insertSCIMOIDCProvider(t, pool, "https://last-master.example.test")
			service := scim.NewService(pool)
			issue, err := service.CreateConnector(ctx, principal, "Master lifecycle", &providerID, true, time.Now().Add(time.Hour), nil)
			if err != nil {
				t.Fatal(err)
			}
			connector, err := service.Authenticate(ctx, issue.BearerToken)
			if err != nil {
				t.Fatal(err)
			}
			user, err := service.CreateUser(ctx, connector, scim.UserInput{
				UserName: "external-master", ExternalID: testStringPointer("master-subject"), Active: true,
				GivenName: "External", FamilyName: "Master", Emails: []scim.MultiValue{{Value: "external-master@example.test"}},
			}, nil)
			if err != nil {
				t.Fatal(err)
			}
			var accountID uuid.UUID
			if err := pool.QueryRow(ctx, `SELECT account_id FROM scim_users WHERE id=$1`, user.ID).Scan(&accountID); err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(ctx, `INSERT INTO account_roles(account_id,role_id) VALUES ($1,$2)`, accountID, masterRoleID); err != nil {
				t.Fatal(err)
			}
			deprovision := func() error {
				if operation == "delete" {
					return service.DeleteUser(ctx, connector, user.ID, nil)
				}
				input := user.Input
				input.Active = false
				_, err := service.ReplaceUser(ctx, connector, user.ID, input, nil)
				return err
			}
			var protocol *scim.ProtocolError
			if err := deprovision(); !errors.As(err, &protocol) || protocol.Status != 409 {
				t.Fatalf("last master deprovisioning returned %v", err)
			}
			assertCount(t, pool, `SELECT count(*) FROM accounts WHERE id=$1 AND status='enabled'`, 1, accountID)
			assertCount(t, pool, `SELECT count(*) FROM auth_identities WHERE account_id=$1 AND disabled_at IS NULL`, 1, accountID)
			assertCount(t, pool, `SELECT count(*) FROM scim_users WHERE id=$1`, 1, user.ID)
			seedAccount(t, pool, "second-master", true)
			if err := deprovision(); err != nil {
				t.Fatal(err)
			}
			assertCount(t, pool, `SELECT count(*) FROM accounts WHERE id=$1 AND status='disabled'`, 1, accountID)
		})
	}
}

func TestSCIMReconciliationPreservesAnEnabledMaster(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	target := seedAccount(t, pool, "reconcile-master-target", false)
	principal := authorization.Principal{AccountID: target.accountID, Master: true}
	providerID := insertSCIMOIDCProvider(t, pool, "https://reconcile-master.example.test")
	service := scim.NewService(pool)
	issue, err := service.CreateConnector(ctx, principal, "Reconcile master", &providerID, true, time.Now().Add(time.Hour), nil)
	if err != nil {
		t.Fatal(err)
	}
	connector, err := service.Authenticate(ctx, issue.BearerToken)
	if err != nil {
		t.Fatal(err)
	}
	user, err := service.CreateUser(ctx, connector, scim.UserInput{
		UserName: "master-source", ExternalID: testStringPointer("master-source"), Active: true,
		GivenName: "Source", FamilyName: "Master", Emails: []scim.MultiValue{{Value: "source@example.test"}},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	var sourceID uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT account_id FROM scim_users WHERE id=$1`, user.ID).Scan(&sourceID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO account_roles(account_id,role_id) VALUES ($1,$2)`, sourceID, masterRoleID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE accounts SET status='disabled' WHERE id=$1`, target.accountID); err != nil {
		t.Fatal(err)
	}
	report, err := service.Reconcile(ctx, principal, sourceID, target.accountID, nil)
	if err != nil || report.CanReconcile || report.Completed || len(report.Conflicts) != 1 || report.Conflicts[0].Code != "last_master" {
		t.Fatalf("last-master reconciliation = %#v, %v", report, err)
	}
	assertCount(t, pool, `SELECT count(*) FROM accounts WHERE id=$1`, 1, sourceID)
	assertCount(t, pool, `SELECT count(*) FROM account_roles WHERE account_id=$1`, 0, target.accountID)
	if _, err := pool.Exec(ctx, `UPDATE accounts SET status='enabled' WHERE id=$1`, target.accountID); err != nil {
		t.Fatal(err)
	}
	report, err = service.Reconcile(ctx, principal, sourceID, target.accountID, nil)
	if err != nil || !report.Completed {
		t.Fatalf("reconciliation = %#v, %v", report, err)
	}
	assertCount(t, pool, `SELECT count(*) FROM accounts WHERE id=$1`, 0, sourceID)
	assertCount(t, pool, `SELECT count(*) FROM account_roles WHERE account_id=$1 AND role_id=$2`, 1, target.accountID, masterRoleID)
}

func TestSCIMProvisioningAuthenticationAndDeprovisioning(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	masterID, err := admin.NewService(pool).BootstrapMaster(ctx, admin.BootstrapInput{
		FirstName: "SCIM", LastName: "Administrator", ContactEmail: "scim-admin@example.test",
		LoginEmail: "scim-admin-login@example.test", Password: bootstrapPassword,
	})
	if err != nil {
		t.Fatal(err)
	}
	providerID := insertSCIMOIDCProvider(t, pool, "https://identity.example.test")
	principal := authorization.Principal{AccountID: masterID, Master: true}
	service := scim.NewService(pool)
	issue, err := service.CreateConnector(ctx, principal, "Authentik", &providerID, true, time.Now().UTC().Add(time.Hour), nil)
	if err != nil {
		t.Fatal(err)
	}
	if issue.BearerToken == "" {
		t.Fatal("connector token was not returned once")
	}
	var digest []byte
	if err := pool.QueryRow(ctx, `SELECT token_digest FROM scim_connector_tokens WHERE connector_id=$1`, issue.Connector.ID).Scan(&digest); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(digest, []byte(issue.BearerToken)) {
		t.Fatal("SCIM bearer token was stored in plaintext")
	}
	connector, err := service.Authenticate(ctx, issue.BearerToken)
	if err != nil {
		t.Fatal(err)
	}
	user, err := service.CreateUser(ctx, connector, scim.UserInput{
		UserName: "provisioned.noel", ExternalID: testStringPointer("authentik-subject-42"), Active: true,
		GivenName: "Noel", FamilyName: "Visitor",
		Emails: []scim.MultiValue{{Value: "noel@example.test", Primary: true}},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	var accountID, personID uuid.UUID
	var source, status string
	var firstAuthenticated bool
	if err := pool.QueryRow(ctx, `SELECT su.account_id,su.person_id,a.provisioning_source,a.status,a.first_authenticated_at IS NOT NULL FROM scim_users su JOIN accounts a ON a.id=su.account_id WHERE su.id=$1`, user.ID).Scan(&accountID, &personID, &source, &status, &firstAuthenticated); err != nil {
		t.Fatal(err)
	}
	if source != "scim" || status != "enabled" || firstAuthenticated {
		t.Fatalf("provisioned state source=%q status=%q firstAuthenticated=%v", source, status, firstAuthenticated)
	}
	assertCount(t, pool, `SELECT count(*) FROM account_roles WHERE account_id=$1`, 0, accountID)
	assertCount(t, pool, `SELECT count(*) FROM auth_identities WHERE account_id=$1 AND kind='oidc' AND provider_id=$2 AND subject='authentik-subject-42'`, 1, accountID, providerID)
	page, err := service.ListUsers(ctx, connector, `externalId eq "authentik-subject-42"`, 1, 100)
	if err != nil || page.Total != 1 || len(page.Items) != 1 || page.Items[0].ID != user.ID {
		t.Fatalf("filtered SCIM list=%#v err=%v", page, err)
	}
	user.Input.Active = false
	if _, err := service.ReplaceUser(ctx, connector, user.ID, user.Input, nil); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `SELECT count(*) FROM accounts WHERE id=$1 AND status='disabled'`, 1, accountID)
	assertCount(t, pool, `SELECT count(*) FROM auth_identities WHERE account_id=$1 AND kind='oidc' AND disabled_at IS NOT NULL`, 1, accountID)
	user.Input.Active = true
	if _, err := service.ReplaceUser(ctx, connector, user.ID, user.Input, nil); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `SELECT count(*) FROM accounts WHERE id=$1 AND status='enabled'`, 1, accountID)
	if err := service.DeleteUser(ctx, connector, user.ID, nil); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `SELECT count(*) FROM scim_users WHERE id=$1`, 0, user.ID)
	assertCount(t, pool, `SELECT count(*) FROM people WHERE id=$1`, 1, personID)
}

func TestSCIMReconciliationPreflightIsAtomicAndRetryable(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	targetAccountID, err := admin.NewService(pool).BootstrapMaster(ctx, admin.BootstrapInput{
		FirstName: "Established", LastName: "Member", ContactEmail: "established@example.test",
		LoginEmail: "established-login@example.test", Password: bootstrapPassword,
	})
	if err != nil {
		t.Fatal(err)
	}
	providerID := insertSCIMOIDCProvider(t, pool, "https://reconcile.example.test")
	principal := authorization.Principal{AccountID: targetAccountID, Master: true}
	service := scim.NewService(pool)
	issue, err := service.CreateConnector(ctx, principal, "Reconciliation", &providerID, true, time.Now().UTC().Add(time.Hour), nil)
	if err != nil {
		t.Fatal(err)
	}
	connector, err := service.Authenticate(ctx, issue.BearerToken)
	if err != nil {
		t.Fatal(err)
	}
	user, err := service.CreateUser(ctx, connector, scim.UserInput{
		UserName: "duplicate.member", ExternalID: testStringPointer("stable-subject"), Active: true,
		GivenName: "Provisioned", FamilyName: "Duplicate", PhoneNumbers: []scim.MultiValue{{Value: "+431234", Primary: true}},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	var sourceAccountID, sourcePersonID, targetPersonID uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT account_id,person_id FROM scim_users WHERE id=$1`, user.ID).Scan(&sourceAccountID, &sourcePersonID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT person_id FROM accounts WHERE id=$1`, targetAccountID).Scan(&targetPersonID); err != nil {
		t.Fatal(err)
	}
	openDayID, sourceRequirementID, targetRequirementID := insertConflictingSCIMAssignments(t, pool, sourcePersonID, targetPersonID)
	report, err := service.PreflightReconciliation(ctx, principal, sourceAccountID, targetAccountID)
	if err != nil || report.CanReconcile || len(report.Conflicts) != 1 || report.Conflicts[0].Code != "open_day_assignment_conflict" {
		t.Fatalf("preflight report=%#v err=%v", report, err)
	}
	report, err = service.Reconcile(ctx, principal, sourceAccountID, targetAccountID, nil)
	if err != nil || report.CanReconcile || report.Completed {
		t.Fatalf("conflicting reconcile report=%#v err=%v", report, err)
	}
	assertCount(t, pool, `SELECT count(*) FROM accounts WHERE id=$1`, 1, sourceAccountID)
	assertCount(t, pool, `SELECT count(*) FROM open_day_assignments WHERE open_day_id=$1`, 2, openDayID)
	if _, err := pool.Exec(ctx, `DELETE FROM open_day_assignments WHERE person_id=$1 AND requirement_id=$2`, targetPersonID, targetRequirementID); err != nil {
		t.Fatal(err)
	}
	report, err = service.Reconcile(ctx, principal, sourceAccountID, targetAccountID, nil)
	if err != nil || !report.CanReconcile || !report.Completed {
		t.Fatalf("resolved reconcile report=%#v err=%v", report, err)
	}
	assertCount(t, pool, `SELECT count(*) FROM accounts WHERE id=$1`, 0, sourceAccountID)
	assertCount(t, pool, `SELECT count(*) FROM people WHERE id=$1`, 0, sourcePersonID)
	assertCount(t, pool, `SELECT count(*) FROM scim_users WHERE id=$1 AND account_id=$2 AND person_id=$3`, 1, user.ID, targetAccountID, targetPersonID)
	assertCount(t, pool, `SELECT count(*) FROM auth_identities WHERE account_id=$1 AND kind='oidc' AND subject='stable-subject'`, 1, targetAccountID)
	assertCount(t, pool, `SELECT count(*) FROM open_day_assignments WHERE open_day_id=$1 AND person_id=$2 AND requirement_id=$3`, 1, openDayID, targetPersonID, sourceRequirementID)
	var firstName, lastName string
	if err := pool.QueryRow(ctx, `SELECT first_name,last_name FROM people WHERE id=$1`, targetPersonID).Scan(&firstName, &lastName); err != nil {
		t.Fatal(err)
	}
	if firstName != "Established" || lastName != "Member" {
		t.Fatalf("target local fields were overwritten: %s %s", firstName, lastName)
	}
}

func insertSCIMOIDCProvider(t *testing.T, pool *pgxpool.Pool, issuer string) uuid.UUID {
	t.Helper()
	id := uuid.Must(uuid.NewV7())
	if _, err := pool.Exec(testContext(t), `INSERT INTO oidc_providers (id,slug,display_name,issuer,client_id,encrypted_client_secret,enabled) VALUES ($1,$2,'SCIM OIDC',$3,'client',$4,true)`, id, "scim-"+id.String()[:8], issuer, []byte{1}); err != nil {
		t.Fatal(err)
	}
	return id
}

func insertConflictingSCIMAssignments(t *testing.T, pool *pgxpool.Pool, sourcePersonID, targetPersonID uuid.UUID) (uuid.UUID, uuid.UUID, uuid.UUID) {
	t.Helper()
	ctx := testContext(t)
	periodID, openDayID := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	sourceRequirementID, targetRequirementID := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	if _, err := pool.Exec(ctx, `INSERT INTO open_day_periods (id,name,starts_on,ends_on) VALUES ($1,'SCIM period',current_date,current_date)`, periodID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO open_days (id,period_id,starts_at,ends_at) VALUES ($1,$2,now()+interval '1 day',now()+interval '1 day 2 hours')`, openDayID, periodID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO open_day_staff_requirements (id,open_day_id,kind,required_count) VALUES ($1,$3,'supervisor',1),($2,$3,'trainee',1)`, sourceRequirementID, targetRequirementID, openDayID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO open_day_assignments (id,open_day_id,requirement_id,person_id) VALUES ($1,$3,$4,$6),($2,$3,$5,$7)`, uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7()), openDayID, sourceRequirementID, targetRequirementID, sourcePersonID, targetPersonID); err != nil {
		t.Fatal(err)
	}
	return openDayID, sourceRequirementID, targetRequirementID
}

func testStringPointer(value string) *string { return &value }
