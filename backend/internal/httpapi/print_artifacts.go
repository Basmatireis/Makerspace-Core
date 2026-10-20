package httpapi

import (
	"context"
	"path/filepath"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printartifacts"
)

func (s *Server) GetPrintArtifact(
	ctx context.Context,
	request openapi.GetPrintArtifactRequestObject,
) (openapi.GetPrintArtifactResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	artifact, err := s.printArtifacts.Get(ctx, principal, request.ArtifactId)
	if err != nil {
		return nil, err
	}
	return openapi.GetPrintArtifact200JSONResponse(printArtifactDTO(artifact)), nil
}

func (s *Server) DownloadPrintArtifact(
	ctx context.Context,
	request openapi.DownloadPrintArtifactRequestObject,
) (openapi.DownloadPrintArtifactResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	artifact, reader, err := s.printArtifacts.Open(ctx, principal, request.ArtifactId)
	if err != nil {
		return nil, err
	}
	return openapi.DownloadPrintArtifact200ApplicationoctetStreamResponse{
		Body: reader, ContentLength: artifact.SizeBytes,
		Headers: openapi.DownloadPrintArtifact200ResponseHeaders{
			CacheControl:        "no-store",
			ContentDisposition:  attachmentDisposition(artifact.OriginalFilename),
			XContentTypeOptions: "nosniff",
		},
	}, nil
}

func (s *Server) ListPrintArtifactPreviews(
	ctx context.Context,
	request openapi.ListPrintArtifactPreviewsRequestObject,
) (openapi.ListPrintArtifactPreviewsResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	previews, err := s.printArtifacts.ListPreviews(ctx, principal, request.ArtifactId)
	if err != nil {
		return nil, err
	}
	items := make([]openapi.PrintArtifactPreview, 0, len(previews))
	for _, preview := range previews {
		items = append(items, printArtifactPreviewDTO(preview))
	}
	return openapi.ListPrintArtifactPreviews200JSONResponse{Items: items}, nil
}

func (s *Server) DownloadPrintArtifactPreview(
	ctx context.Context,
	request openapi.DownloadPrintArtifactPreviewRequestObject,
) (openapi.DownloadPrintArtifactPreviewResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	preview, reader, err := s.printArtifacts.OpenPreview(ctx, principal, request.PreviewId)
	if err != nil {
		return nil, err
	}
	headers := openapi.DownloadPrintArtifactPreview200ResponseHeaders{
		CacheControl:        "no-store",
		ContentDisposition:  attachmentDisposition(filepath.Base(preview.ArchivePath)),
		XContentTypeOptions: "nosniff",
	}
	if preview.MIMEType == "image/png" {
		return openapi.DownloadPrintArtifactPreview200ImagepngResponse{
			Body:          reader,
			ContentLength: preview.SizeBytes,
			Headers:       headers,
		}, nil
	}
	return openapi.DownloadPrintArtifactPreview200ImagejpegResponse{
		Body:          reader,
		ContentLength: preview.SizeBytes,
		Headers:       headers,
	}, nil
}

func (s *Server) CreateMachineJobFromArtifact(
	ctx context.Context,
	request openapi.CreateMachineJobFromArtifactRequestObject,
) (openapi.CreateMachineJobFromArtifactResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	job, err := s.printArtifacts.CreatePlannedJob(ctx, principal, request.ArtifactId, printartifacts.PlannedJobInput{
		MachineID:        request.Body.MachineId,
		Customer:         partyInput(request.Body.Customer),
		OperatorPersonID: request.Body.OperatorPersonId,
		Title: nullableStringPointer(
			request.Body.Title,
		), Notes: nullableStringPointer(request.Body.Notes), PricingGroupID: uuidNullable(request.Body.PricingGroupId),
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateMachineJobFromArtifact201JSONResponse(mlJobDTO(job)), nil
}

func (s *Server) UploadPrinterConnectorRunArtifact(
	ctx context.Context,
	request openapi.UploadPrinterConnectorRunArtifactRequestObject,
) (openapi.UploadPrinterConnectorRunArtifactResponseObject, error) {
	connector, err := printerConnectorContext(ctx)
	if err != nil {
		return nil, err
	}
	result, err := s.printArtifacts.Upload(
		ctx,
		connector.ID,
		request.AssignmentId,
		request.RunId,
		request.Params.XConfigurationVersion,
		request.Params.XArtifactFilename,
		request.Params.XArtifactSHA256,
		request.Params.ContentLength,
		request.Body,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	response := openapi.PrintArtifactUploadResult{
		Artifact:          printArtifactDTO(result.Artifact),
		AutoAttachedJobId: nullableUUIDValue(result.AutoAttachedJobID),
		Disposition:       openapi.PrintArtifactUploadResultDisposition(result.Disposition),
		RunId:             result.RunID,
	}
	if result.Disposition == "created" {
		return openapi.UploadPrinterConnectorRunArtifact201JSONResponse(response), nil
	}
	return openapi.UploadPrinterConnectorRunArtifact200JSONResponse(response), nil
}

func printArtifactDTO(item printartifacts.Artifact) openapi.PrintArtifact {
	filaments := make([]openapi.PrintArtifactFilament, 0, len(item.Filaments))
	for _, filament := range item.Filaments {
		filaments = append(filaments, openapi.PrintArtifactFilament{
			FilamentKey:  filament.Key,
			FilamentType: nullableString(optionalNonEmpty(filament.Type)),
			Color:        nullableString(optionalNonEmpty(filament.Color)),
			Extruder:     nullableValue(filament.Extruder),
			PlannedWeightGrams: nullableDecimalValue(
				filament.WeightGrams,
			), PlannedLengthMillimeters: nullableDecimalValue(filament.LengthMM), DensityGramsPerCubicCentimeter: nullableDecimalValue(filament.DensityGCM3), DiameterMillimeters: nullableDecimalValue(filament.DiameterMM),
		})
	}
	return openapi.PrintArtifact{
		Id:               item.ID,
		OriginalFilename: item.OriginalFilename,
		Sha256:           item.SHA256,
		SizeBytes:        item.SizeBytes,
		ParserStatus:     openapi.PrintArtifactParserStatus(item.ParserStatus),
		ParserVersion:    item.ParserVersion,
		Metadata:         item.Metadata,
		PrimaryPreviewId: nullableUUIDValue(item.PrimaryPreviewID),
		Filaments:        filaments,
		CreatedAt:        item.CreatedAt,
		UpdatedAt:        item.UpdatedAt,
	}
}

func printArtifactPreviewDTO(item printartifacts.Preview) openapi.PrintArtifactPreview {
	return openapi.PrintArtifactPreview{
		Id:          item.ID,
		ArtifactId:  item.ArtifactID,
		ArchivePath: item.ArchivePath,
		Role:        openapi.PrintArtifactPreviewRole(item.Role),
		PlateNumber: nullableValue(item.PlateNumber),
		Width:       item.Width,
		Height:      item.Height,
		MimeType:    openapi.PrintArtifactPreviewMimeType(item.MIMEType),
		SizeBytes:   item.SizeBytes,
		Sha256:      item.SHA256,
		Primary:     item.Primary,
	}
}

func optionalNonEmpty(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}
