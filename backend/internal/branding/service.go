package branding

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	brandingdb "github.com/Basmatireis/Makerspace-Core/backend/internal/branding/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	_ "golang.org/x/image/webp"
)

type Slot string

const (
	Logo                     Slot = "logo"
	CompactLogo              Slot = "compact_logo"
	Favicon                  Slot = "favicon"
	ApplicationBackground    Slot = "application_background"
	AuthenticationBackground Slot = "authentication_background"
)

var allSlots = []Slot{Logo, CompactLogo, Favicon, ApplicationBackground, AuthenticationBackground}

var defaultAssetURLs = map[Slot]string{
	Logo:                     "/brand/htumkr-symbol.png",
	CompactLogo:              "/brand/htumkr-symbol.png",
	Favicon:                  "/brand/htumkr-symbol.png",
	ApplicationBackground:    "/brand/blueprint-workshop.jpg",
	AuthenticationBackground: "/brand/blueprint-details.jpg",
}

type Identity struct {
	LegalOrganizationName string
	DisplayName           string
	ApplicationName       string
	Tagline               *string
}

type Colors struct{ Primary, Secondary, Accent, Background string }
type Legal struct{ Mode, Markdown, ExternalURL string }

type Asset struct {
	Slot             Slot
	Mode             string
	URL              *string
	OriginalFilename *string
	ContentType      *string
	Size             *int64
	UpdatedAt        *time.Time
}

type Configuration struct {
	Identity         Identity
	Colors           Colors
	Imprint, Privacy Legal
	Assets           map[Slot]Asset
	Version          int64
	UpdatedAt        time.Time
}

type ConfigurationInput struct {
	Identity         Identity
	Colors           Colors
	Imprint, Privacy Legal
	ExpectedVersion  int64
}

type PublicLegalDocument struct {
	Kind, Title, Mode string
	Markdown          *string
	ExternalURL       *string
}

type PublicAsset struct {
	File        files.File
	Reader      io.ReadCloser
	ContentType string
}

type Service struct {
	pool  *pgxpool.Pool
	files *files.Service
}

func NewService(pool *pgxpool.Pool, fileService *files.Service) *Service {
	return &Service{pool: pool, files: fileService}
}

func ParseSlot(value string) (Slot, error) {
	slot := Slot(value)
	for _, candidate := range allSlots {
		if candidate == slot {
			return slot, nil
		}
	}
	return "", validation("asset slot is invalid")
}

func (s *Service) Get(ctx context.Context, principal authorization.Principal) (Configuration, error) {
	if !principal.Has(authorization.BrandingManage) {
		return Configuration{}, apperror.PermissionDenied
	}
	return s.get(ctx)
}

func (s *Service) GetPublic(ctx context.Context) (Configuration, error) { return s.get(ctx) }

func (s *Service) get(ctx context.Context) (Configuration, error) {
	row, err := brandingdb.New(s.pool).GetConfiguration(ctx)
	if err != nil {
		return Configuration{}, err
	}
	overrides, err := brandingdb.New(s.pool).ListAssetOverrides(ctx)
	if err != nil {
		return Configuration{}, err
	}
	assets := make(map[Slot]Asset, len(allSlots))
	for _, slot := range allSlots {
		defaultURL := defaultAssetURLs[slot]
		assets[slot] = Asset{Slot: slot, Mode: "default", URL: &defaultURL}
	}
	for _, override := range overrides {
		slot := Slot(override.Slot)
		asset := Asset{Slot: slot, Mode: override.Mode, OriginalFilename: override.OriginalFilename, ContentType: override.ContentType, Size: override.SizeBytes, UpdatedAt: &override.UpdatedAt}
		if override.Mode == "custom" {
			digest := hex.EncodeToString(override.Sha256)
			value := fmt.Sprintf("/api/v1/public/branding/assets/%s/%s", slot, digest)
			asset.URL = &value
		}
		assets[slot] = asset
	}
	return fromRow(row, assets), nil
}

func (s *Service) ApplicationName(ctx context.Context) string {
	row, err := brandingdb.New(s.pool).GetConfiguration(ctx)
	if err != nil || strings.TrimSpace(row.ApplicationName) == "" {
		return "HTU Graz Makerspace"
	}
	return row.ApplicationName
}

