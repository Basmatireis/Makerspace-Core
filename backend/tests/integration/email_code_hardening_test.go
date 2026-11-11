package integration_test

import (
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/accounts"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/attendance"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/auth"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
)

// otherCode returns a well-formed code that differs from code.
func otherCode(code string) string {
	if code == "000000" {
		return "000001"
	}
	return "000000"
}

// requestLoginCode requests a web sign-in code and waits for its mail.
func requestLoginCode(t *testing.T, service *auth.Service, notifier *notificationRecorder, email string) string {
	t.Helper()
	notifier.forgetLoginCode(email)
	if err := service.RequestEmailCode(testContext(t), email, "203.0.113.80", nil); err != nil {
		t.Fatal(err)
	}
	code := notifier.loginCode(t, email)
	if code == "" {
		t.Fatalf("no code mailed to %s", email)
	}
	return code
}

func TestEmailCodeFailureBudgetSpansCodes(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	service, notifier := newEmailCodeAuth(t, pool)
	account := seedAccount(t, pool, "code-budget", false)
	enableEmailCode(t, pool, account)
	email := "code-budget@example.test"
	attempt := 0
	wrongLogin := func(code string) {
		t.Helper()
		attempt++
		// A fresh source each time keeps the in-memory login limiter out of the way: the budget is what is tested.
		if _, err := service.LoginWithEmailCode(ctx, email, otherCode(code), fmt.Sprintf("198.51.100.%d", attempt), nil); !apperror.IsCode(
			err, "invalid_credentials",
		) {
			t.Fatalf("wrong code error=%v", err)
		}
	}
	// A new code resets the per-code attempts, but not the account's budget.
	code := requestLoginCode(t, service, notifier, email)
	for range 5 {
		wrongLogin(code)
	}
	code = requestLoginCode(t, service, notifier, email)
	for range 4 {
		wrongLogin(code)
	}
	code = requestLoginCode(t, service, notifier, email)
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action='auth.email_code_blocked'`, 0)
	wrongLogin(code)
	assertCount(t, pool, `SELECT count(*) FROM email_code_failures WHERE account_id=$1`, 10, account.accountID)
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action='auth.email_code_blocked' AND resource_id=$1`, 1,
		account.accountID)
	// Used up: even the right code is refused like a wrong one, and no new code is issued.
	if _, err := service.LoginWithEmailCode(ctx, email, code, "198.51.100.200", nil); !apperror.IsCode(err, "invalid_credentials") {
		t.Fatalf("login with a used-up budget error=%v", err)
	}
	notifier.forgetLoginCode(email)
	if err := service.RequestEmailCode(ctx, email, "198.51.100.201", nil); err != nil {
		t.Fatalf("request with a used-up budget answered %v; it must look like any other request", err)
	}
	time.Sleep(300 * time.Millisecond)
	notifier.mu.Lock()
	issued := notifier.codes["login:"+email]
	notifier.mu.Unlock()
	if issued != "" {
		t.Fatal("a code was mailed although the budget is used up")
	}
	// Wrong codes older than a day no longer count.
	if _, err := pool.Exec(ctx, `UPDATE email_code_failures SET failed_at=now()-interval '25 hours' WHERE account_id=$1`,
		account.accountID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM auth_rate_limits`); err != nil {
		t.Fatal(err)
	}
	code = requestLoginCode(t, service, notifier, email)
	if _, err := loginSession(service.LoginWithEmailCode(ctx, email, code, "198.51.100.202", nil)); err != nil {
		t.Fatalf("login after the window: %v", err)
	}
}

func TestEmailCodesWorkOnlyForTheirPurposeAndAccount(t *testing.T) {
	f := newCheckInFixture(t, "not_required")
	ctx := testContext(t)
	enableEmailCode(t, f.pool, f.visitor)
	authService, notifier := newEmailCodeAuth(t, f.pool)
	kiosk := attendance.NewService(f.pool, authService, f.labRules, nil)
	email := "kiosk-visitor@example.test"

	// A web code does not check in.
	webCode := requestLoginCode(t, authService, notifier, email)
	if _, err := kiosk.EmailCodeCheckIn(ctx, f.device, email, webCode, "kiosk-purpose", attendance.LabRulesChoice{}, nil); !apperror.IsCode(
		err, "invalid_credentials",
	) {
		t.Fatalf("check-in with a web code error=%v", err)
	}
	// A kiosk code does not sign in on the web, and wrong kiosk codes count toward the budget.
	notifier.forgetLoginCode(email)
	if err := kiosk.RequestEmailCode(ctx, f.device, email, nil); err != nil {
		t.Fatal(err)
	}
	kioskCode := notifier.loginCode(t, email)
	if _, err := authService.LoginWithEmailCode(ctx, email, kioskCode, "web-purpose", nil); !apperror.IsCode(
		err, "invalid_credentials",
	) {
		t.Fatalf("web login with a kiosk code error=%v", err)
	}
	if _, err := kiosk.EmailCodeCheckIn(
		ctx, f.device, email, otherCode(kioskCode), "kiosk-purpose", attendance.LabRulesChoice{}, nil,
	); !apperror.IsCode(err, "invalid_credentials") {
		t.Fatalf("wrong kiosk code error=%v", err)
	}
	// The kiosk code tried on the web was a wrong web code, and the wrong kiosk code another failure.
	assertCount(t, f.pool, `SELECT count(*) FROM email_code_failures WHERE account_id=$1`, 2, f.visitor.accountID)

	// Another account's code does not work with this address.
	other := seedAccount(t, f.pool, "code-other", false)
	enableEmailCode(t, f.pool, other)
	otherWebCode := requestLoginCode(t, authService, notifier, "code-other@example.test")
	if otherWebCode != webCode {
		if _, err := authService.LoginWithEmailCode(ctx, email, otherWebCode, "web-cross", nil); !apperror.IsCode(
			err, "invalid_credentials",
		) {
			t.Fatalf("login with another account's code error=%v", err)
		}
	}
	// Both of this account's codes are still usable for their own purpose.
	if _, err := loginSession(authService.LoginWithEmailCode(ctx, email, webCode, "web-purpose", nil)); err != nil {
		t.Fatalf("web code on the web: %v", err)
	}
	if _, err := kiosk.EmailCodeCheckIn(ctx, f.device, email, kioskCode, "kiosk-purpose", attendance.LabRulesChoice{}, nil); err != nil {
		t.Fatalf("kiosk code at the kiosk: %v", err)
	}
}

func TestEmailCodeRefusesBlockedAccounts(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	service, notifier := newEmailCodeAuth(t, pool)

	// A pending password reset blocks the emailed code like the password.
	reset := seedAccount(t, pool, "code-reset", false)
	enableEmailCode(t, pool, reset)
	code := requestLoginCode(t, service, notifier, "code-reset@example.test")
	if _, err := pool.Exec(ctx, `UPDATE password_credentials SET reset_required=true WHERE auth_identity_id=$1`, reset.identity); err != nil {
		t.Fatal(err)
	}
	if _, err := service.LoginWithEmailCode(ctx, "code-reset@example.test", code, "203.0.113.81", nil); !apperror.IsCode(
		err, "invalid_credentials",
	) {
		t.Fatalf("reset-required login error=%v", err)
	}

	// A disabled account cannot use a code it received before.
	disabled := seedAccount(t, pool, "code-later-disabled", false)
	enableEmailCode(t, pool, disabled)
	code = requestLoginCode(t, service, notifier, "code-later-disabled@example.test")
	if _, err := pool.Exec(ctx, `UPDATE accounts SET status='disabled' WHERE id=$1`, disabled.accountID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.LoginWithEmailCode(ctx, "code-later-disabled@example.test", code, "203.0.113.81", nil); !apperror.IsCode(
		err, "invalid_credentials",
	) {
		t.Fatalf("disabled account login error=%v", err)
	}

	// Without web.sign_in the sign-in is refused and the code stays unused.
	visitor := seedAccount(t, pool, "code-no-web", false)
	enableEmailCode(t, pool, visitor)
	code = requestLoginCode(t, service, notifier, "code-no-web@example.test")
	revokeWebSignIn(t, pool)
	if _, err := service.LoginWithEmailCode(ctx, "code-no-web@example.test", code, "203.0.113.81", nil); !apperror.IsCode(
		err, auth.WebSignInNotPermittedCode,
	) {
		t.Fatalf("login without web.sign_in error=%v", err)
	}
	assertCount(t, pool, `SELECT count(*) FROM auth_challenges WHERE account_id=$1 AND used_at IS NULL`, 1, visitor.accountID)
}

func TestPendingEmailCodeLoginEndsWhenTheMethodIsSwitchedOff(t *testing.T) {
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
	account := seedAccount(t, pool, "code-pending", false)
	enableEmailCode(t, pool, account)
	secret := []byte("12345678901234567890")
	if err := service.EnrollFixtureTOTP(ctx, account.accountID, secret); err != nil {
		t.Fatal(err)
	}
	code := requestLoginCode(t, service, notifier, "code-pending@example.test")
	result, err := service.LoginWithEmailCode(ctx, "code-pending@example.test", code, "203.0.113.82", nil)
	if err != nil || result.Pending == nil {
		t.Fatalf("pending login=%#v err=%v", result, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE auth_identities SET email_code_enabled=false WHERE id=$1`, account.identity); err != nil {
		t.Fatal(err)
	}
	totp := security.HOTP(secret, uint64(security.TOTPStep(time.Now())), security.TOTPDigits)
	if _, err := service.CompleteSecondFactorLogin(ctx, result.Pending.Token, auth.SecondFactorTOTP, totp, nil); !apperror.IsCode(
		err, "second_factor_pending_invalid",
	) {
		t.Fatalf("second factor after switching off error=%v", err)
	}
}

