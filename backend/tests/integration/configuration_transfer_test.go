package integration_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
)

func TestConfigurationTransferHTTPRoundTrip(t *testing.T) {
	e := newSignageEnv(t)
	admin := e.staff("ct-admin", authorization.ConfigurationExport, authorization.ConfigurationImport,
		authorization.ManagedDevicesRead, authorization.ManagedDevicesManage)
	if _, err := e.pool.Exec(testContext(t), `INSERT INTO device_types (id, name) VALUES ($1, 'Kiosk')`, ids.New()); err != nil {
		t.Fatal(err)
	}

	response, body := e.rawGet(admin.client, "/configuration-transfer/export?sections=deviceTypes")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("export status = %d: %s", response.StatusCode, body)
	}
	if response.Header.Get("Cache-Control") != "no-store" ||
		!strings.HasPrefix(response.Header.Get("Content-Disposition"), "attachment") ||
		!strings.Contains(response.Header.Get("Content-Disposition"), ".json") {
		t.Fatalf("export headers = %v", response.Header)
	}
	var exported map[string]any
	if err := json.Unmarshal(body, &exported); err != nil || exported["format"] != "makerspace-core-config" {
		t.Fatalf("export body = %s", body)
	}

	if _, err := e.pool.Exec(testContext(t), `UPDATE device_types SET description = 'changed' WHERE name = 'Kiosk'`); err != nil {
		t.Fatal(err)
	}
	preview := e.expect(e.doRaw(admin.client, admin.csrf, http.MethodPost,
		"/configuration-transfer/import/preview?mode=overwrite&sections=deviceTypes", body), http.StatusOK)
	fingerprint, _ := preview["fingerprint"].(string)
	if preview["applied"] != false || len(fingerprint) != 64 {
		t.Fatalf("preview = %v", preview)
	}
	applied := e.expect(e.doRaw(admin.client, admin.csrf, http.MethodPost,
		"/configuration-transfer/import/apply?mode=overwrite&sections=deviceTypes&fingerprint="+fingerprint, body),
		http.StatusOK)
	if applied["applied"] != true {
		t.Fatalf("apply = %v", applied)
	}
	var description *string
	if err := e.pool.QueryRow(testContext(t), `SELECT description FROM device_types WHERE name = 'Kiosk'`).
		Scan(&description); err != nil || description != nil {
		t.Fatalf("description after overwrite = %v, %v", description, err)
	}
	// The same fingerprint is stale once the import changed the section.
	e.expectCode(e.doRaw(admin.client, admin.csrf, http.MethodPost,
		"/configuration-transfer/import/apply?mode=overwrite&sections=deviceTypes&fingerprint="+fingerprint, body),
		http.StatusConflict, "configuration_changed")

	reader := e.staff("ct-reader", authorization.ManagedDevicesRead, authorization.ManagedDevicesManage)
	response, _ = e.rawGet(reader.client, "/configuration-transfer/export?sections=deviceTypes")
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("export without configuration.export = %d", response.StatusCode)
	}
	e.expectCode(e.doRaw(reader.client, reader.csrf, http.MethodPost,
		"/configuration-transfer/import/preview?mode=overwrite&sections=deviceTypes", body),
		http.StatusForbidden, "permission_denied")
	e.expectCode(e.doRaw(admin.client, "", http.MethodPost,
		"/configuration-transfer/import/preview?mode=overwrite&sections=deviceTypes", body),
		http.StatusForbidden, "csrf_invalid")
}
