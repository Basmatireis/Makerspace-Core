package integration_test

import (
	"net/http"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/admin"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/laborordnung"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
)

// The confirmation a person gives at the tablet check-in must reach the confirmation history through the real HTTP
// path (password check-in with a managed device), not only through the service.
func TestKioskCheckInOverHTTPRecordsConfirmationInHistory(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	accountID, err := admin.NewService(pool).BootstrapMaster(ctx, admin.BootstrapInput{
		FirstName: "Tablet", LastName: "Member", LoginEmail: "tablet-member@example.test", Password: bootstrapPassword,
	})
	if err != nil {
		t.Fatal(err)
	}
	var personID uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT person_id FROM accounts WHERE id=$1`, accountID).Scan(&personID); err != nil {
		t.Fatal(err)
	}
	roleID := ids.New()
	if _, err = pool.Exec(
		ctx, `INSERT INTO roles (id,name,laborordnung_mode) VALUES ($1,'Tablet role','blocking')`, roleID,
	); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO person_roles (person_id,role_id) VALUES ($1,$2)`, personID, roleID); err != nil {
		t.Fatal(err)
	}
	versionID := insertPublishedLabRulesVersion(t, pool, accountID, "2026.3")

	devices := manageddevices.NewService(pool)
	principal := authorization.Principal{AccountID: accountID, PersonID: personID, Master: true}
	deviceType, err := devices.CreateType(ctx, principal, "Tablet type", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	var policyID uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT id FROM session_policies WHERE name='Entrance terminal'`).Scan(&policyID); err != nil {
		t.Fatal(err)
	}
	device, err := devices.CreateConfigured(ctx, principal, "Entrance tablet", deviceType.ID, nil, manageddevices.DeviceSettings{
		SessionPolicyID: &policyID, KioskEnabled: true,
		AllowedApplicationModes: []manageddevices.ApplicationMode{"visitor_terminal"},
		CheckInAssurance:        "low", CheckOutAssurance: "low", KioskResetSeconds: 60,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}

	server := newManagedDeviceHTTPServer(t, pool, testOrigin)
	defer server.Close()
	client := newCookieClient(t)
	post := func(payload map[string]any) int {
		response := doJSONWithDevice(
			t, client, http.MethodPost, server.URL+"/api/v1/terminal/check-in/password", testOrigin, "", device.Token, payload,
		)
		defer func() { _ = response.Body.Close() }()
		return response.StatusCode
	}
	credentials := map[string]any{"email": "tablet-member@example.test", "password": bootstrapPassword}
	if status := post(credentials); status != http.StatusConflict {
		t.Fatalf("check-in without confirmation: %d, want 409", status)
	}
	credentials["confirmLabRulesVersionId"] = versionID.String()
	if status := post(credentials); status != http.StatusCreated {
		t.Fatalf("check-in with confirmation: %d, want 201", status)
	}

	items, total, err := laborordnung.NewService(pool, notifyrules.NewSystemEvents(nil), nil).ListConfirmations(
		ctx, principal, laborordnung.ConfirmationFilters{
			PersonID: &personID, Sort: laborordnung.ConfirmationSortConfirmedAt, Descending: true, Page: 1, PageSize: 25,
		})
	if err != nil || total != 1 || len(items) != 1 {
		t.Fatalf("history: total=%d items=%#v err=%v", total, items, err)
	}
	if items[0].Method != laborordnung.MethodKiosk || items[0].VersionID != versionID {
		t.Fatalf("history entry=%#v, want the kiosk confirmation of the current version", items[0])
	}
}
