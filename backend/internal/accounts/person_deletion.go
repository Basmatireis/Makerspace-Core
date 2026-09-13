package accounts

import (
	"context"
	"errors"

	accountsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/accounts/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// AuthorizePersonDeletion enforces the Account-owned rules that apply when a
// Person deletion would cascade through an attached Account. The caller passes
// its open transaction so the permission and last-master checks are serialized
// with the eventual Person deletion.
func AuthorizePersonDeletion(
	ctx context.Context,
	db accountsdb.DBTX,
	principal authorization.Principal,
	personID uuid.UUID,
) error {
	queries := accountsdb.New(db)
	// Every operation that can remove an enabled master takes this transaction
	// lock before locking an Account row. This keeps recovery and HTTP mutation
	// lock ordering consistent.
	if err := queries.AcquireMasterInvariantLock(ctx); err != nil {
		return err
	}
	account, err := queries.GetAccountByPersonForMutation(ctx, personID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if !principal.Has(authorization.AccountsDelete) {
		return apperror.PermissionDenied
	}
	return protectLastMaster(ctx, queries, Account{ID: account.ID, Status: account.Status})
}
