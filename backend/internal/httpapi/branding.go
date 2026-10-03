package httpapi

import (
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/branding"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
)

func (s *Server) GetPublicConfiguration(ctx context.Context, _ openapi.GetPublicConfigurationRequestObject) (openapi.GetPublicConfigurationResponseObject, error) {
	configuration, err := s.branding.GetPublic(ctx)
	if err != nil {
		return nil, err
	}
	return openapi.GetPublicConfiguration200JSONResponse(publicBrandingConfigurationDTO(configuration)), nil
}

func (s *Server) GetPublicLegalDocument(ctx context.Context, request openapi.GetPublicLegalDocumentRequestObject) (openapi.GetPublicLegalDocumentResponseObject, error) {
	document, err := s.branding.PublicLegal(ctx, string(request.Document))
	if err != nil {
		return nil, err
	}
	return openapi.GetPublicLegalDocument200JSONResponse(openapi.PublicLegalDocument{
		Kind: openapi.PublicLegalDocumentKind(document.Kind), Title: document.Title,
		Mode: openapi.PublicLegalDocumentMode(document.Mode), Markdown: nullableString(document.Markdown), ExternalUrl: nullableString(document.ExternalURL),
	}), nil
}

func (s *Server) GetPublicBrandingAsset(ctx context.Context, request openapi.GetPublicBrandingAssetRequestObject) (openapi.GetPublicBrandingAssetResponseObject, error) {
	slot, err := branding.ParseSlot(string(request.Slot))
	if err != nil {
		return nil, err
	}
	asset, err := s.branding.OpenPublicAsset(ctx, slot, request.Sha256)
	if err != nil {
		return nil, err
	}
	headers := openapi.GetPublicBrandingAsset200ResponseHeaders{
		CacheControl: "public, max-age=31536000, immutable", ETag: `"` + request.Sha256 + `"`, XContentTypeOptions: "nosniff",
		ContentSecurityPolicy: "default-src 'none'; style-src 'none'; sandbox",
	}
	switch asset.ContentType {
	case "image/png":
		return openapi.GetPublicBrandingAsset200ImagepngResponse{Body: asset.Reader, ContentLength: asset.File.Size, Headers: headers}, nil
	case "image/webp":
		return openapi.GetPublicBrandingAsset200ImagewebpResponse{Body: asset.Reader, ContentLength: asset.File.Size, Headers: headers}, nil
	case "image/jpeg":
		return openapi.GetPublicBrandingAsset200ImagejpegResponse{Body: asset.Reader, ContentLength: asset.File.Size, Headers: headers}, nil
	case "image/svg+xml":
		return openapi.GetPublicBrandingAsset200ImagesvgXmlResponse{Body: asset.Reader, ContentLength: asset.File.Size, Headers: headers}, nil
	default:
		_ = asset.Reader.Close()
		return nil, invalidRequest("stored branding asset content type is invalid")
	}
}

func (s *Server) GetBrandingConfiguration(ctx context.Context, _ openapi.GetBrandingConfigurationRequestObject) (openapi.GetBrandingConfigurationResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	configuration, err := s.branding.Get(ctx, principal)
	if err != nil {
		return nil, err
	}
	return openapi.GetBrandingConfiguration200JSONResponse(brandingConfigurationDTO(configuration)), nil
}

