package integration_test

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/people"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/scim"
	"github.com/google/uuid"
)

func TestPersonDeletionCascadesPrintingOperations(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	operator := seedAccount(t, pool, "printing-delete-operator", false)
	target := seedAccount(t, pool, "printing-delete-target", false)
	operationKey := uuid.Must(uuid.NewV7())
	if _, err := pool.Exec(ctx, `
		INSERT INTO printing_operations (operation_key, actor_account_id, kind, fingerprint, result_id)
		VALUES ($1, $2, 'attempt_create', $3, $4)`,
		operationKey, target.accountID, strings.Repeat("a", 64), uuid.Must(uuid.NewV7())); err != nil {
		t.Fatal(err)
	}
	principal := authorization.Principal{AccountID: operator.accountID, Master: true}
	var version int64
	if err := pool.QueryRow(ctx, `SELECT version FROM people WHERE id=$1`, target.personID).Scan(&version); err != nil {
		t.Fatal(err)
	}

	if err := people.NewService(pool, nil).Delete(ctx, principal, target.personID, version, nil); err != nil {
		t.Fatalf("deleting a person with printing operations returned %v", err)
	}
	assertCount(t, pool, `SELECT count(*) FROM people WHERE id=$1`, 0, target.personID)
	assertCount(t, pool, `SELECT count(*) FROM accounts WHERE id=$1`, 0, target.accountID)
	assertCount(t, pool, `SELECT count(*) FROM printing_operations WHERE operation_key=$1`, 0, operationKey)
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action='person.deleted' AND resource_id=$1`, 1, target.personID)
}

func TestPersonDeletionReportsEveryBlocker(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	operator := seedAccount(t, pool, "multi-blocker-operator", false)
	principal := authorization.Principal{AccountID: operator.accountID, Master: true}
	providerID := insertSCIMOIDCProvider(t, pool, "https://multi-blocker.example.test")
	service := scim.NewService(pool)
	issue, err := service.CreateConnector(ctx, principal, "Multi blocker", &providerID, true, time.Now().UTC().Add(time.Hour), nil)
	if err != nil {
		t.Fatal(err)
	}
	connector, err := service.Authenticate(ctx, issue.BearerToken)
	if err != nil {
		t.Fatal(err)
	}
	user, err := service.CreateUser(ctx, connector, scim.UserInput{
		UserName: "multi.blocker", ExternalID: testStringPointer("authentik-multi-1"), Active: true,
		GivenName: "Multi", FamilyName: "Blocker",
		Emails: []scim.MultiValue{{Value: "multi-blocker@example.test", Primary: true}},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	var personID uuid.UUID
	var version int64
	if err := pool.QueryRow(ctx, `SELECT p.id, p.version FROM scim_users su JOIN people p ON p.id=su.person_id WHERE su.id=$1`, user.ID).Scan(&personID, &version); err != nil {
		t.Fatal(err)
	}
	// The SCIM-provisioned person becomes the only enabled master.
	if _, err := pool.Exec(ctx, `INSERT INTO person_roles (person_id, role_id) VALUES ($1, $2)`, personID, masterRoleID); err != nil {
		t.Fatal(err)
	}

	err = people.NewService(pool, nil).Delete(ctx, principal, personID, version, nil)
	var appErr *apperror.Error
	if !errors.As(err, &appErr) || appErr.HTTPStatus != 409 || appErr.Code != "person_deletion_blocked" {
		t.Fatalf("deleting a SCIM-managed last master returned %v", err)
	}
	reasons, ok := appErr.Details["reasons"].([]map[string]any)
	if !ok {
		t.Fatalf("details = %#v", appErr.Details)
	}
	codes := map[any]bool{}
	for _, reason := range reasons {
		codes[reason["code"]] = true
	}
	if len(reasons) != 2 || !codes["last_master_required"] || !codes["person_scim_managed"] {
		t.Fatalf("reasons = %#v", reasons)
	}
	assertCount(t, pool, `SELECT count(*) FROM people WHERE id=$1`, 1, personID)
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action='person.deleted' AND resource_id=$1`, 0, personID)
}
