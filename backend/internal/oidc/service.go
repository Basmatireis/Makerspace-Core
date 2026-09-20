package oidc

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/auth"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	oidcdb "github.com/Basmatireis/Makerspace-Core/backend/internal/oidc/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	coreoidc "github.com/coreos/go-oidc/v3/oidc"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/oauth2"
)

const flowTTL = 10 * time.Minute

var providerSlugPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{1,62}[a-z0-9]$`)

type Provider struct {
	ID                   uuid.UUID
	Slug                 string
	DisplayName          string
	Issuer               string
	ClientID             string
	Enabled              bool
	JITEnabled           bool
	ACRAssuranceMappings map[string]authorization.Assurance
	Version              int64
	CreatedAt            time.Time
	UpdatedAt            time.Time
}

type ProviderInput struct {
	Slug                 string
	DisplayName          string
	Issuer               string
	ClientID             string
	ClientSecret         *string
	Enabled              bool
	JITEnabled           bool
	ACRAssuranceMappings map[string]authorization.Assurance
	ExpectedVersion      int64
}

type LoginProvider struct {
	Slug        string
	DisplayName string
}

type FlowStart struct {
	AuthorizationURL string
	BrowserToken     string
	ExpiresAt        time.Time
}

type Completion struct {
	Kind    string
	Session *auth.Session
}

type Service struct {
	pool        *pgxpool.Pool
	config      config.Config
	keyring     *security.Keyring
	auth        *auth.Service
	newProvider func(context.Context, string) (*coreoidc.Provider, error)
	now         func() time.Time
}

func NewService(pool *pgxpool.Pool, cfg config.Config, authService *auth.Service) (*Service, error) {
	var keyring *security.Keyring
	if len(cfg.EncryptionKeys) > 0 {
		var err error
		keyring, err = security.NewKeyring(cfg.EncryptionKeys)
		if err != nil {
			return nil, err
		}
	}
	return &Service{pool: pool, config: cfg, keyring: keyring, auth: authService, newProvider: coreoidc.NewProvider, now: func() time.Time { return time.Now().UTC() }}, nil
}

func (s *Service) ValidateConfiguration(ctx context.Context) error {
	if s.pool == nil {
		return nil
	}
	providers, err := oidcdb.New(s.pool).ListProviders(ctx)
	if err != nil {
		return err
	}
	for _, provider := range providers {
		if !provider.Enabled {
			continue
		}
		if s.keyring == nil {
			return errors.New("an enabled OIDC provider requires APP_ENCRYPTION_KEYS")
		}
		if _, err := s.keyring.Decrypt(provider.EncryptedClientSecret, providerSecretPurpose(provider.ID)); err != nil {
			return fmt.Errorf("validate enabled OIDC provider %s secret: %w", provider.ID, err)
		}
		if _, err := providerFromRow(provider); err != nil {
			return fmt.Errorf("validate enabled OIDC provider %s: %w", provider.ID, err)
		}
	}
	return nil
}

func (s *Service) ListProviders(ctx context.Context, principal authorization.Principal) ([]Provider, error) {
	if !principal.Has(authorization.OIDCManage) {
		return nil, apperror.PermissionDenied
	}
	rows, err := oidcdb.New(s.pool).ListProviders(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]Provider, 0, len(rows))
	for _, row := range rows {
		provider, err := providerFromRow(row)
		if err != nil {
			return nil, err
		}
		result = append(result, provider)
	}
	return result, nil
}

func (s *Service) ListLoginProviders(ctx context.Context) ([]LoginProvider, error) {
	rows, err := oidcdb.New(s.pool).ListEnabledLoginProviders(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]LoginProvider, 0, len(rows))
	for _, row := range rows {
		result = append(result, LoginProvider{Slug: row.Slug, DisplayName: row.DisplayName})
	}
	return result, nil
}

func (s *Service) CreateProvider(ctx context.Context, principal authorization.Principal, input ProviderInput, requestID *uuid.UUID) (Provider, error) {
	if !principal.Has(authorization.OIDCManage) {
		return Provider{}, apperror.PermissionDenied
	}
	if s.keyring == nil {
		return Provider{}, oidcNotConfigured()
	}
	input, mappings, err := validateProviderInput(input, true)
	if err != nil {
		return Provider{}, err
	}
	id := uuid.Must(uuid.NewV7())
	secret, err := s.keyring.Encrypt([]byte(*input.ClientSecret), providerSecretPurpose(id))
	if err != nil {
		return Provider{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Provider{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row, err := oidcdb.New(tx).CreateProvider(ctx, oidcdb.CreateProviderParams{
		ID: id, Slug: input.Slug, DisplayName: input.DisplayName, Issuer: input.Issuer,
		ClientID: input.ClientID, EncryptedClientSecret: secret, Enabled: input.Enabled,
		JitEnabled: input.JITEnabled, AcrAssuranceMappings: string(mappings),
	})
	if err != nil {
		return Provider{}, translateWriteError(err)
	}
	actor := principal.AccountID
	if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "oidc.provider_created", ResourceType: "oidc_provider", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"slug", "displayName", "issuer", "clientId", "clientSecret", "enabled", "jitEnabled", "acrAssuranceMappings"}}); err != nil {
		return Provider{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Provider{}, err
	}
	return providerFromRow(row)
}

func (s *Service) UpdateProvider(ctx context.Context, principal authorization.Principal, id uuid.UUID, input ProviderInput, requestID *uuid.UUID) (Provider, error) {
	if !principal.Has(authorization.OIDCManage) {
		return Provider{}, apperror.PermissionDenied
	}
	if s.keyring == nil {
		return Provider{}, oidcNotConfigured()
	}
	input, mappings, err := validateProviderInput(input, false)
	if err != nil {
		return Provider{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Provider{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := oidcdb.New(tx)
	existing, err := queries.GetProvider(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Provider{}, apperror.NotFound
	}
	if err != nil {
		return Provider{}, err
	}
	secret := existing.EncryptedClientSecret
	if input.ClientSecret != nil {
		secret, err = s.keyring.Encrypt([]byte(*input.ClientSecret), providerSecretPurpose(id))
		if err != nil {
			return Provider{}, err
		}
	}
	row, err := queries.UpdateProvider(ctx, oidcdb.UpdateProviderParams{
		DisplayName: input.DisplayName, Issuer: input.Issuer, ClientID: input.ClientID,
		EncryptedClientSecret: secret, Enabled: input.Enabled, JitEnabled: input.JITEnabled,
		AcrAssuranceMappings: string(mappings), ID: id, ExpectedVersion: input.ExpectedVersion,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return Provider{}, apperror.StaleWrite
	}
	if err != nil {
		return Provider{}, translateWriteError(err)
	}
	changed := []string{"displayName", "issuer", "clientId", "enabled", "jitEnabled", "acrAssuranceMappings"}
	if input.ClientSecret != nil {
		changed = append(changed, "clientSecret")
	}
	actor := principal.AccountID
	if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "oidc.provider_updated", ResourceType: "oidc_provider", ResourceID: &id, RequestID: requestID, ChangedFields: changed}); err != nil {
		return Provider{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Provider{}, err
	}
	return providerFromRow(row)
}

// ReencryptProviderSecrets rewrites only provider secrets encrypted under an
// older configured application key. It is intended for the administrative CLI.
func (s *Service) ReencryptProviderSecrets(ctx context.Context) (int64, error) {
	if s.keyring == nil {
		return 0, oidcNotConfigured()
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := oidcdb.New(tx)
	providers, err := queries.ListProviders(ctx)
	if err != nil {
		return 0, err
	}
	var changed int64
	for _, provider := range providers {
		if !s.keyring.NeedsRotation(provider.EncryptedClientSecret) {
			continue
		}
		plaintext, err := s.keyring.Decrypt(provider.EncryptedClientSecret, providerSecretPurpose(provider.ID))
		if err != nil {
			return 0, fmt.Errorf("decrypt provider %s: %w", provider.ID, err)
		}
		ciphertext, err := s.keyring.Encrypt(plaintext, providerSecretPurpose(provider.ID))
		if err != nil {
			return 0, err
		}
		rows, err := queries.RotateProviderSecret(ctx, oidcdb.RotateProviderSecretParams{EncryptedClientSecret: ciphertext, ID: provider.ID})
		if err != nil {
			return 0, err
		}
		changed += rows
		id := provider.ID
		if err := audit.Write(ctx, tx, audit.Event{Action: "oidc.provider_secret_reencrypted", ResourceType: "oidc_provider", ResourceID: &id, ChangedFields: []string{"clientSecret"}, Source: "admin_cli"}); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return changed, nil
}

func (s *Service) StartLogin(ctx context.Context, slug string) (FlowStart, error) {
	provider, err := oidcdb.New(s.pool).GetEnabledProviderBySlug(ctx, strings.TrimSpace(slug))
	if errors.Is(err, pgx.ErrNoRows) {
		return FlowStart{}, apperror.NotFound
	}
	if err != nil {
		return FlowStart{}, err
	}
	return s.startFlow(ctx, provider, "login", nil, nil)
}

func (s *Service) StartLink(ctx context.Context, principal authorization.Principal, slug, password string) (FlowStart, error) {
	if password != "" {
		var err error
		principal, err = s.auth.ReauthenticatePassword(ctx, principal, password, nil)
		if err != nil {
			return FlowStart{}, err
		}
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return FlowStart{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	principal, err = s.auth.SessionForSensitiveOperation(ctx, tx, principal, true)
	if err != nil {
		return FlowStart{}, err
	}
	if !principal.Has(authorization.OIDCLinkSelf) {
		return FlowStart{}, apperror.PermissionDenied
	}
	provider, err := oidcdb.New(tx).GetEnabledProviderBySlug(ctx, strings.TrimSpace(slug))
	if errors.Is(err, pgx.ErrNoRows) {
		return FlowStart{}, apperror.NotFound
	}
	if err != nil {
		return FlowStart{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return FlowStart{}, err
	}
	return s.startFlow(ctx, provider, "link", &principal.AccountID, &principal.SessionID)
}

// Reauthentication is bound to an existing session and an already-linked
// provider. Its callback cannot provision, link, or switch to another account.
func (s *Service) StartReauthentication(ctx context.Context, principal authorization.Principal, slug string) (FlowStart, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return FlowStart{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := s.auth.SessionForSensitiveOperation(ctx, tx, principal, false); err != nil {
		return FlowStart{}, err
	}
	queries := oidcdb.New(tx)
	provider, err := queries.GetEnabledProviderBySlug(ctx, strings.TrimSpace(slug))
	if errors.Is(err, pgx.ErrNoRows) {
		return FlowStart{}, apperror.NotFound
	}
	if err != nil {
		return FlowStart{}, err
	}
	linked, err := queries.HasLinkedProvider(ctx, oidcdb.HasLinkedProviderParams{AccountID: principal.AccountID, ProviderID: &provider.ID})
	if err != nil {
		return FlowStart{}, err
	}
	if !linked {
		return FlowStart{}, apperror.PermissionDenied
	}
	if err := tx.Commit(ctx); err != nil {
		return FlowStart{}, err
	}
	return s.startFlow(ctx, provider, "reauthenticate", &principal.AccountID, &principal.SessionID)
}

func (s *Service) startFlow(ctx context.Context, provider oidcdb.OidcProvider, kind string, accountID, sessionID *uuid.UUID) (FlowStart, error) {
	if s.keyring == nil {
		return FlowStart{}, oidcNotConfigured()
	}
	clientSecret, err := s.keyring.Decrypt(provider.EncryptedClientSecret, providerSecretPurpose(provider.ID))
	if err != nil {
		return FlowStart{}, fmt.Errorf("decrypt OIDC client secret: %w", err)
	}
	discovered, err := s.newProvider(ctx, provider.Issuer)
	if err != nil {
		return FlowStart{}, fmt.Errorf("discover OIDC provider: %w", err)
	}
	state, stateDigest, err := security.NewOpaqueToken()
	if err != nil {
		return FlowStart{}, err
	}
	browserToken, browserDigest, err := security.NewOpaqueToken()
	if err != nil {
		return FlowStart{}, err
	}
	nonce, _, err := security.NewOpaqueToken()
	if err != nil {
		return FlowStart{}, err
	}
	verifier, _, err := security.NewOpaqueToken()
	if err != nil {
		return FlowStart{}, err
	}
	flowID := uuid.Must(uuid.NewV7())
	encryptedNonce, err := s.keyring.Encrypt([]byte(nonce), flowNoncePurpose(flowID))
	if err != nil {
		return FlowStart{}, err
	}
	encryptedVerifier, err := s.keyring.Encrypt([]byte(verifier), flowVerifierPurpose(flowID))
	if err != nil {
		return FlowStart{}, err
	}
	expiresAt := s.now().Add(flowTTL)
	if _, err := oidcdb.New(s.pool).CreateFlow(ctx, oidcdb.CreateFlowParams{
		ID: flowID, ProviderID: provider.ID, Kind: kind, AccountID: accountID, SessionID: sessionID,
		StateDigest: stateDigest, BrowserTokenDigest: browserDigest, EncryptedNonce: encryptedNonce,
		EncryptedPkceVerifier: encryptedVerifier, ExpiresAt: expiresAt,
	}); err != nil {
		return FlowStart{}, err
	}
	config := oauthConfig(discovered, provider, string(clientSecret), s.callbackURL())
	options := []oauth2.AuthCodeOption{oauth2.SetAuthURLParam("nonce", nonce), oauth2.S256ChallengeOption(verifier)}
	if kind == "reauthenticate" {
		options = append(options, oauth2.SetAuthURLParam("max_age", "0"), oauth2.SetAuthURLParam("prompt", "login"))
	}
	return FlowStart{
		AuthorizationURL: config.AuthCodeURL(state, options...),
		BrowserToken:     browserToken, ExpiresAt: expiresAt,
	}, nil
}

func (s *Service) Complete(ctx context.Context, state, code, browserToken string, principal authorization.Principal, requestID *uuid.UUID) (Completion, error) {
	if s.keyring == nil || strings.TrimSpace(state) == "" || strings.TrimSpace(code) == "" || strings.TrimSpace(browserToken) == "" {
		return Completion{}, invalidRequest("OIDC callback state is invalid")
	}
	stateDigest := sha256.Sum256([]byte(state))
	browserDigest := sha256.Sum256([]byte(browserToken))
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Completion{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := oidcdb.New(tx)
	contextFlow, err := queries.GetFlowContext(ctx, oidcdb.GetFlowContextParams{StateDigest: stateDigest[:], BrowserTokenDigest: browserDigest[:]})
	if errors.Is(err, pgx.ErrNoRows) {
		return Completion{}, invalidRequest("OIDC callback state is invalid or expired")
	}
	if err != nil {
		return Completion{}, err
	}
	if contextFlow.Kind != "login" {
		if contextFlow.SessionID == nil || contextFlow.AccountID == nil || *contextFlow.SessionID != principal.SessionID || *contextFlow.AccountID != principal.AccountID {
			return Completion{}, apperror.Unauthenticated
		}
		principal, err = s.auth.SessionForSensitiveOperation(ctx, tx, principal, contextFlow.Kind == "link")
		if err != nil {
			return Completion{}, err
		}
		if contextFlow.Kind == "link" && !principal.Has(authorization.OIDCLinkSelf) {
			return Completion{}, apperror.PermissionDenied
		}
	}
	flow, err := queries.GetFlowForCallback(ctx, oidcdb.GetFlowForCallbackParams{StateDigest: stateDigest[:], BrowserTokenDigest: browserDigest[:]})
	if errors.Is(err, pgx.ErrNoRows) {
		return Completion{}, invalidRequest("OIDC callback state is invalid or expired")
	}
	if err != nil {
		return Completion{}, err
	}
	provider, err := queries.GetProviderForFlow(ctx, flow.ProviderID)
	if err != nil || !provider.Enabled {
		return Completion{}, apperror.New(403, "oidc_provider_unavailable", "OIDC provider is unavailable")
	}
	nonce, err := s.keyring.Decrypt(flow.EncryptedNonce, flowNoncePurpose(flow.ID))
	if err != nil {
		return Completion{}, err
	}
	verifier, err := s.keyring.Decrypt(flow.EncryptedPkceVerifier, flowVerifierPurpose(flow.ID))
	if err != nil {
		return Completion{}, err
	}
	clientSecret, err := s.keyring.Decrypt(provider.EncryptedClientSecret, providerSecretPurpose(provider.ID))
	if err != nil {
		return Completion{}, err
	}
	discovered, err := s.newProvider(ctx, provider.Issuer)
	if err != nil {
		return Completion{}, fmt.Errorf("discover OIDC provider: %w", err)
	}
	oauth := oauthConfig(discovered, provider, string(clientSecret), s.callbackURL())
	token, err := oauth.Exchange(ctx, code, oauth2.VerifierOption(string(verifier)))
	if err != nil {
		return Completion{}, invalidRequest("OIDC authorization code could not be verified")
	}
	rawIDToken, ok := token.Extra("id_token").(string)
	if !ok || rawIDToken == "" {
		return Completion{}, invalidRequest("OIDC response did not contain an ID token")
	}
	idToken, err := discovered.Verifier(&coreoidc.Config{ClientID: provider.ClientID}).Verify(ctx, rawIDToken)
	if err != nil {
		return Completion{}, invalidRequest("OIDC ID token could not be verified")
	}
	var claims tokenClaims
	if err := idToken.Claims(&claims); err != nil || claims.Subject == "" || claims.Nonce != string(nonce) {
		return Completion{}, invalidRequest("OIDC ID token claims are invalid")
	}
	assurance, err := assuranceForClaims(provider.AcrAssuranceMappings, claims.ACR)
	if err != nil {
		return Completion{}, err
	}
	issuer := provider.Issuer
	subject := claims.Subject
	var accountID, identityID uuid.UUID
	var actor *uuid.UUID
	if flow.Kind == "link" {
		// Discovery and token exchange may take time; the capability must still
		// be fresh at the point where the new identity is attached.
		if _, err := s.auth.SessionForSensitiveOperation(ctx, tx, principal, true); err != nil {
			return Completion{}, err
		}
		if flow.AccountID == nil {
			return Completion{}, invalidRequest("OIDC linking context is invalid")
		}
		if _, findErr := queries.FindOIDCIdentity(ctx, oidcdb.FindOIDCIdentityParams{Issuer: &issuer, Subject: &subject}); findErr == nil {
			return Completion{}, apperror.Conflict
		} else if !errors.Is(findErr, pgx.ErrNoRows) {
			return Completion{}, findErr
		}
		identityID = uuid.Must(uuid.NewV7())
		accountID = *flow.AccountID
		if _, err := queries.CreateOIDCIdentity(ctx, oidcdb.CreateOIDCIdentityParams{ID: identityID, AccountID: accountID, ProviderID: &provider.ID, Issuer: &issuer, Subject: &subject}); err != nil {
			return Completion{}, translateWriteError(err)
		}
		if err := queries.BumpAccountVersion(ctx, accountID); err != nil {
			return Completion{}, err
		}
		actor = &accountID
		if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: actor, Action: "auth.oidc_linked", ResourceType: "auth_identity", ResourceID: &identityID, RequestID: requestID, ChangedFields: []string{"kind", "providerId", "issuer", "subject"}}); err != nil {
			return Completion{}, err
		}
	} else if flow.Kind == "reauthenticate" {
		found, err := queries.FindOIDCIdentity(ctx, oidcdb.FindOIDCIdentityParams{Issuer: &issuer, Subject: &subject})
		if err != nil || found.AccountID != principal.AccountID || found.Status != "enabled" {
			return Completion{}, apperror.PermissionDenied
		}
		authenticatedAt := time.Unix(claims.AuthTime, 0).UTC()
		if claims.AuthTime == 0 || authenticatedAt.Before(flow.CreatedAt.Truncate(time.Second)) || authenticatedAt.After(s.now()) {
			return Completion{}, invalidRequest("OIDC reauthentication did not prove recent authentication")
		}
		if err := s.auth.GrantRecentAuthentication(ctx, tx, principal, assurance, authenticatedAt, requestID); err != nil {
			return Completion{}, err
		}
	} else if flow.Kind == "login" {
		found, findErr := queries.FindOIDCIdentity(ctx, oidcdb.FindOIDCIdentityParams{Issuer: &issuer, Subject: &subject})
		if findErr == nil {
			if found.Status != "enabled" {
				return Completion{}, apperror.New(403, "account_disabled", "Account is disabled")
			}
			accountID, identityID = found.AccountID, found.IdentityID
		} else if errors.Is(findErr, pgx.ErrNoRows) && provider.JitEnabled {
			personID := uuid.Must(uuid.NewV7())
			accountID = uuid.Must(uuid.NewV7())
			identityID = uuid.Must(uuid.NewV7())
			firstName, lastName, email, phone, claimErr := jitPersonFields(claims)
			if claimErr != nil {
				return Completion{}, claimErr
			}
			if _, err := queries.CreateJITPerson(ctx, oidcdb.CreateJITPersonParams{ID: personID, FirstName: firstName, LastName: lastName, Email: email, Phone: phone}); err != nil {
				return Completion{}, translateWriteError(err)
			}
			if _, err := queries.CreateJITAccount(ctx, oidcdb.CreateJITAccountParams{ID: accountID, PersonID: personID}); err != nil {
				return Completion{}, err
			}
			if _, err := queries.CreateOIDCIdentity(ctx, oidcdb.CreateOIDCIdentityParams{ID: identityID, AccountID: accountID, ProviderID: &provider.ID, Issuer: &issuer, Subject: &subject}); err != nil {
				return Completion{}, translateWriteError(err)
			}
			if err := audit.Write(ctx, tx, audit.Event{Action: "auth.oidc_jit_provisioned", ResourceType: "account", ResourceID: &accountID, RequestID: requestID, ChangedFields: []string{"person", "account", "identity"}}); err != nil {
				return Completion{}, err
			}
		} else if errors.Is(findErr, pgx.ErrNoRows) {
			return Completion{}, apperror.New(403, "oidc_identity_unknown", "This external identity is not linked")
		} else {
			return Completion{}, findErr
		}
		actor = &accountID
	} else {
		return Completion{}, invalidRequest("OIDC flow type is invalid")
	}
	updated, err := queries.MarkFlowUsed(ctx, flow.ID)
	if err != nil || updated != 1 {
		if err != nil {
			return Completion{}, err
		}
		return Completion{}, invalidRequest("OIDC callback was already used")
	}
	result := Completion{Kind: flow.Kind}
	if flow.Kind == "login" {
		session, err := s.auth.CreateOIDCSession(ctx, tx, accountID, identityID, assurance, time.Unix(claims.AuthTime, 0).UTC())
		if err != nil {
			return Completion{}, err
		}
		result.Session = &session
		if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: actor, Action: "auth.oidc_login_succeeded", ResourceType: "account", ResourceID: &accountID, RequestID: requestID, ChangedFields: []string{}}); err != nil {
			return Completion{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Completion{}, err
	}
	return result, nil
}

func (s *Service) Unlink(ctx context.Context, principal authorization.Principal, identityID uuid.UUID, requestID *uuid.UUID) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := oidcdb.New(tx)
	identity, err := queries.GetOIDCIdentityForUnlink(ctx, identityID)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	if err != nil {
		return err
	}
	if identity.AccountID == principal.AccountID {
		if !principal.Has(authorization.OIDCUnlinkSelf) {
			return apperror.PermissionDenied
		}
	} else if !principal.Has(authorization.OIDCUnlinkAll) {
		return apperror.PermissionDenied
	}
	status, err := queries.GetAccountStatusForUpdate(ctx, identity.AccountID)
	if err != nil {
		return err
	}
	usable, err := queries.CountUsableIdentities(ctx, oidcdb.CountUsableIdentitiesParams{AccountID: identity.AccountID, ExcludedIdentityID: identityID})
	if err != nil {
		return err
	}
	if status == "enabled" && usable == 0 {
		return apperror.New(409, "last_authentication_method", "An enabled account must retain an authentication method")
	}
	if err := queries.DeleteOIDCIdentity(ctx, identityID); err != nil {
		return err
	}
	if err := queries.RevokeSessionsForIdentity(ctx, identityID); err != nil {
		return err
	}
	if err := queries.BumpAccountVersion(ctx, identity.AccountID); err != nil {
		return err
	}
	actor := principal.AccountID
	if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "auth.oidc_unlinked", ResourceType: "auth_identity", ResourceID: &identityID, RequestID: requestID, ChangedFields: []string{"identity"}}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func providerFromRow(row oidcdb.OidcProvider) (Provider, error) {
	var raw map[string]string
	if err := json.Unmarshal(row.AcrAssuranceMappings, &raw); err != nil {
		return Provider{}, fmt.Errorf("decode OIDC ACR mappings: %w", err)
	}
	mappings := make(map[string]authorization.Assurance, len(raw))
	for acr, assurance := range raw {
		mappings[acr] = authorization.Assurance(assurance)
	}
	return Provider{ID: row.ID, Slug: row.Slug, DisplayName: row.DisplayName, Issuer: row.Issuer, ClientID: row.ClientID, Enabled: row.Enabled, JITEnabled: row.JitEnabled, ACRAssuranceMappings: mappings, Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}, nil
}

func validateProviderInput(input ProviderInput, requireSecret bool) (ProviderInput, []byte, error) {
	input.Slug = strings.TrimSpace(strings.ToLower(input.Slug))
	input.DisplayName = strings.TrimSpace(input.DisplayName)
	input.ClientID = strings.TrimSpace(input.ClientID)
	issuerURL, err := url.Parse(strings.TrimSpace(input.Issuer))
	if err != nil || issuerURL.Host == "" || issuerURL.User != nil || issuerURL.RawQuery != "" || issuerURL.Fragment != "" || (issuerURL.Scheme != "https" && !(issuerURL.Scheme == "http" && (issuerURL.Hostname() == "localhost" || issuerURL.Hostname() == "127.0.0.1" || issuerURL.Hostname() == "::1"))) {
		return ProviderInput{}, nil, validationError("issuer must be a canonical HTTPS URL")
	}
	issuerURL.Path = strings.TrimSuffix(issuerURL.Path, "/")
	issuerURL.RawPath = ""
	input.Issuer = issuerURL.String()
	if (requireSecret && !providerSlugPattern.MatchString(input.Slug)) || input.DisplayName == "" || len([]rune(input.DisplayName)) > 100 || input.ClientID == "" || len(input.ClientID) > 512 {
		return ProviderInput{}, nil, validationError("provider fields are invalid")
	}
	if requireSecret && (input.ClientSecret == nil || *input.ClientSecret == "") {
		return ProviderInput{}, nil, validationError("clientSecret is required")
	}
	if input.ClientSecret != nil && (*input.ClientSecret == "" || len(*input.ClientSecret) > 4096) {
		return ProviderInput{}, nil, validationError("clientSecret is invalid")
	}
	raw := make(map[string]string, len(input.ACRAssuranceMappings))
	for acr, assurance := range input.ACRAssuranceMappings {
		acr = strings.TrimSpace(acr)
		if acr == "" || len(acr) > 512 || (assurance != authorization.AssuranceNormal && assurance != authorization.AssuranceStrong && assurance != authorization.AssuranceStrongMFA) {
			return ProviderInput{}, nil, validationError("ACR assurance mapping is invalid")
		}
		raw[acr] = string(assurance)
	}
	encoded, err := json.Marshal(raw)
	return input, encoded, err
}

type tokenClaims struct {
	AuthTime      int64  `json:"auth_time"`
	Subject       string `json:"sub"`
	Nonce         string `json:"nonce"`
	Email         string `json:"email"`
	EmailVerified bool   `json:"email_verified"`
	Phone         string `json:"phone_number"`
	GivenName     string `json:"given_name"`
	FamilyName    string `json:"family_name"`
	Name          string `json:"name"`
	ACR           string `json:"acr"`
}

func jitPersonFields(claims tokenClaims) (string, string, *string, *string, error) {
	var email, phone *string
	if claims.EmailVerified && strings.TrimSpace(claims.Email) != "" {
		value := strings.TrimSpace(claims.Email)
		email = &value
	}
	if strings.TrimSpace(claims.Phone) != "" {
		value := strings.TrimSpace(claims.Phone)
		phone = &value
	}
	if email == nil && phone == nil {
		return "", "", nil, nil, apperror.New(403, "oidc_contact_required", "OIDC provisioning requires a verified email or usable phone claim")
	}
	firstName, lastName := strings.TrimSpace(claims.GivenName), strings.TrimSpace(claims.FamilyName)
	if firstName == "" || lastName == "" {
		parts := strings.Fields(claims.Name)
		if firstName == "" && len(parts) > 0 {
			firstName = parts[0]
		}
		if lastName == "" && len(parts) > 1 {
			lastName = strings.Join(parts[1:], " ")
		}
	}
	if firstName == "" {
		firstName = "OIDC"
	}
	if lastName == "" {
		lastName = "User"
	}
	if len([]rune(firstName)) > 100 || len([]rune(lastName)) > 100 {
		return "", "", nil, nil, validationError("OIDC name claims are too long")
	}
	return firstName, lastName, email, phone, nil
}

func assuranceForClaims(encoded []byte, acr string) (authorization.Assurance, error) {
	if strings.TrimSpace(acr) == "" {
		return authorization.AssuranceNormal, nil
	}
	var mappings map[string]string
	if err := json.Unmarshal(encoded, &mappings); err != nil {
		return "", err
	}
	value, ok := mappings[acr]
	if !ok {
		return authorization.AssuranceNormal, nil
	}
	assurance := authorization.Assurance(value)
	if assurance != authorization.AssuranceNormal && assurance != authorization.AssuranceStrong && assurance != authorization.AssuranceStrongMFA {
		return "", errors.New("stored OIDC ACR assurance mapping is invalid")
	}
	return assurance, nil
}

func oauthConfig(provider *coreoidc.Provider, row oidcdb.OidcProvider, clientSecret, callbackURL string) oauth2.Config {
	return oauth2.Config{ClientID: row.ClientID, ClientSecret: clientSecret, Endpoint: provider.Endpoint(), RedirectURL: callbackURL, Scopes: []string{coreoidc.ScopeOpenID, "profile", "email", "phone"}}
}

func (s *Service) callbackURL() string {
	base := *s.config.PublicBaseURL
	base.Path = "/api/v1/auth/oidc/callback"
	base.RawQuery, base.Fragment = "", ""
	return base.String()
}

func providerSecretPurpose(id uuid.UUID) string { return "oidc-provider-client-secret:" + id.String() }
func flowNoncePurpose(id uuid.UUID) string      { return "oidc-flow-nonce:" + id.String() }
func flowVerifierPurpose(id uuid.UUID) string   { return "oidc-flow-pkce:" + id.String() }

func validationError(reason string) *apperror.Error {
	err := apperror.New(422, "validation_failed", "Request validation failed")
	err.Details["reason"] = reason
	return err
}

func invalidRequest(reason string) *apperror.Error {
	err := apperror.New(400, "invalid_request", "Request is invalid")
	err.Details["reason"] = reason
	return err
}

func oidcNotConfigured() *apperror.Error {
	return apperror.New(503, "oidc_not_configured", "OIDC encryption is not configured")
}

func translateWriteError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && (pgErr.Code == "23505" || pgErr.Code == "23503") {
		return apperror.Conflict
	}
	return err
}

// PKCEChallenge is exported for deterministic protocol tests.
func PKCEChallenge(verifier string) string {
	digest := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(digest[:])
}
