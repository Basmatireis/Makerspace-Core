package httpapi

import (
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/laborordnung"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/oapi-codegen/nullable"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

func (s *Server) GetOwnLaborordnungStatus(
	ctx context.Context,
	_ openapi.GetOwnLaborordnungStatusRequestObject,
) (openapi.GetOwnLaborordnungStatusResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	status, err := s.laborordnung.Evaluate(ctx, principal.PersonID)
	if err != nil {
		return nil, err
	}
	return openapi.GetOwnLaborordnungStatus200JSONResponse(laborordnungStatusDTO(status)), nil
}

func (s *Server) ConfirmOwnLaborordnung(
	ctx context.Context,
	request openapi.ConfirmOwnLaborordnungRequestObject,
) (openapi.ConfirmOwnLaborordnungResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	status, err := s.laborordnung.ConfirmOwn(ctx, principal, request.Body.VersionId, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.ConfirmOwnLaborordnung200JSONResponse{
		Body:    laborordnungStatusDTO(status),
		Headers: openapi.ConfirmOwnLaborordnung200ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (s *Server) ListLaborordnungVersions(
	ctx context.Context,
	_ openapi.ListLaborordnungVersionsRequestObject,
) (openapi.ListLaborordnungVersionsResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	versions, err := s.laborordnung.ListVersions(ctx, principal)
	if err != nil {
		return nil, err
	}
	items := make([]openapi.LaborordnungVersion, 0, len(versions))
	for _, version := range versions {
		items = append(items, laborordnungVersionDTO(version))
	}
	return openapi.ListLaborordnungVersions200JSONResponse{Items: items}, nil
}

func (s *Server) CreateLaborordnungVersion(
	ctx context.Context,
	request openapi.CreateLaborordnungVersionRequestObject,
) (openapi.CreateLaborordnungVersionResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("PDF body is required")
	}
	version, err := s.laborordnung.CreateVersion(
		ctx,
		principal,
		request.Params.XHumanRevision,
		request.Params.XFileName,
		request.Body,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.CreateLaborordnungVersion201JSONResponse(laborordnungVersionDTO(version)), nil
}

func (s *Server) PublishLaborordnungVersion(
	ctx context.Context,
	request openapi.PublishLaborordnungVersionRequestObject,
) (openapi.PublishLaborordnungVersionResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	version, err := s.laborordnung.Publish(
		ctx,
		principal,
		request.LaborordnungVersionId,
		request.Body.EffectiveAt,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.PublishLaborordnungVersion200JSONResponse(laborordnungVersionDTO(version)), nil
}

func (s *Server) GetLaborordnungPDF(
	ctx context.Context,
	request openapi.GetLaborordnungPDFRequestObject,
) (openapi.GetLaborordnungPDFResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	file, reader, err := s.laborordnung.OpenPDF(ctx, principal, request.LaborordnungVersionId)
	if err != nil {
		return nil, err
	}
	return openapi.GetLaborordnungPDF200ApplicationpdfResponse{
		Body:          reader,
		ContentLength: file.Size,
		Headers:       openapi.GetLaborordnungPDF200ResponseHeaders{CacheControl: "private, no-store"},
	}, nil
}

func (s *Server) ListLaborordnungConfirmations(
	ctx context.Context,
	request openapi.ListLaborordnungConfirmationsRequestObject,
) (openapi.ListLaborordnungConfirmationsResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	params := request.Params
	sort := laborordnung.ConfirmationSortConfirmedAt
	if params.Sort != nil {
		sort = laborordnung.ConfirmationSort(*params.Sort)
	}
	var method *laborordnung.ConfirmationMethod
	if params.Method != nil {
		value := laborordnung.ConfirmationMethod(*params.Method)
		method = &value
	}
	page, pageSize := defaultInt(params.Page, 1), defaultInt(params.PageSize, 25)
	items, total, err := s.laborordnung.ListConfirmations(ctx, principal, laborordnung.ConfirmationFilters{
		Search:     defaultString(params.Search),
		VersionID:  params.VersionId,
		PersonID:   params.PersonId,
		Method:     method,
		Sort:       sort,
		Descending: params.Direction == nil || *params.Direction == openapi.ListLaborordnungConfirmationsParamsDirectionDesc,
		Page:       page,
		PageSize:   pageSize,
	})
	if err != nil {
		return nil, err
	}
	result := make([]openapi.LaborordnungConfirmation, 0, len(items))
	for _, item := range items {
		result = append(result, openapi.LaborordnungConfirmation{
			Id:            item.ID,
			PersonId:      item.PersonID,
			PersonName:    item.PersonName,
			VersionId:     item.VersionID,
			HumanRevision: item.HumanRevision,
			Method:        openapi.LaborordnungConfirmationMethod(item.Method),
			ConfirmedAt:   item.ConfirmedAt,
			SignedDate: nullablePointer[time.Time](
				item.SignedDate,
				func(value time.Time) openapi_types.Date { return openapi_types.Date{Time: value} },
			),
			PhysicalDocumentReference: nullablePointer[string](
				item.PhysicalDocumentReference,
				func(value string) string { return value },
			),
			ConfirmedByName: nullablePointer[string](item.ConfirmedByName, func(value string) string { return value }),
		})
	}
	return openapi.ListLaborordnungConfirmations200JSONResponse{
		Body:    openapi.LaborordnungConfirmationPage{Items: result, Page: page, PageSize: pageSize, Total: total},
		Headers: openapi.ListLaborordnungConfirmations200ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func laborordnungVersionDTO(version laborordnung.Version) openapi.LaborordnungVersion {
	return openapi.LaborordnungVersion{
		Id: version.ID, Status: openapi.LaborordnungVersionStatus(version.Status), HumanRevision: version.HumanRevision,
		PdfFileId: version.PDFFileID, Sha256: version.SHA256, CreatedAt: version.CreatedAt,
		EffectiveAt: nullablePointer[time.Time](version.EffectiveAt, func(value time.Time) time.Time { return value }),
		PublishedAt: nullablePointer[time.Time](version.PublishedAt, func(value time.Time) time.Time { return value }),
	}
}

func laborordnungStatusDTO(status laborordnung.Status) openapi.LaborordnungStatus {
	result := openapi.LaborordnungStatus{
		Mode:           openapi.LaborordnungStatusMode(status.Mode),
		State:          openapi.LaborordnungStatusState(status.State),
		ActionRequired: status.ActionRequired,
	}
	if status.CurrentVersion == nil {
		result.CurrentVersion = nullable.NewNullNullable[openapi.LaborordnungVersion]()
	} else {
		result.CurrentVersion = nullable.NewNullableWithValue(laborordnungVersionDTO(*status.CurrentVersion))
	}
	if status.LatestConfirmedVersion == nil {
		result.LatestConfirmedVersion = nullable.NewNullNullable[openapi.LaborordnungVersion]()
	} else {
		result.LatestConfirmedVersion = nullable.NewNullableWithValue(laborordnungVersionDTO(*status.LatestConfirmedVersion))
	}
	result.LatestConfirmedAt = nullablePointer(status.LatestConfirmedAt, func(value time.Time) time.Time { return value })
	return result
}
