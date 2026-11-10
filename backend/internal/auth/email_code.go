package auth

import (
	"context"
	"errors"
	"log/slog"
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
	// EmailCodeFailureBudget wrong codes of one account within EmailCodeFailureWindow, across all its codes, stop
	// the method for that account until the oldest of them leaves the window: a new code resets the per-code
	// attempts, so without this budget an attacker could keep requesting codes and guessing.
	EmailCodeFailureBudget = 10
	EmailCodeFailureWindow = 24 * time.Hour
	// emailCodeRequestsPerAddress and emailCodeRequestsPerSource bound the mails one address receives and one client
	// triggers within the challenge rate window.
	emailCodeRequestsPerAddress = 5
	emailCodeRequestsPerSource  = 20
	// emailCodeIssueTimeout bounds issuing and delivering a code, which runs after the request was answered.
	emailCodeIssueTimeout = time.Minute
)

// RequestEmailCode mails a code for the web login (POST /auth/email-code).
func (s *Service) RequestEmailCode(ctx context.Context, email, sourceKey string, requestID *uuid.UUID) error {
	return s.requestEmailCode(ctx, ChallengeEmailLogin, email, sourceKey, requestID)
}

// RequestCheckInEmailCode mails a code for checking in or out at a kiosk; it does not work for the web login.
func (s *Service) RequestCheckInEmailCode(ctx context.Context, email, sourceKey string, requestID *uuid.UUID) error {
	return s.requestEmailCode(ctx, ChallengeEmailCheckIn, email, sourceKey, requestID)
}

// requestEmailCode answers nil for every well-formed request: whether the address belongs to an enabled account that
// signs in with an emailed code is decided, and the code issued and mailed, only after the answer, so neither the
// answer nor its timing tells whether the address has an account.
func (s *Service) requestEmailCode(
	ctx context.Context,
	kind ChallengeKind,
	email, sourceKey string,
	requestID *uuid.UUID,
) error {
	_, normalized, normalizeErr := security.NormalizeEmail(email)
	if normalizeErr != nil {
		return nil //nolint:nilerr // a malformed address gets the same accepted answer as any other
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
	go func() {
		issueCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), emailCodeIssueTimeout)
		defer cancel()
		if err := s.issueEmailCode(issueCtx, kind, normalized, requestID); err != nil {
			attrs := []any{"kind", string(kind), "error", err}
			if requestID != nil {
				attrs = append(attrs, "request_id", requestID.String())
			}
			slog.ErrorContext(issueCtx, "issue emailed sign-in code", attrs...)
		}
	}()
	return nil
}

