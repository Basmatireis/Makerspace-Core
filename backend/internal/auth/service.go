package auth

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/optional"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	authdb "github.com/Basmatireis/Makerspace-Core/backend/internal/auth/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ratelimit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Session struct {
	ID                     uuid.UUID
	Token                  string
	CSRFToken              string
	IdleExpiresAt          time.Time
	AbsoluteExpiry         time.Time
	PostSessionDestination string
}

type Authenticated struct {
	Principal                        authorization.Principal
	CSRFDigest                       []byte
	AuthMethod                       string
	IdleExpiresAt, AbsoluteExpiresAt time.Time
	PostSessionDestination           string
}

type Service struct {
	pool         *pgxpool.Pool
	config       config.Config
	dummyHash    string
	dummyPINHash string
	limits       loginLimits
	notifier     NotificationService
}

type NotificationService interface {
	SendPasswordReset(context.Context, string, string, time.Time) error
	SendInvitation(context.Context, string, string, time.Time) error
	SendEmailVerification(context.Context, string, string, time.Time) error
	SendSecurityNotice(context.Context, string, string, string) error
}

// NewService returns the authentication service. notifier may be nil when no mail delivery is
// configured; challenge delivery then reports mail as unavailable.
func NewService(pool *pgxpool.Pool, cfg config.Config, notifier NotificationService) (*Service, error) {
	dummyHash, err := security.HashPassword("this is only a dummy password")
	if err != nil {
		return nil, err
	}
	dummyPINHash, err := security.HashPIN(cfg.PINPepper, "000000")
	if err != nil {
		return nil, err
	}
	return &Service{
		pool:         pool,
		config:       cfg,
		dummyHash:    dummyHash,
		dummyPINHash: dummyPINHash,
		limits:       newLoginLimits(),
		notifier:     notifier,
	}, nil
}

