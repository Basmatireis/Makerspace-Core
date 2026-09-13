package auth

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	authdb "github.com/Basmatireis/Makerspace-Core/backend/internal/auth/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Session struct {
	ID             uuid.UUID
	Token          string
	CSRFToken      string
	IdleExpiresAt  time.Time
	AbsoluteExpiry time.Time
}

type Authenticated struct {
	Principal  authorization.Principal
	CSRFDigest []byte
}

type Service struct {
	pool      *pgxpool.Pool
	config    config.Config
	dummyHash string
	limiter   *loginLimiter
}

func NewService(pool *pgxpool.Pool, cfg config.Config) (*Service, error) {
	dummyHash, err := security.HashPassword("this is only a dummy password")
	if err != nil {
		return nil, err
	}
	return &Service{pool: pool, config: cfg, dummyHash: dummyHash, limiter: newLoginLimiter()}, nil
}

func (s *Service) Login(ctx context.Context, email, password, sourceKey string, requestID *uuid.UUID) (Session, error) {
	_, normalized, normalizeErr := security.NormalizeEmail(email)
	limitDigest := sha256.Sum256([]byte(sourceKey + "\x00" + normalized))
	limitKey := string(limitDigest[:])
	if !s.limiter.Allow(limitKey, time.Now()) {
		return Session{}, apperror.New(429, "login_rate_limited", "Too many login attempts; try again later")
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Session{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := authdb.New(tx)
	accountID, queryErr := queries.FindLoginAccountByEmail(ctx, normalized)
	var login authdb.GetLoginByEmailRow
	if queryErr == nil {
		if _, lockErr := queries.GetAccountForAuthentication(ctx, accountID); lockErr != nil {
			queryErr = lockErr
		} else {
			// Re-read the identity and credential only after the Account lock is
			// held. Account security mutations take the same lock before changing
			// credentials or revoking sessions.
			login, queryErr = queries.GetLoginByEmail(ctx, normalized)
		}
	}
	hash := s.dummyHash
	if queryErr == nil {
		hash = login.PasswordHash
	}
	validPassword := security.VerifyPassword(hash, password)
	if queryErr != nil && !errors.Is(queryErr, pgx.ErrNoRows) {
		return Session{}, queryErr
	}
	if normalizeErr != nil || errors.Is(queryErr, pgx.ErrNoRows) || !validPassword || login.Status != "enabled" || login.ResetRequired {
		return Session{}, apperror.InvalidCredentials
	}
	if security.PasswordNeedsRehash(login.PasswordHash) {
		upgradedHash, err := security.HashPassword(password)
		if err != nil {
			return Session{}, err
		}
		if err := queries.UpsertPasswordCredential(ctx, authdb.UpsertPasswordCredentialParams{
			AuthIdentityID: login.AuthIdentityID,
			PasswordHash:   upgradedHash,
		}); err != nil {
			return Session{}, err
		}
	}

	session, err := s.createSession(ctx, queries, login.AccountID, login.AuthIdentityID)
	if err != nil {
		return Session{}, err
	}
	actor := login.AccountID
	if err := audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &actor, Action: "auth.login_succeeded", ResourceType: "account",
		ResourceID: &actor, RequestID: requestID,
	}); err != nil {
		return Session{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Session{}, err
	}
	s.limiter.Success(limitKey)
	return session, nil
}

func (s *Service) Authenticate(ctx context.Context, sessionToken string) (Authenticated, error) {
	if sessionToken == "" {
		return Authenticated{}, apperror.Unauthenticated
	}
	queries := authdb.New(s.pool)
	row, err := queries.GetSessionPrincipal(ctx, security.DigestToken(sessionToken))
	if errors.Is(err, pgx.ErrNoRows) {
		return Authenticated{}, apperror.Unauthenticated
	}
	if err != nil {
		return Authenticated{}, err
	}
	principal, err := authorization.LoadPermissionsFrom(ctx, s.pool, authorization.Principal{
		SessionID: row.SessionID, AccountID: row.AccountID, PersonID: row.PersonID,
		FirstName: row.FirstName, LastName: row.LastName, LoginEmail: row.LoginEmail,
	})
	if err != nil {
		return Authenticated{}, err
	}
	_ = queries.TouchSession(ctx, authdb.TouchSessionParams{
		ID: row.SessionID, IdleExpiresAt: time.Now().UTC().Add(s.config.SessionIdleTTL),
	})
	return Authenticated{Principal: principal, CSRFDigest: row.CsrfDigest}, nil
}

func ValidateCSRF(authenticated Authenticated, cookieToken, headerToken string) error {
	if cookieToken == "" || headerToken == "" || subtle.ConstantTimeCompare([]byte(cookieToken), []byte(headerToken)) != 1 {
		return apperror.New(403, "csrf_invalid", "CSRF validation failed")
	}
	digest := security.DigestToken(headerToken)
	if subtle.ConstantTimeCompare(digest, authenticated.CSRFDigest) != 1 {
		return apperror.New(403, "csrf_invalid", "CSRF validation failed")
	}
	return nil
}

func (s *Service) Logout(ctx context.Context, principal authorization.Principal, requestID *uuid.UUID) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := authdb.New(tx).RevokeSession(ctx, authdb.RevokeSessionParams{ID: principal.SessionID, Reason: ptr("logout")}); err != nil {
		return err
	}
	actor := principal.AccountID
	if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "auth.logout", ResourceType: "session", ResourceID: &principal.SessionID, RequestID: requestID}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) ChangePassword(ctx context.Context, principal authorization.Principal, currentPassword, newPassword string, requestID *uuid.UUID) (Session, error) {
	if err := security.ValidatePassword(newPassword); err != nil {
		return Session{}, validationError(err.Error())
	}
	newHash, err := security.HashPassword(newPassword)
	if err != nil {
		return Session{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Session{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := authdb.New(tx)
	account, err := queries.GetAccountForAuthentication(ctx, principal.AccountID)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && account.Status != "enabled") {
		return Session{}, apperror.Unauthenticated
	}
	if err != nil {
		return Session{}, err
	}
	credential, err := queries.GetPasswordCredentialForAccount(ctx, principal.AccountID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, apperror.New(422, "current_password_invalid", "Current password is invalid")
	}
	if err != nil {
		return Session{}, err
	}
	if credential.ResetRequired {
		return Session{}, apperror.Unauthenticated
	}
	if !security.VerifyPassword(credential.PasswordHash, currentPassword) {
		return Session{}, apperror.New(422, "current_password_invalid", "Current password is invalid")
	}
	if err := queries.UpsertPasswordCredential(ctx, authdb.UpsertPasswordCredentialParams{AuthIdentityID: credential.AuthIdentityID, PasswordHash: newHash}); err != nil {
		return Session{}, err
	}
	if err := queries.RevokeSessionsForAccount(ctx, authdb.RevokeSessionsForAccountParams{AccountID: principal.AccountID, Reason: ptr("password_changed")}); err != nil {
		return Session{}, err
	}
	if err := queries.BumpAccountVersionAfterCredentialChange(ctx, principal.AccountID); err != nil {
		return Session{}, err
	}
	session, err := s.createSession(ctx, queries, principal.AccountID, credential.AuthIdentityID)
	if err != nil {
		return Session{}, err
	}
	actor := principal.AccountID
	if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "account.password_changed", ResourceType: "account", ResourceID: &actor, RequestID: requestID}); err != nil {
		return Session{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Session{}, err
	}
	return session, nil
}

func (s *Service) RedeemPasswordReset(ctx context.Context, rawToken, newPassword string, requestID *uuid.UUID) error {
	if err := security.ValidatePassword(newPassword); err != nil {
		return validationError(err.Error())
	}
	newHash, err := security.HashPassword(newPassword)
	if err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := authdb.New(tx)
	tokenDigest := security.DigestToken(rawToken)
	accountID, err := queries.FindPasswordResetAccountByDigest(ctx, tokenDigest)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.New(422, "password_reset_invalid", "Password reset token is invalid or expired")
	}
	if err != nil {
		return err
	}
	if _, err := queries.GetAccountForAuthentication(ctx, accountID); errors.Is(err, pgx.ErrNoRows) {
		return apperror.New(422, "password_reset_invalid", "Password reset token is invalid or expired")
	} else if err != nil {
		return err
	}
	reset, err := queries.GetPasswordResetByDigest(ctx, tokenDigest)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.New(422, "password_reset_invalid", "Password reset token is invalid or expired")
	}
	if err != nil {
		return err
	}
	if err := queries.UpsertPasswordCredential(ctx, authdb.UpsertPasswordCredentialParams{AuthIdentityID: reset.AuthIdentityID, PasswordHash: newHash}); err != nil {
		return err
	}
	if err := queries.DeletePasswordResetToken(ctx, reset.ID); err != nil {
		return err
	}
	if err := queries.RevokeSessionsForAccount(ctx, authdb.RevokeSessionsForAccountParams{AccountID: reset.AccountID, Reason: ptr("password_reset_redeemed")}); err != nil {
		return err
	}
	if err := queries.BumpAccountVersionAfterCredentialChange(ctx, reset.AccountID); err != nil {
		return err
	}
	if err := audit.Write(ctx, tx, audit.Event{Action: "account.password_reset_completed", ResourceType: "account", ResourceID: &accountID, RequestID: requestID}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) createSession(ctx context.Context, queries *authdb.Queries, accountID, identityID uuid.UUID) (Session, error) {
	token, tokenDigest, err := security.NewOpaqueToken()
	if err != nil {
		return Session{}, err
	}
	csrf, csrfDigest, err := security.NewOpaqueToken()
	if err != nil {
		return Session{}, err
	}
	now := time.Now().UTC()
	absolute := now.Add(s.config.SessionAbsoluteTTL)
	idle := now.Add(s.config.SessionIdleTTL)
	if idle.After(absolute) {
		idle = absolute
	}
	id := uuid.Must(uuid.NewV7())
	if _, err := queries.CreateSession(ctx, authdb.CreateSessionParams{
		ID: id, AccountID: accountID, AuthIdentityID: identityID,
		TokenDigest: tokenDigest, CsrfDigest: csrfDigest,
		IdleExpiresAt: idle, AbsoluteExpiresAt: absolute,
	}); err != nil {
		return Session{}, err
	}
	return Session{ID: id, Token: token, CSRFToken: csrf, IdleExpiresAt: idle, AbsoluteExpiry: absolute}, nil
}

