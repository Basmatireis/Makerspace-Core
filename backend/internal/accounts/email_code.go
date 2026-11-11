package accounts

import (
	"context"
	"errors"

	accountsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/accounts/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/auth"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/optional"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// SetEmailCode switches sign-in with an emailed code on or off for an account. Only a master may change a master
// account. Switching it off deletes outstanding codes and revokes the account's sessions.
func (s *Service) SetEmailCode(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	enabled bool,
	expectedVersion int64,
	requestID *uuid.UUID,
) (Account, error) {
	if !principal.Has(authorization.AccountsEmailCodeManageAll) {
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
	current, err := loadAccountForMutation(ctx, queries, id)
	if err != nil {
		return Account{}, err
	}
	if current.Version != expectedVersion {
		return Account{}, apperror.StaleWrite
	}
	if err := requireMasterForMasterAccount(ctx, queries, principal, id); err != nil {
		return Account{}, err
	}
	identity, err := queries.GetIdentityByAccount(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		if enabled {
			return Account{}, auth.LoginEmailRequired()
		}
		return current, nil
	}
	if err != nil {
		return Account{}, err
	}
	changed, err := queries.SetEmailCodeEnabled(ctx, accountsdb.SetEmailCodeEnabledParams{ID: identity.ID, Enabled: enabled})
	if err != nil {
		return Account{}, err
	}
	if changed == 0 {
		return current, nil
	}
	action := "account.email_code_enabled"
	if !enabled {
		action = "account.email_code_disabled"
		if err := queries.DeleteEmailLoginChallengesForAccount(ctx, id); err != nil {
			return Account{}, err
		}
		if err := queries.RevokeSessionsForAccount(ctx, accountsdb.RevokeSessionsForAccountParams{
			AccountID: id, Reason: optional.Of("email_code_disabled"),
		}); err != nil {
			return Account{}, err
		}
	}
	if _, err := queries.BumpAccountVersion(
		ctx,
		accountsdb.BumpAccountVersionParams{ID: id, ExpectedVersion: expectedVersion},
	); errors.Is(err, pgx.ErrNoRows) {
		return Account{}, apperror.StaleWrite
	} else if err != nil {
		return Account{}, err
	}
	actor := principal.AccountID
	if err := audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &actor, Action: action, ResourceType: "account", ResourceID: &id,
		RequestID: requestID, ChangedFields: []string{"emailCodeMethod"},
	}); err != nil {
		return Account{}, err
	}
	result, err := loadAccount(ctx, queries, id)
	if err != nil {
		return Account{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Account{}, err
	}
	return result, nil
}
