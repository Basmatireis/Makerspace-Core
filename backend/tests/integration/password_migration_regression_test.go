package integration_test

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/admin"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/auth"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPreRefactorMasterPasswordSurvivesActualMigrationChain(t *testing.T) {
	pool := emptySchemaPool(t)
	ctx := testContext(t)
	migrations := orderedMigrationFiles(t)
	applyMigrationFiles(t, pool, migrations[:3])

	personID := uuid.Must(uuid.NewV7())
	accountID := uuid.Must(uuid.NewV7())
	identityID := uuid.Must(uuid.NewV7())
	email := "Existing.Master@Example.test"
	password := "original migration password 2026"
	hash, err := security.HashPassword(password)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO people (id, first_name, last_name, email) VALUES ($1, 'Existing', 'Master', $2)`, personID, email); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO accounts (id, person_id, status) VALUES ($1, $2, 'enabled')`, accountID, personID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO auth_identities (id, account_id, kind, identifier_display, identifier_normalized) VALUES ($1, $2, 'email_password', $3, lower($3))`, identityID, accountID, email); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO password_credentials (auth_identity_id, password_hash) VALUES ($1, $2)`, identityID, hash); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO account_roles (account_id, role_id) VALUES ($1, $2)`, accountID, masterRoleID); err != nil {
		t.Fatal(err)
	}
	preMigrationToken, preMigrationDigest, err := security.NewOpaqueToken()
	if err != nil {
		t.Fatal(err)
	}
	preMigrationSessionID := uuid.Must(uuid.NewV7())
	if _, err := pool.Exec(ctx, `
		INSERT INTO sessions (id, account_id, auth_identity_id, token_digest, csrf_digest, auth_method, idle_expires_at, absolute_expires_at)
		VALUES ($1, $2, $3, $4, $5, 'password', now() + interval '1 hour', now() + interval '2 hours')`,
		preMigrationSessionID, accountID, identityID, preMigrationDigest, bytes.Repeat([]byte{7}, 32)); err != nil {
		t.Fatal(err)
	}

	// Reproduce the exact broken persisted schema before the forward repair.
	applyMigrationFiles(t, pool, migrations[3:11])
	_, err = pool.Exec(ctx, `
		INSERT INTO sessions (id, account_id, auth_identity_id, token_digest, csrf_digest, auth_method, idle_expires_at, absolute_expires_at)
		VALUES ($1, $2, $3, $4, $5, 'password', now() + interval '1 hour', now() + interval '2 hours')`,
		uuid.Must(uuid.NewV7()), accountID, identityID, bytes.Repeat([]byte{9}, 32), bytes.Repeat([]byte{8}, 32))
	var pgErr *pgconn.PgError
	if !strings.Contains(errorString(err), "authenticated_at") || !asPostgresError(err, &pgErr) || pgErr.Code != "23502" {
		t.Fatalf("pre-repair session insert error = %v, want authenticated_at not-null violation", err)
	}
	applyMigrationFiles(t, pool, migrations[11:])

	var gotPersonID, gotAccountID, gotIdentityID uuid.UUID
	var gotStatus, gotKind, gotIdentifierDisplay, gotIdentifierNormalized, gotHash string
	var gotVerifiedAt time.Time
	var gotDisabledAt *time.Time
	if err := pool.QueryRow(ctx, `
		SELECT p.id, a.id, a.status, i.id, i.kind, i.identifier_display,
		       i.identifier_normalized, i.verified_at, i.disabled_at, pc.password_hash
		FROM people p JOIN accounts a ON a.person_id = p.id
		JOIN auth_identities i ON i.account_id = a.id
		JOIN password_credentials pc ON pc.auth_identity_id = i.id
		WHERE a.id = $1`, accountID).Scan(
		&gotPersonID, &gotAccountID, &gotStatus, &gotIdentityID, &gotKind,
		&gotIdentifierDisplay, &gotIdentifierNormalized, &gotVerifiedAt, &gotDisabledAt, &gotHash,
	); err != nil {
		t.Fatal(err)
	}
	if gotPersonID != personID || gotAccountID != accountID || gotStatus != "enabled" || gotIdentityID != identityID ||
		gotKind != "password" || gotIdentifierDisplay != email || gotIdentifierNormalized != strings.ToLower(email) ||
		gotVerifiedAt.IsZero() || gotDisabledAt != nil || gotHash != hash || !security.VerifyPassword(gotHash, password) {
		t.Fatalf("migrated identity changed: person=%s account=%s identity=%s kind=%q hashPreserved=%v", gotPersonID, gotAccountID, gotIdentityID, gotKind, gotHash == hash)
	}
	assertCount(t, pool, `SELECT count(*) FROM account_roles WHERE account_id = $1 AND role_id = $2`, 1, accountID, masterRoleID)

	service, err := auth.NewService(pool, integrationConfig(t))
	if err != nil {
		t.Fatal(err)
	}
	preMigrationAuthentication, err := service.Authenticate(ctx, preMigrationToken)
	if err != nil {
		t.Fatalf("pre-migration session cookie after migration: %v", err)
	}
	if preMigrationAuthentication.Principal.AccountID != accountID || preMigrationAuthentication.Principal.PersonID != personID ||
		!preMigrationAuthentication.Principal.Master || preMigrationAuthentication.Principal.Assurance != "normal" {
		t.Fatalf("migrated session principal = %#v", preMigrationAuthentication.Principal)
	}
	var migratedSessionMethod, migratedSessionBase, migratedSessionCurrent string
	var migratedSessionAuthenticatedAt time.Time
	if err := pool.QueryRow(ctx, `
		SELECT auth_method, base_assurance, current_assurance, authenticated_at
		FROM sessions WHERE id = $1`, preMigrationSessionID).Scan(
		&migratedSessionMethod, &migratedSessionBase, &migratedSessionCurrent, &migratedSessionAuthenticatedAt,
	); err != nil {
		t.Fatal(err)
	}
	if migratedSessionMethod != "password" || migratedSessionBase != "normal" || migratedSessionCurrent != "normal" || migratedSessionAuthenticatedAt.IsZero() {
		t.Fatalf("pre-migration session changed incorrectly: method=%q assurance=%q/%q authenticatedAt=%v", migratedSessionMethod, migratedSessionBase, migratedSessionCurrent, migratedSessionAuthenticatedAt)
	}
	session, err := service.Login(ctx, strings.ToUpper(email), password, "migration-regression", nil)
	if err != nil {
		t.Fatalf("login with original password after migration: %v", err)
	}
	var method, baseAssurance, currentAssurance string
	var authenticatedAt time.Time
	if err := pool.QueryRow(ctx, `SELECT auth_method, base_assurance, current_assurance, authenticated_at FROM sessions WHERE id = $1`, session.ID).Scan(&method, &baseAssurance, &currentAssurance, &authenticatedAt); err != nil {
		t.Fatal(err)
	}
	if method != "password" || baseAssurance != "normal" || currentAssurance != "normal" || authenticatedAt.IsZero() {
		t.Fatalf("migrated login session = method %q assurance %q/%q authenticatedAt=%v", method, baseAssurance, currentAssurance, authenticatedAt)
	}
}

func TestAdministrativeResetPasswordPreservesExistingAccountState(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	oldPassword := "old master password 2026"
	newPassword := "new master password 2026"
	accountID, err := admin.NewService(pool).BootstrapMaster(ctx, admin.BootstrapInput{FirstName: "CLI", LastName: "Master", ContactEmail: "cli-master@example.test", LoginEmail: "cli-login@example.test", Password: oldPassword})
	if err != nil {
		t.Fatal(err)
	}
	var personID, passwordIdentityID uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT person_id FROM accounts WHERE id = $1`, accountID).Scan(&personID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT id FROM auth_identities WHERE account_id = $1 AND kind = 'password'`, accountID).Scan(&passwordIdentityID); err != nil {
		t.Fatal(err)
	}
	pinIdentityID := uuid.Must(uuid.NewV7())
	pinHash, err := security.HashPIN([]byte("integration-test-pin-pepper-key-32"), "654321")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO auth_identities (id, account_id, kind, identifier_display, identifier_normalized, verified_at) VALUES ($1,$2,'pin','CliMaster','climaster',now())`, pinIdentityID, accountID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO pin_credentials (auth_identity_id, pin_hash) VALUES ($1,$2)`, pinIdentityID, pinHash); err != nil {
		t.Fatal(err)
	}
	providerID, oidcIdentityID := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	if _, err := pool.Exec(ctx, `INSERT INTO oidc_providers (id,slug,display_name,issuer,client_id,encrypted_client_secret) VALUES ($1,'cli-test','CLI Test','https://issuer.example.test','client',$2)`, providerID, []byte("opaque-test-ciphertext")); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO auth_identities (id,account_id,kind,provider_id,issuer,subject,verified_at) VALUES ($1,$2,'oidc',$3,'https://issuer.example.test','subject-1',now())`, oidcIdentityID, accountID, providerID); err != nil {
		t.Fatal(err)
	}
	authService, err := auth.NewService(pool, integrationConfig(t))
	if err != nil {
		t.Fatal(err)
	}
	oldSession, err := authService.Login(ctx, "CLI-LOGIN@EXAMPLE.TEST", oldPassword, "before-cli-reset", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO password_reset_tokens (id,account_id,token_digest,expires_at) VALUES ($1,$2,$3,now()+interval '1 hour')`, uuid.Must(uuid.NewV7()), accountID, bytes.Repeat([]byte{3}, 32)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO auth_challenges (id,kind,account_id,auth_identity_id,code_digest,delivery_address,expires_at) VALUES ($1,'password_reset',$2,$3,$4,'cli-login@example.test',now()+interval '1 hour')`, uuid.Must(uuid.NewV7()), accountID, passwordIdentityID, bytes.Repeat([]byte{4}, 32)); err != nil {
		t.Fatal(err)
	}

	resetAccountID, err := admin.NewService(pool).ResetPassword(ctx, "CLI-LOGIN@example.test", newPassword)
	if err != nil {
		t.Fatal(err)
	}
	if resetAccountID != accountID {
		t.Fatalf("reset account = %s, want %s", resetAccountID, accountID)
	}
	var gotPersonID uuid.UUID
	var status string
	if err := pool.QueryRow(ctx, `SELECT person_id,status FROM accounts WHERE id=$1`, accountID).Scan(&gotPersonID, &status); err != nil {
		t.Fatal(err)
	}
	if gotPersonID != personID || status != "enabled" {
		t.Fatalf("account identity/status changed: person=%s status=%s", gotPersonID, status)
	}
	assertCount(t, pool, `SELECT count(*) FROM account_roles WHERE account_id=$1 AND role_id=$2`, 1, accountID, masterRoleID)
	assertCount(t, pool, `SELECT count(*) FROM auth_identities WHERE account_id=$1 AND id IN ($2,$3,$4)`, 3, accountID, passwordIdentityID, pinIdentityID, oidcIdentityID)
	assertCount(t, pool, `SELECT count(*) FROM sessions WHERE id=$1 AND revoked_at IS NOT NULL`, 1, oldSession.ID)
	assertCount(t, pool, `SELECT count(*) FROM password_reset_tokens WHERE account_id=$1`, 0, accountID)
	assertCount(t, pool, `SELECT count(*) FROM auth_challenges WHERE account_id=$1 AND kind IN ('invitation','email_verification','password_reset')`, 0, accountID)
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE resource_id=$1 AND action='account.password_reset_by_admin_cli' AND source='admin_cli'`, 1, accountID)
	if _, err := authService.Login(ctx, "cli-login@example.test", oldPassword, "old-after-reset", nil); !apperror.IsCode(err, "invalid_credentials") {
		t.Fatalf("old password login error = %v, want invalid_credentials", err)
	}
	if _, err := authService.Login(ctx, "cli-login@example.test", newPassword, "new-after-reset", nil); err != nil {
		t.Fatalf("new password login: %v", err)
	}
	if _, err := admin.NewService(pool).RecoverMaster(ctx, "cli-login@example.test", "another valid password 2026"); err == nil || !strings.Contains(err.Error(), "enabled master") {
		t.Fatalf("recover-master after CLI reset error = %v, want enabled-master refusal", err)
	}
}

func TestAdministrativeResetPasswordCreatesOnlyMissingLocalMethod(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	personID, accountID, pinIdentityID := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	if _, err := pool.Exec(ctx, `INSERT INTO people (id,first_name,last_name,email) VALUES ($1,'PIN','Only','pin-contact@example.test')`, personID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO accounts (id,person_id,status) VALUES ($1,$2,'enabled')`, accountID, personID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO auth_identities (id,account_id,kind,identifier_display,identifier_normalized,verified_at) VALUES ($1,$2,'pin','PinOnly','pinonly',now())`, pinIdentityID, accountID); err != nil {
		t.Fatal(err)
	}
	pinHash, err := security.HashPIN([]byte("integration-test-pin-pepper-key-32"), "123456")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO pin_credentials (auth_identity_id,pin_hash) VALUES ($1,$2)`, pinIdentityID, pinHash); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.NewService(pool).ResetPassword(ctx, "PINONLY", "created local password 2026"); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `SELECT count(*) FROM people WHERE id=$1`, 1, personID)
	assertCount(t, pool, `SELECT count(*) FROM accounts WHERE id=$1 AND person_id=$2 AND status='enabled'`, 1, accountID, personID)
	assertCount(t, pool, `SELECT count(*) FROM auth_identities WHERE id=$1 AND account_id=$2 AND kind='pin'`, 1, pinIdentityID, accountID)
	assertCount(t, pool, `SELECT count(*) FROM auth_identities WHERE account_id=$1 AND kind='password' AND identifier_normalized='pin-contact@example.test' AND verified_at IS NOT NULL`, 1, accountID)
	service, err := auth.NewService(pool, integrationConfig(t))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Login(ctx, "PIN-CONTACT@EXAMPLE.TEST", "created local password 2026", "created-method", nil); err != nil {
		t.Fatalf("login with administratively created local method: %v", err)
	}
}

