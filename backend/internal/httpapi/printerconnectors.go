package httpapi

import (
	"context"
	"encoding/json"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printerconnectors"
	"github.com/oapi-codegen/nullable"
)

func printerConnectorDTO(value printerconnectors.Connector) openapi.PrinterConnector {
	health := nullable.NewNullNullable[openapi.PrinterConnectorHealthState]()
	if value.HealthState != nil {
		health = nullable.NewNullableWithValue(openapi.PrinterConnectorHealthState(*value.HealthState))
	}
	update := nullable.NewNullNullable[openapi.LocalServiceUpdate]()
	if state := value.Update; state != nil {
		update = localServiceUpdateDTO(
			state.RequestID,
			state.TargetVersion,
			state.RequestedAt,
			state.Status,
			state.Reason,
			state.StatusAt,
		)
	}
	return openapi.PrinterConnector{
		Id:                    value.ID,
		Name:                  value.Name,
		LocationLabel:         nullableString(value.LocationLabel),
		Lifecycle:             openapi.PrinterConnectorLifecycle(value.Lifecycle),
		ConfigurationRevision: value.ConfigurationRevision, AppliedConfigurationRevision: value.AppliedRevision,
		SoftwareVersion: nullableString(value.SoftwareVersion), ProtocolVersion: nullableValue(value.ProtocolVersion),
		HealthState:           health,
		HealthSummary:         nullableString(value.HealthSummary),
		PendingEventCount:     value.PendingEventCount,
		QuarantinedEventCount: value.QuarantinedEventCount,
		EventsClearedAt:       nullableValue(value.EventsClearedAt),
		EventsClearedByName:   nullableString(value.EventsClearedByName),
		LastHeartbeatAt:       nullableValue(value.LastHeartbeatAt),
		EnrolledAt: nullableValue(
			value.EnrolledAt,
		), DisabledAt: nullableValue(value.DisabledAt), RevokedAt: nullableValue(value.RevokedAt),
		UpdaterAvailable: value.UpdaterAvailable, Update: update,
		Version: value.Version, CreatedAt: value.CreatedAt, UpdatedAt: value.UpdatedAt,
	}
}

func printerConnectorAssignmentDTO(value printerconnectors.Assignment) openapi.PrinterConnectorAssignment {
	settings := map[string]any{}
	_ = json.Unmarshal(value.Settings, &settings)
	runtimeState := nullable.NewNullNullable[openapi.PrinterConnectorAssignmentRuntimeState]()
	if value.RuntimeState != nil {
		runtimeState = nullable.NewNullableWithValue(
			openapi.PrinterConnectorAssignmentRuntimeState(*value.RuntimeState),
		)
	}
	return openapi.PrinterConnectorAssignment{Id: value.ID, ConnectorId: value.ConnectorID, MachineId: value.MachineID,
		MachineName:          value.MachineName,
		AdapterKind:          string(value.AdapterKind),
		AdapterSchemaVersion: value.AdapterSchemaVersion,
		Settings:             settings,
		ConfigurationVersion: value.ConfigurationVersion, AppliedConfigurationVersion: value.AppliedVersion,
		Enabled:          value.Enabled,
		RuntimeState:     runtimeState,
		RuntimeErrorCode: nullableString(value.RuntimeErrorCode),
		EndedAt:          nullableValue(value.EndedAt),
		Version:          value.Version, ActivatedAt: value.ActivatedAt, CreatedAt: value.CreatedAt, UpdatedAt: value.UpdatedAt}
}

func printerObservedRunDTO(value printerconnectors.ObservedRun) openapi.PrinterObservedRun {
	return openapi.PrinterObservedRun{
		Id:              value.ID,
		AssignmentId:    value.AssignmentID,
		MachineId:       value.MachineID,
		MachineName:     value.MachineName,
		VendorJobId:     nullableString(value.VendorJobID),
		State:           openapi.MachineRunState(value.State),
		HistoryComplete: value.HistoryComplete,
		FirstObservedAt: value.FirstObservedAt,
		LastObservedAt:  value.LastObservedAt,
		Version:         value.Version,
	}
}

