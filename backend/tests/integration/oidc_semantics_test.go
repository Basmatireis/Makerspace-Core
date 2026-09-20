package integration_test

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/auth"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/httpapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/oidc"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/oauth2"
)

type oidcSemanticsFixture struct {
	t          *testing.T
	ctx        context.Context
	pool       *pgxpool.Pool
	service    *oidc.Service
	auth       *auth.Service
	principal  authorization.Principal
	session    auth.Session
	one, two   oidc.Provider
	identity   uuid.UUID
	key        *rsa.PrivateKey
	mu         sync.Mutex
	tokens     map[string]string
	challenges map[string]string
}

func newOIDCSemanticsFixture(t *testing.T, oidcOnly bool) *oidcSemanticsFixture {
	t.Helper()
	f := &oidcSemanticsFixture{t: t, pool: migratedPool(t), ctx: testContext(t), tokens: map[string]string{}, challenges: map[string]string{}}
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	f.key = key
	mux := http.NewServeMux()
	server := httptest.NewTLSServer(mux)
	t.Cleanup(server.Close)
	f.ctx = context.WithValue(f.ctx, oauth2.HTTPClient, server.Client())
	for _, name := range []string{"one", "two"} {
		issuer := server.URL + "/" + name
		mux.HandleFunc("/"+name+"/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"issuer": issuer, "authorization_endpoint": issuer + "/authorize", "token_endpoint": issuer + "/token", "jwks_uri": server.URL + "/keys", "id_token_signing_alg_values_supported": []string{"RS256"}})
		})
		mux.HandleFunc("/"+name+"/token", func(w http.ResponseWriter, r *http.Request) {
			if err := r.ParseForm(); err != nil {
				http.Error(w, "bad form", 400)
				return
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			code := r.Form.Get("code")
			id, secret, _ := r.BasicAuth()
			if id != "semantics-client" || secret != "semantics-secret" || f.tokens[code] == "" || oauth2.S256ChallengeFromVerifier(r.Form.Get("code_verifier")) != f.challenges[code] {
				http.Error(w, "invalid exchange", 400)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "local-only", "token_type": "Bearer", "id_token": f.tokens[code]})
			delete(f.tokens, code)
		})
	}
	mux.HandleFunc("/keys", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []any{map[string]any{"kty": "RSA", "kid": "semantics", "alg": "RS256", "use": "sig", "n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()), "e": "AQAB"}}})
	})
	actor := seedAccount(t, f.pool, "oidc-semantics", true)
	hash, err := security.HashPassword(bootstrapPassword)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(f.ctx, `UPDATE password_credentials SET password_hash=$1 WHERE auth_identity_id=$2`, hash, actor.identity); err != nil {
		t.Fatal(err)
	}
	cfg := integrationConfig(t)
	cfg.EncryptionKeys = [][]byte{make([]byte, 32)}
	f.auth, err = auth.NewService(f.pool, cfg)
	if err != nil {
		t.Fatal(err)
	}
	f.service, err = oidc.NewService(f.pool, cfg, f.auth)
	if err != nil {
		t.Fatal(err)
	}
	secret := "semantics-secret"
	create := func(slug string) oidc.Provider {
		provider, err := f.service.CreateProvider(f.ctx, authorization.Principal{AccountID: actor.accountID, Master: true}, oidc.ProviderInput{Slug: slug, DisplayName: slug, Issuer: server.URL + "/" + slug, ClientID: "semantics-client", ClientSecret: &secret, Enabled: true, JITEnabled: true}, nil)
		if err != nil {
			t.Fatal(err)
		}
		return provider
	}
	f.one, f.two = create("one"), create("two")
	f.identity = uuid.Must(uuid.NewV7())
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO auth_identities(id,account_id,kind,provider_id,issuer,subject,verified_at) VALUES($1,$2,'oidc',$3,$4,'owned-subject',now())`, f.identity, actor.accountID, f.one.ID, f.one.Issuer); err != nil {
		t.Fatal(err)
	}
	if oidcOnly {
		tx, err := f.pool.Begin(f.ctx)
		if err != nil {
			t.Fatal(err)
		}
		f.session, err = f.auth.CreateOIDCSession(f.ctx, tx, actor.accountID, f.identity, authorization.AssuranceNormal, time.Unix(0, 0))
		if err != nil {
			_ = tx.Rollback(f.ctx)
			t.Fatal(err)
		}
		if err := tx.Commit(f.ctx); err != nil {
			t.Fatal(err)
		}
		if _, err := f.pool.Exec(f.ctx, `DELETE FROM auth_identities WHERE id=$1`, actor.identity); err != nil {
			t.Fatal(err)
		}
	} else {
		f.session, err = f.auth.Login(f.ctx, "oidc-semantics@example.test", bootstrapPassword, "local-fixture", nil)
		if err != nil {
			t.Fatal(err)
		}
	}
	authenticated, err := f.auth.Authenticate(f.ctx, f.session.Token)
	if err != nil {
		t.Fatal(err)
	}
	f.principal = authenticated.Principal
	return f
}

func (f *oidcSemanticsFixture) prepareCallback(flow oidc.FlowStart, subject string, authenticatedAt time.Time) (string, string) {
	f.t.Helper()
	redirect, err := url.Parse(flow.AuthorizationURL)
	if err != nil {
		f.t.Fatal(err)
	}
	params := redirect.Query()
	claims := map[string]any{"iss": strings.TrimSuffix(redirect.Scheme+"://"+redirect.Host+redirect.Path, "/authorize"), "sub": subject, "aud": "semantics-client", "exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix(), "nonce": params.Get("nonce")}
	if !authenticatedAt.IsZero() {
		claims["auth_time"] = authenticatedAt.Unix()
	}
	header, _ := json.Marshal(map[string]string{"alg": "RS256", "kid": "semantics"})
	payload, _ := json.Marshal(claims)
	unsigned := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(payload)
	digest := sha256.Sum256([]byte(unsigned))
	signature, err := rsa.SignPKCS1v15(rand.Reader, f.key, crypto.SHA256, digest[:])
	if err != nil {
		f.t.Fatal(err)
	}
	code := uuid.NewString()
	f.mu.Lock()
	f.tokens[code] = unsigned + "." + base64.RawURLEncoding.EncodeToString(signature)
	f.challenges[code] = params.Get("code_challenge")
	f.mu.Unlock()
	return params.Get("state"), code
}

func (f *oidcSemanticsFixture) complete(flow oidc.FlowStart, subject string, authenticatedAt time.Time, principal authorization.Principal) (oidc.Completion, error) {
	state, code := f.prepareCallback(flow, subject, authenticatedAt)
	return f.service.Complete(f.ctx, state, code, flow.BrowserToken, principal, nil)
}

func TestOIDCLinkUsesRecentSessionAssurance(t *testing.T) {
	f := newOIDCSemanticsFixture(t, false)
	if _, err := f.pool.Exec(f.ctx, `UPDATE sessions SET authenticated_at=now()-interval '1 hour' WHERE id=$1`, f.session.ID); err != nil {
		t.Fatal(err)
	}
	_, err := f.service.StartLink(f.ctx, f.principal, "two", "")
	expectAppCode(t, err, "reauthentication_required")
	_, err = f.service.StartLink(f.ctx, f.principal, "two", "wrong-password")
	expectAppCode(t, err, "current_password_invalid")
	flow, err := f.service.StartLink(f.ctx, f.principal, "two", bootstrapPassword)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.complete(flow, "new-linked-subject", time.Now(), f.principal); err != nil {
		t.Fatal(err)
	}
	assertCount(t, f.pool, `SELECT count(*) FROM auth_identities WHERE account_id=$1 AND subject='new-linked-subject'`, 1, f.principal.AccountID)
	flow, err = f.service.StartLink(f.ctx, f.principal, "two", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(f.ctx, `UPDATE sessions SET assurance_expires_at=now()-interval '1 second' WHERE id=$1`, f.session.ID); err != nil {
		t.Fatal(err)
	}
	_, err = f.complete(flow, "must-not-link", time.Now(), f.principal)
	expectAppCode(t, err, "reauthentication_required")
	_, err = f.service.StartLink(f.ctx, f.principal, "two", "")
	expectAppCode(t, err, "reauthentication_required")
	assertCount(t, f.pool, `SELECT count(*) FROM auth_identities WHERE subject='must-not-link'`, 0)
	if _, err := f.pool.Exec(f.ctx, `UPDATE sessions SET current_assurance='low',base_assurance='low',authenticated_at=now(),assurance_expires_at=NULL WHERE id=$1`, f.session.ID); err != nil {
		t.Fatal(err)
	}
	_, err = f.service.StartLink(f.ctx, f.principal, "two", "")
	expectAppCode(t, err, "reauthentication_required")
}

func TestOIDCOnlyAccountReauthenticatesThroughItsLinkedIdentity(t *testing.T) {
	f := newOIDCSemanticsFixture(t, true)
	_, err := f.service.StartReauthentication(f.ctx, f.principal, "two")
	expectAppCode(t, err, "permission_denied")
	for _, scenario := range []string{"missing_auth_time", "stale_auth_time", "wrong_subject", "other_session", "valid"} {
		t.Run(scenario, func(t *testing.T) {
			flow, err := f.service.StartReauthentication(f.ctx, f.principal, "one")
			if err != nil {
				t.Fatal(err)
			}
			redirect, _ := url.Parse(flow.AuthorizationURL)
			if redirect.Query().Get("max_age") != "0" || redirect.Query().Get("prompt") != "login" {
				t.Fatal("provider reauthentication was not requested")
			}
			subject, when, principal := "owned-subject", time.Now(), f.principal
			switch scenario {
			case "missing_auth_time":
				when = time.Time{}
			case "stale_auth_time":
				when = time.Now().Add(-time.Hour)
			case "wrong_subject":
				subject = "unowned-subject"
			case "other_session":
				principal.SessionID = uuid.New()
			}
			_, err = f.complete(flow, subject, when, principal)
			if scenario != "valid" {
				if err == nil {
					t.Fatal("unproven reauthentication accepted")
				}
				assertCount(t, f.pool, `SELECT count(*) FROM audit_events WHERE action='auth.reauthenticated'`, 0)
				return
			}
			if err != nil {
				t.Fatal(err)
			}
		})
	}
	flow, err := f.service.StartLink(f.ctx, f.principal, "two", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.complete(flow, "second-provider-subject", time.Now(), f.principal); err != nil {
		t.Fatal(err)
	}
	assertCount(t, f.pool, `SELECT count(*) FROM auth_identities WHERE account_id=$1 AND kind='oidc'`, 2, f.principal.AccountID)
	assertCount(t, f.pool, `SELECT count(*) FROM auth_identities WHERE kind='password'`, 0)
	assertCount(t, f.pool, `SELECT count(*) FROM accounts`, 1)
}

func TestDisabledOIDCProviderKeepsSessionsButCannotAuthenticateOrRecover(t *testing.T) {
	f := newOIDCSemanticsFixture(t, true)
	pending, err := f.service.StartLogin(f.ctx, "one")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(f.ctx, `UPDATE oidc_providers SET enabled=false WHERE id=$1`, f.one.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.auth.Authenticate(f.ctx, f.session.Token); err != nil {
		t.Fatalf("provider disablement revoked existing session: %v", err)
	}
	if _, err := f.service.StartLogin(f.ctx, "one"); err == nil {
		t.Fatal("disabled provider started login")
	}
	if _, err := f.service.StartReauthentication(f.ctx, f.principal, "one"); err == nil {
		t.Fatal("disabled provider started reauthentication")
	}
	if _, err := f.complete(pending, "owned-subject", time.Now(), authorization.Principal{}); err == nil {
		t.Fatal("in-flight login ignored disabled provider")
	}

	passwordFixture := newOIDCSemanticsFixture(t, false)
	if _, err := passwordFixture.pool.Exec(passwordFixture.ctx, `UPDATE oidc_providers SET enabled=false WHERE id=$1`, passwordFixture.one.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := passwordFixture.service.StartLink(passwordFixture.ctx, passwordFixture.principal, "one", ""); err == nil {
		t.Fatal("disabled provider started linking")
	}
	err = passwordFixture.auth.RemovePassword(passwordFixture.ctx, passwordFixture.principal, bootstrapPassword, nil)
	expectAppCode(t, err, "last_authentication_method")
	// Removing an unavailable identity is safe when a usable password remains.
	if err := passwordFixture.service.Unlink(passwordFixture.ctx, passwordFixture.principal, passwordFixture.identity, nil); err != nil {
		t.Fatal(err)
	}
}

func TestOIDCLinkAllDoesNotProvideAnAdministrativeSubjectAssignment(t *testing.T) {
	f := newOIDCSemanticsFixture(t, false)
	role := uuid.Must(uuid.NewV7())
	if _, err := f.pool.Exec(f.ctx, `DELETE FROM account_roles WHERE account_id=$1`, f.principal.AccountID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(f.ctx, `INSERT INTO roles(id,name) VALUES($1,'Reserved linker'); INSERT INTO role_permission_grants(id,role_id,permission_id,scope) VALUES(uuidv7(),$1,'identities.oidc.link.all','global'); INSERT INTO account_roles(account_id,role_id) VALUES($2,$1)`, role, f.principal.AccountID); err != nil {
		t.Fatal(err)
	}
	_, err := f.service.StartLink(f.ctx, f.principal, "two", "")
	expectAppCode(t, err, "permission_denied")
	target := seedAccount(t, f.pool, "other-account", false)
	forged := f.principal
	forged.AccountID = target.accountID
	_, err = f.service.StartLink(f.ctx, forged, "two", bootstrapPassword)
	expectAppCode(t, err, "unauthenticated")
	assertCount(t, f.pool, `SELECT count(*) FROM auth_identities WHERE account_id=$1 AND kind='oidc'`, 0, target.accountID)
}

func TestDisabledOIDCDoesNotCountWhenUnlinkingAnotherProvider(t *testing.T) {
	for _, disabled := range []string{"provider", "identity"} {
		t.Run(disabled, func(t *testing.T) {
			f := newOIDCSemanticsFixture(t, true)
			other := uuid.Must(uuid.NewV7())
			if _, err := f.pool.Exec(f.ctx, `INSERT INTO auth_identities(id,account_id,kind,provider_id,issuer,subject) VALUES($1,$2,'oidc',$3,$4,'other-subject')`, other, f.principal.AccountID, f.two.ID, f.two.Issuer); err != nil {
				t.Fatal(err)
			}
			disable := `UPDATE oidc_providers SET enabled=false WHERE id=$1`
			enable := `UPDATE oidc_providers SET enabled=true WHERE id=$1`
			if disabled == "identity" {
				disable = `UPDATE auth_identities SET disabled_at=now() WHERE provider_id=$1`
				enable = `UPDATE auth_identities SET disabled_at=NULL WHERE provider_id=$1`
			}
			if _, err := f.pool.Exec(f.ctx, disable, f.one.ID); err != nil {
				t.Fatal(err)
			}
			err := f.service.Unlink(f.ctx, f.principal, other, nil)
			expectAppCode(t, err, "last_authentication_method")
			assertCount(t, f.pool, `SELECT count(*) FROM auth_identities WHERE id=$1`, 1, other)
			if _, err := f.pool.Exec(f.ctx, enable, f.one.ID); err != nil {
				t.Fatal(err)
			}
			if err := f.service.Unlink(f.ctx, f.principal, other, nil); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestOIDCReauthenticationAndLinkHTTPRequireBoundSessionAndCSRF(t *testing.T) {
	f := newOIDCSemanticsFixture(t, true)
	cfg := integrationConfig(t)
	cfg.EncryptionKeys = [][]byte{make([]byte, 32)}
	cfg.SessionCookieName = "semantics_session"
	cfg.CSRFCookieName = "semantics_csrf"
	cfg.OIDCFlowCookieName = "semantics_oidc"
	handler, err := httpapi.NewHandler(f.pool, cfg, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	post := func(path, body string, csrf bool) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body)).WithContext(f.ctx)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Origin", cfg.PublicBaseURL.String())
		request.AddCookie(&http.Cookie{Name: cfg.SessionCookieName, Value: f.session.Token})
		request.AddCookie(&http.Cookie{Name: cfg.CSRFCookieName, Value: f.session.CSRFToken})
		if csrf {
			request.Header.Set("X-CSRF-Token", f.session.CSRFToken)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	path := "/api/v1/auth/oidc/one/reauthenticate"
	if response := post(path, "", false); response.Code != 403 {
		t.Fatalf("reauthentication skipped CSRF: %d %s", response.Code, response.Body)
	}
	response := post(path, "", true)
	if response.Code != 200 {
		t.Fatalf("start HTTP reauthentication: %d %s", response.Code, response.Body)
	}
	callback := func(response *httptest.ResponseRecorder, subject string) {
		var body struct {
			AuthorizationURL string `json:"authorizationUrl"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		var browser string
		for _, cookie := range response.Result().Cookies() {
			if cookie.Name == cfg.OIDCFlowCookieName {
				browser = cookie.Value
			}
		}
		if browser == "" {
			t.Fatal("OIDC flow cookie missing")
		}
		flow := oidc.FlowStart{AuthorizationURL: body.AuthorizationURL, BrowserToken: browser}
		state, code := f.prepareCallback(flow, subject, time.Now())
		request := httptest.NewRequest(http.MethodGet, "/api/v1/auth/oidc/callback?state="+url.QueryEscape(state)+"&code="+url.QueryEscape(code), nil).WithContext(f.ctx)
		request.AddCookie(&http.Cookie{Name: cfg.SessionCookieName, Value: f.session.Token})
		request.AddCookie(&http.Cookie{Name: cfg.OIDCFlowCookieName, Value: browser})
		completed := httptest.NewRecorder()
		handler.ServeHTTP(completed, request)
		if completed.Code != 302 {
			t.Fatalf("HTTP callback: %d %s", completed.Code, completed.Body)
		}
	}
	callback(response, "owned-subject")
	response = post("/api/v1/auth/oidc/two/link", "{}", true)
	if response.Code != 200 {
		t.Fatalf("link with recent OIDC proof: %d %s", response.Code, response.Body)
	}
	callback(response, "linked-via-http")
	response = post("/api/v1/auth/oidc/two/link", `{"accountId":"`+uuid.NewString()+`","subject":"arbitrary"}`, true)
	if response.Code != 400 {
		t.Fatalf("arbitrary subject request accepted: %d", response.Code)
	}
	assertCount(t, f.pool, `SELECT count(*) FROM auth_identities WHERE account_id=$1 AND subject='linked-via-http'`, 1, f.principal.AccountID)
}
