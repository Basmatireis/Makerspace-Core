package admin

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/dates"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/optional"

	accountsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/accounts/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	peopledb "github.com/Basmatireis/Makerspace-Core/backend/internal/people/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type BootstrapInput struct {
	FirstName string
	LastName  string
	// LoginEmail is the account's only email; the person row mirrors it.
	LoginEmail string
	Password   string
}

type Service struct{ pool *pgxpool.Pool }

func NewService(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

func (s *Service) BootstrapMaster(ctx context.Context, input BootstrapInput) (uuid.UUID, error) {
	firstName, lastName := strings.TrimSpace(input.FirstName), strings.TrimSpace(input.LastName)
	if firstName == "" || lastName == "" || len([]rune(firstName)) > 100 || len([]rune(lastName)) > 100 {
		return uuid.Nil, errors.New("first and last name are required and limited to 100 characters")
	}
	loginDisplay, loginNormalized, err := security.NormalizeEmail(input.LoginEmail)
	if err != nil {
		return uuid.Nil, fmt.Errorf("login email: %w", err)
	}
	hash, err := security.HashPassword(input.Password)
	if err != nil {
		return uuid.Nil, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return uuid.Nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	accountQueries := accountsdb.New(tx)
	peopleQueries := peopledb.New(tx)
	if err := accountQueries.AcquireMasterInvariantLock(ctx); err != nil {
		return uuid.Nil, err
	}
	count, err := peopleQueries.CountMasterAssignments(ctx)
	if err != nil {
		return uuid.Nil, err
	}
	if count != 0 {
		return uuid.Nil, errors.New("a master account already exists; bootstrap made no changes")
	}
	personID := ids.New()
	if _, err := peopleQueries.CreatePerson(
		ctx,
		peopledb.CreatePersonParams{
			ID: personID, FirstName: firstName, LastName: lastName, Email: &loginDisplay,
			MemberSince: dates.TodayUTC(),
		},
	); err != nil {
		return uuid.Nil, err
	}
	accountID := ids.New()
	if _, err := accountQueries.CreateAccount(
		ctx,
		accountsdb.CreateAccountParams{ID: accountID, PersonID: personID, Status: "enabled"},
	); err != nil {
		return uuid.Nil, err
	}
	identity, err := accountQueries.CreateAuthIdentity(
		ctx,
		accountsdb.CreateAuthIdentityParams{
			ID:                   ids.New(),
			AccountID:            accountID,
			IdentifierDisplay:    loginDisplay,
			IdentifierNormalized: loginNormalized,
		},
	)
	if err != nil {
		return uuid.Nil, err
	}
	if err := accountQueries.UpsertPasswordCredential(
		ctx,
		accountsdb.UpsertPasswordCredentialParams{AuthIdentityID: identity.ID, PasswordHash: hash},
	); err != nil {
		return uuid.Nil, err
	}
	master, err := peopleQueries.GetMasterRole(ctx)
	if err != nil {
		return uuid.Nil, fmt.Errorf("master role migration missing: %w", err)
	}
	if _, err := peopleQueries.AssignPersonRole(
		ctx,
		peopledb.AssignPersonRoleParams{PersonID: personID, RoleID: master.ID},
	); err != nil {
		return uuid.Nil, err
	}
	if err := audit.Write(
		ctx,
		tx,
		audit.Event{
			Action:       "system.master_bootstrapped",
			ResourceType: "account",
			ResourceID:   &accountID,
			Source:       "admin_cli",
		},
	); err != nil {
		return uuid.Nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return uuid.Nil, err
	}
	return accountID, nil
}

func (s *Service) RecoverMaster(ctx context.Context, email, password string) (uuid.UUID, error) {
	_, normalized, err := security.NormalizeEmail(email)
	if err != nil {
		return uuid.Nil, err
	}
	hash, err := security.HashPassword(password)
	if err != nil {
		return uuid.Nil, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return uuid.Nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := accountsdb.New(tx)
	account, err := queries.GetAccountIdentityByLoginEmail(ctx, normalized)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, errors.New("no account has that login email")
	}
	if err != nil {
		return uuid.Nil, err
	}
	peopleQueries := peopledb.New(tx)
	person, err := peopleQueries.GetPersonForDeletion(ctx, account.PersonID)
	if err != nil {
		return uuid.Nil, err
	}
	if err := queries.AcquireMasterInvariantLock(ctx); err != nil {
		return uuid.Nil, err
	}
	enabled, err := queries.CountEnabledMasters(ctx)
	if err != nil {
		return uuid.Nil, err
	}
	if enabled != 0 {
		return uuid.Nil, errors.New("an enabled master already exists; recovery made no changes")
	}
	if _, err := queries.GetAccountForMutation(ctx, account.ID); err != nil {
		return uuid.Nil, err
	}
	current, err := queries.GetAccountIdentityByLoginEmail(ctx, normalized)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, errors.New("the account login email changed during recovery; retry")
	}
	if err != nil {
		return uuid.Nil, err
	}
	if current.ID != account.ID || current.AuthIdentityID != account.AuthIdentityID {
		return uuid.Nil, errors.New("the account login email changed during recovery; retry")
	}
	master, err := peopleQueries.GetMasterRole(ctx)
	if err != nil {
		return uuid.Nil, err
	}
	if err := queries.UpsertPasswordCredential(
		ctx,
		accountsdb.UpsertPasswordCredentialParams{AuthIdentityID: account.AuthIdentityID, PasswordHash: hash},
	); err != nil {
		return uuid.Nil, err
	}
	present, err := peopleQueries.IsPersonRoleAssigned(
		ctx,
		peopledb.IsPersonRoleAssignedParams{PersonID: account.PersonID, RoleID: master.ID},
	)
	if err != nil {
		return uuid.Nil, err
	}
	if !present {
		if _, err := peopleQueries.AssignPersonRole(
			ctx,
			peopledb.AssignPersonRoleParams{PersonID: account.PersonID, RoleID: master.ID},
		); err != nil {
			return uuid.Nil, err
		}
		if _, err := peopleQueries.BumpPersonVersion(
			ctx,
			peopledb.BumpPersonVersionParams{ID: account.PersonID, ExpectedVersion: person.Version},
		); err != nil {
			return uuid.Nil, err
		}
	}
	if _, err := queries.RecoverAccount(ctx, account.ID); err != nil {
		return uuid.Nil, err
	}
	if err := queries.DeletePasswordResetForAccount(ctx, account.ID); err != nil {
		return uuid.Nil, err
	}
	if err := queries.DeletePasswordChallengesForAccount(ctx, account.ID); err != nil {
		return uuid.Nil, err
	}
	if err := queries.RevokeSessionsForAccount(
		ctx,
		accountsdb.RevokeSessionsForAccountParams{AccountID: account.ID, Reason: optional.Of("master_recovery")},
	); err != nil {
		return uuid.Nil, err
	}
	if err := audit.Write(
		ctx,
		tx,
		audit.Event{
			Action:       "system.master_recovered",
			ResourceType: "account",
			ResourceID:   &account.ID,
			Source:       "admin_cli",
		},
	); err != nil {
		return uuid.Nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return uuid.Nil, err
	}
	return account.ID, nil
}

// ResetPassword replaces the credential for one existing password identity.
// It deliberately has no master-availability precondition and never changes
// Account status or Roles.
func (s *Service) ResetPassword(ctx context.Context, loginEmail, password string) (uuid.UUID, error) {
	_, normalizedLoginEmail, err := security.NormalizeEmail(loginEmail)
	if err != nil {
		return uuid.Nil, errors.New("an existing password login email is required")
	}
	hash, err := security.HashPassword(password)
	if err != nil {
		return uuid.Nil, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return uuid.Nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := accountsdb.New(tx)
	target, err := queries.GetAccountIdentityByLoginEmail(ctx, normalizedLoginEmail)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, errors.New("no existing password identity has that login email")
	}
	if err != nil {
		return uuid.Nil, err
	}
	accountID := target.ID
	if _, err := queries.GetAccountForMutation(ctx, accountID); err != nil {
		return uuid.Nil, err
	}
	lockedTarget, err := queries.GetAccountIdentityByLoginEmail(ctx, normalizedLoginEmail)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, errors.New("the password login email changed during reset; retry")
	}
	if err != nil {
		return uuid.Nil, err
	}
	if lockedTarget.ID != target.ID || lockedTarget.AuthIdentityID != target.AuthIdentityID {
		return uuid.Nil, errors.New("the password login email changed during reset; retry")
	}
	if err := queries.RestorePasswordIdentity(ctx, target.AuthIdentityID); err != nil {
		return uuid.Nil, err
	}
	if err := queries.UpsertPasswordCredential(
		ctx,
		accountsdb.UpsertPasswordCredentialParams{AuthIdentityID: target.AuthIdentityID, PasswordHash: hash},
	); err != nil {
		return uuid.Nil, err
	}
	if err := queries.RevokeSessionsForAccount(
		ctx,
		accountsdb.RevokeSessionsForAccountParams{AccountID: accountID, Reason: optional.Of("admin_password_reset")},
	); err != nil {
		return uuid.Nil, err
	}
	if err := queries.DeletePasswordResetForAccount(ctx, accountID); err != nil {
		return uuid.Nil, err
	}
	if err := queries.DeletePasswordChallengesForAccount(ctx, accountID); err != nil {
		return uuid.Nil, err
	}
	if err := queries.BumpAccountVersionForAdministrativeReset(ctx, accountID); err != nil {
		return uuid.Nil, err
	}
	if err := audit.Write(
		ctx,
		tx,
		audit.Event{
			Action:        "account.password_reset_by_admin_cli",
			ResourceType:  "account",
			ResourceID:    &accountID,
			ChangedFields: []string{"passwordCredential"},
			Source:        "admin_cli",
		},
	); err != nil {
		return uuid.Nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return uuid.Nil, err
	}
	return accountID, nil
}
