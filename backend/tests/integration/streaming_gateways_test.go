package integration_test

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printerconnectors"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printing"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/signage"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/streaminggateways"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/streamticket"
	"github.com/google/uuid"
)

var gatewayTestKey = []byte("0123456789abcdef0123456789abcdef")

type gatewayEnv struct {
	*signageEnv
	admin   staffSession
	keyring *security.Keyring
	plain   *http.Client
}

func newGatewayEnv(t *testing.T) *gatewayEnv {
	t.Helper()
	e := newSignageEnvWith(t, func(cfg *config.Config) { cfg.EncryptionKeys = [][]byte{gatewayTestKey} })
	keyring, err := security.NewKeyring([][]byte{gatewayTestKey})
	if err != nil {
		t.Fatal(err)
	}
	return &gatewayEnv{
		signageEnv: e,
		admin:      e.staff("lsm-"+uuid.NewString()[:8], authorization.LocalServicesManage),
		keyring:    keyring,
		plain:      &http.Client{},
	}
}

// bambu creates a machine with an active Bambu printer assignment whose LAN access code is stored
// encrypted exactly like the printer setup does.
func (g *gatewayEnv) bambu(name, kind, ip, code string) uuid.UUID {
	g.t.Helper()
	ctx := testContext(g.t)
	admin := g.fixture.admin
	requestID := ids.New()
	logbook := machinelogbook.NewService(g.pool)
	printingService := printing.NewService(g.pool)
	connectors, err := printerconnectors.NewService(g.pool, printingService, nil)
	if err != nil {
		g.t.Fatal(err)
	}
	machineType, err := logbook.CreateMachineType(ctx, admin, name+" type", "fdm_printing", &requestID)
	if err != nil {
		g.t.Fatal(err)
	}
	machine, err := logbook.CreateMachine(ctx, admin, machineType.ID, name, "active", nil, false, &requestID)
	if err != nil {
		g.t.Fatal(err)
	}
	if _, err = printingService.ConfigureProfile(ctx, admin, machine.ID, true, 0, &requestID); err != nil {
		g.t.Fatal(err)
	}
	connector, err := connectors.Create(ctx, admin, name+" connector", nil, &requestID)
	if err != nil {
		g.t.Fatal(err)
	}
	g.assign(machine.ID, connector.ID, kind, ip, code)
	return machine.ID
}

func (g *gatewayEnv) assign(machineID, connectorID uuid.UUID, kind, ip, code string) uuid.UUID {
	g.t.Helper()
	id := ids.New()
	var secrets []byte
	if code != "" {
		var err error
		if secrets, err = g.keyring.Encrypt(
			[]byte(`{"lanAccessCode":"`+code+`"}`),
			"printer-connector-assignment:"+id.String(),
		); err != nil {
			g.t.Fatal(err)
		}
	}
	settings := fmt.Sprintf(`{"ipAddress":%q,"serialNumber":"01P00A000000000","autoDetectSpools":false}`, ip)
	if _, err := g.pool.Exec(testContext(g.t), `INSERT INTO printer_connector_assignments (id, connector_id, machine_id, adapter_kind, settings, encrypted_secrets) VALUES ($1, $2, $3, $4, $5::text::jsonb, $6)`,
		id, connectorID, machineID, kind, settings, secrets); err != nil {
		g.t.Fatal(err)
	}
	return id
}

func (g *gatewayEnv) machineWithoutPrinter(name string) uuid.UUID {
	g.t.Helper()
	ctx := testContext(g.t)
	requestID := ids.New()
	logbook := machinelogbook.NewService(g.pool)
	machineType, err := logbook.CreateMachineType(ctx, g.fixture.admin, name+" type", "fdm_printing", &requestID)
	if err != nil {
		g.t.Fatal(err)
	}
	machine, err := logbook.CreateMachine(ctx, g.fixture.admin, machineType.ID, name, "active", nil, false, &requestID)
	if err != nil {
		g.t.Fatal(err)
	}
	return machine.ID
}

func (g *gatewayEnv) createGateway(name, host string) map[string]any {
	g.t.Helper()
	return g.expect(
		g.as(g.admin, http.MethodPost, "/streaming-gateways", map[string]any{"name": name, "publicHost": host}),
		http.StatusCreated,
	)
}

type gatewayIdentity struct {
	id     string
	secret string
	credID string
}

func (g *gatewayEnv) newCredential() (string, string) {
	secret, _, err := security.NewOpaqueToken()
	if err != nil {
		g.t.Fatal(err)
	}
	return ids.New().String(), secret
}

// enrolledGateway creates a gateway and runs the enrollment handshake.
func (g *gatewayEnv) enrolledGateway(name, host string) (map[string]any, gatewayIdentity) {
	g.t.Helper()
	gateway := g.createGateway(name, host)
	id := gateway["id"].(string)
	issue := g.expect(g.as(g.admin, http.MethodPost, "/streaming-gateways/"+id+"/enrollments", nil), http.StatusCreated)
	credID, credSecret := g.newCredential()
	g.expect(
		g.gw(
			issue["enrollmentSecret"].(string),
			http.MethodPost,
			"/streaming-gateway/enroll",
			map[string]any{
				"credentialId":     credID,
				"credentialSecret": credSecret,
				"softwareVersion":  "test",
				"protocolVersion":  1,
			},
		),
		http.StatusOK,
	)
	return g.expect(
		g.as(g.admin, http.MethodGet, "/streaming-gateways/"+id, nil),
		http.StatusOK,
	), gatewayIdentity{
		id:     id,
		secret: credSecret,
		credID: credID,
	}
}

func (g *gatewayEnv) gw(token, method, path string, body any) *http.Response {
	g.t.Helper()
	return g.do(g.plain, "", method, path, body, "Authorization", "Bearer "+token)
}

func (g *gatewayEnv) configuration(identity gatewayIdentity) map[string]any {
	g.t.Helper()
	return g.expect(g.gw(identity.secret, http.MethodGet, "/streaming-gateway/configuration", nil), http.StatusOK)
}

func rawBody(t *testing.T, response *http.Response, status int) string {
	t.Helper()
	defer response.Body.Close()
	raw, _ := io.ReadAll(response.Body)
	if response.StatusCode != status {
		t.Fatalf("status = %d, want %d: %s", response.StatusCode, status, raw)
	}
	return string(raw)
}

