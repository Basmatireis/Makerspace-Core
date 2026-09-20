package accounts

import (
	"context"

	accountsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/accounts/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// LockProvisionedAccount serializes an authenticated provisioning workflow with
// local credential changes and master removal. The caller owns the transaction
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
	return protectLastMaster(ctx, queries, Account{ID: row.ID, Status: row.Status})
}
