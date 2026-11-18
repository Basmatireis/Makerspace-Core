package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/pdftemplates"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/pdftemplates/engine"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/oapi-codegen/nullable"
)

func optionalText(value string) nullable.Nullable[string] {
	if value == "" {
		return nullable.Nullable[string]{}
	}
	return nullable.NewNullableWithValue(value)
}

func versionMeta(v pdftemplates.Version) openapi.PdfTemplateVersionMeta {
	meta := openapi.PdfTemplateVersionMeta{
		Id:        v.ID,
		Version:   v.Number,
		State:     openapi.PdfTemplateState(v.State),
		Revision:  v.Revision,
		CreatedAt: v.CreatedAt,
		UpdatedAt: v.UpdatedAt,
		CreatedBy: optionalText(v.CreatedBy),
	}
	meta.PublishedBy = optionalText(v.PublishedBy)
	if v.PublishedAt != nil {
		meta.PublishedAt = nullable.NewNullableWithValue(*v.PublishedAt)
	}
	return meta
}

func documentObject(raw json.RawMessage) (openapi.PdfTemplateDocument, error) {
	var document openapi.PdfTemplateDocument
	if err := json.Unmarshal(raw, &document); err != nil {
		return nil, err
	}
	return document, nil
}

func versionDTO(v pdftemplates.Version) (openapi.PdfTemplateVersion, error) {
	document, err := documentObject(v.Document)
	if err != nil {
		return openapi.PdfTemplateVersion{}, err
	}
	meta := versionMeta(v)
	return openapi.PdfTemplateVersion{
		Id: meta.Id, Version: meta.Version, State: meta.State, Revision: meta.Revision, CreatedAt: meta.CreatedAt,
		UpdatedAt: meta.UpdatedAt, CreatedBy: meta.CreatedBy, PublishedAt: meta.PublishedAt,
		PublishedBy: meta.PublishedBy, Document: document,
	}, nil
}

func nullableVersion(v *pdftemplates.Version) (nullable.Nullable[openapi.PdfTemplateVersion], error) {
	if v == nil {
		return nullable.NewNullNullable[openapi.PdfTemplateVersion](), nil
	}
	dto, err := versionDTO(*v)
	if err != nil {
		return nullable.Nullable[openapi.PdfTemplateVersion]{}, err
	}
	return nullable.NewNullableWithValue(dto), nil
}

func nullableVersionMeta(v *pdftemplates.Version) nullable.Nullable[openapi.PdfTemplateVersionMeta] {
	if v == nil {
		return nullable.NewNullNullable[openapi.PdfTemplateVersionMeta]()
	}
	return nullable.NewNullableWithValue(versionMeta(*v))
}

func problemDTOs(problems []engine.Problem) []openapi.PdfTemplateProblem {
	result := make([]openapi.PdfTemplateProblem, 0, len(problems))
	for _, problem := range problems {
		result = append(result, openapi.PdfTemplateProblem{
			NodeId: problem.NodeID, Severity: openapi.PdfTemplateProblemSeverity(problem.Severity), Message: problem.Message,
		})
	}
	return result
}

func schemaDTO(schema engine.SchemaInfo) openapi.PdfTemplateSchema {
	dto := openapi.PdfTemplateSchema{
		Filters: make([]openapi.PdfTemplateFilter, 0, len(schema.Filters)),
		Groups:  make([]openapi.PdfTemplateSchemaGroup, 0, len(schema.Groups)),
	}
	for _, filter := range schema.Filters {
		dto.Filters = append(dto.Filters, openapi.PdfTemplateFilter{Name: filter.Name, Description: filter.Description})
	}
	for _, group := range schema.Groups {
		fields := make([]openapi.PdfTemplateSchemaField, 0, len(group.Fields))
		for _, field := range group.Fields {
			fields = append(fields, openapi.PdfTemplateSchemaField{
				Path:        field.Path,
				Type:        openapi.PdfTemplateSchemaFieldType(field.Type),
				Permission:  optionalText(field.Permission),
				Description: field.Description,
				Example:     optionalText(field.Example),
			})
		}
		dto.Groups = append(dto.Groups, openapi.PdfTemplateSchemaGroup{
			Name: group.Name, List: optionalText(group.List), Description: optionalText(group.Description), Fields: fields,
		})
	}
	return dto
}

