package httpapi

import (
	"context"
	"net/http"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/auth"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/oidc"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
)

func (s *Server) ListOIDCLoginProviders(ctx context.Context, _ openapi.ListOIDCLoginProvidersRequestObject) (openapi.ListOIDCLoginProvidersResponseObject, error) {
	providers, err := s.oidc.ListLoginProviders(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]openapi.OIDCLoginProvider, 0, len(providers))
	for _, provider := range providers {
		items = append(items, openapi.OIDCLoginProvider{Slug: provider.Slug, DisplayName: provider.DisplayName})
	}
	return openapi.ListOIDCLoginProviders200JSONResponse{Items: items}, nil
}

func (s *Server) ListOIDCProviders(ctx context.Context, _ openapi.ListOIDCProvidersRequestObject) (openapi.ListOIDCProvidersResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	providers, err := s.oidc.ListProviders(ctx, principal)
	if err != nil {
		return nil, err
	}
	items := make([]openapi.OIDCProvider, 0, len(providers))
	for _, provider := range providers {
		items = append(items, oidcProviderDTO(provider))
	}
	return openapi.ListOIDCProviders200JSONResponse{Items: items}, nil
}

func (s *Server) CreateOIDCProvider(ctx context.Context, request openapi.CreateOIDCProviderRequestObject) (openapi.CreateOIDCProviderResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	provider, err := s.oidc.CreateProvider(ctx, principal, oidc.ProviderInput{
		Slug: request.Body.Slug, DisplayName: request.Body.DisplayName, Issuer: request.Body.Issuer,
		ClientID: request.Body.ClientId, ClientSecret: request.Body.ClientSecret, Enabled: request.Body.Enabled,
		JITEnabled: request.Body.JitEnabled, ACRAssuranceMappings: assuranceMappings(request.Body.AcrAssuranceMappings),
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateOIDCProvider201JSONResponse(oidcProviderDTO(provider)), nil
}

func (s *Server) UpdateOIDCProvider(ctx context.Context, request openapi.UpdateOIDCProviderRequestObject) (openapi.UpdateOIDCProviderResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	provider, err := s.oidc.UpdateProvider(ctx, principal, request.OidcProviderId, oidc.ProviderInput{
		DisplayName: request.Body.DisplayName, Issuer: request.Body.Issuer, ClientID: request.Body.ClientId,
		ClientSecret: request.Body.ClientSecret, Enabled: request.Body.Enabled, JITEnabled: request.Body.JitEnabled,
		ACRAssuranceMappings: assuranceMappings(request.Body.AcrAssuranceMappings), ExpectedVersion: request.Body.ExpectedVersion,
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateOIDCProvider200JSONResponse(oidcProviderDTO(provider)), nil
}

func (s *Server) StartOIDCLogin(ctx context.Context, request openapi.StartOIDCLoginRequestObject) (openapi.StartOIDCLoginResponseObject, error) {
	flow, err := s.oidc.StartLogin(ctx, request.ProviderSlug)
	if err != nil {
		return nil, err
	}
	return openapi.StartOIDCLogin302Response{Headers: openapi.StartOIDCLogin302ResponseHeaders{
		Location: flow.AuthorizationURL, SetCookie: s.oidcFlowCookie(flow.BrowserToken, flow.ExpiresAt).String(),
	}}, nil
}

func (s *Server) StartOIDCLink(ctx context.Context, request openapi.StartOIDCLinkRequestObject) (openapi.StartOIDCLinkResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	password := ""
	if request.Body != nil && request.Body.CurrentPassword != nil {
		password = *request.Body.CurrentPassword
	}
	flow, err := s.oidc.StartLink(ctx, principal, request.ProviderSlug, password)
	if err != nil {
		return nil, err
	}
	return openapi.StartOIDCLink200JSONResponse{
		Body:    openapi.OIDCFlowStart{AuthorizationUrl: flow.AuthorizationURL},
		Headers: openapi.StartOIDCLink200ResponseHeaders{SetCookie: s.oidcFlowCookie(flow.BrowserToken, flow.ExpiresAt).String()},
	}, nil
}

func (s *Server) CompleteOIDCCallback(ctx context.Context, request openapi.CompleteOIDCCallbackRequestObject) (openapi.CompleteOIDCCallbackResponseObject, error) {
	browserToken, _ := ctx.Value(oidcFlowTokenContextKey).(string)
	principal, _ := requirePrincipal(ctx)
	result, err := s.oidc.Complete(ctx, request.Params.State, request.Params.Code, browserToken, principal, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	location := "/profile?oidc=linked"
	if result.Kind == "login" {
		location = "/"
	} else if result.Kind == "reauthenticate" {
		location = "/profile?oidc=reauthenticated"
	}
	return oidcCallbackResponse{server: s, session: result.Session, location: location}, nil
}

func (s *Server) UnlinkOwnOIDCIdentity(ctx context.Context, request openapi.UnlinkOwnOIDCIdentityRequestObject) (openapi.UnlinkOwnOIDCIdentityResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.oidc.Unlink(ctx, principal, request.IdentityId, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.UnlinkOwnOIDCIdentity204Response{}, nil
}

func oidcProviderDTO(provider oidc.Provider) openapi.OIDCProvider {
	mappings := make(map[string]openapi.AuthenticationAssurance, len(provider.ACRAssuranceMappings))
	for acr, assurance := range provider.ACRAssuranceMappings {
		mappings[acr] = openapi.AuthenticationAssurance(assurance)
	}
	return openapi.OIDCProvider{Id: provider.ID, Slug: provider.Slug, DisplayName: provider.DisplayName, Issuer: provider.Issuer, ClientId: provider.ClientID, Enabled: provider.Enabled, JitEnabled: provider.JITEnabled, AcrAssuranceMappings: mappings, Version: provider.Version, CreatedAt: provider.CreatedAt, UpdatedAt: provider.UpdatedAt}
}

func assuranceMappings(values map[string]openapi.AuthenticationAssurance) map[string]authorization.Assurance {
	result := make(map[string]authorization.Assurance, len(values))
	for acr, assurance := range values {
		result[acr] = authorization.Assurance(assurance)
	}
	return result
}

func (s *Server) oidcFlowCookie(value string, expires time.Time) *http.Cookie {
	maxAge := int(time.Until(expires).Seconds())
	if maxAge < 1 {
		maxAge = 1
	}
	return &http.Cookie{Name: s.config.OIDCFlowCookieName, Value: value, Path: "/", Expires: expires, MaxAge: maxAge, HttpOnly: true, Secure: s.config.SessionCookieSecure, SameSite: http.SameSiteLaxMode}
}

type oidcCallbackResponse struct {
	server   *Server
	session  *auth.Session
	location string
}

// VisitCompleteOIDCCallbackResponse writes multiple Set-Cookie fields, which a
// generated scalar response header cannot represent.
func (response oidcCallbackResponse) VisitCompleteOIDCCallbackResponse(w http.ResponseWriter) error {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Location", response.location)
	http.SetCookie(w, &http.Cookie{Name: response.server.config.OIDCFlowCookieName, Value: "", Path: "/", Expires: time.Unix(1, 0).UTC(), MaxAge: -1, HttpOnly: true, Secure: response.server.config.SessionCookieSecure, SameSite: http.SameSiteLaxMode})
	if response.session != nil {
		maxAge := int(time.Until(response.session.AbsoluteExpiry).Seconds())
		if maxAge < 1 {
			maxAge = 1
		}
		http.SetCookie(w, &http.Cookie{Name: response.server.config.SessionCookieName, Value: response.session.Token, Path: "/", Expires: response.session.AbsoluteExpiry, MaxAge: maxAge, HttpOnly: true, Secure: response.server.config.SessionCookieSecure, SameSite: http.SameSiteLaxMode})
		http.SetCookie(w, &http.Cookie{Name: response.server.config.CSRFCookieName, Value: response.session.CSRFToken, Path: "/", Expires: response.session.AbsoluteExpiry, MaxAge: maxAge, HttpOnly: false, Secure: response.server.config.SessionCookieSecure, SameSite: http.SameSiteLaxMode})
	}
	w.WriteHeader(http.StatusFound)
	return nil
}

func (s *Server) StartOIDCReauthentication(ctx context.Context, request openapi.StartOIDCReauthenticationRequestObject) (openapi.StartOIDCReauthenticationResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	flow, err := s.oidc.StartReauthentication(ctx, principal, request.ProviderSlug)
	if err != nil {
		return nil, err
	}
	return openapi.StartOIDCReauthentication200JSONResponse{Body: openapi.OIDCFlowStart{AuthorizationUrl: flow.AuthorizationURL}, Headers: openapi.StartOIDCReauthentication200ResponseHeaders{SetCookie: s.oidcFlowCookie(flow.BrowserToken, flow.ExpiresAt).String()}}, nil
}
