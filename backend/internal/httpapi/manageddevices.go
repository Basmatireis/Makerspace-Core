package httpapi

import (
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/oapi-codegen/nullable"
)

func (s *Server) ListManagedDeviceTypes(ctx context.Context, _ openapi.ListManagedDeviceTypesRequestObject) (openapi.ListManagedDeviceTypesResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	items, e := s.managedDevices.ListTypes(ctx, p)
	if e != nil {
		return nil, e
	}
	out := make([]openapi.ManagedDeviceType, 0, len(items))
	for _, item := range items {
		out = append(out, deviceTypeDTO(item))
	}
	return openapi.ListManagedDeviceTypes200JSONResponse{Items: out}, nil
}
func (s *Server) CreateManagedDeviceType(ctx context.Context, r openapi.CreateManagedDeviceTypeRequestObject) (openapi.CreateManagedDeviceTypeResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, e := s.managedDevices.CreateType(ctx, p, r.Body.Name, nullableStringPointer(r.Body.Description), requestIDPointer(ctx))
	if e != nil {
		return nil, e
	}
	return openapi.CreateManagedDeviceType201JSONResponse(deviceTypeDTO(item)), nil
}
func (s *Server) GetManagedDeviceType(ctx context.Context, r openapi.GetManagedDeviceTypeRequestObject) (openapi.GetManagedDeviceTypeResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	item, e := s.managedDevices.GetType(ctx, p, r.DeviceTypeId)
	if e != nil {
		return nil, e
	}
	return openapi.GetManagedDeviceType200JSONResponse(deviceTypeDTO(item)), nil
}
func (s *Server) UpdateManagedDeviceType(ctx context.Context, r openapi.UpdateManagedDeviceTypeRequestObject) (openapi.UpdateManagedDeviceTypeResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, e := s.managedDevices.UpdateType(ctx, p, r.DeviceTypeId, r.Body.ExpectedVersion, r.Body.Name, nullableStringPointer(r.Body.Description), requestIDPointer(ctx))
	if e != nil {
		return nil, e
	}
	return openapi.UpdateManagedDeviceType200JSONResponse(deviceTypeDTO(item)), nil
}
func (s *Server) DeleteManagedDeviceType(ctx context.Context, r openapi.DeleteManagedDeviceTypeRequestObject) (openapi.DeleteManagedDeviceTypeResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if e = s.managedDevices.DeleteType(ctx, p, r.DeviceTypeId, r.Body.ExpectedVersion, requestIDPointer(ctx)); e != nil {
		return nil, e
	}
	return openapi.DeleteManagedDeviceType204Response{}, nil
}
func (s *Server) ListManagedDevices(ctx context.Context, request openapi.ListManagedDevicesRequestObject) (openapi.ListManagedDevicesResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	limit, cursor := 50, ""
	if request.Params.Limit != nil {
		limit = *request.Params.Limit
	}
	if request.Params.Cursor != nil {
		cursor = *request.Params.Cursor
	}
	page, e := s.managedDevices.List(ctx, p, limit, cursor)
	if e != nil {
		return nil, e
	}
	out := make([]openapi.ManagedDevice, 0, len(page.Items))
	for _, item := range page.Items {
		out = append(out, managedDeviceDTO(item))
	}
	return openapi.ListManagedDevices200JSONResponse{Items: out, NextCursor: nullablePointer[string](page.NextCursor, func(value string) string { return value })}, nil
}
func (s *Server) GetManagedDevice(ctx context.Context, request openapi.GetManagedDeviceRequestObject) (openapi.GetManagedDeviceResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	item, e := s.managedDevices.Get(ctx, p, request.ManagedDeviceId)
	if e != nil {
		return nil, e
	}
	return openapi.GetManagedDevice200JSONResponse(managedDeviceDTO(item)), nil
}
func (s *Server) CreateManagedDevice(ctx context.Context, r openapi.CreateManagedDeviceRequestObject) (openapi.CreateManagedDeviceResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, e := s.managedDevices.Create(ctx, p, r.Body.Name, r.Body.DeviceTypeId, nullableTime(r.Body.ExpiresAt), requestIDPointer(ctx))
	if e != nil {
		return nil, e
	}
	return openapi.CreateManagedDevice201JSONResponse{Body: provisioningDTO(item), Headers: openapi.CreateManagedDevice201ResponseHeaders{CacheControl: "no-store"}}, nil
}
func (s *Server) UpdateManagedDevice(ctx context.Context, r openapi.UpdateManagedDeviceRequestObject) (openapi.UpdateManagedDeviceResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, e := s.managedDevices.Update(ctx, p, r.ManagedDeviceId, r.Body.Name, r.Body.DeviceTypeId, nullableTime(r.Body.ExpiresAt), r.Body.ExpectedVersion, requestIDPointer(ctx))
	if e != nil {
		return nil, e
	}
	return openapi.UpdateManagedDevice200JSONResponse(managedDeviceDTO(item)), nil
}
func (s *Server) DeleteManagedDevice(ctx context.Context, r openapi.DeleteManagedDeviceRequestObject) (openapi.DeleteManagedDeviceResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if e = s.managedDevices.Delete(ctx, p, r.ManagedDeviceId, r.Body.ExpectedVersion, requestIDPointer(ctx)); e != nil {
		return nil, e
	}
	return openapi.DeleteManagedDevice204Response{}, nil
}
func (s *Server) RevokeManagedDevice(ctx context.Context, r openapi.RevokeManagedDeviceRequestObject) (openapi.RevokeManagedDeviceResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, e := s.managedDevices.Revoke(ctx, p, r.ManagedDeviceId, r.Body.ExpectedVersion, requestIDPointer(ctx))
	if e != nil {
		return nil, e
	}
	return openapi.RevokeManagedDevice200JSONResponse(managedDeviceDTO(item)), nil
}
func (s *Server) RotateManagedDeviceToken(ctx context.Context, r openapi.RotateManagedDeviceTokenRequestObject) (openapi.RotateManagedDeviceTokenResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, e := s.managedDevices.Rotate(ctx, p, r.ManagedDeviceId, r.Body.ExpectedVersion, nullableTime(r.Body.ExpiresAt), requestIDPointer(ctx))
	if e != nil {
		return nil, e
	}
	return openapi.RotateManagedDeviceToken200JSONResponse{Body: provisioningDTO(item), Headers: openapi.RotateManagedDeviceToken200ResponseHeaders{CacheControl: "no-store"}}, nil
}