func TestStreamingGatewayLifecycleEnrollmentAndAudit(t *testing.T) {
	g := newGatewayEnv(t)
	ctx := testContext(t)

	// Creation validates the public host and the unique name.
	for _, host := range []string{
		"https://gw.example.org",
		"gw.example.org/x",
		"user@gw.example.org",
		"gw.example.org:99999",
		"[::1]:8443",
	} {
		g.expectCode(
			g.as(
				g.admin,
				http.MethodPost,
				"/streaming-gateways",
				map[string]any{"name": "Bad host", "publicHost": host},
			),
			http.StatusUnprocessableEntity,
			"validation_failed",
		)
	}
	g.expectCode(
		g.as(g.admin, http.MethodPost, "/streaming-gateways", map[string]any{"name": "Bad host", "publicHost": ""}),
		http.StatusBadRequest,
		"invalid_request",
	)
	gateway := g.createGateway("Workshop gateway", "Signage-GW.example.org:8443")
	id := gateway["id"].(string)
	if gateway["lifecycle"] != "pending" || gateway["publicHost"] != "signage-gw.example.org:8443" ||
		gateway["configurationRevision"] != float64(1) {
		t.Fatalf("gateway = %v", gateway)
	}
	g.expectCode(
		g.as(
			g.admin,
			http.MethodPost,
			"/streaming-gateways",
			map[string]any{"name": "workshop GATEWAY", "publicHost": "other.example.org"},
		),
		http.StatusConflict,
		"streaming_gateway_conflict",
	)

	// A pending gateway cannot be disabled; rename and host changes are versioned.
	g.expectCode(
		g.as(
			g.admin,
			http.MethodPatch,
			"/streaming-gateways/"+id,
			map[string]any{"name": "x", "publicHost": "gw.example.org", "enabled": false, "expectedVersion": 1},
		),
		http.StatusUnprocessableEntity,
		"validation_failed",
	)
	renamed := g.expect(
		g.as(
			g.admin,
			http.MethodPatch,
			"/streaming-gateways/"+id,
			map[string]any{
				"name":            "Entrance gateway",
				"publicHost":      "gw.example.org",
				"enabled":         true,
				"expectedVersion": 1,
			},
		),
		http.StatusOK,
	)
	if renamed["name"] != "Entrance gateway" || renamed["version"] != float64(2) ||
		renamed["configurationRevision"] != float64(2) {
		t.Fatalf("renamed = %v", renamed)
	}
	g.expectCode(
		g.as(
			g.admin,
			http.MethodPatch,
			"/streaming-gateways/"+id,
			map[string]any{"name": "Stale", "publicHost": "gw.example.org", "enabled": true, "expectedVersion": 1},
		),
		http.StatusConflict,
		"stale_write",
	)
	g.expectCode(
		g.as(g.admin, http.MethodGet, "/streaming-gateways/"+ids.New().String(), nil),
		http.StatusNotFound,
		"not_found",
	)

	// Without enrollment nothing authenticates.
	g.expectCode(
		g.gw("not-a-token", http.MethodGet, "/streaming-gateway/configuration", nil),
		http.StatusUnauthorized,
		"unauthenticated",
	)
	randomCredID, randomSecret := g.newCredential()
	g.expectCode(
		g.gw(randomSecret, http.MethodGet, "/streaming-gateway/configuration", nil),
		http.StatusUnauthorized,
		"unauthenticated",
	)
	g.expectCode(
		g.do(g.plain, "", http.MethodGet, "/streaming-gateway/configuration", nil),
		http.StatusUnauthorized,
		"unauthenticated",
	)

	// The enrollment secret is shown once, valid for 15 minutes, and only its digest is stored.
	issue := g.expect(g.as(g.admin, http.MethodPost, "/streaming-gateways/"+id+"/enrollments", nil), http.StatusCreated)
	secret := issue["enrollmentSecret"].(string)
	if len(secret) != 43 {
		t.Fatalf("enrollment secret = %q", secret)
	}
	expires, _ := time.Parse(time.RFC3339, issue["expiresAt"].(string))
	if d := time.Until(expires); d < 14*time.Minute || d > 15*time.Minute+time.Second {
		t.Fatalf("enrollment valid for %v", d)
	}
	var stored []byte
	if err := g.pool.QueryRow(
		ctx,
		`SELECT token_digest FROM streaming_gateway_enrollments WHERE gateway_id = $1`,
		id,
	).Scan(&stored); err != nil ||
		string(stored) == secret ||
		len(stored) != 32 {
		t.Fatalf("stored enrollment token: %v", err)
	}
	credID, credSecret := g.newCredential()
	enroll := map[string]any{
		"credentialId":     credID,
		"credentialSecret": credSecret,
		"softwareVersion":  "1.0.0",
		"protocolVersion":  1,
	}
	g.expectCode(
		g.gw(randomSecret, http.MethodPost, "/streaming-gateway/enroll", enroll),
		http.StatusUnauthorized,
		"unauthenticated",
	)
	g.expectCode(
		g.gw(
			secret,
			http.MethodPost,
			"/streaming-gateway/enroll",
			map[string]any{
				"credentialId":     credID,
				"credentialSecret": credSecret,
				"softwareVersion":  "1.0.0",
				"protocolVersion":  2,
			},
		),
		http.StatusUnprocessableEntity,
		"validation_failed",
	)
	result := g.expect(g.gw(secret, http.MethodPost, "/streaming-gateway/enroll", enroll), http.StatusOK)
	if result["gatewayId"] != id || result["credentialId"] != credID {
		t.Fatalf("enrollment result = %v", result)
	}
	// A lost response is recoverable with the same credential; other credentials are refused.
	g.expect(g.gw(secret, http.MethodPost, "/streaming-gateway/enroll", enroll), http.StatusOK)
	otherID, otherSecret := g.newCredential()
	g.expectCode(
		g.gw(
			secret,
			http.MethodPost,
			"/streaming-gateway/enroll",
			map[string]any{
				"credentialId":     otherID,
				"credentialSecret": otherSecret,
				"softwareVersion":  "1.0.0",
				"protocolVersion":  1,
			},
		),
		http.StatusConflict,
		"enrollment_replay_conflict",
	)
	_ = randomCredID
	enrolled := g.expect(g.as(g.admin, http.MethodGet, "/streaming-gateways/"+id, nil), http.StatusOK)
	if enrolled["lifecycle"] != "active" || enrolled["enrolledAt"] == nil {
		t.Fatalf("enrolled = %v", enrolled)
	}
	identity := gatewayIdentity{id: id, secret: credSecret, credID: credID}

	// Expired enrollments are refused.
	expiredGateway := g.createGateway("Expired enrollment", "gw2.example.org")
	expiredIssue := g.expect(
		g.as(g.admin, http.MethodPost, "/streaming-gateways/"+expiredGateway["id"].(string)+"/enrollments", nil),
		http.StatusCreated,
	)
	if _, err := g.pool.Exec(
		ctx,
		`UPDATE streaming_gateway_enrollments SET expires_at = now() - interval '1 second' WHERE gateway_id = $1`,
		expiredGateway["id"],
	); err != nil {
		t.Fatal(err)
	}
	g.expectCode(
		g.gw(
			expiredIssue["enrollmentSecret"].(string),
			http.MethodPost,
			"/streaming-gateway/enroll",
			map[string]any{
				"credentialId":     otherID,
				"credentialSecret": otherSecret,
				"softwareVersion":  "1",
				"protocolVersion":  1,
			},
		),
		http.StatusUnauthorized,
		"unauthenticated",
	)

	// Heartbeat validation and storage.
	machine := g.bambu("Heartbeat printer", "bambu_h2d", "192.168.1.40", "11112222")
	camera := g.expect(
		g.as(
			g.admin,
			http.MethodPost,
			"/streaming-gateways/"+id+"/cameras",
			map[string]any{"machineId": machine.String(), "enabled": true},
		),
		http.StatusCreated,
	)
	if camera["health"] != "unknown" || camera["gatewayName"] != "Entrance gateway" {
		t.Fatalf("camera = %v", camera)
	}
	beat := func(cameras []any, state string) *http.Response {
		return g.gw(
			identity.secret,
			http.MethodPost,
			"/streaming-gateway/heartbeat",
			map[string]any{
				"softwareVersion":              "1.0.0",
				"protocolVersion":              1,
				"appliedConfigurationRevision": 3,
				"healthState":                  state,
				"healthSummary":                nil,
				"cameras":                      cameras,
			},
		)
	}
	g.expectCode(
		beat(
			[]any{
				map[string]any{
					"machineId": machine.String(),
					"health":    "bogus",
					"viewers":   0,
					"codec":     nil,
					"width":     nil,
					"height":    nil,
					"fps":       nil,
				},
			},
			"connected",
		),
		http.StatusBadRequest,
		"invalid_request",
	)
	g.expectCode(
		beat(
			[]any{
				map[string]any{
					"machineId": machine.String(),
					"health":    "live",
					"viewers":   -1,
					"codec":     nil,
					"width":     nil,
					"height":    nil,
					"fps":       nil,
				},
			},
			"connected",
		),
		http.StatusBadRequest,
		"invalid_request",
	)
	reported := g.expect(beat([]any{
		map[string]any{
			"machineId": machine.String(),
			"health":    "live",
			"viewers":   3,
			"codec":     "h264",
			"width":     1920,
			"height":    1080,
			"fps":       30,
		},
		map[string]any{
			"machineId": ids.New().String(),
			"health":    "live",
			"viewers":   1,
			"codec":     nil,
			"width":     nil,
			"height":    nil,
			"fps":       nil,
		}, // unknown machine is ignored
	}, "connected"), http.StatusOK)
	if reported["healthState"] != "connected" || reported["softwareVersion"] != "1.0.0" ||
		reported["lastHeartbeatAt"] == nil ||
		reported["appliedConfigurationRevision"] != float64(3) {
		t.Fatalf("heartbeat answer = %v", reported)
	}
	status := g.expect(g.as(g.admin, http.MethodGet, "/local-services/cameras", nil), http.StatusOK)["items"].([]any)
	if len(status) != 1 {
		t.Fatalf("status = %v", status)
	}
	first := status[0].(map[string]any)
	if first["health"] != "live" || first["viewers"] != float64(3) || first["codec"] != "h264" ||
		first["width"] != float64(1920) ||
		first["fps"] != float64(30) ||
		first["machineName"] != "Heartbeat printer" {
		t.Fatalf("camera status = %v", first)
	}
	// Stale reports count as unknown.
	if _, err := g.pool.Exec(
		ctx,
		`UPDATE streaming_camera_states SET reported_at = now() - interval '5 minutes'`,
	); err != nil {
		t.Fatal(err)
	}
	if stale := g.expect(
		g.as(g.admin, http.MethodGet, "/local-services/cameras", nil),
		http.StatusOK,
	)["items"].([]any)[0].(map[string]any); stale["health"] != "unknown" {
		t.Fatalf("stale camera = %v", stale)
	}
	// A heartbeat without the camera clears its state.
	g.expect(beat([]any{}, "degraded"), http.StatusOK)
	var states int
	if err := g.pool.QueryRow(ctx, `SELECT count(*) FROM streaming_camera_states`).Scan(&states); err != nil ||
		states != 0 {
		t.Fatalf("states = %d %v", states, err)
	}

	// Credential rotation: the previous credential keeps working during the handover window.
	newCredID, newSecret := g.newCredential()
	rotation := map[string]any{"credentialId": newCredID, "credentialSecret": newSecret}
	g.expect(g.gw(identity.secret, http.MethodPost, "/streaming-gateway/credential-rotation", rotation), http.StatusOK)
	g.expect(
		g.gw(identity.secret, http.MethodPost, "/streaming-gateway/credential-rotation", rotation),
		http.StatusOK,
	) // idempotent
	g.expect(g.gw(newSecret, http.MethodGet, "/streaming-gateway/configuration", nil), http.StatusOK)
	g.expect(g.gw(identity.secret, http.MethodGet, "/streaming-gateway/configuration", nil), http.StatusOK)
	g.expectCode(
		g.gw(
			newSecret,
			http.MethodPost,
			"/streaming-gateway/credential-rotation",
			map[string]any{"credentialId": newCredID, "credentialSecret": credSecret},
		),
		http.StatusConflict,
		"credential_rotation_conflict",
	)
	identity.secret = newSecret

	// Disabling empties the configuration and refuses heartbeats; enabling restores it.
	version := int64(
		g.expect(g.as(g.admin, http.MethodGet, "/streaming-gateways/"+id, nil), http.StatusOK)["version"].(float64),
	)
	disabled := g.expect(
		g.as(
			g.admin,
			http.MethodPatch,
			"/streaming-gateways/"+id,
			map[string]any{
				"name":            "Entrance gateway",
				"publicHost":      "gw.example.org",
				"enabled":         false,
				"expectedVersion": version,
			},
		),
		http.StatusOK,
	)
	if disabled["lifecycle"] != "disabled" || disabled["disabledAt"] == nil {
		t.Fatalf("disabled = %v", disabled)
	}
	if cams := g.configuration(identity)["cameras"].([]any); len(cams) != 0 {
		t.Fatalf("a disabled gateway must receive no cameras: %v", cams)
	}
	g.expectCode(beat([]any{}, "connected"), http.StatusForbidden, "streaming_gateway_inactive")
	enabled := g.expect(
		g.as(
			g.admin,
			http.MethodPatch,
			"/streaming-gateways/"+id,
			map[string]any{
				"name":            "Entrance gateway",
				"publicHost":      "gw.example.org",
				"enabled":         true,
				"expectedVersion": disabled["version"],
			},
		),
		http.StatusOK,
	)
	if cams := g.configuration(identity)["cameras"].([]any); len(cams) != 1 || enabled["lifecycle"] != "active" {
		t.Fatalf("re-enabled gateway cameras = %v", cams)
	}

	// Revocation ends every credential immediately.
	revoked := g.expect(
		g.as(
			g.admin,
			http.MethodPost,
			"/streaming-gateways/"+id+"/revocation",
			map[string]any{"expectedVersion": enabled["version"]},
		),
		http.StatusOK,
	)
	if revoked["lifecycle"] != "revoked" || revoked["revokedAt"] == nil {
		t.Fatalf("revoked = %v", revoked)
	}
	g.expectCode(
		g.gw(identity.secret, http.MethodGet, "/streaming-gateway/configuration", nil),
		http.StatusUnauthorized,
		"unauthenticated",
	)
	g.expectCode(
		g.gw(credSecret, http.MethodGet, "/streaming-gateway/configuration", nil),
		http.StatusUnauthorized,
		"unauthenticated",
	)
	g.expectCode(
		g.as(
			g.admin,
			http.MethodPost,
			"/streaming-gateways/"+id+"/revocation",
			map[string]any{"expectedVersion": revoked["version"]},
		),
		http.StatusConflict,
		"streaming_gateway_revoked",
	)
	g.expectCode(
		g.as(
			g.admin,
			http.MethodPatch,
			"/streaming-gateways/"+id,
			map[string]any{
				"name":            "Entrance gateway",
				"publicHost":      "gw.example.org",
				"enabled":         true,
				"expectedVersion": revoked["version"],
			},
		),
		http.StatusConflict,
		"streaming_gateway_revoked",
	)
	g.expectCode(
		g.as(
			g.admin,
			http.MethodPost,
			"/streaming-gateways/"+id+"/cameras",
			map[string]any{
				"machineId": g.bambu("Late printer", "bambu_x1c", "192.168.1.41", "x").String(),
				"enabled":   true,
			},
		),
		http.StatusConflict,
		"streaming_gateway_revoked",
	)

	// Deletion removes the gateway with its cameras.
	g.expectCode(
		g.as(g.admin, http.MethodDelete, "/streaming-gateways/"+id, map[string]any{"expectedVersion": 1}),
		http.StatusConflict,
		"stale_write",
	)
	g.expect(
		g.as(
			g.admin,
			http.MethodDelete,
			"/streaming-gateways/"+id,
			map[string]any{"expectedVersion": revoked["version"]},
		),
		http.StatusNoContent,
	)
	g.expectCode(g.as(g.admin, http.MethodGet, "/streaming-gateways/"+id, nil), http.StatusNotFound, "not_found")
	var cameras, credentials int
	if err := g.pool.QueryRow(
		ctx,
		`SELECT (SELECT count(*) FROM streaming_cameras WHERE gateway_id = $1), (SELECT count(*) FROM streaming_gateway_credentials WHERE gateway_id = $1)`,
		id,
	).Scan(&cameras, &credentials); err != nil ||
		cameras != 0 ||
		credentials != 0 {
		t.Fatalf("leftovers: cameras %d credentials %d %v", cameras, credentials, err)
	}

	// Every administrative mutation and the enrollments are audited, never with secrets.
	for action, minimum := range map[string]int{
		"streaming_gateway.created":            2,
		"streaming_gateway.updated":            3,
		"streaming_gateway.enrollment_issued":  2,
		"streaming_gateway.enrolled":           1,
		"streaming_gateway.credential_rotated": 1,
		"streaming_camera.assigned":            1,
		"streaming_gateway.revoked":            1,
		"streaming_gateway.deleted":            1,
	} {
		if got := g.countAudit(action); got < minimum {
			t.Errorf("audit %s = %d, want at least %d", action, got, minimum)
		}
	}
	for _, leaked := range []string{secret, credSecret, newSecret, "11112222"} {
		var count int
		if err := g.pool.QueryRow(
			ctx,
			`SELECT count(*) FROM audit_events WHERE audit_events::text LIKE '%' || $1 || '%'`,
			leaked,
		).Scan(&count); err != nil ||
			count != 0 {
			t.Errorf("secret material found in %d audit rows (%v)", count, err)
		}
	}
	var systemEnrolled int
	if err := g.pool.QueryRow(
		ctx,
		`SELECT count(*) FROM audit_events WHERE action = 'streaming_gateway.enrolled' AND actor_type = 'system' AND actor_account_id IS NULL`,
	).Scan(&systemEnrolled); err != nil ||
		systemEnrolled != 1 {
		t.Fatalf("enrollment audit: %d %v", systemEnrolled, err)
	}
}

