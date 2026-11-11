package integration_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/attendance"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/auth"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
)

// failingMailer is a notifier whose sign-in code mail always fails.
type failingMailer struct{ *notificationRecorder }

func (failingMailer) SendEmailLoginCode(context.Context, string, string, time.Time) error {
	return errors.New("provider down")
}

func rateLimitRow(t *testing.T, f checkInFixture, action string) (attempts int, blocked bool) {
	t.Helper()
	err := f.pool.QueryRow(
		testContext(t),
		`SELECT COALESCE(sum(attempt_count),0)::int, COALESCE(bool_or(blocked_until > now()), false)
		 FROM auth_rate_limits WHERE action=$1`, action,
	).Scan(&attempts, &blocked)
	if err != nil {
		t.Fatal(err)
	}
	return attempts, blocked
}

func TestKioskCodeRequestsAreLimitedPerDeviceNotPerClient(t *testing.T) {
	f := newCheckInFixture(t, "not_required")
	ctx := testContext(t)
	authService, _ := newEmailCodeAuth(t, f.pool)
	kiosk := attendance.NewService(f.pool, authService, f.labRules, nil)
	setKioskMethods(t, f, []string{"email_code"}, []string{"email_code"}, false)

	// Many visitors at one tablet exceed the web budget of twenty per client without being blocked.
	for index := range 25 {
		if err := kiosk.RequestEmailCode(ctx, f.device, fmt.Sprintf("visitor-%d@example.test", index), nil); err != nil {
			t.Fatal(err)
		}
	}
	attempts, blocked := rateLimitRow(t, f, "email_code_request_kiosk")
	if attempts != 25 || blocked {
		t.Fatalf("kiosk device budget: attempts=%d blocked=%v", attempts, blocked)
	}
	if attempts, _ = rateLimitRow(t, f, "email_code_request_source"); attempts != 0 {
		t.Fatalf("kiosk requests used the per-client budget: %d", attempts)
	}

	// The web login keeps the per-client bound of twenty.
	for index := range 21 {
		if err := authService.RequestEmailCode(ctx, fmt.Sprintf("web-%d@example.test", index), "203.0.113.90", nil); err != nil {
			t.Fatal(err)
		}
	}
	if _, blocked = rateLimitRow(t, f, "email_code_request_source"); !blocked {
		t.Fatal("the twenty-first web request from one client was not limited")
	}
}

func TestKioskCodeRequestsKeepThePerAddressLimit(t *testing.T) {
	f := newCheckInFixture(t, "not_required")
	ctx := testContext(t)
	enableEmailCode(t, f.pool, f.visitor)
	authService, notifier := newEmailCodeAuth(t, f.pool)
	kiosk := attendance.NewService(f.pool, authService, f.labRules, nil)
	setKioskMethods(t, f, []string{"email_code"}, []string{"email_code"}, false)
	email := "kiosk-visitor@example.test"
	for range 5 {
		if err := kiosk.RequestEmailCode(ctx, f.device, email, nil); err != nil {
			t.Fatal(err)
		}
	}
	if notifier.loginCode(t, email) == "" {
		t.Fatal("no code mailed within the address budget")
	}
	// The five requests issue their codes after they were answered; let the last one finish.
	time.Sleep(500 * time.Millisecond)
	notifier.forgetLoginCode(email)
	// Still answered like any request, but nothing is mailed.
	if err := kiosk.RequestEmailCode(ctx, f.device, email, nil); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	notifier.mu.Lock()
	code := notifier.codes["login:"+email]
	notifier.mu.Unlock()
	if code != "" {
		t.Fatal("a sixth code was mailed to one address within fifteen minutes")
	}
}