func validationError(message string) *apperror.Error {
	err := apperror.New(422, "validation_failed", "Request validation failed")
	err.Details["reason"] = message
	return err
}

func ptr(value string) *string { return &value }

type loginAttempt struct {
	count       int
	windowStart time.Time
}

type loginLimiter struct {
	mu       sync.Mutex
	attempts map[string]loginAttempt
}

func newLoginLimiter() *loginLimiter { return &loginLimiter{attempts: make(map[string]loginAttempt)} }

func (l *loginLimiter) Allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.attempts) >= 4096 {
		for candidate, attempt := range l.attempts {
			if now.Sub(attempt.windowStart) >= 15*time.Minute {
				delete(l.attempts, candidate)
			}
		}
		if len(l.attempts) >= 4096 {
			return false
		}
	}
	attempt := l.attempts[key]
	if now.Sub(attempt.windowStart) >= 15*time.Minute {
		attempt = loginAttempt{windowStart: now}
	}
	attempt.count++
	l.attempts[key] = attempt
	return attempt.count <= 10
}

func (l *loginLimiter) Success(key string) {
	l.mu.Lock()
	delete(l.attempts, key)
	l.mu.Unlock()
}

func (s *Service) Cleanup(ctx context.Context, before time.Time) (sessions int64, resets int64, err error) {
	queries := authdb.New(s.pool)
	sessions, err = queries.DeleteExpiredSessions(ctx, before)
	if err != nil {
		return 0, 0, fmt.Errorf("delete expired sessions: %w", err)
	}
	resets, err = queries.DeleteExpiredPasswordResetTokens(ctx, time.Now().UTC())
	if err != nil {
		return sessions, 0, fmt.Errorf("delete expired reset tokens: %w", err)
	}
	return sessions, resets, nil
}