func (s *Service) Login(ctx context.Context, email, password, sourceKey string, requestID *uuid.UUID) (Session, error) {
	_, normalized, normalizeErr := security.NormalizeEmail(email)
	limitKey, allowed := s.limits.take("password", sourceKey, normalized, time.Now())
	if !allowed {
		return Session{}, loginRateLimited(loginLimitWindow)
	}

	// Verify before opening the transaction: Argon2id is deliberately slow and must not hold a
	// pooled connection or the Account lock while it runs.
	candidate, candidateErr := authdb.New(s.pool).GetLoginByEmail(ctx, normalized)
	hash := s.dummyHash
	if candidateErr == nil {
		hash = candidate.PasswordHash
	}
	validPassword := security.VerifyPassword(hash, password)
	if candidateErr != nil && !errors.Is(candidateErr, pgx.ErrNoRows) {
		return Session{}, candidateErr
	}
	if normalizeErr != nil || candidateErr != nil || !validPassword {
		return Session{}, apperror.InvalidCredentials
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
	if errors.Is(queryErr, pgx.ErrNoRows) {
		return Session{}, apperror.InvalidCredentials
	}
	if queryErr != nil {
		return Session{}, queryErr
	}
	// The credential may have changed between verification and acquiring the lock.
	if login.AuthIdentityID != candidate.AuthIdentityID || login.PasswordHash != candidate.PasswordHash ||
		authorization.AccountStatus(login.Status) != authorization.AccountEnabled || login.ResetRequired {
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
	if err := queries.MarkAuthenticationSucceeded(ctx, authdb.MarkAuthenticationSucceededParams{
		AuthIdentityID: login.AuthIdentityID,
		AccountID:      login.AccountID,
	}); err != nil {
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
	s.limits.succeeded(limitKey)
	return session, nil
}

func (s *Service) Authenticate(ctx context.Context, sessionToken string) (Authenticated, error) {
	if sessionToken == "" {
		return Authenticated{}, apperror.Unauthenticated
	}
	queries := authdb.New(s.pool)
	tokenDigest := security.DigestToken(sessionToken)
	row, err := queries.GetSessionPrincipal(ctx, tokenDigest)
	if errors.Is(err, pgx.ErrNoRows) {
		return Authenticated{}, s.unauthenticatedWithDestination(ctx, queries, tokenDigest)
	}
	if err != nil {
		return Authenticated{}, err
	}
	assurance := authorization.Assurance(row.CurrentAssurance)
	if row.AssuranceExpiresAt.Valid && !row.AssuranceExpiresAt.Time.After(time.Now().UTC()) {
		assurance = authorization.Assurance(row.BaseAssurance)
	}
	principal, err := authorization.LoadPermissionsFrom(ctx, s.pool, authorization.Principal{
		SessionID: row.SessionID, AccountID: row.AccountID, PersonID: row.PersonID,
		FirstName: row.FirstName, LastName: row.LastName,
		Assurance: assurance, AuthenticatedAt: row.AuthenticatedAt,
	})
	if err != nil {
		return Authenticated{}, err
	}
	currentDevice := managedDeviceFromContext(ctx)
	if (row.ManagedDeviceID == nil) != (currentDevice == nil) ||
		(row.ManagedDeviceID != nil && currentDevice != nil && *row.ManagedDeviceID != *currentDevice) {
		return Authenticated{}, apperror.Unauthenticated
	}
	return Authenticated{Principal: principal, CSRFDigest: row.CsrfDigest, AuthMethod: row.AuthMethod,
		IdleExpiresAt: row.IdleExpiresAt, AbsoluteExpiresAt: row.AbsoluteExpiresAt,
		PostSessionDestination: row.PostSessionDestination}, nil
}

func (s *Service) unauthenticatedWithDestination(
	ctx context.Context,
	queries *authdb.Queries,
	tokenDigest []byte,
) error {
	destination, err := queries.GetSessionPostDestinationByDigest(ctx, tokenDigest)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.Unauthenticated
	}
	if err != nil {
		return err
	}
	unauthenticated := apperror.New(http.StatusUnauthorized, "unauthenticated", "Authentication is required")
	unauthenticated.Details["postSessionDestination"] = destination
	return unauthenticated
}

func (s *Service) RecordActivity(ctx context.Context, principal authorization.Principal) (Session, error) {
	row, err := authdb.New(s.pool).TouchSession(ctx, principal.SessionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, apperror.Unauthenticated
	}
	if err != nil {
		return Session{}, err
	}
	return Session{ID: principal.SessionID, IdleExpiresAt: row.IdleExpiresAt,
		AbsoluteExpiry: row.AbsoluteExpiresAt, PostSessionDestination: row.PostSessionDestination}, nil
}

func (s *Service) WithDevice(
	ctx context.Context,
	authenticated Authenticated,
	device *authorization.ManagedDevice,
) (Authenticated, error) {
	principal := authenticated.Principal
	principal.Device = device
	principal, err := authorization.LoadPermissionsFrom(ctx, s.pool, principal)
	if err != nil {
		return Authenticated{}, err
	}
	authenticated.Principal = principal
	return authenticated, nil
}

func ValidateCSRF(authenticated Authenticated, cookieToken, headerToken string) error {
	if cookieToken == "" || headerToken == "" ||
		subtle.ConstantTimeCompare([]byte(cookieToken), []byte(headerToken)) != 1 {
		return apperror.New(http.StatusForbidden, "csrf_invalid", "CSRF validation failed")
	}
	digest := security.DigestToken(headerToken)
	if subtle.ConstantTimeCompare(digest, authenticated.CSRFDigest) != 1 {
		return apperror.New(http.StatusForbidden, "csrf_invalid", "CSRF validation failed")
	}
	return nil
}

func (s *Service) Logout(ctx context.Context, principal authorization.Principal, requestID *uuid.UUID) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := authdb.New(tx).RevokeSession(
		ctx,
		authdb.RevokeSessionParams{ID: principal.SessionID, Reason: optional.Of("logout")},
	); err != nil {
		return err
	}
	actor := principal.AccountID
	if err := audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "auth.logout",
			ResourceType:   "session",
			ResourceID:     &principal.SessionID,
			RequestID:      requestID,
		},
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) ChangePassword(
	ctx context.Context,
	principal authorization.Principal,
	currentPassword, newPassword string,
	requestID *uuid.UUID,
) (Session, error) {
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
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && authorization.AccountStatus(account.Status) != authorization.AccountEnabled) {
		return Session{}, apperror.Unauthenticated
	}
	if err != nil {
		return Session{}, err
	}
	credential, err := queries.GetPasswordCredentialForAccount(ctx, principal.AccountID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, apperror.New(
			http.StatusUnprocessableEntity,
			"current_password_invalid",
			"Current password is invalid",
		)
	}
	if err != nil {
		return Session{}, err
	}
	if credential.ResetRequired {
		return Session{}, apperror.Unauthenticated
	}
	if !security.VerifyPassword(credential.PasswordHash, currentPassword) {
		return Session{}, apperror.New(
			http.StatusUnprocessableEntity,
			"current_password_invalid",
			"Current password is invalid",
		)
	}
	if err := queries.UpsertPasswordCredential(
		ctx,
		authdb.UpsertPasswordCredentialParams{AuthIdentityID: credential.AuthIdentityID, PasswordHash: newHash},
	); err != nil {
		return Session{}, err
	}
	if err := queries.RevokeSessionsForAccount(
		ctx,
		authdb.RevokeSessionsForAccountParams{AccountID: principal.AccountID, Reason: optional.Of("password_changed")},
	); err != nil {
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
	if err := audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "account.password_changed",
			ResourceType:   "account",
			ResourceID:     &actor,
			RequestID:      requestID,
		},
	); err != nil {
		return Session{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Session{}, err
	}
	return session, nil
}