func TestEmailCodeSwitchSessionsAndMasterAccounts(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	service, notifier := newEmailCodeAuth(t, pool)

	// Switching the own method off ends the account's other sessions and keeps the current one.
	principal, account := principalWithFreshPermissions(t, pool, "code-self-sessions", time.Now().UTC(),
		string(authorization.AccountsEmailCodeManageSelf))
	enableEmailCode(t, pool, account)
	email := "code-self-sessions@example.test"
	current, err := loginSession(service.LoginWithEmailCode(ctx, email, requestLoginCode(t, service, notifier, email), "a", nil))
	if err != nil {
		t.Fatal(err)
	}
	other, err := loginSession(service.LoginWithEmailCode(ctx, email, requestLoginCode(t, service, notifier, email), "b", nil))
	if err != nil {
		t.Fatal(err)
	}
	principal.SessionID = current.ID
	if err := service.SetOwnEmailCode(ctx, principal, false, nil); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `SELECT count(*) FROM sessions WHERE id=$1 AND revoked_at IS NULL`, 1, current.ID)
	assertCount(t, pool, `SELECT count(*) FROM sessions WHERE id=$1 AND revoked_at IS NOT NULL`, 1, other.ID)

	// A master may change another master account.
	accountService := accounts.NewService(pool, config.Config{}, nil)
	masterTarget := seedAccount(t, pool, "code-master-target", true)
	masterActor := seedAccount(t, pool, "code-master-actor", true)
	master := authorization.Principal{AccountID: masterActor.accountID, PersonID: masterActor.personID, Master: true}
	var version int64
	if err := pool.QueryRow(ctx, `SELECT version FROM accounts WHERE id=$1`, masterTarget.accountID).Scan(&version); err != nil {
		t.Fatal(err)
	}
	updated, err := accountService.SetEmailCode(ctx, master, masterTarget.accountID, true, version, nil)
	if err != nil || !updated.EmailCodeEnabled {
		t.Fatalf("master changing a master account=%#v err=%v", updated, err)
	}
}

