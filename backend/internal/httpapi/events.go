package httpapi

import (
	"context"
	"io"
	"mime"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/events"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

func (s *Server) ListEvents(ctx context.Context, _ openapi.ListEventsRequestObject) (openapi.ListEventsResponseObject, error) {
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
func (s *Server) CreateEvent(ctx context.Context, r openapi.CreateEventRequestObject) (openapi.CreateEventResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.events.Create(ctx, p, events.EventInput{Name: r.Body.Name, InternalDescription: nullableStringPointer(r.Body.InternalDescription), Location: nullableStringPointer(r.Body.Location), OwnerPersonID: nullableUUID(r.Body.OwnerPersonId)}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateEvent201JSONResponse(eventDTO(item)), nil
}
func (s *Server) GetEvent(ctx context.Context, r openapi.GetEventRequestObject) (openapi.GetEventResponseObject, error) {
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
func (s *Server) UpdateEvent(ctx context.Context, r openapi.UpdateEventRequestObject) (openapi.UpdateEventResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.events.Update(ctx, p, r.EventId, events.EventInput{Name: r.Body.Name, InternalDescription: nullableStringPointer(r.Body.InternalDescription), Location: nullableStringPointer(r.Body.Location), OwnerPersonID: nullableUUID(r.Body.OwnerPersonId), PublicTitle: nullableStringPointer(r.Body.PublicTitle), PublicDescription: nullableStringPointer(r.Body.PublicDescription), PublicLocation: nullableStringPointer(r.Body.PublicLocation), PublicSignupEnabled: r.Body.PublicSignupEnabled, ExpectedVersion: r.Body.ExpectedVersion}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateEvent200JSONResponse(eventDTO(item)), nil
}
func (s *Server) DeleteEvent(ctx context.Context, r openapi.DeleteEventRequestObject) (openapi.DeleteEventResponseObject, error) {
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

func (s *Server) StartEventPlanning(ctx context.Context, r openapi.StartEventPlanningRequestObject) (openapi.StartEventPlanningResponseObject, error) {
	p, b, err := eventActionInput(ctx, r.Body)
	if err != nil {
		return nil, err
	}
	item, err := s.events.Transition(ctx, p, r.EventId, b.ExpectedVersion, "planning", requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.StartEventPlanning200JSONResponse(eventDTO(item)), nil
}
func (s *Server) ReturnEventToDraft(ctx context.Context, r openapi.ReturnEventToDraftRequestObject) (openapi.ReturnEventToDraftResponseObject, error) {
	p, b, err := eventActionInput(ctx, r.Body)
	if err != nil {
		return nil, err
	}
	item, err := s.events.Transition(ctx, p, r.EventId, b.ExpectedVersion, "draft", requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.ReturnEventToDraft200JSONResponse(eventDTO(item)), nil
}
func (s *Server) ConfirmEvent(ctx context.Context, r openapi.ConfirmEventRequestObject) (openapi.ConfirmEventResponseObject, error) {
	p, b, err := eventActionInput(ctx, r.Body)
	if err != nil {
		return nil, err
	}
	item, err := s.events.Transition(ctx, p, r.EventId, b.ExpectedVersion, "confirmed", requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.ConfirmEvent200JSONResponse(eventDTO(item)), nil
}
func (s *Server) ReturnEventToPlanning(ctx context.Context, r openapi.ReturnEventToPlanningRequestObject) (openapi.ReturnEventToPlanningResponseObject, error) {
	p, b, err := eventActionInput(ctx, r.Body)
	if err != nil {
		return nil, err
	}
	item, err := s.events.Transition(ctx, p, r.EventId, b.ExpectedVersion, "planning", requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.ReturnEventToPlanning200JSONResponse(eventDTO(item)), nil
}
func (s *Server) CompleteEvent(ctx context.Context, r openapi.CompleteEventRequestObject) (openapi.CompleteEventResponseObject, error) {
	p, b, err := eventActionInput(ctx, r.Body)
	if err != nil {
		return nil, err
	}
	item, err := s.events.Transition(ctx, p, r.EventId, b.ExpectedVersion, "completed", requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CompleteEvent200JSONResponse(eventDTO(item)), nil
}
func (s *Server) CancelEvent(ctx context.Context, r openapi.CancelEventRequestObject) (openapi.CancelEventResponseObject, error) {
	p, b, err := eventActionInput(ctx, r.Body)
	if err != nil {
		return nil, err
	}
	item, err := s.events.Transition(ctx, p, r.EventId, b.ExpectedVersion, "cancelled", requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CancelEvent200JSONResponse(eventDTO(item)), nil
}
func (s *Server) ArchiveEvent(ctx context.Context, r openapi.ArchiveEventRequestObject) (openapi.ArchiveEventResponseObject, error) {
	p, b, err := eventActionInput(ctx, r.Body)
	if err != nil {
		return nil, err
	}
	item, err := s.events.Transition(ctx, p, r.EventId, b.ExpectedVersion, "archived", requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.ArchiveEvent200JSONResponse(eventDTO(item)), nil
}
func (s *Server) PublishEvent(ctx context.Context, r openapi.PublishEventRequestObject) (openapi.PublishEventResponseObject, error) {
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
func (s *Server) UnpublishEvent(ctx context.Context, r openapi.UnpublishEventRequestObject) (openapi.UnpublishEventResponseObject, error) {
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
func (s *Server) RotateEventPublicId(ctx context.Context, r openapi.RotateEventPublicIdRequestObject) (openapi.RotateEventPublicIdResponseObject, error) {
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

func (s *Server) ListEventSessions(ctx context.Context, r openapi.ListEventSessionsRequestObject) (openapi.ListEventSessionsResponseObject, error) {
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
func (s *Server) CreateEventSession(ctx context.Context, r openapi.CreateEventSessionRequestObject) (openapi.CreateEventSessionResponseObject, error) {
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
func (s *Server) UpdateEventSession(ctx context.Context, r openapi.UpdateEventSessionRequestObject) (openapi.UpdateEventSessionResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input := events.SessionInput{Name: nullableStringPointer(r.Body.Name), Location: nullableStringPointer(r.Body.Location), Description: nullableStringPointer(r.Body.Description), StartsAt: r.Body.StartsAt, EndsAt: r.Body.EndsAt, IsPublic: r.Body.IsPublic, Status: string(r.Body.Status), ExpectedVersion: r.Body.ExpectedVersion}
	item, err := s.events.UpdateSession(ctx, p, r.EventId, r.EventSessionId, input, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateEventSession200JSONResponse(eventSessionDTO(item)), nil
}
func (s *Server) DeleteEventSession(ctx context.Context, r openapi.DeleteEventSessionRequestObject) (openapi.DeleteEventSessionResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err = s.events.DeleteSession(ctx, p, r.EventId, r.EventSessionId, r.Body.ExpectedVersion, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.DeleteEventSession204Response{}, nil
}

func (s *Server) ListEventTaskLists(ctx context.Context, r openapi.ListEventTaskListsRequestObject) (openapi.ListEventTaskListsResponseObject, error) {
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
func (s *Server) CreateEventTaskList(ctx context.Context, r openapi.CreateEventTaskListRequestObject) (openapi.CreateEventTaskListResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.events.CreateTaskList(ctx, p, r.EventId, events.TaskListInput{Name: r.Body.Name, Description: nullableStringPointer(r.Body.Description), SortOrder: int(r.Body.SortOrder)}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateEventTaskList201JSONResponse(eventTaskListDTO(item)), nil
}
func (s *Server) UpdateEventTaskList(ctx context.Context, r openapi.UpdateEventTaskListRequestObject) (openapi.UpdateEventTaskListResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.events.UpdateTaskList(ctx, p, r.EventId, r.EventTaskListId, events.TaskListInput{Name: r.Body.Name, Description: nullableStringPointer(r.Body.Description), SortOrder: int(r.Body.SortOrder), ExpectedVersion: r.Body.ExpectedVersion}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateEventTaskList200JSONResponse(eventTaskListDTO(item)), nil
}
func (s *Server) DeleteEventTaskList(ctx context.Context, r openapi.DeleteEventTaskListRequestObject) (openapi.DeleteEventTaskListResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err = s.events.DeleteTaskList(ctx, p, r.EventId, r.EventTaskListId, r.Body.ExpectedVersion, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.DeleteEventTaskList204Response{}, nil
}

func (s *Server) ListEventTasks(ctx context.Context, r openapi.ListEventTasksRequestObject) (openapi.ListEventTasksResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.events.ListTasks(ctx, p, r.EventId)
	if err != nil {
		return nil, err
	}
	result := make([]openapi.EventTask, 0, len(items))
	for _, item := range items {
		result = append(result, eventTaskDTO(item))
	}
	return openapi.ListEventTasks200JSONResponse{Items: result}, nil
}
func (s *Server) CreateEventTask(ctx context.Context, r openapi.CreateEventTaskRequestObject) (openapi.CreateEventTaskResponseObject, error) {
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
func (s *Server) UpdateEventTask(ctx context.Context, r openapi.UpdateEventTaskRequestObject) (openapi.UpdateEventTaskResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input := events.TaskInput{TaskListID: nullableUUID(r.Body.TaskListId), Title: r.Body.Title, Description: nullableStringPointer(r.Body.Description), Status: string(r.Body.Status), Priority: string(r.Body.Priority), AssigneePersonID: nullableUUID(r.Body.AssigneePersonId), DueAt: nullableTime(r.Body.DueAt), SortOrder: int(r.Body.SortOrder), ExpectedVersion: r.Body.ExpectedVersion}
	item, err := s.events.UpdateTask(ctx, p, r.EventId, r.EventTaskId, input, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateEventTask200JSONResponse(eventTaskDTO(item)), nil
}
func (s *Server) DeleteEventTask(ctx context.Context, r openapi.DeleteEventTaskRequestObject) (openapi.DeleteEventTaskResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err = s.events.DeleteTask(ctx, p, r.EventId, r.EventTaskId, r.Body.ExpectedVersion, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.DeleteEventTask204Response{}, nil
}

func (s *Server) ListEventShifts(ctx context.Context, r openapi.ListEventShiftsRequestObject) (openapi.ListEventShiftsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.events.ListShifts(ctx, p, r.EventId)
	if err != nil {
		return nil, err
	}
	result := make([]openapi.EventShift, 0, len(items))
	for _, item := range items {
		result = append(result, eventShiftDTO(item))
	}
	return openapi.ListEventShifts200JSONResponse{Items: result}, nil
}
func (s *Server) CreateEventShift(ctx context.Context, r openapi.CreateEventShiftRequestObject) (openapi.CreateEventShiftResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.events.CreateShift(ctx, p, r.EventId, eventShiftInput(*r.Body, 0), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateEventShift201JSONResponse(eventShiftDTO(item)), nil
}
func (s *Server) UpdateEventShift(ctx context.Context, r openapi.UpdateEventShiftRequestObject) (openapi.UpdateEventShiftResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input := events.ShiftInput{SessionID: nullableUUID(r.Body.SessionId), Name: r.Body.Name, Description: nullableStringPointer(r.Body.Description), StartsAt: r.Body.StartsAt, EndsAt: r.Body.EndsAt, SignupOpensAt: nullableTime(r.Body.SignupOpensAt), SignupClosesAt: nullableTime(r.Body.SignupClosesAt), IsPublic: r.Body.IsPublic, Status: string(r.Body.Status), ExpectedVersion: r.Body.ExpectedVersion}
	item, err := s.events.UpdateShift(ctx, p, r.EventId, r.EventShiftId, input, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateEventShift200JSONResponse(eventShiftDTO(item)), nil
}
func (s *Server) DeleteEventShift(ctx context.Context, r openapi.DeleteEventShiftRequestObject) (openapi.DeleteEventShiftResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err = s.events.DeleteShift(ctx, p, r.EventId, r.EventShiftId, r.Body.ExpectedVersion, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.DeleteEventShift204Response{}, nil
}

func (s *Server) ListEventShiftRequirements(ctx context.Context, r openapi.ListEventShiftRequirementsRequestObject) (openapi.ListEventShiftRequirementsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.events.ListRequirements(ctx, p, r.EventId)
	if err != nil {
		return nil, err
	}
	result := []openapi.EventRequirement{}
	for _, item := range items {
		if item.ShiftID == r.EventShiftId {
			result = append(result, eventRequirementDTO(item))
		}
	}
	return openapi.ListEventShiftRequirements200JSONResponse{Items: result}, nil
}
func (s *Server) CreateEventShiftRequirement(ctx context.Context, r openapi.CreateEventShiftRequirementRequestObject) (openapi.CreateEventShiftRequirementResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.events.CreateRequirement(ctx, p, r.EventId, r.EventShiftId, eventRequirementInput(*r.Body, 0), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateEventShiftRequirement201JSONResponse(eventRequirementDTO(item)), nil
}
func (s *Server) UpdateEventShiftRequirement(ctx context.Context, r openapi.UpdateEventShiftRequirementRequestObject) (openapi.UpdateEventShiftRequirementResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	roles := make([]uuid.UUID, len(r.Body.EligibleRoleIds))
	copy(roles, r.Body.EligibleRoleIds)
	item, err := s.events.UpdateRequirement(ctx, p, r.EventId, r.EventShiftId, r.EventRequirementId, events.RequirementInput{Name: r.Body.Name, Description: nullableStringPointer(r.Body.Description), RequiredCount: r.Body.RequiredCount, EligibilityMode: string(r.Body.EligibilityMode), EligibleRoleIDs: roles, ExpectedVersion: r.Body.ExpectedVersion}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateEventShiftRequirement200JSONResponse(eventRequirementDTO(item)), nil
}
func (s *Server) DeleteEventShiftRequirement(ctx context.Context, r openapi.DeleteEventShiftRequirementRequestObject) (openapi.DeleteEventShiftRequirementResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err = s.events.DeleteRequirement(ctx, p, r.EventId, r.EventShiftId, r.EventRequirementId, r.Body.ExpectedVersion, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.DeleteEventShiftRequirement204Response{}, nil
}

func (s *Server) ListEventAssignments(ctx context.Context, r openapi.ListEventAssignmentsRequestObject) (openapi.ListEventAssignmentsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.events.ListAssignments(ctx, p, r.EventId)
	if err != nil {
		return nil, err
	}
	return openapi.ListEventAssignments200JSONResponse{Items: eventAssignmentDTOs(items)}, nil
}
func (s *Server) CreateEventAssignment(ctx context.Context, r openapi.CreateEventAssignmentRequestObject) (openapi.CreateEventAssignmentResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.events.CreateStaffAssignment(ctx, p, r.EventId, eventAssignmentInput(*r.Body), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateEventAssignment201JSONResponse(eventAssignmentDTO(item)), nil
}
func (s *Server) MoveEventAssignment(ctx context.Context, r openapi.MoveEventAssignmentRequestObject) (openapi.MoveEventAssignmentResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	shiftID, reqID := uuid.UUID(r.Body.ShiftId), uuid.UUID(r.Body.RequirementId)
	item, err := s.events.MoveAssignment(ctx, p, r.EventId, r.EventAssignmentId, events.AssignmentUpdateInput{ShiftID: &shiftID, RequirementID: &reqID, ExpectedVersion: r.Body.ExpectedVersion, OverrideConflict: r.Body.OverrideConflict}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.MoveEventAssignment200JSONResponse(eventAssignmentDTO(item)), nil
}
func (s *Server) CancelEventAssignment(ctx context.Context, r openapi.CancelEventAssignmentRequestObject) (openapi.CancelEventAssignmentResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.events.CancelAssignment(ctx, p, r.EventId, r.EventAssignmentId, r.Body.ExpectedVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CancelEventAssignment200JSONResponse(eventAssignmentDTO(item)), nil
}
func (s *Server) ListEventAssignmentPersonMatches(ctx context.Context, r openapi.ListEventAssignmentPersonMatchesRequestObject) (openapi.ListEventAssignmentPersonMatchesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.events.FindAssignmentPersonMatches(ctx, p, r.EventId, r.EventAssignmentId)
	if err != nil {
		return nil, err
	}
	return openapi.ListEventAssignmentPersonMatches200JSONResponse{Items: eventPersonDTOs(items)}, nil
}
func (s *Server) LinkEventAssignmentPerson(ctx context.Context, r openapi.LinkEventAssignmentPersonRequestObject) (openapi.LinkEventAssignmentPersonResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.events.LinkAssignmentPerson(ctx, p, r.EventId, r.EventAssignmentId, r.Body.PersonId, r.Body.ExpectedVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.LinkEventAssignmentPerson200JSONResponse(eventAssignmentDTO(item)), nil
}
func (s *Server) ListEventEligibilityRoles(ctx context.Context, _ openapi.ListEventEligibilityRolesRequestObject) (openapi.ListEventEligibilityRolesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.events.ListEligibilityRoles(ctx, p)
	if err != nil {
		return nil, err
	}
	result := make([]openapi.EventRole, 0, len(items))
	for _, item := range items {
		result = append(result, openapi.EventRole{Id: item.ID, Name: item.Name})
	}
	return openapi.ListEventEligibilityRoles200JSONResponse{Items: result}, nil
}
func (s *Server) ListEventPeople(ctx context.Context, r openapi.ListEventPeopleRequestObject) (openapi.ListEventPeopleResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	search := ""
	if r.Params.Search != nil {
		search = *r.Params.Search
	}
	items, err := s.events.FindPeople(ctx, p, search)
	if err != nil {
		return nil, err
	}
	return openapi.ListEventPeople200JSONResponse{Items: eventPersonDTOs(items)}, nil
}

func (s *Server) ListEventFiles(ctx context.Context, r openapi.ListEventFilesRequestObject) (openapi.ListEventFilesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.events.ListFiles(ctx, p, r.EventId)
	if err != nil {
		return nil, err
	}
	result := make([]openapi.EventFile, 0, len(items))
	for _, item := range items {
		result = append(result, eventFileDTO(item))
	}
	return openapi.ListEventFiles200JSONResponse{Items: result}, nil
}
func (s *Server) UploadEventFile(ctx context.Context, r openapi.UploadEventFileRequestObject) (openapi.UploadEventFileResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, (25<<20)+1))
	if err != nil {
		return nil, invalidRequest("could not read file")
	}
	if len(data) > 25<<20 {
		return nil, apperror.New(413, "event_file_too_large", "Event files are limited to 25 MiB")
	}
	isBanner := r.Params.XEventFilePurpose != nil && *r.Params.XEventFilePurpose == openapi.Banner
	item, err := s.events.AttachFile(ctx, p, r.EventId, r.Params.XFileName, r.Params.XFileContentType, string(r.Params.XEventFileVisibility), isBanner, r.Params.XEventFileDescription, data, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UploadEventFile201JSONResponse(eventFileDTO(item)), nil
}
func (s *Server) UpdateEventFile(ctx context.Context, r openapi.UpdateEventFileRequestObject) (openapi.UpdateEventFileResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.events.UpdateFile(ctx, p, r.EventId, r.EventFileId, r.Body.ExpectedVersion, string(r.Body.Visibility), r.Body.IsBanner, nullableStringPointer(r.Body.Description), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateEventFile200JSONResponse(eventFileDTO(item)), nil
}
func (s *Server) RemoveEventFile(ctx context.Context, r openapi.RemoveEventFileRequestObject) (openapi.RemoveEventFileResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err = s.events.RemoveFile(ctx, p, r.EventId, r.EventFileId, r.Body.ExpectedVersion, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.RemoveEventFile204Response{}, nil
}
func (s *Server) DownloadEventFile(ctx context.Context, r openapi.DownloadEventFileRequestObject) (openapi.DownloadEventFileResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	_, file, reader, err := s.events.OpenFile(ctx, p, r.EventId, r.EventFileId)
	if err != nil {
		return nil, err
	}
	return openapi.DownloadEventFile200ApplicationoctetStreamResponse{Body: reader, ContentLength: file.Size, Headers: openapi.DownloadEventFile200ResponseHeaders{CacheControl: "no-store", ContentDisposition: attachmentDisposition(file.OriginalFilename), XContentTypeOptions: "nosniff", ContentSecurityPolicy: "default-src 'none'; sandbox"}}, nil
}

func (s *Server) GetEventBanner(ctx context.Context, r openapi.GetEventBannerRequestObject) (openapi.GetEventBannerResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	file, reader, err := s.events.OpenBanner(ctx, p, r.EventId)
	if err != nil {
		return nil, err
	}
	headers := openapi.GetEventBanner200ResponseHeaders{CacheControl: "private, no-store", XContentTypeOptions: "nosniff", ContentSecurityPolicy: "default-src 'none'; sandbox"}
	switch file.ContentType {
	case "image/jpeg":
		return openapi.GetEventBanner200ImagejpegResponse{Body: reader, ContentLength: file.Size, Headers: headers}, nil
	case "image/png":
		return openapi.GetEventBanner200ImagepngResponse{Body: reader, ContentLength: file.Size, Headers: headers}, nil
	case "image/gif":
		return openapi.GetEventBanner200ImagegifResponse{Body: reader, ContentLength: file.Size, Headers: headers}, nil
	case "image/webp":
		return openapi.GetEventBanner200ImagewebpResponse{Body: reader, ContentLength: file.Size, Headers: headers}, nil
	default:
		_ = reader.Close()
		return nil, invalidRequest("stored Event banner content type is invalid")
	}
}

func (s *Server) GetPublicEvent(ctx context.Context, r openapi.GetPublicEventRequestObject) (openapi.GetPublicEventResponseObject, error) {
	item, err := s.events.GetPublic(ctx, string(r.PublicId))
	if err != nil {
		return nil, err
	}
	return openapi.GetPublicEvent200JSONResponse(publicEventDTO(item)), nil
}
func (s *Server) CreatePublicEventSignup(ctx context.Context, r openapi.CreatePublicEventSignupRequestObject) (openapi.CreatePublicEventSignupResponseObject, error) {
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	result, err := s.events.SignupAnonymous(ctx, string(r.PublicId), sourceAddress(ctx), eventSignupInput(*r.Body), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreatePublicEventSignup201JSONResponse{Body: eventSignupResultDTO(result), Headers: openapi.CreatePublicEventSignup201ResponseHeaders{CacheControl: "no-store"}}, nil
}
func (s *Server) CreateAuthenticatedEventSignup(ctx context.Context, r openapi.CreateAuthenticatedEventSignupRequestObject) (openapi.CreateAuthenticatedEventSignupResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input := events.AssignmentInput{ShiftID: r.Body.ShiftId, RequirementID: r.Body.RequirementId, FirstName: r.Body.FirstName, LastName: r.Body.LastName, Email: nullableStringPointer(r.Body.Email), Phone: nullableStringPointer(r.Body.Phone)}
	result, err := s.events.SignupAuthenticated(ctx, p, string(r.PublicId), sourceAddress(ctx), string(r.Body.SignupFor), input, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateAuthenticatedEventSignup201JSONResponse{Body: eventSignupResultDTO(result), Headers: openapi.CreateAuthenticatedEventSignup201ResponseHeaders{CacheControl: "no-store"}}, nil
}
func (s *Server) GetCurrentEventSignup(ctx context.Context, r openapi.GetCurrentEventSignupRequestObject) (openapi.GetCurrentEventSignupResponseObject, error) {
	item, err := s.events.GetManagedSignup(ctx, string(r.Params.XEventSignupToken))
	if err != nil {
		return nil, err
	}
	return openapi.GetCurrentEventSignup200JSONResponse{Body: eventSignupDTO(item), Headers: openapi.GetCurrentEventSignup200ResponseHeaders{CacheControl: "no-store"}}, nil
}
func (s *Server) UpdateCurrentEventSignup(ctx context.Context, r openapi.UpdateCurrentEventSignupRequestObject) (openapi.UpdateCurrentEventSignupResponseObject, error) {
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.events.UpdateManagedSignup(ctx, string(r.Params.XEventSignupToken), eventSignupUpdateInput(*r.Body), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateCurrentEventSignup200JSONResponse{Body: eventSignupDTO(item), Headers: openapi.UpdateCurrentEventSignup200ResponseHeaders{CacheControl: "no-store"}}, nil
}
func (s *Server) CancelCurrentEventSignup(ctx context.Context, r openapi.CancelCurrentEventSignupRequestObject) (openapi.CancelCurrentEventSignupResponseObject, error) {
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.events.CancelManagedSignup(ctx, string(r.Params.XEventSignupToken), r.Body.ExpectedVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CancelCurrentEventSignup200JSONResponse{Body: eventSignupDTO(item), Headers: openapi.CancelCurrentEventSignup200ResponseHeaders{CacheControl: "no-store"}}, nil
}
func (s *Server) ListOwnPublicEventAssignments(ctx context.Context, r openapi.ListOwnPublicEventAssignmentsRequestObject) (openapi.ListOwnPublicEventAssignmentsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.events.ListOwnAssignments(ctx, p, string(r.PublicId))
	if err != nil {
		return nil, err
	}
	result := make([]openapi.EventSignup, 0, len(items))
	for _, item := range items {
		result = append(result, eventSignupDTO(item))
	}
	return openapi.ListOwnPublicEventAssignments200JSONResponse{Body: openapi.EventSignupList{Items: result}, Headers: openapi.ListOwnPublicEventAssignments200ResponseHeaders{CacheControl: "no-store"}}, nil
}
func (s *Server) UpdateOwnPublicEventAssignment(ctx context.Context, r openapi.UpdateOwnPublicEventAssignmentRequestObject) (openapi.UpdateOwnPublicEventAssignmentResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.events.UpdateOwnAssignment(ctx, p, string(r.PublicId), r.EventAssignmentId, eventSignupUpdateInput(*r.Body), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateOwnPublicEventAssignment200JSONResponse{Body: eventSignupDTO(item), Headers: openapi.UpdateOwnPublicEventAssignment200ResponseHeaders{CacheControl: "no-store"}}, nil
}
func (s *Server) CancelOwnPublicEventAssignment(ctx context.Context, r openapi.CancelOwnPublicEventAssignmentRequestObject) (openapi.CancelOwnPublicEventAssignmentResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.events.CancelOwnAssignment(ctx, p, string(r.PublicId), r.EventAssignmentId, r.Body.ExpectedVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CancelOwnPublicEventAssignment200JSONResponse{Body: eventSignupDTO(item), Headers: openapi.CancelOwnPublicEventAssignment200ResponseHeaders{CacheControl: "no-store"}}, nil
}
func (s *Server) DownloadPublicEventFile(ctx context.Context, r openapi.DownloadPublicEventFileRequestObject) (openapi.DownloadPublicEventFileResponseObject, error) {
	_, file, reader, err := s.events.OpenPublicFile(ctx, string(r.PublicId), r.EventFileId)
	if err != nil {
		return nil, err
	}
	return openapi.DownloadPublicEventFile200ApplicationoctetStreamResponse{Body: reader, ContentLength: file.Size, Headers: openapi.DownloadPublicEventFile200ResponseHeaders{CacheControl: "no-store", ContentDisposition: attachmentDisposition(file.OriginalFilename), XContentTypeOptions: "nosniff", ContentSecurityPolicy: "default-src 'none'; sandbox"}}, nil
}

func (s *Server) GetPublicEventBanner(ctx context.Context, r openapi.GetPublicEventBannerRequestObject) (openapi.GetPublicEventBannerResponseObject, error) {
	file, reader, err := s.events.OpenPublicBanner(ctx, string(r.PublicId))
	if err != nil {
		return nil, err
	}
	headers := openapi.GetPublicEventBanner200ResponseHeaders{CacheControl: "no-store", XContentTypeOptions: "nosniff", ContentSecurityPolicy: "default-src 'none'; sandbox"}
	switch file.ContentType {
	case "image/jpeg":
		return openapi.GetPublicEventBanner200ImagejpegResponse{Body: reader, ContentLength: file.Size, Headers: headers}, nil
	case "image/png":
		return openapi.GetPublicEventBanner200ImagepngResponse{Body: reader, ContentLength: file.Size, Headers: headers}, nil
	case "image/gif":
		return openapi.GetPublicEventBanner200ImagegifResponse{Body: reader, ContentLength: file.Size, Headers: headers}, nil
	case "image/webp":
		return openapi.GetPublicEventBanner200ImagewebpResponse{Body: reader, ContentLength: file.Size, Headers: headers}, nil
	default:
		_ = reader.Close()
		return nil, invalidRequest("stored public Event banner content type is invalid")
	}
}

func eventActionInput(ctx context.Context, body *openapi.VersionRequest) (authorization.Principal, openapi.VersionRequest, error) {
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
	return openapi.Event{Id: item.ID, Name: item.Name, InternalDescription: nullablePointer[string](item.InternalDescription, func(v string) string { return v }), Location: nullablePointer[string](item.Location, func(v string) string { return v }), OwnerPersonId: nullablePointer[openapi.UUIDv7](item.OwnerPersonID, func(v uuid.UUID) openapi.UUIDv7 { return v }), OwnerName: nullablePointer[string](item.OwnerName, func(v string) string { return v }), Status: openapi.EventStatus(item.Status), PublicTitle: nullablePointer[string](item.PublicTitle, func(v string) string { return v }), PublicDescription: nullablePointer[string](item.PublicDescription, func(v string) string { return v }), PublicLocation: nullablePointer[string](item.PublicLocation, func(v string) string { return v }), PublicId: item.PublicID, IsPublic: item.IsPublic, PublicSignupEnabled: item.PublicSignupEnabled, HasBanner: item.HasBanner, ClosedAt: nullablePointer(item.ClosedAt, func(v time.Time) time.Time { return v }), RangeStartsAt: nullablePointer(item.RangeStartsAt, func(v time.Time) time.Time { return v }), RangeEndsAt: nullablePointer(item.RangeEndsAt, func(v time.Time) time.Time { return v }), TaskTotal: item.TaskTotal, TaskCompleted: item.TaskCompleted, FilledCount: item.FilledCount, RequiredCount: item.RequiredCount, NextDeadline: nullablePointer(item.NextDeadline, func(v time.Time) time.Time { return v }), NextScheduleAt: nullablePointer(item.NextScheduleAt, func(v time.Time) time.Time { return v }), Version: item.Version, CreatedAt: item.CreatedAt, UpdatedAt: item.UpdatedAt}
}
func eventSessionInput(v openapi.EventSessionInput, version int64) events.SessionInput {
	return events.SessionInput{Name: nullableStringPointer(v.Name), Location: nullableStringPointer(v.Location), Description: nullableStringPointer(v.Description), StartsAt: v.StartsAt, EndsAt: v.EndsAt, IsPublic: v.IsPublic, Status: string(v.Status), ExpectedVersion: version}
}
func eventSessionDTO(v events.Session) openapi.EventSession {
	return openapi.EventSession{Id: v.ID, EventId: v.EventID, Name: nullablePointer[string](v.Name, func(x string) string { return x }), Location: nullablePointer[string](v.Location, func(x string) string { return x }), Description: nullablePointer[string](v.Description, func(x string) string { return x }), StartsAt: v.StartsAt, EndsAt: v.EndsAt, IsPublic: v.IsPublic, Status: openapi.EventSessionStatus(v.Status), Version: v.Version, CreatedAt: v.CreatedAt, UpdatedAt: v.UpdatedAt}
}
func eventTaskListDTO(v events.TaskList) openapi.EventTaskList {
	return openapi.EventTaskList{Id: v.ID, EventId: v.EventID, Name: v.Name, Description: nullablePointer[string](v.Description, func(x string) string { return x }), SortOrder: int32(v.SortOrder), Version: v.Version, CreatedAt: v.CreatedAt, UpdatedAt: v.UpdatedAt}
}
func eventTaskInput(v openapi.EventTaskInput, version int64) events.TaskInput {
	return events.TaskInput{TaskListID: nullableUUID(v.TaskListId), Title: v.Title, Description: nullableStringPointer(v.Description), Status: string(v.Status), Priority: string(v.Priority), AssigneePersonID: nullableUUID(v.AssigneePersonId), DueAt: nullableTime(v.DueAt), SortOrder: int(v.SortOrder), ExpectedVersion: version}
}
func eventTaskDTO(v events.Task) openapi.EventTask {
	return openapi.EventTask{Id: v.ID, EventId: v.EventID, TaskListId: nullablePointer[openapi.UUIDv7](v.TaskListID, func(x uuid.UUID) openapi.UUIDv7 { return x }), Title: v.Title, Description: nullablePointer[string](v.Description, func(x string) string { return x }), Status: openapi.EventTaskStatus(v.Status), Priority: openapi.EventTaskPriority(v.Priority), AssigneePersonId: nullablePointer[openapi.UUIDv7](v.AssigneePersonID, func(x uuid.UUID) openapi.UUIDv7 { return x }), DueAt: nullablePointer(v.DueAt, func(x time.Time) time.Time { return x }), CompletedAt: nullablePointer(v.CompletedAt, func(x time.Time) time.Time { return x }), CompletedByAccountId: nullablePointer[openapi.UUIDv7](v.CompletedByAccount, func(x uuid.UUID) openapi.UUIDv7 { return x }), SortOrder: int32(v.SortOrder), Version: v.Version, CreatedAt: v.CreatedAt, UpdatedAt: v.UpdatedAt}
}
func eventShiftInput(v openapi.EventShiftInput, version int64) events.ShiftInput {
	return events.ShiftInput{SessionID: nullableUUID(v.SessionId), Name: v.Name, Description: nullableStringPointer(v.Description), StartsAt: v.StartsAt, EndsAt: v.EndsAt, SignupOpensAt: nullableTime(v.SignupOpensAt), SignupClosesAt: nullableTime(v.SignupClosesAt), IsPublic: v.IsPublic, Status: string(v.Status), ExpectedVersion: version}
}
func eventShiftDTO(v events.Shift) openapi.EventShift {
	return openapi.EventShift{Id: v.ID, EventId: v.EventID, SessionId: nullablePointer[openapi.UUIDv7](v.SessionID, func(x uuid.UUID) openapi.UUIDv7 { return x }), Name: v.Name, Description: nullablePointer[string](v.Description, func(x string) string { return x }), StartsAt: v.StartsAt, EndsAt: v.EndsAt, SignupOpensAt: nullablePointer(v.SignupOpensAt, func(x time.Time) time.Time { return x }), SignupClosesAt: nullablePointer(v.SignupClosesAt, func(x time.Time) time.Time { return x }), IsPublic: v.IsPublic, Status: openapi.EventShiftStatus(v.Status), LinkedSessionStatus: nullablePointer(v.LinkedSessionStatus, func(x string) openapi.EventSessionStatus { return openapi.EventSessionStatus(x) }), Version: v.Version, CreatedAt: v.CreatedAt, UpdatedAt: v.UpdatedAt}
}
func eventRequirementInput(v openapi.EventRequirementInput, version int64) events.RequirementInput {
	roles := make([]uuid.UUID, len(v.EligibleRoleIds))
	copy(roles, v.EligibleRoleIds)
	return events.RequirementInput{Name: v.Name, Description: nullableStringPointer(v.Description), RequiredCount: v.RequiredCount, EligibilityMode: string(v.EligibilityMode), EligibleRoleIDs: roles, ExpectedVersion: version}
}
func eventRequirementDTO(v events.Requirement) openapi.EventRequirement {
	roles := make([]openapi.UUIDv7, len(v.EligibleRoleIDs))
	copy(roles, v.EligibleRoleIDs)
	return openapi.EventRequirement{Id: v.ID, EventId: v.EventID, ShiftId: v.ShiftID, Name: v.Name, Description: nullablePointer[string](v.Description, func(x string) string { return x }), RequiredCount: v.RequiredCount, FilledCount: v.FilledCount, EligibilityMode: openapi.EventEligibilityMode(v.EligibilityMode), EligibleRoleIds: roles, Version: v.Version, CreatedAt: v.CreatedAt, UpdatedAt: v.UpdatedAt}
}
func eventAssignmentInput(v openapi.EventAssignmentInput) events.AssignmentInput {
	first, last := "", ""
	if v.FirstName != nil {
		first = *v.FirstName
	}
	if v.LastName != nil {
		last = *v.LastName
	}
	return events.AssignmentInput{ShiftID: v.ShiftId, RequirementID: v.RequirementId, PersonID: nullableUUID(v.PersonId), FirstName: first, LastName: last, Email: nullableStringPointer(v.Email), Phone: nullableStringPointer(v.Phone), OverrideConflict: v.OverrideConflict}
}
func eventAssignmentDTO(v events.Assignment) openapi.EventAssignment {
	return openapi.EventAssignment{Id: v.ID, EventId: v.EventID, ShiftId: v.ShiftID, RequirementId: v.RequirementID, PersonId: nullablePointer[openapi.UUIDv7](v.PersonID, func(x uuid.UUID) openapi.UUIDv7 { return x }), FirstName: nullablePointer[string](v.FirstName, func(x string) string { return x }), LastName: nullablePointer[string](v.LastName, func(x string) string { return x }), Email: nullablePointer[string](v.Email, func(x string) string { return x }), Phone: nullablePointer[string](v.Phone, func(x string) string { return x }), Source: openapi.EventAssignmentSource(v.Source), Status: openapi.EventAssignmentStatus(v.Status), ConflictOverriddenByAccountId: nullablePointer[openapi.UUIDv7](v.ConflictOverriddenByAccountID, func(x uuid.UUID) openapi.UUIDv7 { return x }), CancelledAt: nullablePointer(v.CancelledAt, func(x time.Time) time.Time { return x }), PersonalDataErasedAt: nullablePointer(v.PersonalDataErasedAt, func(x time.Time) time.Time { return x }), Version: v.Version, CreatedAt: v.CreatedAt, UpdatedAt: v.UpdatedAt}
}
func eventAssignmentDTOs(values []events.Assignment) []openapi.EventAssignment {
	result := make([]openapi.EventAssignment, 0, len(values))
	for _, v := range values {
		result = append(result, eventAssignmentDTO(v))
	}
	return result
}
func eventPersonDTOs(values []events.PersonOption) []openapi.EventPersonOption {
	result := make([]openapi.EventPersonOption, 0, len(values))
	for _, v := range values {
		result = append(result, openapi.EventPersonOption{Id: v.ID, FirstName: v.FirstName, LastName: v.LastName, Email: nullablePointer[string](v.Email, func(x string) string { return x }), Phone: nullablePointer[string](v.Phone, func(x string) string { return x })})
	}
	return result
}
func eventFileDTO(v events.EventFile) openapi.EventFile {
	return openapi.EventFile{Id: v.ID, EventId: v.EventID, FileId: v.FileID, Description: nullablePointer[string](v.Description, func(x string) string { return x }), Visibility: openapi.EventFileVisibility(v.Visibility), IsBanner: v.IsBanner, OriginalFilename: v.OriginalFilename, ContentType: v.ContentType, SizeBytes: v.SizeBytes, Version: v.Version, CreatedAt: v.CreatedAt, UpdatedAt: v.UpdatedAt}
}
func eventSignupInput(v openapi.EventSignupRequest) events.AssignmentInput {
	return events.AssignmentInput{ShiftID: v.ShiftId, RequirementID: v.RequirementId, FirstName: v.FirstName, LastName: v.LastName, Email: nullableStringPointer(v.Email), Phone: nullableStringPointer(v.Phone)}
}
func eventSignupUpdateInput(v openapi.UpdateEventSignupRequest) events.AssignmentUpdateInput {
	first, last := "", ""
	if v.FirstName != nil {
		first = *v.FirstName
	}
	if v.LastName != nil {
		last = *v.LastName
	}
	return events.AssignmentUpdateInput{FirstName: first, LastName: last, Email: nullableStringPointer(v.Email), Phone: nullableStringPointer(v.Phone), FirstNameSet: v.FirstName != nil, LastNameSet: v.LastName != nil, EmailSet: v.Email.IsSpecified(), PhoneSet: v.Phone.IsSpecified(), ShiftID: nullableUUID(v.ShiftId), RequirementID: nullableUUID(v.RequirementId), ExpectedVersion: v.ExpectedVersion}
}
func eventSignupDTO(v events.Assignment) openapi.EventSignup {
	return openapi.EventSignup{Id: v.ID, PublicId: v.PublicID, ShiftId: v.ShiftID, RequirementId: v.RequirementID, FirstName: nullablePointer[string](v.FirstName, func(x string) string { return x }), LastName: nullablePointer[string](v.LastName, func(x string) string { return x }), Email: nullablePointer[string](v.Email, func(x string) string { return x }), Phone: nullablePointer[string](v.Phone, func(x string) string { return x }), Source: openapi.EventAssignmentSource(v.Source), Status: openapi.EventAssignmentStatus(v.Status), CancelledAt: nullablePointer(v.CancelledAt, func(x time.Time) time.Time { return x }), Version: v.Version, CreatedAt: v.CreatedAt, UpdatedAt: v.UpdatedAt}
}
func eventSignupResultDTO(v events.SignupResult) openapi.EventSignupResult {
	return openapi.EventSignupResult{Assignment: eventSignupDTO(v.Assignment), ManagementUrl: nullablePointer[string](v.ManagementURL, func(x string) string { return x })}
}
func publicEventDTO(v events.PublicEvent) openapi.PublicEvent {
	sessions := make([]openapi.PublicEventSession, 0, len(v.Sessions))
	for _, item := range v.Sessions {
		sessions = append(sessions, openapi.PublicEventSession{Id: item.ID, Name: nullablePointer[string](item.Name, func(x string) string { return x }), Location: nullablePointer[string](item.Location, func(x string) string { return x }), Description: nullablePointer[string](item.Description, func(x string) string { return x }), StartsAt: item.StartsAt, EndsAt: item.EndsAt})
	}
	shifts := make([]openapi.PublicEventShift, 0, len(v.Shifts))
	for _, item := range v.Shifts {
		requirements := make([]openapi.PublicEventRequirement, 0, len(item.Requirements))
		for _, req := range item.Requirements {
			remaining := req.RequiredCount - req.FilledCount
			if remaining < 0 {
				remaining = 0
			}
			requirements = append(requirements, openapi.PublicEventRequirement{Id: req.ID, Name: req.Name, Description: nullablePointer[string](req.Description, func(x string) string { return x }), RequiredCount: req.RequiredCount, FilledCount: req.FilledCount, RemainingCount: remaining, Availability: openapi.PublicEventRequirementAvailability(req.Availability)})
		}
		shifts = append(shifts, openapi.PublicEventShift{Id: item.ID, SessionId: nullablePointer[openapi.UUIDv7](item.SessionID, func(x uuid.UUID) openapi.UUIDv7 { return x }), Name: item.Name, Description: nullablePointer[string](item.Description, func(x string) string { return x }), StartsAt: item.StartsAt, EndsAt: item.EndsAt, Requirements: requirements})
	}
	files := make([]openapi.PublicEventFile, 0, len(v.Files))
	for _, item := range v.Files {
		files = append(files, openapi.PublicEventFile{Id: item.ID, Description: nullablePointer[string](item.Description, func(x string) string { return x }), OriginalFilename: item.OriginalFilename, ContentType: item.ContentType, SizeBytes: item.SizeBytes})
	}
	return openapi.PublicEvent{PublicId: v.PublicID, Title: v.Title, Description: nullablePointer[string](v.Description, func(x string) string { return x }), Location: nullablePointer[string](v.Location, func(x string) string { return x }), Status: openapi.EventStatus(v.Status), TimeZone: v.TimeZone, PublicSignupEnabled: v.PublicSignupEnabled, HasBanner: v.HasBanner, Sessions: sessions, Shifts: shifts, Files: files}
}

func attachmentDisposition(filename string) string {
	value := mime.FormatMediaType("attachment", map[string]string{"filename": filename})
	if value == "" {
		return "attachment"
	}
	return value
}
