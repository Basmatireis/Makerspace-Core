package httpapi

import (
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/attendance"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
)

func terminalDevice(ctx context.Context) (manageddevices.DeviceContext, error) {
	device, ok := ctx.Value(visitorDeviceContextKey).(manageddevices.DeviceContext)
	if !ok {
		return manageddevices.DeviceContext{}, apperror.NotFound
	}
	return device, nil
}

func (s *Server) GetTerminalContext(ctx context.Context, _ openapi.GetTerminalContextRequestObject) (openapi.GetTerminalContextResponseObject, error) {
	device, err := terminalDevice(ctx)
	if err != nil {
		return nil, err
	}
	value, err := s.attendance.TerminalContext(ctx, device)
	if err != nil {
		return nil, err
	}
	methods := make([]openapi.TerminalContextAuthenticationMethods, len(value.AuthenticationMethods))
	for i, method := range value.AuthenticationMethods {
		methods[i] = openapi.TerminalContextAuthenticationMethods(method)
	}
	capabilities := make([]openapi.DeviceCapability, len(value.Capabilities))
	for i, capability := range value.Capabilities {
		capabilities[i] = openapi.DeviceCapability(capability)
	}
	return openapi.GetTerminalContext200JSONResponse{DeviceId: value.DeviceID, DeviceName: value.DeviceName,
		CheckoutMode: openapi.CheckoutMode(value.CheckoutMode), CheckInAssurance: openapi.AuthenticationAssurance(value.CheckInAssurance),
		CheckOutAssurance: openapi.AuthenticationAssurance(value.CheckOutAssurance), AuthenticationMethods: methods,
		Capabilities: capabilities, StaffDestination: openapi.TerminalContextStaffDestination("login")}, nil
}

