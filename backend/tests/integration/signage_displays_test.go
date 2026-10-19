package integration_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/httpapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printerconnectors"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printing"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/signage"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/storage"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

const signageDeviceCookie = "makerspace_device"
const signagePairingCookie = "makerspace_signage_pairing"

type signageEnv struct {
	t       *testing.T
	pool    *pgxpool.Pool
	fixture signageFixture
	server  *httptest.Server
	api     string
	origin  string
}

type staffSession struct {
	client    *http.Client
	csrf      string
	principal authorization.Principal
	account   seededAccount
}

func newSignageEnv(t *testing.T) *signageEnv {
	t.Helper()
	pool := migratedPool(t)
	dir := t.TempDir()
	store, err := storage.NewLocal(dir)
	if err != nil {
		t.Fatal(err)
	}
	service, err := signage.NewService(pool, config.Config{MakerspaceTimeZone: "Europe/Vienna"}, files.NewService(pool, store))
	if err != nil {
		t.Fatal(err)
	}
	master := seedAccount(t, pool, "signage-master", true)
	cfg := integrationConfig(t)
	cfg.LocalStorageRoot = dir
	cfg.SessionCookieName, cfg.CSRFCookieName, cfg.ManagedDeviceCookieName = "makerspace_session", "makerspace_csrf", signageDeviceCookie
	cfg.MakerspaceTimeZone = "Europe/Vienna"
	handler, err := httpapi.NewHandler(pool, cfg, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return &signageEnv{
		t: t, pool: pool, server: server, api: server.URL + "/api/v1", origin: cfg.PublicBaseURL.String(),
		fixture: signageFixture{pool: pool, service: service, store: store, admin: authorization.Principal{AccountID: master.accountID, PersonID: master.personID, Master: true}},
	}
}

func (e *signageEnv) staff(suffix string, permissions ...authorization.Permission) staffSession {
	e.t.Helper()
	principal, account := signageActor(e.t, e.pool, suffix, permissions...)
	session, csrf := insertTestSession(e.t, e.pool, account)
	return staffSession{client: clientWithSession(e.t, e.server.URL, session, csrf), csrf: csrf, principal: principal, account: account}
}

func (e *signageEnv) allStaff() staffSession {
	return e.staff("all-"+uuid.NewString()[:8], authorization.SignageRead, authorization.SignageManage, authorization.SignageContentManage, authorization.SignagePublish, authorization.SignageOverride)
}

func (e *signageEnv) newPlayer() *http.Client { return newCookieClient(e.t) }

// do sends a JSON request with the same-origin header the API requires for unsafe methods.
func (e *signageEnv) do(client *http.Client, csrf, method, path string, body any, headers ...string) *http.Response {
	e.t.Helper()
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			e.t.Fatal(err)
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(testContext(e.t), method, e.api+path, reader)
	if err != nil {
		e.t.Fatal(err)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	request.Header.Set("Origin", e.origin)
	if csrf != "" {
		request.Header.Set("X-CSRF-Token", csrf)
	}
	for index := 0; index+1 < len(headers); index += 2 {
		request.Header.Set(headers[index], headers[index+1])
	}
	response, err := client.Do(request)
	if err != nil {
		e.t.Fatal(err)
	}
	return response
}

func (e *signageEnv) as(s staffSession, method, path string, body any) *http.Response {
	return e.do(s.client, s.csrf, method, path, body)
}

// status asserts the status code and returns the decoded JSON object (nil for empty bodies).
func (e *signageEnv) expect(response *http.Response, status int) map[string]any {
	e.t.Helper()
	if response.StatusCode != status {
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		e.t.Fatalf("status = %d, want %d; body=%s", response.StatusCode, status, strings.TrimSpace(string(body)))
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		e.t.Fatal(err)
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	var value map[string]any
	if err := json.Unmarshal(raw, &value); err != nil {
		e.t.Fatalf("response is not a JSON object: %s", raw)
	}
	return value
}

func (e *signageEnv) expectCode(response *http.Response, status int, code string) {
	e.t.Helper()
	body := e.expect(response, status)
	if body["code"] != code {
		e.t.Fatalf("error code = %v, want %s; body=%v", body["code"], code, body)
	}
}

// pair runs the whole player/staff handshake and returns the display plus the paired player client.
func (e *signageEnv) pair(staff staffSession, name string, playlistID uuid.UUID) (map[string]any, *http.Client) {
	e.t.Helper()
	player := e.newPlayer()
	start := e.expect(e.do(player, "", http.MethodPost, "/public/signage/pairing", nil), http.StatusCreated)
	display := e.expect(e.as(staff, http.MethodPost, "/signage/displays", map[string]any{
		"code": start["code"], "name": name, "location": "Entrance hall", "orientation": "landscape",
		"resolution": map[string]any{"width": 1920, "height": 1080}, "visibleFromOutside": false, "defaultPlaylistId": playlistID.String(),
	}), http.StatusCreated)
	if poll := e.expect(e.do(player, "", http.MethodGet, "/public/signage/pairing", nil), http.StatusOK); poll["status"] != "paired" {
		e.t.Fatalf("poll after claim = %v", poll)
	}
	return display, player
}

func (e *signageEnv) deviceToken(player *http.Client) string {
	e.t.Helper()
	return cookieValue(e.t, player, e.server.URL, signageDeviceCookie)
}

func (e *signageEnv) seedContent(name string) (signage.Scene, signage.Playlist) {
	e.t.Helper()
	scene := e.fixture.scene(e.t, name+" scene")
	return scene, e.fixture.playlist(e.t, name+" playlist", scene.ID)
}

func (e *signageEnv) displayVersion(staff staffSession, id string) int64 {
	e.t.Helper()
	return int64(e.expect(e.as(staff, http.MethodGet, "/signage/displays/"+id, nil), http.StatusOK)["version"].(float64))
}

func (e *signageEnv) countAudit(action string) int {
	e.t.Helper()
	var count int
	if err := e.pool.QueryRow(testContext(e.t), `SELECT count(*) FROM audit_events WHERE action = $1`, action).Scan(&count); err != nil {
		e.t.Fatal(err)
	}
	return count
}

func setCookie(response *http.Response, name string) *http.Cookie {
	for _, cookie := range response.Cookies() {
		if cookie.Name == name {
			return cookie
		}
	}
	return nil
}

func TestSignagePairingFlowEndToEnd(t *testing.T) {
	e := newSignageEnv(t)
	ctx := testContext(t)
	staff := e.allStaff()
	_, playlist := e.seedContent("Pairing")
	player := e.newPlayer()

	// Without the poll cookie there is nothing to poll.
	if poll := e.expect(e.do(e.newPlayer(), "", http.MethodGet, "/public/signage/pairing", nil), http.StatusOK); poll["status"] != "expired" {
		t.Fatalf("poll without cookie = %v", poll)
	}

	response := e.do(player, "", http.MethodPost, "/public/signage/pairing", nil)
	cookie := setCookie(response, signagePairingCookie)
	if cookie == nil || !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode || cookie.MaxAge != 900 || cookie.Value == "" {
		t.Fatalf("poll-secret cookie = %#v", cookie)
	}
	if response.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("pairing start must be no-store, got %q", response.Header.Get("Cache-Control"))
	}
	start := e.expect(response, http.StatusCreated)
	code := start["code"].(string)
	if len(code) != 6 || strings.Trim(code, signage.PairingCodeAlphabet) != "" {
		t.Fatalf("code %q is not 6 characters of the alphabet", code)
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, start["expiresAt"].(string))
	if err != nil || time.Until(expiresAt) < 14*time.Minute || time.Until(expiresAt) > 15*time.Minute+5*time.Second {
		t.Fatalf("expiresAt = %v (%v)", start["expiresAt"], err)
	}

	// Only digests are stored.
	var storedCodeDigest, storedSecretDigest []byte
	if err := e.pool.QueryRow(ctx, `SELECT code_digest, poll_secret_digest FROM signage_pairing_requests`).Scan(&storedCodeDigest, &storedSecretDigest); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(storedCodeDigest, []byte(code)) || len(storedCodeDigest) != 32 || !bytes.Equal(storedSecretDigest, security.DigestToken(cookie.Value)) {
		t.Fatal("pairing request must store only digests of the code and the poll secret")
	}

	// Before the claim: pending, and no credential cookie.
	response = e.do(player, "", http.MethodGet, "/public/signage/pairing", nil)
	if setCookie(response, signageDeviceCookie) != nil {
		t.Fatal("pending poll must not set the device cookie")
	}
	if poll := e.expect(response, http.StatusOK); poll["status"] != "pending" {
		t.Fatalf("poll = %v", poll)
	}

	claim := func(s staffSession, code string) *http.Response {
		return e.as(s, http.MethodPost, "/signage/displays", map[string]any{
			"code": code, "name": "Entrance", "location": "Hall", "orientation": "landscape",
			"resolution": map[string]any{"width": 1920, "height": 1080}, "visibleFromOutside": true, "defaultPlaylistId": playlist.ID.String(),
		})
	}
	// A wrong code and an expired code give the identical answer.
	wrong := e.expect(claim(staff, "AAAAAA"), http.StatusUnprocessableEntity)
	if _, err := e.pool.Exec(ctx, `INSERT INTO signage_pairing_requests (id, code_digest, poll_secret_digest, created_at, expires_at)
		VALUES ($1, $2, $3, now() - interval '20 minutes', now() - interval '5 minutes')`, uuid.Must(uuid.NewV7()), signageCodeDigest("EXPIRD"), security.DigestToken("expired-secret")); err != nil {
		t.Fatal(err)
	}
	expired := e.expect(claim(staff, "EXPIRD"), http.StatusUnprocessableEntity)
	malformed := e.expect(claim(staff, "no"), http.StatusUnprocessableEntity)
	for _, body := range []map[string]any{expired, malformed} {
		if body["code"] != "pairing_code_invalid" || body["message"] != wrong["message"] {
			t.Fatalf("answers differ: %v vs %v", body, wrong)
		}
	}
	if wrong["code"] != "pairing_code_invalid" {
		t.Fatalf("wrong code answer = %v", wrong)
	}

	// Claim (case and separators are forgiven); the display and its device exist, nothing is audited as a secret.
	display := e.expect(claim(staff, strings.ToLower(code[:3]+"-"+code[3:])), http.StatusCreated)
	if display["status"] != "offline" || display["publishedRevision"] != nil || display["name"] != "Entrance" || display["visibleFromOutside"] != true {
		t.Fatalf("display = %v", display)
	}
	var modes []string
	var deviceTypeName string
	if err := e.pool.QueryRow(ctx, `SELECT md.allowed_app_modes, dt.name FROM managed_devices md JOIN device_types dt ON dt.id = md.device_type_id WHERE md.id = $1`, display["managedDeviceId"]).Scan(&modes, &deviceTypeName); err != nil {
		t.Fatal(err)
	}
	if len(modes) != 1 || modes[0] != "signage_player" || deviceTypeName != "Signage display" {
		t.Fatalf("device modes=%v type=%q", modes, deviceTypeName)
	}
	// The code cannot be claimed twice.
	e.expectCode(claim(staff, code), http.StatusUnprocessableEntity, "pairing_code_invalid")

	// Before delivery the device holds an unusable credential.
	if e.countAudit("signage_display.paired") != 1 {
		t.Fatal("pairing must be audited exactly once")
	}

	// First poll after the claim delivers the cookie, once.
	response = e.do(player, "", http.MethodGet, "/public/signage/pairing", nil)
	deviceCookie := setCookie(response, signageDeviceCookie)
	if deviceCookie == nil || !deviceCookie.HttpOnly || deviceCookie.SameSite != http.SameSiteStrictMode || deviceCookie.Value == "" {
		t.Fatalf("device cookie = %#v", deviceCookie)
	}
	if cleared := setCookie(response, signagePairingCookie); cleared == nil || cleared.MaxAge >= 0 {
		t.Fatalf("poll cookie should be cleared, got %#v", cleared)
	}
	if poll := e.expect(response, http.StatusOK); poll["status"] != "paired" {
		t.Fatalf("poll = %v", poll)
	}
	var storedDigest []byte
	if err := e.pool.QueryRow(ctx, `SELECT token_digest FROM managed_devices WHERE id = $1`, display["managedDeviceId"]).Scan(&storedDigest); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(storedDigest, security.DigestToken(deviceCookie.Value)) {
		t.Fatal("the stored device credential must be the digest of the delivered token")
	}
	var open int
	if err := e.pool.QueryRow(ctx, `SELECT count(*) FROM signage_pairing_requests WHERE claimed_display_id IS NOT NULL`).Scan(&open); err != nil || open != 0 {
		t.Fatalf("delivered request must be deleted: %d %v", open, err)
	}
	// A second poll (even with a copy of the old cookie) never yields another credential.
	replay := e.newPlayer()
	jarURL, _ := url.Parse(e.server.URL)
	replay.Jar.SetCookies(jarURL, []*http.Cookie{{Name: signagePairingCookie, Value: cookie.Value}})
	response = e.do(replay, "", http.MethodGet, "/public/signage/pairing", nil)
	if setCookie(response, signageDeviceCookie) != nil {
		t.Fatal("the credential must be delivered exactly once")
	}
	if poll := e.expect(response, http.StatusOK); poll["status"] != "expired" {
		t.Fatalf("replayed poll = %v", poll)
	}
	// The player now authenticates as its device.
	e.expectCode(e.do(player, "", http.MethodGet, "/signage/player/manifest", nil), http.StatusNotFound, "signage_not_published")
}

func signageCodeDigest(code string) []byte {
	// Mirrors the service's digest so a test can plant a request.
	sum := sha256.Sum256([]byte("signage-pairing-code:" + code))
	return sum[:]
}

func TestSignagePairingRateLimitsAndCleanup(t *testing.T) {
	e := newSignageEnv(t)
	ctx := testContext(t)
	staff := e.allStaff()
	_, playlist := e.seedContent("Limits")

	// Per account: ten wrong codes, then 429 even for a code that would be right.
	attempt := func(code string) *http.Response {
		return e.as(staff, http.MethodPost, "/signage/displays", map[string]any{
			"code": code, "name": "X", "location": "", "orientation": "landscape",
			"resolution": map[string]any{"width": 1920, "height": 1080}, "visibleFromOutside": false, "defaultPlaylistId": playlist.ID.String(),
		})
	}
	for i := 0; i < 10; i++ {
		e.expectCode(attempt("ZZZZZZ"), http.StatusUnprocessableEntity, "pairing_code_invalid")
	}
	start := e.expect(e.do(e.newPlayer(), "", http.MethodPost, "/public/signage/pairing", nil), http.StatusCreated)
	e.expectCode(attempt(start["code"].(string)), http.StatusTooManyRequests, "rate_limited")
	// Another account is unaffected.
	other := e.allStaff()
	e.expect(e.as(other, http.MethodPost, "/signage/displays", map[string]any{
		"code": start["code"], "name": "Y", "location": "", "orientation": "landscape",
		"resolution": map[string]any{"width": 1920, "height": 1080}, "visibleFromOutside": false, "defaultPlaylistId": playlist.ID.String(),
	}), http.StatusCreated)

	// Per client IP: ten codes per hour (one was used above), then 429.
	for i := 0; i < 9; i++ {
		e.expect(e.do(e.newPlayer(), "", http.MethodPost, "/public/signage/pairing", nil), http.StatusCreated)
	}
	e.expectCode(e.do(e.newPlayer(), "", http.MethodPost, "/public/signage/pairing", nil), http.StatusTooManyRequests, "rate_limited")

	// Expired rows disappear opportunistically, and the global cap of open requests applies.
	e2 := newSignageEnv(t)
	ctx2 := testContext(t)
	if _, err := e2.pool.Exec(ctx2, `INSERT INTO signage_pairing_requests (id, code_digest, poll_secret_digest, created_at, expires_at)
		VALUES ($1, $2, $3, now() - interval '30 minutes', now() - interval '15 minutes')`, uuid.Must(uuid.NewV7()), signageCodeDigest("OLDONE"), security.DigestToken("old")); err != nil {
		t.Fatal(err)
	}
	e2.expect(e2.do(e2.newPlayer(), "", http.MethodPost, "/public/signage/pairing", nil), http.StatusCreated)
	var rows int
	if err := e2.pool.QueryRow(ctx2, `SELECT count(*) FROM signage_pairing_requests`).Scan(&rows); err != nil || rows != 1 {
		t.Fatalf("expired row should be gone, rows=%d err=%v", rows, err)
	}
	if _, err := e2.pool.Exec(ctx2, `INSERT INTO signage_pairing_requests (id, code_digest, poll_secret_digest, created_at, expires_at)
		SELECT uuidv7(), sha256(('c' || n)::bytea), sha256(('s' || n)::bytea), now(), now() + interval '10 minutes' FROM generate_series(1, 49) AS n`); err != nil {
		t.Fatal(err)
	}
	e2.expectCode(e2.do(e2.newPlayer(), "", http.MethodPost, "/public/signage/pairing", nil), http.StatusTooManyRequests, "rate_limited")
	_ = ctx
}

func TestSignageDeviceModeIsolation(t *testing.T) {
	e := newSignageEnv(t)
	ctx := testContext(t)
	staff := e.allStaff()
	scene, playlist := e.seedContent("Isolation")
	display, player := e.pair(staff, "Isolated", playlist.ID)
	token := e.deviceToken(player)
	displayID := display["id"].(string)
	_ = scene

	// A signage device reaches the player API and the pairing endpoints, nothing else.
	for _, request := range []struct{ method, path string }{
		{http.MethodGet, "/signage/displays"}, {http.MethodGet, "/auth/me"}, {http.MethodGet, "/permissions"},
		{http.MethodGet, "/public/open-days"}, {http.MethodGet, "/public/config"}, {http.MethodGet, "/managed-devices/self/hardware"},
		{http.MethodGet, "/visitor-enrollment/state"}, {http.MethodPost, "/visitor-enrollment/context"}, {http.MethodGet, "/signage/layouts"},
	} {
		e.expectCode(e.do(player, "", request.method, request.path, nil), http.StatusForbidden, "device_mode_denied")
	}
	e.expectCode(e.do(player, "", http.MethodPost, "/auth/login", map[string]any{"email": "x@example.test", "password": "irrelevant-password"}), http.StatusForbidden, "device_mode_denied")
	e.expectCode(e.do(player, "", http.MethodPost, "/auth/logout", nil), http.StatusForbidden, "device_mode_denied")
	e.expect(e.do(player, "", http.MethodGet, "/public/signage/pairing", nil), http.StatusOK)

	// A staff session on a signage device is refused everywhere outside the player API.
	mixed := e.staff("mixed")
	jarURL, _ := url.Parse(e.server.URL)
	mixed.client.Jar.SetCookies(jarURL, []*http.Cookie{{Name: signageDeviceCookie, Value: token}})
	e.expectCode(e.as(mixed, http.MethodGet, "/signage/displays", nil), http.StatusForbidden, "device_mode_denied")
	e.expectCode(e.as(mixed, http.MethodGet, "/auth/me", nil), http.StatusForbidden, "device_mode_denied")

	// The native header credential works for the player API too.
	native := e.newPlayer()
	e.expect(e.do(native, "", http.MethodGet, "/signage/player/live", nil, "X-Managed-Device-Token", token), http.StatusOK)

	// Player routes never accept a user session: not alone, not with another device mode.
	e.expectCode(e.as(staff, http.MethodGet, "/signage/player/live", nil), http.StatusUnauthorized, "unauthenticated")
	e.expectCode(e.as(staff, http.MethodGet, "/signage/player/manifest", nil), http.StatusUnauthorized, "unauthenticated")
	e.expectCode(e.as(staff, http.MethodPost, "/signage/player/heartbeat", map[string]any{"errors": []string{}}), http.StatusUnauthorized, "unauthenticated")
	e.expectCode(e.do(e.newPlayer(), "", http.MethodGet, "/signage/player/live", nil, "X-Managed-Device-Token", "bogus"), http.StatusUnauthorized, "unauthenticated")
	deviceService := manageddevices.NewService(e.pool)
	deviceType, err := deviceService.CreateType(ctx, e.fixture.admin, "Office tablet", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	office, err := deviceService.Create(ctx, e.fixture.admin, "Office", deviceType.ID, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	e.expectCode(e.do(staff.client, staff.csrf, http.MethodGet, "/signage/player/live", nil, "X-Managed-Device-Token", office.Token), http.StatusForbidden, "device_mode_denied")

	// A signage device without a display answers 404.
	orphanToken, orphanDigest, err := security.NewOpaqueToken()
	if err != nil {
		t.Fatal(err)
	}
	var signageType uuid.UUID
	if err := e.pool.QueryRow(ctx, `SELECT id FROM device_types WHERE name = 'Signage display'`).Scan(&signageType); err != nil {
		t.Fatal(err)
	}
	if _, err := e.pool.Exec(ctx, `INSERT INTO managed_devices (id, name, device_type_id, token_digest, allowed_app_modes) VALUES (uuidv7(), 'Orphan', $1, $2, ARRAY['signage_player'])`, signageType, orphanDigest); err != nil {
		t.Fatal(err)
	}
	e.expectCode(e.do(e.newPlayer(), "", http.MethodGet, "/signage/player/live", nil, "X-Managed-Device-Token", orphanToken), http.StatusNotFound, "not_found")

	// The database refuses a signage player combined with any other mode.
	for _, modes := range []string{"ARRAY['signage_player','staff_ui']", "ARRAY['staff_ui','signage_player']", "ARRAY['visitor_terminal','signage_player']"} {
		if _, err := e.pool.Exec(ctx, `INSERT INTO managed_devices (id, name, device_type_id, token_digest, allowed_app_modes) VALUES (uuidv7(), 'Mixed', $1, sha256(gen_random_uuid()::text::bytea), `+modes+`)`, signageType); err == nil {
			t.Fatalf("modes %s were accepted by the database", modes)
		}
	}

	// Revoking the display revokes the credential at once and blocks every further display change.
	version := e.displayVersion(staff, displayID)
	e.expectCode(e.as(staff, http.MethodDelete, "/signage/displays/"+displayID, map[string]any{"expectedVersion": version}), http.StatusConflict, "signage_display_not_revoked")
	revoked := e.expect(e.as(staff, http.MethodPost, "/signage/displays/"+displayID+"/revoke", map[string]any{"expectedVersion": version}), http.StatusOK)
	if revoked["status"] != "revoked" || revoked["revokedAt"] == nil {
		t.Fatalf("revoked display = %v", revoked)
	}
	e.expectCode(e.do(player, "", http.MethodGet, "/signage/player/live", nil), http.StatusUnauthorized, "unauthenticated")
	e.expectCode(e.do(native, "", http.MethodGet, "/signage/player/manifest", nil, "X-Managed-Device-Token", token), http.StatusUnauthorized, "unauthenticated")
	e.expectCode(e.as(staff, http.MethodPost, "/signage/displays/"+displayID+"/revoke", map[string]any{"expectedVersion": revoked["version"]}), http.StatusConflict, "signage_display_revoked")
	e.expectCode(e.as(staff, http.MethodPost, "/signage/displays/"+displayID+"/publish", nil), http.StatusConflict, "signage_display_revoked")
	if e.countAudit("signage_display.revoked") != 1 || e.countAudit("managed_device.revoked") != 1 {
		t.Fatal("revocation must be audited for the display and its device")
	}
	// Delete removes the display and its managed device.
	e.expect(e.as(staff, http.MethodDelete, "/signage/displays/"+displayID, map[string]any{"expectedVersion": revoked["version"]}), http.StatusNoContent)
	e.expectCode(e.as(staff, http.MethodGet, "/signage/displays/"+displayID, nil), http.StatusNotFound, "not_found")
	var devices int
	if err := e.pool.QueryRow(ctx, `SELECT count(*) FROM managed_devices WHERE id = $1`, display["managedDeviceId"]).Scan(&devices); err != nil || devices != 0 {
		t.Fatalf("managed device should be deleted with its display: %d %v", devices, err)
	}
	if e.countAudit("signage_display.deleted") != 1 || e.countAudit("managed_device.deleted") != 1 {
		t.Fatal("deletion must be audited for the display and its device")
	}

	// Revoking only the managed device through the generic endpoint also cuts the display off.
	second, secondPlayer := e.pair(staff, "Second", playlist.ID)
	devManager := e.staff("devices", authorization.ManagedDevicesRead, authorization.ManagedDevicesManage)
	device := e.expect(e.as(devManager, http.MethodGet, "/managed-devices/"+second["managedDeviceId"].(string), nil), http.StatusOK)
	if modes := device["allowedApplicationModes"].([]any); len(modes) != 1 || modes[0] != "signage_player" {
		t.Fatalf("device modes = %v", modes)
	}
	e.expect(e.as(devManager, http.MethodPost, "/managed-devices/"+second["managedDeviceId"].(string)+"/revoke", map[string]any{"expectedVersion": device["version"]}), http.StatusOK)
	e.expectCode(e.do(secondPlayer, "", http.MethodGet, "/signage/player/live", nil), http.StatusUnauthorized, "unauthenticated")
	view := e.expect(e.as(staff, http.MethodGet, "/signage/displays/"+second["id"].(string), nil), http.StatusOK)
	if view["status"] != "revoked" {
		t.Fatalf("display behind a revoked device must read as revoked: %v", view)
	}
	e.expectCode(e.as(staff, http.MethodPost, "/signage/displays/"+second["id"].(string)+"/publish", nil), http.StatusConflict, "signage_display_revoked")
}

func TestSignagePlayerModeCannotBeCreatedThroughGenericManagedDeviceEndpoints(t *testing.T) {
	e := newSignageEnv(t)
	staff := e.allStaff()
	_, playlist := e.seedContent("Generic")
	display, _ := e.pair(staff, "Generic", playlist.ID)
	manager := e.staff("manager", authorization.ManagedDevicesRead, authorization.ManagedDevicesManage)
	deviceService := manageddevices.NewService(e.pool)
	deviceType, err := deviceService.CreateType(testContext(t), e.fixture.admin, "Generic type", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	create := func(modes ...string) *http.Response {
		return e.as(manager, http.MethodPost, "/managed-devices", map[string]any{
			"name": "Sneaky", "deviceTypeId": deviceType.ID.String(), "expiresAt": nil, "credentialDelivery": "nativeToken", "sessionPolicyId": nil,
			"terminalEnabled": false, "allowedApplicationModes": modes, "checkInAssurance": "low", "checkOutAssurance": "low", "checkoutMode": "verified", "capabilities": []string{},
		})
	}
	e.expectCode(create("signage_player"), http.StatusUnprocessableEntity, "validation_failed")
	e.expectCode(create("signage_player", "staff_ui"), http.StatusUnprocessableEntity, "validation_failed")
	e.expect(create("staff_ui"), http.StatusCreated)

	// A signage device cannot be re-moded, re-keyed or switched to staff use.
	deviceID := display["managedDeviceId"].(string)
	device := e.expect(e.as(manager, http.MethodGet, "/managed-devices/"+deviceID, nil), http.StatusOK)
	update := func(modes ...string) *http.Response {
		return e.as(manager, http.MethodPatch, "/managed-devices/"+deviceID, map[string]any{
			"name": "Renamed", "deviceTypeId": device["deviceTypeId"], "expiresAt": nil, "expectedVersion": device["version"], "sessionPolicyId": nil,
			"terminalEnabled": false, "allowedApplicationModes": modes, "checkInAssurance": "low", "checkOutAssurance": "low", "checkoutMode": "verified", "capabilities": []string{},
		})
	}
	e.expectCode(update("staff_ui"), http.StatusUnprocessableEntity, "validation_failed")
	e.expectCode(update("signage_player"), http.StatusUnprocessableEntity, "validation_failed")
	e.expectCode(e.as(manager, http.MethodPost, "/managed-devices/"+deviceID+"/token", map[string]any{"expiresAt": nil, "expectedVersion": device["version"], "credentialDelivery": "nativeToken"}), http.StatusUnprocessableEntity, "validation_failed")
	// Deleting needs a revoked device, and the display still pins it.
	revoked := e.expect(e.as(manager, http.MethodPost, "/managed-devices/"+deviceID+"/revoke", map[string]any{"expectedVersion": device["version"]}), http.StatusOK)
	e.expectCode(e.as(manager, http.MethodDelete, "/managed-devices/"+deviceID, map[string]any{"expectedVersion": revoked["version"]}), http.StatusConflict, "conflict")
}

func TestSignagePermissionsForDisplayOperations(t *testing.T) {
	e := newSignageEnv(t)
	scene, playlist := e.seedContent("Permissions")
	owner := e.allStaff()
	display, _ := e.pair(owner, "Permissions", playlist.ID)
	displayID := display["id"].(string)
	machine := e.fixture.machine(t, "Permission machine")

	nobody := e.staff("nobody")
	reader := e.staff("reader", authorization.SignageRead)
	manager := e.staff("manager", authorization.SignageManage)
	publisher := e.staff("publisher", authorization.SignagePublish)
	content := e.staff("content", authorization.SignageContentManage, authorization.SignageOverride)
	readManage := e.staff("readmanage", authorization.SignageRead, authorization.SignageManage)

	version := func() int64 { return e.displayVersion(owner, displayID) }
	rule := func() map[string]any {
		return map[string]any{
			"expectedVersion": version(), "enabled": true, "conditionKind": "machine_printing", "machineIds": []string{machine.String()}, "machineMatch": "any",
			"targetKind": "scene", "targetId": scene.ID.String(), "minSeconds": 20, "multiMode": "split", "alternateSeconds": 10,
		}
	}
	settings := func() map[string]any {
		return map[string]any{
			"expectedVersion": version(), "name": "Permissions", "location": "Hall", "orientation": "landscape",
			"resolution": map[string]any{"width": 1920, "height": 1080}, "visibleFromOutside": false, "defaultPlaylistId": playlist.ID.String(),
		}
	}
	pairBody := map[string]any{
		"code": "AAAAAA", "name": "X", "location": "", "orientation": "landscape",
		"resolution": map[string]any{"width": 1920, "height": 1080}, "visibleFromOutside": false, "defaultPlaylistId": playlist.ID.String(),
	}

	// Reads need signage.read.
	for _, request := range []string{"/signage/displays", "/signage/displays/" + displayID, "/signage/displays/" + displayID + "/rules"} {
		for _, denied := range []staffSession{nobody, manager, publisher, content} {
			e.expectCode(e.as(denied, http.MethodGet, request, nil), http.StatusForbidden, "permission_denied")
		}
		e.expect(e.as(reader, http.MethodGet, request, nil), http.StatusOK)
	}

	// Writes need signage.manage; read alone, publish alone and content alone do not suffice.
	writes := []struct {
		name   string
		method string
		path   string
		body   func() map[string]any
		status int
	}{
		{"pair", http.MethodPost, "/signage/displays", func() map[string]any { return pairBody }, http.StatusUnprocessableEntity},
		{"update", http.MethodPut, "/signage/displays/" + displayID, settings, http.StatusOK},
		{"create rule", http.MethodPost, "/signage/displays/" + displayID + "/rules", rule, http.StatusCreated},
	}
	for _, write := range writes {
		for _, denied := range []staffSession{nobody, reader, publisher, content} {
			e.expectCode(e.as(denied, write.method, write.path, write.body()), http.StatusForbidden, "permission_denied")
		}
	}
	for _, write := range writes {
		response := e.as(readManage, write.method, write.path, write.body())
		e.expect(response, write.status)
	}
	rules := e.expect(e.as(readManage, http.MethodGet, "/signage/displays/"+displayID+"/rules", nil), http.StatusOK)
	ruleID := rules["items"].([]any)[0].(map[string]any)["id"].(string)
	rulePath := "/signage/displays/" + displayID + "/rules/" + ruleID
	for _, denied := range []staffSession{nobody, reader, publisher, content} {
		e.expectCode(e.as(denied, http.MethodPut, rulePath, rule()), http.StatusForbidden, "permission_denied")
		e.expectCode(e.as(denied, http.MethodPatch, rulePath, map[string]any{"expectedVersion": version(), "enabled": false}), http.StatusForbidden, "permission_denied")
		e.expectCode(e.as(denied, http.MethodPut, "/signage/displays/"+displayID+"/rule-order", map[string]any{"expectedVersion": version(), "ruleIds": []string{ruleID}}), http.StatusForbidden, "permission_denied")
		e.expectCode(e.as(denied, http.MethodDelete, rulePath, map[string]any{"expectedVersion": version()}), http.StatusForbidden, "permission_denied")
		e.expectCode(e.as(denied, http.MethodPost, "/signage/displays/"+displayID+"/revoke", map[string]any{"expectedVersion": version()}), http.StatusForbidden, "permission_denied")
		e.expectCode(e.as(denied, http.MethodDelete, "/signage/displays/"+displayID, map[string]any{"expectedVersion": version()}), http.StatusForbidden, "permission_denied")
	}
	e.expect(e.as(manager, http.MethodPut, rulePath, rule()), http.StatusOK)
	e.expect(e.as(manager, http.MethodPatch, rulePath, map[string]any{"expectedVersion": version(), "enabled": false}), http.StatusOK)
	e.expect(e.as(manager, http.MethodPut, "/signage/displays/"+displayID+"/rule-order", map[string]any{"expectedVersion": version(), "ruleIds": []string{ruleID}}), http.StatusOK)

	// Publishing needs signage.publish; manage does not imply it and publish does not imply manage.
	for _, denied := range []staffSession{nobody, reader, manager, content, readManage} {
		e.expectCode(e.as(denied, http.MethodPost, "/signage/displays/"+displayID+"/publish", nil), http.StatusForbidden, "permission_denied")
	}
	published := e.expect(e.as(publisher, http.MethodPost, "/signage/displays/"+displayID+"/publish", nil), http.StatusOK)
	if published["publishedRevision"] != float64(1) {
		t.Fatalf("published = %v", published)
	}
	e.expectCode(e.as(publisher, http.MethodPut, "/signage/displays/"+displayID, settings()), http.StatusForbidden, "permission_denied")

	// Deleting a rule, then the display (revoke first), works for the manager.
	e.expect(e.as(manager, http.MethodDelete, rulePath, map[string]any{"expectedVersion": version()}), http.StatusOK)
	revoked := e.expect(e.as(manager, http.MethodPost, "/signage/displays/"+displayID+"/revoke", map[string]any{"expectedVersion": version()}), http.StatusOK)
	e.expect(e.as(manager, http.MethodDelete, "/signage/displays/"+displayID, map[string]any{"expectedVersion": revoked["version"]}), http.StatusNoContent)

	// Unauthenticated callers are refused too.
	e.expectCode(e.do(e.newPlayer(), "", http.MethodGet, "/signage/displays", nil), http.StatusUnauthorized, "unauthenticated")
}

func TestSignageRulesLifecycleValidationAndReferences(t *testing.T) {
	e := newSignageEnv(t)
	ctx := testContext(t)
	staff := e.allStaff()
	scene, playlist := e.seedContent("Rules")
	portrait, err := e.fixture.service.CreateScene(ctx, e.fixture.admin, signage.SceneInput{
		Name: "Portrait scene", Orientation: "portrait", LayoutID: "full", BackgroundColor: "#101820", BackgroundFit: "cover", Theme: "dark",
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	template, err := e.fixture.service.CreateTemplate(ctx, e.fixture.admin, signage.TemplateInput{Name: "Rule template", Tone: "info", Title: "Hello", Body: ""}, nil)
	if err != nil {
		t.Fatal(err)
	}
	machine := e.fixture.machine(t, "Rule machine")
	display, _ := e.pair(staff, "Rules", playlist.ID)
	displayID := display["id"].(string)
	base := "/signage/displays/" + displayID
	body := func(overrides map[string]any) map[string]any {
		value := map[string]any{
			"expectedVersion": e.displayVersion(staff, displayID), "enabled": true, "conditionKind": "live_data_unavailable",
			"targetKind": "scene", "targetId": scene.ID.String(), "minSeconds": 20, "multiMode": "split", "alternateSeconds": 10,
		}
		for key, override := range overrides {
			value[key] = override
		}
		return value
	}
	ruleIDs := func(list map[string]any) []string {
		var ids []string
		for index, item := range list["items"].([]any) {
			rule := item.(map[string]any)
			if int(rule["position"].(float64)) != index {
				t.Fatalf("positions are not contiguous: %v", list["items"])
			}
			ids = append(ids, rule["id"].(string))
		}
		return ids
	}

	list := e.expect(e.as(staff, http.MethodGet, base+"/rules", nil), http.StatusOK)
	if len(list["items"].([]any)) != 0 {
		t.Fatalf("new display has rules: %v", list)
	}
	startVersion := list["displayVersion"].(float64)

	// One rule per condition kind; every write bumps the display version by one.
	created := e.expect(e.as(staff, http.MethodPost, base+"/rules", body(map[string]any{
		"conditionKind": "time_window", "weekdays": []int{5, 1, 1}, "timeFrom": "22:00", "timeTo": "06:00",
	})), http.StatusCreated)
	first := created["items"].([]any)[0].(map[string]any)
	if created["displayVersion"] != startVersion+1 || first["conditionKind"] != "time_window" || first["timeFrom"] != "22:00" || first["machineMatch"] != nil {
		t.Fatalf("created = %v", created)
	}
	if weekdays := first["weekdays"].([]any); len(weekdays) != 2 || weekdays[0] != float64(1) || weekdays[1] != float64(5) {
		t.Fatalf("weekdays = %v", first["weekdays"])
	}
	e.expect(e.as(staff, http.MethodPost, base+"/rules", body(map[string]any{
		"conditionKind": "machine_printing", "machineIds": []string{machine.String()}, "machineMatch": "all", "targetKind": "playlist", "targetId": playlist.ID.String(),
	})), http.StatusCreated)
	e.expect(e.as(staff, http.MethodPost, base+"/rules", body(map[string]any{
		"conditionKind": "announcement_active", "announcementTemplateIds": []string{template.ID.String()},
	})), http.StatusCreated)
	list = e.expect(e.as(staff, http.MethodPost, base+"/rules", body(map[string]any{"enabled": false})), http.StatusCreated)
	ids := ruleIDs(list)
	if len(ids) != 4 || list["displayVersion"] != startVersion+4 {
		t.Fatalf("list = %v", list)
	}

	// Stale display versions conflict.
	e.expectCode(e.as(staff, http.MethodPost, base+"/rules", body(map[string]any{"expectedVersion": startVersion})), http.StatusConflict, "stale_write")

	// Validation: kind-specific fields, references, orientation.
	for name, overrides := range map[string]map[string]any{
		"time window with machines":     {"conditionKind": "time_window", "weekdays": []int{1}, "timeFrom": "08:00", "timeTo": "09:00", "machineIds": []string{machine.String()}},
		"time window without weekdays":  {"conditionKind": "time_window", "timeFrom": "08:00", "timeTo": "09:00"},
		"time window equal bounds":      {"conditionKind": "time_window", "weekdays": []int{1}, "timeFrom": "08:00", "timeTo": "08:00"},
		"machine rule without match":    {"conditionKind": "machine_printing", "machineIds": []string{machine.String()}},
		"machine rule without machines": {"conditionKind": "machine_printing", "machineMatch": "any"},
		"unknown machine":               {"conditionKind": "machine_printing", "machineMatch": "any", "machineIds": []string{uuid.Must(uuid.NewV7()).String()}},
		"unknown template":              {"conditionKind": "announcement_active", "announcementTemplateIds": []string{uuid.Must(uuid.NewV7()).String()}},
		"live rule with weekdays":       {"weekdays": []int{1}},
		"unknown scene":                 {"targetId": uuid.Must(uuid.NewV7()).String()},
		"unknown playlist":              {"targetKind": "playlist", "targetId": uuid.Must(uuid.NewV7()).String()},
		"scene of another orientation":  {"targetId": portrait.ID.String()},
	} {
		response := e.as(staff, http.MethodPost, base+"/rules", body(overrides))
		if response.StatusCode != http.StatusUnprocessableEntity {
			t.Errorf("%s: status = %d, want 422", name, response.StatusCode)
		}
		response.Body.Close()
	}
	for name, overrides := range map[string]map[string]any{
		"clock out of range":   {"conditionKind": "time_window", "weekdays": []int{1}, "timeFrom": "24:00", "timeTo": "09:00"},
		"weekday out of range": {"conditionKind": "time_window", "weekdays": []int{8}, "timeFrom": "08:00", "timeTo": "09:00"},
		"minimum too long":     {"minSeconds": 601},
	} {
		response := e.as(staff, http.MethodPost, base+"/rules", body(overrides))
		if response.StatusCode != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400", name, response.StatusCode)
		}
		response.Body.Close()
	}
	// A playlist may hold scenes of any orientation.
	playlistWithPortrait := e.fixture.playlist(t, "Mixed", portrait.ID)
	e.expect(e.as(staff, http.MethodPost, base+"/rules", body(map[string]any{"targetKind": "playlist", "targetId": playlistWithPortrait.ID.String()})), http.StatusCreated)
	list = e.expect(e.as(staff, http.MethodGet, base+"/rules", nil), http.StatusOK)
	ids = ruleIDs(list)
	e.expect(e.as(staff, http.MethodDelete, base+"/rules/"+ids[4], map[string]any{"expectedVersion": list["displayVersion"]}), http.StatusOK)

	// Update and enable toggle.
	updated := e.expect(e.as(staff, http.MethodPut, base+"/rules/"+ids[3], body(map[string]any{"enabled": true, "minSeconds": 45})), http.StatusOK)
	if rule := updated["items"].([]any)[3].(map[string]any); rule["enabled"] != true || rule["minSeconds"] != float64(45) {
		t.Fatalf("updated rule = %v", rule)
	}
	toggled := e.expect(e.as(staff, http.MethodPatch, base+"/rules/"+ids[3], map[string]any{"expectedVersion": updated["displayVersion"], "enabled": false}), http.StatusOK)
	if toggled["items"].([]any)[3].(map[string]any)["enabled"] != false {
		t.Fatalf("toggle = %v", toggled)
	}
	e.expectCode(e.as(staff, http.MethodPut, base+"/rules/"+uuid.Must(uuid.NewV7()).String(), body(nil)), http.StatusNotFound, "not_found")
	e.expectCode(e.as(staff, http.MethodGet, "/signage/displays/"+uuid.Must(uuid.NewV7()).String()+"/rules", nil), http.StatusNotFound, "not_found")

	// Reorder is atomic: a bad set changes nothing, a good one applies completely and bumps the version once.
	before := e.displayVersion(staff, displayID)
	for name, candidate := range map[string][]string{
		"missing":   {ids[0], ids[1], ids[2]},
		"duplicate": {ids[0], ids[0], ids[1], ids[2]},
		"foreign":   {ids[0], ids[1], ids[2], uuid.Must(uuid.NewV7()).String()},
	} {
		response := e.as(staff, http.MethodPut, base+"/rule-order", map[string]any{"expectedVersion": before, "ruleIds": candidate})
		if response.StatusCode != http.StatusUnprocessableEntity {
			t.Errorf("reorder %s: status = %d, want 422", name, response.StatusCode)
		}
		response.Body.Close()
	}
	if after := e.displayVersion(staff, displayID); after != before {
		t.Fatalf("failed reorders changed the version %d -> %d", before, after)
	}
	reordered := e.expect(e.as(staff, http.MethodPut, base+"/rule-order", map[string]any{"expectedVersion": before, "ruleIds": []string{ids[3], ids[2], ids[1], ids[0]}}), http.StatusOK)
	newOrder := ruleIDs(reordered)
	if newOrder[0] != ids[3] || newOrder[3] != ids[0] || reordered["displayVersion"] != float64(before+1) {
		t.Fatalf("reordered = %v", reordered)
	}
	e.expectCode(e.as(staff, http.MethodPut, base+"/rule-order", map[string]any{"expectedVersion": before, "ruleIds": newOrder}), http.StatusConflict, "stale_write")

	// Delete closes the gap.
	afterDelete := e.expect(e.as(staff, http.MethodDelete, base+"/rules/"+newOrder[1], map[string]any{"expectedVersion": reordered["displayVersion"]}), http.StatusOK)
	if remaining := ruleIDs(afterDelete); len(remaining) != 3 || remaining[0] != newOrder[0] || remaining[1] != newOrder[2] || remaining[2] != newOrder[3] {
		t.Fatalf("after delete = %v", afterDelete)
	}

	// Drafts that rules point at cannot be deleted; settings cannot strand rules on another orientation.
	expectInUse(t, e.fixture.service.DeleteScene(ctx, e.fixture.admin, scene.ID, scene.Version, nil), "playlist", "display_rule", "display_rule")
	expectInUse(t, e.fixture.service.DeletePlaylist(ctx, e.fixture.admin, playlist.ID, playlist.Version, nil), "display_default", "display_rule")
	settings := map[string]any{
		"expectedVersion": e.displayVersion(staff, displayID), "name": "Rules", "location": "", "orientation": "portrait",
		"resolution": map[string]any{"width": 1080, "height": 1920}, "visibleFromOutside": false, "defaultPlaylistId": playlist.ID.String(),
	}
	e.expectCode(e.as(staff, http.MethodPut, base, settings), http.StatusUnprocessableEntity, "validation_failed")
	settings["defaultPlaylistId"] = uuid.Must(uuid.NewV7()).String()
	settings["orientation"] = "landscape"
	e.expectCode(e.as(staff, http.MethodPut, base, settings), http.StatusUnprocessableEntity, "validation_failed")

	for action, want := range map[string]int{"signage_rule.created": 5, "signage_rule.updated": 2, "signage_rule.deleted": 2, "signage_display.rules_reordered": 1} {
		if got := e.countAudit(action); got != want {
			t.Errorf("audit %s = %d, want %d", action, got, want)
		}
	}
}

func (e *signageEnv) rawGet(client *http.Client, path string, headers ...string) (*http.Response, []byte) {
	e.t.Helper()
	response := e.do(client, "", http.MethodGet, path, nil, headers...)
	body, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil {
		e.t.Fatal(err)
	}
	return response, body
}

func pendingSet(display map[string]any) map[string]bool {
	result := map[string]bool{}
	for _, item := range display["pendingChanges"].([]any) {
		change := item.(map[string]any)
		result[change["kind"].(string)+"|"+change["name"].(string)+"|"+change["change"].(string)] = true
	}
	return result
}

func TestSignagePublishManifestPendingChangesAssetsAndPruning(t *testing.T) {
	e := newSignageEnv(t)
	ctx := testContext(t)
	staff := e.allStaff()
	svc, admin := e.fixture.service, e.fixture.admin

	image := e.fixture.uploadImage(t, "poster.jpg")
	imageBytes := signageJPEG(t, 64, 48)
	width, height := 640, 360
	videoBytes := signageMP4(5000)
	video, err := svc.UploadAsset(ctx, admin, signage.UploadInput{Name: "clip.mp4", ContentType: "video/mp4", Width: &width, Height: &height, Body: bytes.NewReader(videoBytes)}, nil)
	if err != nil {
		t.Fatal(err)
	}
	unused := e.fixture.uploadImage(t, "unused.jpg")
	mkScene := func(name, widget string) signage.Scene {
		input := sceneInput(name, "full")
		input.Zones = map[string]json.RawMessage{"main": json.RawMessage(widget)}
		scene, err := svc.CreateScene(ctx, admin, input, nil)
		if err != nil {
			t.Fatal(err)
		}
		return scene
	}
	sceneA := mkScene("Scene A", `{"type":"image","mediaId":"`+image.ID.String()+`","fit":"cover"}`)
	sceneB := mkScene("Scene B", `{"type":"video","mediaId":"`+video.ID.String()+`","fit":"contain"}`)
	sceneC := mkScene("Scene C", `{"type":"empty"}`)
	playlist := e.fixture.playlist(t, "Default", sceneA.ID)

	display, player := e.pair(staff, "Publisher", playlist.ID)
	displayID := display["id"].(string)
	base := "/signage/displays/" + displayID
	addRule := func(enabled bool, scene signage.Scene) {
		e.expect(e.as(staff, http.MethodPost, base+"/rules", map[string]any{
			"expectedVersion": e.displayVersion(staff, displayID), "enabled": enabled, "conditionKind": "live_data_unavailable",
			"targetKind": "scene", "targetId": scene.ID.String(), "minSeconds": 20, "multiMode": "split", "alternateSeconds": 10,
		}), http.StatusCreated)
	}
	addRule(true, sceneB)
	addRule(false, sceneC)

	// Nothing published yet.
	if pending := e.expect(e.as(staff, http.MethodGet, base, nil), http.StatusOK); len(pending["pendingChanges"].([]any)) != 0 || pending["publishedRevision"] != nil {
		t.Fatalf("unpublished display = %v", pending)
	}
	e.expectCode(e.do(player, "", http.MethodGet, "/signage/player/manifest", nil), http.StatusNotFound, "signage_not_published")
	assetPath := func(a signage.Asset) string { return "/signage/player/assets/" + a.ID.String() + "/" + a.SHA256 }
	e.expectCode(e.do(player, "", http.MethodGet, assetPath(image), nil), http.StatusNotFound, "not_found")

	published := e.expect(e.as(staff, http.MethodPost, base+"/publish", nil), http.StatusOK)
	if published["publishedRevision"] != float64(1) || published["publishedAt"] == nil || len(published["pendingChanges"].([]any)) != 0 {
		t.Fatalf("published = %v", published)
	}

	// The manifest holds exactly what the display reaches.
	response := e.do(player, "", http.MethodGet, "/signage/player/manifest", nil)
	if response.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("manifest Cache-Control = %q", response.Header.Get("Cache-Control"))
	}
	envelope := e.expect(response, http.StatusOK)
	manifest := envelope["manifest"].(map[string]any)
	if envelope["unchanged"] != false || manifest["revision"] != float64(1) || manifest["layoutsVersion"] != float64(1) || manifest["defaultPlaylistId"] != playlist.ID.String() {
		t.Fatalf("manifest = %v", manifest)
	}
	if len(manifest["rules"].([]any)) != 1 || len(manifest["scenes"].([]any)) != 2 || len(manifest["playlists"].([]any)) != 1 || len(manifest["assets"].([]any)) != 2 {
		t.Fatalf("manifest content rules=%d scenes=%d playlists=%d assets=%d", len(manifest["rules"].([]any)), len(manifest["scenes"].([]any)), len(manifest["playlists"].([]any)), len(manifest["assets"].([]any)))
	}
	if d := manifest["display"].(map[string]any); d["orientation"] != "landscape" || d["resolution"].(map[string]any)["width"] != float64(1920) {
		t.Fatalf("manifest display = %v", d)
	}
	digest := sha256.Sum256(imageBytes)
	for _, raw := range manifest["assets"].([]any) {
		asset := raw.(map[string]any)
		if asset["id"] == image.ID.String() && (asset["sha256"] != hex.EncodeToString(digest[:]) || asset["url"] != "/api/v1"+assetPath(image) || asset["kind"] != "image") {
			t.Fatalf("image asset = %v", asset)
		}
		if asset["id"] == unused.ID.String() {
			t.Fatal("an unreferenced asset was published")
		}
	}
	unchanged := e.expect(e.do(player, "", http.MethodGet, "/signage/player/manifest?known=1", nil), http.StatusOK)
	if unchanged["unchanged"] != true || unchanged["manifest"] != nil {
		t.Fatalf("known=1 = %v", unchanged)
	}
	if again := e.expect(e.do(player, "", http.MethodGet, "/signage/player/manifest?known=0", nil), http.StatusOK); again["unchanged"] != false {
		t.Fatalf("known=0 = %v", again)
	}

	// Asset delivery: content addressed, immutable, only for published assets.
	response, body := e.rawGet(player, assetPath(image))
	if response.StatusCode != http.StatusOK || !bytes.Equal(body, imageBytes) || response.Header.Get("Content-Type") != "image/jpeg" ||
		response.Header.Get("Cache-Control") != "private, max-age=31536000, immutable" || response.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("image response status=%d headers=%v", response.StatusCode, response.Header)
	}
	response, body = e.rawGet(player, assetPath(video), "Range", "bytes=10-19")
	if response.StatusCode != http.StatusPartialContent || !bytes.Equal(body, videoBytes[10:20]) || response.Header.Get("Content-Range") != "bytes 10-19/5000" || response.Header.Get("Content-Type") != "video/mp4" {
		t.Fatalf("range response status=%d headers=%v len=%d", response.StatusCode, response.Header, len(body))
	}
	wrongSum := signage.Asset{ID: image.ID, SHA256: strings.Repeat("0", 64)}
	e.expectCode(e.do(player, "", http.MethodGet, assetPath(wrongSum), nil), http.StatusNotFound, "not_found")
	e.expectCode(e.do(player, "", http.MethodGet, assetPath(unused), nil), http.StatusNotFound, "not_found")
	e.expectCode(e.do(player, "", http.MethodGet, assetPath(signage.Asset{ID: uuid.Must(uuid.NewV7()), SHA256: image.SHA256}), nil), http.StatusNotFound, "not_found")
	e.expectCode(e.as(staff, http.MethodGet, assetPath(image), nil), http.StatusUnauthorized, "unauthenticated")
	// Another display never gets this display's assets.
	_, otherPlayer := e.pair(staff, "Other", e.fixture.playlist(t, "Other", sceneC.ID).ID)
	e.expectCode(e.do(otherPlayer, "", http.MethodGet, assetPath(image), nil), http.StatusNotFound, "not_found")
	e.expectCode(e.do(otherPlayer, "", http.MethodPost, "/signage/displays/"+displayID+"/publish", nil), http.StatusForbidden, "device_mode_denied")

	// Pending changes compare drafts with the latest publication by id and version.
	renamed := sceneA
	input := sceneInput("Scene A renamed", "full")
	input.Zones = map[string]json.RawMessage{"main": json.RawMessage(`{"type":"empty"}`)}
	if renamed, err = svc.UpdateScene(ctx, admin, sceneA.ID, sceneA.Version, input, nil); err != nil {
		t.Fatal(err)
	}
	_ = renamed
	addRule(true, sceneC)
	view := e.expect(e.as(staff, http.MethodGet, base, nil), http.StatusOK)
	pending := pendingSet(view)
	if !pending["scene|Scene A renamed|modified"] || !pending["rule|Rule 2 (live_data_unavailable)|added"] {
		t.Fatalf("pending = %v", pending)
	}
	list := e.expect(e.as(staff, http.MethodGet, base+"/rules", nil), http.StatusOK)
	first := list["items"].([]any)[0].(map[string]any)["id"].(string)
	e.expect(e.as(staff, http.MethodPatch, base+"/rules/"+first, map[string]any{"expectedVersion": list["displayVersion"], "enabled": false}), http.StatusOK)
	if pending = pendingSet(e.expect(e.as(staff, http.MethodGet, base, nil), http.StatusOK)); !pending["rule|Rule 1 (live_data_unavailable)|removed"] {
		t.Fatalf("pending after disabling = %v", pending)
	}
	// The list endpoint reports the same pending changes.
	listed := e.expect(e.as(staff, http.MethodGet, "/signage/displays", nil), http.StatusOK)["items"].([]any)
	if len(listed) != 2 {
		t.Fatalf("displays = %d", len(listed))
	}

	// Publishing again clears them; the image is no longer reachable so its URL stops working.
	second := e.expect(e.as(staff, http.MethodPost, base+"/publish", nil), http.StatusOK)
	if second["publishedRevision"] != float64(2) || len(second["pendingChanges"].([]any)) != 0 {
		t.Fatalf("second publication = %v", second)
	}
	e.expectCode(e.do(player, "", http.MethodGet, assetPath(image), nil), http.StatusNotFound, "not_found")
	if latest := e.expect(e.do(player, "", http.MethodGet, "/signage/player/manifest?known=1", nil), http.StatusOK); latest["unchanged"] != false || latest["manifest"].(map[string]any)["revision"] != float64(2) {
		t.Fatalf("latest = %v", latest)
	}
	// Scene B is now referenced only by the older publication, so it may be deleted (players keep their cache).
	if err := svc.DeleteScene(ctx, admin, sceneB.ID, sceneB.Version, nil); err == nil {
		t.Fatal("scene B is still used by the disabled-again rule? expected in-use while the draft rule exists")
	}

	// Pruning keeps the latest five revisions.
	for i := 0; i < 5; i++ {
		e.expect(e.as(staff, http.MethodPost, base+"/publish", nil), http.StatusOK)
	}
	var count, oldest, newest int
	if err := e.pool.QueryRow(ctx, `SELECT count(*), min(revision), max(revision) FROM signage_publications WHERE display_id = $1`, displayID).Scan(&count, &oldest, &newest); err != nil {
		t.Fatal(err)
	}
	if count != 5 || oldest != 3 || newest != 7 {
		t.Fatalf("publications: count=%d oldest=%d newest=%d, want 5/3/7", count, oldest, newest)
	}
	if got := e.countAudit("signage_display.published"); got != 7 {
		t.Fatalf("publish audit events = %d, want 7", got)
	}
	e.expectCode(e.as(staff, http.MethodPost, "/signage/displays/"+uuid.Must(uuid.NewV7()).String()+"/publish", nil), http.StatusNotFound, "not_found")
}

type signagePrinter struct {
	machineID uuid.UUID
	report    func(state string, observedAt time.Time)
}

func (e *signageEnv) printer(name string) signagePrinter {
	e.t.Helper()
	ctx := testContext(e.t)
	admin := e.fixture.admin
	logbook := machinelogbook.NewService(e.pool)
	printingService := printing.NewService(e.pool)
	connectors, err := printerconnectors.NewService(e.pool, printingService, nil)
	if err != nil {
		e.t.Fatal(err)
	}
	requestID := uuid.Must(uuid.NewV7())
	machineType, err := logbook.CreateMachineType(ctx, admin, name+" type", "fdm_printing", &requestID)
	if err != nil {
		e.t.Fatal(err)
	}
	machine, err := logbook.CreateMachine(ctx, admin, machineType.ID, name, "active", nil, false, &requestID)
	if err != nil {
		e.t.Fatal(err)
	}
	if _, err = printingService.ConfigureProfile(ctx, admin, machine.ID, true, 0, &requestID); err != nil {
		e.t.Fatal(err)
	}
	connector, err := connectors.Create(ctx, admin, name+" connector", nil, &requestID)
	if err != nil {
		e.t.Fatal(err)
	}
	issue, err := connectors.IssueEnrollment(ctx, admin, connector.ID, &requestID)
	if err != nil {
		e.t.Fatal(err)
	}
	secret, _, err := security.NewOpaqueToken()
	if err != nil {
		e.t.Fatal(err)
	}
	if _, err = connectors.Enroll(ctx, issue.Secret, uuid.Must(uuid.NewV7()), secret, "test", 1); err != nil {
		e.t.Fatal(err)
	}
	if _, err := connectors.Authenticate(ctx, secret); err != nil {
		e.t.Fatalf("authenticate connector: %v", err)
	}
	// CreateAssignment binds a jsonb setting as bytes, which the simple-protocol test pool cannot encode.
	assignment := struct {
		ID                   uuid.UUID
		ConfigurationVersion int64
	}{ID: uuid.Must(uuid.NewV7()), ConfigurationVersion: 1}
	if _, err = e.pool.Exec(ctx, `INSERT INTO printer_connector_assignments (id, connector_id, machine_id, adapter_kind) VALUES ($1, $2, $3, 'simulator')`, assignment.ID, connector.ID, machine.ID); err != nil {
		e.t.Fatal(err)
	}
	return signagePrinter{machineID: machine.ID, report: func(state string, observedAt time.Time) {
		snapshot := `{"state":"` + state + `","job":{"fileName":"customer-secret.3mf","progressPercent":42,"layer":3,"totalLayers":10,"remainingMinutes":17},"temperatures":{"extruders":[],"bedC":null,"bedTargetC":null,"chamberC":null},"nozzles":[],"units":[],"activeTray":null,"errors":[],"firmwareVersion":null,"wifiSignalDbm":-39}`
		// ReportLiveStatus binds the jsonb snapshot as bytes, which the simple-protocol test pool cannot encode; write the row directly.
		if _, err := e.pool.Exec(ctx, `INSERT INTO printer_live_statuses (assignment_id, machine_id, observed_at, received_at, configuration_version, snapshot)
			VALUES ($1, $2, $3, now(), $4, $5::text::jsonb)
			ON CONFLICT (assignment_id) DO UPDATE SET observed_at = EXCLUDED.observed_at, received_at = EXCLUDED.received_at, snapshot = EXCLUDED.snapshot`,
			assignment.ID, machine.ID, observedAt, assignment.ConfigurationVersion, snapshot); err != nil {
			e.t.Fatal(err)
		}
	}}
}

func TestSignagePlayerLiveHeartbeatAndOnlineStatus(t *testing.T) {
	e := newSignageEnv(t)
	ctx := testContext(t)
	staff := e.allStaff()
	svc, admin := e.fixture.service, e.fixture.admin
	watched, unwatched := e.printer("Watched printer"), e.printer("Other printer")
	watched.report("printing", time.Now().UTC())
	unwatched.report("printing", time.Now().UTC())

	input := sceneInput("Status scene", "full")
	input.Zones = map[string]json.RawMessage{"main": json.RawMessage(`{"type":"status","machineIds":["` + watched.machineID.String() + `"],"showProgress":true,"showRemaining":true}`)}
	scene, err := svc.CreateScene(ctx, admin, input, nil)
	if err != nil {
		t.Fatal(err)
	}
	playlist := e.fixture.playlist(t, "Live", scene.ID)
	display, player := e.pair(staff, "Live display", playlist.ID)
	displayID := display["id"].(string)
	otherDisplay, _ := e.pair(staff, "Other display", playlist.ID)
	e.expect(e.as(staff, http.MethodPost, "/signage/displays/"+displayID+"/publish", nil), http.StatusOK)

	template, err := svc.CreateTemplate(ctx, admin, signage.TemplateInput{Name: "Notice", Tone: "warning", Title: "Welcome to {display}", Body: "Find us at {location}"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	start := func(all bool, displays ...string) signage.Announcement {
		ids := []uuid.UUID{}
		for _, id := range displays {
			ids = append(ids, uuid.MustParse(id))
		}
		announcement, err := svc.StartAnnouncement(ctx, admin, signage.AnnouncementInput{TemplateID: template.ID, AllDisplays: all, DisplayIDs: ids}, nil)
		if err != nil {
			t.Fatal(err)
		}
		return announcement
	}
	everyone := start(true)
	targeted := start(false, displayID)
	start(false, otherDisplay["id"].(string))
	future := time.Now().UTC().Add(2 * time.Hour)
	if _, err := svc.StartAnnouncement(ctx, admin, signage.AnnouncementInput{TemplateID: template.ID, AllDisplays: true, StartsAt: &future}, nil); err != nil {
		t.Fatal(err)
	}
	ended := start(true)
	if _, err := e.pool.Exec(ctx, `UPDATE signage_announcements SET starts_at = now() - interval '2 hours', ends_at = now() - interval '1 minute' WHERE id = $1`, ended.ID); err != nil {
		t.Fatal(err)
	}

	// Open days and events: only what is already public.
	if _, err := e.pool.Exec(ctx, `
		INSERT INTO open_day_periods (id, name, starts_on, ends_on, status) VALUES
		  ('01a00000-0000-7000-8000-000000000001', 'Published', current_date, current_date + 30, 'published'),
		  ('01a00000-0000-7000-8000-000000000002', 'Draft', current_date, current_date + 30, 'draft');
		INSERT INTO open_days (id, period_id, starts_at, ends_at, status, internal_note) VALUES
		  (uuidv7(), '01a00000-0000-7000-8000-000000000001', now() - interval '3 days', now() - interval '3 days' + interval '2 hours', 'scheduled', 'past'),
		  (uuidv7(), '01a00000-0000-7000-8000-000000000001', now() + interval '3 days', now() + interval '3 days 2 hours', 'scheduled', 'secret note'),
		  (uuidv7(), '01a00000-0000-7000-8000-000000000001', now() + interval '1 day', now() + interval '1 day 2 hours', 'scheduled', NULL),
		  (uuidv7(), '01a00000-0000-7000-8000-000000000002', now() + interval '2 days', now() + interval '2 days 2 hours', 'scheduled', NULL);
		INSERT INTO events (id, name, internal_description, location, status, public_title, public_location, public_id, is_public) VALUES
		  ('01a00000-0000-7000-8000-0000000000e1', 'Internal name', 'internal text', 'Internal room', 'confirmed', 'Public Workshop', 'Workshop floor', repeat('a', 43), true),
		  ('01a00000-0000-7000-8000-0000000000e2', 'Hidden', 'x', NULL, 'confirmed', 'Hidden event', NULL, repeat('b', 43), false),
		  ('01a00000-0000-7000-8000-0000000000e3', 'Closed', 'x', NULL, 'draft', 'Draft event', NULL, repeat('c', 43), true);
		INSERT INTO event_sessions (id, event_id, name, location, starts_at, ends_at, is_public, status) VALUES
		  (uuidv7(), '01a00000-0000-7000-8000-0000000000e1', 'Session', NULL, now() + interval '2 days', now() + interval '2 days 2 hours', true, 'scheduled'),
		  (uuidv7(), '01a00000-0000-7000-8000-0000000000e1', 'Later', NULL, now() + interval '5 days', now() + interval '5 days 2 hours', true, 'scheduled'),
		  (uuidv7(), '01a00000-0000-7000-8000-0000000000e2', 'Session', NULL, now() + interval '2 days', now() + interval '2 days 2 hours', true, 'scheduled'),
		  (uuidv7(), '01a00000-0000-7000-8000-0000000000e3', 'Session', NULL, now() + interval '2 days', now() + interval '2 days 2 hours', true, 'scheduled')`); err != nil {
		t.Fatal(err)
	}

	response := e.do(player, "", http.MethodGet, "/signage/player/live", nil)
	if response.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("live Cache-Control = %q", response.Header.Get("Cache-Control"))
	}
	raw, _ := io.ReadAll(response.Body)
	response.Body.Close()
	for _, leaked := range []string{"customer-secret", "secret note", "internal text", "Internal room", "Internal name", "example.test"} {
		if strings.Contains(string(raw), leaked) {
			t.Fatalf("live response leaks %q: %s", leaked, raw)
		}
	}
	var live map[string]any
	if err := json.Unmarshal(raw, &live); err != nil {
		t.Fatal(err)
	}
	if len(live) != 7 || live["revision"] != float64(1) || len(live["streams"].([]any)) != 0 || live["serverTime"] == nil {
		t.Fatalf("live = %v", live)
	}
	machines := live["machines"].([]any)
	if len(machines) != 1 {
		t.Fatalf("machines = %v (only the machine on the published scene belongs here)", machines)
	}
	machine := machines[0].(map[string]any)
	if machine["machineId"] != watched.machineID.String() || machine["state"] != "printing" || machine["progressPercent"] != float64(42) || machine["remainingMinutes"] != float64(17) || machine["stale"] != false || machine["name"] != "Watched printer" {
		t.Fatalf("machine = %v", machine)
	}
	announcements := live["announcements"].([]any)
	if len(announcements) != 2 {
		t.Fatalf("announcements = %v, want the all-displays one and the targeted one", announcements)
	}
	got := map[string]map[string]any{}
	for _, item := range announcements {
		entry := item.(map[string]any)
		got[entry["id"].(string)] = entry
	}
	for _, id := range []uuid.UUID{everyone.ID, targeted.ID} {
		entry := got[id.String()]
		if entry == nil || entry["title"] != "Welcome to Live display" || entry["body"] != "Find us at Entrance hall" || entry["tone"] != "warning" || entry["templateId"] != template.ID.String() {
			t.Fatalf("announcement %s = %v", id, entry)
		}
	}
	openDays := live["openDays"].([]any)
	if len(openDays) != 2 || openDays[0].(map[string]any)["startsAt"].(string) >= openDays[1].(map[string]any)["startsAt"].(string) {
		t.Fatalf("openDays = %v (published period only, upcoming only, ascending)", openDays)
	}
	events := live["events"].([]any)
	if len(events) != 1 {
		t.Fatalf("events = %v", events)
	}
	if entry := events[0].(map[string]any); len(entry) != 3 || entry["title"] != "Public Workshop" || entry["location"] != "Workshop floor" {
		t.Fatalf("event = %v", entry)
	}

	// Machine status goes stale after three minutes.
	if _, err := e.pool.Exec(ctx, `UPDATE printer_live_statuses SET received_at = now() - interval '4 minutes'`); err != nil {
		t.Fatal(err)
	}
	live = e.expect(e.do(player, "", http.MethodGet, "/signage/player/live", nil), http.StatusOK)
	if machine = live["machines"].([]any)[0].(map[string]any); machine["state"] != "unknown" || machine["stale"] != true || machine["progressPercent"] != nil || machine["observedAt"] == nil {
		t.Fatalf("stale machine = %v", machine)
	}

	// Heartbeat: validated, upserted, not audited, and it drives online/offline.
	auditBefore := 0
	if err := e.pool.QueryRow(ctx, `SELECT count(*) FROM audit_events`).Scan(&auditBefore); err != nil {
		t.Fatal(err)
	}
	heartbeat := map[string]any{
		"revision": 1, "currentRule": "default", "currentSceneId": scene.ID.String(), "playerVersion": "1.2.3",
		"cacheUsedBytes": 1000, "cacheQuotaBytes": 5000, "errors": []string{"asset failed"},
	}
	response = e.do(player, "", http.MethodPost, "/signage/player/heartbeat", heartbeat)
	if response.StatusCode != http.StatusNoContent || response.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("heartbeat status=%d cache=%q", response.StatusCode, response.Header.Get("Cache-Control"))
	}
	response.Body.Close()
	var auditAfter int
	if err := e.pool.QueryRow(ctx, `SELECT count(*) FROM audit_events`).Scan(&auditAfter); err != nil || auditAfter != auditBefore {
		t.Fatalf("heartbeat must not be audited: %d -> %d (%v)", auditBefore, auditAfter, err)
	}
	view := e.expect(e.as(staff, http.MethodGet, "/signage/displays/"+displayID, nil), http.StatusOK)
	if view["status"] != "online" || view["reportedRevision"] != float64(1) || view["currentRule"] != "default" || view["currentSceneId"] != scene.ID.String() ||
		view["playerVersion"] != "1.2.3" || view["cacheUsedBytes"] != float64(1000) || view["cacheQuotaBytes"] != float64(5000) || view["errors"].([]any)[0] != "asset failed" {
		t.Fatalf("display after heartbeat = %v", view)
	}
	status := func(age string) any {
		if _, err := e.pool.Exec(ctx, `UPDATE signage_display_states SET last_heartbeat_at = now() - interval '`+age+`' WHERE display_id = $1`, displayID); err != nil {
			t.Fatal(err)
		}
		return e.expect(e.as(staff, http.MethodGet, "/signage/displays/"+displayID, nil), http.StatusOK)["status"]
	}
	if status("80 seconds") != "online" || status("100 seconds") != "offline" {
		t.Fatal("online/offline must switch at 90 seconds")
	}
	// A repeated heartbeat replaces the state (single row).
	e.expect(e.do(player, "", http.MethodPost, "/signage/player/heartbeat", map[string]any{"errors": []string{}}), http.StatusNoContent)
	var rows int
	if err := e.pool.QueryRow(ctx, `SELECT count(*) FROM signage_display_states WHERE display_id = $1 AND current_rule IS NULL AND errors = '[]'::jsonb`, displayID).Scan(&rows); err != nil || rows != 1 {
		t.Fatalf("state rows = %d (%v)", rows, err)
	}
	e.expectCode(e.as(staff, http.MethodPost, "/signage/player/heartbeat", heartbeat), http.StatusUnauthorized, "unauthenticated")

	tooMany := make([]string, 21)
	for index := range tooMany {
		tooMany[index] = "x"
	}
	for name, bad := range map[string]map[string]any{
		"too many errors": {"errors": tooMany}, "long error": {"errors": []string{strings.Repeat("x", 201)}}, "revision zero": {"revision": 0, "errors": []string{}},
		"negative cache": {"cacheUsedBytes": -1, "errors": []string{}}, "long version": {"playerVersion": strings.Repeat("v", 65), "errors": []string{}},
		"unknown field": {"errors": []string{}, "extra": 1}, "missing errors": {"revision": 1},
	} {
		response := e.do(player, "", http.MethodPost, "/signage/player/heartbeat", bad)
		if response.StatusCode != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400", name, response.StatusCode)
		}
		response.Body.Close()
	}
	for name, bad := range map[string]map[string]any{
		"control character": {"errors": []string{"a\nb"}}, "rule with space": {"currentRule": "a b", "errors": []string{}},
	} {
		response := e.do(player, "", http.MethodPost, "/signage/player/heartbeat", bad)
		if response.StatusCode != http.StatusUnprocessableEntity {
			t.Errorf("%s: status = %d, want 422", name, response.StatusCode)
		}
		response.Body.Close()
	}
}
