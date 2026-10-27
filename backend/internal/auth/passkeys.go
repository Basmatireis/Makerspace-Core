package auth

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	authdb "github.com/Basmatireis/Makerspace-Core/backend/internal/auth/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// passkeyChallengeTTL bounds every WebAuthn ceremony.
const passkeyChallengeTTL = 5 * time.Minute

// MaxPasskeyNameLength bounds a passkey's display name.
const MaxPasskeyNameLength = 100

type passkeyPurpose string

const (
	passkeyRegistration     passkeyPurpose = "registration"
	passkeyLogin            passkeyPurpose = "login"
	passkeySecondFactor     passkeyPurpose = "second_factor"
	passkeyReauthentication passkeyPurpose = "reauthentication"
)

// newWebAuthn derives the relying party from PUBLIC_BASE_URL: its host is the RP ID and its origin the only
// accepted origin. Without a base URL passkeys are unavailable.
func newWebAuthn(cfg config.Config) (*webauthn.WebAuthn, error) {
	if cfg.PublicBaseURL == nil || cfg.PublicBaseURL.Hostname() == "" {
		return nil, nil
	}
	origin := cfg.PublicBaseURL.Scheme + "://" + cfg.PublicBaseURL.Host
	return webauthn.New(&webauthn.Config{
		RPID:          cfg.PublicBaseURL.Hostname(),
		RPDisplayName: cfg.PublicBaseURL.Hostname(),
		RPOrigins:     []string{origin},
		AuthenticatorSelection: protocol.AuthenticatorSelection{
			ResidentKey:      protocol.ResidentKeyRequirementRequired,
			UserVerification: protocol.VerificationRequired,
		},
		AttestationPreference: protocol.PreferNoAttestation,
		Timeouts: webauthn.TimeoutsConfig{
			Login:        webauthn.TimeoutConfig{Enforce: true, Timeout: passkeyChallengeTTL, TimeoutUVD: passkeyChallengeTTL},
			Registration: webauthn.TimeoutConfig{Enforce: true, Timeout: passkeyChallengeTTL, TimeoutUVD: passkeyChallengeTTL},
		},
	})
}

// webAuthnUser adapts an Account to the library. The user handle is the Account ID: opaque, stable, and free of
// personal data.
type webAuthnUser struct {
	id          uuid.UUID
	name        string
	displayName string
	credentials []webauthn.Credential
	rows        []authdb.WebauthnCredential
}

func (u *webAuthnUser) WebAuthnID() []byte                         { return u.id[:] }
func (u *webAuthnUser) WebAuthnName() string                       { return u.name }
func (u *webAuthnUser) WebAuthnDisplayName() string                { return u.displayName }
func (u *webAuthnUser) WebAuthnCredentials() []webauthn.Credential { return u.credentials }

func (u *webAuthnUser) row(credentialID []byte) (authdb.WebauthnCredential, bool) {
	for _, row := range u.rows {
		if string(row.CredentialID) == string(credentialID) {
			return row, true
		}
	}
	return authdb.WebauthnCredential{}, false
}

func loadWebAuthnUser(ctx context.Context, queries *authdb.Queries, accountID uuid.UUID) (*webAuthnUser, error) {
	account, err := queries.GetAccountWebAuthnUser(ctx, accountID)
	if err != nil {
		return nil, err
	}
	if authorization.AccountStatus(account.Status) != authorization.AccountEnabled {
		return nil, apperror.InvalidCredentials
	}
	rows, err := queries.ListWebAuthnCredentials(ctx, accountID)
	if err != nil {
		return nil, err
	}
	user := &webAuthnUser{
		id: accountID, name: accountLabel(account), displayName: account.FirstName + " " + account.LastName,
		rows: rows,
	}
	for _, row := range rows {
		var credential webauthn.Credential
		if err := json.Unmarshal(row.Credential, &credential); err != nil {
			return nil, err
		}
		user.credentials = append(user.credentials, credential)
	}
	return user, nil
}

func passkeyFromRow(row authdb.WebauthnCredential) Passkey {
	var credential webauthn.Credential
	_ = json.Unmarshal(row.Credential, &credential)
	return Passkey{
		ID: row.ID, Name: row.Name, CreatedAt: row.CreatedAt, LastUsedAt: timePointer(row.LastUsedAt),
		BackedUp: credential.Flags.BackupState,
	}
}

