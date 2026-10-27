package integration_test

import (
	"errors"
	"net/http"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/accounts"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
)

func TestAdministrativePasswordSetAuthorization(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	// No mail configuration: setting a password never depends on the mail service.
	service := accounts.NewService(pool, config.Config{}, nil)
	setter, _ := principalWithPermissions(t, pool, "setpw-admin", "accounts.password.set", "accounts.login_email.update")
	none, _ := principalWithPermissions(t, pool, "setpw-none")
	target := seedAccount(t, pool, "setpw-target", false)
	masterTarget := seedAccount(t, pool, "setpw-master", true)

	if _, err := service.SetPassword(ctx, none, target.accountID, changedPassword, 1, nil); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("set password without permission = %v", err)
	}
	if _, err := service.SetPassword(ctx, setter, masterTarget.accountID, changedPassword, 1, nil); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("non-master setting a master password = %v", err)
	}
	if _, err := service.UpdateLoginEmail(ctx, setter, masterTarget.accountID, "takeover@example.test", 1, nil); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("non-master changing a master login email = %v", err)
	}
	assertCount(t, pool, `SELECT count(*) FROM password_credentials WHERE password_hash='integration-test-hash' AND auth_identity_id=$1`, 1, masterTarget.identity)

	updated, err := service.SetPassword(ctx, setter, target.accountID, changedPassword, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Version != 2 {
		t.Fatalf("version = %d", updated.Version)
	}
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action='account.password_set' AND resource_id=$1`, 1, target.accountID)

	// A master may set a master's password.
	master, _ := principalWithPermissions(t, pool, "setpw-master-actor")
	master.Master = true
	if _, err := service.SetPassword(ctx, master, masterTarget.accountID, changedPassword, 1, nil); err != nil {
		t.Fatal(err)
	}
}

func TestAdministrativePasswordSetNeedsLoginEmail(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	service := accounts.NewService(pool, config.Config{}, nil)
	setter, _ := principalWithPermissions(t, pool, "setpw-noemail-admin", "accounts.password.set", "accounts.login_email.update")
	target := seedAccount(t, pool, "setpw-noemail", false)
	if _, err := pool.Exec(ctx, `DELETE FROM auth_identities WHERE account_id=$1`, target.accountID); err != nil {
		t.Fatal(err)
	}
	_, err := service.SetPassword(ctx, setter, target.accountID, changedPassword, 1, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "validation_failed")

	// Setting the login email first creates the identity, after which the password can be set.
	account, err := service.UpdateLoginEmail(ctx, setter, target.accountID, "fresh-pw@example.test", 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.SetPassword(ctx, setter, target.accountID, changedPassword, account.Version, nil); err != nil {
		t.Fatal(err)
	}
}
