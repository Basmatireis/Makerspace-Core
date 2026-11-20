package httpapi

import (
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/workinggroups"
	"github.com/google/uuid"
	"github.com/oapi-codegen/nullable"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

func (s *Server) SetWorkingGroupColumns(
	ctx context.Context,
	r openapi.SetWorkingGroupColumnsRequestObject,
) (openapi.SetWorkingGroupColumnsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	columns := make([]workinggroups.ColumnInput, 0, len(r.Body.Columns))
	for _, column := range r.Body.Columns {
		columns = append(columns, workinggroups.ColumnInput{ID: column.Id, Name: column.Name})
	}
	group, err := s.workingGroups.SetColumns(ctx, p, r.GroupId, columns, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.SetWorkingGroupColumns200JSONResponse(workingGroupDTO(group)), nil
}

func (s *Server) ListWorkingGroupTickets(
	ctx context.Context,
	r openapi.ListWorkingGroupTicketsRequestObject,
) (openapi.ListWorkingGroupTicketsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	filter := workinggroups.TicketFilter{GroupID: r.Params.GroupId}
	if r.Params.Status != nil {
		status := workinggroups.TicketStatus(*r.Params.Status)
		filter.Status = &status
	}
	items, truncated, err := s.workingGroups.ListTickets(ctx, p, filter)
	if err != nil {
		return nil, err
	}
	out := make([]openapi.WorkingGroupTicket, 0, len(items))
	for _, item := range items {
		out = append(out, workingGroupTicketDTO(item))
	}
	return openapi.ListWorkingGroupTickets200JSONResponse{Items: out, Truncated: &truncated}, nil
}

func (s *Server) CreateWorkingGroupTicket(
	ctx context.Context,
	r openapi.CreateWorkingGroupTicketRequestObject,
) (openapi.CreateWorkingGroupTicketResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	body := ""
	if r.Body.Body != nil {
		body = *r.Body.Body
	}
	detail, err := s.workingGroups.CreateTicket(ctx, p, workinggroups.CreateTicketInput{
		GroupID:   r.Body.GroupId,
		MachineID: r.Body.MachineId,
		Kind:      workinggroups.TicketKind(r.Body.Kind),
		Subject:   r.Body.Subject,
		Body:      body,
		BlocksUse: r.Body.BlocksUse,
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateWorkingGroupTicket201JSONResponse(workingGroupTicketDetailDTO(detail)), nil
}

func (s *Server) GetWorkingGroupTicket(
	ctx context.Context,
	r openapi.GetWorkingGroupTicketRequestObject,
) (openapi.GetWorkingGroupTicketResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	detail, err := s.workingGroups.GetTicket(ctx, p, r.TicketId)
	if err != nil {
		return nil, err
	}
	return openapi.GetWorkingGroupTicket200JSONResponse(workingGroupTicketDetailDTO(detail)), nil
}

func (s *Server) UpdateWorkingGroupTicket(
	ctx context.Context,
	r openapi.UpdateWorkingGroupTicketRequestObject,
) (openapi.UpdateWorkingGroupTicketResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input := workinggroups.UpdateTicketInput{ExpectedVersion: r.Body.ExpectedVersion, ColumnID: r.Body.ColumnId}
	input.Assignee = optionalID(r.Body.AssigneePersonId)
	input.DueOn = optionalDate(r.Body.DueOn)
	detail, err := s.workingGroups.UpdateTicket(ctx, p, r.TicketId, input, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateWorkingGroupTicket200JSONResponse(workingGroupTicketDetailDTO(detail)), nil
}

func (s *Server) PlanWorkingGroupTicket(
	ctx context.Context,
	r openapi.PlanWorkingGroupTicketRequestObject,
) (openapi.PlanWorkingGroupTicketResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input := workinggroups.PlanTicketInput{AssigneePersonID: r.Body.AssigneePersonId, ColumnID: r.Body.ColumnId}
	if r.Body.DueOn != nil {
		due := r.Body.DueOn.Time
		input.DueOn = &due
	}
	detail, err := s.workingGroups.PlanTicket(ctx, p, r.TicketId, input, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.PlanWorkingGroupTicket200JSONResponse(workingGroupTicketDetailDTO(detail)), nil
}

func (s *Server) CloseWorkingGroupTicket(
	ctx context.Context,
	r openapi.CloseWorkingGroupTicketRequestObject,
) (openapi.CloseWorkingGroupTicketResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	answer := ""
	if r.Body.Answer != nil {
		answer = *r.Body.Answer
	}
	detail, err := s.workingGroups.CloseTicket(ctx, p, r.TicketId, workinggroups.CloseTicketInput{
		Outcome: workinggroups.TicketStatus(r.Body.Outcome), Answer: answer,
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CloseWorkingGroupTicket200JSONResponse(workingGroupTicketDetailDTO(detail)), nil
}

func (s *Server) ReopenWorkingGroupTicket(
	ctx context.Context,
	r openapi.ReopenWorkingGroupTicketRequestObject,
) (openapi.ReopenWorkingGroupTicketResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	detail, err := s.workingGroups.ReopenTicket(ctx, p, r.TicketId, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.ReopenWorkingGroupTicket200JSONResponse(workingGroupTicketDetailDTO(detail)), nil
}

func (s *Server) FollowWorkingGroupTicket(
	ctx context.Context,
	r openapi.FollowWorkingGroupTicketRequestObject,
) (openapi.FollowWorkingGroupTicketResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	detail, err := s.workingGroups.FollowTicket(ctx, p, r.TicketId, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.FollowWorkingGroupTicket200JSONResponse(workingGroupTicketDetailDTO(detail)), nil
}

func (s *Server) UnfollowWorkingGroupTicket(
	ctx context.Context,
	r openapi.UnfollowWorkingGroupTicketRequestObject,
) (openapi.UnfollowWorkingGroupTicketResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	detail, err := s.workingGroups.UnfollowTicket(ctx, p, r.TicketId, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UnfollowWorkingGroupTicket200JSONResponse(workingGroupTicketDetailDTO(detail)), nil
}

func (s *Server) AddWorkingGroupTicketComment(
	ctx context.Context,
	r openapi.AddWorkingGroupTicketCommentRequestObject,
) (openapi.AddWorkingGroupTicketCommentResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	internal := r.Body.Internal != nil && *r.Body.Internal
	detail, err := s.workingGroups.AddTicketComment(ctx, p, r.TicketId,
		workinggroups.CommentInput{Text: r.Body.Text, Internal: internal}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.AddWorkingGroupTicketComment200JSONResponse(workingGroupTicketDetailDTO(detail)), nil
}

func (s *Server) DeleteWorkingGroupTicket(
	ctx context.Context,
	r openapi.DeleteWorkingGroupTicketRequestObject,
) (openapi.DeleteWorkingGroupTicketResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.workingGroups.DeleteTicket(ctx, p, r.TicketId, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.DeleteWorkingGroupTicket204Response{}, nil
}

func (s *Server) DeleteWorkingGroupTicketComment(
	ctx context.Context,
	r openapi.DeleteWorkingGroupTicketCommentRequestObject,
) (openapi.DeleteWorkingGroupTicketCommentResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	detail, err := s.workingGroups.DeleteTicketComment(ctx, p, r.TicketId, r.CommentId, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.DeleteWorkingGroupTicketComment200JSONResponse(workingGroupTicketDetailDTO(detail)), nil
}

func (s *Server) DeleteWorkingGroupTodoComment(
	ctx context.Context,
	r openapi.DeleteWorkingGroupTodoCommentRequestObject,
) (openapi.DeleteWorkingGroupTodoCommentResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	detail, err := s.workingGroups.DeleteTodoComment(ctx, p, r.TodoId, r.CommentId, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.DeleteWorkingGroupTodoComment200JSONResponse(workingGroupTodoDetailDTO(detail)), nil
}

func (s *Server) ListWorkingGroupTodos(
	ctx context.Context,
	r openapi.ListWorkingGroupTodosRequestObject,
) (openapi.ListWorkingGroupTodosResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.workingGroups.ListTodos(ctx, p, r.Params.GroupId)
	if err != nil {
		return nil, err
	}
	out := make([]openapi.WorkingGroupTodo, 0, len(items))
	for _, item := range items {
		out = append(out, workingGroupTodoDTO(item))
	}
	return openapi.ListWorkingGroupTodos200JSONResponse{Items: out}, nil
}

func (s *Server) CreateWorkingGroupTodo(
	ctx context.Context,
	r openapi.CreateWorkingGroupTodoRequestObject,
) (openapi.CreateWorkingGroupTodoResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input := workinggroups.CreateTodoInput{
		GroupID:          r.Body.GroupId,
		Title:            r.Body.Title,
		AssigneePersonID: r.Body.AssigneePersonId,
		DueOn:            r.Body.DueOn.Time,
		ColumnID:         r.Body.ColumnId,
	}
	if r.Body.RepeatEveryDays != nil {
		days := int(*r.Body.RepeatEveryDays)
		input.RepeatEveryDays = &days
	}
	detail, err := s.workingGroups.CreateTodo(ctx, p, input, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateWorkingGroupTodo201JSONResponse(workingGroupTodoDetailDTO(detail)), nil
}

func (s *Server) GetWorkingGroupTodo(
	ctx context.Context,
	r openapi.GetWorkingGroupTodoRequestObject,
) (openapi.GetWorkingGroupTodoResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	detail, err := s.workingGroups.GetTodo(ctx, p, r.TodoId)
	if err != nil {
		return nil, err
	}
	return openapi.GetWorkingGroupTodo200JSONResponse(workingGroupTodoDetailDTO(detail)), nil
}

func (s *Server) UpdateWorkingGroupTodo(
	ctx context.Context,
	r openapi.UpdateWorkingGroupTodoRequestObject,
) (openapi.UpdateWorkingGroupTodoResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input := workinggroups.UpdateTodoInput{
		ExpectedVersion: r.Body.ExpectedVersion,
		Title:           r.Body.Title,
		Assignee:        optionalID(r.Body.AssigneePersonId),
		ColumnID:        r.Body.ColumnId,
	}
	if r.Body.DueOn != nil {
		due := r.Body.DueOn.Time
		input.DueOn = &due
	}
	if r.Body.RepeatEveryDays.IsSpecified() {
		input.RepeatEveryDays.Set = true
		if !r.Body.RepeatEveryDays.IsNull() {
			days := int(r.Body.RepeatEveryDays.MustGet())
			input.RepeatEveryDays.Value = &days
		}
	}
	detail, err := s.workingGroups.UpdateTodo(ctx, p, r.TodoId, input, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateWorkingGroupTodo200JSONResponse(workingGroupTodoDetailDTO(detail)), nil
}

func (s *Server) DeleteWorkingGroupTodo(
	ctx context.Context,
	r openapi.DeleteWorkingGroupTodoRequestObject,
) (openapi.DeleteWorkingGroupTodoResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.workingGroups.DeleteTodo(ctx, p, r.TodoId, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.DeleteWorkingGroupTodo204Response{}, nil
}

func (s *Server) MarkWorkingGroupTodoDone(
	ctx context.Context,
	r openapi.MarkWorkingGroupTodoDoneRequestObject,
) (openapi.MarkWorkingGroupTodoDoneResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	detail, err := s.workingGroups.MarkTodoDone(ctx, p, r.TodoId, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.MarkWorkingGroupTodoDone200JSONResponse(workingGroupTodoDetailDTO(detail)), nil
}

func (s *Server) ReopenWorkingGroupTodo(
	ctx context.Context,
	r openapi.ReopenWorkingGroupTodoRequestObject,
) (openapi.ReopenWorkingGroupTodoResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	detail, err := s.workingGroups.ReopenTodo(ctx, p, r.TodoId, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.ReopenWorkingGroupTodo200JSONResponse(workingGroupTodoDetailDTO(detail)), nil
}

func (s *Server) AddWorkingGroupTodoComment(
	ctx context.Context,
	r openapi.AddWorkingGroupTodoCommentRequestObject,
) (openapi.AddWorkingGroupTodoCommentResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	detail, err := s.workingGroups.AddTodoComment(ctx, p, r.TodoId,
		workinggroups.CommentInput{Text: r.Body.Text, Internal: true}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.AddWorkingGroupTodoComment200JSONResponse(workingGroupTodoDetailDTO(detail)), nil
}

func optionalID(value nullable.Nullable[uuid.UUID]) workinggroups.OptionalID {
	if !value.IsSpecified() {
		return workinggroups.OptionalID{}
	}
	if value.IsNull() {
		return workinggroups.OptionalID{Set: true}
	}
	id := value.MustGet()
	return workinggroups.OptionalID{Set: true, Value: &id}
}

func optionalDate(value nullable.Nullable[openapi_types.Date]) workinggroups.OptionalDate {
	if !value.IsSpecified() {
		return workinggroups.OptionalDate{}
	}
	if value.IsNull() {
		return workinggroups.OptionalDate{Set: true}
	}
	day := value.MustGet().Time
	return workinggroups.OptionalDate{Set: true, Value: &day}
}

func workingGroupPersonDTO(person *workinggroups.Person) *openapi.WorkingGroupPerson {
	if person == nil {
		return nil
	}
	return &openapi.WorkingGroupPerson{PersonId: person.ID, DisplayName: person.DisplayName}
}

func dateDTO(value *time.Time) *openapi_types.Date {
	if value == nil {
		return nil
	}
	return &openapi_types.Date{Time: *value}
}

func workingGroupTicketDTO(item workinggroups.Ticket) openapi.WorkingGroupTicket {
	result := openapi.WorkingGroupTicket{
		Id:            item.ID,
		GroupId:       item.GroupID,
		GroupName:     item.GroupName,
		MachineId:     item.MachineID,
		MachineName:   item.MachineName,
		Kind:          openapi.WorkingGroupTicketKind(item.Kind),
		Subject:       item.Subject,
		Body:          item.Body,
		BlocksUse:     item.BlocksUse,
		Status:        openapi.WorkingGroupTicketStatus(item.Status),
		Author:        workingGroupPersonDTO(item.Author),
		Assignee:      workingGroupPersonDTO(item.Assignee),
		DueOn:         dateDTO(item.DueOn),
		ColumnId:      item.ColumnID,
		FollowerCount: item.FollowerCount,
		IsFollowing:   item.IsFollowing,
		IsMine:        item.IsMine,
		CommentCount:  item.CommentCount,
		Inside:        item.Inside,
		Version:       item.Version,
		CreatedAt:     item.CreatedAt,
		UpdatedAt:     item.UpdatedAt,
		ClosedAt:      item.ClosedAt,
		Link:          taskLinkDTO(item.Link),
	}
	if item.LatestComments != nil {
		latest := workingGroupCommentsDTO(item.LatestComments)
		result.LatestComments = &latest
	}
	return result
}

func workingGroupCommentsDTO(items []workinggroups.Comment) []openapi.WorkingGroupComment {
	out := make([]openapi.WorkingGroupComment, 0, len(items))
	for _, item := range items {
		out = append(out, openapi.WorkingGroupComment{
			Id: item.ID, Author: workingGroupPersonDTO(item.Author), Text: item.Text, Internal: item.Internal,
			CreatedAt: item.CreatedAt,
		})
	}
	return out
}

func workingGroupTicketDetailDTO(detail workinggroups.TicketDetail) openapi.WorkingGroupTicketDetail {
	followers := make([]openapi.WorkingGroupPerson, 0, len(detail.Followers))
	for _, follower := range detail.Followers {
		followers = append(followers, openapi.WorkingGroupPerson{PersonId: follower.ID, DisplayName: follower.DisplayName})
	}
	return openapi.WorkingGroupTicketDetail{
		Ticket:    workingGroupTicketDTO(detail.Ticket),
		Followers: followers,
		Comments:  workingGroupCommentsDTO(detail.Comments),
	}
}

func workingGroupTodoDTO(item workinggroups.Todo) openapi.WorkingGroupTodo {
	result := openapi.WorkingGroupTodo{
		Id:           item.ID,
		GroupId:      item.GroupID,
		GroupName:    item.GroupName,
		Title:        item.Title,
		Assignee:     workingGroupPersonDTO(item.Assignee),
		CreatedBy:    workingGroupPersonDTO(item.CreatedBy),
		DueOn:        openapi_types.Date{Time: item.DueOn},
		ColumnId:     item.ColumnID,
		Done:         item.Done,
		DoneAt:       item.DoneAt,
		IsMine:       item.IsMine,
		CommentCount: item.CommentCount,
		Version:      item.Version,
		CreatedAt:    item.CreatedAt,
		UpdatedAt:    item.UpdatedAt,
		Link:         taskLinkDTO(item.Link),
	}
	if item.LatestComments != nil {
		latest := workingGroupCommentsDTO(item.LatestComments)
		result.LatestComments = &latest
	}
	if item.RepeatEveryDays != nil {
		days := int32(*item.RepeatEveryDays)
		result.RepeatEveryDays = &days
	}
	return result
}

func workingGroupTodoDetailDTO(detail workinggroups.TodoDetail) openapi.WorkingGroupTodoDetail {
	return openapi.WorkingGroupTodoDetail{
		Todo:       workingGroupTodoDTO(detail.Todo),
		Comments:   workingGroupCommentsDTO(detail.Comments),
		NextTodoId: detail.NextTodoID,
	}
}

// makerspaceLocation is the configured makerspace time zone, Europe/Vienna by default like the open days; UTC when it
// cannot be loaded.
func makerspaceLocation(cfg config.Config) *time.Location {
	name := cfg.MakerspaceTimeZone
	if name == "" {
		name = "Europe/Vienna"
	}
	location, err := time.LoadLocation(name)
	if err != nil {
		return time.UTC
	}
	return location
}

func taskLinkDTO(link *workinggroups.TaskLink) *openapi.WorkingGroupTaskLink {
	if link == nil {
		return nil
	}
	return &openapi.WorkingGroupTaskLink{
		Kind: openapi.WorkingGroupTaskLinkKind(link.Kind), Id: link.ID, Title: link.Title, Status: link.Status,
	}
}

func linkedTasksDTO(tasks []workinggroups.LinkedTask) *[]openapi.WorkingGroupLinkedTask {
	out := make([]openapi.WorkingGroupLinkedTask, 0, len(tasks))
	for _, task := range tasks {
		out = append(out, openapi.WorkingGroupLinkedTask{Kind: openapi.WorkingGroupLinkedTaskKind(task.Kind), Id: task.ID, Title: task.Title})
	}
	return &out
}

func linkInput(body *openapi.SetWorkingGroupLinkRequest) workinggroups.LinkInput {
	input := workinggroups.LinkInput{ExpectedVersion: body.ExpectedVersion}
	if body.PurchaseId.IsSpecified() && !body.PurchaseId.IsNull() {
		id := body.PurchaseId.MustGet()
		input.PurchaseID = &id
	}
	if body.ProjectId.IsSpecified() && !body.ProjectId.IsNull() {
		id := body.ProjectId.MustGet()
		input.ProjectID = &id
	}
	return input
}

func (s *Server) SetWorkingGroupTicketLink(
	ctx context.Context,
	r openapi.SetWorkingGroupTicketLinkRequestObject,
) (openapi.SetWorkingGroupTicketLinkResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	detail, err := s.workingGroups.SetTicketLink(ctx, p, r.TicketId, linkInput(r.Body), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.SetWorkingGroupTicketLink200JSONResponse(workingGroupTicketDetailDTO(detail)), nil
}

func (s *Server) SetWorkingGroupTodoLink(
	ctx context.Context,
	r openapi.SetWorkingGroupTodoLinkRequestObject,
) (openapi.SetWorkingGroupTodoLinkResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	detail, err := s.workingGroups.SetTodoLink(ctx, p, r.TodoId, linkInput(r.Body), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.SetWorkingGroupTodoLink200JSONResponse(workingGroupTodoDetailDTO(detail)), nil
}

func (s *Server) ListWorkingGroupActivity(
	ctx context.Context,
	r openapi.ListWorkingGroupActivityRequestObject,
) (openapi.ListWorkingGroupActivityResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	entries, err := s.workingGroups.ListActivity(ctx, p, r.GroupId, r.Params.Limit)
	if err != nil {
		return nil, err
	}
	items := make([]openapi.WorkingGroupActivityEntry, 0, len(entries))
	for _, e := range entries {
		items = append(items, openapi.WorkingGroupActivityEntry{
			Kind: openapi.WorkingGroupActivityEntryKind(e.Kind), At: e.At, Actor: workingGroupPersonDTO(e.Actor), Title: e.Title,
			TargetKind: openapi.WorkingGroupActivityEntryTargetKind(e.TargetKind), TargetId: e.TargetID,
		})
	}
	return openapi.ListWorkingGroupActivity200JSONResponse{Items: items}, nil
}
