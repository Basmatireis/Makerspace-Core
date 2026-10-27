package httpapi

import (
	"context"
	"io"
	"mime"
	"net/http"
	"strconv"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/runrecordings"
	"github.com/oapi-codegen/nullable"
)

func (s *Server) GetMachineRunRecording(
	ctx context.Context,
	request openapi.GetMachineRunRecordingRequestObject,
) (openapi.GetMachineRunRecordingResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	recording, err := s.runRecordings.GetRecording(ctx, principal, request.RunId)
	if err != nil {
		return nil, err
	}
	return openapi.GetMachineRunRecording200JSONResponse(runRecordingDTO(recording)), nil
}

func (s *Server) ListMachineJobRecordings(
	ctx context.Context,
	request openapi.ListMachineJobRecordingsRequestObject,
) (openapi.ListMachineJobRecordingsResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	recordings, err := s.runRecordings.ListJobRecordings(ctx, principal, request.MachineJobId)
	if err != nil {
		return nil, err
	}
	items := make([]openapi.MachineRunRecording, 0, len(recordings))
	for _, recording := range recordings {
		items = append(items, runRecordingDTO(recording))
	}
	return openapi.ListMachineJobRecordings200JSONResponse{Items: items}, nil
}

func (s *Server) DownloadMachineRunArtifact(
	ctx context.Context,
	request openapi.DownloadMachineRunArtifactRequestObject,
) (openapi.DownloadMachineRunArtifactResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	file, reader, err := s.runRecordings.OpenRunArtifact(ctx, principal, request.RunId)
	if err != nil {
		return nil, err
	}
	return openapi.DownloadMachineRunArtifact200ApplicationoctetStreamResponse{
		Body:          reader,
		ContentLength: file.SizeBytes,
		Headers: openapi.DownloadMachineRunArtifact200ResponseHeaders{
			CacheControl:        "no-store",
			ContentDisposition:  attachmentDisposition(file.FileName),
			XContentTypeOptions: "nosniff",
		},
	}, nil
}

func (s *Server) GetMachineRunPreview(
	ctx context.Context,
	request openapi.GetMachineRunPreviewRequestObject,
) (openapi.GetMachineRunPreviewResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	file, reader, err := s.runRecordings.OpenRunPreview(ctx, principal, request.RunId, request.PreviewId)
	if err != nil {
		return nil, err
	}
	headers := openapi.GetMachineRunPreview200ResponseHeaders{
		CacheControl:        "no-store",
		ContentDisposition:  inlineDisposition(file.FileName),
		XContentTypeOptions: "nosniff",
	}
	if file.ContentType == "image/png" {
		return openapi.GetMachineRunPreview200ImagepngResponse{
			Body:          reader,
			ContentLength: file.SizeBytes,
			Headers:       headers,
		}, nil
	}
	return openapi.GetMachineRunPreview200ImagejpegResponse{
		Body:          reader,
		ContentLength: file.SizeBytes,
		Headers:       headers,
	}, nil
}

// runTimelapseResponse serves the video with HTTP Range support through
// http.ServeContent when the storage reader can seek; other storage streams the
// whole body with Accept-Ranges: none.
type runTimelapseResponse struct {
	file    runrecordings.FileContent
	reader  io.ReadCloser
	request *http.Request
}

func (response runTimelapseResponse) VisitDownloadMachineRunTimelapseResponse(w http.ResponseWriter) error {
	defer func() { _ = response.reader.Close() }()
	header := w.Header()
	header.Set("Content-Type", response.file.ContentType)
	header.Set("Cache-Control", "no-store")
	header.Set("Content-Disposition", attachmentDisposition(response.file.FileName))
	header.Set("X-Content-Type-Options", "nosniff")
	if seeker, ok := response.reader.(io.ReadSeeker); ok && response.request != nil {
		http.ServeContent(w, response.request, "", time.Time{}, seeker)
		return nil
	}
	header.Set("Accept-Ranges", "none")
	header.Set("Content-Length", strconv.FormatInt(response.file.SizeBytes, 10))
	w.WriteHeader(http.StatusOK)
	_, err := io.Copy(w, response.reader)
	return err
}

