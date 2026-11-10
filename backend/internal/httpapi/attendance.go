package httpapi

import (
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/attendance"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

func kioskDevice(ctx context.Context) (manageddevices.DeviceContext, error) {
	device, ok := ctx.Value(visitorDeviceContextKey).(manageddevices.DeviceContext)
	if !ok {
		return manageddevices.DeviceContext{}, apperror.NotFound
	}
	return device, nil
}

func (s *Server) GetTerminalContext(
	ctx context.Context,
	_ openapi.GetTerminalContextRequestObject,
) (openapi.GetTerminalContextResponseObject, error) {
	device, err := kioskDevice(ctx)
	if err != nil {
		return nil, err
	}
	value, err := s.attendance.KioskContext(ctx, device)
	if err != nil {
		return nil, err
	}
	capabilities := make([]openapi.DeviceCapability, len(value.Capabilities))
	for i, capability := range value.Capabilities {
		capabilities[i] = openapi.DeviceCapability(capability)
	}
	notices := s.kioskNotices(ctx, func(n *notifyrules.Notices) ([]notifyrules.KioskNotice, error) {
		return n.ForDevice(ctx, device.ID)
	})
	return openapi.GetTerminalContext200JSONResponse{Notices: notices, DeviceId: value.DeviceID, DeviceName: value.DeviceName,
		AllowTapCheckout: value.AllowTapCheckout, OfferSurveysAtCheckout: value.OfferSurveysAtCheckout,
		KioskResetSeconds: int(value.KioskResetSeconds), CheckInMethods: kioskMethodsDTO(value.CheckInMethods),
		CheckOutMethods: kioskMethodsDTO(value.CheckOutMethods),
		Capabilities:    capabilities, StaffDestination: openapi.TerminalContextStaffDestination("login")}, nil
}

// kioskNotices reads tablet notices for a response that is already decided: a failure to read them only leaves the
// notices out, it never fails a check-in that has happened.
func (s *Server) kioskNotices(
	ctx context.Context,
	read func(*notifyrules.Notices) ([]notifyrules.KioskNotice, error),
) *[]openapi.KioskNotice {
	found, err := read(notifyrules.NewNotices(s.pool))
	if err != nil {
		s.logger.WarnContext(ctx, "read tablet notices", "error", err)
		return nil
	}
	items := make([]openapi.KioskNotice, 0, len(found))
	for _, notice := range found {
		items = append(items, openapi.KioskNotice{
			Id: notice.ID, Mode: openapi.KioskNoticeMode(notice.Mode), Title: notice.Title, Body: notice.Body,
			Level: openapi.KioskNoticeLevel(notice.Level), MustTap: notice.MustTap,
		})
	}
	return &items
}

// checkInDTO is the visit of a tablet check-in with the notices waiting for that person at this tablet.
func (s *Server) checkInDTO(ctx context.Context, deviceID uuid.UUID, value attendance.Visit) openapi.Visit {
	visit := visitDTO(value)
	visit.Notices = s.kioskNotices(ctx, func(n *notifyrules.Notices) ([]notifyrules.KioskNotice, error) {
		return n.TakeForCheckIn(ctx, deviceID, value.PersonID)
	})
	s.consentForCheckIn(ctx, value.PersonID, &visit)
	return visit
}

func (s *Server) ListTerminalPresence(
	ctx context.Context,
	_ openapi.ListTerminalPresenceRequestObject,
) (openapi.ListTerminalPresenceResponseObject, error) {
	device, err := kioskDevice(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.attendance.PublicPresence(ctx, device)
	if err != nil {
		return nil, err
	}
	result := make([]openapi.PublicPresence, len(items))
	for i, item := range items {
		result[i] = openapi.PublicPresence{
			VisitId:     item.VisitID,
			DisplayName: item.DisplayName,
			CheckedInAt: item.CheckedInAt,
		}
	}
	return openapi.ListTerminalPresence200JSONResponse{Items: result, Count: len(result)}, nil
}

func (s *Server) TerminalPasswordCheckIn(
	ctx context.Context,
	request openapi.TerminalPasswordCheckInRequestObject,
) (openapi.TerminalPasswordCheckInResponseObject, error) {
	device, err := kioskDevice(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil || request.Body.Password == nil {
		return nil, invalidRequest("email and password are required")
	}
	value, err := s.attendance.PasswordCheckIn(
		ctx,
		device,
		string(request.Body.Email),
		*request.Body.Password,
		sourceAddress(ctx),
		attendance.LabRulesChoice{
			ConfirmVersionID: request.Body.ConfirmLabRulesVersionId,
			Defer:            request.Body.DeferLabRules != nil && *request.Body.DeferLabRules,
		},
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.TerminalPasswordCheckIn201JSONResponse(s.checkInDTO(ctx, device.ID, value)), nil
}

func (s *Server) TerminalPinCheckIn(
	ctx context.Context,
	request openapi.TerminalPinCheckInRequestObject,
) (openapi.TerminalPinCheckInResponseObject, error) {
	device, err := kioskDevice(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil || request.Body.Pin == nil {
		return nil, invalidRequest("loginName and pin are required")
	}
	value, err := s.attendance.PINCheckIn(
		ctx,
		device,
		request.Body.LoginName,
		*request.Body.Pin,
		sourceAddress(ctx),
		attendance.LabRulesChoice{
			ConfirmVersionID: request.Body.ConfirmLabRulesVersionId,
			Defer:            request.Body.DeferLabRules != nil && *request.Body.DeferLabRules,
		},
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.TerminalPinCheckIn201JSONResponse(s.checkInDTO(ctx, device.ID, value)), nil
}

func (s *Server) RequestTerminalEmailCode(
	ctx context.Context,
	request openapi.RequestTerminalEmailCodeRequestObject,
) (openapi.RequestTerminalEmailCodeResponseObject, error) {
	device, err := kioskDevice(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("email is required")
	}
	if err := s.attendance.RequestEmailCode(
		ctx, device, string(request.Body.Email), sourceAddress(ctx), requestIDPointer(ctx),
	); err != nil {
		return nil, err
	}
	return openapi.RequestTerminalEmailCode202Response{
		Headers: openapi.RequestTerminalEmailCode202ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (s *Server) TerminalEmailCodeCheckIn(
	ctx context.Context,
	request openapi.TerminalEmailCodeCheckInRequestObject,
) (openapi.TerminalEmailCodeCheckInResponseObject, error) {
	device, err := kioskDevice(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil || request.Body.Code == nil {
		return nil, invalidRequest("email and code are required")
	}
	value, err := s.attendance.EmailCodeCheckIn(
		ctx,
		device,
		string(request.Body.Email),
		*request.Body.Code,
		sourceAddress(ctx),
		attendance.LabRulesChoice{
			ConfirmVersionID: request.Body.ConfirmLabRulesVersionId,
			Defer:            request.Body.DeferLabRules != nil && *request.Body.DeferLabRules,
		},
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.TerminalEmailCodeCheckIn201JSONResponse(s.checkInDTO(ctx, device.ID, value)), nil
}

func (s *Server) TerminalEmailCodeCheckOut(
	ctx context.Context,
	request openapi.TerminalEmailCodeCheckOutRequestObject,
) (openapi.TerminalEmailCodeCheckOutResponseObject, error) {
	device, err := kioskDevice(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil || request.Body.Code == nil {
		return nil, invalidRequest("email and code are required")
	}
	value, err := s.attendance.EmailCodeCheckOut(
		ctx, device, string(request.Body.Email), *request.Body.Code, sourceAddress(ctx), requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.TerminalEmailCodeCheckOut200JSONResponse(visitDTO(value)), nil
}

func (s *Server) TerminalPasswordCheckOut(
	ctx context.Context,
	request openapi.TerminalPasswordCheckOutRequestObject,
) (openapi.TerminalPasswordCheckOutResponseObject, error) {
	device, err := kioskDevice(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil || request.Body.Password == nil {
		return nil, invalidRequest("email and password are required")
	}
	value, err := s.attendance.PasswordCheckOut(
		ctx,
		device,
		string(request.Body.Email),
		*request.Body.Password,
		sourceAddress(ctx),
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.TerminalPasswordCheckOut200JSONResponse(visitDTO(value)), nil
}

func (s *Server) TerminalPinCheckOut(
	ctx context.Context,
	request openapi.TerminalPinCheckOutRequestObject,
) (openapi.TerminalPinCheckOutResponseObject, error) {
	device, err := kioskDevice(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil || request.Body.Pin == nil {
		return nil, invalidRequest("loginName and pin are required")
	}
	value, err := s.attendance.PINCheckOut(
		ctx,
		device,
		request.Body.LoginName,
		*request.Body.Pin,
		sourceAddress(ctx),
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.TerminalPinCheckOut200JSONResponse(visitDTO(value)), nil
}

func (s *Server) TerminalPublicCheckOut(
	ctx context.Context,
	request openapi.TerminalPublicCheckOutRequestObject,
) (openapi.TerminalPublicCheckOutResponseObject, error) {
	device, err := kioskDevice(ctx)
	if err != nil {
		return nil, err
	}
	value, err := s.attendance.PublicCheckOut(ctx, device, request.VisitId, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.TerminalPublicCheckOut200JSONResponse(visitDTO(value)), nil
}

func (s *Server) ListVisits(
	ctx context.Context,
	_ openapi.ListVisitsRequestObject,
) (openapi.ListVisitsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.attendance.List(ctx, p)
	if err != nil {
		return nil, err
	}
	result := make([]openapi.Visit, len(items))
	for i, item := range items {
		result[i] = visitDTO(item)
	}
	return openapi.ListVisits200JSONResponse{Items: result}, nil
}

func (s *Server) SupervisedVisitCheckIn(
	ctx context.Context,
	request openapi.SupervisedVisitCheckInRequestObject,
) (openapi.SupervisedVisitCheckInResponseObject, error) {
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

func (s *Server) GetTerminalLabRules(
	ctx context.Context,
	_ openapi.GetTerminalLabRulesRequestObject,
) (openapi.GetTerminalLabRulesResponseObject, error) {
	if _, err := s.terminalKiosk(ctx); err != nil {
		return nil, err
	}
	version, err := s.laborordnung.CurrentVersion(ctx)
	if err != nil {
		return nil, err
	}
	return openapi.GetTerminalLabRules200JSONResponse{
		Body:    openapi.TerminalLabRules{Id: version.ID, HumanRevision: version.HumanRevision, EffectiveAt: *version.EffectiveAt},
		Headers: openapi.GetTerminalLabRules200ResponseHeaders{CacheControl: "private, no-store"},
	}, nil
}

func (s *Server) GetTerminalLabRulesPDF(
	ctx context.Context,
	_ openapi.GetTerminalLabRulesPDFRequestObject,
) (openapi.GetTerminalLabRulesPDFResponseObject, error) {
	if _, err := s.terminalKiosk(ctx); err != nil {
		return nil, err
	}
	file, reader, err := s.laborordnung.OpenCurrentPDF(ctx)
	if err != nil {
		return nil, err
	}
	return openapi.GetTerminalLabRulesPDF200ApplicationpdfResponse{
		Body:          reader,
		ContentLength: file.Size,
		Headers:       openapi.GetTerminalLabRulesPDF200ResponseHeaders{CacheControl: "private, no-store"},
	}, nil
}

// terminalKiosk resolves the attendance terminal of the request; devices that are not terminals get 404.
func (s *Server) terminalKiosk(ctx context.Context) (attendance.KioskContext, error) {
	device, err := kioskDevice(ctx)
	if err != nil {
		return attendance.KioskContext{}, err
	}
	return s.attendance.KioskContext(ctx, device)
}

func (s *Server) SupervisedVisitCheckOut(
	ctx context.Context,
	request openapi.SupervisedVisitCheckOutRequestObject,
) (openapi.SupervisedVisitCheckOutResponseObject, error) {
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

func (s *Server) VoidVisit(
	ctx context.Context,
	request openapi.VoidVisitRequestObject,
) (openapi.VoidVisitResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	value, err := s.attendance.Void(
		ctx,
		p,
		request.VisitId,
		request.Body.ExpectedVersion,
		request.Body.Reason,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.VoidVisit200JSONResponse(visitDTO(value)), nil
}

func (s *Server) GetAttendanceStatistics(
	ctx context.Context,
	request openapi.GetAttendanceStatisticsRequestObject,
) (openapi.GetAttendanceStatisticsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	value, err := s.attendance.Statistics(ctx, p, request.Params.From, request.Params.To)
	if err != nil {
		return nil, err
	}
	return openapi.GetAttendanceStatistics200JSONResponse{
		From:                         value.From,
		To:                           value.To,
		VisitorCount:                 value.VisitorCount,
		UniqueVisitors:               value.UniqueVisitors,
		VisitorHours:                 value.VisitorHours,
		PeakOccupancy:                value.PeakOccupancy,
		CurrentOccupancy:             value.CurrentOccupancy,
		AverageCompletedVisitMinutes: value.AverageCompletedVisitMinutes,
	}, nil
}

func visitDTO(value attendance.Visit) openapi.Visit {
	return openapi.Visit{
		Id:          value.ID,
		PersonId:    value.PersonID,
		DisplayName: value.DisplayName,
		CheckedInAt: value.CheckedInAt,
		CheckedOutAt: nullablePointer[time.Time](
			value.CheckedOutAt,
			func(v time.Time) time.Time { return v },
		),
		Status:         openapi.VisitStatus(value.Status),
		CheckInMethod:  value.CheckInMethod,
		CheckOutMethod: nullablePointer[string](value.CheckOutMethod, func(v string) string { return v }),
		AdmissionDecision: openapi.VisitAdmissionDecision(
			value.AdmissionDecision,
		),
		CorrectionReason: nullablePointer[string](value.CorrectionReason, func(v string) string { return v }),
		Version:          value.Version,
		SurveyOffer:      surveyOfferDTO(value.SurveyOffer),
	}
}
