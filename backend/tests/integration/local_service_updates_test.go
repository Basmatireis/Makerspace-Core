package integration_test

import (
	"net/http"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/google/uuid"
)

const testCoreVersion = "0.9.0"

func newReleasedConnectorEnv(t *testing.T) *connectorEnv {
	t.Helper()
	return newConnectorEnvWith(t, func(cfg *config.Config) { cfg.Version = testCoreVersion })
}

// localService is one kind of updatable local service for the shared update scenario.
type localService struct {
	kind          string // audit resource prefix
	listPath      string
	itemPath      func(id string) string
	configPath    string
	heartbeatPath string
	heartbeat     func(version string, updater any) map[string]any
}

var updatableConnector = localService{
	kind:          "printer_connector",
	listPath:      "/printer-connectors",
	itemPath:      func(id string) string { return "/printer-connectors/" + id },
	configPath:    "/printer-connector/self/configuration",
	heartbeatPath: "/printer-connector/self/heartbeat",
	heartbeat: func(version string, updater any) map[string]any {
		body := map[string]any{
			"softwareVersion":              version,
			"protocolVersion":              1,
			"appliedConfigurationRevision": 0,
			"healthState":                  "connected",
			"healthSummary":                nil,
			"pendingEventCount":            0,
			"quarantinedEventCount":        0,
			"assignments":                  []any{},
		}
		if updater != nil {
			body["updater"] = updater
		}
		return body
	},
}

func (g *connectorEnv) runUpdateScenario(t *testing.T, spec localService, id, token string, manage, denied staffSession) {
	t.Helper()
	ctx := testContext(t)
	beat := func(version string, updater any) map[string]any {
		t.Helper()
		return g.expect(g.bearer(token, http.MethodPost, spec.heartbeatPath, spec.heartbeat(version, updater)), http.StatusOK)
	}
	request := func(staff staffSession, target string) *http.Response {
		return g.as(staff, http.MethodPost, spec.itemPath(id)+"/update", map[string]any{"targetVersion": target})
	}
	report := func(requestID any, status string, reason any) map[string]any {
		return map[string]any{
			"available": true,
			"result":    map[string]any{"requestId": requestID, "status": status, "reason": reason},
		}
	}

	list := g.expect(g.as(manage, http.MethodGet, spec.listPath, nil), http.StatusOK)
	if list["coreVersion"] != testCoreVersion {
		t.Fatalf("coreVersion = %v", list["coreVersion"])
	}
	// Without an updater sidecar the update must be done by hand.
	if item := beat("0.8.3", nil); item["updaterAvailable"] != false || item["update"] != nil {
		t.Fatalf("without updater: %v", item)
	}
	g.expectCode(request(manage, testCoreVersion), http.StatusConflict, "updater_unavailable")
	if item := beat("0.8.3", map[string]any{"available": true, "result": nil}); item["updaterAvailable"] != true {
		t.Fatalf("with updater: %v", item)
	}

	// Authorization and the version contract.
	g.expectCode(request(denied, testCoreVersion), http.StatusForbidden, "permission_denied")
	g.expectCode(request(manage, "0.8.9"), http.StatusConflict, "update_target_mismatch")
	g.expectCode(request(manage, "v0.9.0"), http.StatusBadRequest, "invalid_request")
	g.expectCode(
		g.as(manage, http.MethodPost, spec.itemPath(uuid.Must(uuid.NewV7()).String())+"/update",
			map[string]any{"targetVersion": testCoreVersion}),
		http.StatusNotFound,
		"not_found",
	)
	if count := g.countAudit(spec.kind + ".update_requested"); count != 0 {
		t.Fatalf("refused requests were audited: %d", count)
	}

	requested := g.expect(request(manage, testCoreVersion), http.StatusOK)
	first := requested["update"].(map[string]any)
	if first["status"] != "requested" || first["targetVersion"] != testCoreVersion || first["reason"] != nil {
		t.Fatalf("requested: %v", first)
	}
	var actor uuid.UUID
	if err := g.pool.QueryRow(
		ctx,
		`SELECT actor_account_id FROM audit_events WHERE action = $1 AND resource_id = $2`,
		spec.kind+".update_requested",
		id,
	).Scan(&actor); err != nil || actor == uuid.Nil {
		t.Fatalf("audit: %v %v", actor, err)
	}
	g.expectCode(request(manage, testCoreVersion), http.StatusConflict, "update_in_progress")
	offer, ok := g.expect(g.bearer(token, http.MethodGet, spec.configPath, nil), http.StatusOK)["update"].(map[string]any)
	if !ok || offer["requestId"] != first["requestId"] || offer["version"] != testCoreVersion {
		t.Fatalf("configuration offer: %v", offer)
	}

	// Results of other requests are ignored; the current one moves the status.
	if item := beat("0.8.3", report(uuid.Must(uuid.NewV7()).String(), "failed", "pull_failed")); item["update"].(map[string]any)["status"] != "requested" {
		t.Fatalf("foreign result applied: %v", item["update"])
	}
	if item := beat("0.8.3", report(first["requestId"], "in_progress", nil)); item["update"].(map[string]any)["status"] != "in_progress" {
		t.Fatalf("in progress: %v", item["update"])
	}
	failed := beat("0.8.3", report(first["requestId"], "failed", "pull_failed"))["update"].(map[string]any)
	if failed["status"] != "failed" || failed["reason"] != "pull_failed" {
		t.Fatalf("failed: %v", failed)
	}
	if offer := g.expect(g.bearer(token, http.MethodGet, spec.configPath, nil), http.StatusOK)["update"]; offer != nil {
		t.Fatalf("a failed request is still offered: %v", offer)
	}
	// A failed update stays failed until staff ask again; the new request has a new ID.
	second := g.expect(request(manage, testCoreVersion), http.StatusOK)["update"].(map[string]any)
	if second["requestId"] == first["requestId"] || second["status"] != "requested" {
		t.Fatalf("second request: %v", second)
	}
	done := beat(testCoreVersion, report(second["requestId"], "succeeded", nil))
	if done["update"].(map[string]any)["status"] != "succeeded" || done["softwareVersion"] != testCoreVersion {
		t.Fatalf("succeeded: %v", done)
	}
	g.expectCode(request(manage, testCoreVersion), http.StatusConflict, "update_not_newer")
	if count := g.countAudit(spec.kind + ".update_requested"); count != 2 {
		t.Fatalf("audited requests: %d", count)
	}
}

func TestPrinterConnectorUpdateRequestAndStatus(t *testing.T) {
	g := newReleasedConnectorEnv(t)
	g.admin = g.staff("pcm-"+uuid.NewString()[:8], authorization.PrinterConnectorsRead, authorization.PrinterConnectorsManage,
		authorization.PrinterConnectorsCredentialsManage)
	id, token := g.enrolledConnector("Updatable connector")
	reader := g.staff("pcr-"+uuid.NewString()[:8], authorization.PrinterConnectorsRead)
	g.runUpdateScenario(t, updatableConnector, id, token, g.admin, reader)
}

func TestDevelopmentCoreOffersNoUpdates(t *testing.T) {
	g := newConnectorEnv(t)
	id, token := g.enrolledConnector("Dev connector")
	g.expect(g.bearer(token, http.MethodPost, updatableConnector.heartbeatPath,
		updatableConnector.heartbeat("0.8.3", map[string]any{"available": true, "result": nil})), http.StatusOK)
	g.expectCode(
		g.as(g.admin, http.MethodPost, "/printer-connectors/"+id+"/update", map[string]any{"targetVersion": "0.9.0"}),
		http.StatusConflict,
		"core_version_unreleased",
	)
}
