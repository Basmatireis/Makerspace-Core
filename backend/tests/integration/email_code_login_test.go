package integration_test

import (
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/accounts"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/attendance"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/auth"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	mailservice "github.com/Basmatireis/Makerspace-Core/backend/internal/mail"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/visitor"
	"github.com/jackc/pgx/v5/pgxpool"
)

func enableEmailCode(t *testing.T, pool *pgxpool.Pool, account seededAccount) {
	t.Helper()
	if _, err := pool.Exec(
		testContext(t), `UPDATE auth_identities SET email_code_enabled=true WHERE id=$1`, account.identity,
	); err != nil {
		t.Fatal(err)
	}
}

func newEmailCodeAuth(t *testing.T, pool *pgxpool.Pool) (*auth.Service, *notificationRecorder) {
	t.Helper()
	notifier := newNotificationRecorder()
	service, err := auth.NewService(pool, integrationConfig(t), notifier)
	if err != nil {
		t.Fatal(err)
	}
	return service, notifier
}

func TestEmailCodeRequestDoesNotRevealAccounts(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	service, notifier := newEmailCodeAuth(t, pool)
	eligible := seedAccount(t, pool, "code-eligible", false)
	enableEmailCode(t, pool, eligible)
	seedAccount(t, pool, "code-password-only", false)
	disabled := seedAccount(t, pool, "code-disabled", false)
	enableEmailCode(t, pool, disabled)
	if _, err := pool.Exec(ctx, `UPDATE accounts SET status='disabled' WHERE id=$1`, disabled.accountID); err != nil {
		t.Fatal(err)
	}
	for _, email := range []string{
		"code-eligible@example.test", "nobody@example.test", "code-password-only@example.test",
		"code-disabled@example.test", "not an address",
	} {
		if err := service.RequestEmailCode(ctx, email, "203.0.113.70", nil); err != nil {
			t.Fatalf("request for %q answered %v; every address must get the same answer", email, err)
		}
	}
	if notifier.loginCode(t, "code-eligible@example.test") == "" {
		t.Fatal("the eligible account received no code")
	}
	for _, email := range []string{"code-password-only@example.test", "code-disabled@example.test", "nobody@example.test"} {
		notifier.mu.Lock()
		code := notifier.codes["login:"+email]
		notifier.mu.Unlock()
		if code != "" {
			t.Fatalf("%s received a code", email)
		}
	}
	assertCount(t, pool, `SELECT count(*) FROM auth_challenges WHERE kind='email_login'`, 1)
	assertCount(t, pool, `SELECT count(*) FROM auth_challenges WHERE kind='email_login' AND account_id=$1`, 1, eligible.accountID)
	// Only the code's digest is stored; the request is audited without the address or the code.
	code := notifier.loginCode(t, "code-eligible@example.test")
	assertCount(t, pool, `SELECT count(*) FROM auth_challenges WHERE code_digest=convert_to($1,'UTF8')`, 0, code)
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action='auth.email_code_requested' AND resource_id=$1`, 1,
		eligible.accountID)
}

func TestEmailCodeLoginRejectsWrongExpiredExhaustedAndUsedCodes(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	service, notifier := newEmailCodeAuth(t, pool)
	account := seedAccount(t, pool, "code-login", false)
	enableEmailCode(t, pool, account)
	email := "code-login@example.test"
	request := func() string {
		t.Helper()
		notifier.forgetLoginCode(email)
		if err := service.RequestEmailCode(ctx, email, "203.0.113.71", nil); err != nil {
			t.Fatal(err)
		}
		code := notifier.loginCode(t, email)
		if code == "" {
			t.Fatal("no code mailed")
		}
		return code
	}
	wrongCode := func(code string) string {
		if code == "000000" {
			return "000001"
		}
		return "000000"
	}
	login := func(code string) (auth.LoginResult, error) {
		return service.LoginWithEmailCode(ctx, email, code, "203.0.113.71", nil)
	}

	if _, err := login("123456"); !apperror.IsCode(err, "invalid_credentials") {
		t.Fatalf("login without a requested code error=%v", err)
	}
	code := request()
	if _, err := login(wrongCode(code)); !apperror.IsCode(err, "invalid_credentials") {
		t.Fatalf("wrong code error=%v", err)
	}
	assertCount(t, pool, `SELECT count(*) FROM auth_challenges WHERE account_id=$1 AND attempt_count=1`, 1, account.accountID)
	// Five wrong codes end the code, even for the right one afterwards.
	for range 4 {
		_, _ = login(wrongCode(code))
	}
	if _, err := login(code); !apperror.IsCode(err, "invalid_credentials") {
		t.Fatalf("exhausted code error=%v", err)
	}
	// A new request replaces the code and its attempts; the old code no longer works.
	old := code
	code = request()
	if old != code {
		if _, err := login(old); !apperror.IsCode(err, "invalid_credentials") {
			t.Fatalf("replaced code error=%v", err)
		}
	}
	if _, err := pool.Exec(ctx, `UPDATE auth_challenges SET created_at=now()-interval '20 minutes', expires_at=now()-interval '10 minutes'
		WHERE account_id=$1`,
		account.accountID); err != nil {
		t.Fatal(err)
	}
	if _, err := login(code); !apperror.IsCode(err, "invalid_credentials") {
		t.Fatalf("expired code error=%v", err)
	}
	code = request()
	session, err := loginSession(login(code))
	if err != nil {
		t.Fatal(err)
	}
	authenticated, err := service.Authenticate(ctx, session.Token)
	if err != nil || authenticated.AuthMethod != "email_code" ||
		authenticated.Principal.Assurance != authorization.AssuranceNormal || authenticated.MFASetupRequired {
		t.Fatalf("email code session=%#v err=%v", authenticated, err)
	}
	// Single use.
	if _, err := login(code); !apperror.IsCode(err, "invalid_credentials") {
		t.Fatalf("reused code error=%v", err)
	}
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action='auth.email_code_login_succeeded' AND resource_id=$1`,
		1, account.accountID)

	// Switched off, the method neither mails codes nor accepts outstanding ones.
	code = request()
	if _, err := pool.Exec(ctx, `UPDATE auth_identities SET email_code_enabled=false WHERE id=$1`, account.identity); err != nil {
		t.Fatal(err)
	}
	if _, err := login(code); !apperror.IsCode(err, "invalid_credentials") {
		t.Fatalf("login after switching off error=%v", err)
	}
}

