package accounts

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/optional"

	accountsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/accounts/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/auth"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
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
	Kind              IdentityKind
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
	Status               authorization.AccountStatus
	ProvisioningSource   ProvisioningSource
	FirstAuthenticatedAt *time.Time
	PasswordStatus       PasswordStatus
	LoginEmail           string
	AuthIdentities       []AuthIdentity
	// SecondFactors is loaded by account reads and the second-factor reset; nil elsewhere.
	SecondFactors *auth.SecondFactorSummary
	Version       int64
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

type ResetIssue struct {
	ExpiresAt      time.Time
	Account        Account
	DeliveryStatus auth.DeliveryStatus
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

// NewService returns the accounts service. notifier may be nil when no mail delivery is
// configured (administrative tools, tests); notifications are then skipped.
func NewService(pool *pgxpool.Pool, cfg config.Config, notifier NotificationService) *Service {
	return &Service{pool: pool, config: cfg, notifier: notifier}
}

func (s *Service) Get(ctx context.Context, principal authorization.Principal, id uuid.UUID) (Account, error) {
	if !principal.Has(authorization.AccountsRead) {
		return Account{}, apperror.PermissionDenied
	}
	account, err := loadAccount(ctx, accountsdb.New(s.pool), id)
	if err != nil {
		return Account{}, err
	}
	return withSecondFactors(ctx, s.pool, account)
}

func (s *Service) GetCurrent(ctx context.Context, principal authorization.Principal) (Account, error) {
	account, err := loadAccount(ctx, accountsdb.New(s.pool), principal.AccountID)
	if err != nil {
		return Account{}, err
	}
	return withSecondFactors(ctx, s.pool, account)
}

// withSecondFactors adds the second-factor summary (kinds, names, timestamps; never secrets).
func withSecondFactors(ctx context.Context, db accountsdb.DBTX, account Account) (Account, error) {
	summary, err := auth.LoadSecondFactorSummary(ctx, db, account.ID)
	if err != nil {
		return Account{}, err
	}
	account.SecondFactors = &summary
	return account, nil
}

func (s *Service) GetForPerson(
	ctx context.Context,
	principal authorization.Principal,
	personID uuid.UUID,
) (*Account, error) {
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
	if err != nil {
		return nil, err
	}
	account, err = withSecondFactors(ctx, s.pool, account)
	return &account, err
}

// ListForPeople returns account administration summaries in a fixed number of
// queries so the people table does not hydrate accounts and identities
// one person at a time.
func (s *Service) ListForPeople(
	ctx context.Context,
	principal authorization.Principal,
	personIDs []uuid.UUID,
) (map[uuid.UUID]Account, error) {
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
			ID: row.ID, PersonID: row.PersonID, Status: authorization.AccountStatus(row.Status),
			ProvisioningSource: ProvisioningSource(row.ProvisioningSource), FirstAuthenticatedAt: timeFromPG(row.FirstAuthenticatedAt),
			PasswordStatus: PasswordStatus(row.PasswordStatus), LoginEmail: loginEmail, AuthIdentities: []AuthIdentity{},
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
			ID: row.ID, Kind: IdentityKind(row.Kind), DisplayIdentifier: &displayIdentifier, ProviderSlug: row.ProviderSlug,
			VerifiedAt: timeFromPG(
				row.VerifiedAt,
			), DisabledAt: timeFromPG(row.DisabledAt), Usable: row.Usable, CreatedAt: row.CreatedAt,
		})
		result[personID] = account
	}
	return result, nil
}

