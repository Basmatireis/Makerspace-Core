package integration_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/pairingcode"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
)

const (
	devicePairingPath   = "/public/managed-devices/pairing"
	devicePairingCookie = "makerspace_device_pairing"
	devicePairingHeader = "X-Device-Pairing-Secret"
)

// kioskPairingEnv reuses the signage test server (same cookie names and helpers) and adds the device type and
// session policy a kiosk claim needs.
type kioskPairingEnv struct {
	*signageEnv
	deviceTypeID string
	policyID     string
}

func newKioskPairingEnv(t *testing.T, adjust func(*config.Config)) kioskPairingEnv {
	t.Helper()
	e := newSignageEnvWith(t, adjust)
	ctx := testContext(t)
	devices := manageddevices.NewService(e.pool)
	deviceType, err := devices.CreateType(ctx, e.fixture.admin, "Entrance tablet", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	policy, err := devices.CreateSessionPolicy(ctx, e.fixture.admin, manageddevices.SessionPolicyInput{
		Name:                    "Kiosk",
		IdleTimeoutSeconds:      120,
		AbsoluteLifetimeSeconds: 900,
		PostSessionDestination:  manageddevices.DestinationVisitorKiosk,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	return kioskPairingEnv{signageEnv: e, deviceTypeID: deviceType.ID.String(), policyID: policy.ID.String()}
}

func (e kioskPairingEnv) manager() staffSession {
	return e.staff("kiosk-"+ids.New().String()[24:], authorization.ManagedDevicesRead, authorization.ManagedDevicesManage)
}

func (e kioskPairingEnv) claimBody(code, name string) map[string]any {
	return map[string]any{
		"code": code, "name": name, "deviceTypeId": e.deviceTypeID, "expiresAt": nil,
		"sessionPolicyId": e.policyID, "terminalEnabled": true,
		"allowedApplicationModes": []string{"visitor_terminal"},
		"checkInMethods":          []string{"email_code", "password"}, "checkOutMethods": []string{},
		"allowTapCheckout": true, "offerSurveysAtCheckout": false, "kioskResetSeconds": 90,
		"capabilities": []string{"camera", "file_upload"},
	}
}

func (e kioskPairingEnv) claim(staff staffSession, code, name string) *http.Response {
	return e.as(staff, http.MethodPost, "/managed-devices/pairing", e.claimBody(code, name))
}

// startBrowser requests a code the way a kiosk browser does and returns the code.
func (e kioskPairingEnv) startBrowser(kiosk *http.Client) string {
	e.t.Helper()
	start := e.expect(
		e.do(kiosk, "", http.MethodPost, devicePairingPath, map[string]any{"credentialDelivery": "bindBrowser"}),
		http.StatusCreated,
	)
	return start["code"].(string)
}

// startNative requests a code the way the desktop app does: no Origin header, poll secret in the body.
func (e kioskPairingEnv) startNative() (code, secret string) {
	e.t.Helper()
	start := e.expect(e.do(
		newCookieClient(e.t), "", http.MethodPost, devicePairingPath,
		map[string]any{"credentialDelivery": "nativeToken"}, "Origin", "",
	), http.StatusCreated)
	return start["code"].(string), start["pollSecret"].(string)
}

func (e kioskPairingEnv) pollNative(secret string) *http.Response {
	return e.do(newCookieClient(e.t), "", http.MethodGet, devicePairingPath, nil, devicePairingHeader, secret)
}

func devicePairingCodeDigest(code string) []byte {
	// Mirrors the service's digest so a test can plant a request.
	return pairingcode.Digest("managed-device-pairing-code", code)
}

func TestKioskPairingBrowserFlowDeliversTheDeviceCookieOnce(t *testing.T) {
	e := newKioskPairingEnv(t, nil)
	ctx := testContext(t)
	staff := e.manager()
	kiosk := e.newPlayer()

	// Without the poll cookie there is nothing to poll.
	if poll := e.expect(e.do(e.newPlayer(), "", http.MethodGet, devicePairingPath, nil), http.StatusOK); poll["status"] != "expired" {
		t.Fatalf("poll without cookie = %v", poll)
	}

	response := e.do(kiosk, "", http.MethodPost, devicePairingPath, map[string]any{"credentialDelivery": "bindBrowser"})
	cookie := setCookie(response, devicePairingCookie)
	if cookie == nil || !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode || cookie.MaxAge != 900 ||
		cookie.Value == "" {
		t.Fatalf("poll-secret cookie = %#v", cookie)
	}
	if response.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("pairing start must be no-store, got %q", response.Header.Get("Cache-Control"))
	}
	start := e.expect(response, http.StatusCreated)
	code := start["code"].(string)
	if len(code) != 6 || strings.Trim(code, pairingcode.Alphabet) != "" {
		t.Fatalf("code %q is not 6 characters of the alphabet", code)
	}
	if _, exposed := start["pollSecret"]; exposed {
		t.Fatal("a browser request must not expose the poll secret to JavaScript")
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, start["expiresAt"].(string))
	if err != nil || time.Until(expiresAt) < 14*time.Minute || time.Until(expiresAt) > 15*time.Minute+5*time.Second {
		t.Fatalf("expiresAt = %v (%v)", start["expiresAt"], err)
	}

	// Only digests are stored.
	var storedCode, storedSecret []byte
	var delivery string
	if err := e.pool.QueryRow(ctx, `SELECT code_digest, poll_secret_digest, credential_delivery
		FROM managed_device_pairing_requests`).Scan(&storedCode, &storedSecret, &delivery); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(storedCode, devicePairingCodeDigest(code)) || bytes.Contains(storedCode, []byte(code)) ||
		!bytes.Equal(storedSecret, security.DigestToken(cookie.Value)) || delivery != "browser_cookie" {
		t.Fatal("a pairing request must store only digests of the code and the poll secret")
	}
	// Signage and kiosk codes are separate: a kiosk code is not a display code.
	signageDigest := sha256.Sum256([]byte("signage-pairing-code:" + code))
	if bytes.Equal(storedCode, signageDigest[:]) {
		t.Fatal("kiosk and signage pairing codes must not share digests")
	}

	// Before the claim: pending, and no credential cookie.
	response = e.do(kiosk, "", http.MethodGet, devicePairingPath, nil)
	if setCookie(response, signageDeviceCookie) != nil {
		t.Fatal("a pending poll must not set the device cookie")
	}
	if poll := e.expect(response, http.StatusOK); poll["status"] != "pending" {
		t.Fatalf("poll = %v", poll)
	}

	// Authorization: no session, or only managed_devices.read, cannot claim.
	anonymous := e.do(e.newPlayer(), "", http.MethodPost, "/managed-devices/pairing", e.claimBody(code, "Nope"))
	e.expect(anonymous, http.StatusUnauthorized)
	reader := e.staff("kiosk-reader", authorization.ManagedDevicesRead)
	e.expect(e.claim(reader, code, "Nope"), http.StatusForbidden)

	// A wrong, an expired and a malformed code give the identical answer.
	wrong := e.expect(e.claim(staff, "AAAAAA", "Wrong"), http.StatusUnprocessableEntity)
	if _, err := e.pool.Exec(ctx, `INSERT INTO managed_device_pairing_requests
		(id, code_digest, poll_secret_digest, credential_delivery, created_at, expires_at)
		VALUES ($1, $2, $3, 'browser_cookie', now() - interval '20 minutes', now() - interval '5 minutes')`,
		ids.New(), devicePairingCodeDigest("EXPIRD"), security.DigestToken("expired-secret")); err != nil {
		t.Fatal(err)
	}
	expired := e.expect(e.claim(staff, "EXPIRD", "Expired"), http.StatusUnprocessableEntity)
	malformed := e.expect(e.claim(staff, "no", "Malformed"), http.StatusUnprocessableEntity)
	for _, body := range []map[string]any{wrong, expired, malformed} {
		if body["code"] != "pairing_code_invalid" || body["message"] != wrong["message"] {
			t.Fatalf("answers differ: %v vs %v", body, wrong)
		}
	}
	if e.countAudit("managed_device.paired") != 0 {
		t.Fatal("failed claims must not create or audit a device")
	}

	// Claim (case and separators are forgiven): the device exists with the chosen settings.
	device := e.expect(e.claim(staff, strings.ToLower(code[:3]+"-"+code[3:]), "Entrance kiosk"), http.StatusCreated)
	if device["name"] != "Entrance kiosk" || device["terminalEnabled"] != true || device["status"] != "active" ||
		device["kioskResetSeconds"] != float64(90) || fmt.Sprint(device["checkInMethods"]) != "[email_code password]" ||
		fmt.Sprint(device["checkOutMethods"]) != "[]" {
		t.Fatalf("device = %v", device)
	}
	if capabilities, _ := device["capabilities"].([]any); len(capabilities) != 2 {
		t.Fatalf("capabilities = %v", device["capabilities"])
	}
	deviceID := device["id"].(string)
	e.expectCode(e.claim(staff, code, "Twice"), http.StatusUnprocessableEntity, "pairing_code_invalid")
	if e.countAudit("managed_device.paired") != 1 {
		t.Fatal("pairing must be audited exactly once")
	}
	var placeholder []byte
	if err := e.pool.QueryRow(ctx, `SELECT token_digest FROM managed_devices WHERE id = $1`, deviceID).
		Scan(&placeholder); err != nil {
		t.Fatal(err)
	}

	// The first poll after the claim installs the device cookie, once, and clears the poll cookie.
	response = e.do(kiosk, "", http.MethodGet, devicePairingPath, nil)
	deviceCookie := setCookie(response, signageDeviceCookie)
	if deviceCookie == nil || !deviceCookie.HttpOnly || deviceCookie.SameSite != http.SameSiteStrictMode ||
		deviceCookie.Value == "" {
		t.Fatalf("device cookie = %#v", deviceCookie)
	}
	if cleared := setCookie(response, devicePairingCookie); cleared == nil || cleared.MaxAge >= 0 {
		t.Fatalf("poll cookie should be cleared, got %#v", cleared)
	}
	poll := e.expect(response, http.StatusOK)
	if poll["status"] != "paired" || poll["token"] != nil {
		t.Fatalf("poll = %v; a browser poll must never carry the token in the body", poll)
	}
	var stored []byte
	if err := e.pool.QueryRow(ctx, `SELECT token_digest FROM managed_devices WHERE id = $1`, deviceID).
		Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(stored, security.DigestToken(deviceCookie.Value)) || bytes.Equal(stored, placeholder) {
		t.Fatal("the stored device credential must be the digest of the delivered token")
	}
	if e.countAudit("managed_device.credential_delivered") != 1 {
		t.Fatal("the credential delivery must be audited")
	}
	var left int
	if err := e.pool.QueryRow(ctx, `SELECT count(*) FROM managed_device_pairing_requests WHERE claimed_device_id IS NOT NULL`).
		Scan(&left); err != nil || left != 0 {
		t.Fatalf("a delivered request must be deleted: %d %v", left, err)
	}

	// A copy of the old poll cookie never yields another credential.
	replay := e.newPlayer()
	jarURL, _ := url.Parse(e.server.URL)
	replay.Jar.SetCookies(jarURL, []*http.Cookie{{Name: devicePairingCookie, Value: cookie.Value}})
	response = e.do(replay, "", http.MethodGet, devicePairingPath, nil)
	if setCookie(response, signageDeviceCookie) != nil {
		t.Fatal("the credential must be delivered exactly once")
	}
	if poll := e.expect(response, http.StatusOK); poll["status"] != "expired" {
		t.Fatalf("replayed poll = %v", poll)
	}

	// The kiosk browser now works as the claimed entrance kiosk.
	context := e.expect(e.do(kiosk, "", http.MethodGet, "/terminal/context", nil), http.StatusOK)
	if context["deviceName"] != "Entrance kiosk" {
		t.Fatalf("terminal context = %v", context)
	}
}

func TestKioskPairingNativeDeliveryReturnsTheTokenOnlyToItsPoller(t *testing.T) {
	e := newKioskPairingEnv(t, nil)
	staff := e.manager()

	code, secret := e.startNative()
	response := e.do(newCookieClient(t), "", http.MethodPost, devicePairingPath,
		map[string]any{"credentialDelivery": "nativeToken"}, "Origin", "")
	if setCookie(response, devicePairingCookie) != nil {
		t.Fatal("a native request must not set the poll cookie")
	}
	response.Body.Close()
	if poll := e.expect(e.pollNative(secret), http.StatusOK); poll["status"] != "pending" || poll["token"] != nil {
		t.Fatalf("pending native poll = %v", poll)
	}
	// A cross-site browser cannot start a request: only a missing Origin is excused.
	e.expectCode(
		e.do(newCookieClient(t), "", http.MethodPost, devicePairingPath, map[string]any{"credentialDelivery": "nativeToken"},
			"Origin", "https://evil.example"),
		http.StatusForbidden,
		"origin_invalid",
	)

	e.expect(e.as(staff, http.MethodPost, "/managed-devices/pairing", map[string]any{
		"code": code, "name": "Desk app", "deviceTypeId": e.deviceTypeID, "expiresAt": nil, "sessionPolicyId": nil,
		"terminalEnabled": false, "allowedApplicationModes": []string{"staff_ui"},
		"checkInMethods": []string{"password"}, "checkOutMethods": []string{"pin"}, "allowTapCheckout": false, "offerSurveysAtCheckout": false,
		"kioskResetSeconds": 60, "capabilities": []string{"nfc"},
	}), http.StatusCreated)

	response = e.pollNative(secret)
	if setCookie(response, signageDeviceCookie) != nil {
		t.Fatal("a native request must not receive the browser cookie")
	}
	poll := e.expect(response, http.StatusOK)
	token, _ := poll["token"].(string)
	if poll["status"] != "paired" || len(token) != 43 {
		t.Fatalf("paired native poll = %v", poll)
	}
	if again := e.expect(e.pollNative(secret), http.StatusOK); again["status"] != "expired" || again["token"] != nil {
		t.Fatalf("the token must be delivered exactly once, got %v", again)
	}
	identity := e.expect(e.do(newCookieClient(t), "", http.MethodGet, "/managed-devices/self/hardware", nil,
		"X-Managed-Device-Token", token), http.StatusOK)
	if identity["deviceName"] != "Desk app" {
		t.Fatalf("the delivered token must authenticate the paired device: %v", identity)
	}

	// A registered device that is not a kiosk is told so instead of looking unregistered, and cannot be paired again
	// over its own credential.
	e.expectCode(e.do(newCookieClient(t), "", http.MethodGet, "/terminal/context", nil,
		"X-Managed-Device-Token", token), http.StatusForbidden, "device_not_kiosk")
	e.expectCode(e.do(newCookieClient(t), "", http.MethodPost, devicePairingPath,
		map[string]any{"credentialDelivery": "nativeToken"}, "Origin", "", "X-Managed-Device-Token", token),
		http.StatusConflict, "device_already_registered")
}

func TestKioskPairingRefusesBrowsersWithoutOriginAndRegisteredDevices(t *testing.T) {
	e := newKioskPairingEnv(t, nil)
	staff := e.manager()

	// The originless exemption serves only the desktop app.
	e.expectCode(
		e.do(e.newPlayer(), "", http.MethodPost, devicePairingPath, map[string]any{"credentialDelivery": "bindBrowser"},
			"Origin", ""),
		http.StatusForbidden,
		"origin_invalid",
	)

	// A browser that already holds a valid device cookie can neither start nor poll a pairing.
	kiosk := e.newPlayer()
	code := e.startBrowser(kiosk)
	e.expect(e.claim(staff, code, "Registered kiosk"), http.StatusCreated)
	if poll := e.expect(e.do(kiosk, "", http.MethodGet, devicePairingPath, nil), http.StatusOK); poll["status"] != "paired" {
		t.Fatalf("poll = %v", poll)
	}
	e.expectCode(
		e.do(kiosk, "", http.MethodPost, devicePairingPath, map[string]any{"credentialDelivery": "bindBrowser"}),
		http.StatusConflict,
		"device_already_registered",
	)
	e.expectCode(e.do(kiosk, "", http.MethodGet, devicePairingPath, nil), http.StatusConflict, "device_already_registered")

	// A signage player's credential never reaches kiosk pairing.
	signageStaff := e.allStaff()
	_, defaults := e.seedContent("Kiosk pairing isolation")
	_, player := e.pair(signageStaff, "Isolated player", defaults)
	e.expectCode(
		e.do(player, "", http.MethodPost, devicePairingPath, map[string]any{"credentialDelivery": "bindBrowser"}),
		http.StatusForbidden,
		"device_mode_denied",
	)
	e.expectCode(e.do(player, "", http.MethodGet, devicePairingPath, nil), http.StatusForbidden, "device_mode_denied")
}

func TestKioskPairingConcurrentPollsDeliverTheCredentialOnce(t *testing.T) {
	e := newKioskPairingEnv(t, nil)
	staff := e.manager()
	for round := 0; round < 5; round++ {
		code, secret := e.startNative()
		e.expect(e.claim(staff, code, "Concurrent "+ids.New().String()[24:]), http.StatusCreated)
		const pollers = 4
		tokens := make(chan string, pollers)
		var wait sync.WaitGroup
		for i := 0; i < pollers; i++ {
			wait.Add(1)
			go func() {
				defer wait.Done()
				request, err := http.NewRequestWithContext(testContext(t), http.MethodGet, e.api+devicePairingPath, nil)
				if err != nil {
					t.Error(err)
					return
				}
				request.Header.Set(devicePairingHeader, secret)
				response, err := http.DefaultClient.Do(request)
				if err != nil {
					t.Error(err)
					return
				}
				defer response.Body.Close()
				var body map[string]any
				if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
					t.Error(err)
					return
				}
				if token, _ := body["token"].(string); token != "" {
					tokens <- token
				}
			}()
		}
		wait.Wait()
		close(tokens)
		if delivered := len(tokens); delivered != 1 {
			t.Fatalf("round %d: %d polls received a token, want exactly 1", round, delivered)
		}
	}
}

func TestKioskPairingLimitsRestartsAndRevocation(t *testing.T) {
	e := newKioskPairingEnv(t, nil)
	ctx := testContext(t)
	staff := e.manager()

	// Per account: ten wrong codes, then 429 even for a code that would be right; another account is unaffected.
	for i := 0; i < 10; i++ {
		e.expectCode(e.claim(staff, "ZZZZZZ", "Guess"), http.StatusUnprocessableEntity, "pairing_code_invalid")
	}
	code := e.startBrowser(e.newPlayer())
	e.expectCode(e.claim(staff, code, "Limited"), http.StatusTooManyRequests, "rate_limited")
	other := e.manager()

	// A restart after the claim keeps the claimed request collectable.
	kiosk := e.newPlayer()
	restartCode := e.startBrowser(kiosk)
	e.expect(e.claim(other, restartCode, "Restarted"), http.StatusCreated)
	e.expectCode(
		e.do(kiosk, "", http.MethodPost, devicePairingPath, map[string]any{"credentialDelivery": "bindBrowser"}),
		http.StatusConflict,
		"pairing_claimed",
	)
	if poll := e.expect(e.do(kiosk, "", http.MethodGet, devicePairingPath, nil), http.StatusOK); poll["status"] != "paired" {
		t.Fatalf("a restart lost the claimed request: %v", poll)
	}

	// A device revoked before the kiosk collected its credential delivers nothing.
	revokedKiosk := e.newPlayer()
	revokedCode := e.startBrowser(revokedKiosk)
	device := e.expect(e.claim(other, revokedCode, "Revoked early"), http.StatusCreated)
	e.expect(e.as(other, http.MethodPost, "/managed-devices/"+device["id"].(string)+"/revoke",
		map[string]any{"expectedVersion": device["version"]}), http.StatusOK)
	response := e.do(revokedKiosk, "", http.MethodGet, devicePairingPath, nil)
	if setCookie(response, signageDeviceCookie) != nil {
		t.Fatal("a revoked device must not receive a credential")
	}
	if poll := e.expect(response, http.StatusOK); poll["status"] != "expired" {
		t.Fatalf("poll after revocation = %v", poll)
	}

	// Per client IP: ten codes per hour (four were used above), then 429.
	for i := 0; i < 6; i++ {
		e.startBrowser(e.newPlayer())
	}
	e.expectCode(
		e.do(e.newPlayer(), "", http.MethodPost, devicePairingPath, map[string]any{"credentialDelivery": "bindBrowser"}),
		http.StatusTooManyRequests,
		"rate_limited",
	)

	// An unknown delivery is rejected by the contract.
	fresh := newKioskPairingEnv(t, nil)
	fresh.expect(
		fresh.do(fresh.newPlayer(), "", http.MethodPost, devicePairingPath, map[string]any{"credentialDelivery": "email"}),
		http.StatusBadRequest,
	)

	// Expired rows disappear opportunistically, and the global cap of open requests applies.
	if _, err := fresh.pool.Exec(ctx, `INSERT INTO managed_device_pairing_requests
		(id, code_digest, poll_secret_digest, credential_delivery, created_at, expires_at)
		VALUES ($1, $2, $3, 'native_token', now() - interval '30 minutes', now() - interval '15 minutes')`,
		ids.New(), devicePairingCodeDigest("OLDONE"), security.DigestToken("old")); err != nil {
		t.Fatal(err)
	}
	fresh.startBrowser(fresh.newPlayer())
	var rows int
	if err := fresh.pool.QueryRow(ctx, `SELECT count(*) FROM managed_device_pairing_requests`).Scan(&rows); err != nil ||
		rows != 1 {
		t.Fatalf("the expired row should be gone, rows=%d err=%v", rows, err)
	}
	if _, err := fresh.pool.Exec(ctx, `INSERT INTO managed_device_pairing_requests
		(id, code_digest, poll_secret_digest, credential_delivery, created_at, expires_at)
		SELECT uuidv7(), sha256(('c' || n)::bytea), sha256(('s' || n)::bytea), 'browser_cookie', now(),
			now() + interval '10 minutes' FROM generate_series(1, 49) AS n`); err != nil {
		t.Fatal(err)
	}
	fresh.expectCode(
		fresh.do(fresh.newPlayer(), "", http.MethodPost, devicePairingPath, map[string]any{"credentialDelivery": "bindBrowser"}),
		http.StatusTooManyRequests,
		"rate_limited",
	)
}

func TestKioskPairingPollsAreRateLimitedAndGarbageIsCheap(t *testing.T) {
	e := newKioskPairingEnv(t, nil)
	// A garbage secret never reaches the database or the rate limiter.
	for i := 0; i < 80; i++ {
		if poll := e.expect(e.pollNative("not-a-token"), http.StatusOK); poll["status"] != "expired" {
			t.Fatalf("poll = %v", poll)
		}
	}
	_, secret := e.startNative()
	limited := 0
	for i := 0; i < 70; i++ {
		response := e.pollNative(secret)
		if response.StatusCode == http.StatusTooManyRequests {
			limited++
		}
		response.Body.Close()
	}
	if limited == 0 {
		t.Fatal("pairing polls were never rate limited")
	}
}

func TestKioskPairingAllowedCIDRs(t *testing.T) {
	denied := newKioskPairingEnv(t, func(c *config.Config) {
		c.DevicePairingAllowedCIDRs = []netip.Prefix{netip.MustParsePrefix("192.0.2.0/24")}
	})
	denied.expectCode(
		denied.do(denied.newPlayer(), "", http.MethodPost, devicePairingPath, map[string]any{"credentialDelivery": "bindBrowser"}),
		http.StatusForbidden,
		"pairing_network_denied",
	)
	// Signage pairing has its own allow-list.
	denied.expect(denied.do(denied.newPlayer(), "", http.MethodPost, "/public/signage/pairing", nil), http.StatusCreated)
	allowed := newKioskPairingEnv(t, func(c *config.Config) {
		c.DevicePairingAllowedCIDRs = []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8"), netip.MustParsePrefix("::1/128")}
	})
	allowed.startBrowser(allowed.newPlayer())
}
