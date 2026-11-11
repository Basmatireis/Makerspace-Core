package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/visitor"
	"github.com/oapi-codegen/nullable"
)

func (s *Server) GetVisitorEnrollmentConfiguration(
	ctx context.Context,
	_ openapi.GetVisitorEnrollmentConfigurationRequestObject,
) (openapi.GetVisitorEnrollmentConfigurationResponseObject, error) {
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

func (s *Server) UpdateVisitorEnrollmentConfiguration(
	ctx context.Context,
	request openapi.UpdateVisitorEnrollmentConfigurationRequestObject,
) (openapi.UpdateVisitorEnrollmentConfigurationResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	value, err := s.visitor.UpdateConfiguration(ctx, principal, visitor.ConfigurationInput{
		Enabled: request.Body.Enabled, DeviceTypeIDs: request.Body.DeviceTypeIds,
		ExpectedVersion: request.Body.ExpectedVersion,
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateVisitorEnrollmentConfiguration200JSONResponse(visitorConfigurationDTO(value)), nil
}

func (s *Server) BeginVisitorEnrollment(
	ctx context.Context,
	_ openapi.BeginVisitorEnrollmentRequestObject,
) (openapi.BeginVisitorEnrollmentResponseObject, error) {
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

func (s *Server) GetVisitorEnrollmentState(
	ctx context.Context,
	_ openapi.GetVisitorEnrollmentStateRequestObject,
) (openapi.GetVisitorEnrollmentStateResponseObject, error) {
	enrollment, ok := ctx.Value(visitorEnrollmentContextKey).(visitor.Context)
	if !ok {
		return nil, invalidRequest("enrollment context is required")
	}
	state, err := s.visitor.State(ctx, enrollment)
	if err != nil {
		return nil, err
	}
	capabilities := make([]openapi.DeviceCapability, len(state.Capabilities))
	for index, capability := range state.Capabilities {
		capabilities[index] = openapi.DeviceCapability(capability)
	}
	// The consent question of a tablet check-in is asked while enrolling, so a new visitor answers it right away.
	categories, err := s.notifyRules.ConsentCategories(ctx)
	if err != nil {
		return nil, err
	}
	consentCategories := make([]openapi.TerminalConsentCategory, len(categories))
	for index, category := range categories {
		consentCategories[index] = openapi.TerminalConsentCategory{
			Id: category.ID, Name: category.Name, Description: category.Description,
			Basis: openapi.TerminalConsentCategoryBasis(category.Basis),
		}
	}
	email := nullable.NewNullNullable[string]()
	if state.Email != "" {
		email = nullable.NewNullableWithValue(state.Email)
	}
	// The tablet's calibrated crop and lens pointer, so the live preview shows exactly what the photo will contain.
	camera, err := s.managedDevices.KioskCamera(ctx, enrollment.ManagedDeviceID)
	if err != nil {
		return nil, err
	}
	cameraSettings := cameraSettingsDTO(camera.CameraSettings)
	result := openapi.VisitorEnrollmentState{
		Camera:            &cameraSettings,
		Email:             email,
		EmailVerified:     state.EmailVerified,
		Capabilities:      capabilities,
		LabRulesRequired:  state.LabRulesRequired,
		ConsentCategories: consentCategories,
		ExpiresAt:         state.ExpiresAt,
	}
	if state.CurrentLabRules == nil {
		result.CurrentLabRules = nullable.NewNullNullable[openapi.VisitorLabRulesVersion]()
	} else {
		result.CurrentLabRules = nullable.NewNullableWithValue(openapi.VisitorLabRulesVersion{
			Id:            state.CurrentLabRules.ID,
			HumanRevision: state.CurrentLabRules.HumanRevision,
			EffectiveAt:   state.CurrentLabRules.EffectiveAt,
		})
	}
	return openapi.GetVisitorEnrollmentState200JSONResponse(result), nil
}

func (s *Server) GetVisitorEnrollmentLabRulesPDF(
	ctx context.Context,
	_ openapi.GetVisitorEnrollmentLabRulesPDFRequestObject,
) (openapi.GetVisitorEnrollmentLabRulesPDFResponseObject, error) {
	enrollment, ok := ctx.Value(visitorEnrollmentContextKey).(visitor.Context)
	if !ok {
		return nil, invalidRequest("enrollment context is required")
	}
	file, reader, err := s.visitor.OpenLabRules(ctx, enrollment)
	if err != nil {
		return nil, err
	}
	return openapi.GetVisitorEnrollmentLabRulesPDF200ApplicationpdfResponse{Body: reader, ContentLength: file.Size}, nil
}

func (s *Server) SubmitVisitorEnrollment(
	ctx context.Context,
	request openapi.SubmitVisitorEnrollmentRequestObject,
) (openapi.SubmitVisitorEnrollmentResponseObject, error) {
	enrollment, ok := ctx.Value(visitorEnrollmentContextKey).(visitor.Context)
	if !ok {
		return nil, invalidRequest("enrollment context is required")
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	// The service decides whether a photo is required for this device; an absent or null image is simply empty.
	var profileImage []byte
	if request.Body.ProfileImageBase64.IsSpecified() && !request.Body.ProfileImageBase64.IsNull() {
		profileImage = request.Body.ProfileImageBase64.GetOrEmpty()
	}
	consents := make([]notifyrules.ConsentAnswer, len(request.Body.Consents))
	for index, answer := range request.Body.Consents {
		consents[index] = notifyrules.ConsentAnswer{CategoryID: answer.CategoryId, Granted: answer.Granted}
	}
	result, err := s.visitor.Submit(ctx, enrollment, visitor.SubmissionInput{
		FirstName: request.Body.FirstName, LastName: request.Body.LastName,
		ProfileImage: profileImage, ProfileImageFilename: request.Body.ProfileImageFilename.GetOrEmpty(),
		LabRulesAccepted: request.Body.LabRulesAccepted,
		Consents:         consents,
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	body := openapi.VisitorEnrollmentResult{
		PersonId: result.PersonID, AccountId: result.AccountID,
		AccountStatus: openapi.VisitorEnrollmentResultAccountStatus(result.AccountStatus),
		Admission:     openapi.VisitorEnrollmentResultAdmission(result.Admission),
		Attendance:    openapi.VisitorEnrollmentResultAttendance(result.Attendance),
	}
	return visitorSubmissionCookieResponse{config: s.config, body: body}, nil
}

func (s *Server) SendVisitorEnrollmentEmailCode(
	ctx context.Context,
	request openapi.SendVisitorEnrollmentEmailCodeRequestObject,
) (openapi.SendVisitorEnrollmentEmailCodeResponseObject, error) {
	enrollment, ok := ctx.Value(visitorEnrollmentContextKey).(visitor.Context)
	if !ok {
		return nil, invalidRequest("enrollment context is required")
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err := s.visitor.SendEmailCode(ctx, enrollment, request.Body.Email, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.SendVisitorEnrollmentEmailCode202Response{
		Headers: openapi.SendVisitorEnrollmentEmailCode202ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (s *Server) ConfirmVisitorEnrollmentEmail(
	ctx context.Context,
	request openapi.ConfirmVisitorEnrollmentEmailRequestObject,
) (openapi.ConfirmVisitorEnrollmentEmailResponseObject, error) {
	enrollment, ok := ctx.Value(visitorEnrollmentContextKey).(visitor.Context)
	if !ok {
		return nil, invalidRequest("enrollment context is required")
	}
	if request.Body == nil || request.Body.Code == nil {
		return nil, invalidRequest("code is required")
	}
	if err := s.visitor.ConfirmEmail(ctx, enrollment, *request.Body.Code, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.ConfirmVisitorEnrollmentEmail204Response{
		Headers: openapi.ConfirmVisitorEnrollmentEmail204ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (s *Server) EvaluateVisitorAdmission(
	ctx context.Context,
	_ openapi.EvaluateVisitorAdmissionRequestObject,
) (openapi.EvaluateVisitorAdmissionResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	result, err := s.visitor.Admission(ctx, principal)
	if err != nil {
		return nil, err
	}
	return openapi.EvaluateVisitorAdmission200JSONResponse{
		Decision: openapi.VisitorAdmissionResultDecision(result.Decision), Status: laborordnungStatusDTO(result.Status),
	}, nil
}

func visitorConfigurationDTO(value visitor.Configuration) openapi.VisitorEnrollmentConfiguration {
	return openapi.VisitorEnrollmentConfiguration{
		Enabled: value.Enabled, DeviceTypeIds: value.DeviceTypeIDs, Version: value.Version, UpdatedAt: value.UpdatedAt,
	}
}

type visitorContextCookieResponse struct {
	config config.Config
	issue  visitor.ContextIssue
}

func (response visitorContextCookieResponse) VisitBeginVisitorEnrollmentResponse(w http.ResponseWriter) error {
	w.Header().Set("Cache-Control", "no-store")
	setEnrollmentCookie(
		w,
		response.config,
		response.config.EnrollmentCookieName,
		response.issue.ContextToken,
		true,
		response.issue.ExpiresAt,
		int(time.Until(response.issue.ExpiresAt).Seconds()),
	)
	setEnrollmentCookie(
		w,
		response.config,
		response.config.EnrollmentCSRFName,
		response.issue.CSRFToken,
		false,
		response.issue.ExpiresAt,
		int(time.Until(response.issue.ExpiresAt).Seconds()),
	)
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

func setEnrollmentCookie(
	w http.ResponseWriter,
	cfg config.Config,
	name, value string,
	httpOnly bool,
	expires time.Time,
	maxAge int,
) {
	http.SetCookie(
		w,
		//nolint:gosec // Secure follows config, HttpOnly and SameSite are explicit; the CSRF cookie is readable by design
		&http.Cookie{
			Name:     name,
			Value:    value,
			Path:     "/",
			Expires:  expires,
			MaxAge:   maxAge,
			HttpOnly: httpOnly,
			Secure:   cfg.SessionCookieSecure,
			SameSite: http.SameSiteStrictMode,
		},
	)
}
