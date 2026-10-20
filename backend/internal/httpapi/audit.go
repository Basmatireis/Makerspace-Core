package httpapi

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/google/uuid"
)

func (s *Server) ListAuditEvents(
	ctx context.Context,
	request openapi.ListAuditEventsRequestObject,
) (openapi.ListAuditEventsResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	limit := 50
	if request.Params.Limit != nil {
		limit = *request.Params.Limit
	}
	filter := audit.Filter{
		Limit: limit, Action: request.Params.Action, ResourceType: request.Params.ResourceType,
		ResourceID: request.Params.ResourceId, ActorAccountID: request.Params.ActorAccountId,
		OccurredFrom: request.Params.OccurredFrom, OccurredTo: request.Params.OccurredTo,
	}
	if request.Params.ActorType != nil {
		actorType := audit.ActorType(*request.Params.ActorType)
		filter.ActorType = &actorType
	}
	if request.Params.ActorSearch != nil {
		filter.ActorSearch = *request.Params.ActorSearch
	}
	if request.Params.Cursor != nil {
		filter.Cursor = *request.Params.Cursor
	}
	page, err := s.audit.List(ctx, principal, filter)
	if err != nil {
		return nil, err
	}
	return openapi.ListAuditEvents200JSONResponse(auditPageDTO(page)), nil
}

func auditPageDTO(page audit.Page) openapi.AuditEventPage {
	items := make([]openapi.AuditEvent, 0, len(page.Items))
	for _, event := range page.Items {
		response := openapi.AuditEvent{
			Id: event.ID, Action: event.Action, ResourceType: event.ResourceType,
			OccurredAt: event.OccurredAt, ChangedFields: event.ChangedFields,
			Metadata:         event.Metadata,
			ResolvedMetadata: &event.ResolvedMetadata,
			Source:           openapi.AuditEventSource(event.Source),
			ActorType:        openapi.AuditActorType(event.ActorType),
			ActorAccountId: nullablePointer[openapi.UUIDv7](
				event.ActorAccountID,
				func(value uuid.UUID) openapi.UUIDv7 { return value },
			),
			ResourceId: nullablePointer[openapi.UUIDv7](
				event.ResourceID,
				func(value uuid.UUID) openapi.UUIDv7 { return value },
			),
			RequestId: nullablePointer[string](event.RequestID, func(value string) string { return value }),
			ActorDisplayName: nullablePointer[string](
				event.ActorDisplayName,
				func(value string) string { return value },
			),
			ResourceDisplayName: nullablePointer[string](
				event.ResourceDisplayName,
				func(value string) string { return value },
			),
		}
		items = append(items, response)
	}
	return openapi.AuditEventPage{
		Items:      items,
		NextCursor: nullablePointer[string](page.NextCursor, func(value string) string { return value }),
	}
}
