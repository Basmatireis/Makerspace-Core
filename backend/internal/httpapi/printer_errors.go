package httpapi

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printerconnectors"
	"github.com/oapi-codegen/nullable"
)

func printerErrorSeverity(value *string) nullable.Nullable[openapi.PrinterErrorSeverity] {
	if value == nil {
		return nullable.NewNullNullable[openapi.PrinterErrorSeverity]()
	}
	return nullable.NewNullableWithValue(openapi.PrinterErrorSeverity(*value))
}

func printerErrorDTO(item printerconnectors.PrinterError) openapi.PrinterErrorOccurrence {
	return openapi.PrinterErrorOccurrence{
		Id:              item.ID,
		SourceFamily:    openapi.PrinterErrorOccurrenceSourceFamily(item.SourceFamily),
		Code:            item.Code,
		Severity:        printerErrorSeverity(item.Severity),
		Title:           nullableString(item.Title),
		Description:     nullableString(item.Description),
		Link:            nullableString(item.Link),
		FirstObservedAt: item.FirstObservedAt,
		LastObservedAt:  item.LastObservedAt,
		ResolvedAt:      nullableTimeValue(item.ResolvedAt),
		RunId:           nullableUUIDValue(item.RunID),
	}
}

func printerErrorCodeDTO(item printerconnectors.ErrorCode) openapi.PrinterErrorCode {
	return openapi.PrinterErrorCode{
		Id:           item.ID,
		SourceFamily: openapi.PrinterErrorCodeSourceFamily(item.SourceFamily),
		Code:         item.Code,
		Title:        item.Title,
		Description:  item.Description,
		Link:         nullableString(item.Link),
		Source:       openapi.PrinterErrorCodeSource(item.Source),
		UpdatedAt:    item.UpdatedAt,
	}
}

func printerErrorCodeSyncDTO(status printerconnectors.ErrorCodeSyncStatus) openapi.PrinterErrorCodeSync {
	return openapi.PrinterErrorCodeSync{
		Enabled:       status.Enabled,
		LastAttemptAt: nullableTimeValue(status.LastAttemptAt),
		LastSuccessAt: nullableTimeValue(status.LastSuccessAt),
		LastError:     nullableString(status.LastError),
		ImportedCount: status.ImportedCount,
	}
}

