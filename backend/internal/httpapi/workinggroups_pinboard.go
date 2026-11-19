package httpapi

import (
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/workinggroups"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

func (s *Server) ListWorkingGroupNotes(
	ctx context.Context,
	r openapi.ListWorkingGroupNotesRequestObject,
) (openapi.ListWorkingGroupNotesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.workingGroups.ListNotes(ctx, p, r.Params.GroupId)
	if err != nil {
		return nil, err
	}
	out := make([]openapi.WorkingGroupNote, 0, len(items))
	for _, item := range items {
		out = append(out, workingGroupNoteDTO(item))
	}
	return openapi.ListWorkingGroupNotes200JSONResponse{Items: out}, nil
}

func (s *Server) CreateWorkingGroupNote(
	ctx context.Context,
	r openapi.CreateWorkingGroupNoteRequestObject,
) (openapi.CreateWorkingGroupNoteResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	note, err := s.workingGroups.CreateNote(ctx, p, workinggroups.CreateNoteInput{
		GroupID: r.Body.GroupId, Public: r.Body.Public, Text: r.Body.Text,
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateWorkingGroupNote201JSONResponse(workingGroupNoteDTO(note)), nil
}

func (s *Server) DeleteWorkingGroupNote(
	ctx context.Context,
	r openapi.DeleteWorkingGroupNoteRequestObject,
) (openapi.DeleteWorkingGroupNoteResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.workingGroups.DeleteNote(ctx, p, r.NoteId, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.DeleteWorkingGroupNote204Response{}, nil
}

func (s *Server) SetWorkingGroupMachineStatus(
	ctx context.Context,
	r openapi.SetWorkingGroupMachineStatusRequestObject,
) (openapi.SetWorkingGroupMachineStatusResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	group, err := s.workingGroups.SetMachineStatus(ctx, p, r.GroupId, r.MachineId, statusInput(*r.Body), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.SetWorkingGroupMachineStatus200JSONResponse(workingGroupDTO(group)), nil
}

func (s *Server) SetWorkingGroupPlaceStatus(
	ctx context.Context,
	r openapi.SetWorkingGroupPlaceStatusRequestObject,
) (openapi.SetWorkingGroupPlaceStatusResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	group, err := s.workingGroups.SetPlaceStatus(ctx, p, r.GroupId, r.PlaceId, statusInput(*r.Body), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.SetWorkingGroupPlaceStatus200JSONResponse(workingGroupDTO(group)), nil
}

func (s *Server) ListWorkingGroupStatus(
	ctx context.Context,
	_ openapi.ListWorkingGroupStatusRequestObject,
) (openapi.ListWorkingGroupStatusResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.workingGroups.ListStatus(ctx, p)
	if err != nil {
		return nil, err
	}
	out := make([]openapi.WorkingGroupStatusItem, 0, len(items))
	for _, item := range items {
		state := workingGroupStateDTO(item.State)
		dto := openapi.WorkingGroupStatusItem{
			Kind: openapi.WorkingGroupStatusItemKind(item.Kind), Id: item.ID, Name: item.Name,
			Status: state.status, Note: state.note, Until: state.until, ChangedAt: state.changedAt, ChangedBy: state.changedBy,
			DaysNotOkLast90: item.DaysNotOkLast90,
		}
		dto.Group.Id, dto.Group.Name = item.GroupID, item.GroupName
		out = append(out, dto)
	}
	return openapi.ListWorkingGroupStatus200JSONResponse{Items: out}, nil
}

func statusInput(body openapi.SetWorkingGroupStatusRequest) workinggroups.StatusInput {
	input := workinggroups.StatusInput{Usage: workinggroups.Usage(body.Status), Note: body.Note}
	if body.Until != nil {
		day := body.Until.Time
		input.Until = &day
	}
	return input
}

type workingGroupState struct {
	status    openapi.WorkingGroupStatus
	note      *string
	until     *openapi_types.Date
	changedAt *time.Time
	changedBy *openapi.WorkingGroupPerson
}

func workingGroupStateDTO(state workinggroups.ItemState) workingGroupState {
	result := workingGroupState{
		status: openapi.WorkingGroupStatus(state.Usage), note: state.Note, changedAt: state.ChangedAt,
		changedBy: workingGroupPersonDTO(state.ChangedBy),
	}
	if state.Until != nil {
		result.until = &openapi_types.Date{Time: *state.Until}
	}
	return result
}

func workingGroupNoteDTO(note workinggroups.Note) openapi.WorkingGroupNote {
	result := openapi.WorkingGroupNote{
		Id: note.ID, GroupId: note.GroupID, Public: note.Public, Text: note.Text, CreatedAt: note.CreatedAt,
		Author: workingGroupPersonDTO(note.Author), CanDelete: note.CanDelete,
	}
	if note.GroupID != nil {
		name := note.GroupName
		result.GroupName = &name
	}
	return result
}