func TestEmailCodeLoginFollowsSecondFactorRules(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	cfg := integrationConfig(t)
	cfg.Environment = "test"
	cfg.EncryptionKeys = [][]byte{make([]byte, 32)}
	notifier := newNotificationRecorder()
	service, err := auth.NewService(pool, cfg, notifier)
	if err != nil {
		t.Fatal(err)
	}
	requestCode := func(email string) string {
		t.Helper()
		if err := service.RequestEmailCode(ctx, email, "203.0.113.72", nil); err != nil {
			t.Fatal(err)
		}
		return notifier.loginCode(t, email)
	}

	// An account with an authenticator app gets a pending login that remembers the emailed code as first step.
	withTOTP := seedAccount(t, pool, "code-totp", false)
	enableEmailCode(t, pool, withTOTP)
	if err := service.EnrollFixtureTOTP(ctx, withTOTP.accountID, []byte("12345678901234567890")); err != nil {
		t.Fatal(err)
	}
	result, err := service.LoginWithEmailCode(ctx, "code-totp@example.test", requestCode("code-totp@example.test"),
		"203.0.113.72", nil)
	if err != nil || result.Pending == nil || result.Session != nil {
		t.Fatalf("login with a second factor=%#v err=%v", result, err)
	}
	assertCount(t, pool, `SELECT count(*) FROM pending_logins WHERE account_id=$1 AND auth_method='email_code'`, 1,
		withTOTP.accountID)

	// A master without a second factor gets a session confined to setting one up.
	master := seedAccount(t, pool, "code-master", true)
	enableEmailCode(t, pool, master)
	result, err = service.LoginWithEmailCode(ctx, "code-master@example.test", requestCode("code-master@example.test"),
		"203.0.113.72", nil)
	if err != nil || result.Session == nil {
		t.Fatalf("master login=%#v err=%v", result, err)
	}
	authenticated, err := service.Authenticate(ctx, result.Session.Token)
	if err != nil || !authenticated.MFASetupRequired {
		t.Fatalf("master email code session=%#v err=%v, want mfaSetupRequired", authenticated, err)
	}
}

