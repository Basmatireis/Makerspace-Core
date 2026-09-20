package accounts

import (
	"context"

	accountsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/accounts/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
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

// ValidateProvisionedRoleTransfer applies ordinary assignment/delegation rules
// while holding role locks for the caller's transaction. System master roles
// always require explicit assignment and cannot be moved by reconciliation.
func ValidateProvisionedRoleTransfer(ctx context.Context, tx pgx.Tx, principal authorization.Principal, sourceID uuid.UUID) error {
	queries := accountsdb.New(tx)
	roles, err := queries.ListAccountRoles(ctx, sourceID)
	if err != nil {
		return err
	}
	for _, role := range roles {
		if role.SystemKey != nil && *role.SystemKey == "master" {
			return apperror.New(409, "master_role_transfer", "SCIM reconciliation cannot transfer the master role")
		}
		if _, err := authorizeRoleAssignment(ctx, queries, principal, role.ID); err != nil {
			return err
		}
	}
	return nil
}
