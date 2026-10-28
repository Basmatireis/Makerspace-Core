package auth

import (
	"context"
	"time"

	authdb "github.com/Basmatireis/Makerspace-Core/backend/internal/auth/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/privacy"
	"github.com/jackc/pgx/v5"
)

// SessionRetention deletes expired or revoked sessions, expired password
// reset tokens, expired sign-in challenges and stale throttle rows that lie
// before the cutoff: the first three steps of the former admin cleanup.
func SessionRetention() privacy.RetentionHandler {
	return privacy.HandlerFunc(func(ctx context.Context, tx pgx.Tx, action privacy.Action, cutoff time.Time, _ int32) (int64, error) {
		if action != privacy.ActionDelete {
			return 0, privacy.ErrActionUnsupported
		}
		q := authdb.New(tx)
		sessions, err := q.DeleteExpiredSessions(ctx, cutoff)
		if err != nil {
			return 0, err
		}
		resets, err := q.DeleteExpiredPasswordResetTokens(ctx, cutoff)
		if err != nil {
			return sessions, err
		}
		challenges, err := q.DeleteExpiredAuthSecurityState(ctx, cutoff)
		if err != nil {
			return sessions + resets, err
		}
		return sessions + resets + challenges, nil
	})
}

// PendingStateRetention deletes expired pending second-factor logins and
// passkey challenges, which no routine pruned before the privacy registry.
func PendingStateRetention() privacy.RetentionHandler {
	return privacy.HandlerFunc(func(ctx context.Context, tx pgx.Tx, action privacy.Action, cutoff time.Time, _ int32) (int64, error) {
		if action != privacy.ActionDelete {
			return 0, privacy.ErrActionUnsupported
		}
		q := authdb.New(tx)
		logins, err := q.DeleteExpiredPendingLogins(ctx, cutoff)
		if err != nil {
			return 0, err
		}
		challenges, err := q.DeleteExpiredWebAuthnChallenges(ctx, cutoff)
		if err != nil {
			return logins, err
		}
		return logins + challenges, nil
	})
}
