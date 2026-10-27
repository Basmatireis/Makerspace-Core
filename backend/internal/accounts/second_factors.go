package accounts

import (
	"context"
	"errors"

	accountsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/accounts/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/optional"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ResetSecondFactors removes every second factor of an account (for a lost authenticator), revokes its sessions,
// and audits it in the same transaction. Only a master may reset a master account.
func (s *Service) ResetSecondFactors(
	ctx context.Context,
	principal authorization.Principal,
	accountID uuid.UUID,
	expectedVersion int64,
	requestID *uuid.UUID,
) (Account, error) {
	if !principal.Has(authorization.AccountsMFAReset) {
		return Account{}, apperror.PermissionDenied
	}
	if expectedVersion < 1 {
		return Account{}, apperror.InvalidField("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Account{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := accountsdb.New(tx)
	account, err := loadAccountForMutation(ctx, queries, accountID)
	if err != nil {
		return Account{}, err
	}
	if err := requireMasterForMasterAccount(ctx, queries, principal, accountID); err != nil {
		return Account{}, err
	}
	if account.Version != expectedVersion {
		return Account{}, apperror.StaleWrite
	}
	if _, err := queries.DeletePasskeysForAccount(ctx, accountID); err != nil {
		return Account{}, err
	}
	if _, err := queries.DeleteTOTPForAccount(ctx, accountID); err != nil {
		return Account{}, err
	}
	if _, err := queries.DeleteRecoveryCodesForAccount(ctx, accountID); err != nil {
		return Account{}, err
	}
	if err := queries.DeletePendingLoginsForAccount(ctx, accountID); err != nil {
		return Account{}, err
	}
	if err := queries.RevokeSessionsForAccount(ctx, accountsdb.RevokeSessionsForAccountParams{
		AccountID: accountID, Reason: optional.Of("second_factors_reset"),
	}); err != nil {
		return Account{}, err
	}
	if _, err := queries.BumpAccountVersion(ctx, accountsdb.BumpAccountVersionParams{
		ID: accountID, ExpectedVersion: expectedVersion,
	}); errors.Is(err, pgx.ErrNoRows) {
		return Account{}, apperror.StaleWrite
	} else if err != nil {
		return Account{}, err
	}
	actor := principal.AccountID
	if err := audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &actor, Action: "account.second_factors_reset", ResourceType: "account",
		ResourceID: &accountID, RequestID: requestID, ChangedFields: []string{"secondFactors"},
	}); err != nil {
		return Account{}, err
	}
	updated, err := loadAccount(ctx, queries, accountID)
	if err != nil {
		return Account{}, err
	}
	if updated, err = withSecondFactors(ctx, tx, updated); err != nil {
		return Account{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Account{}, err
	}
	return updated, nil
}