func TestStreamingGatewayPermissions(t *testing.T) {
	g := newGatewayEnv(t)
	denied := map[string]staffSession{
		"nobody": g.staff("nobody-" + uuid.NewString()[:6]),
		"signage manager": g.staff(
			"sm-"+uuid.NewString()[:6],
			authorization.SignageRead,
			authorization.SignageManage,
			authorization.SignageContentManage,
			authorization.SignagePublish,
		),
		"machines+connectors": g.staff(
			"mc-"+uuid.NewString()[:6],
			authorization.PrinterConnectorsRead,
			authorization.PrinterConnectorsManage,
			authorization.PrinterConnectorsCredentialsManage,
			authorization.MachinesManage,
		),
	}
	gateway, identity := g.enrolledGateway("Permission gateway", "gw.example.org")
	id := gateway["id"].(string)
	machine := g.bambu("Permission printer", "bambu_h2d", "192.168.1.42", "33334444")
	camera := g.expect(
		g.as(
			g.admin,
			http.MethodPost,
			"/streaming-gateways/"+id+"/cameras",
			map[string]any{"machineId": machine.String(), "enabled": true},
		),
		http.StatusCreated,
	)
	cameraID := camera["id"].(string)
	missing := ids.New().String()

	type call struct {
		method, path string
		body         any
	}
	calls := []call{
		{http.MethodGet, "/streaming-gateways", nil},
		{http.MethodPost, "/streaming-gateways", map[string]any{"name": "Denied", "publicHost": "gw.example.org"}},
		{http.MethodGet, "/streaming-gateways/" + id, nil},
		{
			http.MethodPatch,
			"/streaming-gateways/" + id,
			map[string]any{"name": "Denied", "publicHost": "gw.example.org", "enabled": true, "expectedVersion": 1},
		},
		{http.MethodDelete, "/streaming-gateways/" + missing, map[string]any{"expectedVersion": 1}},
		{http.MethodPost, "/streaming-gateways/" + id + "/enrollments", nil},
		{http.MethodPost, "/streaming-gateways/" + id + "/revocation", map[string]any{"expectedVersion": 1}},
		{http.MethodGet, "/streaming-gateways/" + id + "/cameras", nil},
		{
			http.MethodPost,
			"/streaming-gateways/" + id + "/cameras",
			map[string]any{"machineId": machine.String(), "enabled": true},
		},
		{
			http.MethodPatch,
			"/streaming-gateways/" + id + "/cameras/" + cameraID,
			map[string]any{"enabled": false, "expectedVersion": 1},
		},
		{http.MethodDelete, "/streaming-gateways/" + id + "/cameras/" + cameraID, nil},
		{http.MethodGet, "/local-services/cameras", nil},
	}
	for name, staff := range denied {
		for _, c := range calls {
			g.expectCode(g.as(staff, c.method, c.path, c.body), http.StatusForbidden, "permission_denied")
		}
		_ = name
	}
	// Nothing changed behind the 403s.
	if g.countAudit("streaming_gateway.revoked") != 0 || g.countAudit("streaming_camera.unassigned") != 0 {
		t.Fatal("a denied call changed state")
	}
	// The permission is enough; master is not required.
	g.expect(g.as(g.admin, http.MethodGet, "/streaming-gateways", nil), http.StatusOK)
	g.expect(g.as(g.admin, http.MethodGet, "/local-services/cameras", nil), http.StatusOK)

	// Anonymous callers and gateway credentials cannot use the administrative API.
	g.expectCode(
		g.do(g.plain, "", http.MethodGet, "/streaming-gateways", nil),
		http.StatusUnauthorized,
		"unauthenticated",
	)
	g.expectCode(
		g.gw(identity.secret, http.MethodGet, "/streaming-gateways", nil),
		http.StatusUnauthorized,
		"unauthenticated",
	)
	// A staff session, even an administrator's, cannot act as a gateway; the credential is the only way in.
	for _, c := range []call{
		{http.MethodGet, "/streaming-gateway/configuration", nil},
		{
			http.MethodPost,
			"/streaming-gateway/heartbeat",
			map[string]any{
				"softwareVersion":              "1",
				"protocolVersion":              1,
				"appliedConfigurationRevision": 1,
				"healthState":                  "connected",
				"healthSummary":                nil,
				"cameras":                      []any{},
			},
		},
		{
			http.MethodPost,
			"/streaming-gateway/credential-rotation",
			map[string]any{"credentialId": missing, "credentialSecret": strings.Repeat("a", 43)},
		},
	} {
		g.expectCode(g.as(g.admin, c.method, c.path, c.body), http.StatusUnauthorized, "unauthenticated")
	}
	// A player (managed device) credential is no gateway credential either.
	scene, playlist := g.seedContent("Perm")
	_ = scene
	_, player := g.pair(g.allStaff(), "Perm display", playlist.ID)
	g.expectCode(
		g.do(
			player,
			"",
			http.MethodGet,
			"/streaming-gateway/configuration",
			nil,
			"Authorization",
			"Bearer "+g.deviceToken(player),
		),
		http.StatusUnauthorized,
		"unauthenticated",
	)
}

