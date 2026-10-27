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
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/optional"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

// SecondFactorMethod is a way to complete a login or reauthentication with a second factor.
type SecondFactorMethod string

const (
	SecondFactorTOTP         SecondFactorMethod = "totp"
	SecondFactorRecoveryCode SecondFactorMethod = "recovery_code"
	SecondFactorPasskey      SecondFactorMethod = "passkey"
)

const (
	// totpEnrollmentTTL bounds how long an unconfirmed authenticator app secret can be confirmed.
	totpEnrollmentTTL = 10 * time.Minute
	totpSecretPurpose = "mfa_totp_secret" //nolint:gosec // keyring purpose label, not a credential
	// secondFactorMaxBackoff is the longest per-account wait after repeated wrong codes.
	secondFactorMaxBackoff = 5 * time.Minute
)

// SecondFactorState summarizes whether an account must and does use a second factor.
type SecondFactorState struct {
	Required               bool
	TOTP                   bool
	Passkeys               int
	RecoveryCodesRemaining int
}

// Enrolled reports whether the account has an authenticator app or a passkey.
func (s SecondFactorState) Enrolled() bool { return s.TOTP || s.Passkeys > 0 }

// Methods lists how the account can complete a second-factor step.
func (s SecondFactorState) Methods() []SecondFactorMethod {
	methods := make([]SecondFactorMethod, 0, 3)
	if s.TOTP {
		methods = append(methods, SecondFactorTOTP)
	}
	if s.Enrolled() && s.RecoveryCodesRemaining > 0 {
		methods = append(methods, SecondFactorRecoveryCode)
	}
	if s.Passkeys > 0 {
		methods = append(methods, SecondFactorPasskey)
	}
	return methods
}

func stateFromRow(row authdb.GetAccountSecondFactorStateRow) SecondFactorState {
	return SecondFactorState{
		Required: row.Required, TOTP: row.TotpEnrolled, Passkeys: int(row.PasskeyCount),
		RecoveryCodesRemaining: int(row.RecoveryCodesRemaining),
	}
}

// SecondFactorState reads the current second-factor state of an account.
func (s *Service) SecondFactorState(ctx context.Context, accountID uuid.UUID) (SecondFactorState, error) {
	row, err := authdb.New(s.pool).GetAccountSecondFactorState(ctx, accountID)
	if err != nil {
		return SecondFactorState{}, err
	}
	return stateFromRow(row), nil
}

// TOTPSummary describes a confirmed authenticator app.
type TOTPSummary struct {
	ConfirmedAt time.Time
	LastUsedAt  *time.Time
}

// Passkey describes a registered WebAuthn credential without key material.
type Passkey struct {
	ID         uuid.UUID
	Name       string
	CreatedAt  time.Time
	LastUsedAt *time.Time
	BackedUp   bool
}

// SecondFactorSummary lists an account's second factors without any secret.
type SecondFactorSummary struct {
	TOTP                   *TOTPSummary
	Passkeys               []Passkey
	RecoveryCodesRemaining int
}

// Enrolled reports whether an authenticator app or a passkey is enrolled.
func (s SecondFactorSummary) Enrolled() bool { return s.TOTP != nil || len(s.Passkeys) > 0 }

// LoadSecondFactorSummary reads an account's second factors; account administration reuses it.
func LoadSecondFactorSummary(ctx context.Context, db authdb.DBTX, accountID uuid.UUID) (SecondFactorSummary, error) {
	queries := authdb.New(db)
	summary := SecondFactorSummary{Passkeys: []Passkey{}}
	totp, err := queries.GetTOTPCredential(ctx, accountID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return summary, err
	}
	if err == nil && totp.ConfirmedAt.Valid {
		summary.TOTP = &TOTPSummary{ConfirmedAt: totp.ConfirmedAt.Time, LastUsedAt: timePointer(totp.LastUsedAt)}
	}
	credentials, err := queries.ListWebAuthnCredentials(ctx, accountID)
	if err != nil {
		return summary, err
	}
	for _, row := range credentials {
		summary.Passkeys = append(summary.Passkeys, passkeyFromRow(row))
	}
	state, err := queries.GetAccountSecondFactorState(ctx, accountID)
	if err != nil {
		return summary, err
	}
	summary.RecoveryCodesRemaining = int(state.RecoveryCodesRemaining)
	return summary, nil
}

