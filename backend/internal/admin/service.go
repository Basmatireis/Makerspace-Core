package admin

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	accountsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/accounts/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	authdb "github.com/Basmatireis/Makerspace-Core/backend/internal/auth/db"
	peopledb "github.com/Basmatireis/Makerspace-Core/backend/internal/people/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type BootstrapInput struct {
	FirstName    string
	LastName     string
	ContactEmail string
	LoginEmail   string
	Password     string
}

type Service struct{ pool *pgxpool.Pool }

func NewService(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

func (s *Service) BootstrapMaster(ctx context.Context, input BootstrapInput) (uuid.UUID, error) {
	firstName, lastName := strings.TrimSpace(input.FirstName), strings.TrimSpace(input.LastName)
	if firstName == "" || lastName == "" || len([]rune(firstName)) > 100 || len([]rune(lastName)) > 100 {
		return uuid.Nil, errors.New("first and last name are required and limited to 100 characters")
	}
	contactDisplay, _, err := security.NormalizeEmail(input.ContactEmail)
	if err != nil {
		return uuid.Nil, fmt.Errorf("contact email: %w", err)
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
	if err := accountQueries.AcquireMasterInvariantLock(ctx); err != nil {
		return uuid.Nil, err
	}
	count, err := accountQueries.CountMasterAssignments(ctx)
	if err != nil {
		return uuid.Nil, err
	}
	if count != 0 {
		return uuid.Nil, errors.New("a master account already exists; bootstrap made no changes")
	}
	personID := uuid.Must(uuid.NewV7())
	if _, err := peopledb.New(tx).CreatePerson(ctx, peopledb.CreatePersonParams{ID: personID, FirstName: firstName, LastName: lastName, Email: &contactDisplay}); err != nil {
		return uuid.Nil, err
	}
	accountID := uuid.Must(uuid.NewV7())
	if _, err := accountQueries.CreateAccount(ctx, accountsdb.CreateAccountParams{ID: accountID, PersonID: personID, Status: "enabled"}); err != nil {
		return uuid.Nil, err
	}
	identity, err := accountQueries.CreateAuthIdentity(ctx, accountsdb.CreateAuthIdentityParams{ID: uuid.Must(uuid.NewV7()), AccountID: accountID, IdentifierDisplay: loginDisplay, IdentifierNormalized: loginNormalized})
	if err != nil {
		return uuid.Nil, err
	}
	if err := accountQueries.UpsertPasswordCredential(ctx, accountsdb.UpsertPasswordCredentialParams{AuthIdentityID: identity.ID, PasswordHash: hash}); err != nil {
		return uuid.Nil, err
	}
	master, err := accountQueries.GetMasterRole(ctx)
	if err != nil {
		return uuid.Nil, fmt.Errorf("master role migration missing: %w", err)
	}
	if _, err := accountQueries.AssignAccountRole(ctx, accountsdb.AssignAccountRoleParams{AccountID: accountID, RoleID: master.ID}); err != nil {
		return uuid.Nil, err
	}
	if err := audit.Write(ctx, tx, audit.Event{Action: "system.master_bootstrapped", ResourceType: "account", ResourceID: &accountID, Source: "admin_cli"}); err != nil {
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
	account, err := queries.GetAccountIdentityByLoginEmail(ctx, normalized)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, errors.New("no account has that login email")
	}
	if err != nil {
		return uuid.Nil, err
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
	master, err := queries.GetMasterRole(ctx)
	if err != nil {
		return uuid.Nil, err
	}
	if err := queries.UpsertPasswordCredential(ctx, accountsdb.UpsertPasswordCredentialParams{AuthIdentityID: account.AuthIdentityID, PasswordHash: hash}); err != nil {
		return uuid.Nil, err
	}
	if _, err := queries.AssignAccountRole(ctx, accountsdb.AssignAccountRoleParams{AccountID: account.ID, RoleID: master.ID}); err != nil {
		return uuid.Nil, err
	}
	if _, err := queries.RecoverAccount(ctx, account.ID); err != nil {
		return uuid.Nil, err
	}
	if err := queries.DeletePasswordResetForAccount(ctx, account.ID); err != nil {
		return uuid.Nil, err
	}
	if err := queries.RevokeSessionsForAccount(ctx, accountsdb.RevokeSessionsForAccountParams{AccountID: account.ID, Reason: ptr("master_recovery")}); err != nil {
		return uuid.Nil, err
	}
	if err := audit.Write(ctx, tx, audit.Event{Action: "system.master_recovered", ResourceType: "account", ResourceID: &account.ID, Source: "admin_cli"}); err != nil {
		return uuid.Nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return uuid.Nil, err
	}
	return account.ID, nil
}

func (s *Service) Cleanup(ctx context.Context, sessionBefore, auditBefore time.Time) (sessions, resets, auditEvents int64, err error) {
	authQueries := authdb.New(s.pool)
	sessions, err = authQueries.DeleteExpiredSessions(ctx, sessionBefore)
	if err != nil {
		return 0, 0, 0, err
	}
	resets, err = authQueries.DeleteExpiredPasswordResetTokens(ctx, time.Now().UTC())
	if err != nil {
		return sessions, 0, 0, err
	}
	if !auditBefore.IsZero() {
		auditEvents, err = audit.NewService(s.pool).DeleteBefore(ctx, auditBefore)
	}
	return sessions, resets, auditEvents, err
}

func ptr(value string) *string { return &value }