func TestStreamingCameraAssignmentValidationAndHasCamera(t *testing.T) {
	g := newGatewayEnv(t)
	ctx := testContext(t)
	gateway, _ := g.enrolledGateway("Camera gateway", "gw.example.org")
	id := gateway["id"].(string)
	other, _ := g.enrolledGateway("Second gateway", "gw3.example.org")
	assign := func(gatewayID string, machine uuid.UUID, enabled bool) *http.Response {
		return g.as(
			g.admin,
			http.MethodPost,
			"/streaming-gateways/"+gatewayID+"/cameras",
			map[string]any{"machineId": machine.String(), "enabled": enabled},
		)
	}

	// Unknown machine, no printer, simulator, ended Bambu assignment.
	g.expectCode(assign(id, ids.New(), true), http.StatusUnprocessableEntity, "validation_failed")
	g.expectCode(
		assign(id, g.machineWithoutPrinter("Lathe"), true),
		http.StatusUnprocessableEntity,
		"validation_failed",
	)
	simulator := g.bambu("Simulated printer", "simulator", "192.168.1.60", "")
	g.expectCode(assign(id, simulator, true), http.StatusUnprocessableEntity, "validation_failed")
	ended := g.bambu("Ended printer", "bambu_x1c", "192.168.1.61", "55556666")
	if _, err := g.pool.Exec(
		ctx,
		`UPDATE printer_connector_assignments SET ended_at = now(), enabled = false WHERE machine_id = $1`,
		ended,
	); err != nil {
		t.Fatal(err)
	}
	g.expectCode(assign(id, ended, true), http.StatusUnprocessableEntity, "validation_failed")
	g.expectCode(
		assign(ids.New().String(), g.bambu("Orphan printer", "bambu_h2d", "192.168.1.62", "7"), true),
		http.StatusNotFound,
		"not_found",
	)
	if g.countAudit("streaming_camera.assigned") != 0 {
		t.Fatal("rejected assignments must not be audited")
	}

	// Both Bambu adapter kinds can be assigned; one camera per machine.
	h2d := g.bambu("Camera H2D", "bambu_h2d", "192.168.1.63", "88889999")
	x1c := g.bambu("Camera X1C", "bambu_x1c", "192.168.1.64", "12341234")
	camera := g.expect(assign(id, h2d, true), http.StatusCreated)
	g.expect(assign(id, x1c, false), http.StatusCreated)
	g.expectCode(assign(id, h2d, true), http.StatusConflict, "streaming_camera_exists")
	g.expectCode(assign(other["id"].(string), h2d, true), http.StatusConflict, "streaming_camera_exists")
	if camera["machineName"] != "Camera H2D" || camera["enabled"] != true || camera["gatewayId"] != id {
		t.Fatalf("camera = %v", camera)
	}
	if got := len(g.expect(
		g.as(g.admin, http.MethodGet, "/streaming-gateways/"+id+"/cameras", nil),
		http.StatusOK,
	)["items"].([]any)); got != 2 {
		t.Fatalf("cameras = %d", got)
	}
	if got := len(g.expect(
		g.as(g.admin, http.MethodGet, "/streaming-gateways/"+other["id"].(string)+"/cameras", nil),
		http.StatusOK,
	)["items"].([]any)); got != 0 {
		t.Fatalf("other gateway cameras = %d", got)
	}

	// hasCamera in the signage picker follows enabled cameras on non-revoked gateways.
	picker := func() map[string]bool {
		viewer := g.staff("picker-"+uuid.NewString()[:6], authorization.SignageRead)
		result := map[string]bool{}
		for _, item := range g.expect(
			g.as(viewer, http.MethodGet, "/signage/machines", nil),
			http.StatusOK,
		)["items"].([]any) {
			machine := item.(map[string]any)
			result[machine["id"].(string)] = machine["hasCamera"].(bool)
		}
		return result
	}
	hasCamera := picker()
	if !hasCamera[h2d.String()] || hasCamera[x1c.String()] || hasCamera[simulator.String()] {
		t.Fatalf("hasCamera = %v (enabled camera yes, disabled camera no, no camera no)", hasCamera)
	}
	// Enable the second camera, disable the first (versioned).
	cameras := g.expect(
		g.as(g.admin, http.MethodGet, "/streaming-gateways/"+id+"/cameras", nil),
		http.StatusOK,
	)["items"].([]any)
	var x1cCamera map[string]any
	for _, item := range cameras {
		if item.(map[string]any)["machineId"] == x1c.String() {
			x1cCamera = item.(map[string]any)
		}
	}
	path := "/streaming-gateways/" + id + "/cameras/"
	g.expectCode(
		g.as(
			g.admin,
			http.MethodPatch,
			path+x1cCamera["id"].(string),
			map[string]any{"enabled": true, "expectedVersion": 99},
		),
		http.StatusConflict,
		"stale_write",
	)
	g.expectCode(
		g.as(
			g.admin,
			http.MethodPatch,
			path+ids.New().String(),
			map[string]any{"enabled": true, "expectedVersion": 1},
		),
		http.StatusNotFound,
		"not_found",
	)
	enabled := g.expect(
		g.as(
			g.admin,
			http.MethodPatch,
			path+x1cCamera["id"].(string),
			map[string]any{"enabled": true, "expectedVersion": x1cCamera["version"]},
		),
		http.StatusOK,
	)
	if enabled["enabled"] != true || enabled["version"] != float64(2) {
		t.Fatalf("enabled = %v", enabled)
	}
	g.expect(
		g.as(
			g.admin,
			http.MethodPatch,
			path+camera["id"].(string),
			map[string]any{"enabled": false, "expectedVersion": camera["version"]},
		),
		http.StatusOK,
	)
	if hasCamera = picker(); hasCamera[h2d.String()] || !hasCamera[x1c.String()] {
		t.Fatalf("hasCamera after toggling = %v", hasCamera)
	}
	// Revoking the gateway removes hasCamera; unassigning frees the machine for another gateway.
	revoked := g.expect(g.as(g.admin, http.MethodGet, "/streaming-gateways/"+id, nil), http.StatusOK)
	g.expect(
		g.as(
			g.admin,
			http.MethodPost,
			"/streaming-gateways/"+id+"/revocation",
			map[string]any{"expectedVersion": revoked["version"]},
		),
		http.StatusOK,
	)
	if hasCamera = picker(); hasCamera[x1c.String()] {
		t.Fatalf("a revoked gateway's camera must not count: %v", hasCamera)
	}
	secondID := other["id"].(string)
	g.expect(g.as(g.admin, http.MethodDelete, path+x1cCamera["id"].(string), nil), http.StatusNoContent)
	g.expectCode(g.as(g.admin, http.MethodDelete, path+x1cCamera["id"].(string), nil), http.StatusNotFound, "not_found")
	g.expect(assign(secondID, x1c, true), http.StatusCreated)
	if hasCamera = picker(); !hasCamera[x1c.String()] {
		t.Fatalf("reassigned camera should count: %v", hasCamera)
	}
	for action, want := range map[string]int{
		"streaming_camera.assigned":   3,
		"streaming_camera.updated":    2,
		"streaming_camera.unassigned": 1,
	} {
		if got := g.countAudit(action); got != want {
			t.Errorf("audit %s = %d, want %d", action, got, want)
		}
	}
	// Machine deletion cannot leave a camera behind: the foreign key cascades.
	var references int
	if err := g.pool.QueryRow(
		ctx,
		`SELECT count(*) FROM pg_constraint WHERE conrelid = 'streaming_cameras'::regclass AND confrelid = 'machines'::regclass AND confdeltype = 'c'`,
	).Scan(&references); err != nil ||
		references != 1 {
		t.Fatalf("camera -> machine foreign key: %d %v", references, err)
	}
}

