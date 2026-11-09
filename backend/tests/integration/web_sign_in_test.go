package integration_test

import (
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/auth"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

const webSignInPassword = "correct horse battery staple 42"

// webSignInAccount seeds a person with a password and a PIN who holds the given role.
func webSignInAccount(t *testing.T, pool *pgxpool.Pool, suffix string, roleID uuid.UUID) (seededAccount, string, string) {
	t.Helper()
	ctx := testContext(t)
	account := seedAccount(t, pool, suffix, false)
	hash, err := security.HashPassword(webSignInPassword)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE password_credentials SET password_hash=$1 WHERE auth_identity_id=$2`,
		hash, account.identity); err != nil {
		t.Fatal(err)
	}
	pinHash, err := security.HashPIN(integrationConfig(t).PINPepper, "246810")
	if err != nil {
		t.Fatal(err)
	}
	pinIdentity := ids.New()
	login := "pin." + suffix
	if _, err := pool.Exec(ctx, `INSERT INTO auth_identities (id, account_id, kind, identifier_display, identifier_normalized)
		VALUES ($1, $2, 'pin', $3, $3)`, pinIdentity, account.accountID, login); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO pin_credentials (auth_identity_id, pin_hash) VALUES ($1, $2)`,
		pinIdentity, pinHash); err != nil {
		t.Fatal(err)
	}
	// Exactly one membership role at any time: swap it in place.
	if _, err := pool.Exec(ctx, `UPDATE person_roles SET role_id=$2 WHERE person_id=$1
		AND role_id IN (SELECT id FROM roles WHERE system_key IN ('supervisor', 'trainee', 'visitor'))`,
		account.personID, roleID); err != nil {
		t.Fatal(err)
	}
	return account, suffix + "@example.test", login
}

func systemRoleID(t *testing.T, pool *pgxpool.Pool, key string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(testContext(t), `SELECT id FROM roles WHERE system_key=$1`, key).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestWebSignInIsGrantedToEveryRoleExceptVisitorByMigration(t *testing.T) {
	pool := migratedPool(t)
	for key, want := range map[string]int{"supervisor": 1, "trainee": 1, "visitor": 0, "master": 0} {
		assertCount(t, pool,
			`SELECT count(*) FROM role_permission_grants g JOIN roles r ON r.id=g.role_id
			 WHERE r.system_key=$1 AND g.permission_id='web.sign_in'`, want, key)
	}
}

func TestWebSignInIsRequiredForEveryWebSignInPath(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	service, err := auth.NewService(pool, integrationConfig(t), nil)
	if err != nil {
		t.Fatal(err)
	}
	notPermitted := func(t *testing.T, err error) {
		t.Helper()
		if !apperror.IsCode(err, auth.WebSignInNotPermittedCode) {
			t.Fatalf("expected %s, got %v", auth.WebSignInNotPermittedCode, err)
		}
	}

	t.Run("visitor is refused on password and PIN sign-in but can still check in at the terminal", func(t *testing.T) {
		_, email, login := webSignInAccount(t, pool, "wsi-visitor", systemRoleID(t, pool, "visitor"))
		_, err := service.Login(ctx, email, webSignInPassword, "203.0.113.50", nil)
		notPermitted(t, err)
		_, err = service.LoginWithPIN(ctx, login, "246810", "203.0.113.51", nil)
		notPermitted(t, err)
		identity, err := service.VerifyPasswordForAttendance(ctx, email, webSignInPassword, "203.0.113.52")
		if err != nil || identity.Method != "password" {
			t.Fatalf("terminal password check-in of a visitor: %+v %v", identity, err)
		}
		identity, err = service.VerifyPINForAttendance(ctx, login, "246810", "203.0.113.53")
		if err != nil || identity.Method != "pin" {
			t.Fatalf("terminal PIN check-in of a visitor: %+v %v", identity, err)
		}
	})

	t.Run("a role with web.sign_in signs in and a revoked right stops the session", func(t *testing.T) {
		// A visitor who additionally holds a custom role granting web.sign_in; the role is private to this test.
		account, email, login := webSignInAccount(t, pool, "wsi-member", systemRoleID(t, pool, "visitor"))
		role := ids.New()
		if _, err = pool.Exec(ctx, `INSERT INTO roles (id, name) VALUES ($1, 'web sign-in test role');
			INSERT INTO role_permission_grants (id, role_id, permission_id) VALUES (uuidv7(), $1, 'web.sign_in');
			INSERT INTO person_roles (person_id, role_id) VALUES ($2, $1)`, role, account.personID); err != nil {
			t.Fatal(err)
		}
		result, err := service.Login(ctx, email, webSignInPassword, "203.0.113.54", nil)
		if err != nil || result.Session == nil {
			t.Fatalf("member password sign-in: %+v %v", result, err)
		}
		if _, err = service.LoginWithPIN(ctx, login, "246810", "203.0.113.55", nil); err != nil {
			t.Fatalf("member PIN sign-in: %v", err)
		}
		if _, err = service.Authenticate(ctx, result.Session.Token); err != nil {
			t.Fatalf("member session: %v", err)
		}
		if _, err = pool.Exec(ctx, `DELETE FROM role_permission_grants WHERE role_id=$1 AND permission_id='web.sign_in'`,
			role); err != nil {
			t.Fatal(err)
		}
		_, err = service.Authenticate(ctx, result.Session.Token)
		notPermitted(t, err)
		_, err = service.Login(ctx, email, webSignInPassword, "203.0.113.56", nil)
		notPermitted(t, err)
	})

	t.Run("the master role always may sign in", func(t *testing.T) {
		master := seedAccount(t, pool, "wsi-master", true)
		hash, err := security.HashPassword(webSignInPassword)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = pool.Exec(ctx, `UPDATE password_credentials SET password_hash=$1 WHERE auth_identity_id=$2`,
			hash, master.identity); err != nil {
			t.Fatal(err)
		}
		result, err := service.Login(ctx, "wsi-master@example.test", webSignInPassword, "203.0.113.57", nil)
		if err != nil || (result.Session == nil && result.Pending == nil) {
			t.Fatalf("master sign-in: %+v %v", result, err)
		}
	})
}
