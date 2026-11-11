package manageddevices

import (
	"context"
	"errors"
	"math"
	"net/http"
	"slices"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	manageddevicesdb "github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/database"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// CameraCalibrationWindow is how long a tablet may save its own camera calibration after an administrator started it.
const CameraCalibrationWindow = 10 * time.Minute

// Bounds of a camera crop: its centre is a fraction of the frame, its side a fraction of the frame's shorter side.
const (
	MinCameraCropSize = 0.2
	MaxCameraCropSize = 1.0
	MaxIndicatorPct   = 100.0
)

// IndicatorEdge is the screen edge nearest to a tablet's camera lens.
type IndicatorEdge string

const (
	IndicatorEdgeTop    IndicatorEdge = "top"
	IndicatorEdgeRight  IndicatorEdge = "right"
	IndicatorEdgeBottom IndicatorEdge = "bottom"
	IndicatorEdgeLeft   IndicatorEdge = "left"
)

var indicatorEdges = []IndicatorEdge{IndicatorEdgeTop, IndicatorEdgeRight, IndicatorEdgeBottom, IndicatorEdgeLeft}

// CameraCrop is the square of the unmirrored camera frame a profile photo is taken from.
type CameraCrop struct {
	CenterX, CenterY, Size float64
}

// CameraIndicator says where the lens is: an edge and the position along it in percent.
type CameraIndicator struct {
	Edge   IndicatorEdge
	Offset float64
}

// CameraSettings is a kiosk's calibration. A nil Crop is the centred largest square; a nil Indicator shows no pointer.
type CameraSettings struct {
	Crop      *CameraCrop
	Indicator *CameraIndicator
}

// Camera is a device's calibration with the end of its open calibration window, if any.
type Camera struct {
	CameraSettings
	CalibrationExpiresAt *time.Time
}

func errCalibrationClosed() error {
	return apperror.New(
		http.StatusConflict,
		"camera_calibration_closed",
		"No camera calibration is open for this device. Start it again in the device settings.",
	)
}

func validCameraSettings(settings CameraSettings) error {
	inUnit := func(value float64) bool { return !math.IsNaN(value) && value >= 0 && value <= 1 }
	if crop := settings.Crop; crop != nil {
		if !inUnit(crop.CenterX) || !inUnit(crop.CenterY) {
			return apperror.InvalidField("crop centre must be between 0 and 1")
		}
		if math.IsNaN(crop.Size) || crop.Size < MinCameraCropSize || crop.Size > MaxCameraCropSize {
			return apperror.InvalidField("crop size must be between 0.2 and 1")
		}
	}
	if indicator := settings.Indicator; indicator != nil {
		if !slices.Contains(indicatorEdges, indicator.Edge) {
			return apperror.InvalidField("indicator edge must be top, right, bottom or left")
		}
		if math.IsNaN(indicator.Offset) || indicator.Offset < 0 || indicator.Offset > MaxIndicatorPct {
			return apperror.InvalidField("indicator offset must be between 0 and 100")
		}
	}
	return nil
}

func cameraFromRow(row manageddevicesdb.ManagedDeviceCameraSetting, now time.Time) Camera {
	var result Camera
	if row.CropCenterX != nil && row.CropCenterY != nil && row.CropSize != nil {
		result.Crop = &CameraCrop{CenterX: *row.CropCenterX, CenterY: *row.CropCenterY, Size: *row.CropSize}
	}
	if row.IndicatorEdge != nil && row.IndicatorOffset != nil {
		result.Indicator = &CameraIndicator{Edge: IndicatorEdge(*row.IndicatorEdge), Offset: *row.IndicatorOffset}
	}
	// An expired window is the same as none: nothing clears it, the clock does.
	if row.CalibrationExpiresAt.Valid && row.CalibrationExpiresAt.Time.After(now) {
		expires := row.CalibrationExpiresAt.Time.UTC()
		result.CalibrationExpiresAt = &expires
	}
	return result
}

func upsertCameraParams(
	deviceID uuid.UUID,
	settings CameraSettings,
	expiresAt *time.Time,
	now time.Time,
) manageddevicesdb.UpsertManagedDeviceCameraSettingsParams {
	params := manageddevicesdb.UpsertManagedDeviceCameraSettingsParams{
		ManagedDeviceID:      deviceID,
		CalibrationExpiresAt: timestamp(expiresAt),
		UpdatedAt:            now,
	}
	if crop := settings.Crop; crop != nil {
		params.CropCenterX, params.CropCenterY, params.CropSize = &crop.CenterX, &crop.CenterY, &crop.Size
	}
	if indicator := settings.Indicator; indicator != nil {
		edge := string(indicator.Edge)
		params.IndicatorEdge, params.IndicatorOffset = &edge, &indicator.Offset
	}
	return params
}

// readCamera loads a device's camera row; a device without one has the defaults.
func readCamera(
	ctx context.Context,
	q *manageddevicesdb.Queries,
	deviceID uuid.UUID,
	lock bool,
	now time.Time,
) (Camera, error) {
	read := q.GetManagedDeviceCameraSettings
	if lock {
		read = q.GetManagedDeviceCameraSettingsForUpdate
	}
	row, err := read(ctx, deviceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Camera{}, nil
	}
	if err != nil {
		return Camera{}, err
	}
	return cameraFromRow(row, now), nil
}

// KioskCamera is the calibration a kiosk tablet applies, for the device's own context and visitor enrollment.
func (s *Service) KioskCamera(ctx context.Context, deviceID uuid.UUID) (Camera, error) {
	return readCamera(ctx, manageddevicesdb.New(s.pool), deviceID, false, s.now())
}

func (s *Service) GetCamera(
	ctx context.Context,
	principal authorization.Principal,
	deviceID uuid.UUID,
) (Camera, error) {
	if !principal.Has(authorization.ManagedDevicesRead) {
		return Camera{}, apperror.PermissionDenied
	}
	q := manageddevicesdb.New(s.pool)
	if _, err := q.GetManagedDevice(ctx, deviceID); errors.Is(err, pgx.ErrNoRows) {
		return Camera{}, apperror.NotFound
	} else if err != nil {
		return Camera{}, err
	}
	return readCamera(ctx, q, deviceID, false, s.now())
}

// cameraChange computes and writes a device's new camera row inside adminCameraTx.
type cameraChange func(
	tx pgx.Tx,
	q *manageddevicesdb.Queries,
	device manageddevicesdb.ManagedDevice,
	current Camera,
	now time.Time,
) (Camera, error)

// adminCameraTx locks the device and its camera row for a change by an administrator holding managed_devices.manage.
func (s *Service) adminCameraTx(
	ctx context.Context,
	principal authorization.Principal,
	deviceID uuid.UUID,
	change cameraChange,
) (Camera, error) {
	if !principal.Has(authorization.ManagedDevicesManage) {
		return Camera{}, apperror.PermissionDenied
	}
	var result Camera
	err := database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := manageddevicesdb.New(tx)
		device, err := q.GetManagedDeviceForMutation(ctx, deviceID)
		if errors.Is(err, pgx.ErrNoRows) {
			return apperror.NotFound
		}
		if err != nil {
			return err
		}
		now := s.now()
		current, err := readCamera(ctx, q, deviceID, true, now)
		if err != nil {
			return err
		}
		result, err = change(tx, q, device, current, now)
		return err
	})
	return result, err
}

