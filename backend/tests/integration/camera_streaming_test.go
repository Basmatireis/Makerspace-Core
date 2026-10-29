package integration_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/google/uuid"
)

var bambuSettings = map[string]any{"ipAddress": "192.168.1.90", "serialNumber": "01P00A000000001", "autoDetectSpools": false}

func assignmentUpdate(kind string, camera any, version float64, end bool) map[string]any {
	body := map[string]any{
		"adapterKind": kind, "adapterSchemaVersion": 1, "settings": bambuSettings,
		"enabled": true, "end": end, "expectedVersion": version,
	}
	if camera != nil {
		body["cameraStreaming"] = camera
	}
	return body
}

func (g *connectorEnv) assignmentOf(connectorID, machineID uuid.UUID) map[string]any {
	g.t.Helper()
	list := g.expect(g.as(g.admin, http.MethodGet, "/printer-connectors/"+connectorID.String()+"/assignments", nil), http.StatusOK)
	for _, item := range list["items"].([]any) {
		assignment := item.(map[string]any)
		if assignment["machineId"] == machineID.String() && assignment["endedAt"] == nil {
			return assignment
		}
	}
	g.t.Fatalf("no active assignment for machine %s", machineID)
	return nil
}

func TestCameraStreamingAssignmentValidationAndPermission(t *testing.T) {
	g := newConnectorEnv(t)
	machine, connector := g.bambuWithConnector("Camera printer", "bambu_h2d", "192.168.1.90", "30000001")
	base := "/printer-connectors/" + connector.String() + "/assignments"
	assignment := g.assignmentOf(connector, machine)
	path := base + "/" + assignment["id"].(string)
	if assignment["cameraStreaming"] != false || assignment["camera"].(map[string]any)["health"] != "unknown" {
		t.Fatalf("default assignment = %v", assignment)
	}

	// Without printer_connectors.manage the camera switch is refused and nothing changes.
	reader := g.staff("cam-read-"+uuid.NewString()[:6], authorization.PrinterConnectorsRead, authorization.MachinesManage)
	g.expectCode(
		g.as(reader, http.MethodPatch, path, assignmentUpdate("bambu_h2d", true, assignment["version"].(float64), false)),
		http.StatusForbidden, "permission_denied",
	)
	if again := g.assignmentOf(connector, machine); again["cameraStreaming"] != false {
		t.Fatalf("camera changed without permission: %v", again)
	}

	// A non-Bambu adapter cannot stream a camera.
	g.expectCode(
		g.as(g.admin, http.MethodPatch, path, assignmentUpdate("other_adapter", true, assignment["version"].(float64), false)),
		http.StatusUnprocessableEntity, "validation_failed",
	)

	// Switching on is audited with the assignment update and bumps the configuration.
	updated := g.expect(
		g.as(g.admin, http.MethodPatch, path, assignmentUpdate("bambu_h2d", true, assignment["version"].(float64), false)),
		http.StatusOK,
	)
	if updated["cameraStreaming"] != true || updated["camera"].(map[string]any)["health"] != "unknown" ||
		updated["configurationVersion"].(float64) <= assignment["configurationVersion"].(float64) {
		t.Fatalf("updated = %v", updated)
	}
	var changed []string
	if err := g.pool.QueryRow(testContext(t),
		`SELECT changed_fields FROM audit_events WHERE action = 'printer_connector.assignment_updated' AND resource_id = $1`,
		assignment["id"].(string)).Scan(&changed); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, field := range changed {
		found = found || field == "cameraStreaming"
	}
	if !found {
		t.Fatalf("audit changed fields = %v", changed)
	}

	// Omitting the field keeps it; moving a streaming assignment to a non-Bambu adapter is refused.
	kept := g.expect(
		g.as(g.admin, http.MethodPatch, path, assignmentUpdate("bambu_h2d", nil, updated["version"].(float64), false)),
		http.StatusOK,
	)
	if kept["cameraStreaming"] != true {
		t.Fatalf("omitted cameraStreaming changed the value: %v", kept)
	}
	g.expectCode(
		g.as(g.admin, http.MethodPatch, path, assignmentUpdate("other_adapter", nil, kept["version"].(float64), false)),
		http.StatusUnprocessableEntity, "validation_failed",
	)

	// Ending the assignment switches the camera off; creation validates the adapter the same way.
	ended := g.expect(
		g.as(g.admin, http.MethodPatch, path, assignmentUpdate("bambu_h2d", nil, kept["version"].(float64), true)),
		http.StatusOK,
	)
	if ended["cameraStreaming"] != false {
		t.Fatalf("ended assignment still streams: %v", ended)
	}
	create := func(kind string, camera any) *http.Response {
		body := map[string]any{
			"machineId": machine.String(), "adapterKind": kind, "adapterSchemaVersion": 1,
			"settings": bambuSettings, "secrets": map[string]string{"lanAccessCode": "30000001"}, "enabled": true,
		}
		if camera != nil {
			body["cameraStreaming"] = camera
		}
		return g.as(g.admin, http.MethodPost, base, body)
	}
	g.expectCode(create("other_adapter", true), http.StatusUnprocessableEntity, "validation_failed")
	g.expectCode(
		g.as(reader, http.MethodPost, base, map[string]any{
			"machineId": machine.String(), "adapterKind": "bambu_x1c", "adapterSchemaVersion": 1,
			"settings": bambuSettings, "secrets": map[string]string{"lanAccessCode": "30000001"}, "enabled": true,
			"cameraStreaming": true,
		}),
		http.StatusForbidden, "permission_denied",
	)
	created := g.expect(create("bambu_x1c", true), http.StatusCreated)
	if created["cameraStreaming"] != true || created["camera"].(map[string]any)["health"] != "unknown" {
		t.Fatalf("created = %v", created)
	}
	// The default is off.
	if _, err := g.pool.Exec(testContext(t), `UPDATE printer_connector_assignments SET ended_at = now(), enabled = false WHERE id = $1`, created["id"]); err != nil {
		t.Fatal(err)
	}
	if plain := g.expect(create("bambu_h2d", nil), http.StatusCreated); plain["cameraStreaming"] != false {
		t.Fatalf("default = %v", plain)
	}
}

