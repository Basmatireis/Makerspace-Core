package httpapi

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
)

func (s *Server) ListPricingGroups(
	ctx context.Context,
	_ openapi.ListPricingGroupsRequestObject,
) (openapi.ListPricingGroupsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.machineLogbook.ListPricingGroups(ctx, p)
	if err != nil {
		return nil, err
	}
	dto := make([]openapi.PricingGroup, 0, len(items))
	for _, item := range items {
		dto = append(dto, mlPricingGroupDTO(item))
	}
	return openapi.ListPricingGroups200JSONResponse{Items: dto}, nil
}

func (s *Server) CreatePricingGroup(
	ctx context.Context,
	r openapi.CreatePricingGroupRequestObject,
) (openapi.CreatePricingGroupResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.CreatePricingGroup(
		ctx,
		p,
		r.Body.Name,
		nullableStringPointer(r.Body.Description),
		r.Body.IsDefault,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.CreatePricingGroup201JSONResponse(mlPricingGroupDTO(item)), nil
}

func (s *Server) UpdatePricingGroup(
	ctx context.Context,
	r openapi.UpdatePricingGroupRequestObject,
) (openapi.UpdatePricingGroupResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.UpdatePricingGroup(
		ctx,
		p,
		r.PricingGroupId,
		r.Body.ExpectedVersion,
		r.Body.Name,
		nullableStringPointer(r.Body.Description),
		r.Body.Active,
		r.Body.IsDefault,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.UpdatePricingGroup200JSONResponse(mlPricingGroupDTO(item)), nil
}

func (s *Server) CreatePricingRule(
	ctx context.Context,
	r openapi.CreatePricingRuleRequestObject,
) (openapi.CreatePricingRuleResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.CreatePricingRule(
		ctx,
		p,
		r.PricingGroupId,
		machinelogbook.PricingRuleKind(r.Body.Kind),
		uuidNullable(r.Body.MachineTypeId),
		uuidNullable(r.Body.MaterialTypeId),
		runMeasureKeyNullable(r.Body.Measure),
		r.Body.Rate,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.CreatePricingRule201JSONResponse(mlPricingRuleDTO(item)), nil
}

func (s *Server) UpdatePricingRule(
	ctx context.Context,
	r openapi.UpdatePricingRuleRequestObject,
) (openapi.UpdatePricingRuleResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.UpdatePricingRule(
		ctx,
		p,
		r.PricingRuleId,
		r.Body.ExpectedVersion,
		machinelogbook.PricingRuleKind(r.Body.Kind),
		uuidNullable(r.Body.MachineTypeId),
		uuidNullable(r.Body.MaterialTypeId),
		runMeasureKeyNullable(r.Body.Measure),
		r.Body.Rate,
		r.Body.Active,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.UpdatePricingRule200JSONResponse(mlPricingRuleDTO(item)), nil
}

func (s *Server) SetBillingPartyPricingGroup(
	ctx context.Context,
	r openapi.SetBillingPartyPricingGroupRequestObject,
) (openapi.SetBillingPartyPricingGroupResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	_, err = s.machineLogbook.SetPartyPricingGroup(
		ctx,
		p,
		machinelogbook.PartyReference{Kind: machinelogbook.PartyKind(r.Body.Party.Kind), ID: r.Body.Party.Id},
		uuidNullable(r.Body.PricingGroupId),
		r.Body.ExpectedVersion,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.SetBillingPartyPricingGroup204Response{}, nil
}

func rolePricingGroupDTOs(items []machinelogbook.RolePricingGroup) openapi.RolePricingGroupList {
	dto := make([]openapi.RolePricingGroup, 0, len(items))
	for _, item := range items {
		dto = append(
			dto,
			openapi.RolePricingGroup{
				RoleId:           item.RoleID,
				RoleName:         item.RoleName,
				PricingGroupId:   item.PricingGroupID,
				PricingGroupName: item.PricingGroupName,
				Priority:         int(item.Priority),
			},
		)
	}
	return openapi.RolePricingGroupList{Items: dto}
}

func (s *Server) ListRolePricingGroups(
	ctx context.Context,
	_ openapi.ListRolePricingGroupsRequestObject,
) (openapi.ListRolePricingGroupsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.machineLogbook.ListRolePricingGroups(ctx, p)
	if err != nil {
		return nil, err
	}
	return openapi.ListRolePricingGroups200JSONResponse(rolePricingGroupDTOs(items)), nil
}

func (s *Server) SetRolePricingGroups(
	ctx context.Context,
	r openapi.SetRolePricingGroupsRequestObject,
) (openapi.SetRolePricingGroupsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	input := make([]machinelogbook.RolePricingGroupInput, 0, len(r.Body.Items))
	for _, item := range r.Body.Items {
		input = append(
			input,
			machinelogbook.RolePricingGroupInput{
				RoleID:         item.RoleId,
				PricingGroupID: item.PricingGroupId,
				Priority:       int32(item.Priority),
			},
		)
	}
	items, err := s.machineLogbook.SetRolePricingGroups(ctx, p, input, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.SetRolePricingGroups200JSONResponse(rolePricingGroupDTOs(items)), nil
}
