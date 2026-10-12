package accounts

import (
	"context"
	"errors"

	accountsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/accounts/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

var scimDeletionBlockers = map[string]*apperror.Error{
	"scim_users_person_id_fkey":  apperror.New(409, "person_scim_managed", "This person is provisioned through SCIM. Remove them in the identity provider instead."),
	"scim_users_account_id_fkey": apperror.New(409, "account_scim_managed", "This account is provisioned through SCIM. Remove it in the identity provider instead."),
}

// DeletionReferenceBlocker explains a foreign-key violation raised while
// deleting a Person or Account, so restricting references surface as an
// actionable conflict instead of an internal error. It returns nil for any
// other error.
func DeletionReferenceBlocker(err error) *apperror.Error {
	var postgresError *pgconn.PgError
	if !errors.As(err, &postgresError) || postgresError.Code != "23503" {
		return nil
	}
	if blocker, ok := scimDeletionBlockers[postgresError.ConstraintName]; ok {
		return blocker
	}
	return apperror.New(409, "deletion_referenced", "Records in "+postgresError.TableName+" still reference it. Remove or reassign them first.")
}

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