func deviceTypeDTO(v manageddevices.DeviceType) openapi.ManagedDeviceType {
	return openapi.ManagedDeviceType{Id: v.ID, Name: v.Name, Description: nullablePointer[string](v.Description, func(x string) string { return x }), Version: v.Version, CreatedAt: v.CreatedAt, UpdatedAt: v.UpdatedAt}
}
func managedDeviceDTO(v manageddevices.Device) openapi.ManagedDevice {
	status := openapi.ManagedDeviceStatus(v.Status(time.Now()))
	return openapi.ManagedDevice{Id: v.ID, Name: v.Name, DeviceTypeId: v.DeviceTypeID, DeviceTypeName: v.DeviceTypeName, Status: status, ExpiresAt: nullablePointer[time.Time](v.ExpiresAt, func(x time.Time) time.Time { return x }), RevokedAt: nullablePointer[time.Time](v.RevokedAt, func(x time.Time) time.Time { return x }), LastSeenAt: nullablePointer[time.Time](v.LastSeenAt, func(x time.Time) time.Time { return x }), Version: v.Version, CreatedAt: v.CreatedAt, UpdatedAt: v.UpdatedAt}
}
func provisioningDTO(v manageddevices.ProvisionedDevice) openapi.ManagedDeviceProvisioning {
	return openapi.ManagedDeviceProvisioning{Device: managedDeviceDTO(v.Device), Token: &v.Token}
}
func nullableTime(v nullable.Nullable[time.Time]) *time.Time {
	if !v.IsSpecified() || v.IsNull() {
		return nil
	}
	x := v.GetOrEmpty().UTC()
	return &x
}
func grantDTO(v authorization.PermissionGrant) openapi.PermissionGrant {
	scope := openapi.Everywhere
	if v.Scope == authorization.GrantAnyManagedDevice {
		scope = openapi.AnyManagedDevice
	} else if v.Scope == authorization.GrantSelectedDeviceTypes {
		scope = openapi.SelectedDeviceTypes
	}
	ids := append([]openapi.UUIDv7(nil), v.DeviceTypeIDs...)
	return openapi.PermissionGrant{PermissionId: openapi.PermissionId(v.PermissionID), Scope: scope, DeviceTypeIds: ids}
}
func grantDomain(v openapi.PermissionGrant) authorization.PermissionGrant {
	scope := authorization.GrantEverywhere
	if v.Scope == openapi.AnyManagedDevice {
		scope = authorization.GrantAnyManagedDevice
	} else if v.Scope == openapi.SelectedDeviceTypes {
		scope = authorization.GrantSelectedDeviceTypes
	}
	return authorization.PermissionGrant{PermissionID: authorization.Permission(v.PermissionId), Scope: scope, DeviceTypeIDs: append([]openapi.UUIDv7(nil), v.DeviceTypeIds...)}
}