func (s *Service) RemovePassword(
	ctx context.Context,
	principal authorization.Principal,
	currentPassword string,
	requestID *uuid.UUID,
) error {
	if !principal.Has(authorization.AccountsPasswordRemoveSelf) {
		return apperror.PermissionDenied
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := authdb.New(tx)
	account, err := queries.GetAccountForAuthentication(ctx, principal.AccountID)
	if err != nil || authorization.AccountStatus(account.Status) != authorization.AccountEnabled {
		return apperror.Unauthenticated
	}
	credential, err := queries.GetPasswordCredentialForAccount(ctx, principal.AccountID)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.New(http.StatusUnprocessableEntity, "current_password_invalid", "Current password is invalid")
	}
	if err != nil {
		return err
	}
	if !security.VerifyPassword(credential.PasswordHash, currentPassword) {
		return apperror.New(http.StatusUnprocessableEntity, "current_password_invalid", "Current password is invalid")
	}
	if err := queries.DeletePasswordIdentity(ctx, credential.AuthIdentityID); err != nil {
		return err
	}
	if err := queries.RevokeSessionsForAccount(
		ctx,
		authdb.RevokeSessionsForAccountParams{AccountID: principal.AccountID, Reason: optional.Of("password_removed")},
	); err != nil {
		return err
	}
	if err := queries.BumpAccountVersionAfterCredentialChange(ctx, principal.AccountID); err != nil {
		return err
	}
	actor := principal.AccountID
	if err := audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "account.password_removed",
			ResourceType:   "account",
			ResourceID:     &actor,
			RequestID:      requestID,
			ChangedFields:  []string{"passwordIdentity"},
		},
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
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
		return apperror.New(
			http.StatusUnprocessableEntity,
			"password_reset_invalid",
			"Password reset token is invalid or expired",
		)
	}
	if err != nil {
		return err
	}
	if _, err := queries.GetAccountForAuthentication(ctx, accountID); errors.Is(err, pgx.ErrNoRows) {
		return apperror.New(
			http.StatusUnprocessableEntity,
			"password_reset_invalid",
			"Password reset token is invalid or expired",
		)
	} else if err != nil {
		return err
	}
	reset, err := queries.GetPasswordResetByDigest(ctx, tokenDigest)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.New(
			http.StatusUnprocessableEntity,
			"password_reset_invalid",
			"Password reset token is invalid or expired",
		)
	}
	if err != nil {
		return err
	}
	if err := queries.UpsertPasswordCredential(
		ctx,
		authdb.UpsertPasswordCredentialParams{AuthIdentityID: reset.AuthIdentityID, PasswordHash: newHash},
	); err != nil {
		return err
	}
	if err := queries.DeletePasswordResetToken(ctx, reset.ID); err != nil {
		return err
	}
	if err := queries.RevokeSessionsForAccount(
		ctx,
		authdb.RevokeSessionsForAccountParams{AccountID: reset.AccountID, Reason: optional.Of("password_reset_redeemed")},
	); err != nil {
		return err
	}
	if err := queries.BumpAccountVersionAfterCredentialChange(ctx, reset.AccountID); err != nil {
		return err
	}
	if err := audit.Write(
		ctx,
		tx,
		audit.Event{
			Action:       "account.password_reset_completed",
			ResourceType: "account",
			ResourceID:   &accountID,
			RequestID:    requestID,
		},
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) createSession(
	ctx context.Context,
	queries *authdb.Queries,
	accountID, identityID uuid.UUID,
) (Session, error) {
	token, tokenDigest, err := security.NewOpaqueToken()
	if err != nil {
		return Session{}, err
	}
	csrf, csrfDigest, err := security.NewOpaqueToken()
	if err != nil {
		return Session{}, err
	}
	now := time.Now().UTC()
	policy, idle, absolute, err := s.sessionDeadlines(ctx, queries, now)
	if err != nil {
		return Session{}, err
	}
	id := ids.New()
	if _, err := queries.CreateSession(ctx, authdb.CreateSessionParams{
		ID: id, AccountID: accountID, AuthIdentityID: identityID,
		TokenDigest: tokenDigest, CsrfDigest: csrfDigest,
		IdleExpiresAt: idle, AbsoluteExpiresAt: absolute, ManagedDeviceID: policy.ManagedDeviceID,
		SessionPolicyID: policy.ID, SessionPolicyVersion: policy.Version,
		IdleTimeoutSeconds:     int32(policy.IdleTimeout / time.Second),
		PostSessionDestination: policy.PostSessionDestination,
	}); err != nil {
		return Session{}, err
	}
	return Session{
		ID:                     id,
		Token:                  token,
		CSRFToken:              csrf,
		IdleExpiresAt:          idle,
		AbsoluteExpiry:         absolute,
		PostSessionDestination: policy.PostSessionDestination,
	}, nil
}