func (s *Service) writeCamera(
	ctx context.Context,
	q *manageddevicesdb.Queries,
	deviceID uuid.UUID,
	settings CameraSettings,
	expiresAt *time.Time,
	now time.Time,
) (Camera, error) {
	row, err := q.UpsertManagedDeviceCameraSettings(ctx, upsertCameraParams(deviceID, settings, expiresAt, now))
	if err != nil {
		return Camera{}, databaseError(err)
	}
	return cameraFromRow(row, now), nil
}

// UpdateCamera sets or resets a device's calibration from the device settings; an open calibration window stays open.
func (s *Service) UpdateCamera(
	ctx context.Context,
	principal authorization.Principal,
	deviceID uuid.UUID,
	settings CameraSettings,
	requestID *uuid.UUID,
) (Camera, error) {
	if !principal.Has(authorization.ManagedDevicesManage) {
		return Camera{}, apperror.PermissionDenied
	}
	if err := validCameraSettings(settings); err != nil {
		return Camera{}, err
	}
	return s.adminCameraTx(ctx, principal, deviceID, func(
		tx pgx.Tx, q *manageddevicesdb.Queries, _ manageddevicesdb.ManagedDevice, current Camera, now time.Time,
	) (Camera, error) {
		result, err := s.writeCamera(ctx, q, deviceID, settings, current.CalibrationExpiresAt, now)
		if err != nil {
			return Camera{}, err
		}
		actor := principal.AccountID
		return result, audit.Write(ctx, tx, audit.Event{
			ActorAccountID: &actor,
			Action:         "managed_device.camera_updated",
			ResourceType:   "managed_device",
			ResourceID:     &deviceID,
			RequestID:      requestID,
			ChangedFields:  []string{"crop", "indicator"},
		})
	})
}