func TestAdminSendsSignInCode(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	service, notifier := newEmailCodeAuth(t, pool)
	admin, _ := principalWithFreshPermissions(t, pool, "code-admin", time.Now().UTC(),
		string(authorization.AccountsEmailCodeManageAll))
	target := seedAccount(t, pool, "code-admin-target", false)
	email := "code-admin-target@example.test"

	// Without the permission nothing happens.
	plain, _ := principalWithFreshPermissions(t, pool, "code-admin-plain", time.Now().UTC())
	if _, err := service.SendEmailCodeAsAdmin(ctx, plain, target.accountID, nil); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("send without permission error=%v", err)
	}
	// The method must be on.
	if _, err := service.SendEmailCodeAsAdmin(ctx, admin, target.accountID, nil); !apperror.IsCode(err, "email_code_not_enabled") {
		t.Fatalf("send with the method off error=%v", err)
	}
	enableEmailCode(t, pool, target)
	if _, err := service.SendEmailCodeAsAdmin(ctx, admin, [16]byte{1}, nil); !apperror.IsCode(err, "not_found") {
		t.Fatalf("send to an unknown account error=%v", err)
	}

	result, err := service.SendEmailCodeAsAdmin(ctx, admin, target.accountID, nil)
	if err != nil || result.Delivery != auth.DeliverySent || result.Address != email {
		t.Fatalf("send = %+v, %v", result, err)
	}
	code := notifier.loginCode(t, email)
	if code == "" {
		t.Fatal("no code mailed")
	}
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action='auth.email_code_sent_by_admin' AND resource_id=$1 AND actor_account_id=$2`,
		1, target.accountID, admin.AccountID)
	assertCount(t, pool, `SELECT count(*) FROM auth_challenges WHERE kind='email_login' AND account_id=$1 AND delivery_status='sent'`,
		1, target.accountID)
	// The code is a normal web code.
	if _, err := loginSession(service.LoginWithEmailCode(ctx, email, code, "203.0.113.95", nil)); err != nil {
		t.Fatalf("sign-in with the sent code: %v", err)
	}

	// Disabled accounts and pending password resets get no code.
	if _, err := pool.Exec(ctx, `UPDATE accounts SET status='disabled' WHERE id=$1`, target.accountID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.SendEmailCodeAsAdmin(ctx, admin, target.accountID, nil); !apperror.IsCode(err, "email_code_unavailable") {
		t.Fatalf("send to a disabled account error=%v", err)
	}
}

func TestAdminSendIsLimitedPerAddressAndReportsFailedDelivery(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	notifier := newNotificationRecorder()
	service, err := auth.NewService(pool, integrationConfig(t), failingMailer{notifier})
	if err != nil {
		t.Fatal(err)
	}
	admin, _ := principalWithFreshPermissions(t, pool, "code-limit-admin", time.Now().UTC(),
		string(authorization.AccountsEmailCodeManageAll))
	target := seedAccount(t, pool, "code-limit-target", false)
	enableEmailCode(t, pool, target)
	for range 5 {
		result, err := service.SendEmailCodeAsAdmin(ctx, admin, target.accountID, nil)
		if err != nil || result.Delivery != auth.DeliveryFailed {
			t.Fatalf("send with failing mail = %+v, %v", result, err)
		}
	}
	assertCount(t, pool, `SELECT count(*) FROM auth_challenges WHERE account_id=$1 AND delivery_status='failed'`, 1, target.accountID)
	if _, err := service.SendEmailCodeAsAdmin(ctx, admin, target.accountID, nil); !apperror.IsCode(err, "email_code_rate_limited") {
		t.Fatalf("sixth send error=%v", err)
	}
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action='auth.email_code_sent_by_admin'`, 5)
}

func TestAdminSendProtectsMasterAccounts(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	service, notifier := newEmailCodeAuth(t, pool)
	masterTarget := seedAccount(t, pool, "code-master-send-target", true)
	enableEmailCode(t, pool, masterTarget)
	admin, _ := principalWithFreshPermissions(t, pool, "code-nonmaster-admin", time.Now().UTC(),
		string(authorization.AccountsEmailCodeManageAll))
	if _, err := service.SendEmailCodeAsAdmin(ctx, admin, masterTarget.accountID, nil); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("non-master sending to a master error=%v", err)
	}
	assertCount(t, pool, `SELECT count(*) FROM auth_challenges WHERE account_id=$1`, 0, masterTarget.accountID)
	masterActor := seedAccount(t, pool, "code-master-send-actor", true)
	master := authorization.Principal{AccountID: masterActor.accountID, PersonID: masterActor.personID, Master: true}
	if result, err := service.SendEmailCodeAsAdmin(ctx, master, masterTarget.accountID, nil); err != nil || result.Delivery != auth.DeliverySent {
		t.Fatalf("master sending to a master = %+v, %v", result, err)
	}
	if notifier.loginCode(t, "code-master-send-target@example.test") == "" {
		t.Fatal("no code mailed to the master")
	}
}

func TestAdminSendRequiresLoginEmail(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	service, _ := newEmailCodeAuth(t, pool)
	admin, _ := principalWithFreshPermissions(t, pool, "code-noemail-admin", time.Now().UTC(),
		string(authorization.AccountsEmailCodeManageAll))
	target := seedAccount(t, pool, "code-noemail-target", false)
	if _, err := pool.Exec(ctx, `DELETE FROM auth_identities WHERE id=$1`, target.identity); err != nil {
		t.Fatal(err)
	}
	if _, err := service.SendEmailCodeAsAdmin(ctx, admin, target.accountID, nil); !apperror.IsCode(err, "login_email_required") {
		t.Fatalf("send without a login email error=%v", err)
	}
}
