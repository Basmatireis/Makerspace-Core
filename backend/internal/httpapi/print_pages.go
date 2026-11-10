package httpapi

import (
	"context"
	"net/http"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/runrecordings"
	"github.com/oapi-codegen/nullable"
)

func (s *Server) GetPrintPage(
	ctx context.Context,
	request openapi.GetPrintPageRequestObject,
) (openapi.GetPrintPageResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	page, err := s.runRecordings.GetPrintPage(ctx, principal, request.RunId)
	if err != nil {
		return nil, err
	}
	return openapi.GetPrintPage200JSONResponse(printPageDTO(page)), nil
}

func printPageDTO(page runrecordings.PrintPage) openapi.PrintPage {
	dto := openapi.PrintPage{
		RunId:           page.RunID,
		DisplayId:       page.DisplayID,
		Title:           page.Title,
		MachineName:     page.MachineName,
		StartedAt:       page.StartedAt,
		EndedAt:         optionalNullable(page.EndedAt),
		DurationSeconds: optionalNullable(page.DurationSeconds),
		Outcome:         nullable.NewNullNullable[openapi.MachineRunOutcome](),
		Timelapse:       nullable.NewNullNullable[openapi.PrintPageTimelapse](),
		TimelapseStatus: nullable.NewNullNullable[openapi.MachineRunTimelapseStatus](),
		Artifact:        nullable.NewNullNullable[openapi.PrintPageArtifact](),
		Previews:        make([]openapi.PrintPagePreview, 0, len(page.Previews)),
		ViewerIsStaff:   page.ViewerIsStaff,
	}
	if page.Outcome != nil {
		dto.Outcome = nullable.NewNullableWithValue(openapi.MachineRunOutcome(*page.Outcome))
	}
	if page.Timelapse != nil {
		dto.Timelapse = nullable.NewNullableWithValue(openapi.PrintPageTimelapse{
			SizeBytes: page.Timelapse.SizeBytes,
			MimeType:  openapi.PrintPageTimelapseMimeType(runrecordings.TimelapseContentType),
			ExpiresAt: optionalNullable(page.Timelapse.ExpiresAt),
		})
	}
	if status := page.TimelapseStatus; status != nil {
		dto.TimelapseStatus = nullable.NewNullableWithValue(openapi.MachineRunTimelapseStatus{
			State:  openapi.MachineRunTimelapseStatusState(status.State),
			Reason: optionalNullable(status.Reason),
			Detail: nullable.NewNullNullable[string](),
		})
	}
	if page.Artifact != nil {
		dto.Artifact = nullable.NewNullableWithValue(openapi.PrintPageArtifact{
			OriginalFileName: page.Artifact.OriginalFilename,
			SizeBytes:        page.Artifact.SizeBytes,
		})
	}
	for _, preview := range page.Previews {
		dto.Previews = append(dto.Previews, openapi.PrintPagePreview{
			Id:          preview.ID,
			Role:        openapi.PrintPagePreviewRole(preview.Role),
			PlateNumber: optionalNullable(preview.PlateNumber),
			Primary:     preview.Primary,
		})
	}
	return dto
}

// printPageTimelapseResponse serves a print page's timelapse exactly like the run page's: with HTTP Range support when
// the storage reader can seek.
type printPageTimelapseResponse struct{ runTimelapseResponse }

func (response printPageTimelapseResponse) VisitDownloadPrintPageTimelapseResponse(w http.ResponseWriter) error {
	return response.VisitDownloadMachineRunTimelapseResponse(w)
}

func (s *Server) DownloadPrintPageTimelapse(
	ctx context.Context,
	request openapi.DownloadPrintPageTimelapseRequestObject,
) (openapi.DownloadPrintPageTimelapseResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	file, reader, err := s.runRecordings.OpenPrintPageTimelapse(ctx, principal, request.RunId)
	if err != nil {
		return nil, err
	}
	return printPageTimelapseResponse{runTimelapseResponse{file: file, reader: reader, request: httpRequest(ctx)}}, nil
}

func (s *Server) DownloadPrintPageFile(
	ctx context.Context,
	request openapi.DownloadPrintPageFileRequestObject,
) (openapi.DownloadPrintPageFileResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	file, reader, err := s.runRecordings.OpenPrintPageArtifact(ctx, principal, request.RunId)
	if err != nil {
		return nil, err
	}
	return openapi.DownloadPrintPageFile200ApplicationoctetStreamResponse{
		Body:          reader,
		ContentLength: file.SizeBytes,
		Headers: openapi.DownloadPrintPageFile200ResponseHeaders{
			CacheControl:        "no-store",
			ContentDisposition:  attachmentDisposition(file.FileName),
			XContentTypeOptions: "nosniff",
		},
	}, nil
}

func (s *Server) GetPrintPagePreview(
	ctx context.Context,
	request openapi.GetPrintPagePreviewRequestObject,
) (openapi.GetPrintPagePreviewResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	file, reader, err := s.runRecordings.OpenPrintPagePreview(ctx, principal, request.RunId, request.PreviewId)
	if err != nil {
		return nil, err
	}
	headers := openapi.GetPrintPagePreview200ResponseHeaders{
		CacheControl:        "no-store",
		ContentDisposition:  inlineDisposition(file.FileName),
		XContentTypeOptions: "nosniff",
	}
	if file.ContentType == "image/png" {
		return openapi.GetPrintPagePreview200ImagepngResponse{
			Body:          reader,
			ContentLength: file.SizeBytes,
			Headers:       headers,
		}, nil
	}
	return openapi.GetPrintPagePreview200ImagejpegResponse{
		Body:          reader,
		ContentLength: file.SizeBytes,
		Headers:       headers,
	}, nil
}
