package httpapi

import (
	"context"
	"encoding/json"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/auth"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/roles"
	"github.com/oapi-codegen/nullable"
)

const noStore = "no-store"

func pendingLoginToken(ctx context.Context) string {
	value, _ := ctx.Value(pendingLoginTokenContextKey).(string)
	return value
}

func requireAuthenticated(ctx context.Context) (auth.Authenticated, error) {
	authenticated, ok := ctx.Value(authenticatedContextKey).(auth.Authenticated)
	if !ok {
		return auth.Authenticated{}, apperror.Unauthenticated
	}
	return authenticated, nil
}

func webAuthnOptionsDTO(options map[string]any) openapi.WebAuthnOptions {
	result := openapi.WebAuthnOptions{AdditionalProperties: map[string]any{}}
	for key, value := range options {
		if key == "publicKey" {
			result.PublicKey, _ = value.(map[string]any)
			continue
		}
		result.AdditionalProperties[key] = value
	}
	return result
}

func credentialBytes(credential map[string]any) ([]byte, error) {
	if len(credential) == 0 {
		return nil, invalidRequest("credential is required")
	}
	encoded, err := json.Marshal(credential)
	if err != nil {
		return nil, invalidRequest("credential is invalid")
	}
	return encoded, nil
}

func nullableTimestamp(value *time.Time) nullable.Nullable[time.Time] {
	if value == nil {
		return nullable.NewNullNullable[time.Time]()
	}
	return nullable.NewNullableWithValue(*value)
}

func passkeyDTO(passkey auth.Passkey) openapi.Passkey {
	return openapi.Passkey{
		Id: passkey.ID, Name: passkey.Name, CreatedAt: passkey.CreatedAt,
		LastUsedAt: nullableTimestamp(passkey.LastUsedAt), BackedUp: passkey.BackedUp,
	}
}

func secondFactorSummaryDTO(summary auth.SecondFactorSummary) openapi.SecondFactorSummary {
	result := openapi.SecondFactorSummary{
		Enrolled: summary.Enrolled(), Passkeys: make([]openapi.Passkey, 0, len(summary.Passkeys)),
		RecoveryCodesRemaining: summary.RecoveryCodesRemaining, Totp: nullable.NewNullNullable[openapi.TotpSummary](),
	}
	if summary.TOTP != nil {
		result.Totp = nullable.NewNullableWithValue(openapi.TotpSummary{
			ConfirmedAt: summary.TOTP.ConfirmedAt, LastUsedAt: nullableTimestamp(summary.TOTP.LastUsedAt),
		})
	}
	for _, passkey := range summary.Passkeys {
		result.Passkeys = append(result.Passkeys, passkeyDTO(passkey))
	}
	return result
}

func enrollmentResultDTO(result auth.EnrollmentResult) openapi.SecondFactorEnrollmentResult {
	dto := openapi.SecondFactorEnrollmentResult{
		SecondFactors: secondFactorSummaryDTO(result.Summary), RecoveryCodes: nullable.NewNullNullable[[]string](),
	}
	if result.RecoveryCodes != nil {
		dto.RecoveryCodes = nullable.NewNullableWithValue(result.RecoveryCodes)
	}
	return dto
}

// currentAuthentication describes how the session was authenticated and what the frontend must ask for.
func (s *Server) currentAuthentication(
	ctx context.Context,
	authenticated auth.Authenticated,
	principal authorization.Principal,
) (openapi.CurrentAuthentication, error) {
	state, err := s.auth.SecondFactorState(ctx, principal.AccountID)
	if err != nil {
		return openapi.CurrentAuthentication{}, err
	}
	methods := make([]openapi.SecondFactorMethod, 0)
	for _, method := range state.Methods() {
		methods = append(methods, openapi.SecondFactorMethod(method))
	}
	pending := make([]openapi.ReauthenticationRequirement, 0)
	for _, entry := range principal.PendingPermissions() {
		pending = append(pending, openapi.ReauthenticationRequirement{
			PermissionId:      openapi.PermissionId(entry.Permission),
			RequiredAssurance: openapi.AuthenticationAssurance(entry.Requirement.Assurance),
			WithinMinutes:     entry.Requirement.WithinMinutes,
		})
	}
	return openapi.CurrentAuthentication{
		Method:                   openapi.CurrentAuthenticationMethod(authenticated.AuthMethod),
		Assurance:                openapi.AuthenticationAssurance(principal.Assurance),
		AuthenticatedAt:          principal.AuthenticatedAt,
		AuthenticatedAssurance:   openapi.AuthenticationAssurance(principal.ProofAssurance()),
		MfaEnrolled:              state.Enrolled(),
		MfaRequired:              state.Required,
		MfaSetupRequired:         authenticated.MFASetupRequired && !state.Enrolled(),
		SecondFactorMethods:      methods,
		ReauthenticationRequired: pending,
	}, nil
}

