package auth

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"errors"
	"io"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	authdb "github.com/Basmatireis/Makerspace-Core/backend/internal/auth/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const freshMethodAuthentication = 10 * time.Minute

func (s *Service) LoginWithPIN(
	ctx context.Context,
	loginName, pin, sourceKey string,
	requestID *uuid.UUID,
) (Session, error) {
	_, normalized, normalizeErr := normalizeLoginName(loginName)
	loginDigest := s.pinThrottleDigest("login_name", normalized)
	sourceDigest := s.pinThrottleDigest("source", sourceKey)
	queries := authdb.New(s.pool)
	limitKey, err := s.admitPINAttempt(ctx, queries, "pin", sourceKey, normalized, loginDigest, sourceDigest)
	if err != nil {
		return Session{}, err
	}

	// Verify before opening the transaction so the slow hash never holds a pooled
	// connection or the Account lock.
	candidate, candidateErr := queries.FindPINLogin(ctx, normalized)
	hash := s.dummyPINHash
	if candidateErr == nil {
		hash = candidate.PinHash
	}
	valid := security.VerifyPIN(s.config.PINPepper, hash, pin)
	if candidateErr != nil && !errors.Is(candidateErr, pgx.ErrNoRows) {
		return Session{}, candidateErr
	}
	if normalizeErr != nil || candidateErr != nil || !valid || candidate.Status != "enabled" {
		if err := recordPINFailure(ctx, queries, loginDigest, sourceDigest); err != nil {
			return Session{}, err
		}
		if candidateErr == nil {
			resource := candidate.AccountID
			if err := audit.Write(ctx, s.pool, audit.Event{Action: "auth.pin_login_failed", ResourceType: "account", ResourceID: &resource, RequestID: requestID}); err != nil {
				return Session{}, err
			}
		}
		return Session{}, apperror.InvalidCredentials
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Session{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	txQueries := authdb.New(tx)
	if _, err := txQueries.GetAccountForAuthentication(ctx, candidate.AccountID); err != nil {
		return Session{}, err
	}
	login, err := txQueries.FindPINLogin(ctx, normalized)
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, apperror.InvalidCredentials
	}
	if err != nil {
		return Session{}, err
	}
	// The credential may have changed between verification and acquiring the lock.
	if login.AuthIdentityID != candidate.AuthIdentityID || login.PinHash != candidate.PinHash ||
		login.Status != "enabled" {
		return Session{}, apperror.InvalidCredentials
	}

	session, err := s.createPINSession(ctx, txQueries, login.AccountID, login.AuthIdentityID)
	if err != nil {
		return Session{}, err
	}
	if err := txQueries.MarkAuthenticationSucceeded(ctx, authdb.MarkAuthenticationSucceededParams{AuthIdentityID: login.AuthIdentityID, AccountID: login.AccountID}); err != nil {
		return Session{}, err
	}
	actor := login.AccountID
	if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "auth.pin_login_succeeded", ResourceType: "account", ResourceID: &actor, RequestID: requestID}); err != nil {
		return Session{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Session{}, err
	}
	_ = queries.ClearPINThrottle(ctx, authdb.ClearPINThrottleParams{Dimension: "login_name", KeyDigest: loginDigest})
	s.limits.succeeded(limitKey)
	return session, nil
}

// pinMaxBackoff is the longest persistent PIN back-off (see RecordPINFailure).
const pinMaxBackoff = 5 * time.Minute

// admitPINAttempt applies the persistent PIN back-off and the in-memory attempt limit. The
// in-memory limit is atomic, so a burst of parallel guesses cannot all pass the persistent check
// before the first failure is recorded.
func (s *Service) admitPINAttempt(
	ctx context.Context,
	queries *authdb.Queries,
	scope, sourceKey, loginName string,
	loginDigest, sourceDigest []byte,
) (string, error) {
	for _, dimension := range []struct {
		name   string
		digest []byte
	}{{"login_name", loginDigest}, {"source", sourceDigest}} {
		blocked, err := queries.PINThrottleBlocked(
			ctx,
			authdb.PINThrottleBlockedParams{Dimension: dimension.name, KeyDigest: dimension.digest},
		)
		if err != nil {
			return "", err
		}
		if blocked {
			return "", loginRateLimited(pinMaxBackoff)
		}
	}
	key, allowed := s.limits.take(scope, sourceKey, loginName, time.Now())
	if !allowed {
		return "", loginRateLimited(loginLimitWindow)
	}
	return key, nil
}

