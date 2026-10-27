package integration_test

import (
	"encoding/base32"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/accounts"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/admin"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/httpapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/roles"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

const mfaOrigin = "http://makerspace.example.test"

type mfaHarness struct {
	t      *testing.T
	pool   *pgxpool.Pool
	server *httptest.Server
	cfg    config.Config
}

func newMFAHarness(t *testing.T, pool *pgxpool.Pool) *mfaHarness {
	t.Helper()
	disableMasterElevation(t)
	baseURL, err := url.Parse(mfaOrigin)
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{
		PublicBaseURL: baseURL, SessionCookieName: "makerspace_session", CSRFCookieName: "makerspace_csrf",
		SessionIdleTTL: 6 * time.Hour, SessionAbsoluteTTL: 72 * time.Hour, PasswordResetTTL: 30 * time.Minute,
		EncryptionKeys:   [][]byte{[]byte("integration-encryption-key-32byt")},
		ChallengeHMACKey: []byte("integration-challenge-hmac-key-32"),
	}
	handler, err := httpapi.NewHandler(pool, cfg, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return &mfaHarness{t: t, pool: pool, server: server, cfg: cfg}
}

func (h *mfaHarness) do(client *http.Client, method, path string, body any) *http.Response {
	h.t.Helper()
	csrf := ""
	if hasCookie(client, h.server.URL, h.cfg.CSRFCookieName) {
		csrf = cookieValue(h.t, client, h.server.URL, h.cfg.CSRFCookieName)
	}
	return doJSON(h.t, client, method, h.server.URL+"/api/v1"+path, mfaOrigin, csrf, body)
}

func (h *mfaHarness) expectError(response *http.Response, status int, code string) openapi.Error {
	h.t.Helper()
	assertStatus(h.t, response, status)
	var failure openapi.Error
	decodeResponse(h.t, response, &failure)
	if failure.Code != code {
		h.t.Fatalf("error code = %q, want %q (%+v)", failure.Code, code, failure)
	}
	return failure
}

// clearThrottles lifts the per-account back-off after a deliberately wrong code.
func (h *mfaHarness) clearThrottles() {
	h.t.Helper()
	if _, err := h.pool.Exec(testContext(h.t), `DELETE FROM second_factor_throttles`); err != nil {
		h.t.Fatal(err)
	}
}

func (h *mfaHarness) me(client *http.Client) openapi.CurrentUser {
	h.t.Helper()
	response := h.do(client, http.MethodGet, "/auth/me", nil)
	assertStatus(h.t, response, http.StatusOK)
	var current openapi.CurrentUser
	decodeResponse(h.t, response, &current)
	return current
}

func bootstrapMFAMaster(t *testing.T, pool *pgxpool.Pool, email, password string) uuid.UUID {
	t.Helper()
	ctx := testContext(t)
	if _, err := admin.NewService(pool).BootstrapMaster(ctx, admin.BootstrapInput{
		FirstName: "Second", LastName: "Factor", LoginEmail: email, Password: password,
	}); err != nil {
		t.Fatal(err)
	}
	var accountID uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT account_id FROM auth_identities WHERE identifier_normalized=$1`, email).
		Scan(&accountID); err != nil {
		t.Fatal(err)
	}
	return accountID
}

func totpCode(t *testing.T, secret string, offset int64) string {
	t.Helper()
	raw, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(secret)
	if err != nil {
		t.Fatal(err)
	}
	return security.HOTP(raw, uint64(security.TOTPStep(time.Now())+offset), security.TOTPDigits)
}

func TestMasterSecondFactorSetupLoginAndStepUp(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	h := newMFAHarness(t, pool)
	const email, password = "mfa-master@example.test", "Second factor workshop password 71"
	accountID := bootstrapMFAMaster(t, pool, email, password)
	// Another role of the master grants audit.read: without a second factor that is all the account may use.
	roleID := ids.New()
	if _, err := pool.Exec(ctx, `INSERT INTO roles(id,name) VALUES($1,'Auditor')`, roleID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO role_permission_grants(id,role_id,permission_id) VALUES(uuidv7(),$1,'audit.read');
		INSERT INTO person_roles(person_id,role_id) SELECT person_id,$1 FROM accounts WHERE id=$2`, roleID, accountID); err != nil {
		t.Fatal(err)
	}

	client := newCookieClient(t)
	response := h.do(client, http.MethodPost, "/auth/login", map[string]any{"email": email, "password": password})
	assertStatus(t, response, http.StatusNoContent)
	response.Body.Close()
	current := h.me(client)
	if !current.Authentication.MfaSetupRequired || !current.Authentication.MfaRequired ||
		current.Authentication.MfaEnrolled || current.AuthenticationAssurance != openapi.AuthenticationAssuranceNormal {
		t.Fatalf("authentication before setup = %+v", current.Authentication)
	}
	if len(current.Permissions) != 1 || current.Permissions[0] != openapi.AuditRead {
		t.Fatalf("master without a second factor has %v", current.Permissions)
	}
	h.expectError(h.do(client, http.MethodGet, "/roles", nil), http.StatusForbidden, "mfa_setup_required")

	response = h.do(client, http.MethodPost, "/auth/second-factors/totp/enrollment", nil)
	assertStatus(t, response, http.StatusOK)
	var enrollment openapi.TotpEnrollment
	decodeResponse(t, response, &enrollment)
	if !strings.HasPrefix(enrollment.OtpauthUri, "otpauth://totp/") {
		t.Fatalf("enrollment = %+v", enrollment)
	}
	h.expectError(h.do(client, http.MethodPost, "/auth/second-factors/totp/enrollment/confirm",
		map[string]any{"code": totpCode(t, enrollment.Secret, 5)}), http.StatusUnprocessableEntity, "second_factor_invalid")
	h.clearThrottles()
	response = h.do(client, http.MethodPost, "/auth/second-factors/totp/enrollment/confirm",
		map[string]any{"code": totpCode(t, enrollment.Secret, 0)})
	assertStatus(t, response, http.StatusOK)
	var enrolled openapi.SecondFactorEnrollmentResult
	decodeResponse(t, response, &enrolled)
	recoveryCodes, err := enrolled.RecoveryCodes.Get()
	if err != nil || len(recoveryCodes) != security.RecoveryCodeCount || !enrolled.SecondFactors.Enrolled {
		t.Fatalf("enrollment result = %+v", enrolled)
	}
	assertCount(t, pool, `SELECT count(*) FROM mfa_recovery_codes WHERE account_id=$1 AND octet_length(code_digest)=32`, 10, accountID)
	current = h.me(client)
	if current.Authentication.MfaSetupRequired || current.AuthenticationAssurance != openapi.AuthenticationAssuranceStrongMfa ||
		len(current.Permissions) != len(authorization.Registry()) {
		t.Fatalf("after enrollment: %+v, %d permissions", current.Authentication, len(current.Permissions))
	}

	// An old sign-in withholds the master policy's permissions until a fresh multi-factor proof.
	if _, err := pool.Exec(ctx, `UPDATE sessions SET authenticated_at = now() - interval '20 minutes' WHERE account_id=$1`,
		accountID); err != nil {
		t.Fatal(err)
	}
	response = h.do(client, http.MethodGet, "/roles", nil)
	assertStatus(t, response, http.StatusOK)
	response.Body.Close()
	failure := h.expectError(h.do(client, http.MethodPost, "/roles", map[string]any{"name": "Step-up role", "permissionGrants": []any{}}),
		http.StatusForbidden, "reauthentication_required")
	if failure.Details == nil || (*failure.Details)["requiredAssurance"] != "strong_mfa" ||
		(*failure.Details)["withinMinutes"] != float64(10) {
		t.Fatalf("reauthentication details = %+v", failure.Details)
	}
	pending := h.me(client).Authentication.ReauthenticationRequired
	if len(pending) == 0 {
		t.Fatal("/auth/me does not list the withheld permissions")
	}
	h.expectError(h.do(client, http.MethodPost, "/auth/reauthenticate", map[string]any{"password": password}),
		http.StatusUnprocessableEntity, "second_factor_required")
	h.expectError(h.do(client, http.MethodPost, "/auth/reauthenticate",
		map[string]any{"password": "Wrong workshop password 00", "recoveryCode": recoveryCodes[0]}),
		http.StatusUnprocessableEntity, "current_password_invalid")
	response = h.do(client, http.MethodPost, "/auth/reauthenticate",
		map[string]any{"password": password, "recoveryCode": recoveryCodes[0]})
	assertStatus(t, response, http.StatusOK)
	var stepped openapi.CurrentAuthentication
	decodeResponse(t, response, &stepped)
	if stepped.AuthenticatedAssurance != openapi.AuthenticationAssuranceStrongMfa || len(stepped.ReauthenticationRequired) != 0 {
		t.Fatalf("after reauthentication = %+v", stepped)
	}
	response = h.do(client, http.MethodPost, "/roles", map[string]any{"name": "Step-up role", "permissionGrants": []any{}})
	assertStatus(t, response, http.StatusCreated)
	response.Body.Close()
	// The recovery code was spent.
	h.expectError(h.do(client, http.MethodPost, "/auth/reauthenticate",
		map[string]any{"password": password, "recoveryCode": recoveryCodes[0]}),
		http.StatusUnprocessableEntity, "second_factor_invalid")
	h.clearThrottles()

	// A password login of an account with a second factor waits for it.
	second := newCookieClient(t)
	response = h.do(second, http.MethodPost, "/auth/login", map[string]any{"email": email, "password": password})
	assertStatus(t, response, http.StatusAccepted)
	var required openapi.SecondFactorRequired
	decodeResponse(t, response, &required)
	if required.Status != "second_factor_required" || len(required.Methods) != 2 ||
		hasCookie(second, h.server.URL, h.cfg.SessionCookieName) {
		t.Fatalf("pending login = %+v", required)
	}
	h.expectError(h.do(second, http.MethodGet, "/auth/me", nil), http.StatusUnauthorized, "unauthenticated")
	pendingCookie := cookieValue(t, second, h.server.URL, "makerspace_mfa_pending")
	h.expectError(h.do(second, http.MethodPost, "/auth/login/second-factor",
		map[string]any{"method": "totp", "code": totpCode(t, enrollment.Secret, 5)}),
		http.StatusUnprocessableEntity, "second_factor_invalid")
	// The code of the step used for enrollment is never accepted again; the next step is.
	h.clearThrottles()
	response = h.do(second, http.MethodPost, "/auth/login/second-factor",
		map[string]any{"method": "totp", "code": totpCode(t, enrollment.Secret, 1)})
	assertStatus(t, response, http.StatusNoContent)
	response.Body.Close()
	if h.me(second).AuthenticationAssurance != openapi.AuthenticationAssuranceStrongMfa {
		t.Fatal("second-factor login is not strong_mfa")
	}
	// The pending login is single-use.
	replay := newCookieClient(t)
	serverURL, _ := url.Parse(h.server.URL)
	replay.Jar.SetCookies(serverURL, []*http.Cookie{{Name: "makerspace_mfa_pending", Value: pendingCookie, Path: "/"}})
	h.expectError(h.do(replay, http.MethodPost, "/auth/login/second-factor",
		map[string]any{"method": "recovery_code", "code": recoveryCodes[1]}),
		http.StatusUnauthorized, "second_factor_pending_invalid")

	// An expired pending login cannot be completed.
	third := newCookieClient(t)
	response = h.do(third, http.MethodPost, "/auth/login", map[string]any{"email": email, "password": password})
	assertStatus(t, response, http.StatusAccepted)
	response.Body.Close()
	if _, err := pool.Exec(ctx, `UPDATE pending_logins SET expires_at = now() - interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	h.expectError(h.do(third, http.MethodPost, "/auth/login/second-factor",
		map[string]any{"method": "recovery_code", "code": recoveryCodes[1]}),
		http.StatusUnauthorized, "second_factor_pending_invalid")

	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action='account.totp_enrolled' AND resource_id=$1`, 1, accountID)
	var failures int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE action='auth.second_factor_failed'`).
		Scan(&failures); err != nil || failures < 3 {
		t.Fatalf("second-factor failures audited = %d, %v", failures, err)
	}
	var leaked int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE metadata::text LIKE '%'||$1||'%'`,
		enrollment.Secret).Scan(&leaked); err != nil || leaked != 0 {
		t.Fatalf("secret appears in audit metadata: %d %v", leaked, err)
	}
}

