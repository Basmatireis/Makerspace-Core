package integration_test

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/auth"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/oidc"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
	"golang.org/x/oauth2"
)

func TestOIDCLocalProviderValidatesCallbackAndProvisionsWithoutRoles(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	operator := seedAccount(t, pool, "oidc-review", true)
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	var providerURL string
	var mu sync.Mutex
	var token, challenge string
	var exchanges int
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"issuer": providerURL, "authorization_endpoint": providerURL + "/authorize", "token_endpoint": providerURL + "/token", "jwks_uri": providerURL + "/keys", "id_token_signing_alg_values_supported": []string{"RS256"}})
	})
	mux.HandleFunc("/keys", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []any{map[string]any{"kty": "RSA", "kid": "review", "alg": "RS256", "use": "sig", "n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()), "e": "AQAB"}}})
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		exchanges++
		if err := r.ParseForm(); err != nil {
			http.Error(w, "invalid form", 400)
			return
		}
		clientID, clientSecret, _ := r.BasicAuth()
		if clientID != "review-client" || clientSecret != "review-secret" || oauth2.S256ChallengeFromVerifier(r.Form.Get("code_verifier")) != challenge {
			http.Error(w, "invalid client or PKCE", 400)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "local-only", "token_type": "Bearer", "id_token": token})
	})
	server := httptest.NewTLSServer(mux)
	defer server.Close()
	providerURL = server.URL
	ctx = context.WithValue(ctx, oauth2.HTTPClient, server.Client())
	cfg := integrationConfig(t)
	cfg.EncryptionKeys = [][]byte{make([]byte, 32)}
	cfg.PublicBaseURL, _ = url.Parse("https://makerspace.example.test")
	authService, err := auth.NewService(pool, cfg)
	if err != nil {
		t.Fatal(err)
	}
	service, err := oidc.NewService(pool, cfg, authService)
	if err != nil {
		t.Fatal(err)
	}
	secret := "review-secret"
	_, err = service.CreateProvider(ctx, authorization.Principal{AccountID: operator.accountID, Master: true}, oidc.ProviderInput{
		Slug: "review-provider", DisplayName: "Local review provider", Issuer: providerURL, ClientID: "review-client", ClientSecret: &secret, Enabled: true, JITEnabled: true,
		ACRAssuranceMappings: map[string]authorization.Assurance{"trusted-mfa": authorization.AssuranceStrongMFA},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []string{"wrong_browser", "wrong_state", "expired_flow", "wrong_nonce", "wrong_issuer", "expired_token", "valid"} {
		t.Run(scenario, func(t *testing.T) {
			flow, err := service.StartLogin(ctx, "review-provider")
			if err != nil {
				t.Fatal(err)
			}
			redirect, err := url.Parse(flow.AuthorizationURL)
			if err != nil {
				t.Fatal(err)
			}
			params := redirect.Query()
			if params.Get("code_challenge_method") != "S256" || params.Get("nonce") == "" {
				t.Fatal("missing nonce or S256 challenge")
			}
			claims := map[string]any{"iss": providerURL, "sub": "local-subject", "aud": "review-client", "exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix(), "nonce": params.Get("nonce"), "acr": "trusted-mfa", "email": "oidc-review@example.test", "email_verified": true, "given_name": "OIDC", "family_name": "Visitor"}
			state, browser := params.Get("state"), flow.BrowserToken
			switch scenario {
			case "wrong_browser":
				browser = "wrong-browser"
			case "wrong_state":
				state = "wrong-state"
			case "expired_flow":
				if _, err := pool.Exec(ctx, `UPDATE oidc_flows SET created_at=now()-interval '11 minutes',expires_at=now()-interval '1 minute' WHERE state_digest=$1`, security.DigestToken(state)); err != nil {
					t.Fatal(err)
				}
			case "wrong_nonce":
				claims["nonce"] = "wrong-nonce"
			case "wrong_issuer":
				claims["iss"] = "https://other.example.test"
			case "expired_token":
				claims["exp"] = time.Now().Add(-time.Hour).Unix()
			}
			encodedHeader, _ := json.Marshal(map[string]string{"alg": "RS256", "kid": "review", "typ": "JWT"})
			encodedClaims, err := json.Marshal(claims)
			if err != nil {
				t.Fatal(err)
			}
			unsigned := base64.RawURLEncoding.EncodeToString(encodedHeader) + "." + base64.RawURLEncoding.EncodeToString(encodedClaims)
			digest := sha256.Sum256([]byte(unsigned))
			signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
			if err != nil {
				t.Fatal(err)
			}
			mu.Lock()
			token, challenge = unsigned+"."+base64.RawURLEncoding.EncodeToString(signature), params.Get("code_challenge")
			before := exchanges
			mu.Unlock()
			completion, err := service.Complete(ctx, state, "local-code", browser, nil)
			if scenario != "valid" {
				if err == nil {
					t.Fatalf("%s callback accepted", scenario)
				}
				assertCount(t, pool, `SELECT count(*) FROM accounts WHERE provisioning_source='oidc_jit'`, 0)
				if scenario == "wrong_browser" || scenario == "wrong_state" || scenario == "expired_flow" {
					mu.Lock()
					after := exchanges
					mu.Unlock()
					if before != after {
						t.Fatal("invalid flow reached token endpoint")
					}
				}
				return
			}
			if err != nil || completion.Session == nil {
				t.Fatalf("valid callback failed: %v", err)
			}
			var accountID uuid.UUID
			var assurance string
			if err := pool.QueryRow(ctx, `SELECT account_id,current_assurance FROM sessions WHERE id=$1`, completion.Session.ID).Scan(&accountID, &assurance); err != nil {
				t.Fatal(err)
			}
			if accountID == operator.accountID || assurance != "strong_mfa" {
				t.Fatal("email merged an existing account or trusted assurance was lost")
			}
			assertCount(t, pool, `SELECT count(*) FROM account_roles WHERE account_id=$1`, 0, accountID)
			if _, err := service.Complete(ctx, state, "local-code", browser, nil); err == nil {
				t.Fatal("OIDC callback replay accepted")
			}
		})
	}
}