// issueEmailCode creates the code and its audit event in one transaction and mails it, for an enabled account whose
// login email signs in with an emailed code and whose failure budget is not used up. Anything else issues nothing.
func (s *Service) issueEmailCode(ctx context.Context, kind ChallengeKind, normalized string, requestID *uuid.UUID) error {
	target, err := authdb.New(s.pool).FindEmailCodeTarget(ctx, normalized)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if !emailCodeUsable(target) {
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
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if !emailCodeUsable(current) {
		return nil
	}
	if exhausted, err := emailCodeBudgetExhausted(ctx, queries, current.AccountID); err != nil || exhausted {
		return err
	}
	challenge, err := queries.UpsertAuthChallenge(ctx, authdb.UpsertAuthChallengeParams{
		ID: ids.New(), Kind: string(kind), AccountID: current.AccountID,
		AuthIdentityID: &current.AuthIdentityID, CodeDigest: s.challengeDigest(kind, current.AccountID, code),
		DeliveryAddress: current.DeliveryAddress, ExpiresAt: expiresAt,
	})
	if err != nil {
		return err
	}
	if err := audit.Write(ctx, tx, audit.Event{
		Action: "auth.email_code_requested", ResourceType: "account", ResourceID: &current.AccountID,
		RequestID: requestID, ChangedFields: []string{string(kind)},
	}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	deliveryErr := s.notifier.SendEmailLoginCode(ctx, *current.DeliveryAddress, code, expiresAt)
	s.recordChallengeDelivery(ctx, challenge.ID, requestID, deliveryErr)
	return nil
}

// emailCodeUsable is whether the identity may receive and use emailed codes right now.
func emailCodeUsable(target authdb.FindEmailCodeTargetRow) bool {
	return target.EmailCodeEnabled && !target.ResetRequired && target.DeliveryAddress != nil &&
		authorization.AccountStatus(target.Status) == authorization.AccountEnabled
}

func emailCodeBudgetExhausted(ctx context.Context, queries *authdb.Queries, accountID uuid.UUID) (bool, error) {
	failures, err := queries.CountEmailCodeFailures(ctx, authdb.CountEmailCodeFailuresParams{
		AccountID: accountID, Since: time.Now().UTC().Add(-EmailCodeFailureWindow),
	})
	return failures >= EmailCodeFailureBudget, err
}

// emailCodeProof is a correct, unused code found under the Account lock.
type emailCodeProof struct {
	target      authdb.FindEmailCodeTargetRow
	challengeID uuid.UUID
}

// checkEmailCode takes the Account lock and the account's code of the given kind inside tx and compares the code.
// Every reason the code cannot be used answers invalid credentials, including a used-up failure budget. A wrong code
// of a still-active challenge counts against the code and the account's budget and is committed here, so the
// caller's transaction is finished in that case.
func (s *Service) checkEmailCode(
	ctx context.Context,
	tx pgx.Tx,
	kind ChallengeKind,
	normalized, code string,
	requestID *uuid.UUID,
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
	if target.AuthIdentityID != candidate.AuthIdentityID || !emailCodeUsable(target) {
		return emailCodeProof{}, apperror.InvalidCredentials
	}
	if exhausted, err := emailCodeBudgetExhausted(ctx, queries, target.AccountID); err != nil {
		return emailCodeProof{}, err
	} else if exhausted {
		return emailCodeProof{}, apperror.InvalidCredentials
	}
	challenge, err := queries.GetActiveAuthChallengeForUpdate(ctx, authdb.GetActiveAuthChallengeForUpdateParams{
		AccountID: target.AccountID, Kind: string(kind),
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
		if err := recordEmailCodeFailure(ctx, tx, challenge, requestID); err != nil {
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

// recordEmailCodeFailure counts a wrong code against the code and the account's rolling budget. The wrong code that
// uses up the budget is audited, without the address or the code.
func recordEmailCodeFailure(
	ctx context.Context,
	tx pgx.Tx,
	challenge authdb.AuthChallenge,
	requestID *uuid.UUID,
) error {
	queries := authdb.New(tx)
	if err := queries.IncrementAuthChallengeFailure(ctx, challenge.ID); err != nil {
		return err
	}
	if err := queries.RecordEmailCodeFailure(ctx, authdb.RecordEmailCodeFailureParams{
		ID: ids.New(), AccountID: challenge.AccountID,
	}); err != nil {
		return err
	}
	failures, err := queries.CountEmailCodeFailures(ctx, authdb.CountEmailCodeFailuresParams{
		AccountID: challenge.AccountID, Since: time.Now().UTC().Add(-EmailCodeFailureWindow),
	})
	if err != nil || failures != EmailCodeFailureBudget {
		return err
	}
	return audit.Write(ctx, tx, audit.Event{
		Action: "auth.email_code_blocked", ResourceType: "account", ResourceID: &challenge.AccountID,
		RequestID: requestID,
	})
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
	proof, err := s.checkEmailCode(ctx, tx, ChallengeEmailLogin, normalized, code, requestID)
	if err != nil {
		return LoginResult{}, err
	}
	accountID, identityID := proof.target.AccountID, proof.target.AuthIdentityID
	if err := requireWebSignIn(ctx, tx, accountID); err != nil {
		return LoginResult{}, err
	}
	queries := authdb.New(tx)
	if consumed, err := queries.ConsumeEmailCodeChallenge(ctx, proof.challengeID); err != nil {
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
	proof, err := s.checkEmailCode(ctx, tx, ChallengeEmailCheckIn, normalized, code, nil)
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
	consumed, err := authdb.New(tx).ConsumeEmailCodeChallenge(ctx, *verified.emailChallengeID)
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
