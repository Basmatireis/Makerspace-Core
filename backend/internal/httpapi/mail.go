package httpapi

import (
	"context"

	mailservice "github.com/Basmatireis/Makerspace-Core/backend/internal/mail"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
)

func (s *Server) GetMailConfiguration(ctx context.Context, _ openapi.GetMailConfigurationRequestObject) (openapi.GetMailConfigurationResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	configuration, err := s.mail.GetConfiguration(ctx, principal)
	if err != nil {
		return nil, err
	}
	return openapi.GetMailConfiguration200JSONResponse(mailConfigurationDTO(configuration)), nil
}

func (s *Server) UpdateMailConfiguration(ctx context.Context, request openapi.UpdateMailConfigurationRequestObject) (openapi.UpdateMailConfigurationResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	password := ""
	if request.Body.Password != nil {
		password = *request.Body.Password
	}
	configuration, err := s.mail.UpdateConfiguration(ctx, principal, mailservice.ConfigurationInput{Enabled: request.Body.Enabled, Host: request.Body.Host, Port: request.Body.Port, TLSMode: string(request.Body.TlsMode), Username: request.Body.Username, Password: password, FromAddress: request.Body.FromAddress, FromName: request.Body.FromName, BaseURL: request.Body.BaseUrl, ExpectedVersion: request.Body.ExpectedVersion}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateMailConfiguration200JSONResponse(mailConfigurationDTO(configuration)), nil
}

func mailConfigurationDTO(value mailservice.Configuration) openapi.MailConfiguration {
	return openapi.MailConfiguration{Enabled: value.Enabled, Provider: openapi.MailConfigurationProvider(value.Provider), Host: value.Host, Port: value.Port, TlsMode: openapi.MailConfigurationTlsMode(value.TLSMode), Username: value.Username, PasswordConfigured: value.PasswordConfigured, FromAddress: value.FromAddress, FromName: value.FromName, BaseUrl: value.BaseURL, Version: value.Version, UpdatedAt: value.UpdatedAt}
}
