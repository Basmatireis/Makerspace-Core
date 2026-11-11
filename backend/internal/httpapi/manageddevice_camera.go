package httpapi

import (
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/oapi-codegen/nullable"
)

func cameraSettingsDTO(value manageddevices.CameraSettings) openapi.KioskCameraSettings {
	result := openapi.KioskCameraSettings{
		Crop:      nullable.NewNullNullable[openapi.KioskCameraCrop](),
		Indicator: nullable.NewNullNullable[openapi.KioskCameraIndicator](),
		Mirror:    value.Mirror,
	}
	if crop := value.Crop; crop != nil {
		result.Crop = nullable.NewNullableWithValue(
			openapi.KioskCameraCrop{CenterX: crop.CenterX, CenterY: crop.CenterY, Size: crop.Size},
		)
	}
	if indicator := value.Indicator; indicator != nil {
		result.Indicator = nullable.NewNullableWithValue(openapi.KioskCameraIndicator{
			Edge:   openapi.KioskCameraIndicatorEdge(indicator.Edge),
			Offset: indicator.Offset,
		})
	}
	return result
}

func managedDeviceCameraDTO(value manageddevices.Camera) openapi.ManagedDeviceCamera {
	settings := cameraSettingsDTO(value.CameraSettings)
	result := openapi.ManagedDeviceCamera{
		Crop:                 settings.Crop,
		Indicator:            settings.Indicator,
		Mirror:               settings.Mirror,
		CalibrationExpiresAt: nullable.NewNullNullable[time.Time](),
	}
	if value.CalibrationExpiresAt != nil {
		result.CalibrationExpiresAt = nullable.NewNullableWithValue(*value.CalibrationExpiresAt)
	}
	return result
}

// cameraSettingsInput maps a request body; a missing or null group means the default.
func cameraSettingsInput(body *openapi.KioskCameraSettings) (manageddevices.CameraSettings, error) {
	if body == nil {
		return manageddevices.CameraSettings{}, invalidRequest("request body is required")
	}
	result := manageddevices.CameraSettings{Mirror: body.Mirror}
	if crop, err := body.Crop.Get(); err == nil {
		result.Crop = &manageddevices.CameraCrop{CenterX: crop.CenterX, CenterY: crop.CenterY, Size: crop.Size}
	}
	if indicator, err := body.Indicator.Get(); err == nil {
		result.Indicator = &manageddevices.CameraIndicator{
			Edge:   manageddevices.IndicatorEdge(indicator.Edge),
			Offset: indicator.Offset,
		}
	}
	return result, nil
}

func (s *Server) GetManagedDeviceCamera(
	ctx context.Context,
	r openapi.GetManagedDeviceCameraRequestObject,
) (openapi.GetManagedDeviceCameraResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	value, err := s.managedDevices.GetCamera(ctx, p, r.ManagedDeviceId)
	if err != nil {
		return nil, err
	}
	return openapi.GetManagedDeviceCamera200JSONResponse(managedDeviceCameraDTO(value)), nil
}

func (s *Server) UpdateManagedDeviceCamera(
	ctx context.Context,
	r openapi.UpdateManagedDeviceCameraRequestObject,
) (openapi.UpdateManagedDeviceCameraResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	settings, err := cameraSettingsInput(r.Body)
	if err != nil {
		return nil, err
	}
	value, err := s.managedDevices.UpdateCamera(ctx, p, r.ManagedDeviceId, settings, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateManagedDeviceCamera200JSONResponse(managedDeviceCameraDTO(value)), nil
}

func (s *Server) StartManagedDeviceCameraCalibration(
	ctx context.Context,
	r openapi.StartManagedDeviceCameraCalibrationRequestObject,
) (openapi.StartManagedDeviceCameraCalibrationResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	value, err := s.managedDevices.StartCameraCalibration(ctx, p, r.ManagedDeviceId, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.StartManagedDeviceCameraCalibration200JSONResponse(managedDeviceCameraDTO(value)), nil
}

func (s *Server) CloseManagedDeviceCameraCalibration(
	ctx context.Context,
	r openapi.CloseManagedDeviceCameraCalibrationRequestObject,
) (openapi.CloseManagedDeviceCameraCalibrationResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	value, err := s.managedDevices.CloseCameraCalibration(ctx, p, r.ManagedDeviceId, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CloseManagedDeviceCameraCalibration200JSONResponse(managedDeviceCameraDTO(value)), nil
}

func (s *Server) SaveTerminalCameraCalibration(
	ctx context.Context,
	r openapi.SaveTerminalCameraCalibrationRequestObject,
) (openapi.SaveTerminalCameraCalibrationResponseObject, error) {
	device, err := kioskDevice(ctx)
	if err != nil {
		return nil, err
	}
	settings, err := cameraSettingsInput(r.Body)
	if err != nil {
		return nil, err
	}
	value, err := s.managedDevices.SaveKioskCameraCalibration(ctx, device, settings, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.SaveTerminalCameraCalibration200JSONResponse(cameraSettingsDTO(value)), nil
}

func (s *Server) CancelTerminalCameraCalibration(
	ctx context.Context,
	_ openapi.CancelTerminalCameraCalibrationRequestObject,
) (openapi.CancelTerminalCameraCalibrationResponseObject, error) {
	device, err := kioskDevice(ctx)
	if err != nil {
		return nil, err
	}
	if err = s.managedDevices.CancelKioskCameraCalibration(ctx, device, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.CancelTerminalCameraCalibration204Response{}, nil
}
