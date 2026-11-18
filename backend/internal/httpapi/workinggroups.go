package httpapi

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/workinggroups"
)

func (s *Server) ListWorkingGroups(
	ctx context.Context,
	_ openapi.ListWorkingGroupsRequestObject,
) (openapi.ListWorkingGroupsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.workingGroups.List(ctx, p)
	if err != nil {
		return nil, err
	}
	out := make([]openapi.WorkingGroupSummary, 0, len(items))
	for _, item := range items {
		out = append(out, workingGroupSummaryDTO(item))
	}
	return openapi.ListWorkingGroups200JSONResponse{Items: out}, nil
}

func (s *Server) CreateWorkingGroup(
	ctx context.Context,
	r openapi.CreateWorkingGroupRequestObject,
) (openapi.CreateWorkingGroupResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	group, err := s.workingGroups.Create(ctx, p, workinggroups.CreateInput{
		Name:         r.Body.Name,
		Description:  r.Body.Description,
		LeadPersonID: r.Body.LeadPersonId,
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateWorkingGroup201JSONResponse(workingGroupDTO(group)), nil
}

func (s *Server) GetWorkingGroup(
	ctx context.Context,
	r openapi.GetWorkingGroupRequestObject,
) (openapi.GetWorkingGroupResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	group, err := s.workingGroups.Get(ctx, p, r.GroupId)
	if err != nil {
		return nil, err
	}
	return openapi.GetWorkingGroup200JSONResponse(workingGroupDTO(group)), nil
}

func (s *Server) UpdateWorkingGroup(
	ctx context.Context,
	r openapi.UpdateWorkingGroupRequestObject,
) (openapi.UpdateWorkingGroupResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input := workinggroups.UpdateInput{
		ExpectedVersion: r.Body.ExpectedVersion,
		Name:            r.Body.Name,
		Description:     r.Body.Description,
	}
	if r.Body.ChatUrl.IsSpecified() {
		input.ChatURL = workinggroups.OptionalText{Set: true, Value: nullableStringPointer(r.Body.ChatUrl)}
	}
	group, err := s.workingGroups.Update(ctx, p, r.GroupId, input, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateWorkingGroup200JSONResponse(workingGroupDTO(group)), nil
}

func (s *Server) DeleteWorkingGroup(
	ctx context.Context,
	r openapi.DeleteWorkingGroupRequestObject,
) (openapi.DeleteWorkingGroupResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.workingGroups.Delete(ctx, p, r.GroupId, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.DeleteWorkingGroup204Response{}, nil
}

func (s *Server) AddWorkingGroupMember(
	ctx context.Context,
	r openapi.AddWorkingGroupMemberRequestObject,
) (openapi.AddWorkingGroupMemberResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	group, err := s.workingGroups.AddMember(ctx, p, r.GroupId, r.Body.PersonId, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.AddWorkingGroupMember200JSONResponse(workingGroupDTO(group)), nil
}

func (s *Server) RemoveWorkingGroupMember(
	ctx context.Context,
	r openapi.RemoveWorkingGroupMemberRequestObject,
) (openapi.RemoveWorkingGroupMemberResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	group, err := s.workingGroups.RemoveMember(ctx, p, r.GroupId, r.PersonId, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.RemoveWorkingGroupMember200JSONResponse(workingGroupDTO(group)), nil
}

func (s *Server) SetWorkingGroupLead(
	ctx context.Context,
	r openapi.SetWorkingGroupLeadRequestObject,
) (openapi.SetWorkingGroupLeadResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	group, err := s.workingGroups.SetLead(ctx, p, r.GroupId, r.Body.PersonId, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.SetWorkingGroupLead200JSONResponse(workingGroupDTO(group)), nil
}

func (s *Server) SetWorkingGroupMachines(
	ctx context.Context,
	r openapi.SetWorkingGroupMachinesRequestObject,
) (openapi.SetWorkingGroupMachinesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	group, err := s.workingGroups.SetMachines(ctx, p, r.GroupId, r.Body.MachineIds, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.SetWorkingGroupMachines200JSONResponse(workingGroupDTO(group)), nil
}

func (s *Server) AddWorkingGroupPlace(
	ctx context.Context,
	r openapi.AddWorkingGroupPlaceRequestObject,
) (openapi.AddWorkingGroupPlaceResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	group, err := s.workingGroups.AddPlace(ctx, p, r.GroupId, r.Body.Name, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.AddWorkingGroupPlace200JSONResponse(workingGroupDTO(group)), nil
}

func (s *Server) RemoveWorkingGroupPlace(
	ctx context.Context,
	r openapi.RemoveWorkingGroupPlaceRequestObject,
) (openapi.RemoveWorkingGroupPlaceResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	group, err := s.workingGroups.RemovePlace(ctx, p, r.GroupId, r.PlaceId, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.RemoveWorkingGroupPlace200JSONResponse(workingGroupDTO(group)), nil
}

func (s *Server) ListWorkingGroupPeople(
	ctx context.Context,
	r openapi.ListWorkingGroupPeopleRequestObject,
) (openapi.ListWorkingGroupPeopleResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	search := ""
	if r.Params.Search != nil {
		search = *r.Params.Search
	}
	items, err := s.workingGroups.FindPeople(ctx, p, search)
	if err != nil {
		return nil, err
	}
	out := make([]openapi.WorkingGroupPersonOption, 0, len(items))
	for _, item := range items {
		out = append(out, openapi.WorkingGroupPersonOption{Id: item.ID, DisplayName: item.DisplayName})
	}
	return openapi.ListWorkingGroupPeople200JSONResponse{Items: out}, nil
}

func (s *Server) ListWorkingGroupMachines(
	ctx context.Context,
	_ openapi.ListWorkingGroupMachinesRequestObject,
) (openapi.ListWorkingGroupMachinesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.workingGroups.ListMachineOptions(ctx, p)
	if err != nil {
		return nil, err
	}
	out := make([]openapi.WorkingGroupMachineOption, 0, len(items))
	for _, item := range items {
		out = append(out, openapi.WorkingGroupMachineOption{
			Id: item.ID, Name: item.Name, WorkingGroupId: item.GroupID, WorkingGroupName: item.GroupName,
		})
	}
	return openapi.ListWorkingGroupMachines200JSONResponse{Items: out}, nil
}

func workingGroupSummaryDTO(item workinggroups.Summary) openapi.WorkingGroupSummary {
	result := openapi.WorkingGroupSummary{
		Id:           item.ID,
		Name:         item.Name,
		Description:  item.Description,
		MemberCount:  item.MemberCount,
		MachineCount: item.MachineCount,
		IsMember:     item.IsMember,
		IsLead:       item.IsLead,
	}
	if item.Lead != nil {
		result.Lead = &openapi.WorkingGroupPerson{PersonId: item.Lead.ID, DisplayName: item.Lead.DisplayName}
	}
	return result
}

func workingGroupDTO(item workinggroups.Group) openapi.WorkingGroup {
	summary := workingGroupSummaryDTO(item.Summary)
	result := openapi.WorkingGroup{
		Id:           summary.Id,
		Name:         summary.Name,
		Description:  summary.Description,
		Lead:         summary.Lead,
		MemberCount:  summary.MemberCount,
		MachineCount: summary.MachineCount,
		IsMember:     summary.IsMember,
		IsLead:       summary.IsLead,
		Version:      item.Version,
		ChatUrl:      item.ChatURL,
		Members:      make([]openapi.WorkingGroupMember, 0, len(item.Members)),
		Machines:     make([]openapi.WorkingGroupMachine, 0, len(item.Machines)),
		Places:       make([]openapi.WorkingGroupPlace, 0, len(item.Places)),
		Columns:      make([]openapi.WorkingGroupColumn, 0, len(item.Columns)),
		CanEdit:      item.CanEdit,
		CanManage:    item.CanManage,
	}
	for _, m := range item.Members {
		result.Members = append(result.Members, openapi.WorkingGroupMember{
			PersonId: m.PersonID, DisplayName: m.DisplayName, IsLead: m.IsLead, JoinedAt: m.JoinedAt,
		})
	}
	for _, m := range item.Machines {
		result.Machines = append(result.Machines, openapi.WorkingGroupMachine{Id: m.ID, Name: m.Name})
	}
	for _, place := range item.Places {
		result.Places = append(result.Places, openapi.WorkingGroupPlace{Id: place.ID, Name: place.Name})
	}
	for _, column := range item.Columns {
		result.Columns = append(result.Columns, openapi.WorkingGroupColumn{Id: column.ID, Name: column.Name})
	}
	return result
}
