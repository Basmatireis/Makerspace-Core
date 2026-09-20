package auth

import (
	"context"
	"errors"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	authdb "github.com/Basmatireis/Makerspace-Core/backend/internal/auth/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

const SensitiveAuthenticationAge = 5 * time.Minute

// SessionForSensitiveOperation rechecks the persisted session while serializing
// with account security mutations. Device context comes from request middleware.
func (s *Service) SessionForSensitiveOperation(ctx context.Context, tx pgx.Tx, principal authorization.Principal, requireRecent bool) (authorization.Principal, error) {
	queries := authdb.New(tx)
	account, err := queries.GetAccountForAuthentication(ctx, principal.AccountID)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && account.Status != "enabled") {
		return principal, apperror.Unauthenticated
	}
	if err != nil {
		return principal, err
	}
	session, err := queries.GetSessionForReauthentication(ctx, authdb.GetSessionForReauthenticationParams{SessionID: principal.SessionID, AccountID: principal.AccountID})
	if errors.Is(err, pgx.ErrNoRows) {
		return principal, apperror.Unauthenticated
	}
	if err != nil {
		return principal, err
	}
	principal.Assurance = authorization.Assurance(session.CurrentAssurance)
	principal.AuthenticatedAt = session.AuthenticatedAt
	expired := session.AssuranceExpiresAt.Valid && !session.AssuranceExpiresAt.Time.After(time.Now())
	if expired {
		principal.Assurance = authorization.Assurance(session.BaseAssurance)
	}
	if requireRecent && (expired || !principal.HasFreshAssurance(authorization.AssuranceNormal, SensitiveAuthenticationAge, time.Now())) {
		return principal, reauthenticationRequired()
	}
	return authorization.LoadPermissionsFrom(ctx, tx, principal)
}

func (s *Service) GrantRecentAuthentication(ctx context.Context, tx pgx.Tx, principal authorization.Principal, assurance authorization.Assurance, authenticatedAt time.Time, requestID *uuid.UUID) error {
	if _, err := s.SessionForSensitiveOperation(ctx, tx, principal, false); err != nil {
		return err
	}
	proof := authorization.Principal{Assurance: assurance, AuthenticatedAt: authenticatedAt}
	if !proof.HasFreshAssurance(authorization.AssuranceNormal, SensitiveAuthenticationAge, time.Now()) {
		return reauthenticationRequired()
	}
	if err := authdb.New(tx).GrantRecentAuthentication(ctx, authdb.GrantRecentAuthenticationParams{ID: principal.SessionID, Assurance: string(assurance), AuthenticatedAt: authenticatedAt, ExpiresAt: pgtype.Timestamptz{Time: authenticatedAt.Add(SensitiveAuthenticationAge), Valid: true}}); err != nil {
		return err
	}
	return audit.Write(ctx, tx, audit.Event{ActorAccountID: &principal.AccountID, Action: "auth.reauthenticated", ResourceType: "session", ResourceID: &principal.SessionID, RequestID: requestID})
}

func (s *Service) ReauthenticatePassword(ctx context.Context, principal authorization.Principal, password string, requestID *uuid.UUID) (authorization.Principal, error) {
	key := "reauthentication:" + principal.AccountID.String()
	if !s.limiter.Allow(key, time.Now()) {
		return principal, apperror.New(429, "login_rate_limited", "Too many authentication attempts; try again later")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return principal, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := s.SessionForSensitiveOperation(ctx, tx, principal, false); err != nil {
		return principal, err
	}
	credential, err := authdb.New(tx).GetPasswordCredentialForAccount(ctx, principal.AccountID)
	hash := s.dummyHash
	if err == nil {
		hash = credential.PasswordHash
	}
	valid := security.VerifyPassword(hash, password)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return principal, err
	}
	if err != nil || credential.ResetRequired || !valid {
		return principal, apperror.New(422, "current_password_invalid", "Current password is invalid")
	}
	if err := s.GrantRecentAuthentication(ctx, tx, principal, authorization.AssuranceNormal, time.Now().UTC(), requestID); err != nil {
		return principal, err
	}
	fresh, err := s.SessionForSensitiveOperation(ctx, tx, principal, true)
	if err != nil {
		return principal, err
	}
	if err := tx.Commit(ctx); err != nil {
		return principal, err
	}
	s.limiter.Success(key)
	return fresh, nil
}

func reauthenticationRequired() error {
	return apperror.New(403, "reauthentication_required", "Authenticate again with a password or linked OIDC provider before linking an identity")
}