func TestTerminalEmailCodeCheckInSurvivesLabRulesRetry(t *testing.T) {
	f := newCheckInFixture(t, "blocking")
	ctx := testContext(t)
	enableEmailCode(t, f.pool, f.visitor)
	authService, notifier := newEmailCodeAuth(t, f.pool)
	service := attendance.NewService(f.pool, authService, f.labRules, nil)
	email := "kiosk-visitor@example.test"
	if err := service.RequestEmailCode(ctx, f.device, email, "kiosk-email", nil); err != nil {
		t.Fatal(err)
	}
	code := notifier.loginCode(t, email)

	wrong := "999999"
	if code == wrong {
		wrong = "999998"
	}
	if _, err := service.EmailCodeCheckIn(ctx, f.device, email, wrong, "kiosk-email", attendance.LabRulesChoice{}, nil); !apperror.IsCode(
		err, "invalid_credentials",
	) {
		t.Fatalf("wrong code check-in error=%v", err)
	}
	// The Lab Rules answer leaves the code unused, so the kiosk repeats the check-in with it after the confirmation.
	if _, err := service.EmailCodeCheckIn(ctx, f.device, email, code, "kiosk-email", attendance.LabRulesChoice{}, nil); !apperror.IsCode(
		err, "lab_rules_confirmation_required",
	) {
		t.Fatalf("first check-in error=%v", err)
	}
	visit, err := service.EmailCodeCheckIn(
		ctx, f.device, email, code, "kiosk-email", attendance.LabRulesChoice{ConfirmVersionID: &f.versionID}, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	assertCount(t, f.pool, `
		SELECT count(*) FROM visits WHERE id=$1 AND check_in_method='email_code' AND check_in_assurance='normal'`, 1, visit.ID)
	assertCount(t, f.pool, `SELECT count(*) FROM laborordnung_confirmations WHERE person_id=$1 AND method='kiosk'`, 1,
		f.visitor.personID)
	// The successful check-in used the code up.
	if _, err := service.EmailCodeCheckOut(ctx, f.device, email, code, "kiosk-email", nil); !apperror.IsCode(
		err, "invalid_credentials",
	) {
		t.Fatalf("check-out with a used code error=%v", err)
	}
	notifier.forgetLoginCode(email)
	if err := service.RequestEmailCode(ctx, f.device, email, "kiosk-email", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := service.EmailCodeCheckOut(ctx, f.device, email, notifier.loginCode(t, email), "kiosk-email", nil); err != nil {
		t.Fatalf("check-out with a fresh code: %v", err)
	}
	assertCount(t, f.pool, `SELECT count(*) FROM auth_challenges WHERE kind='email_check_in' AND used_at IS NOT NULL`, 1)
}

// principalWithFreshPermissions is principalWithPermissions with a normal sign-in that just happened.
func principalWithFreshPermissions(
	t *testing.T,
	pool *pgxpool.Pool,
	suffix string,
	authenticatedAt time.Time,
	permissions ...string,
) (authorization.Principal, seededAccount) {
	t.Helper()
	_, seeded := principalWithPermissions(t, pool, suffix, permissions...)
	principal, err := authorization.LoadPermissionsFrom(testContext(t), pool, authorization.Principal{
		AccountID: seeded.accountID, PersonID: seeded.personID, SessionID: ids.New(),
		Assurance: authorization.AssuranceNormal, AuthenticatedAt: authenticatedAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	return principal, seeded
}

func TestOwnEmailCodeNeedsPermissionAndFreshSignIn(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	service, _ := newEmailCodeAuth(t, pool)
	now := time.Now().UTC()

	denied, deniedAccount := principalWithFreshPermissions(t, pool, "code-self-denied", now)
	if err := service.SetOwnEmailCode(ctx, denied, true, nil); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("enable without permission error=%v", err)
	}
	assertCount(t, pool, `SELECT count(*) FROM auth_identities WHERE id=$1 AND email_code_enabled`, 0, deniedAccount.identity)

	stale, _ := principalWithFreshPermissions(t, pool, "code-self-stale", now.Add(-time.Hour),
		string(authorization.AccountsEmailCodeManageSelf))
	if err := service.SetOwnEmailCode(ctx, stale, true, nil); !apperror.IsCode(err, "fresh_authentication_required") {
		t.Fatalf("enable with a stale sign-in error=%v", err)
	}

	allowed, account := principalWithFreshPermissions(t, pool, "code-self-allowed", now,
		string(authorization.AccountsEmailCodeManageSelf))
	if err := service.SetOwnEmailCode(ctx, allowed, true, nil); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `SELECT count(*) FROM auth_identities WHERE id=$1 AND email_code_enabled`, 1, account.identity)
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action='account.email_code_enabled' AND resource_id=$1`,
		1, account.accountID)
	if _, err := pool.Exec(ctx, `
		INSERT INTO auth_challenges(id,kind,account_id,auth_identity_id,code_digest,delivery_address,expires_at)
		VALUES(uuidv7(),'email_login',$1,$2,$3,'code-self-allowed@example.test',now()+interval '10 minutes')`,
		account.accountID, account.identity, make([]byte, 32)); err != nil {
		t.Fatal(err)
	}
	if err := service.SetOwnEmailCode(ctx, allowed, false, nil); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `SELECT count(*) FROM auth_identities WHERE id=$1 AND email_code_enabled`, 0, account.identity)
	assertCount(t, pool, `SELECT count(*) FROM auth_challenges WHERE account_id=$1`, 0, account.accountID)
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action='account.email_code_disabled' AND resource_id=$1`,
		1, account.accountID)

	// Without a login email there is nothing to mail a code to.
	if _, err := pool.Exec(ctx, `DELETE FROM auth_identities WHERE id=$1`, account.identity); err != nil {
		t.Fatal(err)
	}
	if err := service.SetOwnEmailCode(ctx, allowed, true, nil); !apperror.IsCode(err, "login_email_required") {
		t.Fatalf("enable without a login email error=%v", err)
	}
}

func TestAccountEmailCodeNeedsAdministrativePermission(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	service := accounts.NewService(pool, config.Config{}, nil)
	target := seedAccount(t, pool, "code-admin-target", false)
	masterTarget := seedAccount(t, pool, "code-admin-master", true)
	version := func(account seededAccount) int64 {
		var value int64
		if err := pool.QueryRow(ctx, `SELECT version FROM accounts WHERE id=$1`, account.accountID).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}

	reader, _ := principalWithPermissions(t, pool, "code-admin-reader", string(authorization.AccountsRead),
		string(authorization.AccountsPINEnrollAll))
	if _, err := service.SetEmailCode(ctx, reader, target.accountID, true, version(target), nil); !apperror.IsCode(
		err, "permission_denied",
	) {
		t.Fatalf("enable without permission error=%v", err)
	}
	admin, _ := principalWithPermissions(t, pool, "code-admin", string(authorization.AccountsEmailCodeManageAll))
	updated, err := service.SetEmailCode(ctx, admin, target.accountID, true, version(target), nil)
	if err != nil || !updated.EmailCodeEnabled {
		t.Fatalf("enable=%#v err=%v", updated, err)
	}
	if _, err := service.SetEmailCode(ctx, admin, target.accountID, false, updated.Version-1, nil); !apperror.IsCode(
		err, "stale_write",
	) {
		t.Fatalf("stale version error=%v", err)
	}
	authService, notifier := newEmailCodeAuth(t, pool)
	if err := authService.RequestEmailCode(ctx, "code-admin-target@example.test", "203.0.113.73", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := loginSession(authService.LoginWithEmailCode(
		ctx, "code-admin-target@example.test", notifier.loginCode(t, "code-admin-target@example.test"), "203.0.113.73", nil,
	)); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `SELECT count(*) FROM sessions WHERE account_id=$1 AND revoked_at IS NULL`, 1, target.accountID)
	updated, err = service.SetEmailCode(ctx, admin, target.accountID, false, updated.Version, nil)
	if err != nil || updated.EmailCodeEnabled {
		t.Fatalf("disable=%#v err=%v", updated, err)
	}
	assertCount(t, pool, `SELECT count(*) FROM sessions WHERE account_id=$1 AND revoked_at IS NULL`, 0, target.accountID)
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action IN ('account.email_code_enabled','account.email_code_disabled')
		AND resource_id=$1`, 2, target.accountID)

	// A delegated administrator cannot change a master account.
	if _, err := service.SetEmailCode(ctx, admin, masterTarget.accountID, true, version(masterTarget), nil); !apperror.IsCode(
		err, "permission_denied",
	) {
		t.Fatalf("enable on a master account error=%v", err)
	}
}

func TestVisitorEnrollmentEmailVerification(t *testing.T) {
	e := newConsentEnrollmentEnv(t)
	ctx := testContext(t)

	enrollment := e.begin(t)
	for _, invalid := range []string{"", "  ", "not-an-address", "two@@example.test"} {
		if err := e.service.SendEmailCode(ctx, enrollment, invalid, nil); !apperror.IsCode(err, "email_invalid") {
			t.Fatalf("address %q error=%v, want email_invalid", invalid, err)
		}
	}

	// A provider error stops the kiosk with a clear code and withdraws the code nobody received.
	e.notifier.enrollmentFailure = errors.New("smtp: 550 mailbox unavailable")
	if err := e.service.SendEmailCode(ctx, enrollment, "bounce@example.test", nil); !apperror.IsCode(
		err, "email_delivery_failed",
	) {
		t.Fatalf("delivery failure error=%v", err)
	}
	assertCount(t, e.pool, `SELECT count(*) FROM visitor_enrollment_contexts WHERE id=$1 AND email_code_digest IS NULL`, 1,
		enrollment.ID)
	e.notifier.enrollmentFailure = mailservice.ErrDisabled
	if err := e.service.SendEmailCode(ctx, enrollment, "bounce@example.test", nil); !apperror.IsCode(err, "mail_unavailable") {
		t.Fatalf("disabled mail error=%v", err)
	}
	e.notifier.enrollmentFailure = nil

	email := "verify-me@example.test"
	if err := e.service.SendEmailCode(ctx, enrollment, email, nil); err != nil {
		t.Fatal(err)
	}
	code := e.notifier.enrollmentCode(email)
	wrong := "000000"
	if code == wrong {
		wrong = "000001"
	}
	for range 5 {
		if err := e.service.ConfirmEmail(ctx, enrollment, wrong, nil); !apperror.IsCode(err, "challenge_invalid") {
			t.Fatalf("wrong code error=%v", err)
		}
	}
	if err := e.service.ConfirmEmail(ctx, enrollment, code, nil); !apperror.IsCode(err, "challenge_invalid") {
		t.Fatalf("exhausted code error=%v", err)
	}
	if _, err := e.service.Submit(ctx, enrollment, submission("Unverified", "Visitor"), nil); !apperror.IsCode(
		err, "email_verification_required",
	) {
		t.Fatalf("unverified submission error=%v", err)
	}
	// A new code replaces the exhausted one.
	if err := e.service.SendEmailCode(ctx, enrollment, email, nil); err != nil {
		t.Fatal(err)
	}
	if err := e.service.ConfirmEmail(ctx, enrollment, e.notifier.enrollmentCode(email), nil); err != nil {
		t.Fatal(err)
	}
	assertCount(t, e.pool, `SELECT count(*) FROM audit_events WHERE action='visitor_enrollment.email_verified' AND resource_id=$1`,
		1, enrollment.ID)
	result, err := e.service.Submit(ctx, enrollment, submission("Verified", "Visitor"), nil)
	if err != nil {
		t.Fatal(err)
	}
	assertCount(t, e.pool, `
		SELECT count(*) FROM auth_identities WHERE account_id=$1 AND kind='password' AND identifier_normalized=$2
		  AND email_code_enabled AND verified_at IS NOT NULL`, 1, result.AccountID, email)

	// Each context sends at most a handful of codes.
	limited := e.begin(t)
	var err2 error
	for index := range visitor.EmailCodesPerContext + 1 {
		err2 = e.service.SendEmailCode(ctx, limited, "limit"+string(rune('a'+index))+"@example.test", nil)
	}
	if !apperror.IsCode(err2, "verification_rate_limited") {
		t.Fatalf("sends beyond the limit error=%v", err2)
	}
}

func TestEmailCodeOperationsOverHTTP(t *testing.T) {
	e := newSignageEnv(t)
	client := newCookieClient(t)
	// Requesting a code answers the same for any address.
	for _, email := range []string{"nobody@example.test", "someone@example.test"} {
		response := e.do(client, "", http.MethodPost, "/auth/email-code", map[string]any{"email": email})
		assertStatus(t, response, http.StatusAccepted)
		response.Body.Close()
	}
	e.expectCode(
		e.do(client, "", http.MethodPost, "/auth/email-code/login", map[string]any{"email": "nobody@example.test", "code": "123456"}),
		http.StatusUnauthorized, "invalid_credentials",
	)
	// Without a registered kiosk there is no enrollment context to verify an address in.
	e.expectCode(
		e.do(
			client, "", http.MethodPost, "/visitor-enrollment/email-verification", map[string]any{"email": "a@example.test"},
			"X-Enrollment-CSRF-Token", "not-a-real-enrollment-csrf-token",
		),
		http.StatusNotFound, "not_found",
	)
}
