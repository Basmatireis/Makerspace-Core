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
	r openapi.ListEventsRequestObject,
) (openapi.ListEventsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	query := events.ListQuery{OwnerPersonID: r.Params.OwnerPersonId}
	if r.Params.Scope != nil {
		query.Scope = events.ListScope(*r.Params.Scope)
	}
	if r.Params.Search != nil {
		query.Search = *r.Params.Search
	}
	if r.Params.Page != nil {
		query.Page = *r.Params.Page
	}
	if r.Params.PageSize != nil {
		query.PageSize = *r.Params.PageSize
	}
	page, err := s.events.List(ctx, p, query)
	if err != nil {
		return nil, err
	}
	result := make([]openapi.Event, 0, len(page.Items))
	for _, item := range page.Items {
		result = append(result, eventDTO(item))
	}
	return openapi.ListEvents200JSONResponse{
		Items:    result,
		Page:     page.Page,
		PageSize: page.PageSize,
		Total:    page.Total,
	}, nil
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
		OwnerName:            nullablePointer[string](item.OwnerName, func(v string) string { return v }),
		Status:               openapi.EventStatus(item.Status),
		PublicTitle:          nullablePointer[string](item.PublicTitle, func(v string) string { return v }),
		PublicDescription:    nullablePointer[string](item.PublicDescription, func(v string) string { return v }),
		PublicLocation:       nullablePointer[string](item.PublicLocation, func(v string) string { return v }),
		PublicId:             item.PublicID,
		IsPublic:             item.IsPublic,
		PublicSignupEnabled:  item.PublicSignupEnabled,
		HasBanner:            item.HasBanner,
		ClosedAt:             nullablePointer(item.ClosedAt, func(v time.Time) time.Time { return v }),
		RangeStartsAt:        nullablePointer(item.RangeStartsAt, func(v time.Time) time.Time { return v }),
		RangeEndsAt:          nullablePointer(item.RangeEndsAt, func(v time.Time) time.Time { return v }),
		TaskTotal:            item.TaskTotal,
		TaskCompleted:        item.TaskCompleted,
		TasksOverdue:         item.TasksOverdue,
		FilledCount:          item.FilledCount,
		RequiredCount:        item.RequiredCount,
		HasAssignmentHistory: item.HasAssignmentHistory,
		OpenPlaces:           item.OpenPlaces,
		MyShifts:             eventMyAssignmentDTOs(item.MyShifts),
		GoLive:               eventGoLiveDTO(item.GoLive),
		NextDeadline:         nullablePointer(item.NextDeadline, func(v time.Time) time.Time { return v }),
		NextScheduleAt:       nullablePointer(item.NextScheduleAt, func(v time.Time) time.Time { return v }),
		Version:              item.Version,
		CreatedAt:            item.CreatedAt,
		UpdatedAt:            item.UpdatedAt,
	}
}

func eventGoLiveDTO(v events.GoLive) openapi.EventGoLive {
	codes := func(values []events.ReadinessCode) []openapi.EventReadinessCode {
		result := make([]openapi.EventReadinessCode, 0, len(values))
		for _, value := range values {
			result = append(result, openapi.EventReadinessCode(value))
		}
		return result
	}
	result := openapi.EventGoLive{ConfirmUnmet: codes(v.ConfirmUnmet)}
	result.PublicPage.State = openapi.EventGoLivePublicPageState(v.PublicPageState)
	result.PublicPage.Unmet = codes(v.PublicPageUnmet)
	result.HelperSignup.State = openapi.EventGoLiveHelperSignupState(v.HelperSignupState)
	result.HelperSignup.OpensAt = nullablePointer(v.HelperSignupOpens, func(x time.Time) time.Time { return x })
	result.HelperSignup.Unmet = codes(v.HelperSignupUnmet)
	result.Shifts.Accepting = v.ShiftsAccepting
	result.Shifts.Total = v.ShiftsTotal
	result.Shifts.NotPublic = v.ShiftsNotPublic
	return result
}
