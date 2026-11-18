package pdftemplates

import (
	"context"
	"net/http"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/pdftemplates/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/pdftemplates/engine"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
)

// SourceKind says what a preview is rendered with.
type SourceKind string

const (
	// SourceSample renders fictitious data.
	SourceSample SourceKind = "sample"
	// SourceRecord renders a real record of the export.
	SourceRecord SourceKind = "record"
)

// PreviewSource selects the data of a preview: the sample, or a record listed in Detail.PreviewSources.
type PreviewSource struct {
	Kind SourceKind
	ID   string
}

// Preview is a rendered PDF with where every node was drawn and what was found wrong or hidden.
type Preview struct {
	PDF      []byte
	Pages    []engine.PageSize
	Boxes    []engine.Box
	Problems []engine.Problem
	Redacted []string
	// Inactive are the nodes that drew nothing with this data (engine.Result.Inactive).
	Inactive []string
}

// Preview renders a possibly unsaved document. With a real record it additionally needs the permissions of the
// export, and fields the caller may not read are redacted exactly as in the export; with the sample every field
// shows its sample value.
func (s *Service) Preview(
	ctx context.Context,
	p authorization.Principal,
	kind engine.Kind,
	raw []byte,
	source PreviewSource,
) (Preview, error) {
	if err := requireManage(p); err != nil {
		return Preview{}, err
	}
	if err := validKind(kind); err != nil {
		return Preview{}, err
	}
	data, can, now, err := s.previewData(ctx, p, kind, source)
	if err != nil {
		return Preview{}, err
	}
	doc, err := decodeFor(kind, raw)
	if err != nil {
		return Preview{}, err
	}
	names, logo := s.branded(ctx)
	result, err := engine.Render(ctx, engine.RenderInput{
		Doc:      doc,
		Data:     data,
		Can:      can,
		Assets:   assetSource{q: db.New(s.pool)},
		Logo:     logo,
		Now:      now,
		Branding: names,
	})
	if err != nil {
		return Preview{}, err
	}
	return Preview{
		PDF:      result.PDF,
		Pages:    result.Pages,
		Boxes:    result.Boxes,
		Problems: result.Problems,
		Redacted: result.Redacted,
		Inactive: result.Inactive,
	}, nil
}

func (s *Service) previewData(
	ctx context.Context,
	p authorization.Principal,
	kind engine.Kind,
	source PreviewSource,
) (engine.Data, func(string) bool, time.Time, error) {
	switch source.Kind {
	case SourceSample:
		return engine.SampleData(kind), func(string) bool { return true }, engine.SampleNow(), nil
	case SourceRecord:
		if source.ID == "" {
			return nil, nil, time.Time{}, apperror.Invalid("A record preview needs the id of a record")
		}
		if !hasRecordPermissions(p, kind) {
			return nil, nil, time.Time{}, apperror.PermissionDenied
		}
		records := s.recordSource(kind)
		if records == nil {
			return nil, nil, time.Time{}, apperror.New(
				http.StatusNotFound, CodeSourceUnavailable, "This export has no records to preview",
			)
		}
		data, err := records.RecordData(ctx, p, source.ID)
		if err != nil {
			return nil, nil, time.Time{}, err
		}
		return data, canFunc(p), time.Now(), nil
	}
	return nil, nil, time.Time{}, apperror.Invalid("The preview source must be sample or record")
}