// OwnSecondFactors lists the current account's second factors; a staff session is enough.
func (s *Service) OwnSecondFactors(ctx context.Context, principal authorization.Principal) (SecondFactorSummary, error) {
	return LoadSecondFactorSummary(ctx, s.pool, principal.AccountID)
}

// TOTPEnrollment is the one-time view of a new authenticator app secret.
type TOTPEnrollment struct {
	Secret          string
	ProvisioningURI string
	ExpiresAt       time.Time
}

// EnrollmentResult is returned when a second factor was added.
type EnrollmentResult struct {
	Summary SecondFactorSummary
	// RecoveryCodes is set only when the factor was the account's first; the codes are shown once.
	RecoveryCodes []string
	Passkey       *Passkey
}

// StartTOTPEnrollment creates (or replaces) an unconfirmed authenticator app secret. It needs no permission: an
// account that must use a second factor has to be able to enroll one whatever its roles grant.
func (s *Service) StartTOTPEnrollment(ctx context.Context, principal authorization.Principal) (TOTPEnrollment, error) {
	if err := requireFreshAuthentication(principal, authorization.AssuranceNormal); err != nil {
		return TOTPEnrollment{}, err
	}
	if s.keyring == nil {
		return TOTPEnrollment{}, apperror.Conflicting(
			"encryption_unavailable",
			"Authenticator apps need an application encryption key",
		)
	}
	secret, err := security.NewTOTPSecret()
	if err != nil {
		return TOTPEnrollment{}, err
	}
	ciphertext, err := s.keyring.Encrypt(secret, totpSecretPurpose+":"+principal.AccountID.String())
	if err != nil {
		return TOTPEnrollment{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return TOTPEnrollment{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := authdb.New(tx)
	if _, err := lockSession(ctx, queries, principal); err != nil {
		return TOTPEnrollment{}, err
	}
	existing, err := queries.GetTOTPCredentialForUpdate(ctx, principal.AccountID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return TOTPEnrollment{}, err
	}
	if err == nil && existing.ConfirmedAt.Valid {
		return TOTPEnrollment{}, apperror.Conflicting(
			"totp_already_enrolled",
			"An authenticator app is already set up; remove it first",
		)
	}
	if err := queries.ReplacePendingTOTPCredential(ctx, authdb.ReplacePendingTOTPCredentialParams{
		ID: ids.New(), AccountID: principal.AccountID, SecretCiphertext: ciphertext,
	}); err != nil {
		return TOTPEnrollment{}, err
	}
	user, err := queries.GetAccountWebAuthnUser(ctx, principal.AccountID)
	if err != nil {
		return TOTPEnrollment{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return TOTPEnrollment{}, err
	}
	return TOTPEnrollment{
		Secret:          security.TOTPSecretText(secret),
		ProvisioningURI: security.TOTPProvisioningURI(s.issuer(), accountLabel(user), secret),
		ExpiresAt:       time.Now().UTC().Add(totpEnrollmentTTL),
	}, nil
}

// ConfirmTOTPEnrollment activates the pending authenticator app with a current code and raises the session to
// strong_mfa.
func (s *Service) ConfirmTOTPEnrollment(
	ctx context.Context,
	principal authorization.Principal,
	code string,
	requestID *uuid.UUID,
) (EnrollmentResult, error) {
	if err := requireFreshAuthentication(principal, authorization.AssuranceNormal); err != nil {
		return EnrollmentResult{}, err
	}
	if s.keyring == nil {
		return EnrollmentResult{}, apperror.Conflicting(
			"encryption_unavailable",
			"Authenticator apps need an application encryption key",
		)
	}
	if err := s.checkSecondFactorThrottle(ctx, principal.AccountID); err != nil {
		return EnrollmentResult{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return EnrollmentResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := authdb.New(tx)
	if _, err := lockSession(ctx, queries, principal); err != nil {
		return EnrollmentResult{}, err
	}
	credential, err := queries.GetTOTPCredentialForUpdate(ctx, principal.AccountID)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil &&
		(credential.ConfirmedAt.Valid || time.Since(credential.CreatedAt) > totpEnrollmentTTL)) {
		return EnrollmentResult{}, apperror.Conflicting(
			"totp_enrollment_not_started",
			"Start the authenticator app setup again",
		)
	}
	if err != nil {
		return EnrollmentResult{}, err
	}
	secret, err := s.keyring.Decrypt(credential.SecretCiphertext, totpSecretPurpose+":"+principal.AccountID.String())
	if err != nil {
		return EnrollmentResult{}, err
	}
	step, ok := security.VerifyTOTP(secret, code, time.Now(), nil)
	if !ok {
		_ = tx.Rollback(ctx)
		actor := principal.AccountID
		return EnrollmentResult{}, s.secondFactorFailed(ctx, principal.AccountID, &actor, nil, SecondFactorTOTP, requestID)
	}
	first, err := isFirstSecondFactor(ctx, queries, principal.AccountID)
	if err != nil {
		return EnrollmentResult{}, err
	}
	if err := queries.ConfirmTOTPCredential(
		ctx,
		authdb.ConfirmTOTPCredentialParams{ID: credential.ID, Step: &step},
	); err != nil {
		return EnrollmentResult{}, err
	}
	result, err := s.finishEnrollment(ctx, tx, principal, first, "account.totp_enrolled", "account", principal.AccountID, requestID)
	if err != nil {
		return EnrollmentResult{}, err
	}
	return result, nil
}

// finishEnrollment runs inside the enrollment transaction after the new factor was stored: recovery codes for a
// first factor, the session raise, the audit event, and the commit.
func (s *Service) finishEnrollment(
	ctx context.Context,
	tx pgx.Tx,
	principal authorization.Principal,
	first bool,
	action, resourceType string,
	resourceID uuid.UUID,
	requestID *uuid.UUID,
) (EnrollmentResult, error) {
	queries := authdb.New(tx)
	var codes []string
	if first {
		var err error
		if codes, err = s.replaceRecoveryCodes(ctx, queries, principal.AccountID); err != nil {
			return EnrollmentResult{}, err
		}
	}
	if err := queries.ClearSecondFactorThrottle(ctx, principal.AccountID); err != nil {
		return EnrollmentResult{}, err
	}
	// The session proved its login and, just now, the new factor: it is equivalent to a multi-factor login.
	if err := queries.RaiseSessionToStrongMFA(ctx, authdb.RaiseSessionToStrongMFAParams{
		ID: principal.SessionID, AuthenticatedAt: time.Now().UTC(),
	}); err != nil {
		return EnrollmentResult{}, err
	}
	if err := queries.BumpAccountVersionAfterCredentialChange(ctx, principal.AccountID); err != nil {
		return EnrollmentResult{}, err
	}
	actor := principal.AccountID
	if err := audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &actor, Action: action, ResourceType: resourceType, ResourceID: &resourceID,
		RequestID: requestID,
	}); err != nil {
		return EnrollmentResult{}, err
	}
	summary, err := LoadSecondFactorSummary(ctx, tx, principal.AccountID)
	if err != nil {
		return EnrollmentResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return EnrollmentResult{}, err
	}
	return EnrollmentResult{Summary: summary, RecoveryCodes: codes}, nil
}

func isFirstSecondFactor(ctx context.Context, queries *authdb.Queries, accountID uuid.UUID) (bool, error) {
	count, err := queries.CountSecondFactors(ctx, accountID)
	return count == 0, err
}

func (s *Service) replaceRecoveryCodes(ctx context.Context, queries *authdb.Queries, accountID uuid.UUID) ([]string, error) {
	if err := queries.DeleteRecoveryCodes(ctx, accountID); err != nil {
		return nil, err
	}
	codes := make([]string, 0, security.RecoveryCodeCount)
	for range security.RecoveryCodeCount {
		code, err := security.NewRecoveryCode()
		if err != nil {
			return nil, err
		}
		if err := queries.InsertRecoveryCode(ctx, authdb.InsertRecoveryCodeParams{
			ID: ids.New(), AccountID: accountID,
			CodeDigest: security.RecoveryCodeDigest(s.config.ChallengeHMACKey, accountID, code),
		}); err != nil {
			return nil, err
		}
		codes = append(codes, code)
	}
	return codes, nil
}

// RemoveOwnTOTP deletes the current account's authenticator app after a fresh multi-factor sign-in.
func (s *Service) RemoveOwnTOTP(ctx context.Context, principal authorization.Principal, requestID *uuid.UUID) error {
	if err := requireFreshAuthentication(principal, authorization.AssuranceStrongMFA); err != nil {
		return err
	}
	return s.removeOwnFactor(ctx, principal, requestID, func(queries *authdb.Queries) (string, string, uuid.UUID, error) {
		deleted, err := queries.DeleteTOTPCredential(ctx, principal.AccountID)
		if err != nil {
			return "", "", uuid.Nil, err
		}
		if deleted == 0 {
			return "", "", uuid.Nil, apperror.NotFound
		}
		return "account.totp_removed", "account", principal.AccountID, nil
	})
}

// RemoveOwnPasskey deletes one of the current account's passkeys after a fresh multi-factor sign-in. Sessions
// signed in with it end with it.
func (s *Service) RemoveOwnPasskey(
	ctx context.Context,
	principal authorization.Principal,
	passkeyID uuid.UUID,
	requestID *uuid.UUID,
) error {
	if err := requireFreshAuthentication(principal, authorization.AssuranceStrongMFA); err != nil {
		return err
	}
	return s.removeOwnFactor(ctx, principal, requestID, func(queries *authdb.Queries) (string, string, uuid.UUID, error) {
		deleted, err := queries.DeleteWebAuthnCredential(
			ctx,
			authdb.DeleteWebAuthnCredentialParams{ID: passkeyID, AccountID: principal.AccountID},
		)
		if err != nil {
			return "", "", uuid.Nil, err
		}
		if deleted == 0 {
			return "", "", uuid.Nil, apperror.NotFound
		}
		return "account.passkey_removed", "webauthn_credential", passkeyID, nil
	})
}

func (s *Service) removeOwnFactor(
	ctx context.Context,
	principal authorization.Principal,
	requestID *uuid.UUID,
	remove func(*authdb.Queries) (string, string, uuid.UUID, error),
) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := authdb.New(tx)
	if _, err := lockSession(ctx, queries, principal); err != nil {
		return err
	}
	action, resourceType, resourceID, err := remove(queries)
	if err != nil {
		return err
	}
	remaining, err := queries.CountSecondFactors(ctx, principal.AccountID)
	if err != nil {
		return err
	}
	if remaining == 0 {
		if err := queries.DeleteRecoveryCodes(ctx, principal.AccountID); err != nil {
			return err
		}
	}
	if err := queries.RevokeOtherSessionsForAccount(ctx, authdb.RevokeOtherSessionsForAccountParams{
		Reason: optional.Of("second_factor_removed"), AccountID: principal.AccountID,
		CurrentSessionID: principal.SessionID,
	}); err != nil {
		return err
	}
	if err := queries.DeletePendingLoginsForAccount(ctx, principal.AccountID); err != nil {
		return err
	}
	if err := queries.BumpAccountVersionAfterCredentialChange(ctx, principal.AccountID); err != nil {
		return err
	}
	actor := principal.AccountID
	if err := audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &actor, Action: action, ResourceType: resourceType, ResourceID: &resourceID,
		RequestID: requestID,
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// RegenerateRecoveryCodes replaces every recovery code of the current account after a fresh multi-factor sign-in.
func (s *Service) RegenerateRecoveryCodes(
	ctx context.Context,
	principal authorization.Principal,
	requestID *uuid.UUID,
) ([]string, error) {
	if err := requireFreshAuthentication(principal, authorization.AssuranceStrongMFA); err != nil {
		return nil, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := authdb.New(tx)
	if _, err := lockSession(ctx, queries, principal); err != nil {
		return nil, err
	}
	first, err := isFirstSecondFactor(ctx, queries, principal.AccountID)
	if err != nil {
		return nil, err
	}
	if first {
		return nil, apperror.Conflicting("second_factor_not_enrolled", "Set up a second factor first")
	}
	codes, err := s.replaceRecoveryCodes(ctx, queries, principal.AccountID)
	if err != nil {
		return nil, err
	}
	actor := principal.AccountID
	if err := audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &actor, Action: "account.recovery_codes_regenerated", ResourceType: "account",
		ResourceID: &actor, RequestID: requestID,
	}); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return codes, nil
}

// verifyCodeFactor checks a TOTP or recovery code inside the caller's transaction, after the Account lock. A
// TOTP code's time step is stored so the same code is never accepted twice; a recovery code is spent.
func (s *Service) verifyCodeFactor(
	ctx context.Context,
	queries *authdb.Queries,
	accountID uuid.UUID,
	method SecondFactorMethod,
	code string,
) (bool, error) {
	switch method {
	case SecondFactorTOTP:
		credential, err := queries.GetTOTPCredentialForUpdate(ctx, accountID)
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		if !credential.ConfirmedAt.Valid || s.keyring == nil {
			return false, nil
		}
		secret, err := s.keyring.Decrypt(credential.SecretCiphertext, totpSecretPurpose+":"+accountID.String())
		if err != nil {
			return false, err
		}
		step, ok := security.VerifyTOTP(secret, code, time.Now(), credential.LastUsedStep)
		if !ok {
			return false, nil
		}
		return true, queries.RecordTOTPUse(ctx, authdb.RecordTOTPUseParams{ID: credential.ID, Step: &step})
	case SecondFactorRecoveryCode:
		used, err := queries.UseRecoveryCode(ctx, authdb.UseRecoveryCodeParams{
			AccountID: accountID, CodeDigest: security.RecoveryCodeDigest(s.config.ChallengeHMACKey, accountID, code),
		})
		return used == 1, err
	default:
		return false, nil
	}
}

func (s *Service) checkSecondFactorThrottle(ctx context.Context, accountID uuid.UUID) error {
	blocked, err := authdb.New(s.pool).SecondFactorThrottleBlocked(ctx, accountID)
	if err != nil {
		return err
	}
	if blocked {
		return apperror.RateLimited(
			"second_factor_rate_limited",
			"Too many wrong codes; try again later",
			secondFactorMaxBackoff,
		)
	}
	return nil
}

// secondFactorFailed records a wrong second factor in its own transaction, so the throttle, the pending login's
// attempt count, and the audit event survive the failed operation, and returns the client error.
func (s *Service) secondFactorFailed(
	ctx context.Context,
	accountID uuid.UUID,
	actor *uuid.UUID,
	pendingLoginID *uuid.UUID,
	method SecondFactorMethod,
	requestID *uuid.UUID,
) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := authdb.New(tx)
	if err := queries.RecordSecondFactorFailure(ctx, accountID); err != nil {
		return err
	}
	if pendingLoginID != nil {
		attempts, err := queries.RecordPendingLoginFailure(ctx, *pendingLoginID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if err == nil && attempts >= pendingLoginMaxFailures {
			if err := queries.DeletePendingLogin(ctx, *pendingLoginID); err != nil {
				return err
			}
		}
	}
	event := audit.Event{
		ActorAccountID: actor, Action: "auth.second_factor_failed", ResourceType: "account",
		ResourceID: &accountID, RequestID: requestID, ChangedFields: []string{string(method)},
	}
	if actor == nil {
		event.ActorType = audit.ActorUnknown
	}
	if err := audit.Write(ctx, tx, event); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return apperror.New(http.StatusUnprocessableEntity, "second_factor_invalid", "The code or passkey is not valid")
}

func secondFactorRequiredError() error {
	return apperror.New(
		http.StatusUnprocessableEntity,
		"second_factor_required",
		"Confirm with your authenticator app, a recovery code, or a passkey",
	)
}

func (s *Service) issuer() string {
	if s.config.PublicBaseURL != nil && s.config.PublicBaseURL.Hostname() != "" {
		return s.config.PublicBaseURL.Hostname()
	}
	return "Makerspace"
}

func accountLabel(user authdb.GetAccountWebAuthnUserRow) string {
	if user.LoginEmail != "" {
		return user.LoginEmail
	}
	return user.FirstName + " " + user.LastName
}

func timePointer(value pgtype.Timestamptz) *time.Time {
	if !value.Valid {
		return nil
	}
	result := value.Time
	return &result
}