func (s *Service) Create(
	ctx context.Context,
	principal authorization.Principal,
	personID uuid.UUID,
	loginEmail string,
	expectedPersonVersion int64,
	requestID *uuid.UUID,
) (Account, error) {
	if !principal.Has(authorization.AccountsCreate) {
		return Account{}, apperror.PermissionDenied
	}
	display, normalized, err := security.NormalizeEmail(loginEmail)
	if err != nil || expectedPersonVersion < 1 {
		return Account{}, apperror.InvalidField("loginEmail must be valid and expectedVersion is required")
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
	accountID := ids.New()
	if _, err := queries.CreateAccount(
		ctx,
		accountsdb.CreateAccountParams{ID: accountID, PersonID: personID, Status: string(authorization.AccountEnabled)},
	); err != nil {
		return Account{}, databaseError(err)
	}
	if _, err := queries.CreateAuthIdentity(
		ctx,
		accountsdb.CreateAuthIdentityParams{
			ID:                   ids.New(),
			AccountID:            accountID,
			IdentifierDisplay:    display,
			IdentifierNormalized: normalized,
		},
	); err != nil {
		return Account{}, databaseError(err)
	}
	// The person's email is the login email from now on.
	if err := queries.SetPersonEmail(ctx, accountsdb.SetPersonEmailParams{PersonID: personID, Email: display}); err != nil {
		return Account{}, err
	}
	actor := principal.AccountID
	if err := audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "account.created",
			ResourceType:   "account",
			ResourceID:     &accountID,
			RequestID:      requestID,
		},
	); err != nil {
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

func (s *Service) SetStatus(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	status authorization.AccountStatus,
	expectedVersion int64,
	requestID *uuid.UUID,
) (Account, error) {
	permission := authorization.AccountsEnable
	if status == authorization.AccountDisabled {
		permission = authorization.AccountsDisable
	}
	if !principal.Has(permission) {
		return Account{}, apperror.PermissionDenied
	}
	if (status != authorization.AccountEnabled && status != authorization.AccountDisabled) || expectedVersion < 1 {
		return Account{}, apperror.InvalidField("status and expectedVersion are invalid")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Account{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := accountsdb.New(tx)
	if status == authorization.AccountDisabled {
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
	if status == authorization.AccountDisabled {
		if err := protectLastMaster(ctx, queries, current); err != nil {
			return Account{}, err
		}
	}
	row, err := queries.UpdateAccountStatus(
		ctx,
		accountsdb.UpdateAccountStatusParams{ID: id, Status: string(status), ExpectedVersion: expectedVersion},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Account{}, apperror.StaleWrite
	}
	if err != nil {
		return Account{}, err
	}
	if status == authorization.AccountDisabled {
		if err := queries.RevokeSessionsForAccount(
			ctx,
			accountsdb.RevokeSessionsForAccountParams{AccountID: id, Reason: optional.Of("account_disabled")},
		); err != nil {
			return Account{}, err
		}
	}
	actor := principal.AccountID
	action := "account." + string(status)
	if err := audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         action,
			ResourceType:   "account",
			ResourceID:     &id,
			RequestID:      requestID,
			ChangedFields:  []string{"status"},
		},
	); err != nil {
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

func (s *Service) Delete(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	expectedVersion int64,
	requestID *uuid.UUID,
) error {
	if !principal.Has(authorization.AccountsDelete) {
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
	var appErr *apperror.Error
	if err := protectLastMaster(ctx, queries, current); errors.As(err, &appErr) {
		return accountDeletionBlocked(appErr)
	} else if err != nil {
		return err
	}
	actor := principal.AccountID
	if err := audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "account.deleted",
			ResourceType:   "account",
			ResourceID:     &id,
			RequestID:      requestID,
		},
	); err != nil {
		return err
	}
	if _, err := queries.DeleteAccount(
		ctx,
		accountsdb.DeleteAccountParams{ID: id, ExpectedVersion: expectedVersion},
	); errors.Is(
		err,
		pgx.ErrNoRows,
	) {
		return apperror.StaleWrite
	} else if blocker := DeletionReferenceBlocker(err); blocker != nil {
		return accountDeletionBlocked(blocker)
	} else if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func accountDeletionBlocked(reasons ...*apperror.Error) *apperror.Error {
	return apperror.Blocked(
		"account_deletion_blocked",
		"This account cannot be deleted for several reasons",
		reasons...)
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
			ID:                identity.ID,
			Kind:              IdentityKind(identity.Kind),
			DisplayIdentifier: &displayIdentifier,
			ProviderSlug:      identity.ProviderSlug,
			VerifiedAt: timeFromPG(
				identity.VerifiedAt,
			), DisabledAt: timeFromPG(identity.DisabledAt), Usable: identity.Usable, CreatedAt: identity.CreatedAt,
		})
	}
	loginEmail := ""
	if row.LoginEmail != nil {
		loginEmail = *row.LoginEmail
	}
	return Account{ID: row.ID, PersonID: row.PersonID, Status: authorization.AccountStatus(row.Status),
		ProvisioningSource: ProvisioningSource(row.ProvisioningSource), FirstAuthenticatedAt: timeFromPG(row.FirstAuthenticatedAt),
		PasswordStatus: PasswordStatus(row.PasswordStatus), LoginEmail: loginEmail, AuthIdentities: identities,
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
	if err != nil || !isMaster || account.Status != authorization.AccountEnabled {
		return err
	}
	count, err := queries.CountEnabledMasters(ctx)
	if err != nil {
		return err
	}
	if count <= 1 {
		return apperror.New(
			http.StatusConflict,
			"last_master_required",
			"At least one enabled master account must remain",
		)
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