func TestConcurrentKioskUseOfOneCodeSucceedsOnce(t *testing.T) {
	f := newCheckInFixture(t, "not_required")
	ctx := testContext(t)
	enableEmailCode(t, f.pool, f.visitor)
	authService, notifier := newEmailCodeAuth(t, f.pool)
	kiosk := attendance.NewService(f.pool, authService, f.labRules, nil)
	email := "kiosk-visitor@example.test"
	if err := kiosk.RequestEmailCode(ctx, f.device, email, nil); err != nil {
		t.Fatal(err)
	}
	code := notifier.loginCode(t, email)
	var wait sync.WaitGroup
	results := make([]error, 4)
	for index := range results {
		wait.Go(func() {
			_, results[index] = kiosk.EmailCodeCheckIn(
				ctx, f.device, email, code, fmt.Sprintf("kiosk-race-%d", index), attendance.LabRulesChoice{}, nil,
			)
		})
	}
	wait.Wait()
	succeeded := 0
	for _, err := range results {
		if err == nil {
			succeeded++
		} else if !apperror.IsCode(err, "invalid_credentials") && !apperror.IsCode(err, "already_checked_in") {
			t.Fatalf("concurrent check-in error=%v", err)
		}
	}
	if succeeded != 1 {
		t.Fatalf("%d concurrent check-ins with one code succeeded, want 1", succeeded)
	}
	assertCount(t, f.pool, `SELECT count(*) FROM visits WHERE person_id=$1`, 1, f.visitor.personID)
	assertCount(t, f.pool, `SELECT count(*) FROM auth_challenges WHERE kind='email_check_in' AND used_at IS NOT NULL`, 1)
}

