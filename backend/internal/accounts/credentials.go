package accounts

import (
	"context"
	"errors"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/optional"

	accountsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/accounts/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *Service) UpdateLoginEmail(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	email string,
	expectedVersion int64,
	requestID *uuid.UUID,
) (Account, error) {
	if !principal.Has(authorization.AccountsLoginEmailUpdate) {
		return Account{}, apperror.PermissionDenied
	}
	if expectedVersion < 1 {
		return Account{}, apperror.InvalidField("expectedVersion must be positive")
	}
	display, normalized, err := security.NormalizeEmail(email)
	if err != nil {
		return Account{}, apperror.InvalidField("loginEmail is invalid")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Account{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := accountsdb.New(tx)
	// The person row is locked first (people before accounts) because the login email is mirrored into it.
	if _, err := queries.LockPersonForAccountMutation(ctx, id); errors.Is(err, pgx.ErrNoRows) {
		return Account{}, apperror.NotFound
	} else if err != nil {
		return Account{}, err
	}
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
	if _, err := queries.GetPasswordIdentityForAccountForUpdate(ctx, id); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return Account{}, err
	}
	if _, err := queries.UpsertPasswordIdentity(ctx, accountsdb.UpsertPasswordIdentityParams{
		ID: ids.New(), AccountID: id, IdentifierDisplay: display, IdentifierNormalized: normalized,
	}); err != nil {
		return Account{}, databaseError(err)
	}
	if err := queries.SyncPersonEmailFromLoginEmail(ctx, id); err != nil {
		return Account{}, err
	}
	if err := queries.DeletePasswordResetForAccount(ctx, id); err != nil {
		return Account{}, err
	}
	if err := queries.DeletePasswordChallengesForAccount(ctx, id); err != nil {
		return Account{}, err
	}
	if _, err := queries.BumpAccountVersion(
		ctx,
		accountsdb.BumpAccountVersionParams{ID: id, ExpectedVersion: expectedVersion},
	); errors.Is(
		err,
		pgx.ErrNoRows,
	) {
		return Account{}, apperror.StaleWrite
	} else if err != nil {
		return Account{}, err
	}
	if err := queries.RevokeSessionsForAccount(
		ctx,
		accountsdb.RevokeSessionsForAccountParams{AccountID: id, Reason: optional.Of("login_email_changed")},
	); err != nil {
		return Account{}, err
	}
	actor := principal.AccountID
	if err := audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "account.login_email_updated",
			ResourceType:   "account",
			ResourceID:     &id,
			RequestID:      requestID,
			ChangedFields:  []string{"loginEmail"},
		},
	); err != nil {
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

// requireMasterForMasterAccount keeps credential takeover of a master account
// limited to masters: a delegated administrator must not be able to replace the
// password or login email of an account that holds more privileges than a
// registered permission could ever grant.
func requireMasterForMasterAccount(
	ctx context.Context,
	queries *accountsdb.Queries,
	principal authorization.Principal,
	accountID uuid.UUID,
) error {
	if principal.Master {
		return nil
	}
	isMaster, err := queries.IsAccountMaster(ctx, accountID)
	if err != nil {
		return err
	}
	if isMaster {
		return apperror.PermissionDenied
	}
	return nil
}

func (s *Service) SetPassword(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	password string,
	expectedVersion int64,
	requestID *uuid.UUID,
) (Account, error) {
	if !principal.Has(authorization.AccountsPasswordSet) {
		return Account{}, apperror.PermissionDenied
	}
	if expectedVersion < 1 {
		return Account{}, apperror.InvalidField("expectedVersion must be positive")
	}
	hash, err := security.HashPassword(password)
	if err != nil {
		return Account{}, apperror.InvalidField(err.Error())
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
		// A password needs a login email; the administrator sets one first (accounts.login_email.update).
		return Account{}, apperror.InvalidField("the account has no login email; set one before setting a password")
	} else if err != nil {
		return Account{}, err
	}
	if err := queries.UpsertPasswordCredential(
		ctx,
		accountsdb.UpsertPasswordCredentialParams{AuthIdentityID: identity.ID, PasswordHash: hash},
	); err != nil {
		return Account{}, err
	}
	if err := queries.VerifyPasswordIdentity(ctx, identity.ID); err != nil {
		return Account{}, err
	}
	if err := queries.DeletePasswordResetForAccount(ctx, id); err != nil {
		return Account{}, err
	}
	if err := queries.DeletePasswordChallengesForAccount(ctx, id); err != nil {
		return Account{}, err
	}
	if err := queries.RevokeSessionsForAccount(
		ctx,
		accountsdb.RevokeSessionsForAccountParams{AccountID: id, Reason: optional.Of("password_set_by_admin")},
	); err != nil {
		return Account{}, err
	}
	if _, err := queries.BumpAccountVersion(
		ctx,
		accountsdb.BumpAccountVersionParams{ID: id, ExpectedVersion: expectedVersion},
	); errors.Is(
		err,
		pgx.ErrNoRows,
	) {
		return Account{}, apperror.StaleWrite
	} else if err != nil {
		return Account{}, err
	}
	actor := principal.AccountID
	if err := audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "account.password_set",
			ResourceType:   "account",
			ResourceID:     &id,
			RequestID:      requestID,
			ChangedFields:  []string{"passwordStatus"},
		},
	); err != nil {
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

func (s *Service) RemoveAuthIdentity(
	ctx context.Context,
	principal authorization.Principal,
	accountID, identityID uuid.UUID,
	expectedVersion int64,
	requestID *uuid.UUID,
) error {
	if !principal.Has(authorization.AccountsPasswordRemoveAll) &&
		!principal.Has(authorization.AccountsPINRemoveAll) &&
		!principal.Has(authorization.OIDCUnlinkAll) {
		return apperror.PermissionDenied
	}
	if expectedVersion < 1 {
		return apperror.InvalidField("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := accountsdb.New(tx)
	account, err := loadAccountForMutation(ctx, queries, accountID)
	if err != nil {
		return err
	}
	if account.Version != expectedVersion {
		return apperror.StaleWrite
	}
	var identity *AuthIdentity
	for index := range account.AuthIdentities {
		if account.AuthIdentities[index].ID == identityID {
			identity = &account.AuthIdentities[index]
			break
		}
	}
	if identity == nil {
		return apperror.NotFound
	}
	policy, ok := authIdentityRemovalPolicyFor(identity.Kind)
	if !ok {
		return apperror.NotFound
	}
	if !principal.Has(policy.permission) {
		return apperror.PermissionDenied
	}
	if identity.Kind == IdentityPassword {
		if err := queries.DeletePasswordResetForAccount(ctx, accountID); err != nil {
			return err
		}
		if err := queries.DeletePasswordChallengesForAccount(ctx, accountID); err != nil {
			return err
		}
	}
	if identity.Kind == IdentityPIN {
		if err := queries.DeletePINEnrollmentChallengesForAccount(ctx, accountID); err != nil {
			return err
		}
	}
	deleted, err := queries.DeleteAuthIdentityForAccount(ctx, accountsdb.DeleteAuthIdentityForAccountParams{
		ID: identityID, AccountID: accountID,
	})
	if err != nil {
		return err
	}
	if deleted != 1 {
		return apperror.NotFound
	}
	if err := queries.RevokeSessionsForAccount(
		ctx,
		accountsdb.RevokeSessionsForAccountParams{AccountID: accountID, Reason: optional.Of(policy.revocationReason)},
	); err != nil {
		return err
	}
	if _, err := queries.BumpAccountVersion(
		ctx,
		accountsdb.BumpAccountVersionParams{ID: accountID, ExpectedVersion: expectedVersion},
	); errors.Is(
		err,
		pgx.ErrNoRows,
	) {
		return apperror.StaleWrite
	} else if err != nil {
		return err
	}
	actor := principal.AccountID
	resourceType := "account"
	resourceID := accountID
	if identity.Kind == IdentityOIDC {
		resourceType = "auth_identity"
		resourceID = identityID
	}
	if err := audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &actor, Action: policy.auditAction, ResourceType: resourceType,
		ResourceID: &resourceID, RequestID: requestID, ChangedFields: []string{policy.changedField},
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

type authIdentityRemovalPolicy struct {
	permission       authorization.Permission
	auditAction      string
	changedField     string
	revocationReason string
}

func authIdentityRemovalPolicyFor(kind IdentityKind) (authIdentityRemovalPolicy, bool) {
	switch kind {
	case IdentityPassword:
		return authIdentityRemovalPolicy{
			permission: authorization.AccountsPasswordRemoveAll, auditAction: "account.password_removed",
			changedField: "passwordIdentity", revocationReason: "password_removed",
		}, true
	case IdentityPIN:
		return authIdentityRemovalPolicy{
			permission: authorization.AccountsPINRemoveAll, auditAction: "account.pin_removed",
			changedField: "pinMethod", revocationReason: "pin_removed",
		}, true
	case IdentityOIDC:
		return authIdentityRemovalPolicy{
			permission: authorization.OIDCUnlinkAll, auditAction: "auth.oidc_unlinked",
			changedField: "identity", revocationReason: "identity_unlinked",
		}, true
	default:
		return authIdentityRemovalPolicy{}, false
	}
}