func (s *Server) DownloadMachineRunTimelapse(
	ctx context.Context,
	request openapi.DownloadMachineRunTimelapseRequestObject,
) (openapi.DownloadMachineRunTimelapseResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	file, reader, err := s.runRecordings.OpenRunTimelapse(ctx, principal, request.RunId)
	if err != nil {
		return nil, err
	}
	return runTimelapseResponse{file: file, reader: reader, request: httpRequest(ctx)}, nil
}

func (s *Server) RequestMachineRunArtifactRefetch(
	ctx context.Context,
	request openapi.RequestMachineRunArtifactRefetchRequestObject,
) (openapi.RequestMachineRunArtifactRefetchResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	command, created, err := s.runRecordings.RequestCommand(
		ctx,
		principal,
		request.RunId,
		runrecordings.CommandRefetchArtifact,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	if created {
		return openapi.RequestMachineRunArtifactRefetch202JSONResponse(runCommandDTO(command)), nil
	}
	return openapi.RequestMachineRunArtifactRefetch200JSONResponse(runCommandDTO(command)), nil
}

func (s *Server) RequestMachineRunConsumptionRecompute(
	ctx context.Context,
	request openapi.RequestMachineRunConsumptionRecomputeRequestObject,
) (openapi.RequestMachineRunConsumptionRecomputeResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	command, created, err := s.runRecordings.RequestCommand(
		ctx,
		principal,
		request.RunId,
		runrecordings.CommandRecomputeConsumption,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	if created {
		return openapi.RequestMachineRunConsumptionRecompute202JSONResponse(runCommandDTO(command)), nil
	}
	return openapi.RequestMachineRunConsumptionRecompute200JSONResponse(runCommandDTO(command)), nil
}

func (s *Server) GetRunRecordingSettings(
	ctx context.Context,
	_ openapi.GetRunRecordingSettingsRequestObject,
) (openapi.GetRunRecordingSettingsResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	settings, err := s.runRecordings.GetSettings(ctx, principal)
	if err != nil {
		return nil, err
	}
	return openapi.GetRunRecordingSettings200JSONResponse(s.runRecordingSettingsDTO(settings)), nil
}

func (s *Server) UpdateRunRecordingSettings(
	ctx context.Context,
	request openapi.UpdateRunRecordingSettingsRequestObject,
) (openapi.UpdateRunRecordingSettingsResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	settings, err := s.runRecordings.UpdateSettings(ctx, principal, runrecordings.SettingsInput{
		TimelapseEnabled:       request.Body.TimelapseEnabled,
		TimelapseRetentionDays: request.Body.TimelapseRetentionDays,
		ExpectedVersion:        request.Body.ExpectedVersion,
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateRunRecordingSettings200JSONResponse(s.runRecordingSettingsDTO(settings)), nil
}

// Connector side --------------------------------------------------------------------------------------------

func (s *Server) ReportPrinterConnectorRun(
	ctx context.Context,
	request openapi.ReportPrinterConnectorRunRequestObject,
) (openapi.ReportPrinterConnectorRunResponseObject, error) {
	connector, err := printerConnectorContext(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	report := runrecordings.RunReport{
		ProtocolVersion: request.Body.ProtocolVersion,
		ObservedAt:      request.Body.ObservedAt,
		Consumption:     runReportSection(request.Body.Consumption),
		Timelapse:       runReportSection(request.Body.Timelapse),
	}
	if err = s.runRecordings.ReportRun(ctx, connector, request.AssignmentId, request.RunId, report); err != nil {
		return nil, err
	}
	return openapi.ReportPrinterConnectorRun204Response{}, nil
}

func (s *Server) UploadPrinterConnectorRunTimelapse(
	ctx context.Context,
	request openapi.UploadPrinterConnectorRunTimelapseRequestObject,
) (openapi.UploadPrinterConnectorRunTimelapseResponseObject, error) {
	connector, err := printerConnectorContext(ctx)
	if err != nil {
		return nil, err
	}
	result, err := s.runRecordings.UploadTimelapse(ctx, connector, runrecordings.TimelapseUpload{
		AssignmentID:  request.AssignmentId,
		RunID:         request.RunId,
		FileName:      request.Params.XTimelapseFilename,
		SHA256:        request.Params.XTimelapseSHA256,
		ContentLength: request.Params.ContentLength,
	}, request.Body, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	if result.Created {
		return openapi.UploadPrinterConnectorRunTimelapse201JSONResponse{
			RunId:       result.RunID,
			Disposition: openapi.PrinterConnectorTimelapseUploadResultDispositionCreated,
			SizeBytes:   result.SizeBytes,
		}, nil
	}
	return openapi.UploadPrinterConnectorRunTimelapse200JSONResponse{
		RunId:       result.RunID,
		Disposition: openapi.PrinterConnectorTimelapseUploadResultDispositionDeduplicated,
		SizeBytes:   result.SizeBytes,
	}, nil
}

func (s *Server) DownloadPrinterConnectorRunArtifact(
	ctx context.Context,
	request openapi.DownloadPrinterConnectorRunArtifactRequestObject,
) (openapi.DownloadPrinterConnectorRunArtifactResponseObject, error) {
	connector, err := printerConnectorContext(ctx)
	if err != nil {
		return nil, err
	}
	file, reader, err := s.runRecordings.OpenConnectorRunArtifact(ctx, connector, request.AssignmentId, request.RunId)
	if err != nil {
		return nil, err
	}
	return openapi.DownloadPrinterConnectorRunArtifact200ApplicationoctetStreamResponse{
		Body:          reader,
		ContentLength: file.SizeBytes,
		Headers: openapi.DownloadPrinterConnectorRunArtifact200ResponseHeaders{
			CacheControl:    "no-store",
			XArtifactSHA256: file.SHA256,
		},
	}, nil
}

func (s *Server) ListPrinterConnectorCommands(
	ctx context.Context,
	_ openapi.ListPrinterConnectorCommandsRequestObject,
) (openapi.ListPrinterConnectorCommandsResponseObject, error) {
	connector, err := printerConnectorContext(ctx)
	if err != nil {
		return nil, err
	}
	commands, err := s.runRecordings.ConnectorCommands(ctx, connector)
	if err != nil {
		return nil, err
	}
	items := make([]openapi.PrinterConnectorCommand, 0, len(commands))
	for _, command := range commands {
		if command.AssignmentID == nil {
			continue
		}
		items = append(items, openapi.PrinterConnectorCommand{
			Id:           command.ID,
			AssignmentId: *command.AssignmentID,
			RunId:        command.RunID,
			Kind:         openapi.PrinterConnectorCommandKind(command.Kind),
			State:        openapi.PrinterConnectorCommandState(command.State),
			RequestedAt:  command.RequestedAt,
		})
	}
	return openapi.ListPrinterConnectorCommands200JSONResponse{
		Body:    openapi.PrinterConnectorCommandList{Items: items},
		Headers: openapi.ListPrinterConnectorCommands200ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (s *Server) ReportPrinterConnectorCommandStatus(
	ctx context.Context,
	request openapi.ReportPrinterConnectorCommandStatusRequestObject,
) (openapi.ReportPrinterConnectorCommandStatusResponseObject, error) {
	connector, err := printerConnectorContext(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err = s.runRecordings.ReportCommandStatus(
		ctx,
		connector,
		request.CommandId,
		runrecordings.CommandState(request.Body.State),
		nullableStringPointer(request.Body.ReasonCode),
	); err != nil {
		return nil, err
	}
	return openapi.ReportPrinterConnectorCommandStatus204Response{}, nil
}

// DTOs ------------------------------------------------------------------------------------------------------

func runReportSection(
	value nullable.Nullable[openapi.PrinterConnectorRunReportSection],
) *runrecordings.RunReportSection {
	if !value.IsSpecified() || value.IsNull() {
		return nil
	}
	section := value.MustGet()
	return &runrecordings.RunReportSection{
		State:  section.State,
		Reason: nullableStringPointer(section.Reason),
		Detail: nullableStringPointer(section.Detail),
	}
}

func consumptionStatusDTO(
	status *machinelogbook.ConsumptionStatus,
) nullable.Nullable[openapi.MachineRunConsumptionStatus] {
	if status == nil {
		return nullable.NewNullNullable[openapi.MachineRunConsumptionStatus]()
	}
	reason := nullable.NewNullNullable[openapi.MachineRunConsumptionReason]()
	if status.Reason != nil {
		reason = nullable.NewNullableWithValue(openapi.MachineRunConsumptionReason(*status.Reason))
	}
	return nullable.NewNullableWithValue(openapi.MachineRunConsumptionStatus{
		State:  openapi.MachineRunConsumptionStatusState(status.State),
		Reason: reason,
		Detail: nullableString(status.Detail),
	})
}

func runCommandDTO(command runrecordings.Command) openapi.MachineRunCommand {
	return openapi.MachineRunCommand{
		Id:          command.ID,
		RunId:       command.RunID,
		Kind:        openapi.MachineRunCommandKind(command.Kind),
		State:       openapi.MachineRunCommandState(command.State),
		ReasonCode:  nullableString(command.ReasonCode),
		RequestedAt: command.RequestedAt,
		StartedAt:   nullableTimeValue(command.StartedAt),
		FinishedAt:  nullableTimeValue(command.FinishedAt),
	}
}

func runRecordingDTO(recording runrecordings.Recording) openapi.MachineRunRecording {
	previews := make([]openapi.MachineRunPreview, 0, len(recording.Previews))
	for _, preview := range recording.Previews {
		previews = append(previews, openapi.MachineRunPreview{
			Id:          preview.ID,
			Role:        openapi.MachineRunPreviewRole(preview.Role),
			PlateNumber: nullableValue(preview.PlateNumber),
			Width:       preview.Width,
			Height:      preview.Height,
			MimeType:    openapi.MachineRunPreviewMimeType(preview.MIMEType),
			Primary:     preview.Primary,
		})
	}
	commands := make([]openapi.MachineRunCommand, 0, len(recording.Commands))
	for _, command := range recording.Commands {
		commands = append(commands, runCommandDTO(command))
	}
	artifact := nullable.NewNullNullable[openapi.MachineRunArtifactFile]()
	if value := recording.Artifact; value != nil {
		artifact = nullable.NewNullableWithValue(openapi.MachineRunArtifactFile{
			Id:               value.ID,
			OriginalFilename: value.OriginalFilename,
			SizeBytes:        value.SizeBytes,
			Sha256:           value.SHA256,
			ParserStatus:     openapi.PrintArtifactParserStatus(value.ParserStatus),
		})
	}
	timelapse := nullable.NewNullNullable[openapi.MachineRunTimelapse]()
	if value := recording.Timelapse; value != nil {
		timelapse = nullable.NewNullableWithValue(openapi.MachineRunTimelapse{
			SizeBytes:   value.SizeBytes,
			ContentType: openapi.MachineRunTimelapseContentType(runrecordings.TimelapseContentType),
			CreatedAt:   value.CreatedAt,
			ExpiresAt:   nullableTimeValue(value.ExpiresAt),
		})
	}
	status := nullable.NewNullNullable[openapi.MachineRunTimelapseStatus]()
	if value := recording.TimelapseStatus; value != nil {
		status = nullable.NewNullableWithValue(openapi.MachineRunTimelapseStatus{
			State:  openapi.MachineRunTimelapseStatusState(value.State),
			Reason: nullableString(value.Reason),
			Detail: nullableString(value.Detail),
		})
	}
	return openapi.MachineRunRecording{
		RunId:             recording.RunID,
		RunDisplayId:      recording.RunDisplayID,
		Source:            openapi.MachineRunSource(recording.Source),
		State:             openapi.MachineRunState(recording.State),
		StartedAt:         recording.StartedAt,
		ConsumptionStatus: consumptionStatusDTO(recording.ConsumptionStatus),
		Artifact:          artifact,
		Previews:          previews,
		Timelapse:         timelapse,
		TimelapseStatus:   status,
		Commands:          commands,
	}
}

func (s *Server) runRecordingSettingsDTO(settings runrecordings.Settings) openapi.RunRecordingSettings {
	maxBytes := s.runRecordings.TimelapseMaxBytes()
	return openapi.RunRecordingSettings{
		TimelapseEnabled:       settings.TimelapseEnabled,
		TimelapseRetentionDays: settings.TimelapseRetentionDays,
		TimelapseMaxBytes:      &maxBytes,
		Version:                settings.Version,
		UpdatedAt:              settings.UpdatedAt,
	}
}

// inlineDisposition lets img elements render a preview while keeping a safe file name.
func inlineDisposition(filename string) string {
	value := mime.FormatMediaType("inline", map[string]string{"filename": filename})
	if value == "" {
		return "inline"
	}
	return value
}