func printerConnectorEventDTO(value printerconnectors.ConnectorEvent) openapi.PrinterConnectorEvent {
	payload := map[string]any{}
	_ = json.Unmarshal(value.Payload, &payload)
	return openapi.PrinterConnectorEvent{Id: value.ID, MachineId: value.MachineID, AssignmentId: value.AssignmentID,
		Kind: openapi.PrinterConnectorEventKind(value.Kind), OccurredAt: value.OccurredAt, ReceivedAt: value.ReceivedAt,
		ApplicationState: openapi.PrinterConnectorEventApplicationState(
			value.ApplicationState,
		), ApplicationReason: nullableString(value.ApplicationReason),
		Payload: payload}
}

func (s *Server) ListPrinterConnectors(
	ctx context.Context,
	_ openapi.ListPrinterConnectorsRequestObject,
) (openapi.ListPrinterConnectorsResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.printerConnectors.List(ctx, principal)
	if err != nil {
		return nil, err
	}
	result := make([]openapi.PrinterConnector, 0, len(items))
	for _, item := range items {
		result = append(result, printerConnectorDTO(item))
	}
	return openapi.ListPrinterConnectors200JSONResponse{Items: result, CoreVersion: s.config.Version}, nil
}

func (s *Server) CreatePrinterConnector(
	ctx context.Context,
	request openapi.CreatePrinterConnectorRequestObject,
) (openapi.CreatePrinterConnectorResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.printerConnectors.Create(
		ctx,
		principal,
		request.Body.Name,
		nullableStringPointer(request.Body.LocationLabel),
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.CreatePrinterConnector201JSONResponse(printerConnectorDTO(item)), nil
}

func (s *Server) GetPrinterConnector(
	ctx context.Context,
	request openapi.GetPrinterConnectorRequestObject,
) (openapi.GetPrinterConnectorResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	item, err := s.printerConnectors.Get(ctx, principal, request.PrinterConnectorId)
	if err != nil {
		return nil, err
	}
	return openapi.GetPrinterConnector200JSONResponse(printerConnectorDTO(item)), nil
}

func (s *Server) UpdatePrinterConnector(
	ctx context.Context,
	request openapi.UpdatePrinterConnectorRequestObject,
) (openapi.UpdatePrinterConnectorResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.printerConnectors.Update(
		ctx,
		principal,
		request.PrinterConnectorId,
		request.Body.Name,
		nullableStringPointer(request.Body.LocationLabel),
		request.Body.Enabled,
		request.Body.ExpectedVersion,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.UpdatePrinterConnector200JSONResponse(printerConnectorDTO(item)), nil
}

func (s *Server) DeletePrinterConnector(
	ctx context.Context,
	request openapi.DeletePrinterConnectorRequestObject,
) (openapi.DeletePrinterConnectorResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err = s.printerConnectors.Delete(
		ctx,
		principal,
		request.PrinterConnectorId,
		request.Body.ExpectedVersion,
		requestIDPointer(ctx),
	); err != nil {
		return nil, err
	}
	return openapi.DeletePrinterConnector204Response{}, nil
}

func (s *Server) CreatePrinterConnectorEnrollment(
	ctx context.Context,
	request openapi.CreatePrinterConnectorEnrollmentRequestObject,
) (openapi.CreatePrinterConnectorEnrollmentResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	issue, err := s.printerConnectors.IssueEnrollment(ctx, principal, request.PrinterConnectorId, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	secret := issue.Secret
	return openapi.CreatePrinterConnectorEnrollment201JSONResponse{
		Body: openapi.PrinterConnectorEnrollmentIssue{
			Connector:        printerConnectorDTO(issue.Connector),
			EnrollmentId:     issue.ID,
			EnrollmentSecret: &secret,
			ExpiresAt:        issue.ExpiresAt,
		},
		Headers: openapi.CreatePrinterConnectorEnrollment201ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (s *Server) RevokePrinterConnector(
	ctx context.Context,
	request openapi.RevokePrinterConnectorRequestObject,
) (openapi.RevokePrinterConnectorResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.printerConnectors.Revoke(
		ctx,
		principal,
		request.PrinterConnectorId,
		request.Body.ExpectedVersion,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.RevokePrinterConnector200JSONResponse(printerConnectorDTO(item)), nil
}

func (s *Server) CreatePrinterConnectorAssignment(
	ctx context.Context,
	request openapi.CreatePrinterConnectorAssignmentRequestObject,
) (openapi.CreatePrinterConnectorAssignmentResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	settings, _ := json.Marshal(request.Body.Settings)
	secrets := map[string]string{}
	if request.Body.Secrets != nil {
		secrets = *request.Body.Secrets
	}
	item, err := s.printerConnectors.CreateAssignment(
		ctx,
		principal,
		request.PrinterConnectorId,
		printerconnectors.AssignmentInput{
			MachineID:            request.Body.MachineId,
			AdapterKind:          printerconnectors.AdapterKind(request.Body.AdapterKind),
			AdapterSchemaVersion: request.Body.AdapterSchemaVersion,
			Settings:             settings,
			Secrets:              secrets,
			Enabled:              request.Body.Enabled,
		},
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.CreatePrinterConnectorAssignment201JSONResponse(printerConnectorAssignmentDTO(item)), nil
}

func (s *Server) ListPrinterConnectorAssignments(
	ctx context.Context,
	request openapi.ListPrinterConnectorAssignmentsRequestObject,
) (openapi.ListPrinterConnectorAssignmentsResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.printerConnectors.ListAssignments(ctx, principal, request.PrinterConnectorId)
	if err != nil {
		return nil, err
	}
	result := make([]openapi.PrinterConnectorAssignment, 0, len(items))
	for _, item := range items {
		result = append(result, printerConnectorAssignmentDTO(item))
	}
	return openapi.ListPrinterConnectorAssignments200JSONResponse{Items: result}, nil
}

func (s *Server) UpdatePrinterConnectorAssignment(
	ctx context.Context,
	request openapi.UpdatePrinterConnectorAssignmentRequestObject,
) (openapi.UpdatePrinterConnectorAssignmentResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	settings, _ := json.Marshal(request.Body.Settings)
	item, err := s.printerConnectors.UpdateAssignment(
		ctx,
		principal,
		request.PrinterConnectorId,
		request.AssignmentId,
		printerconnectors.AssignmentUpdate{
			AdapterKind: printerconnectors.AdapterKind(request.Body.AdapterKind), AdapterSchemaVersion: request.Body.AdapterSchemaVersion,
			Settings: settings, Secrets: request.Body.Secrets, Enabled: request.Body.Enabled, End: request.Body.End,
			ExpectedVersion: request.Body.ExpectedVersion,
		},
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.UpdatePrinterConnectorAssignment200JSONResponse(printerConnectorAssignmentDTO(item)), nil
}

func (s *Server) ListPrinterObservedRuns(
	ctx context.Context,
	request openapi.ListPrinterObservedRunsRequestObject,
) (openapi.ListPrinterObservedRunsResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.printerConnectors.ListObservedRuns(ctx, principal, request.PrinterConnectorId)
	if err != nil {
		return nil, err
	}
	result := make([]openapi.PrinterObservedRun, 0, len(items))
	for _, item := range items {
		result = append(result, printerObservedRunDTO(item))
	}
	return openapi.ListPrinterObservedRuns200JSONResponse{Items: result}, nil
}

func (s *Server) ListPrinterConnectorEvents(
	ctx context.Context,
	request openapi.ListPrinterConnectorEventsRequestObject,
) (openapi.ListPrinterConnectorEventsResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.printerConnectors.ListEvents(
		ctx,
		principal,
		request.PrinterConnectorId,
		request.Params.IncludeCleared != nil && *request.Params.IncludeCleared,
	)
	if err != nil {
		return nil, err
	}
	result := make([]openapi.PrinterConnectorEvent, 0, len(items))
	for _, item := range items {
		result = append(result, printerConnectorEventDTO(item))
	}
	return openapi.ListPrinterConnectorEvents200JSONResponse{Items: result}, nil
}

func (s *Server) EnrollPrinterConnector(
	ctx context.Context,
	request openapi.EnrollPrinterConnectorRequestObject,
) (openapi.EnrollPrinterConnectorResponseObject, error) {
	if request.Body == nil || request.Body.CredentialSecret == nil {
		return nil, invalidRequest("request body is required")
	}
	secret, err := printerConnectorEnrollmentSecret(ctx)
	if err != nil {
		return nil, err
	}
	result, err := s.printerConnectors.Enroll(
		ctx,
		secret,
		request.Body.CredentialId,
		*request.Body.CredentialSecret,
		request.Body.SoftwareVersion,
		request.Body.ProtocolVersion,
	)
	if err != nil {
		return nil, err
	}
	return openapi.EnrollPrinterConnector200JSONResponse{
		Body: openapi.PrinterConnectorEnrollmentResult{
			ConnectorId:         result.Connector.ID,
			CredentialId:        request.Body.CredentialId,
			ProtocolVersion:     1,
			CredentialExpiresAt: result.CredentialExpiresAt,
		},
		Headers: openapi.EnrollPrinterConnector200ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (s *Server) GetPrinterConnectorConfiguration(
	ctx context.Context,
	_ openapi.GetPrinterConnectorConfigurationRequestObject,
) (openapi.GetPrinterConnectorConfigurationResponseObject, error) {
	connector, err := printerConnectorContext(ctx)
	if err != nil {
		return nil, err
	}
	configuration, err := s.printerConnectors.Configuration(ctx, connector)
	if err != nil {
		return nil, err
	}
	assignments := make([]openapi.PrinterConnectorRuntimeAssignment, 0, len(configuration.Assignments))
	for _, value := range configuration.Assignments {
		settings := map[string]any{}
		_ = json.Unmarshal(value.Settings, &settings)
		secrets := value.Secrets
		assignments = append(
			assignments,
			openapi.PrinterConnectorRuntimeAssignment{
				Id:                   value.ID,
				MachineId:            value.MachineID,
				MachineName:          value.MachineName,
				AdapterKind:          string(value.AdapterKind),
				AdapterSchemaVersion: value.AdapterSchemaVersion,
				ConfigurationVersion: value.ConfigurationVersion,
				Settings:             settings,
				Secrets:              &secrets,
				Enabled:              value.Enabled,
			},
		)
	}
	return openapi.GetPrinterConnectorConfiguration200JSONResponse{
		Body: openapi.PrinterConnectorConfiguration{
			Revision:        configuration.Revision,
			ProtocolVersion: configuration.ProtocolVersion,
			Assignments:     assignments,
			Update:          updateOfferDTO(configuration.Update),
			// Announces run reports, run commands and timelapse uploads to connectors that support them.
			Recordings: nullable.NewNullableWithValue(openapi.PrinterConnectorRecordingFeatures{
				TimelapseEnabled:  configuration.TimelapseEnabled,
				TimelapseMaxBytes: s.runRecordings.TimelapseMaxBytes(),
			}),
		},
		Headers: openapi.GetPrinterConnectorConfiguration200ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (s *Server) ReportPrinterConnectorHeartbeat(
	ctx context.Context,
	request openapi.ReportPrinterConnectorHeartbeatRequestObject,
) (openapi.ReportPrinterConnectorHeartbeatResponseObject, error) {
	connector, err := printerConnectorContext(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	health := make([]printerconnectors.AssignmentHealth, 0, len(request.Body.Assignments))
	for _, value := range request.Body.Assignments {
		health = append(
			health,
			printerconnectors.AssignmentHealth{
				AssignmentID:                value.AssignmentId,
				AppliedConfigurationVersion: value.AppliedConfigurationVersion,
				State:                       printerconnectors.AssignmentState(value.State),
				ErrorCode:                   nullableStringPointer(value.ErrorCode),
			},
		)
	}
	item, err := s.printerConnectors.Heartbeat(
		ctx,
		connector,
		printerconnectors.Heartbeat{
			SoftwareVersion:              request.Body.SoftwareVersion,
			ProtocolVersion:              request.Body.ProtocolVersion,
			AppliedConfigurationRevision: request.Body.AppliedConfigurationRevision,
			HealthState:                  printerconnectors.HealthState(request.Body.HealthState),
			HealthSummary:                nullableStringPointer(request.Body.HealthSummary),
			PendingEventCount:            request.Body.PendingEventCount,
			QuarantinedEventCount:        request.Body.QuarantinedEventCount,
			Assignments:                  health,
			Updater:                      updaterReportFrom(request.Body.Updater),
		},
	)
	if err != nil {
		return nil, err
	}
	return openapi.ReportPrinterConnectorHeartbeat200JSONResponse(printerConnectorDTO(item)), nil
}

func (s *Server) IngestPrinterConnectorEvents(
	ctx context.Context,
	request openapi.IngestPrinterConnectorEventsRequestObject,
) (openapi.IngestPrinterConnectorEventsResponseObject, error) {
	connector, err := printerConnectorContext(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil || request.Body.ProtocolVersion != 1 {
		return nil, invalidRequest("supported protocolVersion is required")
	}
	inputs := make([]printerconnectors.EventInput, 0, len(request.Body.Events))
	for _, value := range request.Body.Events {
		payload, _ := json.Marshal(value.Payload)
		inputs = append(
			inputs,
			printerconnectors.EventInput{
				EventID:              value.EventId,
				AssignmentID:         value.AssignmentId,
				RunID:                nullableUUIDPointer(value.RunId),
				HistoryComplete:      value.HistoryComplete,
				ConfigurationVersion: value.ConfigurationVersion,
				Sequence:             value.Sequence,
				OccurredAt:           value.OccurredAt,
				Kind:                 printing.EventKind(value.Kind),
				ExternalPrintID:      nullableStringPointer(value.ExternalPrintId),
				ReportRevision:       nullableInt64Pointer(value.ReportRevision),
				Payload:              payload,
			},
		)
	}
	receipts, err := s.printerConnectors.IngestEvents(ctx, connector, inputs)
	if err != nil {
		return nil, err
	}
	result := make([]openapi.PrinterConnectorEventReceipt, 0, len(receipts))
	for _, value := range receipts {
		result = append(
			result,
			openapi.PrinterConnectorEventReceipt{
				EventId:      value.EventID,
				CoreEventId:  nullableValue(value.CoreEventID),
				Status:       openapi.PrinterConnectorEventReceiptStatus(value.Status),
				ReasonCode:   nullableString(value.ReasonCode),
				NextSequence: value.NextSequence,
			},
		)
	}
	return openapi.IngestPrinterConnectorEvents200JSONResponse{Receipts: result}, nil
}

func (s *Server) RotatePrinterConnectorCredential(
	ctx context.Context,
	request openapi.RotatePrinterConnectorCredentialRequestObject,
) (openapi.RotatePrinterConnectorCredentialResponseObject, error) {
	connector, err := printerConnectorContext(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil || request.Body.CredentialSecret == nil {
		return nil, invalidRequest("request body is required")
	}
	expires, err := s.printerConnectors.RotateCredential(
		ctx,
		connector,
		request.Body.CredentialId,
		*request.Body.CredentialSecret,
	)
	if err != nil {
		return nil, err
	}
	return openapi.RotatePrinterConnectorCredential200JSONResponse{
		Body: openapi.PrinterConnectorEnrollmentResult{
			ConnectorId:         connector.ID,
			CredentialId:        request.Body.CredentialId,
			ProtocolVersion:     1,
			CredentialExpiresAt: expires,
		},
		Headers: openapi.RotatePrinterConnectorCredential200ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func nullableUUIDPointer(value nullable.Nullable[openapi.UUIDv7]) *openapi.UUIDv7 {
	if !value.IsSpecified() || value.IsNull() {
		return nil
	}
	result := value.GetOrEmpty()
	return &result
}

func nullableInt64Pointer(value nullable.Nullable[int64]) *int64 {
	if !value.IsSpecified() || value.IsNull() {
		return nil
	}
	result := value.GetOrEmpty()
	return &result
}

func (s *Server) ReportPrinterConnectorLiveStatus(
	ctx context.Context,
	request openapi.ReportPrinterConnectorLiveStatusRequestObject,
) (openapi.ReportPrinterConnectorLiveStatusResponseObject, error) {
	connector, err := printerConnectorContext(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	// Re-encoding the typed snapshot drops every field the contract does not
	// name, so unknown connector fields are never stored.
	snapshot, err := json.Marshal(request.Body.Status)
	if err != nil {
		return nil, invalidRequest("live status snapshot is invalid")
	}
	if err = s.printerConnectors.ReportLiveStatus(
		ctx,
		connector,
		printerconnectors.LiveStatusReport{
			AssignmentID:         request.AssignmentId,
			ProtocolVersion:      request.Body.ProtocolVersion,
			ConfigurationVersion: request.Body.ConfigurationVersion,
			ObservedAt:           request.Body.ObservedAt,
			Snapshot:             snapshot,
		},
	); err != nil {
		return nil, err
	}
	return openapi.ReportPrinterConnectorLiveStatus204Response{}, nil
}

func (s *Server) ClearPrinterConnectorEvents(
	ctx context.Context,
	request openapi.ClearPrinterConnectorEventsRequestObject,
) (openapi.ClearPrinterConnectorEventsResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	item, err := s.printerConnectors.ClearEvents(ctx, principal, request.PrinterConnectorId, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.ClearPrinterConnectorEvents200JSONResponse(printerConnectorDTO(item)), nil
}

func printerConnectorActivityDTO(value printerconnectors.Activity) openapi.PrinterConnectorActivity {
	var eventKind *string
	if value.EventKind != nil {
		kind := string(*value.EventKind)
		eventKind = &kind
	}
	fields := value.ChangedFields
	if fields == nil {
		fields = []string{}
	}
	return openapi.PrinterConnectorActivity{
		Id:            value.ID,
		Kind:          openapi.PrinterConnectorActivityKind(value.Kind),
		OccurredAt:    value.OccurredAt,
		MachineId:     nullableUUIDValue(value.MachineID),
		MachineName:   nullableString(value.MachineName),
		ResourceId:    nullableUUIDValue(value.ResourceID),
		ResourceLabel: nullableString(value.ResourceLabel),
		EventKind:     nullableString(eventKind),
		ChangedFields: fields,
	}
}

func (s *Server) ListPrinterConnectorActivity(
	ctx context.Context,
	request openapi.ListPrinterConnectorActivityRequestObject,
) (openapi.ListPrinterConnectorActivityResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	page, err := s.printerConnectors.ListActivity(
		ctx,
		principal,
		request.PrinterConnectorId,
		defaultInt(request.Params.Page, 1),
		defaultInt(request.Params.PageSize, 25),
	)
	if err != nil {
		return nil, err
	}
	items := make([]openapi.PrinterConnectorActivity, 0, len(page.Items))
	for _, item := range page.Items {
		items = append(items, printerConnectorActivityDTO(item))
	}
	return openapi.ListPrinterConnectorActivity200JSONResponse{
		Items:    items,
		Page:     page.Page,
		PageSize: page.PageSize,
		Total:    page.Total,
	}, nil
}

func (s *Server) RequestPrinterConnectorUpdate(
	ctx context.Context,
	request openapi.RequestPrinterConnectorUpdateRequestObject,
) (openapi.RequestPrinterConnectorUpdateResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.printerConnectors.RequestUpdate(
		ctx,
		principal,
		request.PrinterConnectorId,
		request.Body.TargetVersion,
		s.config.Version,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.RequestPrinterConnectorUpdate200JSONResponse(printerConnectorDTO(item)), nil
}
