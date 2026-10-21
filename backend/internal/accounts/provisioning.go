package accounts

import (
	"context"
	"errors"
	"time"

	accountsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/accounts/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
)

// LockProvisionedAccount serializes an authenticated provisioning workflow with
// local credential changes and master-sensitive Account deactivation. The caller owns the transaction
// and must authorize its connector or reconciliation operator before calling
// this service boundary.
func LockProvisionedAccount(ctx context.Context, tx pgx.Tx, id uuid.UUID) error {
	queries := accountsdb.New(tx)
	if err := queries.AcquireMasterInvariantLock(ctx); err != nil {
		return err
	}
	_, err := queries.GetAccountForMutation(ctx, id)
	return err
}

// ProtectProvisionedAccountDeactivation applies the same last-master invariant
// as local account disablement. Call after LockProvisionedAccount, before any
// deactivation is committed.
func ProtectProvisionedAccountDeactivation(ctx context.Context, tx pgx.Tx, id uuid.UUID) error {
	queries := accountsdb.New(tx)
	row, err := queries.GetAccountForMutation(ctx, id)
	if err != nil {
		return err
	}
	return protectLastMaster(ctx, queries, Account{ID: row.ID, Status: authorization.AccountStatus(row.Status)})
}

// SetProvisionedLoginEmail gives a provisioned account (SCIM, OIDC JIT, visitor enrollment) its login email and
// mirrors it into the person row, so the person has exactly one email. The caller owns the transaction and has
// created or locked the person before the account. A changed address invalidates outstanding password reset
// tokens and challenges. A login email already held by another account surfaces as a unique violation (SQLSTATE
// 23505) so protocol adapters can map it; use TrySetProvisionedLoginEmail where a collision must not fail the flow.
func SetProvisionedLoginEmail(
	ctx context.Context,
	tx pgx.Tx,
	accountID uuid.UUID,
	display, normalized string,
	verified bool,
) error {
	queries := accountsdb.New(tx)
	previous, err := queries.GetIdentityByAccount(ctx, accountID)
	hadIdentity := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	var verifiedAt pgtype.Timestamptz
	if verified {
		verifiedAt = pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true}
	}
	if _, err := queries.UpsertPasswordIdentity(ctx, accountsdb.UpsertPasswordIdentityParams{
		ID: ids.New(), AccountID: accountID, IdentifierDisplay: display, IdentifierNormalized: normalized,
		VerifiedAt: verifiedAt,
	}); err != nil {
		return err
	}
	if hadIdentity && previous.IdentifierNormalized != nil && *previous.IdentifierNormalized != normalized {
		if err := queries.DeletePasswordResetForAccount(ctx, accountID); err != nil {
			return err
		}
		if err := queries.DeletePasswordChallengesForAccount(ctx, accountID); err != nil {
			return err
		}
	}
	return queries.SyncPersonEmailFromLoginEmail(ctx, accountID)
}

// TrySetProvisionedLoginEmail is SetProvisionedLoginEmail for flows that must continue when another account
// already uses the address: it reports false and leaves the account without a login email in that case. The
// attempt runs in a savepoint so the collision does not abort the caller's transaction.
func TrySetProvisionedLoginEmail(
	ctx context.Context,
	tx pgx.Tx,
	accountID uuid.UUID,
	display, normalized string,
	verified bool,
) (bool, error) {
	savepoint, err := tx.Begin(ctx)
	if err != nil {
		return false, err
	}
	if err := SetProvisionedLoginEmail(ctx, savepoint, accountID, display, normalized, verified); err != nil {
		_ = savepoint.Rollback(ctx)
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return false, nil
		}
		return false, err
	}
	return true, savepoint.Commit(ctx)
}

// SyncPersonEmailFromLoginEmail restores people.email from the account's login email, for flows that rewrite the
// person row (SCIM replace) and must not drop the mirrored value.
func SyncPersonEmailFromLoginEmail(ctx context.Context, tx pgx.Tx, accountID uuid.UUID) error {
	return accountsdb.New(tx).SyncPersonEmailFromLoginEmail(ctx, accountID)
}
