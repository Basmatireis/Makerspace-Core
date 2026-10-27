package httpapi

import (
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/auth"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/oapi-codegen/nullable"
)

func (s *Server) Login(ctx context.Context, request openapi.LoginRequestObject) (openapi.LoginResponseObject, error) {
	if request.Body == nil || request.Body.Password == nil {
		return nil, invalidRequest("email and password are required")
	}
	result, err := s.auth.Login(
		ctx,
		string(request.Body.Email),
		*request.Body.Password,
		sourceAddress(ctx),
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	if result.Pending != nil {
		return pendingLoginResponse{config: s.config, pending: *result.Pending}, nil
	}
	return cookieNoContentResponse{config: s.config, session: result.Session}, nil
}

func (s *Server) LoginWithPin(
	ctx context.Context,
	request openapi.LoginWithPinRequestObject,
) (openapi.LoginWithPinResponseObject, error) {
	if request.Body == nil || request.Body.Pin == nil {
		return nil, invalidRequest("loginName and pin are required")
	}
	session, err := s.auth.LoginWithPIN(
		ctx,
		request.Body.LoginName,
		*request.Body.Pin,
		sourceAddress(ctx),
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return cookieNoContentResponse{config: s.config, session: &session}, nil
}

func (s *Server) EnrollOwnPin(
	ctx context.Context,
	request openapi.EnrollOwnPinRequestObject,
) (openapi.EnrollOwnPinResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil || request.Body.Pin == nil {
		return nil, invalidRequest("loginName and pin are required")
	}
	if err := s.auth.EnrollOwnPIN(
		ctx,
		principal,
		request.Body.LoginName,
		*request.Body.Pin,
		requestIDPointer(ctx),
	); err != nil {
		return nil, err
	}
	return openapi.EnrollOwnPin204Response{}, nil
}

func (s *Server) CompletePinEnrollment(
	ctx context.Context,
	request openapi.CompletePinEnrollmentRequestObject,
) (openapi.CompletePinEnrollmentResponseObject, error) {
	if request.Body == nil || request.Body.Pin == nil {
		return nil, invalidRequest("accountId, code, loginName, and pin are required")
	}
	if err := s.auth.CompletePINEnrollment(
		ctx,
		request.Body.AccountId,
		request.Body.Code,
		request.Body.LoginName,
		*request.Body.Pin,
		sourceAddress(ctx),
		requestIDPointer(ctx),
	); err != nil {
		return nil, err
	}
	return openapi.CompletePinEnrollment204Response{}, nil
}

func (s *Server) RemoveOwnPin(
	ctx context.Context,
	_ openapi.RemoveOwnPinRequestObject,
) (openapi.RemoveOwnPinResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.auth.RemoveOwnPIN(ctx, principal, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.RemoveOwnPin204Response{}, nil
}

func (s *Server) Logout(ctx context.Context, _ openapi.LogoutRequestObject) (openapi.LogoutResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.auth.Logout(ctx, principal, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return cookieNoContentResponse{config: s.config, clear: true}, nil
}

func (s *Server) GetCurrentUser(
	ctx context.Context,
	_ openapi.GetCurrentUserRequestObject,
) (openapi.GetCurrentUserResponseObject, error) {
	authenticated, ok := ctx.Value(authenticatedContextKey).(auth.Authenticated)
	if !ok {
		return nil, apperror.Unauthenticated
	}
	principal := authenticated.Principal
	account, err := s.accounts.GetCurrent(ctx, principal)
	if err != nil {
		return nil, err
	}
	person, err := s.people.GetCurrent(ctx, principal)
	if err != nil {
		return nil, err
	}
	personResponse, err := s.personDTO(ctx, principal, person, principal.CanReadPerson(person.ID), false)
	if err != nil {
		return nil, err
	}
	permissions := principal.PermissionIDs()
	permissionIDs := make([]openapi.PermissionId, 0, len(permissions))
	for _, permission := range permissions {
		permissionIDs = append(permissionIDs, openapi.PermissionId(permission))
	}
	delegable := make([]openapi.PermissionGrant, 0)
	for _, grant := range principal.DelegablePermissionGrants() {
		delegable = append(delegable, grantDTO(grant))
	}
	device := nullable.NewNullNullable[openapi.ManagedDeviceContext]()
	if principal.Device != nil {
		device = nullable.NewNullableWithValue(
			openapi.ManagedDeviceContext{
				Id:             principal.Device.ID,
				Name:           principal.Device.Name,
				DeviceTypeId:   principal.Device.DeviceTypeID,
				DeviceTypeName: principal.Device.DeviceTypeName,
				ExpiresAt: nullablePointer[time.Time](
					principal.Device.ExpiresAt,
					func(v time.Time) time.Time { return v },
				),
			},
		)
	}
	authentication, err := s.currentAuthentication(ctx, authenticated, principal)
	if err != nil {
		return nil, err
	}
	laborStatus, err := s.laborordnung.Evaluate(ctx, principal.PersonID)
	if err != nil {
		return nil, err
	}
	return openapi.GetCurrentUser200JSONResponse{
		Body: openapi.CurrentUser{
			Account: accountDTO(account), Person: personResponse, Permissions: permissionIDs,
			AuthenticationAssurance: openapi.AuthenticationAssurance(principal.Assurance),
			Authentication:          authentication,
			ManagedDevice:           device, DelegablePermissionGrants: delegable,
			LaborordnungStatus: laborordnungStatusDTO(laborStatus),
			Session: openapi.SessionContext{
				IdleExpiresAt:          authenticated.IdleExpiresAt,
				AbsoluteExpiresAt:      authenticated.AbsoluteExpiresAt,
				PostSessionDestination: openapi.PostSessionDestination(authenticated.PostSessionDestination),
			},
		},
		Headers: openapi.GetCurrentUser200ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (s *Server) RecordSessionActivity(
	ctx context.Context,
	_ openapi.RecordSessionActivityRequestObject,
) (openapi.RecordSessionActivityResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	session, err := s.auth.RecordActivity(ctx, principal)
	if err != nil {
		return nil, err
	}
	return openapi.RecordSessionActivity200JSONResponse{
		IdleExpiresAt:          session.IdleExpiresAt,
		AbsoluteExpiresAt:      session.AbsoluteExpiry,
		PostSessionDestination: openapi.PostSessionDestination(session.PostSessionDestination),
	}, nil
}

func (s *Server) ChangeOwnPassword(
	ctx context.Context,
	request openapi.ChangeOwnPasswordRequestObject,
) (openapi.ChangeOwnPasswordResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil || request.Body.CurrentPassword == nil || request.Body.NewPassword == nil {
		return nil, invalidRequest("currentPassword and newPassword are required")
	}
	session, err := s.auth.ChangePassword(
		ctx,
		principal,
		*request.Body.CurrentPassword,
		*request.Body.NewPassword,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return cookieNoContentResponse{config: s.config, session: &session}, nil
}

func (s *Server) RemoveOwnPassword(
	ctx context.Context,
	request openapi.RemoveOwnPasswordRequestObject,
) (openapi.RemoveOwnPasswordResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil || request.Body.CurrentPassword == nil {
		return nil, invalidRequest("currentPassword is required")
	}
	if err := s.auth.RemovePassword(ctx, principal, *request.Body.CurrentPassword, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return cookieNoContentResponse{config: s.config, clear: true}, nil
}

func (s *Server) CompletePasswordReset(
	ctx context.Context,
	request openapi.CompletePasswordResetRequestObject,
) (openapi.CompletePasswordResetResponseObject, error) {
	if request.Body == nil || request.Body.Token == nil || request.Body.NewPassword == nil {
		return nil, invalidRequest("token and newPassword are required")
	}
	if err := s.auth.RedeemPasswordReset(
		ctx,
		*request.Body.Token,
		*request.Body.NewPassword,
		requestIDPointer(ctx),
	); err != nil {
		return nil, err
	}
	return cookieNoContentResponse{config: s.config, clear: true}, nil
}

func (s *Server) RequestPasswordReset(
	ctx context.Context,
	request openapi.RequestPasswordResetRequestObject,
) (openapi.RequestPasswordResetResponseObject, error) {
	if request.Body == nil {
		return nil, invalidRequest("email is required")
	}
	if err := s.auth.RequestPasswordReset(
		ctx,
		string(request.Body.Email),
		sourceAddress(ctx),
		requestIDPointer(ctx),
	); err != nil {
		return nil, err
	}
	return openapi.RequestPasswordReset202Response{
		Headers: openapi.RequestPasswordReset202ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (s *Server) CompletePasswordResetCode(
	ctx context.Context,
	request openapi.CompletePasswordResetCodeRequestObject,
) (openapi.CompletePasswordResetCodeResponseObject, error) {
	if request.Body == nil || request.Body.NewPassword == nil {
		return nil, invalidRequest("email, code, and newPassword are required")
	}
	if err := s.auth.CompletePasswordResetCode(
		ctx,
		string(request.Body.Email),
		request.Body.Code,
		*request.Body.NewPassword,
		sourceAddress(ctx),
		requestIDPointer(ctx),
	); err != nil {
		return nil, err
	}
	return openapi.CompletePasswordResetCode204Response{
		Headers: openapi.CompletePasswordResetCode204ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (s *Server) CompleteInvitation(
	ctx context.Context,
	request openapi.CompleteInvitationRequestObject,
) (openapi.CompleteInvitationResponseObject, error) {
	if request.Body == nil || request.Body.NewPassword == nil {
		return nil, invalidRequest("email, code, and newPassword are required")
	}
	if err := s.auth.CompleteInvitation(
		ctx,
		string(request.Body.Email),
		request.Body.Code,
		*request.Body.NewPassword,
		sourceAddress(ctx),
		requestIDPointer(ctx),
	); err != nil {
		return nil, err
	}
	return openapi.CompleteInvitation204Response{
		Headers: openapi.CompleteInvitation204ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (s *Server) RequestOwnEmailVerification(
	ctx context.Context,
	_ openapi.RequestOwnEmailVerificationRequestObject,
) (openapi.RequestOwnEmailVerificationResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.auth.RequestOwnEmailVerification(ctx, principal, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.RequestOwnEmailVerification202Response{
		Headers: openapi.RequestOwnEmailVerification202ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (s *Server) CompleteEmailVerification(
	ctx context.Context,
	request openapi.CompleteEmailVerificationRequestObject,
) (openapi.CompleteEmailVerificationResponseObject, error) {
	if request.Body == nil {
		return nil, invalidRequest("email and code are required")
	}
	if err := s.auth.CompleteEmailVerification(
		ctx,
		string(request.Body.Email),
		request.Body.Code,
		sourceAddress(ctx),
		requestIDPointer(ctx),
	); err != nil {
		return nil, err
	}
	return openapi.CompleteEmailVerification204Response{
		Headers: openapi.CompleteEmailVerification204ResponseHeaders{CacheControl: "no-store"},
	}, nil
}
