package accounts

import (
	"context"
	"errors"
	"log/slog"
	"net/url"
	"time"

	accountsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/accounts/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type RoleSummary struct {
	ID        uuid.UUID
	Name      string
	SystemKey *string
}

type Account struct {
	ID             uuid.UUID
	PersonID       uuid.UUID
	Status         string
	PasswordStatus string
	LoginEmail     string
	Roles          []RoleSummary
	Version        int64
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

type ResetIssue struct {
	URL       string
	ExpiresAt time.Time
	Account   Account
}

type Service struct {
	pool   *pgxpool.Pool
	config config.Config
}

func NewService(pool *pgxpool.Pool, cfg config.Config) *Service {
	return &Service{pool: pool, config: cfg}
}

func (s *Service) Get(ctx context.Context, principal authorization.Principal, id uuid.UUID) (Account, error) {
	if !principal.Has(authorization.AccountsRead) {
		return Account{}, apperror.PermissionDenied
	}
	return loadAccount(ctx, accountsdb.New(s.pool), id)
}

func (s *Service) GetCurrent(ctx context.Context, principal authorization.Principal) (Account, error) {
	return loadAccount(ctx, accountsdb.New(s.pool), principal.AccountID)
}

func (s *Service) GetForPerson(ctx context.Context, principal authorization.Principal, personID uuid.UUID) (*Account, error) {
	if !principal.Has(authorization.AccountsRead) {
		return nil, nil
	}
	queries := accountsdb.New(s.pool)
	row, err := queries.GetAccountByPerson(ctx, personID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	account, err := loadAccount(ctx, queries, row.ID)
	return &account, err
}

func (s *Service) Create(ctx context.Context, principal authorization.Principal, personID uuid.UUID, loginEmail string, expectedPersonVersion int64, requestID *uuid.UUID) (Account, error) {
	if !principal.Has(authorization.AccountsCreate) {
		return Account{}, apperror.PermissionDenied
	}
	display, normalized, err := security.NormalizeEmail(loginEmail)
	if err != nil || expectedPersonVersion < 1 {
		return Account{}, validation("valid loginEmail and expectedVersion are required")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Account{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := accountsdb.New(tx)
	version, err := queries.GetPersonVersionForAccountCreation(ctx, personID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Account{}, apperror.NotFound
	}
	if err != nil {
		return Account{}, err
	}
	if version != expectedPersonVersion {
		return Account{}, apperror.StaleWrite
	}
	accountID := uuid.Must(uuid.NewV7())
	if _, err := queries.CreateAccount(ctx, accountsdb.CreateAccountParams{ID: accountID, PersonID: personID, Status: "disabled"}); err != nil {
		return Account{}, databaseError(err)
	}
	if _, err := queries.CreateAuthIdentity(ctx, accountsdb.CreateAuthIdentityParams{ID: uuid.Must(uuid.NewV7()), AccountID: accountID, IdentifierDisplay: display, IdentifierNormalized: normalized}); err != nil {
		return Account{}, databaseError(err)
	}
	actor := principal.AccountID
	if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "account.created", ResourceType: "account", ResourceID: &accountID, RequestID: requestID}); err != nil {
		return Account{}, err
	}
	account, err := loadAccount(ctx, queries, accountID)
	if err != nil {
		return Account{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Account{}, err
	}
	return account, nil
}

func (s *Service) SetStatus(ctx context.Context, principal authorization.Principal, id uuid.UUID, status string, expectedVersion int64, requestID *uuid.UUID) (Account, error) {
	permission := authorization.AccountsEnable
	if status == "disabled" {
		permission = authorization.AccountsDisable
	}
	if !principal.Has(permission) {
		return Account{}, apperror.PermissionDenied
	}
	if (status != "enabled" && status != "disabled") || expectedVersion < 1 {
		return Account{}, validation("status and expectedVersion are invalid")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Account{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := accountsdb.New(tx)
	if status == "disabled" {
		if err := queries.AcquireMasterInvariantLock(ctx); err != nil {
			return Account{}, err
		}
	}
	current, err := loadAccountForMutation(ctx, queries, id)
	if err != nil {
		return Account{}, err
	}
	if current.Version != expectedVersion {
		return Account{}, apperror.StaleWrite
	}
	if status == "enabled" && current.PasswordStatus != "active" {
		return Account{}, validation("an active password is required before enabling the account")
	}
	if status == "disabled" {
		if err := protectLastMaster(ctx, queries, current); err != nil {
			return Account{}, err
		}
	}
	row, err := queries.UpdateAccountStatus(ctx, accountsdb.UpdateAccountStatusParams{ID: id, Status: status, ExpectedVersion: expectedVersion})
	if errors.Is(err, pgx.ErrNoRows) {
		return Account{}, apperror.StaleWrite
	}
	if err != nil {
		return Account{}, err
	}
	if status == "disabled" {
		if err := queries.RevokeSessionsForAccount(ctx, accountsdb.RevokeSessionsForAccountParams{AccountID: id, Reason: ptr("account_disabled")}); err != nil {
			return Account{}, err
		}
	}
	actor := principal.AccountID
	action := "account." + status
	if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: action, ResourceType: "account", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"status"}}); err != nil {
		return Account{}, err
	}
	result, err := loadAccount(ctx, queries, row.ID)
	if err != nil {
		return Account{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Account{}, err
	}
	return result, nil
}

func (s *Service) Delete(ctx context.Context, principal authorization.Principal, id uuid.UUID, expectedVersion int64, requestID *uuid.UUID) error {
	if !principal.Has(authorization.AccountsDelete) {
		return apperror.PermissionDenied
	}
	if expectedVersion < 1 {
		return validation("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := accountsdb.New(tx)
	if err := queries.AcquireMasterInvariantLock(ctx); err != nil {
		return err
	}
	current, err := loadAccountForMutation(ctx, queries, id)
	if err != nil {
		return err
	}
	if current.Version != expectedVersion {
		return apperror.StaleWrite
	}
	if err := protectLastMaster(ctx, queries, current); err != nil {
		return err
	}
	actor := principal.AccountID
	if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "account.deleted", ResourceType: "account", ResourceID: &id, RequestID: requestID}); err != nil {
		return err
	}
	if _, err := queries.DeleteAccount(ctx, accountsdb.DeleteAccountParams{ID: id, ExpectedVersion: expectedVersion}); errors.Is(err, pgx.ErrNoRows) {
		return apperror.StaleWrite
	} else if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) UpdateLoginEmail(ctx context.Context, principal authorization.Principal, id uuid.UUID, email string, expectedVersion int64, requestID *uuid.UUID) (Account, error) {
	if !principal.Has(authorization.AccountsLoginEmailUpdate) {
		return Account{}, apperror.PermissionDenied
	}
	if expectedVersion < 1 {
		return Account{}, validation("expectedVersion must be positive")
	}
	display, normalized, err := security.NormalizeEmail(email)
	if err != nil {
		return Account{}, validation("loginEmail is invalid")
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
	if _, err := queries.UpdateLoginEmail(ctx, accountsdb.UpdateLoginEmailParams{AccountID: id, IdentifierDisplay: display, IdentifierNormalized: normalized}); err != nil {
		return Account{}, databaseError(err)
	}
	if _, err := queries.BumpAccountVersion(ctx, accountsdb.BumpAccountVersionParams{ID: id, ExpectedVersion: expectedVersion}); errors.Is(err, pgx.ErrNoRows) {
		return Account{}, apperror.StaleWrite
	} else if err != nil {
		return Account{}, err
	}
	if err := queries.RevokeSessionsForAccount(ctx, accountsdb.RevokeSessionsForAccountParams{AccountID: id, Reason: ptr("login_email_changed")}); err != nil {
		return Account{}, err
	}
	actor := principal.AccountID
	if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "account.login_email_updated", ResourceType: "account", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"loginEmail"}}); err != nil {
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

func (s *Service) SetPassword(ctx context.Context, principal authorization.Principal, id uuid.UUID, password string, expectedVersion int64, requestID *uuid.UUID) (Account, error) {
	if !principal.Has(authorization.AccountsPasswordSet) {
		return Account{}, apperror.PermissionDenied
	}
	if expectedVersion < 1 {
		return Account{}, validation("expectedVersion must be positive")
	}
	hash, err := security.HashPassword(password)
	if err != nil {
		return Account{}, validation(err.Error())
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
	identity, err := queries.GetIdentityByAccount(ctx, id)
	if err != nil {
		return Account{}, err
	}
	if err := queries.UpsertPasswordCredential(ctx, accountsdb.UpsertPasswordCredentialParams{AuthIdentityID: identity.ID, PasswordHash: hash}); err != nil {
		return Account{}, err
	}
	if err := queries.DeletePasswordResetForAccount(ctx, id); err != nil {
		return Account{}, err
	}
	if err := queries.RevokeSessionsForAccount(ctx, accountsdb.RevokeSessionsForAccountParams{AccountID: id, Reason: ptr("password_set_by_admin")}); err != nil {
		return Account{}, err
	}
	if _, err := queries.BumpAccountVersion(ctx, accountsdb.BumpAccountVersionParams{ID: id, ExpectedVersion: expectedVersion}); errors.Is(err, pgx.ErrNoRows) {
		return Account{}, apperror.StaleWrite
	} else if err != nil {
		return Account{}, err
	}
	actor := principal.AccountID
	if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "account.password_set", ResourceType: "account", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"passwordStatus"}}); err != nil {
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

func (s *Service) IssuePasswordReset(ctx context.Context, principal authorization.Principal, id uuid.UUID, expectedVersion int64, requestID *uuid.UUID) (ResetIssue, error) {
	if !principal.Has(authorization.AccountsPasswordReset) {
		return ResetIssue{}, apperror.PermissionDenied
	}
	if expectedVersion < 1 {
		return ResetIssue{}, validation("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ResetIssue{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := accountsdb.New(tx)
	current, err := loadAccountForMutation(ctx, queries, id)
	if err != nil {
		return ResetIssue{}, err
	}
	if current.Version != expectedVersion {
		return ResetIssue{}, apperror.StaleWrite
	}
	identity, err := queries.GetIdentityByAccount(ctx, id)
	if err != nil {
		return ResetIssue{}, err
	}
	rawToken, digest, err := security.NewOpaqueToken()
	if err != nil {
		return ResetIssue{}, err
	}
	expiresAt := time.Now().UTC().Add(s.config.PasswordResetTTL)
	actor := principal.AccountID
	if _, err := queries.CreatePasswordResetToken(ctx, accountsdb.CreatePasswordResetTokenParams{
		ID: uuid.Must(uuid.NewV7()), AccountID: id, TokenDigest: digest,
		CreatedByAccountID: &actor, ExpiresAt: expiresAt,
	}); err != nil {
		return ResetIssue{}, err
	}
	if err := queries.MarkPasswordResetRequired(ctx, identity.ID); err != nil {
		return ResetIssue{}, err
	}
	if err := queries.RevokeSessionsForAccount(ctx, accountsdb.RevokeSessionsForAccountParams{AccountID: id, Reason: ptr("password_reset_issued")}); err != nil {
		return ResetIssue{}, err
	}
	if _, err := queries.BumpAccountVersion(ctx, accountsdb.BumpAccountVersionParams{ID: id, ExpectedVersion: expectedVersion}); errors.Is(err, pgx.ErrNoRows) {
		return ResetIssue{}, apperror.StaleWrite
	} else if err != nil {
		return ResetIssue{}, err
	}
	if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "account.password_reset_issued", ResourceType: "account", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"passwordStatus"}}); err != nil {
		return ResetIssue{}, err
	}
	result, err := loadAccount(ctx, queries, id)
	if err != nil {
		return ResetIssue{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ResetIssue{}, err
	}
	base := *s.config.PublicBaseURL
	base.Path = "/reset-password"
	base.RawQuery = ""
	base.Fragment = "token=" + url.QueryEscape(rawToken)
	return ResetIssue{URL: base.String(), ExpiresAt: expiresAt, Account: result}, nil
}

func (s *Service) ChangeRole(ctx context.Context, principal authorization.Principal, accountID, roleID uuid.UUID, expectedVersion int64, assign bool, requestID *uuid.UUID) (Account, error) {
	if !principal.Has(authorization.AccountsRolesAssign) {
		return Account{}, apperror.PermissionDenied
	}
	if expectedVersion < 1 {
		return Account{}, validation("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Account{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := accountsdb.New(tx)
	if !assign {
		if err := queries.AcquireMasterInvariantLock(ctx); err != nil {
			return Account{}, err
		}
	}
	account, err := loadAccountForMutation(ctx, queries, accountID)
	if err != nil {
		return Account{}, err
	}
	if account.Version != expectedVersion {
		return Account{}, apperror.StaleWrite
	}
	role, err := queries.GetRoleForAssignment(ctx, roleID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Account{}, apperror.NotFound
	}
	if err != nil {
		return Account{}, err
	}
	permissions, err := queries.GetRolePermissionsForAssignment(ctx, roleID)
	if err != nil {
		return Account{}, err
	}
	if role.SystemKey != nil && *role.SystemKey == "master" {
		if !principal.Master {
			return Account{}, apperror.PermissionDenied
		}
	} else {
		for _, permission := range permissions {
			permissionID := authorization.Permission(permission)
			if !authorization.Known(permissionID) {
				slog.WarnContext(ctx, "unknown stored permission blocked role assignment", "role_id", roleID, "permission_id", permission)
				if !principal.Master {
					return Account{}, apperror.PermissionDenied
				}
				continue
			}
			if !principal.Master && !principal.Has(permissionID) {
				return Account{}, apperror.PermissionDenied
			}
		}
	}
	present, err := queries.IsAccountRoleAssigned(ctx, accountsdb.IsAccountRoleAssignedParams{AccountID: accountID, RoleID: roleID})
	if err != nil {
		return Account{}, err
	}
	if present == assign {
		return account, tx.Commit(ctx)
	}
	if !assign && role.SystemKey != nil && *role.SystemKey == "master" && account.Status == "enabled" {
		if err := protectLastMaster(ctx, queries, account); err != nil {
			return Account{}, err
		}
	}
	if _, err := queries.BumpAccountVersion(ctx, accountsdb.BumpAccountVersionParams{ID: accountID, ExpectedVersion: expectedVersion}); errors.Is(err, pgx.ErrNoRows) {
		return Account{}, apperror.StaleWrite
	} else if err != nil {
		return Account{}, err
	}
	var rows int64
	if assign {
		rows, err = queries.AssignAccountRole(ctx, accountsdb.AssignAccountRoleParams{AccountID: accountID, RoleID: roleID, AssignedByAccountID: &principal.AccountID})
	} else {
		rows, err = queries.RemoveAccountRole(ctx, accountsdb.RemoveAccountRoleParams{AccountID: accountID, RoleID: roleID})
	}
	if err != nil {
		return Account{}, err
	}
	if rows != 1 {
		return Account{}, apperror.StaleWrite
	}
	action := "account.role_removed"
	if assign {
		action = "account.role_assigned"
	}
	actor := principal.AccountID
	if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: action, ResourceType: "account", ResourceID: &accountID, RequestID: requestID, Metadata: map[string]any{"roleId": roleID.String()}}); err != nil {
		return Account{}, err
	}
	result, err := loadAccount(ctx, queries, accountID)
	if err != nil {
		return Account{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Account{}, err
	}
	return result, nil
}

func loadAccount(ctx context.Context, queries *accountsdb.Queries, id uuid.UUID) (Account, error) {
	row, err := queries.GetAccountView(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Account{}, apperror.NotFound
	}
	if err != nil {
		return Account{}, err
	}
	roles, err := queries.ListAccountRoles(ctx, id)
	if err != nil {
		return Account{}, err
	}
	summaries := make([]RoleSummary, 0, len(roles))
	for _, role := range roles {
		summaries = append(summaries, RoleSummary{ID: role.ID, Name: role.Name, SystemKey: role.SystemKey})
	}
	return Account{ID: row.ID, PersonID: row.PersonID, Status: row.Status, PasswordStatus: row.PasswordStatus, LoginEmail: row.LoginEmail,
		Roles: summaries, Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}, nil
}

func loadAccountForMutation(ctx context.Context, queries *accountsdb.Queries, id uuid.UUID) (Account, error) {
	if _, err := queries.GetAccountForMutation(ctx, id); errors.Is(err, pgx.ErrNoRows) {
		return Account{}, apperror.NotFound
	} else if err != nil {
		return Account{}, err
	}
	return loadAccount(ctx, queries, id)
}

func protectLastMaster(ctx context.Context, queries *accountsdb.Queries, account Account) error {
	// Callers that can remove an enabled master acquire the transaction-level
	// master invariant lock before locking the Account row.
	isMaster, err := queries.IsAccountMaster(ctx, account.ID)
	if err != nil || !isMaster || account.Status != "enabled" {
		return err
	}
	count, err := queries.CountEnabledMasters(ctx)
	if err != nil {
		return err
	}
	if count <= 1 {
		return apperror.New(409, "last_master_required", "At least one enabled master account must remain")
	}
	return nil
}

func databaseError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && (pgErr.Code == "23505" || pgErr.Code == "23503") {
		return apperror.Conflict
	}
	return err
}

func validation(reason string) *apperror.Error {
	err := apperror.New(422, "validation_failed", "Request validation failed")
	err.Details["reason"] = reason
	return err
}

func ptr(value string) *string { return &value }