func (s *Server) CompleteSecondFactorLogin(
	ctx context.Context,
	request openapi.CompleteSecondFactorLoginRequestObject,
) (openapi.CompleteSecondFactorLoginResponseObject, error) {
	if request.Body == nil || request.Body.Code == nil {
		return nil, invalidRequest("method and code are required")
	}
	session, err := s.auth.CompleteSecondFactorLogin(
		ctx, pendingLoginToken(ctx), auth.SecondFactorMethod(request.Body.Method), *request.Body.Code,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return secondFactorSessionResponse{config: s.config, session: session}, nil
}

func (s *Server) StartSecondFactorPasskey(
	ctx context.Context,
	_ openapi.StartSecondFactorPasskeyRequestObject,
) (openapi.StartSecondFactorPasskeyResponseObject, error) {
	options, err := s.auth.StartSecondFactorPasskey(ctx, pendingLoginToken(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.StartSecondFactorPasskey200JSONResponse{
		Body: webAuthnOptionsDTO(options), Headers: openapi.StartSecondFactorPasskey200ResponseHeaders{CacheControl: noStore},
	}, nil
}

func (s *Server) CompleteSecondFactorPasskey(
	ctx context.Context,
	request openapi.CompleteSecondFactorPasskeyRequestObject,
) (openapi.CompleteSecondFactorPasskeyResponseObject, error) {
	if request.Body == nil {
		return nil, invalidRequest("credential is required")
	}
	credential, err := credentialBytes(request.Body.Credential)
	if err != nil {
		return nil, err
	}
	session, err := s.auth.CompleteSecondFactorPasskey(ctx, pendingLoginToken(ctx), credential, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return secondFactorSessionResponse{config: s.config, session: session}, nil
}

func (s *Server) StartPasskeyLogin(
	ctx context.Context,
	_ openapi.StartPasskeyLoginRequestObject,
) (openapi.StartPasskeyLoginResponseObject, error) {
	options, err := s.auth.StartPasskeyLogin(ctx, sourceAddress(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.StartPasskeyLogin200JSONResponse{
		Body: webAuthnOptionsDTO(options), Headers: openapi.StartPasskeyLogin200ResponseHeaders{CacheControl: noStore},
	}, nil
}

func (s *Server) CompletePasskeyLogin(
	ctx context.Context,
	request openapi.CompletePasskeyLoginRequestObject,
) (openapi.CompletePasskeyLoginResponseObject, error) {
	if request.Body == nil {
		return nil, invalidRequest("credential is required")
	}
	credential, err := credentialBytes(request.Body.Credential)
	if err != nil {
		return nil, err
	}
	session, err := s.auth.CompletePasskeyLogin(ctx, credential, sourceAddress(ctx), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return secondFactorSessionResponse{config: s.config, session: session}, nil
}

func (s *Server) reauthenticationResponse(
	ctx context.Context,
	principal authorization.Principal,
) (openapi.CurrentAuthentication, error) {
	authenticated, err := requireAuthenticated(ctx)
	if err != nil {
		return openapi.CurrentAuthentication{}, err
	}
	return s.currentAuthentication(ctx, authenticated, principal)
}

func (s *Server) Reauthenticate(
	ctx context.Context,
	request openapi.ReauthenticateRequestObject,
) (openapi.ReauthenticateResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil || request.Body.Password == nil {
		return nil, invalidRequest("password is required")
	}
	input := auth.ReauthenticationInput{Password: *request.Body.Password}
	if request.Body.TotpCode != nil {
		input.TOTPCode = *request.Body.TotpCode
	}
	if request.Body.RecoveryCode != nil {
		input.RecoveryCode = *request.Body.RecoveryCode
	}
	fresh, err := s.auth.Reauthenticate(ctx, principal, input, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	body, err := s.reauthenticationResponse(ctx, fresh)
	if err != nil {
		return nil, err
	}
	return openapi.Reauthenticate200JSONResponse{
		Body: body, Headers: openapi.Reauthenticate200ResponseHeaders{CacheControl: noStore},
	}, nil
}

func (s *Server) StartPasskeyReauthentication(
	ctx context.Context,
	_ openapi.StartPasskeyReauthenticationRequestObject,
) (openapi.StartPasskeyReauthenticationResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	options, err := s.auth.StartPasskeyReauthentication(ctx, principal)
	if err != nil {
		return nil, err
	}
	return openapi.StartPasskeyReauthentication200JSONResponse{
		Body:    webAuthnOptionsDTO(options),
		Headers: openapi.StartPasskeyReauthentication200ResponseHeaders{CacheControl: noStore},
	}, nil
}

func (s *Server) CompletePasskeyReauthentication(
	ctx context.Context,
	request openapi.CompletePasskeyReauthenticationRequestObject,
) (openapi.CompletePasskeyReauthenticationResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("credential is required")
	}
	credential, err := credentialBytes(request.Body.Credential)
	if err != nil {
		return nil, err
	}
	fresh, err := s.auth.ReauthenticateWithPasskey(ctx, principal, credential, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	body, err := s.reauthenticationResponse(ctx, fresh)
	if err != nil {
		return nil, err
	}
	return openapi.CompletePasskeyReauthentication200JSONResponse{
		Body: body, Headers: openapi.CompletePasskeyReauthentication200ResponseHeaders{CacheControl: noStore},
	}, nil
}

func (s *Server) GetOwnSecondFactors(
	ctx context.Context,
	_ openapi.GetOwnSecondFactorsRequestObject,
) (openapi.GetOwnSecondFactorsResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	summary, err := s.auth.OwnSecondFactors(ctx, principal)
	if err != nil {
		return nil, err
	}
	return openapi.GetOwnSecondFactors200JSONResponse{
		Body: secondFactorSummaryDTO(summary), Headers: openapi.GetOwnSecondFactors200ResponseHeaders{CacheControl: noStore},
	}, nil
}

func (s *Server) StartTotpEnrollment(
	ctx context.Context,
	_ openapi.StartTotpEnrollmentRequestObject,
) (openapi.StartTotpEnrollmentResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	enrollment, err := s.auth.StartTOTPEnrollment(ctx, principal)
	if err != nil {
		return nil, err
	}
	return openapi.StartTotpEnrollment200JSONResponse{
		Body: openapi.TotpEnrollment{
			Secret: enrollment.Secret, OtpauthUri: enrollment.ProvisioningURI, ExpiresAt: enrollment.ExpiresAt,
		},
		Headers: openapi.StartTotpEnrollment200ResponseHeaders{CacheControl: noStore},
	}, nil
}

func (s *Server) ConfirmTotpEnrollment(
	ctx context.Context,
	request openapi.ConfirmTotpEnrollmentRequestObject,
) (openapi.ConfirmTotpEnrollmentResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil || request.Body.Code == nil {
		return nil, invalidRequest("code is required")
	}
	result, err := s.auth.ConfirmTOTPEnrollment(ctx, principal, *request.Body.Code, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.ConfirmTotpEnrollment200JSONResponse{
		Body: enrollmentResultDTO(result), Headers: openapi.ConfirmTotpEnrollment200ResponseHeaders{CacheControl: noStore},
	}, nil
}

func (s *Server) RemoveOwnTotp(
	ctx context.Context,
	_ openapi.RemoveOwnTotpRequestObject,
) (openapi.RemoveOwnTotpResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.auth.RemoveOwnTOTP(ctx, principal, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.RemoveOwnTotp204Response{}, nil
}

func (s *Server) RegenerateRecoveryCodes(
	ctx context.Context,
	_ openapi.RegenerateRecoveryCodesRequestObject,
) (openapi.RegenerateRecoveryCodesResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	codes, err := s.auth.RegenerateRecoveryCodes(ctx, principal, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.RegenerateRecoveryCodes200JSONResponse{
		Body:    openapi.RecoveryCodeList{RecoveryCodes: codes},
		Headers: openapi.RegenerateRecoveryCodes200ResponseHeaders{CacheControl: noStore},
	}, nil
}

func (s *Server) StartPasskeyRegistration(
	ctx context.Context,
	_ openapi.StartPasskeyRegistrationRequestObject,
) (openapi.StartPasskeyRegistrationResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	options, err := s.auth.StartPasskeyRegistration(ctx, principal)
	if err != nil {
		return nil, err
	}
	return openapi.StartPasskeyRegistration200JSONResponse{
		Body:    webAuthnOptionsDTO(options),
		Headers: openapi.StartPasskeyRegistration200ResponseHeaders{CacheControl: noStore},
	}, nil
}

func (s *Server) RegisterPasskey(
	ctx context.Context,
	request openapi.RegisterPasskeyRequestObject,
) (openapi.RegisterPasskeyResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("name and credential are required")
	}
	credential, err := credentialBytes(request.Body.Credential)
	if err != nil {
		return nil, err
	}
	result, err := s.auth.RegisterPasskey(ctx, principal, request.Body.Name, credential, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.RegisterPasskey201JSONResponse{
		Body: enrollmentResultDTO(result), Headers: openapi.RegisterPasskey201ResponseHeaders{CacheControl: noStore},
	}, nil
}

func (s *Server) RenamePasskey(
	ctx context.Context,
	request openapi.RenamePasskeyRequestObject,
) (openapi.RenamePasskeyResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("name is required")
	}
	passkey, err := s.auth.RenameOwnPasskey(ctx, principal, request.PasskeyId, request.Body.Name, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.RenamePasskey200JSONResponse(passkeyDTO(passkey)), nil
}

func (s *Server) RemovePasskey(
	ctx context.Context,
	request openapi.RemovePasskeyRequestObject,
) (openapi.RemovePasskeyResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.auth.RemoveOwnPasskey(ctx, principal, request.PasskeyId, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.RemovePasskey204Response{}, nil
}

func (s *Server) ResetAccountSecondFactors(
	ctx context.Context,
	request openapi.ResetAccountSecondFactorsRequestObject,
) (openapi.ResetAccountSecondFactorsResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("expectedVersion is required")
	}
	account, err := s.accounts.ResetSecondFactors(
		ctx, principal, request.AccountId, request.Body.ExpectedVersion, requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.ResetAccountSecondFactors200JSONResponse(accountDTO(account)), nil
}

func masterPolicyDTO(entries []roles.MasterReauthenticationEntry) openapi.MasterReauthenticationPolicy {
	items := make([]openapi.MasterReauthenticationEntry, 0, len(entries))
	for _, entry := range entries {
		items = append(items, openapi.MasterReauthenticationEntry{
			PermissionId: openapi.PermissionId(entry.Permission), WithinMinutes: entry.WithinMinutes,
		})
	}
	return openapi.MasterReauthenticationPolicy{Items: items}
}

func (s *Server) GetMasterReauthenticationPolicy(
	ctx context.Context,
	_ openapi.GetMasterReauthenticationPolicyRequestObject,
) (openapi.GetMasterReauthenticationPolicyResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	entries, err := s.roles.MasterReauthenticationPolicy(ctx, principal)
	if err != nil {
		return nil, err
	}
	return openapi.GetMasterReauthenticationPolicy200JSONResponse(masterPolicyDTO(entries)), nil
}

func (s *Server) ReplaceMasterReauthenticationPolicy(
	ctx context.Context,
	request openapi.ReplaceMasterReauthenticationPolicyRequestObject,
) (openapi.ReplaceMasterReauthenticationPolicyResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("items are required")
	}
	entries := make([]roles.MasterReauthenticationEntry, 0, len(request.Body.Items))
	for _, item := range request.Body.Items {
		entries = append(entries, roles.MasterReauthenticationEntry{
			Permission: authorization.Permission(item.PermissionId), WithinMinutes: item.WithinMinutes,
		})
	}
	result, err := s.roles.ReplaceMasterReauthenticationPolicy(ctx, principal, entries, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.ReplaceMasterReauthenticationPolicy200JSONResponse(masterPolicyDTO(result)), nil
}