func TestStreamingGatewayConfigurationContents(t *testing.T) {
	g := newGatewayEnv(t)
	ctx := testContext(t)
	gateway, identity := g.enrolledGateway("Config gateway", "gw.example.org:8443")
	id := gateway["id"].(string)
	machine := g.bambu("Config printer", "bambu_h2d", "192.168.1.50", "ACC12345")
	camera := g.expect(
		g.as(
			g.admin,
			http.MethodPost,
			"/streaming-gateways/"+id+"/cameras",
			map[string]any{"machineId": machine.String(), "enabled": true},
		),
		http.StatusCreated,
	)
	disabledMachine := g.bambu("Disabled printer", "bambu_x1c", "192.168.1.51", "DISABLED1")
	g.expect(
		g.as(
			g.admin,
			http.MethodPost,
			"/streaming-gateways/"+id+"/cameras",
			map[string]any{"machineId": disabledMachine.String(), "enabled": false},
		),
		http.StatusCreated,
	)

	configuration := g.configuration(identity)
	cameras := configuration["cameras"].([]any)
	if len(cameras) != 1 {
		t.Fatalf("only enabled cameras are configured: %v", cameras)
	}
	entry := cameras[0].(map[string]any)
	wantStream := "cam-" + strings.ReplaceAll(machine.String(), "-", "")
	if entry["machineId"] != machine.String() || entry["name"] != "Config printer" ||
		entry["streamName"] != wantStream ||
		entry["sourceUrl"] != "rtspx://bblp:ACC12345@192.168.1.50:322/streaming/live/1" {
		t.Fatalf("camera entry = %v", entry)
	}
	if configuration["publicHost"] != "gw.example.org:8443" || configuration["protocolVersion"] != float64(1) ||
		configuration["revision"].(float64) < 3 {
		t.Fatalf("configuration = %v", configuration)
	}
	keys := configuration["ticketPublicKeys"].([]any)
	if len(keys) != 1 {
		t.Fatalf("keys = %v", keys)
	}
	key := keys[0].(map[string]any)
	publicKey, err := base64.RawURLEncoding.DecodeString(key["publicKey"].(string))
	if err != nil || len(publicKey) != ed25519.PublicKeySize || key["validUntil"] != nil ||
		key["kid"] != streamticket.KeyID(publicKey) {
		t.Fatalf("key = %v (%v)", key, err)
	}
	// The private key is stored encrypted and never leaves Core.
	var encrypted []byte
	if err = g.pool.QueryRow(
		ctx,
		`SELECT encrypted_private_key FROM signage_ticket_keys WHERE state = 'active'`,
	).Scan(&encrypted); err != nil ||
		len(encrypted) < 48 {
		t.Fatalf("stored key: %v", err)
	}
	seed, err := g.keyring.Decrypt(encrypted, "signage-ticket-key:"+mustSingleKeyID(t, g, ctx))
	if err != nil ||
		ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey).Equal(ed25519.PublicKey(publicKey)) != true {
		t.Fatalf("encrypted private key does not match the published public key: %v", err)
	}

	// The source URL (access code) is visible to the authenticated gateway only.
	for _, path := range []string{
		"/streaming-gateways",
		"/streaming-gateways/" + id,
		"/streaming-gateways/" + id + "/cameras",
		"/local-services/cameras",
	} {
		body := rawBody(t, g.as(g.admin, http.MethodGet, path, nil), http.StatusOK)
		for _, secret := range []string{"ACC12345", "rtspx", "bblp", "192.168.1.50", string(gatewayTestKey)} {
			if strings.Contains(body, secret) {
				t.Errorf("GET %s leaks %q", path, secret)
			}
		}
	}
	for _, c := range []struct{ method, path string }{{http.MethodGet, "/streaming-gateway/configuration"}} {
		g.expectCode(g.as(g.admin, c.method, c.path, nil), http.StatusUnauthorized, "unauthenticated")
	}
	g.expectCode(
		g.gw(identity.secret+"x", http.MethodGet, "/streaming-gateway/configuration", nil),
		http.StatusUnauthorized,
		"unauthenticated",
	)
	if response := g.gw(identity.secret, http.MethodGet, "/streaming-gateway/configuration", nil); response.Header.Get(
		"Cache-Control",
	) != "no-store" {
		t.Fatalf("configuration Cache-Control = %q", response.Header.Get("Cache-Control"))
	}

	// Camera changes bump the revision; the printer's address follows its assignment.
	before := configuration["revision"].(float64)
	g.expect(
		g.as(
			g.admin,
			http.MethodPatch,
			"/streaming-gateways/"+id+"/cameras/"+camera["id"].(string),
			map[string]any{"enabled": false, "expectedVersion": camera["version"]},
		),
		http.StatusOK,
	)
	changed := g.configuration(identity)
	if changed["revision"].(float64) <= before || len(changed["cameras"].([]any)) != 0 {
		t.Fatalf("after disabling: %v", changed)
	}
	g.expect(
		g.as(
			g.admin,
			http.MethodPatch,
			"/streaming-gateways/"+id+"/cameras/"+camera["id"].(string),
			map[string]any{"enabled": true, "expectedVersion": 2},
		),
		http.StatusOK,
	)
	if _, err = g.pool.Exec(
		ctx,
		`UPDATE printer_connector_assignments SET settings = jsonb_set(settings, '{ipAddress}', '"192.168.1.77"') WHERE machine_id = $1`,
		machine,
	); err != nil {
		t.Fatal(err)
	}
	if source := g.configuration(identity)["cameras"].([]any)[0].(map[string]any)["sourceUrl"]; source != "rtspx://bblp:ACC12345@192.168.1.77:322/streaming/live/1" {
		t.Fatalf("source after address change = %v", source)
	}
	// An ended printer assignment drops the camera from the configuration.
	if _, err = g.pool.Exec(
		ctx,
		`UPDATE printer_connector_assignments SET ended_at = now() WHERE machine_id = $1`,
		machine,
	); err != nil {
		t.Fatal(err)
	}
	if cams := g.configuration(identity)["cameras"].([]any); len(cams) != 0 {
		t.Fatalf("camera without an active printer assignment: %v", cams)
	}

	if configuration["sessionEpoch"] == nil || configuration["revokedDisplayIds"] == nil {
		t.Fatalf("configuration lacks the session epoch fields: %v", configuration)
	}
	if g.countAudit("signage_ticket_key.created") != 1 {
		t.Fatal("key creation must be audited")
	}
}

