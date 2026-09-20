package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/visitor"
	"github.com/google/uuid"
	"github.com/oapi-codegen/nullable"
)

func (s *Server) GetVisitorEnrollmentConfiguration(ctx context.Context, _ openapi.GetVisitorEnrollmentConfigurationRequestObject) (openapi.GetVisitorEnrollmentConfigurationResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	value, err := s.visitor.GetConfiguration(ctx, principal)
	if err != nil {
		return nil, err
	}
	return openapi.GetVisitorEnrollmentConfiguration200JSONResponse(visitorConfigurationDTO(value)), nil
}

func (s *Server) UpdateVisitorEnrollmentConfiguration(ctx context.Context, request openapi.UpdateVisitorEnrollmentConfigurationRequestObject) (openapi.UpdateVisitorEnrollmentConfigurationResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	var roleID *uuid.UUID
	if request.Body.InitialRoleId.IsSpecified() && !request.Body.InitialRoleId.IsNull() {
		value := request.Body.InitialRoleId.GetOrEmpty()
		roleID = &value
	}
	methods := make([]string, len(request.Body.AllowedMethods))
	for index, method := range request.Body.AllowedMethods {
		methods[index] = string(method)
	}
	value, err := s.visitor.UpdateConfiguration(ctx, principal, visitor.ConfigurationInput{
		Enabled: request.Body.Enabled, InitialRoleID: roleID, DeviceTypeIDs: request.Body.DeviceTypeIds,
		AllowedMethods: methods, ExpectedVersion: request.Body.ExpectedVersion,
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateVisitorEnrollmentConfiguration200JSONResponse(visitorConfigurationDTO(value)), nil
}

func (s *Server) BeginVisitorEnrollment(ctx context.Context, _ openapi.BeginVisitorEnrollmentRequestObject) (openapi.BeginVisitorEnrollmentResponseObject, error) {
	device, ok := ctx.Value(visitorDeviceContextKey).(manageddevices.DeviceContext)
	if !ok {
		return nil, invalidRequest("verified ManagedDevice is required")
	}
	issue, err := s.visitor.Begin(ctx, device)
	if err != nil {
		return nil, err
	}
	return visitorContextCookieResponse{config: s.config, issue: issue}, nil
}

func (s *Server) GetVisitorEnrollmentState(ctx context.Context, _ openapi.GetVisitorEnrollmentStateRequestObject) (openapi.GetVisitorEnrollmentStateResponseObject, error) {
	enrollment, ok := ctx.Value(visitorEnrollmentContextKey).(visitor.Context)
	if !ok {
		return nil, invalidRequest("enrollment context is required")
	}
	state, err := s.visitor.State(ctx, enrollment)
	if err != nil {
		return nil, err
	}
	methods := make([]openapi.VisitorAuthenticationMethod, len(state.AllowedMethods))
	for index, method := range state.AllowedMethods {
		methods[index] = openapi.VisitorAuthenticationMethod(method)
	}
	result := openapi.VisitorEnrollmentState{AllowedMethods: methods, ExpiresAt: state.ExpiresAt}
	if state.CurrentLabRules == nil {
		result.CurrentLabRules = nullable.NewNullNullable[openapi.VisitorLabRulesVersion]()
	} else {
		result.CurrentLabRules = nullable.NewNullableWithValue(openapi.VisitorLabRulesVersion{Id: state.CurrentLabRules.ID, HumanRevision: state.CurrentLabRules.HumanRevision, EffectiveAt: state.CurrentLabRules.EffectiveAt})
	}
	return openapi.GetVisitorEnrollmentState200JSONResponse(result), nil
}

func (s *Server) GetVisitorEnrollmentLabRulesPDF(ctx context.Context, _ openapi.GetVisitorEnrollmentLabRulesPDFRequestObject) (openapi.GetVisitorEnrollmentLabRulesPDFResponseObject, error) {
	file, reader, err := s.visitor.OpenLabRules(ctx)
	if err != nil {
		return nil, err
	}
	return openapi.GetVisitorEnrollmentLabRulesPDF200ApplicationpdfResponse{Body: reader, ContentLength: file.Size}, nil
}

func (s *Server) SubmitVisitorEnrollment(ctx context.Context, request openapi.SubmitVisitorEnrollmentRequestObject) (openapi.SubmitVisitorEnrollmentResponseObject, error) {
	enrollment, ok := ctx.Value(visitorEnrollmentContextKey).(visitor.Context)
	if !ok {
		return nil, invalidRequest("enrollment context is required")
	}
	if request.Body == nil || request.Body.ProfileImageBase64 == nil {
		return nil, invalidRequest("request body and profile image are required")
	}
	methods := make([]string, len(request.Body.AuthMethods))
	for index, method := range request.Body.AuthMethods {
		methods[index] = string(method)
	}
	result, err := s.visitor.Submit(ctx, enrollment, visitor.SubmissionInput{
		FirstName: request.Body.FirstName, LastName: request.Body.LastName,
		Email: nullableStringPointer(request.Body.Email), Phone: nullableStringPointer(request.Body.Phone),
		AuthMethods: methods, PINLoginName: nullableStringPointer(request.Body.PinLoginName), PIN: nullableStringPointer(request.Body.Pin),
		ProfileImage: *request.Body.ProfileImageBase64, ProfileImageFilename: request.Body.ProfileImageFilename,
		RequestConfirmation: request.Body.RequestConfirmation,
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	body := openapi.VisitorEnrollmentResult{
		PersonId: result.PersonID, AccountId: result.AccountID,
		AccountStatus: openapi.VisitorEnrollmentResultAccountStatus(result.AccountStatus),
		Admission:     openapi.VisitorEnrollmentResultAdmission(result.Admission),
		InvitationDelivery: nullablePointer(result.InvitationDelivery, func(value string) openapi.VisitorEnrollmentResultInvitationDelivery {
			return openapi.VisitorEnrollmentResultInvitationDelivery(value)
		}),
		LabRulesRequestId: nullablePointer(result.LabRulesRequestID, func(value uuid.UUID) openapi.UUIDv7 { return value }),
	}
	return visitorSubmissionCookieResponse{config: s.config, body: body}, nil
}

func (s *Server) EvaluateVisitorAdmission(ctx context.Context, _ openapi.EvaluateVisitorAdmissionRequestObject) (openapi.EvaluateVisitorAdmissionResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	result, err := s.visitor.Admission(ctx, principal, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.EvaluateVisitorAdmission200JSONResponse{
		Decision: openapi.VisitorAdmissionResultDecision(result.Decision), Status: laborordnungStatusDTO(result.Status),
		RequestId: nullablePointer(result.RequestID, func(value uuid.UUID) openapi.UUIDv7 { return value }),
	}, nil
}

func visitorConfigurationDTO(value visitor.Configuration) openapi.VisitorEnrollmentConfiguration {
	methods := make([]openapi.VisitorAuthenticationMethod, len(value.AllowedMethods))
	for index, method := range value.AllowedMethods {
		methods[index] = openapi.VisitorAuthenticationMethod(method)
	}
	return openapi.VisitorEnrollmentConfiguration{
		Enabled: value.Enabled, InitialRoleId: nullablePointer(value.InitialRoleID, func(id uuid.UUID) openapi.UUIDv7 { return id }),
		DeviceTypeIds: value.DeviceTypeIDs, AllowedMethods: methods, Version: value.Version, UpdatedAt: value.UpdatedAt,
	}
}

type visitorContextCookieResponse struct {
	config config.Config
	issue  visitor.ContextIssue
}

func (response visitorContextCookieResponse) VisitBeginVisitorEnrollmentResponse(w http.ResponseWriter) error {
	w.Header().Set("Cache-Control", "no-store")
	setEnrollmentCookie(w, response.config, response.config.EnrollmentCookieName, response.issue.ContextToken, true, response.issue.ExpiresAt, int(time.Until(response.issue.ExpiresAt).Seconds()))
	setEnrollmentCookie(w, response.config, response.config.EnrollmentCSRFName, response.issue.CSRFToken, false, response.issue.ExpiresAt, int(time.Until(response.issue.ExpiresAt).Seconds()))
	w.WriteHeader(http.StatusNoContent)
	return nil
}

type visitorSubmissionCookieResponse struct {
	config config.Config
	body   openapi.VisitorEnrollmentResult
}

func (response visitorSubmissionCookieResponse) VisitSubmitVisitorEnrollmentResponse(w http.ResponseWriter) error {
	w.Header().Set("Cache-Control", "no-store")
	expired := time.Unix(1, 0).UTC()
	setEnrollmentCookie(w, response.config, response.config.EnrollmentCookieName, "", true, expired, -1)
	setEnrollmentCookie(w, response.config, response.config.EnrollmentCSRFName, "", false, expired, -1)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	return json.NewEncoder(w).Encode(response.body)
}

func setEnrollmentCookie(w http.ResponseWriter, cfg config.Config, name, value string, httpOnly bool, expires time.Time, maxAge int) {
	http.SetCookie(w, &http.Cookie{Name: name, Value: value, Path: "/", Expires: expires, MaxAge: maxAge, HttpOnly: httpOnly, Secure: cfg.SessionCookieSecure, SameSite: http.SameSiteStrictMode})
}