func (s *Service) Update(ctx context.Context, principal authorization.Principal, input ConfigurationInput, requestID *uuid.UUID) (Configuration, error) {
	if !principal.Has(authorization.BrandingManage) {
		return Configuration{}, apperror.PermissionDenied
	}
	if err := validateConfiguration(&input); err != nil {
		return Configuration{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Configuration{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := brandingdb.New(tx)
	current, err := queries.GetConfigurationForUpdate(ctx)
	if err != nil {
		return Configuration{}, err
	}
	if current.Version != input.ExpectedVersion {
		return Configuration{}, apperror.StaleWrite
	}
	actor := principal.AccountID
	row, err := queries.UpdateConfiguration(ctx, brandingdb.UpdateConfigurationParams{
		LegalOrganizationName: input.Identity.LegalOrganizationName, DisplayName: input.Identity.DisplayName,
		ApplicationName: input.Identity.ApplicationName, Tagline: input.Identity.Tagline,
		PrimaryColor: input.Colors.Primary, SecondaryColor: input.Colors.Secondary,
		AccentColor: input.Colors.Accent, BackgroundColor: input.Colors.Background,
		ImprintMode: input.Imprint.Mode, ImprintMarkdown: input.Imprint.Markdown, ImprintExternalUrl: input.Imprint.ExternalURL,
		PrivacyMode: input.Privacy.Mode, PrivacyMarkdown: input.Privacy.Markdown, PrivacyExternalUrl: input.Privacy.ExternalURL,
		UpdatedByAccountID: &actor, ExpectedVersion: input.ExpectedVersion,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return Configuration{}, apperror.StaleWrite
	}
	if err != nil {
		return Configuration{}, err
	}
	if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "branding.configuration_updated", ResourceType: "branding_configuration", RequestID: requestID, ChangedFields: []string{"identity", "colors", "imprint", "privacy"}}); err != nil {
		return Configuration{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Configuration{}, err
	}
	assets, err := s.get(ctx)
	if err != nil {
		return Configuration{}, err
	}
	assets.Version, assets.UpdatedAt = row.Version, row.UpdatedAt
	return assets, nil
}

func (s *Service) PutAsset(ctx context.Context, principal authorization.Principal, slot Slot, expectedVersion int64, filename string, reader io.Reader, requestID *uuid.UUID) (Configuration, error) {
	if !principal.Has(authorization.BrandingManage) {
		return Configuration{}, apperror.PermissionDenied
	}
	if s.files == nil {
		return Configuration{}, errors.New("file storage is unavailable")
	}
	data, contentType, err := validateAsset(slot, reader)
	if err != nil {
		return Configuration{}, err
	}
	stored, err := s.files.StoreBytes(ctx, principal, filename, contentType, data, requestID)
	if err != nil {
		return Configuration{}, err
	}
	linked := false
	defer func() {
		if !linked {
			_ = s.files.Delete(context.Background(), principal, stored.ID, requestID)
		}
	}()
	oldFile, err := s.mutateAsset(ctx, principal, slot, expectedVersion, "custom", &stored.ID, requestID)
	if err != nil {
		return Configuration{}, err
	}
	linked = true
	if oldFile != nil && *oldFile != stored.ID {
		_ = s.files.Delete(context.Background(), principal, *oldFile, requestID)
	}
	return s.get(ctx)
}

func (s *Service) RemoveAsset(ctx context.Context, principal authorization.Principal, slot Slot, expectedVersion int64, requestID *uuid.UUID) (Configuration, error) {
	if !principal.Has(authorization.BrandingManage) {
		return Configuration{}, apperror.PermissionDenied
	}
	oldFile, err := s.mutateAsset(ctx, principal, slot, expectedVersion, "none", nil, requestID)
	if err != nil {
		return Configuration{}, err
	}
	if oldFile != nil && s.files != nil {
		_ = s.files.Delete(context.Background(), principal, *oldFile, requestID)
	}
	return s.get(ctx)
}

func (s *Service) RestoreDefaultAsset(ctx context.Context, principal authorization.Principal, slot Slot, expectedVersion int64, requestID *uuid.UUID) (Configuration, error) {
	if !principal.Has(authorization.BrandingManage) {
		return Configuration{}, apperror.PermissionDenied
	}
	oldFile, err := s.mutateAsset(ctx, principal, slot, expectedVersion, "default", nil, requestID)
	if err != nil {
		return Configuration{}, err
	}
	if oldFile != nil && s.files != nil {
		_ = s.files.Delete(context.Background(), principal, *oldFile, requestID)
	}
	return s.get(ctx)
}

func (s *Service) mutateAsset(ctx context.Context, principal authorization.Principal, slot Slot, expectedVersion int64, mode string, fileID *uuid.UUID, requestID *uuid.UUID) (*uuid.UUID, error) {
	if _, err := ParseSlot(string(slot)); err != nil {
		return nil, err
	}
	if expectedVersion < 1 {
		return nil, validation("expectedVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := brandingdb.New(tx)
	current, err := queries.GetConfigurationForUpdate(ctx)
	if err != nil {
		return nil, err
	}
	if current.Version != expectedVersion {
		return nil, apperror.StaleWrite
	}
	var oldFile *uuid.UUID
	override, err := queries.GetAssetOverride(ctx, string(slot))
	if err == nil {
		oldFile = override.FileID
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	actor := principal.AccountID
	switch mode {
	case "custom":
		if fileID == nil {
			return nil, errors.New("custom branding asset requires a file")
		}
		_, err = queries.UpsertCustomAsset(ctx, brandingdb.UpsertCustomAssetParams{Slot: string(slot), FileID: fileID, UpdatedByAccountID: &actor})
	case "none":
		_, err = queries.UpsertRemovedAsset(ctx, brandingdb.UpsertRemovedAssetParams{Slot: string(slot), UpdatedByAccountID: &actor})
	case "default":
		err = queries.DeleteAssetOverride(ctx, string(slot))
	default:
		return nil, errors.New("invalid branding asset mode")
	}
	if err != nil {
		return nil, err
	}
	if _, err := queries.BumpConfigurationVersion(ctx, brandingdb.BumpConfigurationVersionParams{UpdatedByAccountID: &actor, ExpectedVersion: expectedVersion}); errors.Is(err, pgx.ErrNoRows) {
		return nil, apperror.StaleWrite
	} else if err != nil {
		return nil, err
	}
	action := "branding.asset_updated"
	if mode == "none" {
		action = "branding.asset_removed"
	} else if mode == "default" {
		action = "branding.asset_default_restored"
	}
	if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: action, ResourceType: "branding_configuration", RequestID: requestID, ChangedFields: []string{string(slot)}}); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return oldFile, nil
}

func (s *Service) PublicLegal(ctx context.Context, kind string) (PublicLegalDocument, error) {
	configuration, err := s.get(ctx)
	if err != nil {
		return PublicLegalDocument{}, err
	}
	var title string
	var legal Legal
	switch kind {
	case "imprint":
		title, legal = "Imprint", configuration.Imprint
	case "privacy":
		title, legal = "Privacy policy", configuration.Privacy
	default:
		return PublicLegalDocument{}, apperror.NotFound
	}
	document := PublicLegalDocument{Kind: kind, Title: title, Mode: legal.Mode}
	if legal.Mode == "external" {
		document.ExternalURL = &legal.ExternalURL
	} else {
		document.Markdown = &legal.Markdown
	}
	return document, nil
}

func (s *Service) OpenPublicAsset(ctx context.Context, slot Slot, digest string) (PublicAsset, error) {
	if s.files == nil {
		return PublicAsset{}, errors.New("file storage is unavailable")
	}
	if _, err := ParseSlot(string(slot)); err != nil || !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(digest) {
		return PublicAsset{}, apperror.NotFound
	}
	row, err := brandingdb.New(s.pool).GetPublicAssetByDigest(ctx, brandingdb.GetPublicAssetByDigestParams{Slot: string(slot), Digest: digest})
	if errors.Is(err, pgx.ErrNoRows) {
		return PublicAsset{}, apperror.NotFound
	}
	if err != nil {
		return PublicAsset{}, err
	}
	file, reader, err := s.files.Open(ctx, row.ID)
	if err != nil {
		return PublicAsset{}, err
	}
	return PublicAsset{File: file, Reader: reader, ContentType: row.ContentType}, nil
}

func fromRow(row brandingdb.BrandingConfiguration, assets map[Slot]Asset) Configuration {
	return Configuration{
		Identity: Identity{LegalOrganizationName: row.LegalOrganizationName, DisplayName: row.DisplayName, ApplicationName: row.ApplicationName, Tagline: row.Tagline},
		Colors:   Colors{Primary: row.PrimaryColor, Secondary: row.SecondaryColor, Accent: row.AccentColor, Background: row.BackgroundColor},
		Imprint:  Legal{Mode: row.ImprintMode, Markdown: row.ImprintMarkdown, ExternalURL: row.ImprintExternalUrl},
		Privacy:  Legal{Mode: row.PrivacyMode, Markdown: row.PrivacyMarkdown, ExternalURL: row.PrivacyExternalUrl},
		Assets:   assets, Version: row.Version, UpdatedAt: row.UpdatedAt,
	}
}

var hexColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func validateConfiguration(input *ConfigurationInput) error {
	input.Identity.LegalOrganizationName = strings.TrimSpace(input.Identity.LegalOrganizationName)
	input.Identity.DisplayName = strings.TrimSpace(input.Identity.DisplayName)
	input.Identity.ApplicationName = strings.TrimSpace(input.Identity.ApplicationName)
	if input.Identity.Tagline != nil {
		value := strings.TrimSpace(*input.Identity.Tagline)
		if value == "" {
			input.Identity.Tagline = nil
		} else {
			input.Identity.Tagline = &value
		}
	}
	if input.ExpectedVersion < 1 || input.Identity.LegalOrganizationName == "" || utf8.RuneCountInString(input.Identity.LegalOrganizationName) > 200 || input.Identity.DisplayName == "" || utf8.RuneCountInString(input.Identity.DisplayName) > 100 || input.Identity.ApplicationName == "" || utf8.RuneCountInString(input.Identity.ApplicationName) > 150 || (input.Identity.Tagline != nil && utf8.RuneCountInString(*input.Identity.Tagline) > 240) {
		return validation("organization identity is invalid")
	}
	colors := []*string{&input.Colors.Primary, &input.Colors.Secondary, &input.Colors.Accent, &input.Colors.Background}
	for _, color := range colors {
		if !hexColor.MatchString(*color) {
			return validation("branding colors must be six-digit HEX values")
		}
		*color = strings.ToLower(*color)
	}
	if err := validateLegal(input.Imprint); err != nil {
		return err
	}
	if err := validateLegal(input.Privacy); err != nil {
		return err
	}
	return nil
}

func validateLegal(value Legal) error {
	if value.Mode != "internal" && value.Mode != "external" {
		return validation("legal mode is invalid")
	}
	if len([]byte(value.Markdown)) > 102400 || len(value.ExternalURL) > 2048 {
		return validation("legal content is too long")
	}
	if strings.IndexFunc(value.ExternalURL, func(r rune) bool { return r < 0x20 || r == 0x7f }) >= 0 {
		return validation("external legal URL is invalid")
	}
	if value.ExternalURL != "" {
		parsed, err := url.Parse(value.ExternalURL)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil {
			return validation("external legal URL must be an absolute HTTP(S) URL without credentials")
		}
	}
	if value.Mode == "external" && value.ExternalURL == "" {
		return validation("external legal URL is required in external mode")
	}
	return nil
}

func validateAsset(slot Slot, reader io.Reader) ([]byte, string, error) {
	limit := int64(2 << 20)
	background := slot == ApplicationBackground || slot == AuthenticationBackground
	if background {
		limit = 8 << 20
	}
	raw, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, "", err
	}
	if len(raw) == 0 || int64(len(raw)) > limit {
		return nil, "", apperror.New(413, "branding_asset_too_large", "Branding asset exceeds the slot size limit")
	}
	trimmed := bytes.TrimSpace(raw)
	if bytes.HasPrefix(trimmed, []byte("<")) {
		sanitized, err := sanitizeSVG(trimmed)
		if err != nil {
			return nil, "", validation("SVG contains unsupported or unsafe content")
		}
		return sanitized, "image/svg+xml", nil
	}
	configuration, format, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil || (format != "png" && format != "webp" && (!background || format != "jpeg")) {
		return nil, "", validation("asset must be a valid PNG, WebP, or safe SVG; backgrounds also accept JPEG")
	}
	if configuration.Width < 1 || configuration.Height < 1 || configuration.Width > 4096 || configuration.Height > 4096 || int64(configuration.Width)*int64(configuration.Height) > 16_000_000 {
		return nil, "", validation("asset dimensions exceed 4096x4096 or 16 megapixels")
	}
	if _, _, err := image.Decode(bytes.NewReader(raw)); err != nil {
		return nil, "", validation("asset image could not be decoded")
	}
	contentTypes := map[string]string{"png": "image/png", "webp": "image/webp", "jpeg": "image/jpeg"}
	return raw, contentTypes[format], nil
}

var svgElements = map[string]map[string]bool{
	"svg": {"xmlns": true, "width": true, "height": true, "viewBox": true, "preserveAspectRatio": true, "version": true},
	"g":   {}, "defs": {}, "title": {}, "desc": {},
	"path": {"d": true}, "rect": {"x": true, "y": true, "width": true, "height": true, "rx": true, "ry": true},
	"circle": {"cx": true, "cy": true, "r": true}, "ellipse": {"cx": true, "cy": true, "rx": true, "ry": true},
	"line": {"x1": true, "y1": true, "x2": true, "y2": true}, "polyline": {"points": true}, "polygon": {"points": true},
	"clipPath": {"clipPathUnits": true}, "mask": {"maskUnits": true, "x": true, "y": true, "width": true, "height": true},
	"linearGradient": {"x1": true, "y1": true, "x2": true, "y2": true, "gradientUnits": true, "gradientTransform": true},
	"radialGradient": {"cx": true, "cy": true, "r": true, "fx": true, "fy": true, "gradientUnits": true, "gradientTransform": true},
	"stop":           {"offset": true, "stop-color": true, "stop-opacity": true},
	"use":            {"href": true, "x": true, "y": true, "width": true, "height": true},
}

var svgGlobalAttributes = map[string]bool{
	"id": true, "fill": true, "fill-opacity": true, "fill-rule": true, "stroke": true, "stroke-width": true,
	"stroke-opacity": true, "stroke-linecap": true, "stroke-linejoin": true, "stroke-miterlimit": true,
	"stroke-dasharray": true, "stroke-dashoffset": true, "opacity": true, "transform": true, "clip-path": true,
	"mask": true, "vector-effect": true,
}

func sanitizeSVG(raw []byte) ([]byte, error) {
	decoder := xml.NewDecoder(bytes.NewReader(raw))
	decoder.Strict = true
	var output bytes.Buffer
	encoder := xml.NewEncoder(&output)
	depth, roots, tokens := 0, 0, 0
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
		tokens++
		if tokens > 100_000 {
			return nil, errors.New("too many SVG tokens")
		}
		switch value := token.(type) {
		case xml.StartElement:
			allowed, ok := svgElements[value.Name.Local]
			if !ok || (value.Name.Space != "" && value.Name.Space != "http://www.w3.org/2000/svg") {
				return nil, errors.New("unsupported SVG element")
			}
			depth++
			if depth > 64 {
				return nil, errors.New("SVG nesting is too deep")
			}
			if depth == 1 {
				roots++
				if roots != 1 || value.Name.Local != "svg" {
					return nil, errors.New("SVG root is invalid")
				}
			}
			value.Name.Space = ""
			attributes := make([]xml.Attr, 0, len(value.Attr)+1)
			if value.Name.Local == "svg" {
				attributes = append(attributes, xml.Attr{Name: xml.Name{Local: "xmlns"}, Value: "http://www.w3.org/2000/svg"})
			}
			for _, attribute := range value.Attr {
				name := attribute.Name.Local
				if name == "xmlns" {
					continue
				}
				if strings.HasPrefix(strings.ToLower(name), "on") || (!allowed[name] && !svgGlobalAttributes[name]) || !safeSVGValue(name, attribute.Value) {
					return nil, errors.New("unsupported SVG attribute")
				}
				attribute.Name.Space = ""
				attributes = append(attributes, attribute)
			}
			value.Attr = attributes
			if err := encoder.EncodeToken(value); err != nil {
				return nil, err
			}
		case xml.EndElement:
			value.Name.Space = ""
			if err := encoder.EncodeToken(value); err != nil {
				return nil, err
			}
			depth--
		case xml.CharData:
			if err := encoder.EncodeToken(value); err != nil {
				return nil, err
			}
		case xml.Comment:
			// Comments are not needed for rendering and may contain retained metadata.
		case xml.ProcInst:
			if !strings.EqualFold(value.Target, "xml") || roots != 0 || depth != 0 {
				return nil, errors.New("unsupported SVG processing instruction")
			}
		default:
			return nil, errors.New("unsupported SVG token")
		}
	}
	if roots != 1 || depth != 0 {
		return nil, errors.New("SVG document is incomplete")
	}
	if err := encoder.Flush(); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

func safeSVGValue(name, value string) bool {
	lower := strings.ToLower(strings.TrimSpace(value))
	if strings.ContainsAny(value, "<>\x00") || strings.Contains(lower, "javascript:") || strings.Contains(lower, "data:") || strings.Contains(lower, "@import") || strings.Contains(lower, "expression(") || strings.Contains(lower, "http:") || strings.Contains(lower, "https:") || strings.HasPrefix(lower, "//") {
		return false
	}
	if name == "href" {
		return strings.HasPrefix(lower, "#") && len(lower) > 1
	}
	if strings.Contains(lower, "url(") {
		return regexp.MustCompile(`^url\(#[A-Za-z_][A-Za-z0-9_.:-]*\)$`).MatchString(value)
	}
	return true
}

func validation(reason string) *apperror.Error {
	err := apperror.New(422, "branding_configuration_invalid", "Branding configuration is invalid")
	err.Details["reason"] = reason
	return err
}
