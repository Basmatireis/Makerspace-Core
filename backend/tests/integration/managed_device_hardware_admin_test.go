package integration_test

import (
	"errors"
	"slices"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
)

func TestAdministratorReadsConfiguredReportedAndEffectiveDeviceCapabilities(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	admin := seedAccount(t, pool, "hardware-admin-read", true)
	master := authorization.Principal{AccountID: admin.accountID, PersonID: admin.personID, Master: true}
	service := manageddevices.NewService(pool)
	deviceType, err := service.CreateType(ctx, master, "Reporting tablet", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	var policyID uuid.UUID
	if err = pool.QueryRow(ctx, `SELECT id FROM session_policies WHERE name='Entrance terminal'`).Scan(&policyID); err != nil {
		t.Fatal(err)
	}
	created, err := service.CreateConfigured(
		ctx, master, "Reporting kiosk", deviceType.ID, nil,
		manageddevices.DeviceSettings{
			SessionPolicyID: &policyID, KioskEnabled: true,
			AllowedApplicationModes: []manageddevices.ApplicationMode{"visitor_terminal"},
			CheckInAssurance:        "low", CheckOutAssurance: "low", CheckoutMode: "verified",
			Capabilities: []string{"nfc", "camera", "file_upload"},
		},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}

	never, err := service.GetHardware(ctx, master, created.Device.ID)
	if err != nil || never.Platform != nil || len(never.ReportedCapabilities) != 0 {
		t.Fatalf("a device that never reported has no report: %#v err=%v", never, err)
	}
	if _, err = service.ReportHardware(
		ctx,
		manageddevices.DeviceContext{ID: created.Device.ID, Name: created.Device.Name},
		manageddevices.HardwareReport{
			Platform: manageddevices.PlatformAndroid, BridgeVersion: "1.2.3", Capabilities: []string{"nfc"},
		},
		nil,
	); err != nil {
		t.Fatal(err)
	}
	reported, err := service.GetHardware(ctx, master, created.Device.ID)
	if err != nil || reported.Platform == nil || reported.BridgeVersion == nil || *reported.BridgeVersion != "1.2.3" {
		t.Fatalf("report metadata: %#v err=%v", reported, err)
	}
	if !slices.Equal(reported.ReportedCapabilities, []string{"nfc"}) ||
		!slices.Contains(reported.ConfiguredCapabilities, "camera") ||
		slices.Contains(reported.EffectiveCapabilities, "camera") ||
		!slices.Contains(reported.EffectiveCapabilities, "nfc") ||
		!slices.Contains(reported.EffectiveCapabilities, "file_upload") {
		t.Fatalf("effective must be configured intersected with reported plus file_upload: %#v", reported)
	}

	// A principal without managed_devices.read (not master, no grants) must not see device hardware.
	if _, err = service.GetHardware(
		ctx, authorization.Principal{AccountID: admin.accountID, PersonID: admin.personID}, created.Device.ID,
	); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("reading hardware without managed_devices.read must be denied, got %v", err)
	}
	if _, err = service.GetHardware(ctx, master, ids.New()); !errors.Is(err, apperror.NotFound) {
		t.Fatalf("unknown device must be not found, got %v", err)
	}
}
