package auth

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	authdb "github.com/Basmatireis/Makerspace-Core/backend/internal/auth/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const (
	// PendingLoginTTL bounds the time between a correct password and its second factor.
	PendingLoginTTL = 5 * time.Minute
	// pendingLoginMaxFailures wrong second factors end a pending login.
	pendingLoginMaxFailures = 5
)

// PendingLogin is a password login that waits for its second factor. Token goes into an HttpOnly cookie; only its
// digest is stored.
type PendingLogin struct {
	Token     string
	ExpiresAt time.Time
	Methods   []SecondFactorMethod
}

func (s *Service) createPendingLogin(
	ctx context.Context,
	queries *authdb.Queries,
	accountID, identityID uuid.UUID,
	state authdb.GetAccountSecondFactorStateRow,
) (PendingLogin, error) {
	token, digest, err := security.NewOpaqueToken()
	if err != nil {
		return PendingLogin{}, err
	}
	expiresAt := time.Now().UTC().Add(PendingLoginTTL)
	if err := queries.CreatePendingLogin(ctx, authdb.CreatePendingLoginParams{
		ID: ids.New(), TokenDigest: digest, AccountID: accountID, AuthIdentityID: identityID,
		ManagedDeviceID: managedDeviceFromContext(ctx), ExpiresAt: expiresAt,
	}); err != nil {
		return PendingLogin{}, err
	}
	return PendingLogin{Token: token, ExpiresAt: expiresAt, Methods: stateFromRow(state).Methods()}, nil
}

func pendingLoginInvalid() error {
	return apperror.New(
		http.StatusUnauthorized,
		"second_factor_pending_invalid",
		"The sign-in expired; enter your password again",
	)
}

// loadPendingLogin resolves the pending-login cookie without locking. The device context must be the one the
// password was entered on.
func (s *Service) loadPendingLogin(ctx context.Context, token string) (authdb.PendingLogin, error) {
	if token == "" {
		return authdb.PendingLogin{}, pendingLoginInvalid()
	}
	pending, err := authdb.New(s.pool).GetPendingLogin(ctx, security.DigestToken(token))
	if errors.Is(err, pgx.ErrNoRows) {
		return pending, pendingLoginInvalid()
	}
	if err != nil {
		return pending, err
	}
	if !sameDevice(pending.ManagedDeviceID, managedDeviceFromContext(ctx)) {
		return pending, pendingLoginInvalid()
	}
	return pending, nil
}

func sameDevice(a, b *uuid.UUID) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && *a == *b)
}

// CompleteSecondFactorLogin finishes a pending password login with a TOTP or recovery code.
func (s *Service) CompleteSecondFactorLogin(
	ctx context.Context,
	token string,
	method SecondFactorMethod,
	code string,
	requestID *uuid.UUID,
) (Session, error) {
	if method != SecondFactorTOTP && method != SecondFactorRecoveryCode {
		return Session{}, apperror.InvalidField("method must be totp or recovery_code")
	}
	pending, err := s.loadPendingLogin(ctx, token)
	if err != nil {
		return Session{}, err
	}
	if err := s.checkSecondFactorThrottle(ctx, pending.AccountID); err != nil {
		return Session{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Session{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := authdb.New(tx)
	locked, err := lockPendingLogin(ctx, queries, token, pending)
	if err != nil {
		return Session{}, err
	}
	ok, err := s.verifyCodeFactor(ctx, queries, locked.AccountID, method, code)
	if err != nil {
		return Session{}, err
	}
	if !ok {
		_ = tx.Rollback(ctx)
		return Session{}, s.secondFactorFailed(ctx, locked.AccountID, nil, &locked.ID, method, requestID)
	}
	return s.finishPendingLogin(ctx, tx, locked, requestID)
}

// lockPendingLogin takes the Account lock and then the pending login, and rechecks that the password identity is
// still usable: a password change or reset after the first step invalidates the pending login.
func lockPendingLogin(
	ctx context.Context,
	queries *authdb.Queries,
	token string,
	pending authdb.PendingLogin,
) (authdb.PendingLogin, error) {
	account, err := queries.GetAccountForAuthentication(ctx, pending.AccountID)
	if errors.Is(err, pgx.ErrNoRows) ||
		(err == nil && authorization.AccountStatus(account.Status) != authorization.AccountEnabled) {
		return pending, pendingLoginInvalid()
	}
	if err != nil {
		return pending, err
	}
	locked, err := queries.GetPendingLoginForUpdate(ctx, security.DigestToken(token))
	if errors.Is(err, pgx.ErrNoRows) {
		return pending, pendingLoginInvalid()
	}
	if err != nil {
		return pending, err
	}
	credential, err := queries.GetPasswordCredentialForAccount(ctx, locked.AccountID)
	if errors.Is(err, pgx.ErrNoRows) ||
		(err == nil && (credential.AuthIdentityID != locked.AuthIdentityID || credential.ResetRequired)) {
		return pending, pendingLoginInvalid()
	}
	return locked, err
}

// finishPendingLogin consumes the pending login and creates a strong_mfa password session in the caller's
// transaction, which it commits.
func (s *Service) finishPendingLogin(
	ctx context.Context,
	tx pgx.Tx,
	pending authdb.PendingLogin,
	requestID *uuid.UUID,
) (Session, error) {
	queries := authdb.New(tx)
	if err := queries.DeletePendingLogin(ctx, pending.ID); err != nil {
		return Session{}, err
	}
	session, err := s.createSession(
		ctx, queries, pending.AccountID, pending.AuthIdentityID, authorization.AssuranceStrongMFA, false,
	)
	if err != nil {
		return Session{}, err
	}
	if err := queries.MarkAuthenticationSucceeded(ctx, authdb.MarkAuthenticationSucceededParams{
		AuthIdentityID: pending.AuthIdentityID, AccountID: pending.AccountID,
	}); err != nil {
		return Session{}, err
	}
	if err := queries.ClearSecondFactorThrottle(ctx, pending.AccountID); err != nil {
		return Session{}, err
	}
	actor := pending.AccountID
	if err := audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &actor, Action: "auth.login_succeeded", ResourceType: "account",
		ResourceID: &actor, RequestID: requestID, ChangedFields: []string{"secondFactor"},
	}); err != nil {
		return Session{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Session{}, err
	}
	return session, nil
}