func (s *Server) UpdateBrandingConfiguration(ctx context.Context, request openapi.UpdateBrandingConfigurationRequestObject) (openapi.UpdateBrandingConfigurationResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	configuration, err := s.branding.Update(ctx, principal, branding.ConfigurationInput{
		Identity:        branding.Identity{LegalOrganizationName: request.Body.Identity.LegalOrganizationName, DisplayName: request.Body.Identity.DisplayName, ApplicationName: request.Body.Identity.ApplicationName, Tagline: nullableStringPointer(request.Body.Identity.Tagline)},
		Colors:          branding.Colors{Primary: request.Body.Colors.Primary, Secondary: request.Body.Colors.Secondary, Accent: request.Body.Colors.Accent, Background: request.Body.Colors.Background},
		Imprint:         branding.Legal{Mode: string(request.Body.Imprint.Mode), Markdown: request.Body.Imprint.Markdown, ExternalURL: request.Body.Imprint.ExternalUrl},
		Privacy:         branding.Legal{Mode: string(request.Body.Privacy.Mode), Markdown: request.Body.Privacy.Markdown, ExternalURL: request.Body.Privacy.ExternalUrl},
		ExpectedVersion: request.Body.ExpectedVersion,
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateBrandingConfiguration200JSONResponse(brandingConfigurationDTO(configuration)), nil
}

func (s *Server) PutBrandingAsset(ctx context.Context, request openapi.PutBrandingAssetRequestObject) (openapi.PutBrandingAssetResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("asset body is required")
	}
	slot, err := branding.ParseSlot(string(request.Slot))
	if err != nil {
		return nil, err
	}
	configuration, err := s.branding.PutAsset(ctx, principal, slot, request.Params.ExpectedVersion, request.Params.XFileName, request.Body, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.PutBrandingAsset200JSONResponse(brandingConfigurationDTO(configuration)), nil
}

func (s *Server) RemoveBrandingAsset(ctx context.Context, request openapi.RemoveBrandingAssetRequestObject) (openapi.RemoveBrandingAssetResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	slot, err := branding.ParseSlot(string(request.Slot))
	if err != nil {
		return nil, err
	}
	configuration, err := s.branding.RemoveAsset(ctx, principal, slot, request.Body.ExpectedVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.RemoveBrandingAsset200JSONResponse(brandingConfigurationDTO(configuration)), nil
}

func (s *Server) RestoreDefaultBrandingAsset(ctx context.Context, request openapi.RestoreDefaultBrandingAssetRequestObject) (openapi.RestoreDefaultBrandingAssetResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	slot, err := branding.ParseSlot(string(request.Slot))
	if err != nil {
		return nil, err
	}
	configuration, err := s.branding.RestoreDefaultAsset(ctx, principal, slot, request.Body.ExpectedVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.RestoreDefaultBrandingAsset200JSONResponse(brandingConfigurationDTO(configuration)), nil
}

func brandingConfigurationDTO(value branding.Configuration) openapi.BrandingConfiguration {
	return openapi.BrandingConfiguration{
		Identity: brandingIdentityDTO(value.Identity), Colors: brandingColorsDTO(value.Colors), Assets: openapi.BrandingAssets{
			Logo: brandingAssetDTO(value.Assets[branding.Logo]), CompactLogo: brandingAssetDTO(value.Assets[branding.CompactLogo]), Favicon: brandingAssetDTO(value.Assets[branding.Favicon]),
			ApplicationBackground: brandingAssetDTO(value.Assets[branding.ApplicationBackground]), AuthenticationBackground: brandingAssetDTO(value.Assets[branding.AuthenticationBackground]),
		},
		Imprint: legalConfigurationDTO(value.Imprint), Privacy: legalConfigurationDTO(value.Privacy), Version: value.Version, UpdatedAt: value.UpdatedAt,
	}
}

func publicBrandingConfigurationDTO(value branding.Configuration) openapi.PublicConfiguration {
	legalLink := func(kind string, value branding.Legal) openapi.PublicLegalLink {
		href := "/legal/" + kind
		if value.Mode == "external" {
			href = value.ExternalURL
		}
		return openapi.PublicLegalLink{Mode: openapi.PublicLegalLinkMode(value.Mode), Href: href}
	}
	return openapi.PublicConfiguration{
		Identity: brandingIdentityDTO(value.Identity), Colors: brandingColorsDTO(value.Colors), Version: value.Version,
		Assets: openapi.PublicBrandingAssets{
			LogoUrl: nullableString(value.Assets[branding.Logo].URL), CompactLogoUrl: nullableString(value.Assets[branding.CompactLogo].URL), FaviconUrl: nullableString(value.Assets[branding.Favicon].URL),
			ApplicationBackgroundUrl: nullableString(value.Assets[branding.ApplicationBackground].URL), AuthenticationBackgroundUrl: nullableString(value.Assets[branding.AuthenticationBackground].URL),
		},
		Legal: openapi.PublicLegalLinks{Imprint: legalLink("imprint", value.Imprint), Privacy: legalLink("privacy", value.Privacy)},
	}
}

func brandingIdentityDTO(value branding.Identity) openapi.BrandingIdentity {
	return openapi.BrandingIdentity{LegalOrganizationName: value.LegalOrganizationName, DisplayName: value.DisplayName, ApplicationName: value.ApplicationName, Tagline: nullableString(value.Tagline)}
}

func brandingColorsDTO(value branding.Colors) openapi.BrandingColors {
	return openapi.BrandingColors{Primary: value.Primary, Secondary: value.Secondary, Accent: value.Accent, Background: value.Background}
}

func legalConfigurationDTO(value branding.Legal) openapi.LegalConfiguration {
	return openapi.LegalConfiguration{Mode: openapi.LegalConfigurationMode(value.Mode), Markdown: value.Markdown, ExternalUrl: value.ExternalURL}
}

func brandingAssetDTO(value branding.Asset) openapi.BrandingAsset {
	return openapi.BrandingAsset{
		Slot: openapi.BrandingAssetSlot(value.Slot), Mode: openapi.BrandingAssetMode(value.Mode), Url: nullableString(value.URL), OriginalFilename: nullableString(value.OriginalFilename), ContentType: nullableString(value.ContentType),
		SizeBytes: nullablePointer[int64](value.Size, func(value int64) int64 { return value }), UpdatedAt: nullablePointer[time.Time](value.UpdatedAt, func(value time.Time) time.Time { return value }),
	}
}