func (s *Server) ListPdfTemplates(
	ctx context.Context,
	_ openapi.ListPdfTemplatesRequestObject,
) (openapi.ListPdfTemplatesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	summaries, err := s.pdfTemplates.List(ctx, p)
	if err != nil {
		return nil, err
	}
	body := make([]openapi.PdfTemplateSummary, 0, len(summaries))
	for _, summary := range summaries {
		body = append(body, openapi.PdfTemplateSummary{
			Export:    openapi.PdfTemplateExport(summary.Export),
			Name:      summary.Name,
			Draft:     nullableVersionMeta(summary.Draft),
			Published: nullableVersionMeta(summary.Published),
		})
	}
	return openapi.ListPdfTemplates200JSONResponse{
		Body: body, Headers: openapi.ListPdfTemplates200ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (s *Server) GetPdfTemplate(
	ctx context.Context,
	r openapi.GetPdfTemplateRequestObject,
) (openapi.GetPdfTemplateResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	detail, err := s.pdfTemplates.Get(ctx, p, engine.Kind(r.Export))
	if err != nil {
		return nil, err
	}
	builtin, err := documentObject(detail.Builtin)
	if err != nil {
		return nil, err
	}
	body := openapi.PdfTemplateDetail{
		Export:         r.Export,
		Builtin:        builtin,
		Schema:         schemaDTO(detail.Schema),
		PreviewSources: make([]openapi.PdfTemplatePreviewSource, 0, len(detail.PreviewSources)),
	}
	if body.Draft, err = nullableVersion(detail.Draft); err != nil {
		return nil, err
	}
	if body.Published, err = nullableVersion(detail.Published); err != nil {
		return nil, err
	}
	for _, source := range detail.PreviewSources {
		body.PreviewSources = append(body.PreviewSources, openapi.PdfTemplatePreviewSource{Id: source.ID, Label: source.Label})
	}
	return openapi.GetPdfTemplate200JSONResponse{
		Body: body, Headers: openapi.GetPdfTemplate200ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (s *Server) ListPdfTemplateVersions(
	ctx context.Context,
	r openapi.ListPdfTemplateVersionsRequestObject,
) (openapi.ListPdfTemplateVersionsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	versions, err := s.pdfTemplates.ListVersions(ctx, p, engine.Kind(r.Export))
	if err != nil {
		return nil, err
	}
	body := make([]openapi.PdfTemplateVersionMeta, 0, len(versions))
	for _, version := range versions {
		body = append(body, versionMeta(version))
	}
	return openapi.ListPdfTemplateVersions200JSONResponse{
		Body: body, Headers: openapi.ListPdfTemplateVersions200ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (s *Server) GetPdfTemplateVersion(
	ctx context.Context,
	r openapi.GetPdfTemplateVersionRequestObject,
) (openapi.GetPdfTemplateVersionResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	version, err := s.pdfTemplates.GetVersion(ctx, p, engine.Kind(r.Export), r.VersionId)
	if err != nil {
		return nil, err
	}
	body, err := versionDTO(version)
	if err != nil {
		return nil, err
	}
	return openapi.GetPdfTemplateVersion200JSONResponse{
		Body: body, Headers: openapi.GetPdfTemplateVersion200ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (s *Server) SavePdfTemplateDraft(
	ctx context.Context,
	r openapi.SavePdfTemplateDraftRequestObject,
) (openapi.SavePdfTemplateDraftResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	raw, err := json.Marshal(r.Body.Document)
	if err != nil {
		return nil, invalidRequest("the document could not be read")
	}
	result, err := s.pdfTemplates.SaveDraft(
		ctx, p, engine.Kind(r.Export), raw, r.Body.ExpectedRevision, requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	version, err := versionDTO(result.Version)
	if err != nil {
		return nil, err
	}
	return openapi.SavePdfTemplateDraft200JSONResponse{
		Body:    openapi.PdfTemplateDraftResult{Version: version, Problems: problemDTOs(result.Problems)},
		Headers: openapi.SavePdfTemplateDraft200ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (s *Server) DiscardPdfTemplateDraft(
	ctx context.Context,
	r openapi.DiscardPdfTemplateDraftRequestObject,
) (openapi.DiscardPdfTemplateDraftResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.pdfTemplates.DiscardDraft(ctx, p, engine.Kind(r.Export), requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.DiscardPdfTemplateDraft204Response{}, nil
}

func (s *Server) PublishPdfTemplateDraft(
	ctx context.Context,
	r openapi.PublishPdfTemplateDraftRequestObject,
) (openapi.PublishPdfTemplateDraftResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	version, err := s.pdfTemplates.Publish(
		ctx, p, engine.Kind(r.Export), r.Body.ExpectedRevision, requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	body, err := versionDTO(version)
	if err != nil {
		return nil, err
	}
	return openapi.PublishPdfTemplateDraft200JSONResponse{
		Body: body, Headers: openapi.PublishPdfTemplateDraft200ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (s *Server) RestorePdfTemplateVersion(
	ctx context.Context,
	r openapi.RestorePdfTemplateVersionRequestObject,
) (openapi.RestorePdfTemplateVersionResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	version, err := s.pdfTemplates.Restore(ctx, p, engine.Kind(r.Export), r.VersionId, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	body, err := versionDTO(version)
	if err != nil {
		return nil, err
	}
	return openapi.RestorePdfTemplateVersion200JSONResponse{
		Body: body, Headers: openapi.RestorePdfTemplateVersion200ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (s *Server) PreviewPdfTemplate(
	ctx context.Context,
	r openapi.PreviewPdfTemplateRequestObject,
) (openapi.PreviewPdfTemplateResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	raw, err := json.Marshal(r.Body.Document)
	if err != nil {
		return nil, invalidRequest("the document could not be read")
	}
	source := pdftemplates.PreviewSource{Kind: pdftemplates.SourceKind(r.Body.Source.Kind)}
	if r.Body.Source.Id != nil {
		source.ID = *r.Body.Source.Id
	}
	preview, err := s.pdfTemplates.Preview(ctx, p, engine.Kind(r.Export), raw, source)
	if err != nil {
		return nil, err
	}
	body := openapi.PdfTemplatePreview{
		Pdf:      preview.PDF,
		Pages:    make([]openapi.PdfTemplatePage, 0, len(preview.Pages)),
		Boxes:    make([]openapi.PdfTemplateBox, 0, len(preview.Boxes)),
		Problems: problemDTOs(preview.Problems),
		Redacted: preview.Redacted,
		Inactive: preview.Inactive,
	}
	if body.Redacted == nil {
		body.Redacted = []string{}
	}
	if body.Inactive == nil {
		body.Inactive = []string{}
	}
	for _, page := range preview.Pages {
		body.Pages = append(body.Pages, openapi.PdfTemplatePage{Width: float32(page.Width), Height: float32(page.Height)})
	}
	for _, box := range preview.Boxes {
		body.Boxes = append(body.Boxes, openapi.PdfTemplateBox{
			// The engine counts pages from 0; the contract (and the editor) from 1.
			NodeId: box.NodeID, Page: box.Page + 1, X: float32(box.X), Y: float32(box.Y), W: float32(box.W), H: float32(box.H),
		})
	}
	return openapi.PreviewPdfTemplate200JSONResponse{
		Body: body, Headers: openapi.PreviewPdfTemplate200ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func assetDTO(asset pdftemplates.Asset) openapi.PdfTemplateAsset {
	return openapi.PdfTemplateAsset{
		Id:          asset.ID,
		FileName:    asset.FileName,
		ContentType: openapi.PdfTemplateAssetContentType(asset.ContentType),
		ByteSize:    asset.ByteSize,
		Width:       asset.Width,
		Height:      asset.Height,
		CreatedAt:   asset.CreatedAt,
	}
}

func (s *Server) ListPdfTemplateAssets(
	ctx context.Context,
	_ openapi.ListPdfTemplateAssetsRequestObject,
) (openapi.ListPdfTemplateAssetsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	assets, err := s.pdfTemplates.ListAssets(ctx, p)
	if err != nil {
		return nil, err
	}
	body := make([]openapi.PdfTemplateAsset, 0, len(assets))
	for _, asset := range assets {
		body = append(body, assetDTO(asset))
	}
	return openapi.ListPdfTemplateAssets200JSONResponse{
		Body: body, Headers: openapi.ListPdfTemplateAssets200ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (s *Server) UploadPdfTemplateAsset(
	ctx context.Context,
	r openapi.UploadPdfTemplateAssetRequestObject,
) (openapi.UploadPdfTemplateAssetResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	// One byte more than allowed, so that an oversized image is refused by its content check instead of being cut.
	data, err := io.ReadAll(io.LimitReader(r.Body, engine.MaxAssetBytes+1))
	if err != nil {
		return nil, invalidRequest("could not read the image")
	}
	asset, err := s.pdfTemplates.UploadAsset(ctx, p, r.Params.FileName, data, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UploadPdfTemplateAsset201JSONResponse(assetDTO(asset)), nil
}

func (s *Server) DeletePdfTemplateAsset(
	ctx context.Context,
	r openapi.DeletePdfTemplateAssetRequestObject,
) (openapi.DeletePdfTemplateAssetResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.pdfTemplates.DeleteAsset(ctx, p, r.AssetId, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.DeletePdfTemplateAsset204Response{}, nil
}

func (s *Server) GetPdfTemplateAsset(
	ctx context.Context,
	r openapi.GetPdfTemplateAssetRequestObject,
) (openapi.GetPdfTemplateAssetResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	asset, err := s.pdfTemplates.GetAsset(ctx, p, r.AssetId)
	if err != nil {
		return nil, err
	}
	// An uploaded SVG is served from the application's origin, so it may neither run script nor be framed or
	// sniffed into something else.
	headers := openapi.GetPdfTemplateAsset200ResponseHeaders{
		CacheControl:          "private, no-store",
		ContentSecurityPolicy: "default-src 'none'; sandbox",
		XContentTypeOptions:   "nosniff",
	}
	body, length := bytes.NewReader(asset.Data), int64(len(asset.Data))
	switch asset.ContentType {
	case engine.ContentTypePNG:
		return openapi.GetPdfTemplateAsset200ImagepngResponse{Body: body, ContentLength: length, Headers: headers}, nil
	case engine.ContentTypeJPEG:
		return openapi.GetPdfTemplateAsset200ImagejpegResponse{Body: body, ContentLength: length, Headers: headers}, nil
	case engine.ContentTypeSVG:
		return openapi.GetPdfTemplateAsset200ImagesvgXmlResponse{Body: body, ContentLength: length, Headers: headers}, nil
	}
	return nil, apperror.NotFound
}
