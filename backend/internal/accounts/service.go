package accounts

import (
	"context"
	"errors"
	"net/url"
	"time"

	accountsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/accounts/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	mailservice "github.com/Basmatireis/Makerspace-Core/backend/internal/mail"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

type AuthIdentity struct {
	ID                uuid.UUID
	Kind              string
	DisplayIdentifier *string
	ProviderSlug      *string
	VerifiedAt        *time.Time
	DisabledAt        *time.Time
	Usable            bool
	CreatedAt         time.Time
}

type Account struct {
	ID                   uuid.UUID
	PersonID             uuid.UUID
	Status               string
	ProvisioningSource   string
	FirstAuthenticatedAt *time.Time
	PasswordStatus       string
	LoginEmail           string
	AuthIdentities       []AuthIdentity
	Version              int64
	CreatedAt            time.Time
	UpdatedAt            time.Time
}

type ResetIssue struct {
	ExpiresAt      time.Time
	Account        Account
	DeliveryStatus string
	SetupURL       *string
}

type NotificationService interface {
	SendPasswordReset(context.Context, string, string, time.Time) error
	SendInvitation(context.Context, string, string, time.Time) error
}

type PINEnrollmentNotificationService interface {
	SendPINEnrollment(context.Context, string, uuid.UUID, string, time.Time) error
}

type Service struct {
	pool     *pgxpool.Pool
	config   config.Config
	notifier NotificationService
}

func NewService(pool *pgxpool.Pool, cfg config.Config, notification ...NotificationService) *Service {
	var notifier NotificationService
	if len(notification) > 0 {
		notifier = notification[0]
	}
	return &Service{pool: pool, config: cfg, notifier: notifier}
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

// ListForPeople returns account administration summaries in a fixed number of
// queries so the people table does not hydrate accounts and identities
// one person at a time.
func (s *Service) ListForPeople(ctx context.Context, principal authorization.Principal, personIDs []uuid.UUID) (map[uuid.UUID]Account, error) {
	if !principal.Has(authorization.AccountsRead) {
		return nil, apperror.PermissionDenied
	}
	result := make(map[uuid.UUID]Account, len(personIDs))
	if len(personIDs) == 0 {
		return result, nil
	}
	queries := accountsdb.New(s.pool)
	rows, err := queries.ListAccountViewsByPeople(ctx, personIDs)
	if err != nil {
		return nil, err
	}
	accountIDs := make([]uuid.UUID, 0, len(rows))
	personByAccount := make(map[uuid.UUID]uuid.UUID, len(rows))
	for _, row := range rows {
		loginEmail := ""
		if row.LoginEmail != nil {
			loginEmail = *row.LoginEmail
		}
		result[row.PersonID] = Account{
			ID: row.ID, PersonID: row.PersonID, Status: row.Status,
			ProvisioningSource: row.ProvisioningSource, FirstAuthenticatedAt: timeFromPG(row.FirstAuthenticatedAt),
			PasswordStatus: row.PasswordStatus, LoginEmail: loginEmail, AuthIdentities: []AuthIdentity{},
			Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt,
		}
		accountIDs = append(accountIDs, row.ID)
		personByAccount[row.ID] = row.PersonID
	}
	if len(accountIDs) == 0 {
		return result, nil
	}
	identityRows, err := queries.ListAuthIdentitiesByAccounts(ctx, accountIDs)
	if err != nil {
		return nil, err
	}
	for _, row := range identityRows {
		personID := personByAccount[row.AccountID]
		account := result[personID]
		displayIdentifier := row.DisplayIdentifier
		account.AuthIdentities = append(account.AuthIdentities, AuthIdentity{
			ID: row.ID, Kind: row.Kind, DisplayIdentifier: &displayIdentifier, ProviderSlug: row.ProviderSlug,
			VerifiedAt: timeFromPG(row.VerifiedAt), DisabledAt: timeFromPG(row.DisabledAt), Usable: row.Usable, CreatedAt: row.CreatedAt,
		})
		result[personID] = account
	}
	return result, nil
}

func (s *Service) Create(ctx context.Context, principal authorization.Principal, personID uuid.UUID, loginEmail string, expectedPersonVersion int64, requestID *uuid.UUID) (Account, error) {
	return s.create(ctx, principal, personID, &loginEmail, expectedPersonVersion, requestID)
}

func (s *Service) CreateWithoutIdentity(ctx context.Context, principal authorization.Principal, personID uuid.UUID, expectedPersonVersion int64, requestID *uuid.UUID) (Account, error) {
	return s.create(ctx, principal, personID, nil, expectedPersonVersion, requestID)
}

func (s *Service) create(ctx context.Context, principal authorization.Principal, personID uuid.UUID, loginEmail *string, expectedPersonVersion int64, requestID *uuid.UUID) (Account, error) {
	if !principal.Has(authorization.AccountsCreate) {
		return Account{}, apperror.PermissionDenied
	}
	var display, normalized string
	var err error
	if loginEmail != nil {
		display, normalized, err = security.NormalizeEmail(*loginEmail)
	}
	if err != nil || expectedPersonVersion < 1 {
		return Account{}, validation("loginEmail must be valid when supplied and expectedVersion is required")
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
	if _, err := queries.CreateAccount(ctx, accountsdb.CreateAccountParams{ID: accountID, PersonID: personID, Status: "enabled"}); err != nil {
		return Account{}, databaseError(err)
	}
	if loginEmail != nil {
		if _, err := queries.CreateAuthIdentity(ctx, accountsdb.CreateAuthIdentityParams{ID: uuid.Must(uuid.NewV7()), AccountID: accountID, IdentifierDisplay: display, IdentifierNormalized: normalized}); err != nil {
			return Account{}, databaseError(err)
		}
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
		if _, err := queries.LockPersonForAccountMutation(ctx, id); errors.Is(err, pgx.ErrNoRows) {
			return Account{}, apperror.NotFound
		} else if err != nil {
			return Account{}, err
		}
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
	if _, err := queries.LockPersonForAccountMutation(ctx, id); errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	} else if err != nil {
		return err
	}
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
	_, identityErr := queries.GetPasswordIdentityForAccountForUpdate(ctx, id)
	if errors.Is(identityErr, pgx.ErrNoRows) {
		if _, err := queries.CreateAuthIdentity(ctx, accountsdb.CreateAuthIdentityParams{
			ID: uuid.Must(uuid.NewV7()), AccountID: id,
			IdentifierDisplay: display, IdentifierNormalized: normalized,
		}); err != nil {
			return Account{}, databaseError(err)
		}
	} else if identityErr != nil {
		return Account{}, identityErr
	} else if _, err := queries.UpdateLoginEmail(ctx, accountsdb.UpdateLoginEmailParams{
		AccountID: id, IdentifierDisplay: display, IdentifierNormalized: normalized,
	}); err != nil {
		return Account{}, databaseError(err)
	}
	if err := queries.DeletePasswordResetForAccount(ctx, id); err != nil {
		return Account{}, err
	}
	if err := queries.DeletePasswordChallengesForAccount(ctx, id); err != nil {
		return Account{}, err
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
	if err := queries.VerifyPasswordIdentity(ctx, identity.ID); err != nil {
		return Account{}, err
	}
	if err := queries.DeletePasswordResetForAccount(ctx, id); err != nil {
		return Account{}, err
	}
	if err := queries.DeletePasswordChallengesForAccount(ctx, id); err != nil {
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

func (s *Service) RemoveAuthIdentity(ctx context.Context, principal authorization.Principal, accountID, identityID uuid.UUID, expectedVersion int64, requestID *uuid.UUID) error {
	if !principal.Has(authorization.AccountsPasswordRemoveAll) &&
		!principal.Has(authorization.AccountsPINRemoveAll) &&
		!principal.Has(authorization.OIDCUnlinkAll) {
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
	if identity.Kind == "password" {
		if err := queries.DeletePasswordResetForAccount(ctx, accountID); err != nil {
			return err
		}
		if err := queries.DeletePasswordChallengesForAccount(ctx, accountID); err != nil {
			return err
		}
	}
	if identity.Kind == "pin" {
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
	if err := queries.RevokeSessionsForAccount(ctx, accountsdb.RevokeSessionsForAccountParams{AccountID: accountID, Reason: ptr(policy.revocationReason)}); err != nil {
		return err
	}
	if _, err := queries.BumpAccountVersion(ctx, accountsdb.BumpAccountVersionParams{ID: accountID, ExpectedVersion: expectedVersion}); errors.Is(err, pgx.ErrNoRows) {
		return apperror.StaleWrite
	} else if err != nil {
		return err
	}
	actor := principal.AccountID
	resourceType := "account"
	resourceID := accountID
	if identity.Kind == "oidc" {
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

func authIdentityRemovalPolicyFor(kind string) (authIdentityRemovalPolicy, bool) {
	switch kind {
	case "password":
		return authIdentityRemovalPolicy{
			permission: authorization.AccountsPasswordRemoveAll, auditAction: "account.password_removed",
			changedField: "passwordIdentity", revocationReason: "password_removed",
		}, true
	case "pin":
		return authIdentityRemovalPolicy{
			permission: authorization.AccountsPINRemoveAll, auditAction: "account.pin_removed",
			changedField: "pinMethod", revocationReason: "pin_removed",
		}, true
	case "oidc":
		return authIdentityRemovalPolicy{
			permission: authorization.OIDCUnlinkAll, auditAction: "auth.oidc_unlinked",
			changedField: "identity", revocationReason: "identity_unlinked",
		}, true
	default:
		return authIdentityRemovalPolicy{}, false
	}
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
	code, err := security.NewChallengeCode()
	if err != nil {
		return ResetIssue{}, err
	}
	expiresAt := time.Now().UTC().Add(s.config.PasswordResetTTL)
	actor := principal.AccountID
	if identity.IdentifierDisplay == nil {
		return ResetIssue{}, validation("the account has no password login email")
	}
	challenge, err := queries.UpsertAuthChallenge(ctx, accountsdb.UpsertAuthChallengeParams{
		ID: uuid.Must(uuid.NewV7()), Kind: "password_reset", AccountID: id,
		AuthIdentityID:  &identity.ID,
		CodeDigest:      security.ChallengeDigest(s.config.ChallengeHMACKey, "password_reset", id, code),
		DeliveryAddress: identity.IdentifierDisplay, CreatedByAccountID: &actor, ExpiresAt: expiresAt,
	})
	if err != nil {
		return ResetIssue{}, err
	}
	if _, err := queries.BumpAccountVersion(ctx, accountsdb.BumpAccountVersionParams{ID: id, ExpectedVersion: expectedVersion}); errors.Is(err, pgx.ErrNoRows) {
		return ResetIssue{}, apperror.StaleWrite
	} else if err != nil {
		return ResetIssue{}, err
	}
	if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "account.password_reset_issued", ResourceType: "account", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"passwordChallenge"}}); err != nil {
		return ResetIssue{}, err
	}
	result, err := loadAccount(ctx, queries, id)
	if err != nil {
		return ResetIssue{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ResetIssue{}, err
	}
	deliveryErr := error(mailservice.ErrDisabled)
	if s.notifier != nil {
		deliveryErr = s.notifier.SendPasswordReset(ctx, *identity.IdentifierDisplay, code, expiresAt)
	}
	status := "sent"
	var failureCode *string
	if errors.Is(deliveryErr, mailservice.ErrDisabled) {
		status = "manual"
	} else if deliveryErr != nil {
		status = "failed"
		code := "provider_error"
		failureCode = &code
	}
	_ = accountsdb.New(s.pool).SetAuthChallengeDelivery(ctx, accountsdb.SetAuthChallengeDeliveryParams{ID: challenge.ID, DeliveryStatus: status, DeliveryFailureCode: failureCode})
	if errors.Is(deliveryErr, mailservice.ErrDisabled) {
		manual := "/reset-password#email=" + url.QueryEscape(*identity.IdentifierDisplay) + "&code=" + url.QueryEscape(code)
		return ResetIssue{ExpiresAt: expiresAt, Account: result, DeliveryStatus: "manual", SetupURL: &manual}, nil
	}
	if deliveryErr != nil {
		return ResetIssue{}, apperror.New(503, "mail_delivery_failed", "Password recovery could not be delivered")
	}
	return ResetIssue{ExpiresAt: expiresAt, Account: result, DeliveryStatus: "sent"}, nil
}

func (s *Service) IssuePINEnrollment(ctx context.Context, principal authorization.Principal, id uuid.UUID, expectedVersion int64, requestID *uuid.UUID) (ResetIssue, error) {
	if !principal.Has(authorization.AccountsPINEnrollAll) && !principal.Has(authorization.AccountsPINReset) {
		return ResetIssue{}, apperror.PermissionDenied
	}
	if expectedVersion < 1 {
		return ResetIssue{}, validation("expectedVersion must be positive")
	}
	notifier, notifierAvailable := s.notifier.(PINEnrollmentNotificationService)
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
	var pinIdentityID *uuid.UUID
	for _, identity := range current.AuthIdentities {
		if identity.Kind == "pin" {
			value := identity.ID
			pinIdentityID = &value
			break
		}
	}
	if pinIdentityID == nil && !principal.Has(authorization.AccountsPINEnrollAll) {
		return ResetIssue{}, apperror.PermissionDenied
	}
	if pinIdentityID != nil && !principal.Has(authorization.AccountsPINReset) {
		return ResetIssue{}, apperror.PermissionDenied
	}
	deliveryAddress, err := queries.GetPersonEmailForAccount(ctx, id)
	if err != nil {
		return ResetIssue{}, err
	}
	code, err := security.NewChallengeCode()
	if err != nil {
		return ResetIssue{}, err
	}
	expiresAt := time.Now().UTC().Add(s.config.PasswordResetTTL)
	actor := principal.AccountID
	challenge, err := queries.UpsertAuthChallenge(ctx, accountsdb.UpsertAuthChallengeParams{
		ID: uuid.Must(uuid.NewV7()), Kind: "pin_enrollment", AccountID: id,
		AuthIdentityID: pinIdentityID, CodeDigest: security.ChallengeDigest(s.config.ChallengeHMACKey, "pin_enrollment", id, code),
		DeliveryAddress: deliveryAddress, CreatedByAccountID: &actor, ExpiresAt: expiresAt,
	})
	if err != nil {
		return ResetIssue{}, err
	}
	if _, err := queries.BumpAccountVersion(ctx, accountsdb.BumpAccountVersionParams{ID: id, ExpectedVersion: expectedVersion}); errors.Is(err, pgx.ErrNoRows) {
		return ResetIssue{}, apperror.StaleWrite
	} else if err != nil {
		return ResetIssue{}, err
	}
	if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "account.pin_enrollment_issued", ResourceType: "account", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"pinEnrollmentChallenge"}}); err != nil {
		return ResetIssue{}, err
	}
	result, err := loadAccount(ctx, queries, id)
	if err != nil {
		return ResetIssue{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ResetIssue{}, err
	}
	deliveryErr := error(mailservice.ErrDisabled)
	if notifierAvailable && deliveryAddress != nil {
		deliveryErr = notifier.SendPINEnrollment(ctx, *deliveryAddress, id, code, expiresAt)
	}
	status := "sent"
	var failureCode *string
	if errors.Is(deliveryErr, mailservice.ErrDisabled) {
		status = "manual"
	} else if deliveryErr != nil {
		status = "failed"
		value := "provider_error"
		failureCode = &value
	}
	_ = accountsdb.New(s.pool).SetAuthChallengeDelivery(ctx, accountsdb.SetAuthChallengeDeliveryParams{ID: challenge.ID, DeliveryStatus: status, DeliveryFailureCode: failureCode})
	if errors.Is(deliveryErr, mailservice.ErrDisabled) {
		manual := "/complete-pin-setup#account=" + id.String() + "&code=" + url.QueryEscape(code)
		return ResetIssue{ExpiresAt: expiresAt, Account: result, DeliveryStatus: "manual", SetupURL: &manual}, nil
	}
	if deliveryErr != nil {
		return ResetIssue{}, apperror.New(503, "mail_delivery_failed", "PIN setup could not be delivered")
	}
	return ResetIssue{ExpiresAt: expiresAt, Account: result, DeliveryStatus: "sent"}, nil
}

func (s *Service) IssueInvitation(ctx context.Context, principal authorization.Principal, id uuid.UUID, expectedVersion int64, requestID *uuid.UUID) (ResetIssue, error) {
	if !principal.Has(authorization.AccountsPasswordEnrollAll) {
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
	if current.PasswordStatus == "active" {
		return ResetIssue{}, apperror.New(409, "password_already_enrolled", "Use password reset for an account that already has a password")
	}
	identity, err := queries.GetIdentityByAccount(ctx, id)
	if err != nil {
		return ResetIssue{}, err
	}
	if identity.IdentifierDisplay == nil {
		return ResetIssue{}, validation("the account has no password login email")
	}
	code, err := security.NewChallengeCode()
	if err != nil {
		return ResetIssue{}, err
	}
	expiresAt := time.Now().UTC().Add(s.config.PasswordResetTTL)
	actor := principal.AccountID
	challenge, err := queries.UpsertAuthChallenge(ctx, accountsdb.UpsertAuthChallengeParams{
		ID: uuid.Must(uuid.NewV7()), Kind: "invitation", AccountID: id,
		AuthIdentityID:  &identity.ID,
		CodeDigest:      security.ChallengeDigest(s.config.ChallengeHMACKey, "invitation", id, code),
		DeliveryAddress: identity.IdentifierDisplay, CreatedByAccountID: &actor, ExpiresAt: expiresAt,
	})
	if err != nil {
		return ResetIssue{}, err
	}
	if err := queries.MarkInvitationProvisioning(ctx, id); err != nil {
		return ResetIssue{}, err
	}
	if _, err := queries.BumpAccountVersion(ctx, accountsdb.BumpAccountVersionParams{ID: id, ExpectedVersion: expectedVersion}); errors.Is(err, pgx.ErrNoRows) {
		return ResetIssue{}, apperror.StaleWrite
	} else if err != nil {
		return ResetIssue{}, err
	}
	if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "account.invitation_issued", ResourceType: "account", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"invitation"}}); err != nil {
		return ResetIssue{}, err
	}
	result, err := loadAccount(ctx, queries, id)
	if err != nil {
		return ResetIssue{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ResetIssue{}, err
	}
	deliveryErr := error(mailservice.ErrDisabled)
	if s.notifier != nil {
		deliveryErr = s.notifier.SendInvitation(ctx, *identity.IdentifierDisplay, code, expiresAt)
	}
	status := "sent"
	var failureCode *string
	if errors.Is(deliveryErr, mailservice.ErrDisabled) {
		status = "manual"
	} else if deliveryErr != nil {
		status = "failed"
		code := "provider_error"
		failureCode = &code
	}
	_ = accountsdb.New(s.pool).SetAuthChallengeDelivery(ctx, accountsdb.SetAuthChallengeDeliveryParams{ID: challenge.ID, DeliveryStatus: status, DeliveryFailureCode: failureCode})
	if errors.Is(deliveryErr, mailservice.ErrDisabled) {
		manual := "/complete-invitation#email=" + url.QueryEscape(*identity.IdentifierDisplay) + "&code=" + url.QueryEscape(code)
		return ResetIssue{ExpiresAt: expiresAt, Account: result, DeliveryStatus: "manual", SetupURL: &manual}, nil
	}
	if deliveryErr != nil {
		return ResetIssue{}, apperror.New(503, "mail_delivery_failed", "Invitation could not be delivered")
	}
	return ResetIssue{ExpiresAt: expiresAt, Account: result, DeliveryStatus: "sent"}, nil
}

func loadAccount(ctx context.Context, queries *accountsdb.Queries, id uuid.UUID) (Account, error) {
	row, err := queries.GetAccountView(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Account{}, apperror.NotFound
	}
	if err != nil {
		return Account{}, err
	}
	identityRows, err := queries.ListAuthIdentitiesByAccount(ctx, id)
	if err != nil {
		return Account{}, err
	}
	identities := make([]AuthIdentity, 0, len(identityRows))
	for _, identity := range identityRows {
		displayIdentifier := identity.DisplayIdentifier
		identities = append(identities, AuthIdentity{
			ID: identity.ID, Kind: identity.Kind, DisplayIdentifier: &displayIdentifier, ProviderSlug: identity.ProviderSlug,
			VerifiedAt: timeFromPG(identity.VerifiedAt), DisabledAt: timeFromPG(identity.DisabledAt), Usable: identity.Usable, CreatedAt: identity.CreatedAt,
		})
	}
	loginEmail := ""
	if row.LoginEmail != nil {
		loginEmail = *row.LoginEmail
	}
	return Account{ID: row.ID, PersonID: row.PersonID, Status: row.Status,
		ProvisioningSource: row.ProvisioningSource, FirstAuthenticatedAt: timeFromPG(row.FirstAuthenticatedAt),
		PasswordStatus: row.PasswordStatus, LoginEmail: loginEmail, AuthIdentities: identities,
		Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}, nil
}

func timeFromPG(value pgtype.Timestamptz) *time.Time {
	if !value.Valid {
		return nil
	}
	result := value.Time
	return &result
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
