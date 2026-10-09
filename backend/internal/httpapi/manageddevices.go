package httpapi

import (
	"context"
	"net/http"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
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
	capabilities := make([]string, len(r.Body.Capabilities))
	for i, capability := range r.Body.Capabilities {
		capabilities[i] = string(capability)
	}
	item, e := s.managedDevices.CreateConfigured(ctx, p, r.Body.Name, r.Body.DeviceTypeId, nullableTime(r.Body.ExpiresAt), manageddevices.DeviceSettings{
		SessionPolicyID: nullableUUID(r.Body.SessionPolicyId), TerminalEnabled: r.Body.TerminalEnabled,
		AllowedApplicationModes: applicationModeStrings(r.Body.AllowedApplicationModes),
		CheckInAssurance:        string(r.Body.CheckInAssurance), CheckOutAssurance: string(r.Body.CheckOutAssurance),
		CheckoutMode: string(r.Body.CheckoutMode), Capabilities: capabilities,
	}, requestIDPointer(ctx))
	if e != nil {
		return nil, e
	}
	body, setCookie := s.managedDeviceProvisioning(item, r.Body.CredentialDelivery)
	return openapi.CreateManagedDevice201JSONResponse{Body: body, Headers: openapi.CreateManagedDevice201ResponseHeaders{CacheControl: "no-store", SetCookie: setCookie}}, nil
}
func (s *Server) UpdateManagedDevice(ctx context.Context, r openapi.UpdateManagedDeviceRequestObject) (openapi.UpdateManagedDeviceResponseObject, error) {
	p, e := requirePrincipal(ctx)
	if e != nil {
		return nil, e
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	capabilities := make([]string, len(r.Body.Capabilities))
	for i, capability := range r.Body.Capabilities {
		capabilities[i] = string(capability)
	}
	item, e := s.managedDevices.UpdateConfigured(ctx, p, r.ManagedDeviceId, r.Body.Name, r.Body.DeviceTypeId, nullableTime(r.Body.ExpiresAt), manageddevices.DeviceSettings{
		SessionPolicyID: nullableUUID(r.Body.SessionPolicyId), TerminalEnabled: r.Body.TerminalEnabled,
		AllowedApplicationModes: applicationModeStrings(r.Body.AllowedApplicationModes),
		CheckInAssurance:        string(r.Body.CheckInAssurance), CheckOutAssurance: string(r.Body.CheckOutAssurance),
		CheckoutMode: string(r.Body.CheckoutMode), Capabilities: capabilities,
	}, r.Body.ExpectedVersion, requestIDPointer(ctx))
	if e != nil {
		return nil, e
	}
	return openapi.UpdateManagedDevice200JSONResponse(managedDeviceDTO(item)), nil
}

func (s *Server) GetOwnManagedDeviceHardware(ctx context.Context, _ openapi.GetOwnManagedDeviceHardwareRequestObject) (openapi.GetOwnManagedDeviceHardwareResponseObject, error) {
	device, ok := ctx.Value(visitorDeviceContextKey).(manageddevices.DeviceContext)
	if !ok {
		return nil, apperror.Unauthenticated
	}
	value, err := s.managedDevices.GetHardwareContext(ctx, device)
	if err != nil {
		return nil, err
	}
	return openapi.GetOwnManagedDeviceHardware200JSONResponse(hardwareContextDTO(value)), nil
}

func (s *Server) ReportOwnManagedDeviceHardware(ctx context.Context, request openapi.ReportOwnManagedDeviceHardwareRequestObject) (openapi.ReportOwnManagedDeviceHardwareResponseObject, error) {
	device, ok := ctx.Value(visitorDeviceContextKey).(manageddevices.DeviceContext)
	if !ok {
		return nil, apperror.Unauthenticated
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	capabilities := make([]string, len(request.Body.Capabilities))
	for i, capability := range request.Body.Capabilities {
		capabilities[i] = string(capability)
	}
	value, err := s.managedDevices.ReportHardware(ctx, device, manageddevices.HardwareReport{
		Platform: string(request.Body.Platform), BridgeVersion: request.Body.BridgeVersion, Capabilities: capabilities,
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.ReportOwnManagedDeviceHardware200JSONResponse(hardwareContextDTO(value)), nil
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
	body, setCookie := s.managedDeviceProvisioning(item, r.Body.CredentialDelivery)
	return openapi.RotateManagedDeviceToken200JSONResponse{Body: body, Headers: openapi.RotateManagedDeviceToken200ResponseHeaders{CacheControl: "no-store", SetCookie: setCookie}}, nil
}

func (s *Server) managedDeviceProvisioning(v manageddevices.ProvisionedDevice, delivery openapi.ManagedDeviceCredentialDelivery) (openapi.ManagedDeviceProvisioning, string) {
	result := openapi.ManagedDeviceProvisioning{Device: managedDeviceDTO(v.Device)}
	if delivery == openapi.BindBrowser {
		expires := time.Now().UTC().AddDate(10, 0, 0)
		maxAge := 10 * 365 * 24 * 60 * 60
		if v.Device.ExpiresAt != nil {
			expires = v.Device.ExpiresAt.UTC()
			maxAge = max(1, int(time.Until(expires).Seconds()))
		}
		cookie := (&http.Cookie{Name: s.config.ManagedDeviceCookieName, Value: v.Token, Path: "/", HttpOnly: true, Secure: s.config.SessionCookieSecure, SameSite: http.SameSiteStrictMode, Expires: expires, MaxAge: maxAge}).String()
		return result, cookie
	}
	result.Token = &v.Token
	return result, ""
}

func deviceTypeDTO(v manageddevices.DeviceType) openapi.ManagedDeviceType {
	return openapi.ManagedDeviceType{Id: v.ID, Name: v.Name, Description: nullablePointer[string](v.Description, func(x string) string { return x }), Version: v.Version, CreatedAt: v.CreatedAt, UpdatedAt: v.UpdatedAt}
}
func managedDeviceDTO(v manageddevices.Device) openapi.ManagedDevice {
	status := openapi.ManagedDeviceStatus(v.Status(time.Now()))
	capabilities := make([]openapi.DeviceCapability, len(v.Capabilities))
	for i, capability := range v.Capabilities {
		capabilities[i] = openapi.DeviceCapability(capability)
	}
	return openapi.ManagedDevice{Id: v.ID, Name: v.Name, DeviceTypeId: v.DeviceTypeID, DeviceTypeName: v.DeviceTypeName, Status: status,
		ExpiresAt: nullablePointer[time.Time](v.ExpiresAt, func(x time.Time) time.Time { return x }), RevokedAt: nullablePointer[time.Time](v.RevokedAt, func(x time.Time) time.Time { return x }),
		LastSeenAt: nullablePointer[time.Time](v.LastSeenAt, func(x time.Time) time.Time { return x }), SessionPolicyId: nullablePointer[uuid.UUID](v.SessionPolicyID, func(x uuid.UUID) openapi.UUIDv7 { return x }),
		TerminalEnabled: v.TerminalEnabled, AllowedApplicationModes: applicationModes(v.AllowedApplicationModes), CheckInAssurance: openapi.AuthenticationAssurance(v.CheckInAssurance), CheckOutAssurance: openapi.AuthenticationAssurance(v.CheckOutAssurance),
		CheckoutMode: openapi.CheckoutMode(v.CheckoutMode), Capabilities: capabilities, Version: v.Version, CreatedAt: v.CreatedAt, UpdatedAt: v.UpdatedAt}
}

func applicationModeStrings(values []openapi.DeviceApplicationMode) []string {
	result := make([]string, len(values))
	for i, value := range values {
		result[i] = string(value)
	}
	return result
}

func applicationModes(values []string) []openapi.DeviceApplicationMode {
	result := make([]openapi.DeviceApplicationMode, len(values))
	for i, value := range values {
		result[i] = openapi.DeviceApplicationMode(value)
	}
	return result
}

func deviceCapabilities(values []string) []openapi.DeviceCapability {
	result := make([]openapi.DeviceCapability, len(values))
	for i, value := range values {
		result[i] = openapi.DeviceCapability(value)
	}
	return result
}

func hardwareContextDTO(value manageddevices.HardwareContext) openapi.DeviceHardwareContext {
	return openapi.DeviceHardwareContext{
		DeviceId: value.DeviceID, DeviceName: value.DeviceName, TerminalEnabled: value.TerminalEnabled,
		AllowedApplicationModes: applicationModes(value.AllowedApplicationModes),
		SessionPolicyId:         nullablePointer[uuid.UUID](value.SessionPolicyID, func(id uuid.UUID) openapi.UUIDv7 { return id }),
		ConfiguredCapabilities:  deviceCapabilities(value.ConfiguredCapabilities), ReportedCapabilities: deviceCapabilities(value.ReportedCapabilities),
		EffectiveCapabilities: deviceCapabilities(value.EffectiveCapabilities),
		Platform:              nullablePointer[string](value.Platform, func(platform string) openapi.DevicePlatform { return openapi.DevicePlatform(platform) }),
		BridgeVersion:         nullablePointer[string](value.BridgeVersion, func(version string) string { return version }),
		ReportedAt:            nullablePointer[time.Time](value.ReportedAt, func(at time.Time) time.Time { return at }),
	}
}

func (s *Server) ListSessionPolicies(ctx context.Context, _ openapi.ListSessionPoliciesRequestObject) (openapi.ListSessionPoliciesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.managedDevices.ListSessionPolicies(ctx, p)
	if err != nil {
		return nil, err
	}
	result := make([]openapi.SessionPolicy, len(items))
	for i, item := range items {
		result[i] = sessionPolicyDTO(item)
	}
	return openapi.ListSessionPolicies200JSONResponse{Items: result}, nil
}

func (s *Server) CreateSessionPolicy(ctx context.Context, request openapi.CreateSessionPolicyRequestObject) (openapi.CreateSessionPolicyResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	value, err := s.managedDevices.CreateSessionPolicy(ctx, p, sessionPolicyInput(*request.Body, 0), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateSessionPolicy201JSONResponse(sessionPolicyDTO(value)), nil
}

func (s *Server) UpdateSessionPolicy(ctx context.Context, request openapi.UpdateSessionPolicyRequestObject) (openapi.UpdateSessionPolicyResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	value, err := s.managedDevices.UpdateSessionPolicy(ctx, p, request.SessionPolicyId, manageddevices.SessionPolicyInput{
		Name: request.Body.Name, IdleTimeoutSeconds: int32(request.Body.IdleTimeoutSeconds), AbsoluteLifetimeSeconds: int32(request.Body.AbsoluteLifetimeSeconds),
		PostSessionDestination: string(request.Body.PostSessionDestination), IsDefault: request.Body.IsDefault, ExpectedVersion: request.Body.ExpectedVersion,
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateSessionPolicy200JSONResponse(sessionPolicyDTO(value)), nil
}

func sessionPolicyInput(value openapi.SessionPolicyInput, expected int64) manageddevices.SessionPolicyInput {
	return manageddevices.SessionPolicyInput{Name: value.Name, IdleTimeoutSeconds: int32(value.IdleTimeoutSeconds), AbsoluteLifetimeSeconds: int32(value.AbsoluteLifetimeSeconds),
		PostSessionDestination: string(value.PostSessionDestination), IsDefault: value.IsDefault, ExpectedVersion: expected}
}

func sessionPolicyDTO(value manageddevices.SessionPolicy) openapi.SessionPolicy {
	return openapi.SessionPolicy{Id: value.ID, Name: value.Name, IdleTimeoutSeconds: int(value.IdleTimeoutSeconds), AbsoluteLifetimeSeconds: int(value.AbsoluteLifetimeSeconds),
		PostSessionDestination: openapi.PostSessionDestination(value.PostSessionDestination), IsDefault: value.IsDefault, Version: value.Version, CreatedAt: value.CreatedAt, UpdatedAt: value.UpdatedAt}
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
	// The OpenAPI contract requires an array. A nil Go slice would otherwise
	// serialize as JSON null and crash clients that correctly expect an array.
	ids := make([]openapi.UUIDv7, len(v.DeviceTypeIDs))
	copy(ids, v.DeviceTypeIDs)
	result := openapi.PermissionGrant{
		PermissionId:     openapi.PermissionId(v.PermissionID),
		Scope:            scope,
		DeviceTypeIds:    ids,
		MinimumAssurance: openapi.AuthenticationAssurance(v.MinimumAssurance),
	}
	if v.ID != uuid.Nil {
		id := openapi.UUIDv7(v.ID)
		result.Id = &id
	}
	return result
}
func grantDomain(v openapi.PermissionGrant) authorization.PermissionGrant {
	scope := authorization.GrantEverywhere
	if v.Scope == openapi.AnyManagedDevice {
		scope = authorization.GrantAnyManagedDevice
	} else if v.Scope == openapi.SelectedDeviceTypes {
		scope = authorization.GrantSelectedDeviceTypes
	}
	return authorization.PermissionGrant{
		PermissionID:     authorization.Permission(v.PermissionId),
		Scope:            scope,
		DeviceTypeIDs:    append([]openapi.UUIDv7(nil), v.DeviceTypeIds...),
		MinimumAssurance: authorization.Assurance(v.MinimumAssurance),
	}
}
