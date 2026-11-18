// Package pdftemplates owns the editable PDF templates of the exports (wiRef invoice request, cashbook, order
// receipt): the versions of every template (one draft, one published version, archived history), the uploaded
// images templates may place, previews with sample or real records, and the effective template the real exports
// render with. The layout and rendering itself is the pure engine in the engine package; this package adds
// authorization, persistence, audit and the record sources of previews.
package pdftemplates

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/branding"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/pdftemplates/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/pdftemplates/engine"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// BrandingSource is the part of the branding service the templates need: the logo and names of the makerspace and
// its primary colour.
type BrandingSource interface {
	DocumentMark(ctx context.Context) branding.DocumentMark
	EmailIdentity(ctx context.Context) branding.EmailIdentity
}

// Source is one real record a preview can render, for example an approved wiRef request.
type Source struct {
	ID    string
	Label string
}

// RecordSource lists and loads the real records of one export. The package that owns the records implements it;
// both methods check the permission the export needs, and RecordData returns the data the real export would
// render for the record (fields the caller may not read are still redacted by the renderer).
type RecordSource interface {
	PreviewSources(ctx context.Context, p authorization.Principal) ([]Source, error)
	RecordData(ctx context.Context, p authorization.Principal, id string) (engine.Data, error)
}

// Records are the record sources of the three exports; a nil source offers no real records.
type Records struct {
	WiRef    RecordSource
	Cashbook RecordSource
	Receipt  RecordSource
}

// Service owns the PDF templates.
type Service struct {
	pool     *pgxpool.Pool
	branding BrandingSource
	records  Records
}

// NewService returns the service. branding may be nil; renderings then carry no logo and the sample names.
func NewService(pool *pgxpool.Pool, branding BrandingSource, records Records) *Service {
	return &Service{pool: pool, branding: branding, records: records}
}

// State is the position of a version in its life cycle.
type State string

const (
	StateDraft     State = "draft"
	StatePublished State = "published"
	StateArchived  State = "archived"
)

// Version is one stored version of a template. Document is set for full versions and nil for list entries.
type Version struct {
	ID          uuid.UUID
	Export      engine.Kind
	Number      int
	State       State
	Revision    int
	CreatedAt   time.Time
	UpdatedAt   time.Time
	PublishedAt *time.Time
	// CreatedBy and PublishedBy are display names; empty when the account no longer exists.
	CreatedBy   string
	PublishedBy string
	Document    json.RawMessage
}

// Summary is one export in the list of templates.
type Summary struct {
	Export    engine.Kind
	Name      string
	Draft     *Version
	Published *Version
}

// Detail is everything the editor needs for one export.
type Detail struct {
	Export         engine.Kind
	Draft          *Version
	Published      *Version
	Builtin        json.RawMessage
	Schema         engine.SchemaInfo
	PreviewSources []Source
}

// DraftResult is a saved draft with the problems found in it; a draft may be saved with problems.
type DraftResult struct {
	Version  Version
	Problems []engine.Problem
}

// Error codes of this package; the engine has its own for invalid documents.
const (
	CodeHasProblems       = "pdf_template_has_problems"
	CodeAssetInUse        = "pdf_template_asset_in_use"
	CodeAssetLimit        = "pdf_template_asset_limit"
	CodeNoDraft           = "pdf_template_no_draft"
	CodeVersionIsDraft    = "pdf_template_version_is_draft"
	CodeExportMismatch    = "pdf_template_export_mismatch"
	CodeInvalidFileName   = "pdf_template_asset_name_invalid"
	CodeSourceUnavailable = "pdf_template_source_unavailable"
)

func requireManage(p authorization.Principal) error {
	if !p.Has(authorization.PDFTemplatesManage) {
		return apperror.PermissionDenied
	}
	return nil
}

func validKind(kind engine.Kind) error {
	if _, ok := engine.ParseKind(string(kind)); !ok {
		return apperror.NotFound
	}
	return nil
}

// versionFromRow maps the columns every version query shares.
func version(
	id uuid.UUID, kind string, number int32, state string, revision int32, created, updated time.Time,
	published pgtype.Timestamptz, createdBy, publishedBy string, document []byte,
) Version {
	v := Version{
		ID: id, Export: engine.Kind(kind), Number: int(number), State: State(state), Revision: int(revision),
		CreatedAt: created, UpdatedAt: updated, CreatedBy: createdBy, PublishedBy: publishedBy,
	}
	if published.Valid {
		at := published.Time
		v.PublishedAt = &at
	}
	if document != nil {
		v.Document = json.RawMessage(document)
	}
	return v
}

func fromStateRow(r db.GetStateVersionRow) Version {
	return version(r.ID, r.ExportKind, r.Version, r.State, r.Revision, r.CreatedAt, r.UpdatedAt, r.PublishedAt,
		r.CreatedByName, r.PublishedByName, r.Document)
}

// List returns the three exports with their draft and published versions.
func (s *Service) List(ctx context.Context, p authorization.Principal) ([]Summary, error) {
	if err := requireManage(p); err != nil {
		return nil, err
	}
	rows, err := db.New(s.pool).ListCurrentVersions(ctx)
	if err != nil {
		return nil, fmt.Errorf("list pdf template versions: %w", err)
	}
	byKind := map[engine.Kind]*Summary{}
	summaries := make([]Summary, 0, len(engine.Kinds))
	for _, kind := range engine.Kinds {
		summaries = append(summaries, Summary{Export: kind, Name: engine.Builtin(kind).Name})
	}
	for i := range summaries {
		byKind[summaries[i].Export] = &summaries[i]
	}
	for _, row := range rows {
		summary := byKind[engine.Kind(row.ExportKind)]
		if summary == nil {
			continue
		}
		v := version(row.ID, row.ExportKind, row.Version, row.State, row.Revision, row.CreatedAt, row.UpdatedAt,
			row.PublishedAt, row.CreatedByName, row.PublishedByName, nil)
		switch v.State {
		case StateDraft:
			summary.Draft = &v
		case StatePublished:
			summary.Published = &v
			summary.Name = documentName(row.Document, summary.Name)
		case StateArchived:
		}
	}
	return summaries, nil
}

