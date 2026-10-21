package httpapi

import (
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/events"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/google/uuid"
)

func (s *Server) ListEventSessions(
	ctx context.Context,
	r openapi.ListEventSessionsRequestObject,
) (openapi.ListEventSessionsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.events.ListSessions(ctx, p, r.EventId)
	if err != nil {
		return nil, err
	}
	result := make([]openapi.EventSession, 0, len(items))
	for _, item := range items {
		result = append(result, eventSessionDTO(item))
	}
	return openapi.ListEventSessions200JSONResponse{Items: result}, nil
}

func (s *Server) CreateEventSession(
	ctx context.Context,
	r openapi.CreateEventSessionRequestObject,
) (openapi.CreateEventSessionResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.events.CreateSession(ctx, p, r.EventId, eventSessionInput(*r.Body, 0), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateEventSession201JSONResponse(eventSessionDTO(item)), nil
}

func (s *Server) UpdateEventSession(
	ctx context.Context,
	r openapi.UpdateEventSessionRequestObject,
) (openapi.UpdateEventSessionResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input := events.SessionInput{
		Name:            nullableStringPointer(r.Body.Name),
		Location:        nullableStringPointer(r.Body.Location),
		Description:     nullableStringPointer(r.Body.Description),
		StartsAt:        r.Body.StartsAt,
		EndsAt:          r.Body.EndsAt,
		IsPublic:        r.Body.IsPublic,
		Status:          events.SessionStatus(r.Body.Status),
		ExpectedVersion: r.Body.ExpectedVersion,
	}
	item, err := s.events.UpdateSession(ctx, p, r.EventId, r.EventSessionId, input, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateEventSession200JSONResponse(eventSessionDTO(item)), nil
}

func (s *Server) DeleteEventSession(
	ctx context.Context,
	r openapi.DeleteEventSessionRequestObject,
) (openapi.DeleteEventSessionResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err = s.events.DeleteSession(
		ctx,
		p,
		r.EventId,
		r.EventSessionId,
		r.Body.ExpectedVersion,
		requestIDPointer(ctx),
	); err != nil {
		return nil, err
	}
	return openapi.DeleteEventSession204Response{}, nil
}

func (s *Server) ListEventTaskLists(
	ctx context.Context,
	r openapi.ListEventTaskListsRequestObject,
) (openapi.ListEventTaskListsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.events.ListTaskLists(ctx, p, r.EventId)
	if err != nil {
		return nil, err
	}
	result := make([]openapi.EventTaskList, 0, len(items))
	for _, item := range items {
		result = append(result, eventTaskListDTO(item))
	}
	return openapi.ListEventTaskLists200JSONResponse{Items: result}, nil
}

func (s *Server) CreateEventTaskList(
	ctx context.Context,
	r openapi.CreateEventTaskListRequestObject,
) (openapi.CreateEventTaskListResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.events.CreateTaskList(
		ctx,
		p,
		r.EventId,
		events.TaskListInput{
			Name:        r.Body.Name,
			Description: nullableStringPointer(r.Body.Description),
			SortOrder:   int(r.Body.SortOrder),
		},
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.CreateEventTaskList201JSONResponse(eventTaskListDTO(item)), nil
}

func (s *Server) UpdateEventTaskList(
	ctx context.Context,
	r openapi.UpdateEventTaskListRequestObject,
) (openapi.UpdateEventTaskListResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.events.UpdateTaskList(
		ctx,
		p,
		r.EventId,
		r.EventTaskListId,
		events.TaskListInput{
			Name:            r.Body.Name,
			Description:     nullableStringPointer(r.Body.Description),
			SortOrder:       int(r.Body.SortOrder),
			ExpectedVersion: r.Body.ExpectedVersion,
		},
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateEventTaskList200JSONResponse(eventTaskListDTO(item)), nil
}

func (s *Server) DeleteEventTaskList(
	ctx context.Context,
	r openapi.DeleteEventTaskListRequestObject,
) (openapi.DeleteEventTaskListResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err = s.events.DeleteTaskList(
		ctx,
		p,
		r.EventId,
		r.EventTaskListId,
		r.Body.ExpectedVersion,
		requestIDPointer(ctx),
	); err != nil {
		return nil, err
	}
	return openapi.DeleteEventTaskList204Response{}, nil
}

func (s *Server) ListEventTasks(
	ctx context.Context,
	r openapi.ListEventTasksRequestObject,
) (openapi.ListEventTasksResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	filter := events.TaskFilter{IncludeDone: true}
	if r.Params.Mine != nil {
		filter.Mine = *r.Params.Mine
	}
	if r.Params.Overdue != nil {
		filter.Overdue = *r.Params.Overdue
	}
	if r.Params.IncludeDone != nil {
		filter.IncludeDone = *r.Params.IncludeDone
	}
	items, err := s.events.ListTasks(ctx, p, r.EventId, filter)
	if err != nil {
		return nil, err
	}
	result := make([]openapi.EventTask, 0, len(items))
	for _, item := range items {
		result = append(result, eventTaskDTO(item))
	}
	return openapi.ListEventTasks200JSONResponse{Items: result}, nil
}

func (s *Server) CreateEventTask(
	ctx context.Context,
	r openapi.CreateEventTaskRequestObject,
) (openapi.CreateEventTaskResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.events.CreateTask(ctx, p, r.EventId, eventTaskInput(*r.Body, 0), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateEventTask201JSONResponse(eventTaskDTO(item)), nil
}

func (s *Server) UpdateEventTask(
	ctx context.Context,
	r openapi.UpdateEventTaskRequestObject,
) (openapi.UpdateEventTaskResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input := events.TaskInput{
		TaskListID:       nullableUUID(r.Body.TaskListId),
		Title:            r.Body.Title,
		Description:      nullableStringPointer(r.Body.Description),
		Status:           events.TaskStatus(r.Body.Status),
		Important:        r.Body.Important,
		AssigneePersonID: nullableUUID(r.Body.AssigneePersonId),
		DueAt:            nullableTime(r.Body.DueAt),
		SortOrder:        int(r.Body.SortOrder),
		ExpectedVersion:  r.Body.ExpectedVersion,
	}
	item, err := s.events.UpdateTask(ctx, p, r.EventId, r.EventTaskId, input, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateEventTask200JSONResponse(eventTaskDTO(item)), nil
}

func (s *Server) DeleteEventTask(
	ctx context.Context,
	r openapi.DeleteEventTaskRequestObject,
) (openapi.DeleteEventTaskResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err = s.events.DeleteTask(
		ctx,
		p,
		r.EventId,
		r.EventTaskId,
		r.Body.ExpectedVersion,
		requestIDPointer(ctx),
	); err != nil {
		return nil, err
	}
	return openapi.DeleteEventTask204Response{}, nil
}

func eventSessionInput(v openapi.EventSessionInput, version int64) events.SessionInput {
	return events.SessionInput{
		Name:            nullableStringPointer(v.Name),
		Location:        nullableStringPointer(v.Location),
		Description:     nullableStringPointer(v.Description),
		StartsAt:        v.StartsAt,
		EndsAt:          v.EndsAt,
		IsPublic:        v.IsPublic,
		Status:          events.SessionStatus(v.Status),
		ExpectedVersion: version,
	}
}
func eventSessionDTO(v events.Session) openapi.EventSession {
	return openapi.EventSession{
		Id:          v.ID,
		EventId:     v.EventID,
		Name:        nullablePointer[string](v.Name, func(x string) string { return x }),
		Location:    nullablePointer[string](v.Location, func(x string) string { return x }),
		Description: nullablePointer[string](v.Description, func(x string) string { return x }),
		StartsAt:    v.StartsAt,
		EndsAt:      v.EndsAt,
		IsPublic:    v.IsPublic,
		Status:      openapi.EventSessionStatus(v.Status),
		Version:     v.Version,
		CreatedAt:   v.CreatedAt,
		UpdatedAt:   v.UpdatedAt,
	}
}
func eventTaskListDTO(v events.TaskList) openapi.EventTaskList {
	return openapi.EventTaskList{
		Id:          v.ID,
		EventId:     v.EventID,
		Name:        v.Name,
		Description: nullablePointer[string](v.Description, func(x string) string { return x }),
		SortOrder:   int32(v.SortOrder),
		Version:     v.Version,
		CreatedAt:   v.CreatedAt,
		UpdatedAt:   v.UpdatedAt,
	}
}
func eventTaskInput(v openapi.EventTaskInput, version int64) events.TaskInput {
	return events.TaskInput{
		TaskListID:       nullableUUID(v.TaskListId),
		Title:            v.Title,
		Description:      nullableStringPointer(v.Description),
		Status:           events.TaskStatus(v.Status),
		Important:        v.Important,
		AssigneePersonID: nullableUUID(v.AssigneePersonId),
		DueAt:            nullableTime(v.DueAt),
		SortOrder:        int(v.SortOrder),
		ExpectedVersion:  version,
	}
}
func eventTaskDTO(v events.Task) openapi.EventTask {
	return openapi.EventTask{
		Id:      v.ID,
		EventId: v.EventID,
		TaskListId: nullablePointer[openapi.UUIDv7](
			v.TaskListID,
			func(x uuid.UUID) openapi.UUIDv7 { return x },
		),
		Title:       v.Title,
		Description: nullablePointer[string](v.Description, func(x string) string { return x }),
		Status:      openapi.EventTaskStatus(v.Status),
		Important:   v.Important,
		AssigneePersonId: nullablePointer[openapi.UUIDv7](
			v.AssigneePersonID,
			func(x uuid.UUID) openapi.UUIDv7 { return x },
		),
		DueAt:       nullablePointer(v.DueAt, func(x time.Time) time.Time { return x }),
		CompletedAt: nullablePointer(v.CompletedAt, func(x time.Time) time.Time { return x }),
		CompletedByAccountId: nullablePointer[openapi.UUIDv7](
			v.CompletedByAccount,
			func(x uuid.UUID) openapi.UUIDv7 { return x },
		),
		SortOrder: int32(v.SortOrder),
		Version:   v.Version,
		CreatedAt: v.CreatedAt,
		UpdatedAt: v.UpdatedAt,
	}
}
