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
)

const (
	// EmailCodeTTL is how long an emailed sign-in code stays valid.
	EmailCodeTTL = 10 * time.Minute
	// emailCodeMaxAttempts wrong entries end a code; the column check caps the counter at the same value.
	emailCodeMaxAttempts = 5
	// emailCodeRequestsPerAddress and emailCodeRequestsPerSource bound the mails one address receives and one client
	// triggers within the challenge rate window.
	emailCodeRequestsPerAddress = 5
	emailCodeRequestsPerSource  = 20
	// emailCodeDeliveryTimeout bounds the mail delivery that runs after the request was answered.
	emailCodeDeliveryTimeout = time.Minute
)

// RequestEmailCode mails a sign-in code to the login email of an enabled account that signs in with an emailed code.
// It answers nil for unknown, ineligible and throttled addresses alike, and delivers the mail after returning, so
// neither the answer nor the time it takes tells whether the address belongs to an account.
func (s *Service) RequestEmailCode(ctx context.Context, email, sourceKey string, requestID *uuid.UUID) error {
	_, normalized, normalizeErr := security.NormalizeEmail(email)
	if normalizeErr != nil {
		return nil
	}
	sourceAllowed, err := s.consumeChallengeLimit(ctx, "email_code_request_source", sourceKey, emailCodeRequestsPerSource)
	if err != nil {
		return err
	}
	addressAllowed, err := s.consumeChallengeLimit(
		ctx, "email_code_request_identifier", normalized, emailCodeRequestsPerAddress,
	)
	if err != nil {
		return err
	}
	if !sourceAllowed || !addressAllowed || s.notifier == nil {
		return nil
	}
	target, err := authdb.New(s.pool).FindEmailCodeTarget(ctx, normalized)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if !target.EmailCodeEnabled || authorization.AccountStatus(target.Status) != authorization.AccountEnabled ||
		target.DeliveryAddress == nil {
		return nil
	}
	code, err := security.NewNumericCode()
	if err != nil {
		return err
	}
	expiresAt := time.Now().UTC().Add(EmailCodeTTL)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := authdb.New(tx)
	if err := lockPasswordChallengeTarget(ctx, queries, target.AccountID, target.AuthIdentityID, normalized); err != nil {
		if apperror.IsCode(err, "challenge_invalid") {
			return nil
		}
		return err
	}
	// Re-read under the Account lock: the method may have been switched off meanwhile.
	current, err := queries.FindEmailCodeTarget(ctx, normalized)
	if err != nil || !current.EmailCodeEnabled ||
		authorization.AccountStatus(current.Status) != authorization.AccountEnabled {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	}
	challenge, err := queries.UpsertAuthChallenge(ctx, authdb.UpsertAuthChallengeParams{
		ID: ids.New(), Kind: string(ChallengeEmailLogin), AccountID: target.AccountID,
		AuthIdentityID: &target.AuthIdentityID, CodeDigest: s.challengeDigest(ChallengeEmailLogin, target.AccountID, code),
		DeliveryAddress: target.DeliveryAddress, ExpiresAt: expiresAt,
	})
	if err != nil {
		return err
	}
	if err := audit.Write(ctx, tx, audit.Event{
		Action: "auth.email_code_requested", ResourceType: "account", ResourceID: &target.AccountID,
		RequestID: requestID,
	}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	address := *target.DeliveryAddress
	// The mail leaves after the answer: a slow provider must not reveal that the address has an account.
	go func() {
		deliveryCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), emailCodeDeliveryTimeout)
		defer cancel()
		deliveryErr := s.notifier.SendEmailLoginCode(deliveryCtx, address, code, expiresAt)
		s.recordChallengeDelivery(deliveryCtx, challenge.ID, requestID, deliveryErr)
	}()
	return nil
}

// emailCodeProof is a correct, unused sign-in code found under the Account lock.
type emailCodeProof struct {
	target      authdb.FindEmailCodeTargetRow
	challengeID uuid.UUID
}