func recordPINFailure(ctx context.Context, queries *authdb.Queries, loginDigest, sourceDigest []byte) error {
	if err := queries.RecordPINFailure(ctx, authdb.RecordPINFailureParams{Dimension: "login_name", KeyDigest: loginDigest}); err != nil {
		return err
	}
	return queries.RecordPINFailure(ctx, authdb.RecordPINFailureParams{Dimension: "source", KeyDigest: sourceDigest})
}

func (s *Service) EnrollOwnPIN(
	ctx context.Context,
	principal authorization.Principal,
	loginName, pin string,
	requestID *uuid.UUID,
) error {
	if !principal.Has(authorization.AccountsPINEnrollSelf) {
		return apperror.PermissionDenied
	}
	if !principal.HasFreshAssurance(authorization.AssuranceNormal, freshMethodAuthentication, time.Now()) {
		return apperror.New(403, "fresh_authentication_required", "Fresh normal authentication is required")
	}
	display, normalized, err := normalizeLoginName(loginName)
	if err != nil {
		return validationError(err.Error())
	}
	hash, err := security.HashPIN(s.config.PINPepper, pin)
	if err != nil {
		return validationError(err.Error())
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := authdb.New(tx)
	if _, err := queries.GetAccountForAuthentication(ctx, principal.AccountID); err != nil {
		return err
	}
	identity, err := queries.GetPINIdentityForAccount(ctx, principal.AccountID)
	if errors.Is(err, pgx.ErrNoRows) {
		identity, err = queries.CreatePINIdentity(
			ctx,
			authdb.CreatePINIdentityParams{
				ID:                   uuid.Must(uuid.NewV7()),
				AccountID:            principal.AccountID,
				IdentifierDisplay:    &display,
				IdentifierNormalized: &normalized,
			},
		)
	} else if err == nil {
		identity, err = queries.UpdatePINIdentity(ctx, authdb.UpdatePINIdentityParams{AccountID: principal.AccountID, IdentifierDisplay: &display, IdentifierNormalized: &normalized})
	}
	if err != nil {
		var postgresError *pgconn.PgError
		if errors.As(err, &postgresError) && postgresError.Code == "23505" {
			return apperror.New(409, "login_name_unavailable", "Login name is unavailable")
		}
		return err
	}
	if err := queries.UpsertPINCredential(ctx, authdb.UpsertPINCredentialParams{AuthIdentityID: identity.ID, PinHash: hash}); err != nil {
		return err
	}
	if err := queries.RevokeOtherSessionsForAccount(ctx, authdb.RevokeOtherSessionsForAccountParams{Reason: ptr("pin_changed"), AccountID: principal.AccountID, CurrentSessionID: principal.SessionID}); err != nil {
		return err
	}
	if err := queries.BumpAccountVersionAfterCredentialChange(ctx, principal.AccountID); err != nil {
		return err
	}
	actor := principal.AccountID
	if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "account.pin_enrolled", ResourceType: "account", ResourceID: &actor, RequestID: requestID, ChangedFields: []string{"pinMethod"}}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) SetAccountPIN(
	ctx context.Context,
	principal authorization.Principal,
	accountID uuid.UUID,
	loginName, pin string,
	expectedVersion int64,
	requestID *uuid.UUID,
) error {
	if !principal.Has(authorization.AccountsPINEnrollAll) && !principal.Has(authorization.AccountsPINReset) {
		return apperror.PermissionDenied
	}
	if expectedVersion < 1 {
		return validationError("expectedVersion must be positive")
	}
	display, normalized, err := normalizeLoginName(loginName)
	if err != nil {
		return validationError(err.Error())
	}
	hash, err := security.HashPIN(s.config.PINPepper, pin)
	if err != nil {
		return validationError(err.Error())
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := authdb.New(tx)
	account, err := queries.GetAccountForAuthentication(ctx, accountID)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	if err != nil {
		return err
	}
	if account.Version != expectedVersion {
		return apperror.StaleWrite
	}
	identity, identityErr := queries.GetPINIdentityForAccount(ctx, accountID)
	if errors.Is(identityErr, pgx.ErrNoRows) {
		if !principal.Has(authorization.AccountsPINEnrollAll) {
			return apperror.PermissionDenied
		}
		identity, err = queries.CreatePINIdentity(ctx, authdb.CreatePINIdentityParams{
			ID: uuid.Must(uuid.NewV7()), AccountID: accountID,
			IdentifierDisplay: &display, IdentifierNormalized: &normalized,
		})
	} else if identityErr != nil {
		return identityErr
	} else {
		if !principal.Has(authorization.AccountsPINReset) {
			return apperror.PermissionDenied
		}
		identity, err = queries.UpdatePINIdentity(ctx, authdb.UpdatePINIdentityParams{
			AccountID: accountID, IdentifierDisplay: &display, IdentifierNormalized: &normalized,
		})
	}
	if err != nil {
		var postgresError *pgconn.PgError
		if errors.As(err, &postgresError) && postgresError.Code == "23505" {
			return apperror.New(409, "login_name_unavailable", "Login name is unavailable")
		}
		return err
	}
	if err := queries.UpsertPINCredential(ctx, authdb.UpsertPINCredentialParams{AuthIdentityID: identity.ID, PinHash: hash}); err != nil {
		return err
	}
	if err := queries.DeletePINEnrollmentChallengeForAccount(ctx, accountID); err != nil {
		return err
	}
	if err := queries.RevokeSessionsForAccount(ctx, authdb.RevokeSessionsForAccountParams{AccountID: accountID, Reason: ptr("pin_set_by_admin")}); err != nil {
		return err
	}
	if err := queries.BumpAccountVersionAfterCredentialChange(ctx, accountID); err != nil {
		return err
	}
	actor := principal.AccountID
	if err := audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &actor, Action: "account.pin_set", ResourceType: "account", ResourceID: &accountID,
		RequestID: requestID, ChangedFields: []string{"pinMethod"},
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) CompletePINEnrollment(
	ctx context.Context,
	accountID uuid.UUID,
	code, loginName, pin, sourceKey string,
	requestID *uuid.UUID,
) error {
	display, normalized, normalizeErr := normalizeLoginName(loginName)
	hash, hashErr := security.HashPIN(s.config.PINPepper, pin)
	allowed, err := s.consumeChallengeLimit(ctx, "pin_enrollment_verify_source", sourceKey, 10)
	if err != nil {
		return err
	}
	accountAllowed, err := s.consumeChallengeLimit(ctx, "pin_enrollment_verify_account", accountID.String(), 5)
	if err != nil {
		return err
	}
	if normalizeErr != nil {
		return validationError(normalizeErr.Error())
	}
	if hashErr != nil {
		return validationError(hashErr.Error())
	}
	if !allowed || !accountAllowed {
		return invalidChallenge()
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := authdb.New(tx)
	if _, err := queries.GetAccountForAuthentication(ctx, accountID); errors.Is(err, pgx.ErrNoRows) {
		return invalidChallenge()
	} else if err != nil {
		return err
	}
	challenge, err := queries.GetActiveAuthChallengeForUpdate(
		ctx,
		authdb.GetActiveAuthChallengeForUpdateParams{AccountID: accountID, Kind: "pin_enrollment"},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return invalidChallenge()
	}
	if err != nil {
		return err
	}
	if !s.challengeValid(challenge, code) {
		if challenge.UsedAt.Valid || challenge.CancelledAt.Valid || challenge.AttemptCount >= 5 ||
			!challenge.ExpiresAt.After(time.Now().UTC()) {
			return invalidChallenge()
		}
		if err := queries.IncrementAuthChallengeFailure(ctx, challenge.ID); err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return invalidChallenge()
	}
	identity, identityErr := queries.GetPINIdentityForAccount(ctx, accountID)
	if challenge.AuthIdentityID == nil {
		if identityErr == nil {
			return invalidChallenge()
		}
		if !errors.Is(identityErr, pgx.ErrNoRows) {
			return identityErr
		}
		identity, err = queries.CreatePINIdentity(
			ctx,
			authdb.CreatePINIdentityParams{
				ID:                   uuid.Must(uuid.NewV7()),
				AccountID:            accountID,
				IdentifierDisplay:    &display,
				IdentifierNormalized: &normalized,
			},
		)
	} else {
		if identityErr != nil || identity.ID != *challenge.AuthIdentityID {
			return invalidChallenge()
		}
		identity, err = queries.UpdatePINIdentity(ctx, authdb.UpdatePINIdentityParams{AccountID: accountID, IdentifierDisplay: &display, IdentifierNormalized: &normalized})
	}
	if err != nil {
		var postgresError *pgconn.PgError
		if errors.As(err, &postgresError) && postgresError.Code == "23505" {
			return apperror.New(409, "login_name_unavailable", "Login name is unavailable")
		}
		return err
	}
	if err := queries.UpsertPINCredential(ctx, authdb.UpsertPINCredentialParams{AuthIdentityID: identity.ID, PinHash: hash}); err != nil {
		return err
	}
	if err := queries.UseAuthChallenge(ctx, challenge.ID); err != nil {
		return err
	}
	if err := queries.RevokeSessionsForAccount(ctx, authdb.RevokeSessionsForAccountParams{AccountID: accountID, Reason: ptr("pin_enrollment_completed")}); err != nil {
		return err
	}
	if err := queries.BumpAccountVersionAfterCredentialChange(ctx, accountID); err != nil {
		return err
	}
	if err := audit.Write(ctx, tx, audit.Event{Action: "account.pin_enrollment_completed", ResourceType: "account", ResourceID: &accountID, RequestID: requestID, ChangedFields: []string{"pinIdentity", "pinCredential"}}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if s.notifier != nil && challenge.DeliveryAddress != nil {
		_ = s.notifier.SendSecurityNotice(
			ctx,
			*challenge.DeliveryAddress,
			"Makerspace PIN login configured",
			"Your Makerspace username and PIN were configured. If this was not you, contact an administrator immediately.",
		)
	}
	return nil
}

func (s *Service) RemoveOwnPIN(ctx context.Context, principal authorization.Principal, requestID *uuid.UUID) error {
	if !principal.Has(authorization.AccountsPINRemoveSelf) {
		return apperror.PermissionDenied
	}
	if !principal.HasFreshAssurance(authorization.AssuranceNormal, freshMethodAuthentication, time.Now()) {
		return apperror.New(403, "fresh_authentication_required", "Fresh normal authentication is required")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := authdb.New(tx)
	if _, err := queries.GetAccountForAuthentication(ctx, principal.AccountID); err != nil {
		return err
	}
	identity, err := queries.GetPINIdentityForAccount(ctx, principal.AccountID)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	if err != nil {
		return err
	}
	if err := queries.DeletePINIdentity(ctx, identity.ID); err != nil {
		return err
	}
	if err := queries.RevokeOtherSessionsForAccount(ctx, authdb.RevokeOtherSessionsForAccountParams{Reason: ptr("pin_removed"), AccountID: principal.AccountID, CurrentSessionID: principal.SessionID}); err != nil {
		return err
	}
	if err := queries.BumpAccountVersionAfterCredentialChange(ctx, principal.AccountID); err != nil {
		return err
	}
	actor := principal.AccountID
	if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "account.pin_removed", ResourceType: "account", ResourceID: &actor, RequestID: requestID, ChangedFields: []string{"pinMethod"}}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) createPINSession(
	ctx context.Context,
	queries *authdb.Queries,
	accountID, identityID uuid.UUID,
) (Session, error) {
	rawToken, tokenDigest, err := security.NewOpaqueToken()
	if err != nil {
		return Session{}, err
	}
	csrfToken, csrfDigest, err := security.NewOpaqueToken()
	if err != nil {
		return Session{}, err
	}
	now := time.Now().UTC()
	policy, idle, absolute, err := s.sessionDeadlines(ctx, queries, now)
	if err != nil {
		return Session{}, err
	}
	row, err := queries.CreatePINSession(
		ctx,
		authdb.CreatePINSessionParams{ID: uuid.Must(uuid.NewV7()), AccountID: accountID,
			AuthIdentityID: identityID, TokenDigest: tokenDigest, CsrfDigest: csrfDigest, IdleExpiresAt: idle, AbsoluteExpiresAt: absolute,
			ManagedDeviceID: policy.ManagedDeviceID, SessionPolicyID: policy.ID, SessionPolicyVersion: policy.Version,
			IdleTimeoutSeconds: int32(
				policy.IdleTimeout / time.Second,
			), PostSessionDestination: policy.PostSessionDestination},
	)
	if err != nil {
		return Session{}, err
	}
	return Session{ID: row.ID, Token: rawToken, CSRFToken: csrfToken, IdleExpiresAt: row.IdleExpiresAt,
		AbsoluteExpiry: row.AbsoluteExpiresAt, PostSessionDestination: policy.PostSessionDestination}, nil
}

func (s *Service) pinThrottleDigest(dimension, value string) []byte {
	mac := hmac.New(sha256.New, s.config.PINPepper)
	_, _ = io.WriteString(mac, dimension)
	_, _ = mac.Write([]byte{0})
	_, _ = io.WriteString(mac, value)
	return mac.Sum(nil)
}

func normalizeLoginName(raw string) (string, string, error) {
	display := strings.TrimSpace(raw)
	if len(display) < 3 || len(display) > 64 {
		return "", "", errors.New("loginName must contain 3 to 64 characters")
	}
	for index, value := range []byte(display) {
		allowed := value >= 'a' && value <= 'z' || value >= 'A' && value <= 'Z' || value >= '0' && value <= '9' ||
			(index > 0 && (value == '.' || value == '_' || value == '-'))
		if !allowed {
			return "", "", errors.New("loginName contains unsupported characters")
		}
	}
	return display, strings.ToLower(display), nil
}

// NormalizePINLoginName applies the canonical local PIN username rules for
// controlled provisioning workflows as well as interactive enrollment.
func NormalizePINLoginName(raw string) (string, string, error) {
	return normalizeLoginName(raw)
}