func TestEnrollmentCodesAreBoundToTheirContext(t *testing.T) {
	e := newConsentEnrollmentEnv(t)
	ctx := testContext(t)
	first, second := e.begin(t), e.begin(t)
	if err := e.service.SendEmailCode(ctx, first, "first-context@example.test", nil); err != nil {
		t.Fatal(err)
	}
	if err := e.service.SendEmailCode(ctx, second, "second-context@example.test", nil); err != nil {
		t.Fatal(err)
	}
	firstCode, secondCode := e.notifier.enrollmentCode("first-context@example.test"), e.notifier.enrollmentCode("second-context@example.test")
	if firstCode != secondCode {
		if err := e.service.ConfirmEmail(ctx, second, firstCode, nil); !apperror.IsCode(err, "challenge_invalid") {
			t.Fatalf("code of another context error=%v", err)
		}
	}
	if err := e.service.ConfirmEmail(ctx, second, secondCode, nil); err != nil {
		t.Fatal(err)
	}

	// Refused addresses count against the context's sends, so a kiosk cannot probe addresses without limit.
	existing := seedAccount(t, e.pool, "enroll-existing", false)
	_ = existing
	probing := e.begin(t)
	for range 5 {
		if err := e.service.SendEmailCode(ctx, probing, "enroll-existing@example.test", nil); !apperror.IsCode(
			err, "authentication_identifier_exists",
		) && !apperror.IsCode(err, "verification_rate_limited") {
			t.Fatalf("existing address error=%v", err)
		}
	}
	assertCount(t, e.pool, `SELECT count(*) FROM visitor_enrollment_contexts WHERE id=$1 AND email_codes_sent=5`, 1, probing.ID)
	if err := e.service.SendEmailCode(ctx, probing, "fresh-after-probing@example.test", nil); !apperror.IsCode(
		err, "verification_rate_limited",
	) {
		t.Fatalf("send after probing error=%v", err)
	}
}