// documentName reads the name of a stored document without decoding all of it.
func documentName(raw []byte, fallback string) string {
	var named struct {
		Name string `json:"name"`
	}
	if json.Unmarshal(raw, &named) != nil || named.Name == "" {
		return fallback
	}
	return named.Name
}

// Get returns the draft, the published version, the built-in default, the variables and the real records of an
// export. Real records are listed only for a caller who may preview them.
func (s *Service) Get(ctx context.Context, p authorization.Principal, kind engine.Kind) (Detail, error) {
	if err := requireManage(p); err != nil {
		return Detail{}, err
	}
	if err := validKind(kind); err != nil {
		return Detail{}, err
	}
	q := db.New(s.pool)
	detail := Detail{Export: kind, Schema: engine.Schema(kind), PreviewSources: []Source{}}
	builtin, err := engine.Encode(s.builtin(ctx, kind))
	if err != nil {
		return Detail{}, err
	}
	detail.Builtin = builtin
	for _, state := range []State{StateDraft, StatePublished} {
		row, err := q.GetStateVersion(ctx, db.GetStateVersionParams{ExportKind: string(kind), State: string(state)})
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return Detail{}, fmt.Errorf("load pdf template version: %w", err)
		}
		v := fromStateRow(row)
		if state == StateDraft {
			detail.Draft = &v
		} else {
			detail.Published = &v
		}
	}
	if source := s.recordSource(kind); source != nil && hasRecordPermissions(p, kind) {
		sources, err := source.PreviewSources(ctx, p)
		if err != nil {
			return Detail{}, err
		}
		if sources != nil {
			detail.PreviewSources = sources
		}
	}
	return detail, nil
}

// ListVersions returns every version of an export without its document, newest first.
func (s *Service) ListVersions(ctx context.Context, p authorization.Principal, kind engine.Kind) ([]Version, error) {
	if err := requireManage(p); err != nil {
		return nil, err
	}
	if err := validKind(kind); err != nil {
		return nil, err
	}
	rows, err := db.New(s.pool).ListVersionMetas(ctx, string(kind))
	if err != nil {
		return nil, fmt.Errorf("list pdf template versions: %w", err)
	}
	versions := make([]Version, 0, len(rows))
	for _, row := range rows {
		versions = append(versions, version(row.ID, row.ExportKind, row.Version, row.State, row.Revision,
			row.CreatedAt, row.UpdatedAt, row.PublishedAt, row.CreatedByName, row.PublishedByName, nil))
	}
	return versions, nil
}

// GetVersion returns one version with its document.
func (s *Service) GetVersion(
	ctx context.Context,
	p authorization.Principal,
	kind engine.Kind,
	id uuid.UUID,
) (Version, error) {
	if err := requireManage(p); err != nil {
		return Version{}, err
	}
	if err := validKind(kind); err != nil {
		return Version{}, err
	}
	row, err := db.New(s.pool).GetVersion(ctx, db.GetVersionParams{ID: id, ExportKind: string(kind)})
	if errors.Is(err, pgx.ErrNoRows) {
		return Version{}, apperror.NotFound
	}
	if err != nil {
		return Version{}, fmt.Errorf("load pdf template version: %w", err)
	}
	return version(row.ID, row.ExportKind, row.Version, row.State, row.Revision, row.CreatedAt, row.UpdatedAt,
		row.PublishedAt, row.CreatedByName, row.PublishedByName, row.Document), nil
}

func (s *Service) recordSource(kind engine.Kind) RecordSource {
	switch kind {
	case engine.KindWiRef:
		return s.records.WiRef
	case engine.KindCashbook:
		return s.records.Cashbook
	case engine.KindReceipt:
		return s.records.Receipt
	}
	return nil
}

// recordPermissions are what an export's real records need beyond pdf_templates.manage.
func recordPermissions(kind engine.Kind) []authorization.Permission {
	switch kind {
	case engine.KindWiRef:
		return []authorization.Permission{authorization.ExternalInvoiceRequestsRead}
	case engine.KindCashbook:
		return []authorization.Permission{authorization.PaymentsRead, authorization.CashMovementsRead}
	case engine.KindReceipt:
		return []authorization.Permission{authorization.OrdersRead}
	}
	return nil
}

func hasRecordPermissions(p authorization.Principal, kind engine.Kind) bool {
	for _, permission := range recordPermissions(kind) {
		if !p.Has(permission) {
			return false
		}
	}
	return true
}

// canFunc is the permission test of the renderer for a signed-in reader.
func canFunc(p authorization.Principal) func(string) bool {
	return func(permission string) bool { return p.Has(authorization.Permission(permission)) }
}

// decodeFor reads a document strictly and checks that it belongs to the export it is stored or previewed for.
func decodeFor(kind engine.Kind, raw []byte) (engine.Document, error) {
	doc, err := engine.Decode(raw)
	if err != nil {
		return engine.Document{}, err
	}
	if doc.Export != kind {
		return engine.Document{}, apperror.New(
			http.StatusUnprocessableEntity, CodeExportMismatch, "The template belongs to another export",
		)
	}
	return doc, nil
}
