package integration_test

import (
	"sync/atomic"
	"testing"
	"time"

	"context"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/auth"
	mailservice "github.com/Basmatireis/Makerspace-Core/backend/internal/mail"
	"github.com/google/uuid"
)

type countingNotifier struct {
	*notificationRecorder
	resets atomic.Int32
	fail   error
}

func (n *countingNotifier) SendPasswordReset(ctx context.Context, to, code string, expiresAt time.Time) error {
	n.resets.Add(1)
	if n.fail != nil {
		return n.fail
	}
	return n.notificationRecorder.SendPasswordReset(ctx, to, code, expiresAt)
}

func TestPasswordResetReachesAccountsWithoutPasswordCredential(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	cfg := integrationConfig(t)
	notifier := &countingNotifier{notificationRecorder: newNotificationRecorder()}
	service, err := auth.NewService(pool, cfg, notifier)
	if err != nil {
		t.Fatal(err)
	}

	// Login email exists but the member never chose a password.
	pending := seedAccount(t, pool, "reset-no-credential", false)
	if _, err := pool.Exec(ctx, `
		DELETE FROM password_credentials WHERE auth_identity_id IN
		(SELECT id FROM auth_identities WHERE account_id = $1)`, pending.accountID); err != nil {
		t.Fatal(err)
	}
	disabled := seedAccount(t, pool, "reset-disabled", false)
	if _, err := pool.Exec(ctx, `UPDATE accounts SET status='disabled' WHERE id=$1`, disabled.accountID); err != nil {
		t.Fatal(err)
	}

	for _, email := range []string{"reset-disabled@example.test", "reset-unknown@example.test"} {
		if err := service.RequestPasswordReset(ctx, email, "203.0.113.5", nil); err != nil {
			t.Fatalf("request for %s: %v", email, err)
		}
	}
	if notifier.resets.Load() != 0 {
		t.Fatalf("mail sent for disabled or unknown account: %d", notifier.resets.Load())
	}

	requestID := uuid.New()
	if err := service.RequestPasswordReset(ctx, "reset-no-credential@example.test", "203.0.113.5", &requestID); err != nil {
		t.Fatal(err)
	}
	if notifier.resets.Load() != 1 {
		t.Fatalf("sends = %d, want exactly one", notifier.resets.Load())
	}
	var challenges int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM auth_challenges
		WHERE account_id = $1 AND kind = 'password_reset' AND delivery_status = 'sent'`, pending.accountID).
		Scan(&challenges); err != nil || challenges != 1 {
		t.Fatalf("challenges = %d, err = %v", challenges, err)
	}
	code := notifier.code("reset-no-credential@example.test")
	if code == "" {
		t.Fatal("no code delivered")
	}
	if err := service.CompletePasswordResetCode(
		ctx, "reset-no-credential@example.test", code, resetPassword, "203.0.113.5", nil,
	); err != nil {
		t.Fatalf("complete reset: %v", err)
	}
	if _, err := service.Login(ctx, "reset-no-credential@example.test", resetPassword, "203.0.113.5", nil); err != nil {
		t.Fatalf("login with the new password: %v", err)
	}
}

func TestPasswordResetRecordsDisabledMailDistinctly(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	notifier := &countingNotifier{notificationRecorder: newNotificationRecorder(), fail: mailservice.ErrDisabled}
	service, err := auth.NewService(pool, integrationConfig(t), notifier)
	if err != nil {
		t.Fatal(err)
	}
	account := seedAccount(t, pool, "reset-mail-off", false)
	if err := service.RequestPasswordReset(ctx, "reset-mail-off@example.test", "203.0.113.6", nil); err != nil {
		t.Fatal(err)
	}
	var status, failure string
	if err := pool.QueryRow(ctx, `
		SELECT delivery_status, delivery_failure_code FROM auth_challenges
		WHERE account_id = $1 AND kind = 'password_reset'`, account.accountID).Scan(&status, &failure); err != nil {
		t.Fatal(err)
	}
	if status != "failed" || failure != "mail_disabled" {
		t.Fatalf("delivery = %s/%s", status, failure)
	}
}