// checkEmailCode takes the Account lock and the account's sign-in code inside tx and compares the code. Every reason
// the code cannot be used answers invalid credentials. A wrong code of a still-active challenge is counted and
// committed here, so the caller's transaction is finished in that case.
func (s *Service) checkEmailCode(
	ctx context.Context,
	tx pgx.Tx,
	normalized, code string,
) (emailCodeProof, error) {
	queries := authdb.New(tx)
	candidate, err := queries.FindEmailCodeTarget(ctx, normalized)
	if errors.Is(err, pgx.ErrNoRows) {
		return emailCodeProof{}, apperror.InvalidCredentials
	}
	if err != nil {
		return emailCodeProof{}, err
	}
	if _, err := queries.GetAccountForAuthentication(ctx, candidate.AccountID); errors.Is(err, pgx.ErrNoRows) {
		return emailCodeProof{}, apperror.InvalidCredentials
	} else if err != nil {
		return emailCodeProof{}, err
	}
	// Re-read the identity under the Account lock; credential changes take the same lock first.
	target, err := queries.FindEmailCodeTarget(ctx, normalized)
	if errors.Is(err, pgx.ErrNoRows) {
		return emailCodeProof{}, apperror.InvalidCredentials
	}
	if err != nil {
		return emailCodeProof{}, err
	}
	if target.AuthIdentityID != candidate.AuthIdentityID || !target.EmailCodeEnabled ||
		authorization.AccountStatus(target.Status) != authorization.AccountEnabled {
		return emailCodeProof{}, apperror.InvalidCredentials
	}
	challenge, err := queries.GetActiveAuthChallengeForUpdate(ctx, authdb.GetActiveAuthChallengeForUpdateParams{
		AccountID: target.AccountID, Kind: string(ChallengeEmailLogin),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return emailCodeProof{}, apperror.InvalidCredentials
	}
	if err != nil {
		return emailCodeProof{}, err
	}
	if !security.IsNumericCode(code) || !s.challengeValid(challenge, code) {
		if challenge.UsedAt.Valid || challenge.CancelledAt.Valid || challenge.AttemptCount >= emailCodeMaxAttempts ||
			!challenge.ExpiresAt.After(time.Now().UTC()) {
			return emailCodeProof{}, apperror.InvalidCredentials
		}
		if err := queries.IncrementAuthChallengeFailure(ctx, challenge.ID); err != nil {
			return emailCodeProof{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return emailCodeProof{}, err
		}
		return emailCodeProof{}, apperror.InvalidCredentials
	}
	if challenge.AuthIdentityID == nil || *challenge.AuthIdentityID != target.AuthIdentityID {
		return emailCodeProof{}, apperror.InvalidCredentials
	}
	return emailCodeProof{target: target, challengeID: challenge.ID}, nil
}

// LoginWithEmailCode signs in with an emailed code. Like a password login it yields a normal session, a pending login
// for an account with a second factor, or a session confined to second-factor setup. The code is used up by the
// sign-in.
func (s *Service) LoginWithEmailCode(
	ctx context.Context,
	email, code, sourceKey string,
	requestID *uuid.UUID,
) (LoginResult, error) {
	_, normalized, normalizeErr := security.NormalizeEmail(email)
	limitKey, allowed := s.limits.take("email_code", sourceKey, normalized, time.Now())
	if !allowed {
		return LoginResult{}, loginRateLimited(loginLimitWindow)
	}
	if normalizeErr != nil {
		return LoginResult{}, apperror.InvalidCredentials
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return LoginResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	proof, err := s.checkEmailCode(ctx, tx, normalized, code)
	if err != nil {
		return LoginResult{}, err
	}
	accountID, identityID := proof.target.AccountID, proof.target.AuthIdentityID
	if err := requireWebSignIn(ctx, tx, accountID); err != nil {
		return LoginResult{}, err
	}
	queries := authdb.New(tx)
	if consumed, err := queries.ConsumeEmailLoginChallenge(ctx, proof.challengeID); err != nil {
		return LoginResult{}, err
	} else if consumed != 1 {
		return LoginResult{}, apperror.InvalidCredentials
	}
	state, err := queries.GetAccountSecondFactorState(ctx, accountID)
	if err != nil {
		return LoginResult{}, err
	}
	if state.TotpEnrolled || state.PasskeyCount > 0 {
		pending, err := s.createPendingLogin(ctx, queries, accountID, identityID, MethodEmailCode, state)
		if err != nil {
			return LoginResult{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return LoginResult{}, err
		}
		s.limits.succeeded(limitKey)
		return LoginResult{Pending: &pending}, nil
	}
	// An emailed code proves control of the mailbox, which already allows a password reset: normal assurance.
	session, err := s.createSession(
		ctx, queries, accountID, identityID, MethodEmailCode, authorization.AssuranceNormal, state.Required,
	)
	if err != nil {
		return LoginResult{}, err
	}
	if err := queries.MarkAuthenticationSucceeded(ctx, authdb.MarkAuthenticationSucceededParams{
		AuthIdentityID: identityID, AccountID: accountID,
	}); err != nil {
		return LoginResult{}, err
	}
	if err := audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &accountID, Action: "auth.email_code_login_succeeded", ResourceType: "account",
		ResourceID: &accountID, RequestID: requestID,
	}); err != nil {
		return LoginResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return LoginResult{}, err
	}
	s.limits.succeeded(limitKey)
	return LoginResult{Session: &session}, nil
}

// VerifyEmailCodeForAttendance checks an emailed code for a kiosk check-in or check-out without using it up: the
// kiosk repeats the request with the same code after showing the Lab Rules. ConsumeVerifiedTx uses it up inside the
// attendance transaction.
func (s *Service) VerifyEmailCodeForAttendance(
	ctx context.Context,
	email, code, sourceKey string,
) (VerifiedIdentity, error) {
	_, normalized, normalizeErr := security.NormalizeEmail(email)
	limitKey, allowed := s.limits.take("attendance_email_code", sourceKey, normalized, time.Now())
	if !allowed {
		return VerifiedIdentity{}, loginRateLimited(loginLimitWindow)
	}
	if normalizeErr != nil {
		return VerifiedIdentity{}, apperror.InvalidCredentials
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return VerifiedIdentity{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	proof, err := s.checkEmailCode(ctx, tx, normalized, code)
	if err != nil {
		return VerifiedIdentity{}, err
	}
	s.limits.succeeded(limitKey)
	challengeID := proof.challengeID
	return VerifiedIdentity{
		AccountID:        proof.target.AccountID,
		PersonID:         proof.target.PersonID,
		Method:           string(MethodEmailCode),
		Assurance:        authorization.AssuranceNormal,
		emailChallengeID: &challengeID,
	}, nil
}

// ConsumeVerifiedTx uses up the one-time proof behind a verified identity inside the caller's transaction, so the
// proof is spent exactly when the attendance change commits. Identities verified by a password or PIN carry no
// one-time proof.
func (s *Service) ConsumeVerifiedTx(ctx context.Context, tx pgx.Tx, verified VerifiedIdentity) error {
	if verified.emailChallengeID == nil {
		return nil
	}
	consumed, err := authdb.New(tx).ConsumeEmailLoginChallenge(ctx, *verified.emailChallengeID)
	if err != nil {
		return err
	}
	if consumed != 1 {
		return apperror.InvalidCredentials
	}
	return nil
}

// SetOwnEmailCode switches sign-in with an emailed code on or off for the signed-in account. Like changing the own
// PIN it needs a fresh normal sign-in. Switching it off deletes outstanding codes and ends the account's other
// sessions.
func (s *Service) SetOwnEmailCode(
	ctx context.Context,
	principal authorization.Principal,
	enabled bool,
	requestID *uuid.UUID,
) error {
	if !principal.Has(authorization.AccountsEmailCodeManageSelf) {
		return apperror.PermissionDenied
	}
	if !principal.HasFreshAssurance(authorization.AssuranceNormal, freshMethodAuthentication, time.Now()) {
		return apperror.New(
			http.StatusForbidden,
			"fresh_authentication_required",
			"Fresh normal authentication is required",
		)
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
	identity, err := queries.GetPasswordIdentityTargetForAccount(ctx, principal.AccountID)
	if errors.Is(err, pgx.ErrNoRows) {
		if !enabled {
			return nil
		}
		return LoginEmailRequired()
	}
	if err != nil {
		return err
	}
	changed, err := queries.SetEmailCodeEnabled(ctx, authdb.SetEmailCodeEnabledParams{
		ID: identity.AuthIdentityID, Enabled: enabled,
	})
	if err != nil {
		return err
	}
	if changed == 0 {
		return nil
	}
	action := "account.email_code_enabled"
	if !enabled {
		action = "account.email_code_disabled"
		if err := queries.DeleteEmailLoginChallengesForAccount(ctx, principal.AccountID); err != nil {
			return err
		}
		if err := queries.RevokeOtherSessionsForAccount(ctx, authdb.RevokeOtherSessionsForAccountParams{
			Reason: optional.Of("email_code_disabled"), AccountID: principal.AccountID,
			CurrentSessionID: principal.SessionID,
		}); err != nil {
			return err
		}
	}
	if err := queries.BumpAccountVersionAfterCredentialChange(ctx, principal.AccountID); err != nil {
		return err
	}
	actor := principal.AccountID
	if err := audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &actor, Action: action, ResourceType: "account", ResourceID: &actor,
		RequestID: requestID, ChangedFields: []string{"emailCodeMethod"},
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// LoginEmailRequired answers switching on the emailed code for an account without a login email.
func LoginEmailRequired() error {
	return apperror.New(
		http.StatusUnprocessableEntity,
		"login_email_required",
		"The account needs a login email before it can sign in with an emailed code",
	)
}