func (s *Server) SyncPrinterErrorCodes(
	ctx context.Context,
	_ openapi.SyncPrinterErrorCodesRequestObject,
) (openapi.SyncPrinterErrorCodesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.printerConnectors.SyncErrorCodesNow(ctx, p, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	status, err := s.printerConnectors.ErrorCodeSyncStatus(ctx)
	if err != nil {
		return nil, err
	}
	return openapi.SyncPrinterErrorCodes200JSONResponse(printerErrorCodeSyncDTO(status)), nil
}

func printerNotificationSettingsDTO(item printerconnectors.NotificationSettings) openapi.PrinterNotificationSettings {
	events := make([]openapi.PrinterNotificationRule, 0, len(item.Events))
	for _, rule := range item.Events {
		events = append(events, openapi.PrinterNotificationRule{
			Event:           openapi.PrinterNotificationEvent(rule.Event),
			NotifyOperator:  rule.NotifyOperator,
			NotifyRecipient: rule.NotifyRecipient,
			RoleId:          nullableUUIDValue(rule.RoleID),
			RoleName:        nullableString(rule.RoleName),
			Email:           rule.Email,
			MinSeverity:     nullableEnum[openapi.PrinterErrorSeverity](rule.MinSeverity),
		})
	}
	return openapi.PrinterNotificationSettings{Events: events, Version: item.Version, UpdatedAt: item.UpdatedAt}
}

func (s *Server) ListPrinterErrors(
	ctx context.Context,
	r openapi.ListPrinterErrorsRequestObject,
) (openapi.ListPrinterErrorsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.printerConnectors.ListPrinterErrors(ctx, p, r.MachineId)
	if err != nil {
		return nil, err
	}
	result := make([]openapi.PrinterErrorOccurrence, 0, len(items))
	for _, item := range items {
		result = append(result, printerErrorDTO(item))
	}
	return openapi.ListPrinterErrors200JSONResponse{Items: result}, nil
}

func (s *Server) ClearPrinterErrors(
	ctx context.Context,
	r openapi.ClearPrinterErrorsRequestObject,
) (openapi.ClearPrinterErrorsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.printerConnectors.ClearPrinterErrors(ctx, p, r.MachineId, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.ClearPrinterErrors204Response{}, nil
}

func (s *Server) ListPrinterErrorCodes(
	ctx context.Context,
	r openapi.ListPrinterErrorCodesRequestObject,
) (openapi.ListPrinterErrorCodesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	page, pageSize := defaultInt(r.Params.Page, 1), defaultInt(r.Params.PageSize, 25)
	items, total, err := s.printerConnectors.ListErrorCodes(ctx, p, printerconnectors.ErrorCodeFilter{
		Search:       defaultString(r.Params.Search),
		SourceFamily: defaultString(stringEnum(r.Params.SourceFamily)),
		Source:       defaultString(stringEnum(r.Params.Source)),
	}, page, pageSize)
	if err != nil {
		return nil, err
	}
	status, err := s.printerConnectors.ErrorCodeSyncStatus(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]openapi.PrinterErrorCode, 0, len(items))
	for _, item := range items {
		result = append(result, printerErrorCodeDTO(item))
	}
	return openapi.ListPrinterErrorCodes200JSONResponse{
		Items:    result,
		Page:     page,
		PageSize: pageSize,
		Total:    total,
		Sync:     printerErrorCodeSyncDTO(status),
	}, nil
}

func (s *Server) PutPrinterErrorCode(
	ctx context.Context,
	r openapi.PutPrinterErrorCodeRequestObject,
) (openapi.PutPrinterErrorCodeResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.printerConnectors.PutErrorCode(ctx, p, r.SourceFamily, r.Code, printerconnectors.ErrorCodeInput{
		Title: r.Body.Title, Description: r.Body.Description, Link: nullableStringLike(r.Body.Link),
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.PutPrinterErrorCode200JSONResponse(printerErrorCodeDTO(item)), nil
}

func (s *Server) DeletePrinterErrorCode(
	ctx context.Context,
	r openapi.DeletePrinterErrorCodeRequestObject,
) (openapi.DeletePrinterErrorCodeResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.printerConnectors.DeleteErrorCode(ctx, p, r.SourceFamily, r.Code, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.DeletePrinterErrorCode204Response{}, nil
}

func (s *Server) GetPrinterNotificationSettings(
	ctx context.Context,
	_ openapi.GetPrinterNotificationSettingsRequestObject,
) (openapi.GetPrinterNotificationSettingsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	item, err := s.printerConnectors.NotificationSettings(ctx, p)
	if err != nil {
		return nil, err
	}
	return openapi.GetPrinterNotificationSettings200JSONResponse(printerNotificationSettingsDTO(item)), nil
}

func (s *Server) UpdatePrinterNotificationSettings(
	ctx context.Context,
	r openapi.UpdatePrinterNotificationSettingsRequestObject,
) (openapi.UpdatePrinterNotificationSettingsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	rules := make([]printerconnectors.NotificationRule, 0, len(r.Body.Events))
	for _, rule := range r.Body.Events {
		rules = append(rules, printerconnectors.NotificationRule{
			Event:           printerconnectors.NotificationEvent(rule.Event),
			NotifyOperator:  rule.NotifyOperator,
			NotifyRecipient: rule.NotifyRecipient,
			RoleID:          nullableUUID(rule.RoleId),
			Email:           rule.Email,
			MinSeverity:     nullableStringPointer(rule.MinSeverity),
		})
	}
	item, err := s.printerConnectors.UpdateNotificationSettings(ctx, p, printerconnectors.NotificationSettingsInput{
		Events:          rules,
		ExpectedVersion: r.Body.ExpectedVersion,
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdatePrinterNotificationSettings200JSONResponse(printerNotificationSettingsDTO(item)), nil
}

// describeLiveErrors adds the level, the catalog's meaning and a link to the errors of a live status snapshot.
func (s *Server) describeLiveErrors(ctx context.Context, snapshot *openapi.PrinterLiveStatusSnapshot) error {
	if len(snapshot.Errors) == 0 {
		return nil
	}
	items := make([][2]string, 0, len(snapshot.Errors))
	for _, item := range snapshot.Errors {
		items = append(items, [2]string{string(item.SourceFamily), item.Code})
	}
	facts, err := s.printerConnectors.ErrorFacts(ctx, items)
	if err != nil {
		return err
	}
	for i := range snapshot.Errors {
		item := &snapshot.Errors[i]
		fact := facts[string(item.SourceFamily)+":"+item.Code]
		item.Severity = printerErrorSeverity(fact.Severity)
		item.Title = nullableString(fact.Title)
		item.Link = nullableString(fact.Link)
	}
	return nil
}