func TestPasskeyRegistrationUsernamelessLoginAndSecondFactor(t *testing.T) {
	pool := migratedPool(t)
	h := newMFAHarness(t, pool)
	const email, password = "passkey-master@example.test", "Passkey workshop password 83"
	bootstrapMFAMaster(t, pool, email, password)
	client := newCookieClient(t)
	response := h.do(client, http.MethodPost, "/auth/login", map[string]any{"email": email, "password": password})
	assertStatus(t, response, http.StatusNoContent)
	response.Body.Close()

	authenticator := newVirtualAuthenticator(t, mfaOrigin)
	response = h.do(client, http.MethodPost, "/auth/second-factors/passkeys/registration-options", nil)
	assertStatus(t, response, http.StatusOK)
	var creation map[string]any
	decodeResponse(t, response, &creation)
	response = h.do(client, http.MethodPost, "/auth/second-factors/passkeys",
		map[string]any{"name": "Laptop", "credential": authenticator.register(creation)})
	assertStatus(t, response, http.StatusCreated)
	var registered openapi.SecondFactorEnrollmentResult
	decodeResponse(t, response, &registered)
	if codes, err := registered.RecoveryCodes.Get(); err != nil || len(codes) != 10 ||
		len(registered.SecondFactors.Passkeys) != 1 || registered.SecondFactors.Passkeys[0].Name != "Laptop" {
		t.Fatalf("registration = %+v", registered)
	}
	if h.me(client).Authentication.MfaSetupRequired {
		t.Fatal("passkey registration did not end the forced setup")
	}

	// Usernameless login.
	passkeyClient := newCookieClient(t)
	response = h.do(passkeyClient, http.MethodPost, "/auth/passkey/options", nil)
	assertStatus(t, response, http.StatusOK)
	var request map[string]any
	decodeResponse(t, response, &request)
	assertion := authenticator.assert(request)
	response = h.do(passkeyClient, http.MethodPost, "/auth/passkey/login", map[string]any{"credential": assertion})
	assertStatus(t, response, http.StatusNoContent)
	response.Body.Close()
	current := h.me(passkeyClient)
	if current.Authentication.Method != "passkey" || current.AuthenticationAssurance != openapi.AuthenticationAssuranceStrongMfa ||
		len(current.Permissions) != len(authorization.Registry()) {
		t.Fatalf("passkey session = %+v", current.Authentication)
	}
	// The challenge is single-use.
	h.expectError(h.do(newCookieClient(t), http.MethodPost, "/auth/passkey/login", map[string]any{"credential": assertion}),
		http.StatusUnauthorized, "invalid_credentials")

	// A passkey completes a password login as second factor.
	second := newCookieClient(t)
	response = h.do(second, http.MethodPost, "/auth/login", map[string]any{"email": email, "password": password})
	assertStatus(t, response, http.StatusAccepted)
	response.Body.Close()
	response = h.do(second, http.MethodPost, "/auth/login/second-factor/passkey/options", nil)
	assertStatus(t, response, http.StatusOK)
	decodeResponse(t, response, &request)
	response = h.do(second, http.MethodPost, "/auth/login/second-factor/passkey",
		map[string]any{"credential": authenticator.assert(request)})
	assertStatus(t, response, http.StatusNoContent)
	response.Body.Close()

	// Passkey reauthentication refreshes the current session.
	response = h.do(second, http.MethodPost, "/auth/reauthenticate/passkey/options", nil)
	assertStatus(t, response, http.StatusOK)
	decodeResponse(t, response, &request)
	response = h.do(second, http.MethodPost, "/auth/reauthenticate/passkey",
		map[string]any{"credential": authenticator.assert(request)})
	assertStatus(t, response, http.StatusOK)
	response.Body.Close()

	// A signature counter that goes backwards is treated as a cloned authenticator.
	authenticator.signCount = 0
	response = h.do(passkeyClient, http.MethodPost, "/auth/passkey/options", nil)
	assertStatus(t, response, http.StatusOK)
	decodeResponse(t, response, &request)
	h.expectError(h.do(newCookieClient(t), http.MethodPost, "/auth/passkey/login",
		map[string]any{"credential": authenticator.assert(request)}), http.StatusUnauthorized, "passkey_clone_suspected")

	// Removing the passkey needs a fresh multi-factor sign-in and ends the sessions signed in with it.
	passkeyID := registered.SecondFactors.Passkeys[0].Id
	response = h.do(second, http.MethodDelete, "/auth/second-factors/passkeys/"+passkeyID.String(), nil)
	assertStatus(t, response, http.StatusNoContent)
	response.Body.Close()
	h.expectError(h.do(passkeyClient, http.MethodGet, "/auth/me", nil), http.StatusUnauthorized, "unauthenticated")
}