func mustSingleKeyID(t *testing.T, g *gatewayEnv, ctx context.Context) string {
	t.Helper()
	var id string
	if err := g.pool.QueryRow(
		ctx,
		`SELECT id::text FROM signage_ticket_keys WHERE state = 'active'`,
	).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func cameraWidget(machine uuid.UUID) json.RawMessage {
	return json.RawMessage(
		`{"type":"camera","source":"machine","machineId":"` + machine.String() + `","multi":"split","showProgress":false,"showRemaining":false,"fallback":"text","fallbackMediaId":null}`,
	)
}

func TestPlayerLiveStreams(t *testing.T) {
	g := newGatewayEnv(t)
	ctx := testContext(t)
	staff := g.allStaff()
	svc, admin := g.fixture.service, g.fixture.admin

	gateway, identity := g.enrolledGateway("Live gateway", "Stream-GW.example.org:8443")
	gatewayID := gateway["id"].(string)
	watched := g.bambu("Watched printer", "bambu_h2d", "192.168.1.70", "10000001")
	statusOnly := g.bambu("Status only printer", "bambu_x1c", "192.168.1.71", "10000002")
	disabledCam := g.bambu("Disabled camera printer", "bambu_h2d", "192.168.1.72", "10000003")
	noCamera := g.bambu("No camera printer", "bambu_h2d", "192.168.1.73", "10000004")
	var cameraIDs = map[uuid.UUID]map[string]any{}
	for machine, enabled := range map[uuid.UUID]bool{watched: true, statusOnly: true, disabledCam: false} {
		cameraIDs[machine] = g.expect(
			g.as(
				g.admin,
				http.MethodPost,
				"/streaming-gateways/"+gatewayID+"/cameras",
				map[string]any{"machineId": machine.String(), "enabled": enabled},
			),
			http.StatusCreated,
		)
	}

	mkScene := func(name string, widget json.RawMessage) uuid.UUID {
		input := sceneInput(name, "full")
		input.Zones = map[string]json.RawMessage{"main": widget}
		scene, err := svc.CreateScene(ctx, admin, input, nil)
		if err != nil {
			t.Fatal(err)
		}
		return scene.ID
	}
	cameraScene := mkScene("Camera A", cameraWidget(watched))
	disabledScene := mkScene("Camera disabled", cameraWidget(disabledCam))
	noCameraScene := mkScene("Camera none", cameraWidget(noCamera))
	statusScene := mkScene(
		"Status",
		json.RawMessage(
			`{"type":"status","machineIds":["`+statusOnly.String()+`"],"showProgress":true,"showRemaining":true}`,
		),
	)
	playlist := g.fixture.playlist(t, "Streams", cameraScene, disabledScene, noCameraScene, statusScene)
	display, player := g.pair(staff, "Stream display", playlist.ID)
	displayID := display["id"].(string)
	live := func(client *http.Client) map[string]any {
		return g.expect(g.do(client, "", http.MethodGet, "/signage/player/live", nil), http.StatusOK)
	}

	// Nothing is published yet: no streams.
	if streams := live(player)["streams"].([]any); len(streams) != 0 {
		t.Fatalf("unpublished display got streams: %v", streams)
	}
	g.expect(g.as(staff, http.MethodPost, "/signage/displays/"+displayID+"/publish", nil), http.StatusOK)

	streams := live(player)["streams"].([]any)
	if len(streams) != 1 {
		t.Fatalf("streams = %v, want only the published, enabled camera widget on an active gateway", streams)
	}
	stream := streams[0].(map[string]any)
	name := "cam-" + strings.ReplaceAll(watched.String(), "-", "")
	if stream["machineId"] != watched.String() ||
		stream["webrtcUrl"] != "https://stream-gw.example.org:8443/api/webrtc?src="+name ||
		stream["mseUrl"] != "wss://stream-gw.example.org:8443/api/ws?src="+name {
		t.Fatalf("stream = %v", stream)
	}
	if strings.Contains(fmt.Sprint(stream["webrtcUrl"], stream["mseUrl"]), "ticket") {
		t.Fatal("the ticket is a separate field, not part of the URLs")
	}
	// The ticket verifies against the key the gateway receives, offline, for exactly this display and stream.
	keys := streamticket.Keys{}
	for _, raw := range g.configuration(identity)["ticketPublicKeys"].([]any) {
		entry := raw.(map[string]any)
		decoded, _ := base64.RawURLEncoding.DecodeString(entry["publicKey"].(string))
		keys[entry["kid"].(string)] = decoded
	}
	claims, err := streamticket.VerifyForStream(stream["ticket"].(string), keys, name, time.Now())
	if err != nil {
		t.Fatalf("ticket does not verify: %v", err)
	}
	if claims.DisplayID.String() != displayID || claims.MachineID != watched || claims.StreamName != name ||
		claims.Version != 1 {
		t.Fatalf("claims = %+v", claims)
	}
	expiresAt, _ := time.Parse(time.RFC3339, stream["expiresAt"].(string))
	if !expiresAt.Equal(claims.ExpiresAt()) || time.Until(expiresAt) < 4*time.Minute ||
		time.Until(expiresAt) > 5*time.Minute+time.Second {
		t.Fatalf("expiresAt = %v", expiresAt)
	}
	if _, err = streamticket.VerifyForStream(
		stream["ticket"].(string),
		keys,
		name,
		time.Now().Add(6*time.Minute),
	); err == nil {
		t.Fatal("ticket must expire")
	}
	if _, err = streamticket.VerifyForStream(
		stream["ticket"].(string),
		keys,
		"cam-"+strings.ReplaceAll(statusOnly.String(), "-", ""),
		time.Now(),
	); err == nil {
		t.Fatal("ticket must be bound to its stream")
	}

	// A draft change (a second camera widget) is not served until it is published.
	update := sceneInput("Camera A", "full")
	update.Zones = map[string]json.RawMessage{"main": cameraWidget(statusOnly)}
	if _, err = svc.UpdateScene(ctx, admin, cameraScene, 1, update, nil); err != nil {
		t.Fatal(err)
	}
	if got := live(player)["streams"].([]any); len(got) != 1 ||
		got[0].(map[string]any)["machineId"] != watched.String() {
		t.Fatalf("draft change leaked into the live data: %v", got)
	}
	g.expect(g.as(staff, http.MethodPost, "/signage/displays/"+displayID+"/publish", nil), http.StatusOK)
	if got := live(player)["streams"].([]any); len(got) != 1 ||
		got[0].(map[string]any)["machineId"] != statusOnly.String() {
		t.Fatalf("after publishing: %v", got)
	}

	// Camera disabled, gateway disabled or revoked: no streams.
	cam := cameraIDs[statusOnly]
	disabled := g.expect(
		g.as(
			g.admin,
			http.MethodPatch,
			"/streaming-gateways/"+gatewayID+"/cameras/"+cam["id"].(string),
			map[string]any{"enabled": false, "expectedVersion": cam["version"]},
		),
		http.StatusOK,
	)
	if got := live(player)["streams"].([]any); len(got) != 0 {
		t.Fatalf("disabled camera still streams: %v", got)
	}
	g.expect(
		g.as(
			g.admin,
			http.MethodPatch,
			"/streaming-gateways/"+gatewayID+"/cameras/"+cam["id"].(string),
			map[string]any{"enabled": true, "expectedVersion": disabled["version"]},
		),
		http.StatusOK,
	)
	if got := live(player)["streams"].([]any); len(got) != 1 {
		t.Fatalf("re-enabled camera: %v", got)
	}
	current := g.expect(g.as(g.admin, http.MethodGet, "/streaming-gateways/"+gatewayID, nil), http.StatusOK)
	off := g.expect(
		g.as(
			g.admin,
			http.MethodPatch,
			"/streaming-gateways/"+gatewayID,
			map[string]any{
				"name":            "Live gateway",
				"publicHost":      "stream-gw.example.org:8443",
				"enabled":         false,
				"expectedVersion": current["version"],
			},
		),
		http.StatusOK,
	)
	if got := live(player)["streams"].([]any); len(got) != 0 {
		t.Fatalf("disabled gateway still streams: %v", got)
	}
	on := g.expect(
		g.as(
			g.admin,
			http.MethodPatch,
			"/streaming-gateways/"+gatewayID,
			map[string]any{
				"name":            "Live gateway",
				"publicHost":      "other-host.example.org",
				"enabled":         true,
				"expectedVersion": off["version"],
			},
		),
		http.StatusOK,
	)
	if got := live(player)["streams"].([]any); len(got) != 1 ||
		!strings.HasPrefix(
			got[0].(map[string]any)["webrtcUrl"].(string),
			"https://other-host.example.org/api/webrtc?src=",
		) {
		t.Fatalf("host change: %v", got)
	}

	// The admin preview never carries tickets.
	preview := g.expect(g.as(staff, http.MethodGet, "/signage/displays/"+displayID+"/preview", nil), http.StatusOK)
	if got := preview["live"].(map[string]any)["streams"].([]any); len(got) != 0 {
		t.Fatalf("preview streams = %v", got)
	}
	// Another display with the same cameras but no camera widget gets nothing.
	plainDisplay, plainPlayer := g.pair(staff, "Plain display", g.fixture.playlist(t, "Plain", statusScene).ID)
	g.expect(
		g.as(staff, http.MethodPost, "/signage/displays/"+plainDisplay["id"].(string)+"/publish", nil),
		http.StatusOK,
	)
	if got := live(plainPlayer)["streams"].([]any); len(got) != 0 {
		t.Fatalf("display without camera widgets got streams: %v", got)
	}

	// Revoked gateway: no streams.
	g.expect(
		g.as(
			g.admin,
			http.MethodPost,
			"/streaming-gateways/"+gatewayID+"/revocation",
			map[string]any{"expectedVersion": on["version"]},
		),
		http.StatusOK,
	)
	if got := live(player)["streams"].([]any); len(got) != 0 {
		t.Fatalf("revoked gateway still streams: %v", got)
	}

	// Revoked display: the live endpoint (and with it every ticket) is closed.
	fresh, _ := g.enrolledGateway("Second live gateway", "gw9.example.org")
	g.expect(
		g.as(
			g.admin,
			http.MethodPost,
			"/streaming-gateways/"+fresh["id"].(string)+"/cameras",
			map[string]any{"machineId": noCamera.String(), "enabled": true},
		),
		http.StatusCreated,
	)
	if got := live(player)["streams"].([]any); len(got) != 1 {
		t.Fatalf("camera on the second gateway: %v", got)
	}
	version := g.displayVersion(staff, displayID)
	g.expect(
		g.as(
			staff,
			http.MethodPost,
			"/signage/displays/"+displayID+"/revoke",
			map[string]any{"expectedVersion": version},
		),
		http.StatusOK,
	)
	response := g.do(player, "", http.MethodGet, "/signage/player/live", nil)
	body := rawBody(t, response, http.StatusUnauthorized)
	if strings.Contains(body, "ticket") || strings.Contains(body, "webrtcUrl") {
		t.Fatalf("revoked display response: %s", body)
	}
}

func (g *gatewayEnv) keyStates() map[string]int {
	g.t.Helper()
	rows, err := g.pool.Query(testContext(g.t), `SELECT state, count(*) FROM signage_ticket_keys GROUP BY state`)
	if err != nil {
		g.t.Fatal(err)
	}
	defer rows.Close()
	result := map[string]int{}
	for rows.Next() {
		var state string
		var count int
		if err = rows.Scan(&state, &count); err != nil {
			g.t.Fatal(err)
		}
		result[state] = count
	}
	return result
}

func ticketKid(t *testing.T, ticket string) string {
	t.Helper()
	payload, err := base64.RawURLEncoding.DecodeString(strings.SplitN(ticket, ".", 2)[0])
	if err != nil {
		t.Fatal(err)
	}
	var claims struct {
		KeyID string `json:"kid"`
	}
	if err = json.Unmarshal(payload, &claims); err != nil {
		t.Fatal(err)
	}
	return claims.KeyID
}

func TestTicketKeyRotationIsStagedAndAudited(t *testing.T) {
	g := newGatewayEnv(t)
	ctx := testContext(t)
	gateway, identity := g.enrolledGateway("Rotation gateway", "gw.example.org")
	machine := g.bambu("Rotation printer", "bambu_h2d", "192.168.1.60", "ROT12345")
	g.expect(
		g.as(
			g.admin,
			http.MethodPost,
			"/streaming-gateways/"+gateway["id"].(string)+"/cameras",
			map[string]any{"machineId": machine.String(), "enabled": true},
		),
		http.StatusCreated,
	)
	const path = "/local-services/ticket-key/rotation"

	// Only local_services.manage may rotate; nothing changes behind the 403.
	for _, staff := range []staffSession{
		g.staff("nobody-" + uuid.NewString()[:6]),
		g.staff("sm-"+uuid.NewString()[:6], authorization.SignageManage, authorization.SignagePublish),
	} {
		g.expectCode(g.as(staff, http.MethodPost, path, nil), http.StatusForbidden, "permission_denied")
	}
	g.expectCode(g.do(g.plain, "", http.MethodPost, path, nil), http.StatusUnauthorized, "unauthenticated")
	g.expectCode(g.gw(identity.secret, http.MethodPost, path, nil), http.StatusUnauthorized, "unauthenticated")

	issue := func() string { // a fresh service has no signing-key cache, like a restarted Core
		service, err := streaminggateways.NewService(g.pool, [][]byte{gatewayTestKey})
		if err != nil {
			t.Fatal(err)
		}
		streams, err := service.IssueStreams(ctx, ids.New(), []uuid.UUID{machine})
		if err != nil || len(streams) != 1 {
			t.Fatalf("issue streams: %v %v", streams, err)
		}
		return ticketKid(t, streams[0].Ticket)
	}
	firstKid := issue()
	if keys := g.configuration(identity)["ticketPublicKeys"].([]any); len(keys) != 1 ||
		keys[0].(map[string]any)["kid"] != firstKid {
		t.Fatalf("keys before rotation = %v", keys)
	}
	revisionBefore := g.configuration(identity)["revision"].(float64)

	started := time.Now()
	rotation := g.expect(g.as(g.admin, http.MethodPost, path, nil), http.StatusAccepted)
	pendingKid := rotation["keyId"].(string)
	activates, _ := time.Parse(time.RFC3339, rotation["activatesAt"].(string))
	if pendingKid == firstKid || activates.Sub(started) < 59*time.Second || activates.Sub(started) > 62*time.Second {
		t.Fatalf("rotation = %v", rotation)
	}
	// The pending key reaches the gateways at once but does not sign yet.
	configuration := g.configuration(identity)
	if configuration["revision"].(float64) <= revisionBefore {
		t.Fatal("rotation must bump the configuration revision")
	}
	published := map[string]any{}
	for _, raw := range configuration["ticketPublicKeys"].([]any) {
		entry := raw.(map[string]any)
		published[entry["kid"].(string)] = entry["validUntil"]
	}
	if len(published) != 2 || published[firstKid] != nil || published[pendingKid] != nil {
		t.Fatalf("published keys = %v", published)
	}
	if states := g.keyStates(); states["active"] != 1 || states["pending"] != 1 {
		t.Fatalf("states = %v", states)
	}
	if got := issue(); got != firstKid {
		t.Fatalf("a pending key signed a ticket (%s)", got)
	}

	// After the activation time the next signing promotes it lazily and retires the old key for ten minutes.
	if _, err := g.pool.Exec(
		ctx,
		`UPDATE signage_ticket_keys SET activates_at = now() - interval '1 second' WHERE state = 'pending'`,
	); err != nil {
		t.Fatal(err)
	}
	if got := issue(); got != pendingKid {
		t.Fatalf("after activation the ticket carries %s, want %s", got, pendingKid)
	}
	var retiredUntil time.Time
	for _, raw := range g.configuration(identity)["ticketPublicKeys"].([]any) {
		entry := raw.(map[string]any)
		switch entry["kid"] {
		case pendingKid:
			if entry["validUntil"] != nil {
				t.Fatalf("signing key has an end of validity: %v", entry)
			}
		case firstKid:
			retiredUntil, _ = time.Parse(time.RFC3339, entry["validUntil"].(string))
		default:
			t.Fatalf("unexpected key %v", entry)
		}
	}
	if until := time.Until(retiredUntil); until < 9*time.Minute || until > 10*time.Minute+5*time.Second {
		t.Fatalf("retired key valid for %v", until)
	}
	if states := g.keyStates(); states["active"] != 1 || states["retired"] != 1 || states["pending"] != 0 {
		t.Fatalf("states = %v", states)
	}

	// Rotating while a key is still pending activates that key first, then stages the next one.
	second := g.expect(g.as(g.admin, http.MethodPost, path, nil), http.StatusAccepted)["keyId"].(string)
	third := g.expect(g.as(g.admin, http.MethodPost, path, nil), http.StatusAccepted)["keyId"].(string)
	if states := g.keyStates(); states["active"] != 1 || states["pending"] != 1 {
		t.Fatalf("states after back-to-back rotations = %v", states)
	}
	if got := issue(); got != second {
		t.Fatalf("the second rotation's key (%s) should sign, got %s (third pending: %s)", second, got, third)
	}

	// Retired keys disappear from the configuration after ten minutes.
	if _, err := g.pool.Exec(
		ctx,
		`UPDATE signage_ticket_keys SET retired_at = now() - interval '11 minutes' WHERE state = 'retired'`,
	); err != nil {
		t.Fatal(err)
	}
	if keys := g.configuration(identity)["ticketPublicKeys"].([]any); len(keys) != 2 {
		t.Fatalf("keys after expiry = %v", keys)
	}
	if g.countAudit("signage_ticket_key.created") != 1 || g.countAudit("signage_ticket_key.rotated") != 3 ||
		g.countAudit("signage_ticket_key.activated") != 2 {
		t.Fatalf(
			"audit: created %d rotated %d activated %d",
			g.countAudit("signage_ticket_key.created"),
			g.countAudit("signage_ticket_key.rotated"),
			g.countAudit("signage_ticket_key.activated"),
		)
	}
	var actors int
	if err := g.pool.QueryRow(
		ctx,
		`SELECT count(*) FROM audit_events WHERE action = 'signage_ticket_key.rotated' AND actor_account_id IS NOT NULL`,
	).Scan(&actors); err != nil ||
		actors != 3 {
		t.Fatalf("rotation audit rows with an actor: %d (%v)", actors, err)
	}
}

func TestSessionEpochAndRevokedDisplaysInTheConfiguration(t *testing.T) {
	g := newGatewayEnv(t)
	ctx := testContext(t)
	staff := g.allStaff()
	svc, admin := g.fixture.service, g.fixture.admin
	gateway, identity := g.enrolledGateway("Epoch gateway", "gw.example.org")
	machine := g.bambu("Epoch printer", "bambu_h2d", "192.168.1.61", "EPO12345")
	g.expect(
		g.as(
			g.admin,
			http.MethodPost,
			"/streaming-gateways/"+gateway["id"].(string)+"/cameras",
			map[string]any{"machineId": machine.String(), "enabled": true},
		),
		http.StatusCreated,
	)
	epoch := func() float64 { return g.configuration(identity)["sessionEpoch"].(float64) }
	revoked := func() []any { return g.configuration(identity)["revokedDisplayIds"].([]any) }
	mk := func(name string, widget json.RawMessage) uuid.UUID {
		input := sceneInput(name, "full")
		input.Zones = map[string]json.RawMessage{"main": widget}
		scene, err := svc.CreateScene(ctx, admin, input, nil)
		if err != nil {
			t.Fatal(err)
		}
		return scene.ID
	}
	cameraScene := mk("Epoch camera", cameraWidget(machine))
	plainScene := mk(
		"Epoch plain",
		json.RawMessage(
			`{"type":"status","machineIds":["`+machine.String()+`"],"showProgress":true,"showRemaining":true}`,
		),
	)
	start := epoch()
	if len(revoked()) != 0 {
		t.Fatalf("revoked displays = %v", revoked())
	}

	// Republishing without a camera the display used before drops running sessions; other
	// publications do not.
	playlist := g.fixture.playlist(t, "Epoch", cameraScene)
	display, _ := g.pair(staff, "Epoch display", playlist.ID)
	displayID := display["id"].(string)
	publish := func(id string) {
		g.expect(g.as(staff, http.MethodPost, "/signage/displays/"+id+"/publish", nil), http.StatusOK)
	}
	publish(displayID)
	publish(displayID)
	if epoch() != start {
		t.Fatal("publishing that keeps the camera must not bump the epoch")
	}
	if _, err := svc.UpdatePlaylist(
		ctx,
		admin,
		playlist.ID,
		playlist.Version,
		signage.PlaylistInput{
			Name:  playlist.Name,
			Items: []signage.PlaylistItem{{SceneID: plainScene, Seconds: 10, Transition: "cut"}},
		},
		nil,
	); err != nil {
		t.Fatalf("playlist update: %v", err)
	}
	publish(displayID)
	if epoch() != start+1 {
		t.Fatalf("epoch = %v after a republish without the camera, want %v", epoch(), start+1)
	}
	publish(displayID)
	if epoch() != start+1 {
		t.Fatal("no camera before and after: no bump")
	}

	// Revoking and deleting a display bump the epoch and list the display for 24 hours.
	g.expect(
		g.as(
			staff,
			http.MethodPost,
			"/signage/displays/"+displayID+"/revoke",
			map[string]any{"expectedVersion": g.displayVersion(staff, displayID)},
		),
		http.StatusOK,
	)
	if epoch() != start+2 || len(revoked()) != 1 || revoked()[0] != displayID {
		t.Fatalf("after revoke: epoch %v revoked %v", epoch(), revoked())
	}
	g.expect(
		g.as(
			staff,
			http.MethodDelete,
			"/signage/displays/"+displayID,
			map[string]any{"expectedVersion": g.displayVersion(staff, displayID)},
		),
		http.StatusNoContent,
	)
	if epoch() != start+3 || len(revoked()) != 1 || revoked()[0] != displayID {
		t.Fatalf("after delete: epoch %v revoked %v", epoch(), revoked())
	}
	if _, err := g.pool.Exec(
		ctx,
		`UPDATE signage_revoked_displays SET revoked_at = now() - interval '25 hours'`,
	); err != nil {
		t.Fatal(err)
	}
	if len(revoked()) != 0 {
		t.Fatalf("revoked displays after 24 hours = %v", revoked())
	}
	// The revocation list is only for the authenticated gateway.
	g.expectCode(
		g.as(g.admin, http.MethodGet, "/streaming-gateway/configuration", nil),
		http.StatusUnauthorized,
		"unauthenticated",
	)
}

func TestCameraAccessOutsideNeedsTheExplicitSetting(t *testing.T) {
	g := newGatewayEnv(t)
	ctx := testContext(t)
	staff := g.allStaff()
	svc, admin := g.fixture.service, g.fixture.admin
	gateway, identity := g.enrolledGateway("Outside gateway", "gw.example.org")
	machine := g.bambu("Outside printer", "bambu_h2d", "192.168.1.62", "OUT12345")
	g.expect(
		g.as(
			g.admin,
			http.MethodPost,
			"/streaming-gateways/"+gateway["id"].(string)+"/cameras",
			map[string]any{"machineId": machine.String(), "enabled": true},
		),
		http.StatusCreated,
	)
	input := sceneInput("Outside camera", "full")
	input.Zones = map[string]json.RawMessage{"main": cameraWidget(machine)}
	scene, err := svc.CreateScene(ctx, admin, input, nil)
	if err != nil {
		t.Fatal(err)
	}
	playlist := g.fixture.playlist(t, "Outside", scene.ID)
	display, player := g.pair(staff, "Outside display", playlist.ID)
	displayID := display["id"].(string)
	if display["allowCameraOutside"] != false {
		t.Fatalf("default = %v", display["allowCameraOutside"])
	}
	g.expect(g.as(staff, http.MethodPost, "/signage/displays/"+displayID+"/publish", nil), http.StatusOK)
	streams := func() int {
		return len(
			g.expect(g.do(player, "", http.MethodGet, "/signage/player/live", nil), http.StatusOK)["streams"].([]any),
		)
	}
	epoch := func() float64 { return g.configuration(identity)["sessionEpoch"].(float64) }
	update := func(visible bool, allow any) map[string]any {
		body := map[string]any{
			"expectedVersion": g.displayVersion(
				staff,
				displayID,
			), "name": "Outside display", "location": "Entrance hall", "orientation": "landscape",
			"resolution": map[string]any{
				"width":  1920,
				"height": 1080,
			}, "visibleFromOutside": visible, "defaultPlaylistId": playlist.ID.String(),
		}
		if allow != nil {
			body["allowCameraOutside"] = allow
		}
		return g.expect(g.as(staff, http.MethodPut, "/signage/displays/"+displayID, body), http.StatusOK)
	}
	if streams() != 1 {
		t.Fatal("an inside display gets its stream")
	}
	start := epoch()

	// Visible from outside without the setting: no tickets, and running sessions are dropped.
	update(true, nil)
	if streams() != 0 || epoch() != start+1 {
		t.Fatalf("outside display without the setting: streams %d, epoch %v (want %v)", streams(), epoch(), start+1)
	}
	// The setting is effective immediately, without publishing, and does not bump the epoch.
	shown := update(true, true)
	if shown["allowCameraOutside"] != true || streams() != 1 || epoch() != start+1 {
		t.Fatalf("allowed: setting %v streams %d epoch %v", shown["allowCameraOutside"], streams(), epoch())
	}
	// Omitting the field keeps the stored value.
	if kept := update(true, nil); kept["allowCameraOutside"] != true || streams() != 1 {
		t.Fatalf("omitted field changed the setting: %v", kept["allowCameraOutside"])
	}
	// Switching it off drops the running sessions.
	off := update(true, false)
	if off["allowCameraOutside"] != false || streams() != 0 || epoch() != start+2 {
		t.Fatalf("switched off: streams %d epoch %v (want %v)", streams(), epoch(), start+2)
	}
	// The setting only matters for displays visible from outside; it stays stored.
	update(false, true)
	update(false, false)
	if streams() != 1 || epoch() != start+2 {
		t.Fatalf("inside again: streams %d epoch %v", streams(), epoch())
	}
	update(false, true)
	update(true, nil) // visible from outside with the setting on: still allowed
	if streams() != 1 || epoch() != start+2 {
		t.Fatalf("outside with the setting: streams %d epoch %v", streams(), epoch())
	}
	// Moving an inside display outside without the setting also cuts the sessions.
	update(false, false)
	update(true, nil)
	if streams() != 0 || epoch() != start+3 {
		t.Fatalf("moved outside without the setting: streams %d epoch %v", streams(), epoch())
	}
	if g.countAudit("signage_display.updated") < 6 {
		t.Fatal("changes must be audited")
	}
	var changed int
	if err = g.pool.QueryRow(
		ctx,
		`SELECT count(*) FROM audit_events WHERE action = 'signage_display.updated' AND changed_fields @> ARRAY['allowCameraOutside']`,
	).Scan(&changed); err != nil ||
		changed == 0 {
		t.Fatalf("allowCameraOutside is not audited as a changed field (%d, %v)", changed, err)
	}
}

func autoCameraWidget(machines ...uuid.UUID) json.RawMessage {
	ids := make([]string, 0, len(machines))
	for _, id := range machines {
		ids = append(ids, `"`+id.String()+`"`)
	}
	return json.RawMessage(
		`{"type":"camera","source":"auto","machineId":null,"machineIds":[` + strings.Join(
			ids,
			",",
		) + `],"multi":"split","showProgress":false,"showRemaining":false,"fallback":"text","fallbackMediaId":null}`,
	)
}

func TestPlayerLiveStreamsFollowTheAutoCameraMachineList(t *testing.T) {
	g := newGatewayEnv(t)
	ctx := testContext(t)
	staff := g.allStaff()
	svc, admin := g.fixture.service, g.fixture.admin

	gateway, _ := g.enrolledGateway("Auto gateway", "auto-gw.example.org")
	gatewayID := gateway["id"].(string)
	cameras := map[string]uuid.UUID{
		"first":  g.bambu("Auto first", "bambu_h2d", "192.168.1.80", "20000001"),
		"second": g.bambu("Auto second", "bambu_h2d", "192.168.1.81", "20000002"),
		"third":  g.bambu("Auto third", "bambu_x1c", "192.168.1.82", "20000003"),
	}
	for _, machine := range cameras {
		g.expect(
			g.as(
				g.admin,
				http.MethodPost,
				"/streaming-gateways/"+gatewayID+"/cameras",
				map[string]any{"machineId": machine.String(), "enabled": true},
			),
			http.StatusCreated,
		)
	}
	noCamera := g.bambu("Auto without camera", "bambu_h2d", "192.168.1.83", "20000004")

	input := sceneInput("Auto camera", "full")
	input.Zones = map[string]json.RawMessage{"main": autoCameraWidget(cameras["first"], cameras["second"])}
	scene, err := svc.CreateScene(ctx, admin, input, nil)
	if err != nil {
		t.Fatal(err)
	}
	display, player := g.pair(staff, "Auto display", g.fixture.playlist(t, "Auto", scene.ID).ID)
	displayID := display["id"].(string)
	live := func() map[string]any {
		return g.expect(g.do(player, "", http.MethodGet, "/signage/player/live", nil), http.StatusOK)
	}
	streamMachines := func() map[string]bool {
		result := map[string]bool{}
		for _, raw := range live()["streams"].([]any) {
			result[raw.(map[string]any)["machineId"].(string)] = true
		}
		return result
	}
	liveMachines := func() map[string]bool {
		result := map[string]bool{}
		for _, raw := range live()["machines"].([]any) {
			result[raw.(map[string]any)["machineId"].(string)] = true
		}
		return result
	}
	publish := func() {
		g.expect(g.as(staff, http.MethodPost, "/signage/displays/"+displayID+"/publish", nil), http.StatusOK)
	}
	update := func(version int64, widget json.RawMessage) {
		t.Helper()
		next := sceneInput("Auto camera", "full")
		next.Zones = map[string]json.RawMessage{"main": widget}
		if _, err := svc.UpdateScene(ctx, admin, scene.ID, version, next, nil); err != nil {
			t.Fatal(err)
		}
	}
	publish()

	// Restricted list: tickets and live status only for the allowed machines.
	streams := streamMachines()
	if len(streams) != 2 || !streams[cameras["first"].String()] || !streams[cameras["second"].String()] ||
		streams[cameras["third"].String()] {
		t.Fatalf("restricted streams = %v", streams)
	}
	if machines := liveMachines(); len(machines) != 2 || !machines[cameras["first"].String()] ||
		!machines[cameras["second"].String()] {
		t.Fatalf("restricted live machines = %v", machines)
	}

	// A draft change is not served until published; then the new list applies.
	update(1, autoCameraWidget(cameras["third"]))
	if streams = streamMachines(); len(streams) != 2 || streams[cameras["third"].String()] {
		t.Fatalf("draft leaked: %v", streams)
	}
	publish()
	if streams = streamMachines(); len(streams) != 1 || !streams[cameras["third"].String()] {
		t.Fatalf("after changing the list: %v", streams)
	}

	// An empty list means every machine with a camera, and only those.
	update(2, autoCameraWidget())
	publish()
	streams = streamMachines()
	if len(streams) != 3 || streams[noCamera.String()] {
		t.Fatalf("unrestricted streams = %v", streams)
	}
	if machines := liveMachines(); len(machines) != 3 {
		t.Fatalf("unrestricted live machines = %v", machines)
	}

	// Validation: unknown machines and duplicates are refused; a stored scene without the field works.
	bad := sceneInput("Auto camera", "full")
	bad.Zones = map[string]json.RawMessage{"main": autoCameraWidget(ids.New())}
	if _, err := svc.UpdateScene(ctx, admin, scene.ID, 3, bad, nil); err == nil {
		t.Fatal("unknown camera machine accepted")
	}
	bad.Zones = map[string]json.RawMessage{"main": autoCameraWidget(cameras["first"], cameras["first"])}
	if _, err := svc.UpdateScene(ctx, admin, scene.ID, 3, bad, nil); err == nil {
		t.Fatal("duplicate camera machines accepted")
	}
	if _, err := g.pool.Exec(
		ctx,
		`UPDATE signage_scenes SET zones = jsonb_set(zones, '{main}', (zones->'main') - 'machineIds') WHERE id = $1`,
		scene.ID,
	); err != nil {
		t.Fatal(err)
	}
	publish()
	if streams = streamMachines(); len(streams) != 3 {
		t.Fatalf("scene stored without machineIds: %v", streams)
	}
}