func (s *Service) requireWebAuthn() error {
	if s.webAuthn == nil {
		return apperror.Conflicting("passkeys_unavailable", "Passkeys need a public base URL")
	}
	return nil
}

func passkeyInvalid() error {
	return apperror.New(http.StatusUnprocessableEntity, "passkey_invalid", "The passkey response is not valid")
}

// optionsJSON turns library options into the free-form object of the API contract.
func optionsJSON(value any) (map[string]any, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var result map[string]any
	return result, json.Unmarshal(encoded, &result)
}

type challengeBinding struct {
	accountID      *uuid.UUID
	sessionID      *uuid.UUID
	pendingLoginID *uuid.UUID
}

func storeChallenge(
	ctx context.Context,
	queries *authdb.Queries,
	purpose passkeyPurpose,
	session *webauthn.SessionData,
	binding challengeBinding,
) error {
	encoded, err := json.Marshal(session)
	if err != nil {
		return err
	}
	digest := sha256.Sum256([]byte(session.Challenge))
	return queries.InsertWebAuthnChallenge(ctx, authdb.InsertWebAuthnChallengeParams{
		ID: ids.New(), ChallengeDigest: digest[:], Purpose: string(purpose),
		AccountID: binding.accountID, SessionID: binding.sessionID, PendingLoginID: binding.pendingLoginID,
		SessionData: string(encoded), ExpiresAt: time.Now().UTC().Add(passkeyChallengeTTL),
	})
}

