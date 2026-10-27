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
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

// SensitiveAuthenticationAge is how long a raise above the session's base assurance lasts, and how recent the
// authentication for OIDC linking must be.
const SensitiveAuthenticationAge = 5 * time.Minute

// SessionForSensitiveOperation rechecks the persisted session while serializing
// with account security mutations. Device context comes from request middleware.
func (s *Service) SessionForSensitiveOperation(
	ctx context.Context,
	tx pgx.Tx,
	principal authorization.Principal,
	requireRecent bool,
) (authorization.Principal, error) {
	session, err := lockSession(ctx, authdb.New(tx), principal)
	if err != nil {
		return principal, err
	}
	principal.Assurance = authorization.Assurance(session.CurrentAssurance)
	principal.AuthenticatedAt = session.AuthenticatedAt
	principal.AuthenticatedAssurance = authorization.Assurance(session.AuthenticatedAssurance)
	expired := session.AssuranceExpiresAt.Valid && !session.AssuranceExpiresAt.Time.After(time.Now())
	if expired {
		principal.Assurance = authorization.Assurance(session.BaseAssurance)
	}
	// An expired raise also ends the recent-authentication proof it carried.
	if requireRecent && (expired ||
		!principal.HasFreshAssurance(authorization.AssuranceNormal, SensitiveAuthenticationAge, time.Now())) {
		return principal, ReauthenticationRequired(authorization.AssuranceNormal, SensitiveAuthenticationAge)
	}
	return authorization.LoadPermissionsFrom(ctx, tx, principal)
}

// lockSession locks the Account and then the session, and fails when either is no longer usable.
func lockSession(
	ctx context.Context,
	queries *authdb.Queries,
	principal authorization.Principal,
) (authdb.GetSessionForReauthenticationRow, error) {
	account, err := queries.GetAccountForAuthentication(ctx, principal.AccountID)
	if errors.Is(err, pgx.ErrNoRows) ||
		(err == nil && authorization.AccountStatus(account.Status) != authorization.AccountEnabled) {
		return authdb.GetSessionForReauthenticationRow{}, apperror.Unauthenticated
	}
	if err != nil {
		return authdb.GetSessionForReauthenticationRow{}, err
	}
	session, err := queries.GetSessionForReauthentication(
		ctx,
		authdb.GetSessionForReauthenticationParams{SessionID: principal.SessionID, AccountID: principal.AccountID},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return session, apperror.Unauthenticated
	}
	return session, err
}

// GrantRecentAuthentication records a reauthentication of the current session. A second-factor proof raises the
// session to strong_mfa for good, as a multi-factor login would. A weaker proof never lowers the session; when it
// is above the session's base assurance the raise lasts SensitiveAuthenticationAge.
func (s *Service) GrantRecentAuthentication(
	ctx context.Context,
	tx pgx.Tx,
	principal authorization.Principal,
	assurance authorization.Assurance,
	authenticatedAt time.Time,
	requestID *uuid.UUID,
) error {
	queries := authdb.New(tx)
	session, err := lockSession(ctx, queries, principal)
	if err != nil {
		return err
	}
	proof := authorization.Principal{Assurance: assurance, AuthenticatedAt: authenticatedAt}
	if !proof.HasFreshAssurance(authorization.AssuranceNormal, SensitiveAuthenticationAge, time.Now()) {
		return ReauthenticationRequired(authorization.AssuranceNormal, SensitiveAuthenticationAge)
	}
	if assurance == authorization.AssuranceStrongMFA {
		if err := queries.RaiseSessionToStrongMFA(
			ctx,
			authdb.RaiseSessionToStrongMFAParams{ID: principal.SessionID, AuthenticatedAt: authenticatedAt},
		); err != nil {
			return err
		}
	} else {
		base := authorization.Assurance(session.BaseAssurance)
		current, expiresAt := base, pgtype.Timestamptz{}
		if !authorization.AtLeast(base, assurance) {
			current = assurance
			expiresAt = pgtype.Timestamptz{Time: authenticatedAt.Add(SensitiveAuthenticationAge), Valid: true}
		}
		proven := string(assurance)
		if err := queries.GrantRecentAuthentication(ctx, authdb.GrantRecentAuthenticationParams{
			ID:               principal.SessionID,
			CurrentAssurance: string(current),
			ProofAssurance:   &proven,
			AuthenticatedAt:  authenticatedAt,
			ExpiresAt:        expiresAt,
		}); err != nil {
			return err
		}
	}
	return audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &principal.AccountID,
			Action:         "auth.reauthenticated",
			ResourceType:   "session",
			ResourceID:     &principal.SessionID,
			RequestID:      requestID,
		},
	)
}

// ReauthenticatePassword refreshes the session with a password-only (normal) proof, as OIDC linking needs.
func (s *Service) ReauthenticatePassword(
	ctx context.Context,
	principal authorization.Principal,
	password string,
	requestID *uuid.UUID,
) (authorization.Principal, error) {
	return s.reauthenticate(ctx, principal, ReauthenticationInput{Password: password}, false, requestID)
}

// ReauthenticationInput is a step-up proof: the password and, for an account with a second factor, one code.
type ReauthenticationInput struct {
	Password     string
	TOTPCode     string
	RecoveryCode string
}

