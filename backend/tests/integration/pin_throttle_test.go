package integration_test

import (
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/auth"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
)

func TestPINThrottleBacksOffAndForgetsQuietSources(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	authService, err := auth.NewService(pool, integrationConfig(t))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM pin_login_throttles`); err != nil {
		t.Fatal(err)
	}

	if _, err := authService.LoginWithPIN(ctx, "nobody.here", "123456", "203.0.113.40", nil); !apperror.IsCode(
		err,
		"invalid_credentials",
	) {
		t.Fatalf("first wrong PIN returned %v, want invalid_credentials", err)
	}
	if _, err := authService.LoginWithPIN(ctx, "someone.else", "123456", "203.0.113.40", nil); !apperror.IsCode(
		err,
		"login_rate_limited",
	) {
		t.Fatalf("PIN attempt during back-off returned %v, want login_rate_limited", err)
	}

	// Simulate a key that reached the maximum back-off and then stayed quiet.
	if _, err := pool.Exec(ctx, `UPDATE pin_login_throttles SET failure_count=20, blocked_until=now() - interval '1 second', updated_at=now() - interval '16 minutes'`); err != nil {
		t.Fatal(err)
	}
	if _, err := authService.LoginWithPIN(ctx, "nobody.here", "123456", "203.0.113.40", nil); !apperror.IsCode(
		err,
		"invalid_credentials",
	) {
		t.Fatalf("PIN attempt after quiet period returned %v, want invalid_credentials", err)
	}
	assertCount(
		t,
		pool,
		`SELECT count(*) FROM pin_login_throttles WHERE failure_count=1 AND blocked_until <= now() + interval '2 seconds'`,
		2,
	)
}