func (s *Server) ListTerminalPresence(ctx context.Context, _ openapi.ListTerminalPresenceRequestObject) (openapi.ListTerminalPresenceResponseObject, error) {
	device, err := terminalDevice(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.attendance.PublicPresence(ctx, device)
	if err != nil {
		return nil, err
	}
	result := make([]openapi.PublicPresence, len(items))
	for i, item := range items {
		result[i] = openapi.PublicPresence{VisitId: item.VisitID, DisplayName: item.DisplayName, CheckedInAt: item.CheckedInAt}
	}
	return openapi.ListTerminalPresence200JSONResponse{Items: result, Count: len(result)}, nil
}

func (s *Server) TerminalPasswordCheckIn(ctx context.Context, request openapi.TerminalPasswordCheckInRequestObject) (openapi.TerminalPasswordCheckInResponseObject, error) {
	device, err := terminalDevice(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil || request.Body.Password == nil {
		return nil, invalidRequest("email and password are required")
	}
	value, err := s.attendance.PasswordCheckIn(ctx, device, string(request.Body.Email), string(*request.Body.Password), sourceAddress(ctx), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.TerminalPasswordCheckIn201JSONResponse(visitDTO(value)), nil
}

func (s *Server) TerminalPinCheckIn(ctx context.Context, request openapi.TerminalPinCheckInRequestObject) (openapi.TerminalPinCheckInResponseObject, error) {
	device, err := terminalDevice(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil || request.Body.Pin == nil {
		return nil, invalidRequest("loginName and pin are required")
	}
	value, err := s.attendance.PINCheckIn(ctx, device, request.Body.LoginName, *request.Body.Pin, sourceAddress(ctx), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.TerminalPinCheckIn201JSONResponse(visitDTO(value)), nil
}

func (s *Server) TerminalPasswordCheckOut(ctx context.Context, request openapi.TerminalPasswordCheckOutRequestObject) (openapi.TerminalPasswordCheckOutResponseObject, error) {
	device, err := terminalDevice(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil || request.Body.Password == nil {
		return nil, invalidRequest("email and password are required")
	}
	value, err := s.attendance.PasswordCheckOut(ctx, device, string(request.Body.Email), string(*request.Body.Password), sourceAddress(ctx), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.TerminalPasswordCheckOut200JSONResponse(visitDTO(value)), nil
}

func (s *Server) TerminalPinCheckOut(ctx context.Context, request openapi.TerminalPinCheckOutRequestObject) (openapi.TerminalPinCheckOutResponseObject, error) {
	device, err := terminalDevice(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil || request.Body.Pin == nil {
		return nil, invalidRequest("loginName and pin are required")
	}
	value, err := s.attendance.PINCheckOut(ctx, device, request.Body.LoginName, *request.Body.Pin, sourceAddress(ctx), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.TerminalPinCheckOut200JSONResponse(visitDTO(value)), nil
}

func (s *Server) TerminalPublicCheckOut(ctx context.Context, request openapi.TerminalPublicCheckOutRequestObject) (openapi.TerminalPublicCheckOutResponseObject, error) {
	device, err := terminalDevice(ctx)
	if err != nil {
		return nil, err
	}
	value, err := s.attendance.PublicCheckOut(ctx, device, request.VisitId, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.TerminalPublicCheckOut200JSONResponse(visitDTO(value)), nil
}

func (s *Server) ListVisits(ctx context.Context, request openapi.ListVisitsRequestObject) (openapi.ListVisitsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.attendance.List(ctx, p, request.Params.CurrentlyHere != nil && *request.Params.CurrentlyHere, request.Params.From, request.Params.To)
	if err != nil {
		return nil, err
	}
	result := make([]openapi.Visit, len(items))
	for i, item := range items {
		result[i] = visitDTO(item)
	}
	return openapi.ListVisits200JSONResponse{Items: result}, nil
}

func (s *Server) SupervisedVisitCheckIn(ctx context.Context, request openapi.SupervisedVisitCheckInRequestObject) (openapi.SupervisedVisitCheckInResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	value, err := s.attendance.SupervisedCheckIn(ctx, p, request.Body.PersonId, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.SupervisedVisitCheckIn201JSONResponse(visitDTO(value)), nil
}

func (s *Server) SupervisedVisitCheckOut(ctx context.Context, request openapi.SupervisedVisitCheckOutRequestObject) (openapi.SupervisedVisitCheckOutResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	value, err := s.attendance.SupervisedCheckOut(ctx, p, request.VisitId, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.SupervisedVisitCheckOut200JSONResponse(visitDTO(value)), nil
}

func (s *Server) VoidVisit(ctx context.Context, request openapi.VoidVisitRequestObject) (openapi.VoidVisitResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	value, err := s.attendance.Void(ctx, p, request.VisitId, int64(request.Body.ExpectedVersion), request.Body.Reason, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.VoidVisit200JSONResponse(visitDTO(value)), nil
}

func (s *Server) GetAttendanceStatistics(ctx context.Context, request openapi.GetAttendanceStatisticsRequestObject) (openapi.GetAttendanceStatisticsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	value, err := s.attendance.Statistics(ctx, p, request.Params.From, request.Params.To)
	if err != nil {
		return nil, err
	}
	return openapi.GetAttendanceStatistics200JSONResponse{From: value.From, To: value.To, VisitorCount: value.VisitorCount,
		UniqueVisitors: value.UniqueVisitors, VisitorHours: value.VisitorHours, PeakOccupancy: value.PeakOccupancy,
		CurrentOccupancy: value.CurrentOccupancy, AverageCompletedVisitMinutes: value.AverageCompletedVisitMinutes}, nil
}

func visitDTO(value attendance.Visit) openapi.Visit {
	return openapi.Visit{Id: value.ID, PersonId: value.PersonID, DisplayName: value.DisplayName, CheckedInAt: value.CheckedInAt,
		CheckedOutAt: nullablePointer[time.Time](value.CheckedOutAt, func(v time.Time) time.Time { return v }), Status: openapi.VisitStatus(value.Status),
		CheckInMethod: value.CheckInMethod, CheckOutMethod: nullablePointer[string](value.CheckOutMethod, func(v string) string { return v }),
		AdmissionDecision: openapi.VisitAdmissionDecision(value.AdmissionDecision), CorrectionReason: nullablePointer[string](value.CorrectionReason, func(v string) string { return v }), Version: value.Version}
}