func TestConnectorHeartbeatStoresAndReportsCameraHealth(t *testing.T) {
	g := newConnectorEnv(t)
	machine, connector := g.bambuWithConnector("Heartbeat camera printer", "bambu_h2d", "192.168.1.91", "30000002")
	other, otherConnector := g.bambuWithConnector("No camera printer", "bambu_x1c", "192.168.1.92", "30000003")
	_ = otherConnector
	assignment := g.assignmentOf(connector, machine)
	id := assignment["id"].(string)
	if _, err := g.pool.Exec(testContext(t), `UPDATE printer_connector_assignments SET camera_streaming = true WHERE id = $1`, id); err != nil {
		t.Fatal(err)
	}
	var otherAssignment uuid.UUID
	if err := g.pool.QueryRow(testContext(t), `SELECT id FROM printer_connector_assignments WHERE machine_id = $1`, other).Scan(&otherAssignment); err != nil {
		t.Fatal(err)
	}

	issue := g.expect(g.as(g.admin, http.MethodPost, "/printer-connectors/"+connector.String()+"/enrollments", nil), http.StatusCreated)
	credID, token := g.newCredential()
	g.expect(g.bearer(issue["enrollmentSecret"].(string), http.MethodPost, "/printer-connector/enroll", map[string]any{
		"credentialId": credID, "credentialSecret": token, "softwareVersion": "test", "protocolVersion": 1,
	}), http.StatusOK)

	// The configuration snapshot carries the switch.
	configuration := g.expect(g.bearer(token, http.MethodGet, "/printer-connector/self/configuration", nil), http.StatusOK)
	entries := configuration["assignments"].([]any)
	if len(entries) != 1 || entries[0].(map[string]any)["cameraStreaming"] != true {
		t.Fatalf("configuration assignments = %v", entries)
	}

	beat := func(cameras any) *http.Response {
		body := updatableConnector.heartbeat("0.11.1", nil)
		if cameras != nil {
			body["cameras"] = cameras
		}
		return g.bearer(token, http.MethodPost, "/printer-connector/self/heartbeat", body)
	}
	// Nothing reported yet: unknown.
	if camera := g.assignmentOf(connector, machine)["camera"].(map[string]any); camera["health"] != "unknown" || camera["reportedAt"] != nil {
		t.Fatalf("before any report: %v", camera)
	}
	g.expect(beat([]any{map[string]any{"assignmentId": id, "health": "live", "viewers": 3}}), http.StatusOK)
	camera := g.assignmentOf(connector, machine)["camera"].(map[string]any)
	if camera["health"] != "live" || camera["viewers"] != float64(3) || camera["reportedAt"] == nil {
		t.Fatalf("after report: %v", camera)
	}
	// Invalid entries are refused; reports for assignments that do not stream are ignored.
	g.expect(beat([]any{map[string]any{"assignmentId": id, "health": "unknown", "viewers": 0}}), http.StatusBadRequest)
	g.expectCode(beat([]any{map[string]any{"assignmentId": id, "health": "live", "viewers": 100001}}), http.StatusBadRequest, "invalid_request")
	g.expect(beat([]any{map[string]any{"assignmentId": otherAssignment.String(), "health": "live", "viewers": 1}}), http.StatusOK)
	var stored *string
	if err := g.pool.QueryRow(testContext(t), `SELECT camera_health FROM printer_connector_assignments WHERE id = $1`, otherAssignment).Scan(&stored); err != nil || stored != nil {
		t.Fatalf("another connector's or non-streaming assignment stored a camera: %v %v", stored, err)
	}
	// Reports not renewed for two minutes count as unknown.
	if _, err := g.pool.Exec(testContext(t), `UPDATE printer_connector_assignments SET camera_reported_at = $2 WHERE id = $1`, id, time.Now().Add(-3*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if camera = g.assignmentOf(connector, machine)["camera"].(map[string]any); camera["health"] != "unknown" || camera["viewers"] != float64(0) {
		t.Fatalf("stale report: %v", camera)
	}
	// Switching the camera off clears the reported state.
	g.expect(beat([]any{map[string]any{"assignmentId": id, "health": "idle", "viewers": 0}}), http.StatusOK)
	current := g.assignmentOf(connector, machine)
	g.expect(
		g.as(g.admin, http.MethodPatch, "/printer-connectors/"+connector.String()+"/assignments/"+id,
			assignmentUpdate("bambu_h2d", false, current["version"].(float64), false)),
		http.StatusOK,
	)
	var health *string
	var viewers int
	if err := g.pool.QueryRow(testContext(t), `SELECT camera_health, camera_viewers FROM printer_connector_assignments WHERE id = $1`, id).Scan(&health, &viewers); err != nil ||
		health != nil || viewers != 0 {
		t.Fatalf("camera state after switching off: %v %d %v", health, viewers, err)
	}
}