// StartCameraCalibration opens the window in which the tablet itself may save its calibration once. Only an active
// kiosk configured with a camera can calibrate; starting again extends the window.
func (s *Service) StartCameraCalibration(
	ctx context.Context,
	principal authorization.Principal,
	deviceID uuid.UUID,
	requestID *uuid.UUID,
) (Camera, error) {
	return s.adminCameraTx(ctx, principal, deviceID, func(
		tx pgx.Tx, q *manageddevicesdb.Queries, device manageddevicesdb.ManagedDevice, current Camera, now time.Time,
	) (Camera, error) {
		if device.RevokedAt.Valid || (device.ExpiresAt.Valid && !device.ExpiresAt.Time.After(now)) ||
			!device.TerminalEnabled {
			return Camera{}, apperror.New(
				http.StatusUnprocessableEntity,
				"camera_calibration_unavailable",
				"Only an active entrance kiosk can calibrate its camera",
			)
		}
		capabilities, err := q.ListDeviceCapabilities(ctx, deviceID)
		if err != nil {
			return Camera{}, err
		}
		if !slices.Contains(capabilities, CapabilityCamera) {
			return Camera{}, apperror.New(
				http.StatusUnprocessableEntity,
				"camera_not_configured",
				"This device is not configured with a camera",
			)
		}
		expires := now.Add(CameraCalibrationWindow)
		result, err := s.writeCamera(ctx, q, deviceID, current.CameraSettings, &expires, now)
		if err != nil {
			return Camera{}, err
		}
		actor := principal.AccountID
		return result, audit.Write(ctx, tx, audit.Event{
			ActorAccountID: &actor,
			Action:         "managed_device.camera_calibration_started",
			ResourceType:   "managed_device",
			ResourceID:     &deviceID,
			RequestID:      requestID,
		})
	})
}

// CloseCameraCalibration ends an open calibration window early; closing none changes nothing and writes no audit event.
func (s *Service) CloseCameraCalibration(
	ctx context.Context,
	principal authorization.Principal,
	deviceID uuid.UUID,
	requestID *uuid.UUID,
) (Camera, error) {
	return s.adminCameraTx(ctx, principal, deviceID, func(
		tx pgx.Tx, q *manageddevicesdb.Queries, _ manageddevicesdb.ManagedDevice, current Camera, now time.Time,
	) (Camera, error) {
		if current.CalibrationExpiresAt == nil {
			return current, nil
		}
		result, err := s.writeCamera(ctx, q, deviceID, current.CameraSettings, nil, now)
		if err != nil {
			return Camera{}, err
		}
		actor := principal.AccountID
		return result, audit.Write(ctx, tx, audit.Event{
			ActorAccountID: &actor,
			Action:         "managed_device.camera_calibration_closed",
			ResourceType:   "managed_device",
			ResourceID:     &deviceID,
			RequestID:      requestID,
		})
	})
}

// kioskCalibrationTx runs a tablet's own calibration step. The device credential is enough only while the window an
// administrator opened for this very device is open; the step always closes it, so it is single use.
func (s *Service) kioskCalibrationTx(
	ctx context.Context,
	device DeviceContext,
	settings *CameraSettings,
	requestID *uuid.UUID,
) (Camera, error) {
	if !device.KioskEnabled {
		return Camera{}, apperror.New(
			http.StatusForbidden,
			"device_not_kiosk",
			"This managed device is not configured as an entrance kiosk",
		)
	}
	if settings != nil {
		if err := validCameraSettings(*settings); err != nil {
			return Camera{}, err
		}
	}
	var result Camera
	err := database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := manageddevicesdb.New(tx)
		now := s.now()
		current, err := readCamera(ctx, q, device.ID, true, now)
		if err != nil {
			return err
		}
		if current.CalibrationExpiresAt == nil {
			return errCalibrationClosed()
		}
		next, action, changed := current.CameraSettings, "managed_device.camera_calibration_cancelled", []string(nil)
		if settings != nil {
			next, action, changed = *settings, "managed_device.camera_calibrated", []string{"crop", "indicator"}
		}
		if result, err = s.writeCamera(ctx, q, device.ID, next, nil, now); err != nil {
			return err
		}
		return audit.Write(ctx, tx, audit.Event{
			ActorType:     audit.ActorUnknown,
			Action:        action,
			ResourceType:  "managed_device",
			ResourceID:    &device.ID,
			RequestID:     requestID,
			ChangedFields: changed,
		})
	})
	return result, err
}

// SaveKioskCameraCalibration stores the calibration made on the tablet and closes the window.
func (s *Service) SaveKioskCameraCalibration(
	ctx context.Context,
	device DeviceContext,
	settings CameraSettings,
	requestID *uuid.UUID,
) (CameraSettings, error) {
	result, err := s.kioskCalibrationTx(ctx, device, &settings, requestID)
	return result.CameraSettings, err
}

// CancelKioskCameraCalibration closes the window from the tablet without changing the calibration.
func (s *Service) CancelKioskCameraCalibration(ctx context.Context, device DeviceContext, requestID *uuid.UUID) error {
	_, err := s.kioskCalibrationTx(ctx, device, nil, requestID)
	return err
}
