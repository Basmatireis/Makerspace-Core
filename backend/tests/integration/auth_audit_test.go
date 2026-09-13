package integration_test

import (
	"bytes"
	"context"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/accounts"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/admin"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/auth"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/people"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	bootstrapPassword = "Soldering fox battery 74"
	resetPassword     = "Workshop comet orbit 93"
	changedPassword   = "Workbench aurora circuit 58"
)

func TestBootstrapAuthenticationResetAndAuditPrivacy(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	serviceConfig := integrationConfig(t)

	contactEmail := "Contact.Person@Example.test"
	loginEmail := "Login.Admin+makerspace@Example.test"
	adminService := admin.NewService(pool)
	accountID, err := adminService.BootstrapMaster(ctx, admin.BootstrapInput{
		FirstName:    "Ada",
		LastName:     "Lovelace",
		ContactEmail: contactEmail,
		LoginEmail:   loginEmail,
		Password:     bootstrapPassword,
	})
	if err != nil {
		t.Fatalf("bootstrap master: %v", err)
	}
	if accountID.Version() != 7 {
		t.Fatalf("bootstrap account ID version = %d, want UUIDv7", accountID.Version())
	}

	var (
		storedContact    string
		storedLogin      string
		storedNormalized string
		accountStatus    string
		passwordHash     string
		isMaster         bool
	)
	if err := pool.QueryRow(ctx, `
		SELECT p.email, i.identifier_display, i.identifier_normalized, a.status, pc.password_hash,
		       EXISTS (
		           SELECT 1 FROM account_roles ar
		           JOIN roles r ON r.id = ar.role_id
		           WHERE ar.account_id = a.id AND r.system_key = 'master'
		       )
		FROM accounts a
		JOIN people p ON p.id = a.person_id
		JOIN auth_identities i ON i.account_id = a.id AND i.kind = 'email_password'
		JOIN password_credentials pc ON pc.auth_identity_id = i.id
		WHERE a.id = $1`, accountID).Scan(
		&storedContact, &storedLogin, &storedNormalized, &accountStatus, &passwordHash, &isMaster,
	); err != nil {
		t.Fatal(err)
	}
	if storedContact != contactEmail || storedLogin != loginEmail || storedNormalized != strings.ToLower(loginEmail) {
		t.Fatalf("contact/login identities were conflated: contact=%q login=%q normalized=%q", storedContact, storedLogin, storedNormalized)
	}
	if accountStatus != "enabled" || !isMaster {
		t.Fatalf("bootstrap account status=%q master=%v, want enabled master", accountStatus, isMaster)
	}
	if !strings.HasPrefix(passwordHash, "$argon2id$") || strings.Contains(passwordHash, bootstrapPassword) {
		t.Fatal("bootstrap credential was not stored as a non-plaintext Argon2id PHC string")
	}
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action = 'system.master_bootstrapped' AND source = 'admin_cli'`, 1)

	if _, err := adminService.BootstrapMaster(ctx, admin.BootstrapInput{
		FirstName: "Second", LastName: "Master", ContactEmail: "second-contact@example.test",
		LoginEmail: "second-login@example.test", Password: "A second unique workshop password 82",
	}); err == nil {
		t.Fatal("second bootstrap unexpectedly succeeded")
	}
	assertCount(t, pool, `SELECT count(*) FROM people`, 1)
	assertCount(t, pool, `SELECT count(*) FROM accounts`, 1)
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action = 'system.master_bootstrapped'`, 1)

	authService, err := auth.NewService(pool, serviceConfig)
	if err != nil {
		t.Fatal(err)
	}
	requestID := uuid.Must(uuid.NewV7())
	session, err := authService.Login(ctx, strings.ToLower(loginEmail), bootstrapPassword, "127.0.0.1", &requestID)
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	assertSessionMaterial(t, pool, session)
	if got := session.IdleExpiresAt.Sub(time.Now().UTC()); got < serviceConfig.SessionIdleTTL-time.Minute || got > serviceConfig.SessionIdleTTL+time.Minute {
		t.Fatalf("idle expiry delta = %s, want approximately %s", got, serviceConfig.SessionIdleTTL)
	}
	if got := session.AbsoluteExpiry.Sub(time.Now().UTC()); got < serviceConfig.SessionAbsoluteTTL-time.Minute || got > serviceConfig.SessionAbsoluteTTL+time.Minute {
		t.Fatalf("absolute expiry delta = %s, want approximately %s", got, serviceConfig.SessionAbsoluteTTL)
	}
	authenticated, err := authService.Authenticate(ctx, session.Token)
	if err != nil {
		t.Fatalf("authenticate fresh session: %v", err)
	}
	if !authenticated.Principal.Master || authenticated.Principal.AccountID != accountID {
		t.Fatalf("authenticated principal = %#v, want bootstrapped master", authenticated.Principal)
	}

	if _, err := pool.Exec(ctx, `UPDATE sessions SET idle_expires_at = now() - interval '1 second' WHERE id = $1`, session.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := authService.Authenticate(ctx, session.Token); !apperror.IsCode(err, "unauthenticated") {
		t.Fatalf("expired idle session returned %v, want unauthenticated", err)
	}
	absoluteSession, err := authService.Login(ctx, loginEmail, bootstrapPassword, "127.0.0.1", nil)
	if err != nil {
		t.Fatalf("login for absolute-expiry check: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		UPDATE sessions
		SET idle_expires_at = now() - interval '2 seconds',
		    absolute_expires_at = now() - interval '1 second'
		WHERE id = $1`, absoluteSession.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := authService.Authenticate(ctx, absoluteSession.Token); !apperror.IsCode(err, "unauthenticated") {
		t.Fatalf("expired absolute session returned %v, want unauthenticated", err)
	}

	activeSession, err := authService.Login(ctx, loginEmail, bootstrapPassword, "127.0.0.1", nil)
	if err != nil {
		t.Fatalf("second login: %v", err)
	}
	activeAuth, err := authService.Authenticate(ctx, activeSession.Token)
	if err != nil {
		t.Fatal(err)
	}
	accountService := accounts.NewService(pool, serviceConfig)
	current, err := accountService.GetCurrent(ctx, activeAuth.Principal)
	if err != nil {
		t.Fatal(err)
	}
	issue, err := accountService.IssuePasswordReset(ctx, activeAuth.Principal, accountID, current.Version, nil)
	if err != nil {
		t.Fatalf("issue password reset: %v", err)
	}
	rawResetToken := resetTokenFromURL(t, issue.URL)
	assertResetTokenStoredAsDigest(t, pool, accountID, rawResetToken)

	if _, err := authService.Authenticate(ctx, activeSession.Token); !apperror.IsCode(err, "unauthenticated") {
		t.Fatalf("session was not revoked by reset issuance: %v", err)
	}
	if _, err := authService.Login(ctx, loginEmail, bootstrapPassword, "127.0.0.1", nil); !apperror.IsCode(err, "invalid_credentials") {
		t.Fatalf("reset-required credential did not return generic login failure: %v", err)
	}
	if _, err := authService.Login(ctx, "absent@example.test", bootstrapPassword, "127.0.0.2", nil); !apperror.IsCode(err, "invalid_credentials") {
		t.Fatalf("absent account did not return the same generic login failure: %v", err)
	}

	resetErrors := redeemConcurrently(authService, rawResetToken, resetPassword)
	succeeded, rejected := 0, 0
	for _, resetErr := range resetErrors {
		switch {
		case resetErr == nil:
			succeeded++
		case apperror.IsCode(resetErr, "password_reset_invalid"):
			rejected++
		default:
			t.Fatalf("unexpected concurrent reset result: %v", resetErr)
		}
	}
	if succeeded != 1 || rejected != 1 {
		t.Fatalf("concurrent reset results succeeded=%d rejected=%d, want 1/1", succeeded, rejected)
	}
	assertCount(t, pool, `SELECT count(*) FROM password_reset_tokens WHERE account_id = $1`, 0, accountID)
	var redeemedVersion int64
	if err := pool.QueryRow(ctx, `SELECT version FROM accounts WHERE id = $1`, accountID).Scan(&redeemedVersion); err != nil {
		t.Fatal(err)
	}
	if redeemedVersion != issue.Account.Version+1 {
		t.Fatalf("account version after reset redemption = %d, want %d", redeemedVersion, issue.Account.Version+1)
	}

	if _, err := authService.Login(ctx, loginEmail, bootstrapPassword, "127.0.0.3", nil); !apperror.IsCode(err, "invalid_credentials") {
		t.Fatalf("old password remained valid after reset: %v", err)
	}
	passwordChangeSession, err := authService.Login(ctx, loginEmail, resetPassword, "127.0.0.3", nil)
	if err != nil {
		t.Fatalf("new password login: %v", err)
	}
	passwordChangeAuth, err := authService.Authenticate(ctx, passwordChangeSession.Token)
	if err != nil {
		t.Fatalf("authenticate before own password change: %v", err)
	}
	freshSession, err := authService.ChangePassword(ctx, passwordChangeAuth.Principal, resetPassword, changedPassword, nil)
	if err != nil {
		t.Fatalf("change own password: %v", err)
	}
	if freshSession.ID == passwordChangeSession.ID || freshSession.Token == passwordChangeSession.Token {
		t.Fatal("own password change did not return a fresh session")
	}
	if _, err := authService.Authenticate(ctx, passwordChangeSession.Token); !apperror.IsCode(err, "unauthenticated") {
		t.Fatalf("pre-change session remained usable: %v", err)
	}
	if _, err := authService.Authenticate(ctx, freshSession.Token); err != nil {
		t.Fatalf("fresh session after own password change is invalid: %v", err)
	}
	var changedVersion int64
	if err := pool.QueryRow(ctx, `SELECT version FROM accounts WHERE id = $1`, accountID).Scan(&changedVersion); err != nil {
		t.Fatal(err)
	}
	if changedVersion != redeemedVersion+1 {
		t.Fatalf("account version after own password change = %d, want %d", changedVersion, redeemedVersion+1)
	}
	if _, err := authService.Login(ctx, loginEmail, resetPassword, "127.0.0.4", nil); !apperror.IsCode(err, "invalid_credentials") {
		t.Fatalf("pre-change password remained valid: %v", err)
	}

	assertAuditContainsNoPII(t, pool, contactEmail, loginEmail, bootstrapPassword, resetPassword, changedPassword, rawResetToken)
}

func TestPasswordResetProvisioningKeepsDisabledAccountDisabled(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	serviceConfig := integrationConfig(t)

	masterLogin := "reset-provisioning-master@example.test"
	if _, err := admin.NewService(pool).BootstrapMaster(ctx, admin.BootstrapInput{
		FirstName: "Reset", LastName: "Administrator", ContactEmail: masterLogin,
		LoginEmail: masterLogin, Password: bootstrapPassword,
	}); err != nil {
		t.Fatalf("bootstrap master: %v", err)
	}
	authService, err := auth.NewService(pool, serviceConfig)
	if err != nil {
		t.Fatal(err)
	}
	masterSession, err := authService.Login(ctx, masterLogin, bootstrapPassword, "127.0.0.1", nil)
	if err != nil {
		t.Fatalf("master login: %v", err)
	}
	authenticated, err := authService.Authenticate(ctx, masterSession.Token)
	if err != nil {
		t.Fatalf("authenticate master: %v", err)
	}

	contactEmail := "disabled-person-contact@example.test"
	person, err := people.NewService(pool).Create(ctx, authenticated.Principal, people.CreateInput{
		FirstName: "Disabled", LastName: "Member", Email: &contactEmail,
	}, nil)
	if err != nil {
		t.Fatalf("create person: %v", err)
	}
	loginEmail := "disabled-account-login@example.test"
	accountService := accounts.NewService(pool, serviceConfig)
	account, err := accountService.Create(ctx, authenticated.Principal, person.ID, loginEmail, person.Version, nil)
	if err != nil {
		t.Fatalf("create disabled account: %v", err)
	}
	if account.Status != "disabled" || account.PasswordStatus != "not_set" {
		t.Fatalf("new account status=%q passwordStatus=%q, want disabled/not_set", account.Status, account.PasswordStatus)
	}

	expiredIssue, err := accountService.IssuePasswordReset(ctx, authenticated.Principal, account.ID, account.Version, nil)
	if err != nil {
		t.Fatalf("issue password setup token: %v", err)
	}
	expiredToken := resetTokenFromURL(t, expiredIssue.URL)
	if _, err := pool.Exec(ctx, `
		UPDATE password_reset_tokens
		SET created_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute'
		WHERE account_id = $1`, account.ID); err != nil {
		t.Fatal(err)
	}
	if err := authService.RedeemPasswordReset(ctx, expiredToken, "Expired token password 46", nil); !apperror.IsCode(err, "password_reset_invalid") {
		t.Fatalf("expired setup token returned %v, want password_reset_invalid", err)
	}
	assertCount(t, pool, `SELECT count(*) FROM password_credentials pc JOIN auth_identities i ON i.id = pc.auth_identity_id WHERE i.account_id = $1`, 0, account.ID)

	activeIssue, err := accountService.IssuePasswordReset(ctx, authenticated.Principal, account.ID, expiredIssue.Account.Version, nil)
	if err != nil {
		t.Fatalf("replace expired password setup token: %v", err)
	}
	activeToken := resetTokenFromURL(t, activeIssue.URL)
	provisionedPassword := "Provisioned disabled account 84"
	if err := authService.RedeemPasswordReset(ctx, activeToken, provisionedPassword, nil); err != nil {
		t.Fatalf("redeem active setup token: %v", err)
	}
	if err := authService.RedeemPasswordReset(ctx, activeToken, "Second redemption password 25", nil); !apperror.IsCode(err, "password_reset_invalid") {
		t.Fatalf("second setup-token redemption returned %v, want password_reset_invalid", err)
	}

	var (
		status        string
		version       int64
		passwordHash  string
		resetRequired bool
	)
	if err := pool.QueryRow(ctx, `
		SELECT a.status, a.version, pc.password_hash, pc.reset_required
		FROM accounts a
		JOIN auth_identities i ON i.account_id = a.id AND i.kind = 'email_password'
		JOIN password_credentials pc ON pc.auth_identity_id = i.id
		WHERE a.id = $1`, account.ID).Scan(&status, &version, &passwordHash, &resetRequired); err != nil {
		t.Fatal(err)
	}
	if status != "disabled" {
		t.Fatalf("account status after password setup = %q, want disabled", status)
	}
	if version != activeIssue.Account.Version+1 {
		t.Fatalf("account version after password setup = %d, want %d", version, activeIssue.Account.Version+1)
	}
	if resetRequired || !strings.HasPrefix(passwordHash, "$argon2id$") {
		t.Fatalf("credential resetRequired=%v hashPrefixValid=%v, want active Argon2id credential", resetRequired, strings.HasPrefix(passwordHash, "$argon2id$"))
	}
	assertCount(t, pool, `SELECT count(*) FROM password_reset_tokens WHERE account_id = $1`, 0, account.ID)

	if _, err := authService.Login(ctx, loginEmail, provisionedPassword, "127.0.0.4", nil); !apperror.IsCode(err, "invalid_credentials") {
		t.Fatalf("disabled provisioned account login returned %v, want invalid_credentials", err)
	}
	assertAuditContainsNoPII(t, pool, contactEmail, loginEmail, expiredToken, activeToken, provisionedPassword)
}

func TestAdministrativeResetCannotBeBypassedByConcurrentLogin(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	cfg := integrationConfig(t)
	loginEmail := "login-reset-race@example.test"
	accountID, err := admin.NewService(pool).BootstrapMaster(ctx, admin.BootstrapInput{
		FirstName: "Login", LastName: "Race", ContactEmail: loginEmail,
		LoginEmail: loginEmail, Password: bootstrapPassword,
	})
	if err != nil {
		t.Fatalf("bootstrap master: %v", err)
	}
	authService, err := auth.NewService(pool, cfg)
	if err != nil {
		t.Fatal(err)
	}
	var personID uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT person_id FROM accounts WHERE id = $1`, accountID).Scan(&personID); err != nil {
		t.Fatal(err)
	}
	principal := authorization.Principal{AccountID: accountID, PersonID: personID, Master: true}

	if _, err := pool.Exec(ctx, `
		CREATE FUNCTION test_pause_session_insert() RETURNS trigger
		LANGUAGE plpgsql AS $$
		BEGIN
			PERFORM pg_advisory_xact_lock(731984621047512001);
			RETURN NEW;
		END;
		$$;
		CREATE TRIGGER test_pause_session_insert
		BEFORE INSERT ON sessions
		FOR EACH ROW EXECUTE FUNCTION test_pause_session_insert()`); err != nil {
		t.Fatal(err)
	}
	gate, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	gateReleased := false
	defer func() {
		if !gateReleased {
			_ = gate.Rollback(context.Background())
		}
	}()
	if _, err := gate.Exec(ctx, `SELECT pg_advisory_xact_lock(731984621047512001)`); err != nil {
		t.Fatal(err)
	}

	type loginResult struct {
		session auth.Session
		err     error
	}
	loginDone := make(chan loginResult, 1)
	go func() {
		session, loginErr := authService.Login(context.Background(), loginEmail, bootstrapPassword, "192.0.2.31", nil)
		loginDone <- loginResult{session: session, err: loginErr}
	}()
	waitForAdvisoryQuery(t, pool, "INSERT INTO sessions")

	accountService := accounts.NewService(pool, cfg)
	resetDone := make(chan error, 1)
	go func() {
		_, resetErr := accountService.IssuePasswordReset(context.Background(), principal, accountID, 1, nil)
		resetDone <- resetErr
	}()
	select {
	case resetErr := <-resetDone:
		t.Fatalf("administrative reset completed before the in-flight login transaction: %v", resetErr)
	case <-time.After(200 * time.Millisecond):
	}

	if err := gate.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	gateReleased = true
	login := <-loginDone
	if login.err != nil {
		t.Fatalf("login: %v", login.err)
	}
	if resetErr := <-resetDone; resetErr != nil {
		t.Fatalf("issue reset: %v", resetErr)
	}
	if _, err := authService.Authenticate(ctx, login.session.Token); !apperror.IsCode(err, "unauthenticated") {
		t.Fatalf("login session committed after reset remained usable: %v", err)
	}
}

func TestConcurrentResetBlocksOwnPasswordChangeFromCreatingFreshSession(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	cfg := integrationConfig(t)
	loginEmail := "password-reset-race@example.test"
	accountID, err := admin.NewService(pool).BootstrapMaster(ctx, admin.BootstrapInput{
		FirstName: "Password", LastName: "Race", ContactEmail: loginEmail,
		LoginEmail: loginEmail, Password: bootstrapPassword,
	})
	if err != nil {
		t.Fatalf("bootstrap master: %v", err)
	}
	authService, err := auth.NewService(pool, cfg)
	if err != nil {
		t.Fatal(err)
	}
	initialSession, err := authService.Login(ctx, loginEmail, bootstrapPassword, "192.0.2.32", nil)
	if err != nil {
		t.Fatal(err)
	}
	authenticated, err := authService.Authenticate(ctx, initialSession.Token)
	if err != nil {
		t.Fatal(err)
	}
	accountService := accounts.NewService(pool, cfg)
	account, err := accountService.GetCurrent(ctx, authenticated.Principal)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := pool.Exec(ctx, `
		CREATE FUNCTION test_pause_reset_audit() RETURNS trigger
		LANGUAGE plpgsql AS $$
		BEGIN
			PERFORM pg_advisory_xact_lock(731984621047512002);
			RETURN NEW;
		END;
		$$;
		CREATE TRIGGER test_pause_reset_audit
		BEFORE INSERT ON audit_events
		FOR EACH ROW
		WHEN (NEW.action = 'account.password_reset_issued')
		EXECUTE FUNCTION test_pause_reset_audit()`); err != nil {
		t.Fatal(err)
	}
	gate, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	gateReleased := false
	defer func() {
		if !gateReleased {
			_ = gate.Rollback(context.Background())
		}
	}()
	if _, err := gate.Exec(ctx, `SELECT pg_advisory_xact_lock(731984621047512002)`); err != nil {
		t.Fatal(err)
	}

	resetDone := make(chan error, 1)
	go func() {
		_, resetErr := accountService.IssuePasswordReset(context.Background(), authenticated.Principal, accountID, account.Version, nil)
		resetDone <- resetErr
	}()
	waitForAdvisoryQuery(t, pool, "INSERT INTO audit_events")

	type passwordChangeResult struct {
		session auth.Session
		err     error
	}
	changeDone := make(chan passwordChangeResult, 1)
	go func() {
		session, changeErr := authService.ChangePassword(context.Background(), authenticated.Principal, bootstrapPassword, changedPassword, nil)
		changeDone <- passwordChangeResult{session: session, err: changeErr}
	}()
	select {
	case change := <-changeDone:
		t.Fatalf("password change completed before the reset transaction: %v", change.err)
	case <-time.After(200 * time.Millisecond):
	}

	if err := gate.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	gateReleased = true
	if resetErr := <-resetDone; resetErr != nil {
		t.Fatalf("issue reset: %v", resetErr)
	}
	change := <-changeDone
	if !apperror.IsCode(change.err, "unauthenticated") || change.session.ID != uuid.Nil {
		t.Fatalf("password change after reset returned session=%v error=%v", change.session.ID, change.err)
	}
	if _, err := authService.Authenticate(ctx, initialSession.Token); !apperror.IsCode(err, "unauthenticated") {
		t.Fatalf("original session remained usable after reset: %v", err)
	}
	if _, err := authService.Login(ctx, loginEmail, changedPassword, "192.0.2.33", nil); !apperror.IsCode(err, "invalid_credentials") {
		t.Fatalf("concurrent password change overrode reset-required state: %v", err)
	}
}

func TestMasterRecoveryRevokesSessionCreatedByConcurrentLogin(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	cfg := integrationConfig(t)
	loginEmail := "login-recovery-race@example.test"
	recoveryPassword := "Recovered workshop access 81"
	accountID, err := admin.NewService(pool).BootstrapMaster(ctx, admin.BootstrapInput{
		FirstName: "Recovery", LastName: "Race", ContactEmail: loginEmail,
		LoginEmail: loginEmail, Password: bootstrapPassword,
	})
	if err != nil {
		t.Fatalf("bootstrap master: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM account_roles WHERE account_id = $1 AND role_id = $2`, accountID, masterRoleID); err != nil {
		t.Fatal(err)
	}

	authService, err := auth.NewService(pool, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		CREATE FUNCTION test_pause_recovery_session_insert() RETURNS trigger
		LANGUAGE plpgsql AS $$
		BEGIN
			PERFORM pg_advisory_xact_lock(731984621047512003);
			RETURN NEW;
		END;
		$$;
		CREATE TRIGGER test_pause_recovery_session_insert
		BEFORE INSERT ON sessions
		FOR EACH ROW EXECUTE FUNCTION test_pause_recovery_session_insert()`); err != nil {
		t.Fatal(err)
	}
	gate, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	gateReleased := false
	defer func() {
		if !gateReleased {
			_ = gate.Rollback(context.Background())
		}
	}()
	if _, err := gate.Exec(ctx, `SELECT pg_advisory_xact_lock(731984621047512003)`); err != nil {
		t.Fatal(err)
	}

	type loginResult struct {
		session auth.Session
		err     error
	}
	loginDone := make(chan loginResult, 1)
	go func() {
		session, loginErr := authService.Login(context.Background(), loginEmail, bootstrapPassword, "192.0.2.34", nil)
		loginDone <- loginResult{session: session, err: loginErr}
	}()
	waitForAdvisoryQuery(t, pool, "INSERT INTO sessions")

	recoveryDone := make(chan error, 1)
	go func() {
		_, recoveryErr := admin.NewService(pool).RecoverMaster(context.Background(), loginEmail, recoveryPassword)
		recoveryDone <- recoveryErr
	}()
	select {
	case recoveryErr := <-recoveryDone:
		t.Fatalf("master recovery completed before the in-flight login transaction: %v", recoveryErr)
	case <-time.After(200 * time.Millisecond):
	}

	if err := gate.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	gateReleased = true
	login := <-loginDone
	if login.err != nil {
		t.Fatalf("login: %v", login.err)
	}
	if recoveryErr := <-recoveryDone; recoveryErr != nil {
		t.Fatalf("recover master: %v", recoveryErr)
	}
	if _, err := authService.Authenticate(ctx, login.session.Token); !apperror.IsCode(err, "unauthenticated") {
		t.Fatalf("session committed before recovery remained usable: %v", err)
	}
	if _, err := authService.Login(ctx, loginEmail, bootstrapPassword, "192.0.2.35", nil); !apperror.IsCode(err, "invalid_credentials") {
		t.Fatalf("pre-recovery password remained valid: %v", err)
	}
	if _, err := authService.Login(ctx, loginEmail, recoveryPassword, "192.0.2.36", nil); err != nil {
		t.Fatalf("recovered credential did not authenticate: %v", err)
	}
	assertCount(t, pool, `
		SELECT count(*)
		FROM account_roles ar
		JOIN roles r ON r.id = ar.role_id
		WHERE ar.account_id = $1 AND r.system_key = 'master'`, 1, accountID)
}

func TestMutationRollsBackWhenAuditInsertionFails(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	serviceConfig := integrationConfig(t)
	loginEmail := "rollback-login@example.test"

	accountID, err := admin.NewService(pool).BootstrapMaster(ctx, admin.BootstrapInput{
		FirstName: "Audit", LastName: "Rollback", ContactEmail: "rollback-contact@example.test",
		LoginEmail: loginEmail, Password: bootstrapPassword,
	})
	if err != nil {
		t.Fatal(err)
	}
	authService, err := auth.NewService(pool, serviceConfig)
	if err != nil {
		t.Fatal(err)
	}
	session, err := authService.Login(ctx, loginEmail, bootstrapPassword, "127.0.0.1", nil)
	if err != nil {
		t.Fatal(err)
	}
	authenticated, err := authService.Authenticate(ctx, session.Token)
	if err != nil {
		t.Fatal(err)
	}
	if authenticated.Principal.AccountID != accountID || !authenticated.Principal.Master {
		t.Fatal("bootstrap login did not resolve the master principal")
	}

	if _, err := pool.Exec(ctx, `
		CREATE FUNCTION reject_test_audit() RETURNS trigger
		LANGUAGE plpgsql AS $$
		BEGIN
			RAISE EXCEPTION 'forced audit insertion failure';
		END;
		$$`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		CREATE TRIGGER audit_events_reject_test_insert
		BEFORE INSERT ON audit_events
		FOR EACH ROW EXECUTE FUNCTION reject_test_audit()`); err != nil {
		t.Fatal(err)
	}

	var peopleBefore, auditBefore int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM people`).Scan(&peopleBefore); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_events`).Scan(&auditBefore); err != nil {
		t.Fatal(err)
	}
	rolledBackEmail := "must-not-persist@example.test"
	_, err = people.NewService(pool).Create(ctx, authenticated.Principal, people.CreateInput{
		FirstName: "Rolled", LastName: "Back", Email: &rolledBackEmail,
	}, nil)
	if err == nil {
		t.Fatal("person mutation unexpectedly committed when audit insertion failed")
	}
	assertCount(t, pool, `SELECT count(*) FROM people`, peopleBefore)
	assertCount(t, pool, `SELECT count(*) FROM people WHERE email = $1`, 0, rolledBackEmail)
	assertCount(t, pool, `SELECT count(*) FROM audit_events`, auditBefore)
}

func integrationConfig(t *testing.T) config.Config {
	t.Helper()
	baseURL, err := url.Parse("http://makerspace.example.test")
	if err != nil {
		t.Fatal(err)
	}
	return config.Config{
		PublicBaseURL:      baseURL,
		SessionIdleTTL:     6 * time.Hour,
		SessionAbsoluteTTL: 72 * time.Hour,
		PasswordResetTTL:   30 * time.Minute,
	}
}

func assertSessionMaterial(t *testing.T, pool *pgxpool.Pool, session auth.Session) {
	t.Helper()
	if session.Token == "" || session.CSRFToken == "" || session.Token == session.CSRFToken {
		t.Fatal("session and CSRF tokens must be distinct non-empty opaque values")
	}
	var storedTokenDigest, storedCSRFDigest []byte
	if err := pool.QueryRow(testContext(t), `SELECT token_digest, csrf_digest FROM sessions WHERE id = $1`, session.ID).
		Scan(&storedTokenDigest, &storedCSRFDigest); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(storedTokenDigest, security.DigestToken(session.Token)) || bytes.Equal(storedTokenDigest, []byte(session.Token)) {
		t.Fatal("session token was not persisted exclusively as its SHA-256 digest")
	}
	if !bytes.Equal(storedCSRFDigest, security.DigestToken(session.CSRFToken)) || bytes.Equal(storedCSRFDigest, []byte(session.CSRFToken)) {
		t.Fatal("CSRF token was not persisted exclusively as its SHA-256 digest")
	}
}

func resetTokenFromURL(t *testing.T, resetURL string) string {
	t.Helper()
	parsed, err := url.Parse(resetURL)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Path != "/reset-password" || parsed.RawQuery != "" || !strings.HasPrefix(parsed.Fragment, "token=") {
		t.Fatalf("reset URL must carry its secret only in the fragment: %q", resetURL)
	}
	values, err := url.ParseQuery(parsed.Fragment)
	if err != nil {
		t.Fatal(err)
	}
	token := values.Get("token")
	if token == "" {
		t.Fatalf("reset URL has no token: %q", resetURL)
	}
	return token
}

func assertResetTokenStoredAsDigest(t *testing.T, pool *pgxpool.Pool, accountID uuid.UUID, rawToken string) {
	t.Helper()
	var digest []byte
	if err := pool.QueryRow(testContext(t), `SELECT token_digest FROM password_reset_tokens WHERE account_id = $1`, accountID).Scan(&digest); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(digest, security.DigestToken(rawToken)) || bytes.Equal(digest, []byte(rawToken)) {
		t.Fatal("password-reset token was not persisted exclusively as its SHA-256 digest")
	}
}

func redeemConcurrently(service *auth.Service, rawToken, password string) []error {
	start := make(chan struct{})
	results := make([]error, 2)
	var wait sync.WaitGroup
	wait.Add(len(results))
	for index := range results {
		go func(index int) {
			defer wait.Done()
			<-start
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			results[index] = service.RedeemPasswordReset(ctx, rawToken, password, nil)
		}(index)
	}
	close(start)
	wait.Wait()
	return results
}

func waitForAdvisoryQuery(t *testing.T, pool *pgxpool.Pool, queryFragment string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var waiting bool
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		err := pool.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1
				FROM pg_stat_activity
				WHERE pid <> pg_backend_pid()
				  AND wait_event_type = 'Lock'
				  AND wait_event = 'advisory'
				  AND position($1 in query) > 0
			)`, queryFragment).Scan(&waiting)
		cancel()
		if err != nil {
			t.Fatalf("inspect PostgreSQL lock wait: %v", err)
		}
		if waiting {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for query containing %q to reach the advisory gate", queryFragment)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func assertAuditContainsNoPII(t *testing.T, pool *pgxpool.Pool, forbidden ...string) {
	t.Helper()
	ctx := testContext(t)
	var serialized string
	if err := pool.QueryRow(ctx, `SELECT COALESCE(jsonb_agg(to_jsonb(ae))::text, '[]') FROM audit_events ae`).Scan(&serialized); err != nil {
		t.Fatal(err)
	}
	for _, value := range forbidden {
		if value != "" && strings.Contains(serialized, value) {
			t.Fatalf("audit records contain private or secret value %q", value)
		}
	}
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE metadata <> '{}'::jsonb`, 0)
}
