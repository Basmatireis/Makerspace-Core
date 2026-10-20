package httpapi

import (
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/events"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/google/uuid"
)

func (s *Server) ListEvents(
	ctx context.Context,
	_ openapi.ListEventsRequestObject,
) (openapi.ListEventsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.events.List(ctx, p)
	if err != nil {
		return nil, err
	}
	result := make([]openapi.Event, 0, len(items))
	for _, item := range items {
		result = append(result, eventDTO(item))
	}
	return openapi.ListEvents200JSONResponse{Items: result}, nil
}

func (s *Server) CreateEvent(
	ctx context.Context,
	r openapi.CreateEventRequestObject,
) (openapi.CreateEventResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.events.Create(
		ctx,
		p,
		events.EventInput{
			Name:                r.Body.Name,
			InternalDescription: nullableStringPointer(r.Body.InternalDescription),
			Location:            nullableStringPointer(r.Body.Location),
			OwnerPersonID:       nullableUUID(r.Body.OwnerPersonId),
		},
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.CreateEvent201JSONResponse(eventDTO(item)), nil
}

func (s *Server) GetEvent(
	ctx context.Context,
	r openapi.GetEventRequestObject,
) (openapi.GetEventResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	item, err := s.events.Get(ctx, p, r.EventId)
	if err != nil {
		return nil, err
	}
	return openapi.GetEvent200JSONResponse(eventDTO(item)), nil
}

func (s *Server) UpdateEvent(
	ctx context.Context,
	r openapi.UpdateEventRequestObject,
) (openapi.UpdateEventResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.events.Update(
		ctx,
		p,
		r.EventId,
		events.EventInput{
			Name:                r.Body.Name,
			InternalDescription: nullableStringPointer(r.Body.InternalDescription),
			Location:            nullableStringPointer(r.Body.Location),
			OwnerPersonID:       nullableUUID(r.Body.OwnerPersonId),
			PublicTitle:         nullableStringPointer(r.Body.PublicTitle),
			PublicDescription:   nullableStringPointer(r.Body.PublicDescription),
			PublicLocation:      nullableStringPointer(r.Body.PublicLocation),
			PublicSignupEnabled: r.Body.PublicSignupEnabled,
			ExpectedVersion:     r.Body.ExpectedVersion,
		},
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateEvent200JSONResponse(eventDTO(item)), nil
}

func (s *Server) DeleteEvent(
	ctx context.Context,
	r openapi.DeleteEventRequestObject,
) (openapi.DeleteEventResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	fileIDs, err := s.events.Delete(ctx, p, r.EventId, r.Body.ExpectedVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	for _, id := range fileIDs {
		if err = s.files.DeleteSystem(ctx, id, requestIDPointer(ctx)); err != nil {
			return nil, err
		}
	}
	return openapi.DeleteEvent204Response{}, nil
}

func (s *Server) StartEventPlanning(
	ctx context.Context,
	r openapi.StartEventPlanningRequestObject,
) (openapi.StartEventPlanningResponseObject, error) {
	p, b, err := eventActionInput(ctx, r.Body)
	if err != nil {
		return nil, err
	}
	item, err := s.events.Transition(ctx, p, r.EventId, b.ExpectedVersion, events.EventStatusPlanning, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.StartEventPlanning200JSONResponse(eventDTO(item)), nil
}

func (s *Server) ReturnEventToDraft(
	ctx context.Context,
	r openapi.ReturnEventToDraftRequestObject,
) (openapi.ReturnEventToDraftResponseObject, error) {
	p, b, err := eventActionInput(ctx, r.Body)
	if err != nil {
		return nil, err
	}
	item, err := s.events.Transition(ctx, p, r.EventId, b.ExpectedVersion, events.EventStatusDraft, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.ReturnEventToDraft200JSONResponse(eventDTO(item)), nil
}

func (s *Server) ConfirmEvent(
	ctx context.Context,
	r openapi.ConfirmEventRequestObject,
) (openapi.ConfirmEventResponseObject, error) {
	p, b, err := eventActionInput(ctx, r.Body)
	if err != nil {
		return nil, err
	}
	item, err := s.events.Transition(ctx, p, r.EventId, b.ExpectedVersion, events.EventStatusConfirmed, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.ConfirmEvent200JSONResponse(eventDTO(item)), nil
}

func (s *Server) ReturnEventToPlanning(
	ctx context.Context,
	r openapi.ReturnEventToPlanningRequestObject,
) (openapi.ReturnEventToPlanningResponseObject, error) {
	p, b, err := eventActionInput(ctx, r.Body)
	if err != nil {
		return nil, err
	}
	item, err := s.events.Transition(ctx, p, r.EventId, b.ExpectedVersion, events.EventStatusPlanning, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.ReturnEventToPlanning200JSONResponse(eventDTO(item)), nil
}

func (s *Server) CompleteEvent(
	ctx context.Context,
	r openapi.CompleteEventRequestObject,
) (openapi.CompleteEventResponseObject, error) {
	p, b, err := eventActionInput(ctx, r.Body)
	if err != nil {
		return nil, err
	}
	item, err := s.events.Transition(ctx, p, r.EventId, b.ExpectedVersion, events.EventStatusCompleted, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CompleteEvent200JSONResponse(eventDTO(item)), nil
}

func (s *Server) CancelEvent(
	ctx context.Context,
	r openapi.CancelEventRequestObject,
) (openapi.CancelEventResponseObject, error) {
	p, b, err := eventActionInput(ctx, r.Body)
	if err != nil {
		return nil, err
	}
	item, err := s.events.Transition(ctx, p, r.EventId, b.ExpectedVersion, events.EventStatusCancelled, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CancelEvent200JSONResponse(eventDTO(item)), nil
}

func (s *Server) ArchiveEvent(
	ctx context.Context,
	r openapi.ArchiveEventRequestObject,
) (openapi.ArchiveEventResponseObject, error) {
	p, b, err := eventActionInput(ctx, r.Body)
	if err != nil {
		return nil, err
	}
	item, err := s.events.Transition(ctx, p, r.EventId, b.ExpectedVersion, events.EventStatusArchived, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.ArchiveEvent200JSONResponse(eventDTO(item)), nil
}

func (s *Server) PublishEvent(
	ctx context.Context,
	r openapi.PublishEventRequestObject,
) (openapi.PublishEventResponseObject, error) {
	p, b, err := eventActionInput(ctx, r.Body)
	if err != nil {
		return nil, err
	}
	item, err := s.events.SetPublished(ctx, p, r.EventId, b.ExpectedVersion, true, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.PublishEvent200JSONResponse(eventDTO(item)), nil
}

func (s *Server) UnpublishEvent(
	ctx context.Context,
	r openapi.UnpublishEventRequestObject,
) (openapi.UnpublishEventResponseObject, error) {
	p, b, err := eventActionInput(ctx, r.Body)
	if err != nil {
		return nil, err
	}
	item, err := s.events.SetPublished(ctx, p, r.EventId, b.ExpectedVersion, false, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UnpublishEvent200JSONResponse(eventDTO(item)), nil
}

func (s *Server) RotateEventPublicId(
	ctx context.Context,
	r openapi.RotateEventPublicIdRequestObject,
) (openapi.RotateEventPublicIdResponseObject, error) {
	p, b, err := eventActionInput(ctx, r.Body)
	if err != nil {
		return nil, err
	}
	item, err := s.events.RotatePublicID(ctx, p, r.EventId, b.ExpectedVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.RotateEventPublicId200JSONResponse(eventDTO(item)), nil
}

func eventActionInput(
	ctx context.Context,
	body *openapi.VersionRequest,
) (authorization.Principal, openapi.VersionRequest, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return authorization.Principal{}, openapi.VersionRequest{}, err
	}
	if body == nil {
		return authorization.Principal{}, openapi.VersionRequest{}, invalidRequest("request body is required")
	}
	return p, *body, nil
}

func eventDTO(item events.Event) openapi.Event {
	return openapi.Event{
		Id:                  item.ID,
		Name:                item.Name,
		InternalDescription: nullablePointer[string](item.InternalDescription, func(v string) string { return v }),
		Location:            nullablePointer[string](item.Location, func(v string) string { return v }),
		OwnerPersonId: nullablePointer[openapi.UUIDv7](
			item.OwnerPersonID,
			func(v uuid.UUID) openapi.UUIDv7 { return v },
		),
		OwnerName:           nullablePointer[string](item.OwnerName, func(v string) string { return v }),
		Status:              openapi.EventStatus(item.Status),
		PublicTitle:         nullablePointer[string](item.PublicTitle, func(v string) string { return v }),
		PublicDescription:   nullablePointer[string](item.PublicDescription, func(v string) string { return v }),
		PublicLocation:      nullablePointer[string](item.PublicLocation, func(v string) string { return v }),
		PublicId:            item.PublicID,
		IsPublic:            item.IsPublic,
		PublicSignupEnabled: item.PublicSignupEnabled,
		HasBanner:           item.HasBanner,
		ClosedAt:            nullablePointer(item.ClosedAt, func(v time.Time) time.Time { return v }),
		RangeStartsAt:       nullablePointer(item.RangeStartsAt, func(v time.Time) time.Time { return v }),
		RangeEndsAt:         nullablePointer(item.RangeEndsAt, func(v time.Time) time.Time { return v }),
		TaskTotal:           item.TaskTotal,
		TaskCompleted:       item.TaskCompleted,
		FilledCount:         item.FilledCount,
		RequiredCount:       item.RequiredCount,
		NextDeadline:        nullablePointer(item.NextDeadline, func(v time.Time) time.Time { return v }),
		NextScheduleAt:      nullablePointer(item.NextScheduleAt, func(v time.Time) time.Time { return v }),
		Version:             item.Version,
		CreatedAt:           item.CreatedAt,
		UpdatedAt:           item.UpdatedAt,
	}
}
