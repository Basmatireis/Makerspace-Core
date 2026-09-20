package httpapi

import (
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/laborordnung"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/oapi-codegen/nullable"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

func (s *Server) GetOwnLaborordnungStatus(ctx context.Context, _ openapi.GetOwnLaborordnungStatusRequestObject) (openapi.GetOwnLaborordnungStatusResponseObject, error) {
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

func (s *Server) RequestOwnLaborordnungConfirmation(ctx context.Context, _ openapi.RequestOwnLaborordnungConfirmationRequestObject) (openapi.RequestOwnLaborordnungConfirmationResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	result, created, err := s.laborordnung.RequestOwnConfirmation(ctx, principal, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	response := laborordnungRequestDTO(result)
	if created {
		return openapi.RequestOwnLaborordnungConfirmation201JSONResponse(response), nil
	}
	return openapi.RequestOwnLaborordnungConfirmation200JSONResponse(response), nil
}

func (s *Server) ListLaborordnungVersions(ctx context.Context, _ openapi.ListLaborordnungVersionsRequestObject) (openapi.ListLaborordnungVersionsResponseObject, error) {
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

func (s *Server) CreateLaborordnungVersion(ctx context.Context, request openapi.CreateLaborordnungVersionRequestObject) (openapi.CreateLaborordnungVersionResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("PDF body is required")
	}
	version, err := s.laborordnung.CreateVersion(ctx, principal, request.Params.XHumanRevision, request.Params.XFileName, request.Body, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateLaborordnungVersion201JSONResponse(laborordnungVersionDTO(version)), nil
}

func (s *Server) PublishLaborordnungVersion(ctx context.Context, request openapi.PublishLaborordnungVersionRequestObject) (openapi.PublishLaborordnungVersionResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	version, err := s.laborordnung.Publish(ctx, principal, request.LaborordnungVersionId, request.Body.EffectiveAt, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.PublishLaborordnungVersion200JSONResponse(laborordnungVersionDTO(version)), nil
}

func (s *Server) GetLaborordnungPDF(ctx context.Context, request openapi.GetLaborordnungPDFRequestObject) (openapi.GetLaborordnungPDFResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	file, reader, err := s.laborordnung.OpenPDF(ctx, principal, request.LaborordnungVersionId)
	if err != nil {
		return nil, err
	}
	return openapi.GetLaborordnungPDF200ApplicationpdfResponse{Body: reader, ContentLength: file.Size, Headers: openapi.GetLaborordnungPDF200ResponseHeaders{CacheControl: "private, no-store"}}, nil
}

func (s *Server) ListLaborordnungRequests(ctx context.Context, _ openapi.ListLaborordnungRequestsRequestObject) (openapi.ListLaborordnungRequestsResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	requests, err := s.laborordnung.ListRequests(ctx, principal)
	if err != nil {
		return nil, err
	}
	items := make([]openapi.LaborordnungRequest, 0, len(requests))
	for _, request := range requests {
		items = append(items, laborordnungRequestDTO(request))
	}
	return openapi.ListLaborordnungRequests200JSONResponse{Items: items}, nil
}

func (s *Server) ConfirmLaborordnungRequest(ctx context.Context, request openapi.ConfirmLaborordnungRequestRequestObject) (openapi.ConfirmLaborordnungRequestResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	var signedDate *time.Time
	if request.Body.SignedDate.IsSpecified() && !request.Body.SignedDate.IsNull() {
		value := request.Body.SignedDate.GetOrEmpty().Time
		signedDate = &value
	}
	result, err := s.laborordnung.Confirm(ctx, principal, request.LaborordnungRequestId, request.Body.PhysicalDocumentReference, signedDate, nullableStringPointer(request.Body.ArchiveNote), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.ConfirmLaborordnungRequest200JSONResponse(laborordnungRequestDTO(result)), nil
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
	result := openapi.LaborordnungStatus{Mode: openapi.LaborordnungStatusMode(status.Mode), State: openapi.LaborordnungStatusState(status.State), ActionRequired: status.ActionRequired}
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
	result.RequestId = nullablePointer(status.RequestID, func(value openapi.UUIDv7) openapi.UUIDv7 { return value })
	return result
}

func laborordnungRequestDTO(request laborordnung.Request) openapi.LaborordnungRequest {
	result := openapi.LaborordnungRequest{
		Id: request.ID, PersonId: request.PersonID, PersonName: request.PersonName,
		RequiredVersion: laborordnungVersionDTO(request.RequiredVersion), Status: openapi.LaborordnungRequestStatus(request.Status), RequestedAt: request.RequestedAt,
		CompletedAt:               nullablePointer[time.Time](request.CompletedAt, func(value time.Time) time.Time { return value }),
		PhysicalDocumentReference: nullablePointer[string](request.PhysicalDocumentReference, func(value string) string { return value }),
		ArchiveNote:               nullablePointer[string](request.ArchiveNote, func(value string) string { return value }),
	}
	if request.PreviousVersion == nil {
		result.PreviousVersion = nullable.NewNullNullable[openapi.LaborordnungVersion]()
	} else {
		result.PreviousVersion = nullable.NewNullableWithValue(laborordnungVersionDTO(*request.PreviousVersion))
	}
	result.SignedDate = nullablePointer[time.Time](request.SignedDate, func(value time.Time) openapi_types.Date { return openapi_types.Date{Time: value} })
	return result
}