// consumeChallenge deletes the challenge the client signed in its own statement, so it is spent even when the
// verification that follows fails.
func (s *Service) consumeChallenge(
	ctx context.Context,
	purpose passkeyPurpose,
	clientChallenge string,
) (authdb.WebauthnChallenge, webauthn.SessionData, error) {
	digest := sha256.Sum256([]byte(clientChallenge))
	row, err := authdb.New(s.pool).ConsumeWebAuthnChallenge(ctx, authdb.ConsumeWebAuthnChallengeParams{
		ChallengeDigest: digest[:], Purpose: string(purpose),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return row, webauthn.SessionData{}, passkeyInvalid()
	}
	if err != nil {
		return row, webauthn.SessionData{}, err
	}
	if !row.ExpiresAt.After(time.Now()) {
		return row, webauthn.SessionData{}, passkeyInvalid()
	}
	var session webauthn.SessionData
	if err := json.Unmarshal(row.SessionData, &session); err != nil {
		return row, session, err
	}
	return row, session, nil
}

func parseAssertion(credential []byte) (*protocol.ParsedCredentialAssertionData, error) {
	parsed, err := protocol.ParseCredentialRequestResponseBytes(credential)
	if err != nil {
		return nil, passkeyInvalid()
	}
	return parsed, nil
}

// StartPasskeyRegistration returns creation options for a discoverable credential with user verification. Like
// TOTP enrollment it needs a recent normal-or-higher sign-in but no permission.
func (s *Service) StartPasskeyRegistration(ctx context.Context, principal authorization.Principal) (map[string]any, error) {
	if err := requireFreshAuthentication(principal, authorization.AssuranceNormal); err != nil {
		return nil, err
	}
	if err := s.requireWebAuthn(); err != nil {
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
	user, err := loadWebAuthnUser(ctx, queries, principal.AccountID)
	if err != nil {
		return nil, err
	}
	creation, session, err := s.webAuthn.BeginRegistration(
		user,
		webauthn.WithAuthenticatorSelection(protocol.AuthenticatorSelection{
			ResidentKey: protocol.ResidentKeyRequirementRequired, UserVerification: protocol.VerificationRequired,
		}),
		webauthn.WithResidentKeyRequirement(protocol.ResidentKeyRequirementRequired),
		webauthn.WithExclusions(webauthn.Credentials(user.credentials).CredentialDescriptors()),
	)
	if err != nil {
		return nil, err
	}
	if err := queries.DeleteWebAuthnChallengesForSession(ctx, authdb.DeleteWebAuthnChallengesForSessionParams{
		SessionID: &principal.SessionID, Purpose: string(passkeyRegistration),
	}); err != nil {
		return nil, err
	}
	if err := storeChallenge(ctx, queries, passkeyRegistration, session, challengeBinding{
		accountID: &principal.AccountID, sessionID: &principal.SessionID,
	}); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return optionsJSON(creation)
}

// RegisterPasskey verifies the attestation response and stores the passkey; it raises the session to strong_mfa.
func (s *Service) RegisterPasskey(
	ctx context.Context,
	principal authorization.Principal,
	name string,
	credential []byte,
	requestID *uuid.UUID,
) (EnrollmentResult, error) {
	if err := requireFreshAuthentication(principal, authorization.AssuranceNormal); err != nil {
		return EnrollmentResult{}, err
	}
	if err := s.requireWebAuthn(); err != nil {
		return EnrollmentResult{}, err
	}
	name = strings.TrimSpace(name)
	if name == "" || len([]rune(name)) > MaxPasskeyNameLength {
		return EnrollmentResult{}, apperror.InvalidField("name must contain 1 to 100 characters")
	}
	parsed, err := protocol.ParseCredentialCreationResponseBytes(credential)
	if err != nil {
		return EnrollmentResult{}, passkeyInvalid()
	}
	row, session, err := s.consumeChallenge(ctx, passkeyRegistration, parsed.Response.CollectedClientData.Challenge)
	if err != nil {
		return EnrollmentResult{}, err
	}
	if row.SessionID == nil || *row.SessionID != principal.SessionID ||
		row.AccountID == nil || *row.AccountID != principal.AccountID {
		return EnrollmentResult{}, passkeyInvalid()
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
	user, err := loadWebAuthnUser(ctx, queries, principal.AccountID)
	if err != nil {
		return EnrollmentResult{}, err
	}
	created, err := s.webAuthn.CreateCredential(user, session, parsed)
	if err != nil || !created.Flags.UserVerified {
		return EnrollmentResult{}, passkeyInvalid()
	}
	encoded, err := json.Marshal(created)
	if err != nil {
		return EnrollmentResult{}, err
	}
	first, err := isFirstSecondFactor(ctx, queries, principal.AccountID)
	if err != nil {
		return EnrollmentResult{}, err
	}
	stored, err := queries.InsertWebAuthnCredential(ctx, authdb.InsertWebAuthnCredentialParams{
		ID: ids.New(), AccountID: principal.AccountID, CredentialID: created.ID, Credential: string(encoded), Name: name,
	})
	if err != nil {
		var postgresError *pgconn.PgError
		if errors.As(err, &postgresError) && postgresError.Code == "23505" {
			return EnrollmentResult{}, apperror.Conflicting("passkey_already_registered", "This passkey is already registered")
		}
		return EnrollmentResult{}, err
	}
	result, err := s.finishEnrollment(
		ctx, tx, principal, first, "account.passkey_registered", "webauthn_credential", stored.ID, requestID,
	)
	if err != nil {
		return EnrollmentResult{}, err
	}
	passkey := passkeyFromRow(stored)
	result.Passkey = &passkey
	return result, nil
}

// RenameOwnPasskey changes the display name of one of the current account's passkeys.
func (s *Service) RenameOwnPasskey(
	ctx context.Context,
	principal authorization.Principal,
	passkeyID uuid.UUID,
	name string,
	requestID *uuid.UUID,
) (Passkey, error) {
	name = strings.TrimSpace(name)
	if name == "" || len([]rune(name)) > MaxPasskeyNameLength {
		return Passkey{}, apperror.InvalidField("name must contain 1 to 100 characters")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Passkey{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := authdb.New(tx)
	if _, err := lockSession(ctx, queries, principal); err != nil {
		return Passkey{}, err
	}
	row, err := queries.RenameWebAuthnCredential(ctx, authdb.RenameWebAuthnCredentialParams{
		ID: passkeyID, AccountID: principal.AccountID, Name: name,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return Passkey{}, apperror.NotFound
	}
	if err != nil {
		return Passkey{}, err
	}
	actor := principal.AccountID
	if err := audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &actor, Action: "account.passkey_renamed", ResourceType: "webauthn_credential",
		ResourceID: &passkeyID, RequestID: requestID, ChangedFields: []string{"name"},
	}); err != nil {
		return Passkey{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Passkey{}, err
	}
	return passkeyFromRow(row), nil
}

// StartPasskeyLogin returns request options for a usernameless login with a discoverable credential.
func (s *Service) StartPasskeyLogin(ctx context.Context, sourceKey string) (map[string]any, error) {
	if err := s.requireWebAuthn(); err != nil {
		return nil, err
	}
	if !s.limits.takeOptions(sourceKey, time.Now()) {
		return nil, loginRateLimited(loginLimitWindow)
	}
	assertion, session, err := s.webAuthn.BeginDiscoverableLogin(
		webauthn.WithUserVerification(protocol.VerificationRequired),
	)
	if err != nil {
		return nil, err
	}
	if err := storeChallenge(ctx, authdb.New(s.pool), passkeyLogin, session, challengeBinding{}); err != nil {
		return nil, err
	}
	return optionsJSON(assertion)
}

// CompletePasskeyLogin verifies a discoverable passkey assertion with user verification and creates a strong_mfa
// session. Every failure answers invalid_credentials.
func (s *Service) CompletePasskeyLogin(
	ctx context.Context,
	credential []byte,
	sourceKey string,
	requestID *uuid.UUID,
) (Session, error) {
	if err := s.requireWebAuthn(); err != nil {
		return Session{}, err
	}
	limitKey, allowed := s.limits.take("passkey", sourceKey, "", time.Now())
	if !allowed {
		return Session{}, loginRateLimited(loginLimitWindow)
	}
	parsed, err := parseAssertion(credential)
	if err != nil {
		return Session{}, apperror.InvalidCredentials
	}
	_, challenge, err := s.consumeChallengeFor(ctx, passkeyLogin, parsed)
	if err != nil {
		return Session{}, apperror.InvalidCredentials
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Session{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := authdb.New(tx)
	accountID, err := uuid.FromBytes(parsed.Response.UserHandle)
	if err != nil {
		return Session{}, apperror.InvalidCredentials
	}
	account, err := queries.GetAccountForAuthentication(ctx, accountID)
	if err != nil || authorization.AccountStatus(account.Status) != authorization.AccountEnabled {
		return Session{}, apperror.InvalidCredentials
	}
	user, used, err := s.verifyAssertion(ctx, queries, accountID, challenge, parsed, passkeyLogin)
	if err != nil {
		return Session{}, err
	}
	session, err := s.createPasskeySession(ctx, queries, accountID, used.ID)
	if err != nil {
		return Session{}, err
	}
	if err := queries.MarkAuthenticationSucceeded(ctx, authdb.MarkAuthenticationSucceededParams{
		AuthIdentityID: uuid.Nil, AccountID: accountID,
	}); err != nil {
		return Session{}, err
	}
	actor := user.id
	if err := audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &actor, Action: "auth.login_succeeded", ResourceType: "account", ResourceID: &actor,
		RequestID: requestID, ChangedFields: []string{"passkey"},
	}); err != nil {
		return Session{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Session{}, err
	}
	s.limits.succeeded(limitKey)
	return session, nil
}

// consumeChallengeFor spends the challenge of an assertion; a login challenge carries no binding.
func (s *Service) consumeChallengeFor(
	ctx context.Context,
	purpose passkeyPurpose,
	parsed *protocol.ParsedCredentialAssertionData,
) (authdb.WebauthnChallenge, webauthn.SessionData, error) {
	return s.consumeChallenge(ctx, purpose, parsed.Response.CollectedClientData.Challenge)
}

// verifyAssertion checks an assertion of one of accountID's passkeys against the ceremony state of the challenge
// it signed (already consumed by the caller), updates its sign counter, and rejects a counter that did not increase
// as a possible clone.
func (s *Service) verifyAssertion(
	ctx context.Context,
	queries *authdb.Queries,
	accountID uuid.UUID,
	session webauthn.SessionData,
	parsed *protocol.ParsedCredentialAssertionData,
	purpose passkeyPurpose,
) (*webAuthnUser, authdb.WebauthnCredential, error) {
	user, err := loadWebAuthnUser(ctx, queries, accountID)
	if err != nil {
		return nil, authdb.WebauthnCredential{}, apperror.InvalidCredentials
	}
	var verified *webauthn.Credential
	if purpose == passkeyLogin {
		verified, err = s.webAuthn.ValidateDiscoverableLogin(
			func(_, userHandle []byte) (webauthn.User, error) {
				if string(userHandle) != string(user.WebAuthnID()) {
					return nil, errors.New("user handle mismatch")
				}
				return user, nil
			},
			session,
			parsed,
		)
	} else {
		verified, err = s.webAuthn.ValidateLogin(user, session, parsed)
	}
	if err != nil || verified == nil || !parsed.Response.AuthenticatorData.Flags.UserVerified() {
		return nil, authdb.WebauthnCredential{}, apperror.InvalidCredentials
	}
	row, found := user.row(verified.ID)
	if !found {
		return nil, authdb.WebauthnCredential{}, apperror.InvalidCredentials
	}
	if verified.Authenticator.CloneWarning {
		return nil, authdb.WebauthnCredential{}, apperror.New(
			http.StatusUnauthorized,
			"passkey_clone_suspected",
			"This passkey's signature counter went backwards; remove it and register it again",
		)
	}
	encoded, err := json.Marshal(verified)
	if err != nil {
		return nil, authdb.WebauthnCredential{}, err
	}
	if err := queries.UpdateWebAuthnCredentialUse(ctx, authdb.UpdateWebAuthnCredentialUseParams{
		ID: row.ID, Credential: string(encoded),
	}); err != nil {
		return nil, authdb.WebauthnCredential{}, err
	}
	return user, row, nil
}

func (s *Service) createPasskeySession(
	ctx context.Context,
	queries *authdb.Queries,
	accountID, credentialID uuid.UUID,
) (Session, error) {
	token, tokenDigest, err := security.NewOpaqueToken()
	if err != nil {
		return Session{}, err
	}
	csrf, csrfDigest, err := security.NewOpaqueToken()
	if err != nil {
		return Session{}, err
	}
	policy, idle, absolute, err := s.sessionDeadlines(ctx, queries, time.Now().UTC())
	if err != nil {
		return Session{}, err
	}
	id := ids.New()
	if _, err := queries.CreatePasskeySession(ctx, authdb.CreatePasskeySessionParams{
		ID: id, AccountID: accountID, WebauthnCredentialID: credentialID, TokenDigest: tokenDigest,
		CsrfDigest: csrfDigest, IdleExpiresAt: idle, AbsoluteExpiresAt: absolute,
		ManagedDeviceID: policy.ManagedDeviceID, SessionPolicyID: policy.ID, SessionPolicyVersion: policy.Version,
		IdleTimeoutSeconds:     int32(policy.IdleTimeout / time.Second),
		PostSessionDestination: policy.PostSessionDestination,
	}); err != nil {
		return Session{}, err
	}
	return Session{
		ID: id, Token: token, CSRFToken: csrf, IdleExpiresAt: idle, AbsoluteExpiry: absolute,
		PostSessionDestination: policy.PostSessionDestination,
	}, nil
}

// StartSecondFactorPasskey returns request options for the pending login's account.
func (s *Service) StartSecondFactorPasskey(ctx context.Context, token string) (map[string]any, error) {
	if err := s.requireWebAuthn(); err != nil {
		return nil, err
	}
	pending, err := s.loadPendingLogin(ctx, token)
	if err != nil {
		return nil, err
	}
	queries := authdb.New(s.pool)
	return s.beginAccountAssertion(ctx, queries, pending.AccountID, passkeySecondFactor, challengeBinding{
		accountID: &pending.AccountID, pendingLoginID: &pending.ID,
	})
}

func (s *Service) beginAccountAssertion(
	ctx context.Context,
	queries *authdb.Queries,
	accountID uuid.UUID,
	purpose passkeyPurpose,
	binding challengeBinding,
) (map[string]any, error) {
	user, err := loadWebAuthnUser(ctx, queries, accountID)
	if err != nil {
		return nil, err
	}
	if len(user.credentials) == 0 {
		return nil, apperror.InvalidField("the account has no passkey")
	}
	assertion, session, err := s.webAuthn.BeginLogin(user, webauthn.WithUserVerification(protocol.VerificationRequired))
	if err != nil {
		return nil, err
	}
	if binding.pendingLoginID != nil {
		if err := queries.DeleteWebAuthnChallengesForPendingLogin(ctx, binding.pendingLoginID); err != nil {
			return nil, err
		}
	}
	if binding.sessionID != nil {
		if err := queries.DeleteWebAuthnChallengesForSession(ctx, authdb.DeleteWebAuthnChallengesForSessionParams{
			SessionID: binding.sessionID, Purpose: string(purpose),
		}); err != nil {
			return nil, err
		}
	}
	if err := storeChallenge(ctx, queries, purpose, session, binding); err != nil {
		return nil, err
	}
	return optionsJSON(assertion)
}

// CompleteSecondFactorPasskey finishes a pending password login with a passkey assertion.
func (s *Service) CompleteSecondFactorPasskey(
	ctx context.Context,
	token string,
	credential []byte,
	requestID *uuid.UUID,
) (Session, error) {
	if err := s.requireWebAuthn(); err != nil {
		return Session{}, err
	}
	pending, err := s.loadPendingLogin(ctx, token)
	if err != nil {
		return Session{}, err
	}
	if err := s.checkSecondFactorThrottle(ctx, pending.AccountID); err != nil {
		return Session{}, err
	}
	fail := func() error {
		return s.secondFactorFailed(ctx, pending.AccountID, nil, &pending.ID, SecondFactorPasskey, requestID)
	}
	parsed, err := parseAssertion(credential)
	if err != nil {
		return Session{}, fail()
	}
	row, session, err := s.consumeChallengeFor(ctx, passkeySecondFactor, parsed)
	if err != nil || row.PendingLoginID == nil || *row.PendingLoginID != pending.ID {
		return Session{}, fail()
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
	if _, _, err := s.verifyAssertion(ctx, queries, locked.AccountID, session, parsed, passkeySecondFactor); err != nil {
		_ = tx.Rollback(ctx)
		if apperror.IsCode(err, "passkey_clone_suspected") {
			_ = fail()
			return Session{}, err
		}
		return Session{}, fail()
	}
	return s.finishPendingLogin(ctx, tx, locked, requestID)
}

// StartPasskeyReauthentication returns request options for the current account's passkeys.
func (s *Service) StartPasskeyReauthentication(ctx context.Context, principal authorization.Principal) (map[string]any, error) {
	if err := s.requireWebAuthn(); err != nil {
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
	options, err := s.beginAccountAssertion(ctx, queries, principal.AccountID, passkeyReauthentication, challengeBinding{
		accountID: &principal.AccountID, sessionID: &principal.SessionID,
	})
	if err != nil {
		return nil, err
	}
	return options, tx.Commit(ctx)
}

// ReauthenticateWithPasskey records a strong_mfa proof on the current session.
func (s *Service) ReauthenticateWithPasskey(
	ctx context.Context,
	principal authorization.Principal,
	credential []byte,
	requestID *uuid.UUID,
) (authorization.Principal, error) {
	if err := s.requireWebAuthn(); err != nil {
		return principal, err
	}
	if err := s.checkSecondFactorThrottle(ctx, principal.AccountID); err != nil {
		return principal, err
	}
	actor := principal.AccountID
	fail := func() error {
		return s.secondFactorFailed(ctx, principal.AccountID, &actor, nil, SecondFactorPasskey, requestID)
	}
	parsed, err := parseAssertion(credential)
	if err != nil {
		return principal, fail()
	}
	row, session, err := s.consumeChallengeFor(ctx, passkeyReauthentication, parsed)
	if err != nil || row.SessionID == nil || *row.SessionID != principal.SessionID {
		return principal, fail()
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
	if _, _, err := s.verifyAssertion(ctx, queries, principal.AccountID, session, parsed, passkeyReauthentication); err != nil {
		_ = tx.Rollback(ctx)
		if apperror.IsCode(err, "passkey_clone_suspected") {
			_ = fail()
			return principal, err
		}
		return principal, fail()
	}
	if err := s.GrantRecentAuthentication(ctx, tx, principal, authorization.AssuranceStrongMFA, time.Now().UTC(), requestID); err != nil {
		return principal, err
	}
	fresh, err := s.SessionForSensitiveOperation(ctx, tx, principal, false)
	if err != nil {
		return principal, err
	}
	if err := tx.Commit(ctx); err != nil {
		return principal, err
	}
	return fresh, nil
}