func TestSecondFactorResetAuthorization(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	service := accounts.NewService(pool, config.Config{}, nil)
	none, _ := principalWithPermissions(t, pool, "mfa-reset-none")
	resetter, _ := principalWithPermissions(t, pool, "mfa-reset-admin", "accounts.mfa.reset")
	target := seedAccount(t, pool, "mfa-reset-target", false)
	masterTarget := seedAccount(t, pool, "mfa-reset-master", true)
	for _, account := range []seededAccount{target, masterTarget} {
		if _, err := pool.Exec(ctx, `INSERT INTO mfa_totp_credentials(id,account_id,secret_ciphertext,confirmed_at)
			VALUES(uuidv7(),$1,'\x01',now()); INSERT INTO mfa_recovery_codes(id,account_id,code_digest)
			VALUES(uuidv7(),$1,sha256('code'::bytea))`, account.accountID); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := service.ResetSecondFactors(ctx, none, target.accountID, 1, nil); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("reset without permission = %v", err)
	}
	if _, err := service.ResetSecondFactors(ctx, resetter, masterTarget.accountID, 1, nil); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("non-master resetting a master = %v", err)
	}
	account, err := service.ResetSecondFactors(ctx, resetter, target.accountID, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	if account.SecondFactors == nil || account.SecondFactors.Enrolled() || account.Version != 2 {
		t.Fatalf("after reset = %+v", account)
	}
	assertCount(t, pool, `SELECT count(*) FROM mfa_totp_credentials WHERE account_id=$1`, 0, target.accountID)
	assertCount(t, pool, `SELECT count(*) FROM mfa_recovery_codes WHERE account_id=$1`, 0, target.accountID)
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action='account.second_factors_reset' AND resource_id=$1`, 1, target.accountID)
	master, _ := principalWithPermissions(t, pool, "mfa-reset-master-actor")
	master.Master = true
	if _, err := service.ResetSecondFactors(ctx, master, masterTarget.accountID, 1, nil); err != nil {
		t.Fatal(err)
	}
}

func TestDelegationKeepsFreshSignInRequirement(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	_, seeded := principalWithPermissions(t, pool, "reauth-delegation", "roles.manage", "open_days.manage")
	if _, err := pool.Exec(ctx, `UPDATE role_permission_grants SET reauth_within_minutes=10, minimum_assurance='normal'
		WHERE permission_id='open_days.manage'`); err != nil {
		t.Fatal(err)
	}
	actor, err := authorization.LoadPermissionsFrom(ctx, pool, authorization.Principal{
		AccountID: seeded.accountID, PersonID: seeded.personID, Assurance: authorization.AssuranceNormal,
		AuthenticatedAt: time.Now(),
	})
	if err != nil {
		t.Fatal(err)
	}
	service := roles.NewService(pool)
	grant := func(window *int) []authorization.PermissionGrant {
		return []authorization.PermissionGrant{{
			PermissionID: authorization.OpenDaysManage, Scope: authorization.GrantEverywhere,
			MinimumAssurance: authorization.AssuranceNormal, ReauthWithinMinutes: window,
		}}
	}
	if _, err := service.Create(ctx, actor, "Looser", nil, grant(nil), nil); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("delegating without the fresh sign-in requirement = %v", err)
	}
	thirty, five := 30, 5
	if _, err := service.Create(ctx, actor, "Longer", nil, grant(&thirty), nil); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("delegating a longer window = %v", err)
	}
	created, err := service.Create(ctx, actor, "Stricter", nil, grant(&five), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(created.PermissionGrants) != 1 || created.PermissionGrants[0].ReauthWithinMinutes == nil ||
		*created.PermissionGrants[0].ReauthWithinMinutes != 5 {
		t.Fatalf("stored grant = %+v", created.PermissionGrants)
	}
	// A stale session cannot use the restricted grant and records why.
	stale, err := authorization.LoadPermissionsFrom(ctx, pool, authorization.Principal{
		AccountID: seeded.accountID, PersonID: seeded.personID, Assurance: authorization.AssuranceNormal,
		AuthenticatedAt: time.Now().Add(-time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	if stale.Has(authorization.OpenDaysManage) || !stale.Has(authorization.RolesManage) {
		t.Fatal("fresh sign-in requirement not enforced")
	}
	if requirement, denied := stale.ReauthenticationDenial(); !denied || requirement.WithinMinutes != 10 {
		t.Fatalf("denial = %v %+v", denied, requirement)
	}
}
