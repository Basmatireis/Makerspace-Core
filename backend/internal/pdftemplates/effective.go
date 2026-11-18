package pdftemplates

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"time"

	db "github.com/Basmatireis/Makerspace-Core/backend/internal/pdftemplates/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/pdftemplates/engine"
	"github.com/jackc/pgx/v5"
)

// accentColorID is the document colour of the built-in wiRef template that follows the branding primary colour,
// so the default PDF keeps the look of the application.
const accentColorID = "accent"

var hexColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// builtin is the built-in default of an export; the wiRef default takes the branding primary colour as accent.
func (s *Service) builtin(ctx context.Context, kind engine.Kind) engine.Document {
	doc := engine.Builtin(kind)
	if kind == engine.KindWiRef && s.branding != nil {
		SetAccent(&doc, s.branding.EmailIdentity(ctx).PrimaryColor)
	}
	return doc
}

// SetAccent sets the document colour named "accent", if the template has one, to a #rrggbb colour. Anything else
// leaves the template as it is.
func SetAccent(doc *engine.Document, color string) {
	if !hexColor.MatchString(color) {
		return
	}
	for i := range doc.Styles.Colors {
		if doc.Styles.Colors[i].ID == accentColorID {
			doc.Styles.Colors[i].Value = engine.Color(strings.ToLower(color))
		}
	}
}

// Effective returns the template the real exports render with: the published version, or the built-in default
// while none is published.
func (s *Service) Effective(ctx context.Context, kind engine.Kind) (engine.Document, error) {
	if err := validKind(kind); err != nil {
		return engine.Document{}, err
	}
	raw, err := db.New(s.pool).GetPublishedDocument(ctx, string(kind))
	if errors.Is(err, pgx.ErrNoRows) {
		return s.builtin(ctx, kind), nil
	}
	if err != nil {
		return engine.Document{}, fmt.Errorf("load published pdf template: %w", err)
	}
	doc, err := decodeFor(kind, raw)
	if err != nil {
		// A stored template this engine can no longer read must not stop the exports; the built-in default does
		// the work until someone publishes a new version. The document itself is never logged.
		slog.WarnContext(ctx, "published pdf template unreadable, using the built-in default", "export", string(kind))
		return s.builtin(ctx, kind), nil //nolint:nilerr // falling back to the built-in default is the intent
	}
	return doc, nil
}

// RenderEffective renders data with the effective template of an export and returns the PDF and its file name.
// can answers whether the reader holds a permission; nil is a system rendering, which has no permissions, so
// fields that need one stay empty.
func (s *Service) RenderEffective(
	ctx context.Context,
	kind engine.Kind,
	data engine.Data,
	can func(permission string) bool,
) ([]byte, string, error) {
	doc, err := s.Effective(ctx, kind)
	if err != nil {
		return nil, "", err
	}
	names, logo := s.branded(ctx)
	return render(ctx, engine.RenderInput{
		Doc: doc, Data: data, Can: can, Assets: assetSource{q: db.New(s.pool)}, Logo: logo, Branding: names,
	})
}

// render draws one document and returns the PDF and its file name. Without can nothing is readable that needs a
// permission; Now defaults to the current time.
func render(ctx context.Context, in engine.RenderInput) ([]byte, string, error) {
	if in.Can == nil {
		in.Can = func(string) bool { return false }
	}
	if in.Now.IsZero() {
		in.Now = time.Now()
	}
	result, err := engine.Render(ctx, in)
	if err != nil {
		return nil, "", fmt.Errorf("render %s pdf: %w", in.Doc.Export, err)
	}
	return result.PDF, result.Filename, nil
}

// BuiltinRenderer renders with the built-in default templates only: no stored versions, no uploaded images, no
// logo. It is the renderer of packages that are used without the template service, for example in tests.
type BuiltinRenderer struct{}

// RenderEffective renders data with the built-in default of the export.
func (BuiltinRenderer) RenderEffective(
	ctx context.Context,
	kind engine.Kind,
	data engine.Data,
	can func(permission string) bool,
) ([]byte, string, error) {
	if err := validKind(kind); err != nil {
		return nil, "", err
	}
	return render(ctx, engine.RenderInput{
		Doc: engine.Builtin(kind), Data: data, Can: can, Branding: engine.SampleBranding(),
	})
}

// branded returns the names and the logo of the makerspace for renderings. The logo is left out when it is not a
// PNG or JPEG; names fall back to the sample branding.
func (s *Service) branded(ctx context.Context) (engine.Branding, *engine.Logo) {
	names := engine.SampleBranding()
	if s.branding == nil {
		return names, nil
	}
	mark := s.branding.DocumentMark(ctx)
	if mark.OrganizationName != "" {
		names.Name = mark.OrganizationName
	}
	if mark.DisplayName != "" {
		names.DisplayName = mark.DisplayName
	}
	if len(mark.Logo) == 0 || (mark.LogoType != engine.ContentTypePNG && mark.LogoType != engine.ContentTypeJPEG) {
		return names, nil
	}
	return names, &engine.Logo{Data: mark.Logo}
}