func (s *Service) CreateOIDCSession(
	ctx context.Context,
	db authdb.DBTX,
	accountID, identityID uuid.UUID,
	assurance authorization.Assurance,
	authenticatedAt time.Time,
) (Session, error) {
	if assurance != authorization.AssuranceNormal && assurance != authorization.AssuranceStrong &&
		assurance != authorization.AssuranceStrongMFA {
		return Session{}, errors.New("invalid OIDC assurance")
	}
	queries := authdb.New(db)
	account, err := queries.GetAccountForAuthentication(ctx, accountID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, apperror.Unauthenticated
	}
	if err != nil {
		return Session{}, err
	}
	if authorization.AccountStatus(account.Status) != authorization.AccountEnabled {
		return Session{}, apperror.Unauthenticated
	}
	usable, err := queries.OIDCIdentityUsable(
		ctx,
		authdb.OIDCIdentityUsableParams{ID: identityID, AccountID: accountID},
	)
	if err != nil {
		return Session{}, err
	}
	if !usable {
		return Session{}, apperror.Unauthenticated
	}
	token, tokenDigest, err := security.NewOpaqueToken()
	if err != nil {
		return Session{}, err
	}
	csrf, csrfDigest, err := security.NewOpaqueToken()
	if err != nil {
		return Session{}, err
	}
	now := time.Now().UTC()
	policy, idle, absolute, err := s.sessionDeadlines(ctx, queries, now)
	if err != nil {
		return Session{}, err
	}
	id := ids.New()
	if _, err := queries.CreateOIDCSession(ctx, authdb.CreateOIDCSessionParams{
		ID: id, AccountID: accountID, AuthIdentityID: identityID, TokenDigest: tokenDigest,
		CsrfDigest:        csrfDigest,
		Assurance:         string(assurance),
		AuthenticatedAt:   authenticatedAt,
		IdleExpiresAt:     idle,
		AbsoluteExpiresAt: absolute,
		ManagedDeviceID:   policy.ManagedDeviceID, SessionPolicyID: policy.ID, SessionPolicyVersion: policy.Version,
		IdleTimeoutSeconds:     int32(policy.IdleTimeout / time.Second),
		PostSessionDestination: policy.PostSessionDestination,
	}); err != nil {
		return Session{}, err
	}
	if err := queries.MarkAuthenticationSucceeded(
		ctx,
		authdb.MarkAuthenticationSucceededParams{AuthIdentityID: identityID, AccountID: accountID},
	); err != nil {
		return Session{}, err
	}
	return Session{
		ID:                     id,
		Token:                  token,
		CSRFToken:              csrf,
		IdleExpiresAt:          idle,
		AbsoluteExpiry:         absolute,
		PostSessionDestination: policy.PostSessionDestination,
	}, nil
}

func validationError(message string) *apperror.Error {
	err := apperror.New(http.StatusUnprocessableEntity, "validation_failed", "Request validation failed")
	err.Details["reason"] = message
	return err
}

// loginLimits throttles credential verification in memory (single-instance deployment). The
// per-attempt limit stops guessing one identifier from one source; the per-source limit stops
// a client from minting fresh identifiers to escape it. Persistent PIN throttling is separate.
type loginLimits struct {
	perAttempt *ratelimit.Limiter
	perSource  *ratelimit.Limiter
}

const (
	loginLimitWindow       = 15 * time.Minute
	loginAttemptsPerKey    = 10
	loginAttemptsPerSource = 100
)

func newLoginLimits() loginLimits {
	return loginLimits{
		perAttempt: ratelimit.New(loginAttemptsPerKey, loginLimitWindow),
		perSource:  ratelimit.New(loginAttemptsPerSource, loginLimitWindow),
	}
}

// take counts one verification attempt for identifier within scope. An empty sourceKey skips the
// per-source limit, for attempts that are already bound to an authenticated account.
func (l loginLimits) take(scope, sourceKey, identifier string, now time.Time) (string, bool) {
	digest := sha256.Sum256([]byte(scope + "\x00" + sourceKey + "\x00" + identifier))
	key := string(digest[:])
	if sourceKey != "" && !l.perSource.Take(scope+"\x00"+ratelimit.KeyForIP(sourceKey), now) {
		return key, false
	}
	return key, l.perAttempt.Take(key, now)
}

func (l loginLimits) succeeded(key string) { l.perAttempt.Reset(key) }

func loginRateLimited(retryAfter time.Duration) error {
	return apperror.RateLimited("login_rate_limited", "Too many login attempts; try again later", retryAfter)
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
