package integration_test

import (
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type cameraKiosk struct {
	id     uuid.UUID
	device manageddevices.DeviceContext
}

// newCameraKiosk registers an active kiosk; withCamera configures the camera capability.
func newCameraKiosk(
	t *testing.T,
	pool *pgxpool.Pool,
	service *manageddevices.Service,
	admin authorization.Principal,
	typeID uuid.UUID,
	name string,
	withCamera bool,
) cameraKiosk {
	t.Helper()
	ctx := testContext(t)
	issued, err := service.Create(ctx, admin, name, typeID, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `UPDATE managed_devices SET terminal_enabled=true,
		allowed_app_modes=ARRAY['visitor_terminal']::text[],
		session_policy_id=(SELECT id FROM session_policies ORDER BY id LIMIT 1) WHERE id=$1`, issued.Device.ID); err != nil {
		t.Fatal(err)
	}
	if withCamera {
		if _, err = pool.Exec(ctx, `INSERT INTO managed_device_capabilities(managed_device_id, capability)
			VALUES($1,'camera')`, issued.Device.ID); err != nil {
			t.Fatal(err)
		}
	}
	device, err := service.Authenticate(ctx, issued.Token)
	if err != nil || device == nil {
		t.Fatalf("authenticate kiosk: %v %v", device, err)
	}
	return cameraKiosk{id: issued.Device.ID, device: *device}
}

func wantAppError(t *testing.T, err error, status int, code string) {
	t.Helper()
	var appErr *apperror.Error
	if !errors.As(err, &appErr) || appErr.HTTPStatus != status || (code != "" && appErr.Code != code) {
		t.Fatalf("want %d %s, got %v", status, code, err)
	}
}

func TestKioskCameraCalibrationWindow(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	account := seedAccount(t, pool, "camera-admin", true)
	master := authorization.Principal{AccountID: account.accountID, PersonID: account.personID, Master: true}
	reader, _ := principalWithPermissions(t, pool, "camera-reader", string(authorization.ManagedDevicesRead))
	manager, _ := principalWithPermissions(t, pool, "camera-manager",
		string(authorization.ManagedDevicesRead), string(authorization.ManagedDevicesManage))
	service := manageddevices.NewService(pool)
	deviceType, err := service.CreateType(ctx, master, "Entrance tablet", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	kiosk := newCameraKiosk(t, pool, service, master, deviceType.ID, "Entrance", true)
	other := newCameraKiosk(t, pool, service, master, deviceType.ID, "Side door", true)
	noCamera := newCameraKiosk(t, pool, service, master, deviceType.ID, "No camera", false)
	calibrated := manageddevices.CameraSettings{
		Crop:      &manageddevices.CameraCrop{CenterX: 0.62, CenterY: 0.45, Size: 0.7},
		Indicator: &manageddevices.CameraIndicator{Edge: manageddevices.IndicatorEdgeTop, Offset: 61.5},
	}

	// Defaults until anything is set; reading needs managed_devices.read.
	if camera, err := service.GetCamera(ctx, reader, kiosk.id); err != nil || camera.Crop != nil ||
		camera.Indicator != nil || camera.CalibrationExpiresAt != nil {
		t.Fatalf("default camera = %+v, %v", camera, err)
	}
	if _, err = service.GetCamera(ctx, authorization.Principal{AccountID: account.accountID}, kiosk.id); !errors.Is(
		err, apperror.PermissionDenied) {
		t.Fatalf("read without permission: %v", err)
	}

	// Without an open window the device credential cannot save or cancel.
	_, err = service.SaveKioskCameraCalibration(ctx, kiosk.device, calibrated, nil)
	wantAppError(t, err, http.StatusConflict, "camera_calibration_closed")
	err = service.CancelKioskCameraCalibration(ctx, kiosk.device, nil)
	wantAppError(t, err, http.StatusConflict, "camera_calibration_closed")

	// Starting needs managed_devices.manage and a kiosk with a camera.
	if _, err = service.StartCameraCalibration(ctx, reader, kiosk.id, nil); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("start without manage: %v", err)
	}
	_, err = service.StartCameraCalibration(ctx, manager, noCamera.id, nil)
	wantAppError(t, err, http.StatusUnprocessableEntity, "camera_not_configured")
	if _, err = service.StartCameraCalibration(ctx, manager, uuid.New(), nil); !errors.Is(err, apperror.NotFound) {
		t.Fatalf("start on unknown device: %v", err)
	}
	started, err := service.StartCameraCalibration(ctx, manager, kiosk.id, nil)
	if err != nil || started.CalibrationExpiresAt == nil ||
		time.Until(*started.CalibrationExpiresAt) > manageddevices.CameraCalibrationWindow+time.Minute {
		t.Fatalf("start = %+v, %v", started, err)
	}
	if context, err := service.KioskCamera(ctx, kiosk.id); err != nil || context.CalibrationExpiresAt == nil {
		t.Fatalf("kiosk does not see the open window: %+v %v", context, err)
	}

	// The window belongs to one device: another kiosk's credential cannot use it.
	_, err = service.SaveKioskCameraCalibration(ctx, other.device, calibrated, nil)
	wantAppError(t, err, http.StatusConflict, "camera_calibration_closed")

	// Ranges are validated before anything is stored.
	for name, invalid := range map[string]manageddevices.CameraSettings{
		"centre":      {Crop: &manageddevices.CameraCrop{CenterX: 1.2, CenterY: 0.5, Size: 0.5}},
		"small crop":  {Crop: &manageddevices.CameraCrop{CenterX: 0.5, CenterY: 0.5, Size: 0.1}},
		"large crop":  {Crop: &manageddevices.CameraCrop{CenterX: 0.5, CenterY: 0.5, Size: 1.5}},
		"edge":        {Indicator: &manageddevices.CameraIndicator{Edge: "middle", Offset: 50}},
		"offset":      {Indicator: &manageddevices.CameraIndicator{Edge: manageddevices.IndicatorEdgeLeft, Offset: 100.5}},
		"neg. offset": {Indicator: &manageddevices.CameraIndicator{Edge: manageddevices.IndicatorEdgeLeft, Offset: -1}},
	} {
		_, err = service.SaveKioskCameraCalibration(ctx, kiosk.device, invalid, nil)
		wantAppError(t, err, http.StatusUnprocessableEntity, "validation_failed")
		_, err = service.UpdateCamera(ctx, manager, kiosk.id, invalid, nil)
		wantAppError(t, err, http.StatusUnprocessableEntity, "validation_failed")
		_ = name
	}

	// Saving inside the window stores the values and closes it: the credential is good for one save.
	saved, err := service.SaveKioskCameraCalibration(ctx, kiosk.device, calibrated, nil)
	if err != nil || saved.Crop == nil || *saved.Crop != *calibrated.Crop || *saved.Indicator != *calibrated.Indicator {
		t.Fatalf("save = %+v, %v", saved, err)
	}
	_, err = service.SaveKioskCameraCalibration(ctx, kiosk.device, manageddevices.CameraSettings{}, nil)
	wantAppError(t, err, http.StatusConflict, "camera_calibration_closed")
	if camera, err := service.GetCamera(ctx, reader, kiosk.id); err != nil || camera.CalibrationExpiresAt != nil ||
		camera.Crop == nil || camera.Crop.CenterX != 0.62 || camera.Indicator.Offset != 61.5 {
		t.Fatalf("after save = %+v, %v", camera, err)
	}
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action='managed_device.camera_calibration_started'
		AND resource_id=$1 AND actor_account_id=$2`, 1, kiosk.id, manager.AccountID)
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action='managed_device.camera_calibrated'
		AND resource_id=$1`, 1, kiosk.id)

	// An expired window is refused although nobody closed it.
	if _, err = service.StartCameraCalibration(ctx, manager, kiosk.id, nil); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `UPDATE managed_device_camera_settings
		SET calibration_expires_at = now() - interval '1 second' WHERE managed_device_id=$1`, kiosk.id); err != nil {
		t.Fatal(err)
	}
	_, err = service.SaveKioskCameraCalibration(ctx, kiosk.device, manageddevices.CameraSettings{}, nil)
	wantAppError(t, err, http.StatusConflict, "camera_calibration_closed")

	// Cancelling on the tablet closes the window and keeps the values.
	if _, err = service.StartCameraCalibration(ctx, manager, kiosk.id, nil); err != nil {
		t.Fatal(err)
	}
	if err = service.CancelKioskCameraCalibration(ctx, kiosk.device, nil); err != nil {
		t.Fatal(err)
	}
	_, err = service.SaveKioskCameraCalibration(ctx, kiosk.device, manageddevices.CameraSettings{}, nil)
	wantAppError(t, err, http.StatusConflict, "camera_calibration_closed")
	if camera, _ := service.KioskCamera(ctx, kiosk.id); camera.Crop == nil || camera.CalibrationExpiresAt != nil {
		t.Fatalf("cancel changed the calibration: %+v", camera)
	}

	// An administrator can close an open window; the tablet's credential is then refused.
	if _, err = service.StartCameraCalibration(ctx, manager, kiosk.id, nil); err != nil {
		t.Fatal(err)
	}
	if _, err = service.CloseCameraCalibration(ctx, reader, kiosk.id, nil); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("close without manage: %v", err)
	}
	if closed, err := service.CloseCameraCalibration(ctx, manager, kiosk.id, nil); err != nil ||
		closed.CalibrationExpiresAt != nil {
		t.Fatalf("close = %+v, %v", closed, err)
	}
	_, err = service.SaveKioskCameraCalibration(ctx, kiosk.device, manageddevices.CameraSettings{}, nil)
	wantAppError(t, err, http.StatusConflict, "camera_calibration_closed")
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action='managed_device.camera_calibration_closed'
		AND resource_id=$1`, 1, kiosk.id)
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action='managed_device.camera_calibration_cancelled'
		AND resource_id=$1`, 1, kiosk.id)

	// The device settings set values numerically and reset them; only with managed_devices.manage.
	if _, err = service.UpdateCamera(ctx, reader, kiosk.id, calibrated, nil); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("update without manage: %v", err)
	}
	reset, err := service.UpdateCamera(ctx, manager, kiosk.id, manageddevices.CameraSettings{}, nil)
	if err != nil || reset.Crop != nil || reset.Indicator != nil {
		t.Fatalf("reset = %+v, %v", reset, err)
	}
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action='managed_device.camera_updated'
		AND resource_id=$1`, 1, kiosk.id)

	// A device that is no longer a kiosk cannot calibrate with its credential.
	notKiosk := kiosk.device
	notKiosk.KioskEnabled = false
	_, err = service.SaveKioskCameraCalibration(ctx, notKiosk, calibrated, nil)
	wantAppError(t, err, http.StatusForbidden, "device_not_kiosk")
}