// Reauthenticate verifies the password and, when the account has a second factor, a TOTP or recovery code, and
// records the proof on the current session.
func (s *Service) Reauthenticate(
	ctx context.Context,
	principal authorization.Principal,
	input ReauthenticationInput,
	requestID *uuid.UUID,
) (authorization.Principal, error) {
	return s.reauthenticate(ctx, principal, input, true, requestID)
}

func (s *Service) reauthenticate(
	ctx context.Context,
	principal authorization.Principal,
	input ReauthenticationInput,
	requireSecondFactor bool,
	requestID *uuid.UUID,
) (authorization.Principal, error) {
	if input.TOTPCode != "" && input.RecoveryCode != "" {
		return principal, apperror.InvalidField("send either totpCode or recoveryCode")
	}
	key, allowed := s.limits.take("reauthentication", "", principal.AccountID.String(), time.Now())
	if !allowed {
		return principal, loginRateLimited(loginLimitWindow)
	}
	// A revoked or expired session fails before any password is checked.
	if err := s.checkSessionUsable(ctx, principal); err != nil {
		return principal, err
	}
	// Argon2id runs before any transaction or lock; the credential is compared again under the Account lock.
	readQueries := authdb.New(s.pool)
	credential, err := readQueries.GetPasswordCredentialForAccount(ctx, principal.AccountID)
	hash := s.dummyHash
	if err == nil {
		hash = credential.PasswordHash
	}
	valid := security.VerifyPassword(hash, input.Password)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return principal, err
	}
	if err != nil || credential.ResetRequired || !valid {
		return principal, currentPasswordInvalid()
	}
	state, err := readQueries.GetAccountSecondFactorState(ctx, principal.AccountID)
	if err != nil {
		return principal, err
	}
	enrolled := state.TotpEnrolled || state.PasskeyCount > 0
	method, code := secondFactorCodeFromInput(input)
	if requireSecondFactor && enrolled && method == "" {
		return principal, secondFactorRequiredError()
	}
	if method != "" && !enrolled {
		return principal, apperror.InvalidField("the account has no second factor")
	}
	if method != "" {
		if err := s.checkSecondFactorThrottle(ctx, principal.AccountID); err != nil {
			return principal, err
		}
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return principal, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := authdb.New(tx)
	if _, err := lockSession(ctx, queries, principal); err != nil {
		return principal, err
	}
	locked, err := queries.GetPasswordCredentialForAccount(ctx, principal.AccountID)
	if errors.Is(err, pgx.ErrNoRows) ||
		(err == nil && (locked.PasswordHash != credential.PasswordHash || locked.ResetRequired)) {
		return principal, currentPasswordInvalid()
	}
	if err != nil {
		return principal, err
	}
	proof := authorization.AssuranceNormal
	if method != "" {
		ok, err := s.verifyCodeFactor(ctx, queries, principal.AccountID, method, code)
		if err != nil {
			return principal, err
		}
		if !ok {
			_ = tx.Rollback(ctx)
			actor := principal.AccountID
			return principal, s.secondFactorFailed(ctx, principal.AccountID, &actor, nil, method, requestID)
		}
		proof = authorization.AssuranceStrongMFA
		if err := queries.ClearSecondFactorThrottle(ctx, principal.AccountID); err != nil {
			return principal, err
		}
	}
	now := time.Now().UTC()
	if err := s.GrantRecentAuthentication(ctx, tx, principal, proof, now, requestID); err != nil {
		return principal, err
	}
	fresh, err := s.SessionForSensitiveOperation(ctx, tx, principal, false)
	if err != nil {
		return principal, err
	}
	if err := tx.Commit(ctx); err != nil {
		return principal, err
	}
	s.limits.succeeded(key)
	return fresh, nil
}

func (s *Service) checkSessionUsable(ctx context.Context, principal authorization.Principal) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = lockSession(ctx, authdb.New(tx), principal)
	return err
}

func secondFactorCodeFromInput(input ReauthenticationInput) (SecondFactorMethod, string) {
	switch {
	case input.TOTPCode != "":
		return SecondFactorTOTP, input.TOTPCode
	case input.RecoveryCode != "":
		return SecondFactorRecoveryCode, input.RecoveryCode
	default:
		return "", ""
	}
}

func currentPasswordInvalid() error {
	return apperror.New(http.StatusUnprocessableEntity, "current_password_invalid", "Current password is invalid")
}

// ReauthenticationRequired is the 403 a client answers with a fresh sign-in at assurance within the window.
func ReauthenticationRequired(assurance authorization.Assurance, within time.Duration) error {
	err := apperror.New(
		http.StatusForbidden,
		"reauthentication_required",
		"Sign in again to continue",
	)
	err.Details["requiredAssurance"] = string(assurance)
	err.Details["withinMinutes"] = int(within / time.Minute)
	return err
}

// requireFreshAuthentication guards self-service changes of authentication methods.
func requireFreshAuthentication(principal authorization.Principal, assurance authorization.Assurance) error {
	if !principal.HasFreshAssurance(assurance, freshMethodAuthentication, time.Now()) {
		return ReauthenticationRequired(assurance, freshMethodAuthentication)
	}
	return nil
}
