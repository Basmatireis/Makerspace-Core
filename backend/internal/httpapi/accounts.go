package httpapi

import (
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/accounts"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/oapi-codegen/nullable"
)

func (s *Server) DeleteAccount(
	ctx context.Context,
	request openapi.DeleteAccountRequestObject,
) (openapi.DeleteAccountResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err := s.accounts.Delete(
		ctx,
		principal,
		request.AccountId,
		request.Body.ExpectedVersion,
		requestIDPointer(ctx),
	); err != nil {
		return nil, err
	}
	return openapi.DeleteAccount204Response{}, nil
}

func (s *Server) GetAccount(
	ctx context.Context,
	request openapi.GetAccountRequestObject,
) (openapi.GetAccountResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	account, err := s.accounts.Get(ctx, principal, request.AccountId)
	if err != nil {
		return nil, err
	}
	return openapi.GetAccount200JSONResponse(accountDTO(account)), nil
}

func (s *Server) DisableAccount(
	ctx context.Context,
	request openapi.DisableAccountRequestObject,
) (openapi.DisableAccountResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	account, err := s.accounts.SetStatus(
		ctx,
		principal,
		request.AccountId,
		"disabled",
		request.Body.ExpectedVersion,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.DisableAccount200JSONResponse(accountDTO(account)), nil
}

func (s *Server) EnableAccount(
	ctx context.Context,
	request openapi.EnableAccountRequestObject,
) (openapi.EnableAccountResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	account, err := s.accounts.SetStatus(
		ctx,
		principal,
		request.AccountId,
		"enabled",
		request.Body.ExpectedVersion,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.EnableAccount200JSONResponse(accountDTO(account)), nil
}

func (s *Server) UpdateAccountLoginEmail(
	ctx context.Context,
	request openapi.UpdateAccountLoginEmailRequestObject,
) (openapi.UpdateAccountLoginEmailResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	account, err := s.accounts.UpdateLoginEmail(
		ctx,
		principal,
		request.AccountId,
		string(request.Body.LoginEmail),
		request.Body.ExpectedVersion,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateAccountLoginEmail200JSONResponse(accountDTO(account)), nil
}

func (s *Server) SetAccountPassword(
	ctx context.Context,
	request openapi.SetAccountPasswordRequestObject,
) (openapi.SetAccountPasswordResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil || request.Body.NewPassword == nil {
		return nil, invalidRequest("newPassword is required")
	}
	account, err := s.accounts.SetPassword(
		ctx,
		principal,
		request.AccountId,
		*request.Body.NewPassword,
		request.Body.ExpectedVersion,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.SetAccountPassword200JSONResponse(accountDTO(account)), nil
}

func (s *Server) SetAccountPin(
	ctx context.Context,
	request openapi.SetAccountPinRequestObject,
) (openapi.SetAccountPinResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil || request.Body.Pin == nil {
		return nil, invalidRequest("pin is required")
	}
	if err := s.auth.SetAccountPIN(
		ctx,
		principal,
		request.AccountId,
		request.Body.LoginName,
		*request.Body.Pin,
		request.Body.ExpectedVersion,
		requestIDPointer(ctx),
	); err != nil {
		return nil, err
	}
	return openapi.SetAccountPin204Response{}, nil
}

func (s *Server) RemoveAccountAuthIdentity(
	ctx context.Context,
	request openapi.RemoveAccountAuthIdentityRequestObject,
) (openapi.RemoveAccountAuthIdentityResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err := s.accounts.RemoveAuthIdentity(
		ctx,
		principal,
		request.AccountId,
		request.IdentityId,
		request.Body.ExpectedVersion,
		requestIDPointer(ctx),
	); err != nil {
		return nil, err
	}
	return openapi.RemoveAccountAuthIdentity204Response{}, nil
}

func (s *Server) IssueAccountPasswordReset(
	ctx context.Context,
	request openapi.IssueAccountPasswordResetRequestObject,
) (openapi.IssueAccountPasswordResetResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	issue, err := s.accounts.IssuePasswordReset(
		ctx,
		principal,
		request.AccountId,
		request.Body.ExpectedVersion,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.IssueAccountPasswordReset201JSONResponse{
		Body: openapi.PasswordResetIssue{
			Account: accountDTO(
				issue.Account,
			),
			ExpiresAt:      issue.ExpiresAt,
			DeliveryStatus: openapi.PasswordResetIssueDeliveryStatus(issue.DeliveryStatus),
			SetupUrl:       nullableString(issue.SetupURL),
		},
		Headers: openapi.IssueAccountPasswordReset201ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (s *Server) IssueAccountInvitation(
	ctx context.Context,
	request openapi.IssueAccountInvitationRequestObject,
) (openapi.IssueAccountInvitationResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	issue, err := s.accounts.IssueInvitation(
		ctx,
		principal,
		request.AccountId,
		request.Body.ExpectedVersion,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.IssueAccountInvitation201JSONResponse{
		Body: openapi.PasswordResetIssue{
			Account:        accountDTO(issue.Account),
			ExpiresAt:      issue.ExpiresAt,
			DeliveryStatus: openapi.PasswordResetIssueDeliveryStatus(issue.DeliveryStatus),
			SetupUrl:       nullableString(issue.SetupURL),
		},
		Headers: openapi.IssueAccountInvitation201ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (s *Server) IssueAccountPinEnrollment(
	ctx context.Context,
	request openapi.IssueAccountPinEnrollmentRequestObject,
) (openapi.IssueAccountPinEnrollmentResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	issue, err := s.accounts.IssuePINEnrollment(
		ctx,
		principal,
		request.AccountId,
		request.Body.ExpectedVersion,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.IssueAccountPinEnrollment201JSONResponse{
		Body: openapi.PasswordResetIssue{
			Account:        accountDTO(issue.Account),
			ExpiresAt:      issue.ExpiresAt,
			DeliveryStatus: openapi.PasswordResetIssueDeliveryStatus(issue.DeliveryStatus),
			SetupUrl:       nullableString(issue.SetupURL),
		},
		Headers: openapi.IssueAccountPinEnrollment201ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func accountDTO(account accounts.Account) openapi.Account {
	identities := make([]openapi.AuthIdentitySummary, 0, len(account.AuthIdentities))
	for _, identity := range account.AuthIdentities {
		identities = append(identities, openapi.AuthIdentitySummary{
			Id:           identity.ID,
			Kind:         openapi.AuthIdentitySummaryKind(identity.Kind),
			CreatedAt:    identity.CreatedAt,
			ProviderSlug: identity.ProviderSlug,
			DisplayIdentifier: nullablePointer[string](
				identity.DisplayIdentifier,
				func(value string) string { return value },
			),
			VerifiedAt: nullablePointer[time.Time](
				identity.VerifiedAt,
				func(value time.Time) time.Time { return value },
			),
			DisabledAt: nullablePointer[time.Time](
				identity.DisabledAt,
				func(value time.Time) time.Time { return value },
			),
			Usable: identity.Usable,
		})
	}
	return openapi.Account{
		Id: account.ID, PersonId: account.PersonID, Status: openapi.AccountStatus(account.Status),
		ProvisioningSource: openapi.AccountProvisioningSource(account.ProvisioningSource),
		FirstAuthenticatedAt: nullablePointer[time.Time](
			account.FirstAuthenticatedAt,
			func(value time.Time) time.Time { return value },
		),
		PasswordStatus: openapi.PasswordStatus(account.PasswordStatus),
		LoginEmail:     optionalLoginEmail(account.LoginEmail),
		AuthIdentities: identities,
		Version:        account.Version, CreatedAt: account.CreatedAt, UpdatedAt: account.UpdatedAt,
	}
}

func optionalLoginEmail(value string) nullable.Nullable[openapi.Email] {
	if value == "" {
		return nullable.NewNullNullable[openapi.Email]()
	}
	return nullable.NewNullableWithValue(openapi.Email(value))
}

func accountSummaryDTO(account accounts.Account) openapi.AccountSummary {
	full := accountDTO(account)
	return openapi.AccountSummary{
		Id: full.Id, PersonId: full.PersonId, Status: full.Status, PasswordStatus: full.PasswordStatus,
		ProvisioningSource: openapi.AccountSummaryProvisioningSource(
			full.ProvisioningSource,
		), FirstAuthenticatedAt: full.FirstAuthenticatedAt,
		LoginEmail: full.LoginEmail, AuthIdentities: full.AuthIdentities, Version: full.Version,
	}
}