func emptySchemaPool(t *testing.T) *pgxpool.Pool {
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
	schema := "makerspace_migration_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := adminPool.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		adminPool.Close()
		t.Fatal(err)
	}
	poolConfig, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	poolConfig.ConnConfig.RuntimeParams["search_path"] = schema
	poolConfig.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, _ = adminPool.Exec(cleanupCtx, "DROP SCHEMA "+identifier+" CASCADE")
		adminPool.Close()
	})
	return pool
}

func orderedMigrationFiles(t *testing.T) []string {
	t.Helper()
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate migration test")
	}
	paths, err := filepath.Glob(filepath.Join(filepath.Dir(filename), "..", "..", "migrations", "*.sql"))
	if err != nil || len(paths) != 19 {
		t.Fatalf("locate 19 migrations: count=%d err=%v", len(paths), err)
	}
	return paths
}

func applyMigrationFiles(t *testing.T, pool *pgxpool.Pool, paths []string) {
	t.Helper()
	for _, path := range paths {
		migration, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		up, _, found := strings.Cut(string(migration), "-- +goose Down")
		if !found {
			t.Fatalf("migration %s has no Goose Down section", filepath.Base(path))
		}
		if _, err := pool.Exec(testContext(t), up); err != nil {
			t.Fatalf("apply migration %s: %v", filepath.Base(path), err)
		}
	}
}

func errorString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func asPostgresError(err error, target **pgconn.PgError) bool {
	if err == nil {
		return false
	}
	pgErr, ok := err.(*pgconn.PgError)
	if ok {
		*target = pgErr
	}
	return ok
}
