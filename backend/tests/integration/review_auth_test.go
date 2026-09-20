package integration_test

import (
	"context"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/accounts"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/admin"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/auth"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
)

func TestPasswordChallengeCompletionUsesAccountSecurityLock(t *testing.T) {
	for _, kind := range []string{"password_reset", "invitation"} {
		t.Run(kind, func(t *testing.T) {
			pool := migratedPool(t)
			ctx := testContext(t)
			cfg := integrationConfig(t)
			account := seedAccount(t, pool, "locked-challenge", false)
			code := "ABCDE12345"
			if _, err := pool.Exec(ctx, `INSERT INTO auth_challenges
				(id,kind,account_id,auth_identity_id,code_digest,delivery_address,expires_at)
				VALUES ($1,$2,$3,$4,$5,'locked-challenge@example.test',now()+interval '30 minutes')`,
				uuid.Must(uuid.NewV7()), kind, account.accountID, account.identity,
				security.ChallengeDigest(cfg.ChallengeHMACKey, kind, account.accountID, code)); err != nil {
				t.Fatal(err)
			}
			service, err := auth.NewService(pool, cfg)
			if err != nil {
				t.Fatal(err)
			}
			gate, err := pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer gate.Rollback(context.Background())
			if _, err := gate.Exec(ctx, `SELECT id FROM accounts WHERE id=$1 FOR UPDATE`, account.accountID); err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() {
				if kind == "password_reset" {
					done <- service.CompletePasswordResetCode(ctx, "locked-challenge@example.test", code, resetPassword, "review-lock", nil)
				} else {
					done <- service.CompleteInvitation(ctx, "locked-challenge@example.test", code, resetPassword, "review-lock", nil)
				}
			}()
			// Wait for the actual blocked SQL, not a scheduler-dependent sleep.
			deadline := time.Now().Add(5 * time.Second)
			var waitingQuery string
			for time.Now().Before(deadline) {
				err := pool.QueryRow(ctx, `SELECT query FROM pg_stat_activity
					WHERE pid<>pg_backend_pid() AND wait_event_type='Lock'
					AND query LIKE '%GetAccountForAuthentication%' LIMIT 1`).Scan(&waitingQuery)
				if err == nil {
					break
				}
				time.Sleep(10 * time.Millisecond)
			}
			if waitingQuery == "" {
				t.Fatal("challenge completion did not acquire the account lock before mutating credentials")
			}
			if _, err := gate.Exec(ctx, `DELETE FROM auth_challenges WHERE account_id=$1`, account.accountID); err != nil {
				t.Fatal(err)
			}
			if err := gate.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			if err := <-done; !apperror.IsCode(err, "challenge_invalid") {
				t.Fatalf("cancelled challenge completed: %v", err)
			}
		})
	}
}

func TestOIDCSessionRejectsDisabledOrForeignIdentity(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	account := seedAccount(t, pool, "oidc-session", false)
	other := seedAccount(t, pool, "oidc-other", false)
	providerID := insertSCIMOIDCProvider(t, pool, "https://session.example.test")
	identityID := uuid.Must(uuid.NewV7())
	if _, err := pool.Exec(ctx, `INSERT INTO auth_identities(id,account_id,kind,provider_id,issuer,subject)
		VALUES ($1,$2,'oidc',$3,'https://session.example.test','subject')`, identityID, account.accountID, providerID); err != nil {
		t.Fatal(err)
	}
	service, err := auth.NewService(pool, integrationConfig(t))
	if err != nil {
		t.Fatal(err)
	}
	for _, state := range []string{"enabled", "disabled_identity", "disabled_account", "foreign_identity"} {
		t.Run(state, func(t *testing.T) {
			tx, err := pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(ctx)
			targetID := account.accountID
			if state == "disabled_identity" {
				_, err = tx.Exec(ctx, `UPDATE auth_identities SET disabled_at=now() WHERE id=$1`, identityID)
			} else if state == "disabled_account" {
				_, err = tx.Exec(ctx, `UPDATE accounts SET status='disabled' WHERE id=$1`, account.accountID)
			} else if state == "foreign_identity" {
				targetID = other.accountID
			}
			if err != nil {
				t.Fatal(err)
			}
			session, err := service.CreateOIDCSession(ctx, tx, targetID, identityID, authorization.AssuranceNormal)
			if state == "enabled" {
				if err != nil || session.Token == "" {
					t.Fatalf("valid OIDC identity rejected: %v", err)
				}
			} else if !apperror.IsCode(err, "unauthenticated") {
				t.Fatalf("invalid OIDC session accepted: %v", err)
			}
		})
	}
}

func TestAdministrativeCredentialChangesInvalidateOutstandingChallenges(t *testing.T) {
	for _, operation := range []string{"set_password", "change_email", "recover_master"} {
		t.Run(operation, func(t *testing.T) {
			pool := migratedPool(t)
			ctx := testContext(t)
			cfg := integrationConfig(t)
			account := seedAccount(t, pool, "challenge-owner", false)
			principal := authorization.Principal{AccountID: account.accountID, Master: true}
			email := "challenge-owner@example.test"
			code := "ABCDE12345"
			for _, kind := range []string{"password_reset", "invitation", "email_verification"} {
				if _, err := pool.Exec(ctx, `INSERT INTO auth_challenges
					(id, kind, account_id, auth_identity_id, code_digest, delivery_address, expires_at)
					VALUES ($1,$2,$3,$4,$5,$6,now()+interval '30 minutes')`,
					uuid.Must(uuid.NewV7()), kind, account.accountID, account.identity,
					security.ChallengeDigest(cfg.ChallengeHMACKey, kind, account.accountID, code), email); err != nil {
					t.Fatal(err)
				}
			}
			service := accounts.NewService(pool, cfg)
			switch operation {
			case "set_password":
				if _, err := service.SetPassword(ctx, principal, account.accountID, changedPassword, 1, nil); err != nil {
					t.Fatal(err)
				}
			case "change_email":
				if _, err := pool.Exec(ctx, `UPDATE auth_identities SET verified_at=now() WHERE id=$1`, account.identity); err != nil {
					t.Fatal(err)
				}
				email = "replacement@example.test"
				if _, err := service.UpdateLoginEmail(ctx, principal, account.accountID, email, 1, nil); err != nil {
					t.Fatal(err)
				}
				assertCount(t, pool, `SELECT count(*) FROM auth_identities WHERE id=$1 AND verified_at IS NOT NULL`, 0, account.identity)
			case "recover_master":
				if _, err := admin.NewService(pool).RecoverMaster(ctx, email, changedPassword); err != nil {
					t.Fatal(err)
				}
			}
			authService, err := auth.NewService(pool, cfg)
			if err != nil {
				t.Fatal(err)
			}
			if err := authService.CompletePasswordResetCode(ctx, email, code, resetPassword, "review-reset", nil); !apperror.IsCode(err, "challenge_invalid") {
				t.Fatalf("obsolete reset code accepted: %v", err)
			}
			if err := authService.CompleteInvitation(ctx, email, code, resetPassword, "review-invitation", nil); !apperror.IsCode(err, "challenge_invalid") {
				t.Fatalf("obsolete invitation accepted: %v", err)
			}
			if err := authService.CompleteEmailVerification(ctx, email, code, "review-verification", nil); !apperror.IsCode(err, "challenge_invalid") {
				t.Fatalf("obsolete verification accepted: %v", err)
			}
		})
	}
}
