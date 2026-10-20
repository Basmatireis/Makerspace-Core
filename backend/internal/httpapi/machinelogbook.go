package httpapi

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
)

func (s *Server) ListMachineTypes(
	ctx context.Context,
	_ openapi.ListMachineTypesRequestObject,
) (openapi.ListMachineTypesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.machineLogbook.ListMachineTypes(ctx, p)
	if err != nil {
		return nil, err
	}
	dto := make([]openapi.MachineType, 0, len(items))
	for _, item := range items {
		dto = append(dto, mlMachineTypeDTO(item))
	}
	return openapi.ListMachineTypes200JSONResponse{Items: dto}, nil
}

func (s *Server) CreateMachineType(
	ctx context.Context,
	r openapi.CreateMachineTypeRequestObject,
) (openapi.CreateMachineTypeResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.CreateMachineType(ctx, p, r.Body.Name, string(r.Body.Process), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateMachineType201JSONResponse(mlMachineTypeDTO(item)), nil
}

func (s *Server) UpdateMachineType(
	ctx context.Context,
	r openapi.UpdateMachineTypeRequestObject,
) (openapi.UpdateMachineTypeResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.UpdateMachineType(
		ctx,
		p,
		r.MachineTypeId,
		r.Body.ExpectedVersion,
		r.Body.Name,
		r.Body.Active,
		machineProcessPointer(r.Body.Process),
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateMachineType200JSONResponse(mlMachineTypeDTO(item)), nil
}

func (s *Server) ListMachines(
	ctx context.Context,
	r openapi.ListMachinesRequestObject,
) (openapi.ListMachinesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, total, err := s.machineLogbook.ListMachines(
		ctx,
		p,
		defaultString(r.Params.Search),
		stringEnum(r.Params.Status),
		defaultInt(r.Params.Page, 1),
		defaultInt(r.Params.PageSize, 25),
	)
	if err != nil {
		return nil, err
	}
	dto := make([]openapi.Machine, 0, len(items))
	for _, item := range items {
		dto = append(dto, mlMachineDTO(item))
	}
	return openapi.ListMachines200JSONResponse{
		Items:    dto,
		Page:     defaultInt(r.Params.Page, 1),
		PageSize: defaultInt(r.Params.PageSize, 25),
		Total:    total,
	}, nil
}

func (s *Server) CreateMachine(
	ctx context.Context,
	r openapi.CreateMachineRequestObject,
) (openapi.CreateMachineResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.CreateMachine(
		ctx,
		p,
		r.Body.MachineTypeId,
		r.Body.Name,
		string(r.Body.Status),
		nullableStringPointer(r.Body.ExternalIdentifier),
		r.Body.AutomaticCollectionEnabled,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.CreateMachine201JSONResponse(mlMachineDTO(item)), nil
}

func (s *Server) GetMachine(
	ctx context.Context,
	r openapi.GetMachineRequestObject,
) (openapi.GetMachineResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	item, err := s.machineLogbook.GetMachine(ctx, p, r.MachineId)
	if err != nil {
		return nil, err
	}
	return openapi.GetMachine200JSONResponse(mlMachineDTO(item)), nil
}

func (s *Server) UpdateMachine(
	ctx context.Context,
	r openapi.UpdateMachineRequestObject,
) (openapi.UpdateMachineResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.UpdateMachine(
		ctx,
		p,
		r.MachineId,
		r.Body.ExpectedVersion,
		r.Body.MachineTypeId,
		r.Body.Name,
		string(r.Body.Status),
		nullableStringPointer(r.Body.ExternalIdentifier),
		r.Body.AutomaticCollectionEnabled,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateMachine200JSONResponse(mlMachineDTO(item)), nil
}

func (s *Server) DeleteMachine(
	ctx context.Context,
	r openapi.DeleteMachineRequestObject,
) (openapi.DeleteMachineResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err = s.machineLogbook.DeleteMachine(
		ctx,
		p,
		r.MachineId,
		r.Body.ExpectedVersion,
		requestIDPointer(ctx),
	); err != nil {
		return nil, err
	}
	return openapi.DeleteMachine204Response{}, nil
}

func (s *Server) ListOrganizations(
	ctx context.Context,
	r openapi.ListOrganizationsRequestObject,
) (openapi.ListOrganizationsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	var kind *string
	if r.Params.Kind != nil {
		k := string(*r.Params.Kind)
		kind = &k
	}
	items, total, err := s.machineLogbook.ListOrganizations(
		ctx,
		p,
		machinelogbook.OrganizationFilters{
			Search:         defaultString(r.Params.Search),
			Active:         r.Params.Active,
			Kind:           kind,
			PricingGroupID: r.Params.PricingGroupId,
			Page:           defaultInt(r.Params.Page, 1),
			PageSize:       defaultInt(r.Params.PageSize, 25),
		},
	)
	if err != nil {
		return nil, err
	}
	dto := make([]openapi.Organization, 0, len(items))
	for _, item := range items {
		dto = append(dto, mlOrganizationDTO(item))
	}
	return openapi.ListOrganizations200JSONResponse{
		Items:    dto,
		Page:     defaultInt(r.Params.Page, 1),
		PageSize: defaultInt(r.Params.PageSize, 25),
		Total:    total,
	}, nil
}

func (s *Server) CreateOrganization(
	ctx context.Context,
	r openapi.CreateOrganizationRequestObject,
) (openapi.CreateOrganizationResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.CreateOrganization(
		ctx,
		p,
		r.Body.Name,
		string(r.Body.Kind),
		machinelogbook.OrganizationDetailsInput{
			AddressLine:  r.Body.AddressLine,
			PostalCode:   r.Body.PostalCode,
			Locality:     r.Body.Locality,
			CountryCode:  r.Body.CountryCode,
			ContactName:  r.Body.ContactName,
			ContactEmail: r.Body.ContactEmail,
		},
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.CreateOrganization201JSONResponse(mlOrganizationDTO(item)), nil
}

func (s *Server) UpdateOrganization(
	ctx context.Context,
	r openapi.UpdateOrganizationRequestObject,
) (openapi.UpdateOrganizationResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.UpdateOrganization(
		ctx,
		p,
		r.OrganizationId,
		r.Body.ExpectedVersion,
		r.Body.Name,
		string(r.Body.Kind),
		r.Body.Active,
		machinelogbook.OrganizationDetailsInput{
			AddressLine:  r.Body.AddressLine,
			PostalCode:   r.Body.PostalCode,
			Locality:     r.Body.Locality,
			CountryCode:  r.Body.CountryCode,
			ContactName:  r.Body.ContactName,
			ContactEmail: r.Body.ContactEmail,
		},
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateOrganization200JSONResponse(mlOrganizationDTO(item)), nil
}

func (s *Server) DeleteOrganization(
	ctx context.Context,
	r openapi.DeleteOrganizationRequestObject,
) (openapi.DeleteOrganizationResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err = s.machineLogbook.DeleteOrganization(
		ctx,
		p,
		r.OrganizationId,
		r.Body.ExpectedVersion,
		requestIDPointer(ctx),
	); err != nil {
		return nil, err
	}
	return openapi.DeleteOrganization204Response{}, nil
}

func (s *Server) GetOrganization(
	ctx context.Context,
	r openapi.GetOrganizationRequestObject,
) (openapi.GetOrganizationResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	item, err := s.machineLogbook.GetOrganization(ctx, p, r.OrganizationId)
	if err != nil {
		return nil, err
	}
	return openapi.GetOrganization200JSONResponse(mlOrganizationDTO(item)), nil
}

func (s *Server) ListOrganizationMembers(
	ctx context.Context,
	r openapi.ListOrganizationMembersRequestObject,
) (openapi.ListOrganizationMembersResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.machineLogbook.ListOrganizationMembers(ctx, p, r.OrganizationId)
	if err != nil {
		return nil, err
	}
	dto := make([]openapi.OrganizationMember, 0, len(items))
	for _, item := range items {
		dto = append(
			dto,
			openapi.OrganizationMember{PersonId: item.PersonID, DisplayName: item.DisplayName, AddedAt: item.AddedAt},
		)
	}
	return openapi.ListOrganizationMembers200JSONResponse{Items: dto}, nil
}

func (s *Server) AddOrganizationMember(
	ctx context.Context,
	r openapi.AddOrganizationMemberRequestObject,
) (openapi.AddOrganizationMemberResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.AddOrganizationMember(
		ctx,
		p,
		r.OrganizationId,
		r.Body.PersonId,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.AddOrganizationMember201JSONResponse(
		openapi.OrganizationMember{PersonId: item.PersonID, DisplayName: item.DisplayName, AddedAt: item.AddedAt},
	), nil
}

func (s *Server) RemoveOrganizationMember(
	ctx context.Context,
	r openapi.RemoveOrganizationMemberRequestObject,
) (openapi.RemoveOrganizationMemberResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err = s.machineLogbook.RemoveOrganizationMember(
		ctx,
		p,
		r.OrganizationId,
		r.PersonId,
		requestIDPointer(ctx),
	); err != nil {
		return nil, err
	}
	return openapi.RemoveOrganizationMember204Response{}, nil
}

func (s *Server) SearchBillingParties(
	ctx context.Context,
	r openapi.SearchBillingPartiesRequestObject,
) (openapi.SearchBillingPartiesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.machineLogbook.SearchBillingParties(
		ctx,
		p,
		defaultString(r.Params.Search),
		defaultInt(r.Params.Limit, 20),
	)
	if err != nil {
		return nil, err
	}
	dto := make([]openapi.BillingParty, 0, len(items))
	for _, item := range items {
		dto = append(dto, mlBillingPartyDTO(item))
	}
	return openapi.SearchBillingParties200JSONResponse{Items: dto}, nil
}

func (s *Server) SearchMachineJobOperators(
	ctx context.Context,
	r openapi.SearchMachineJobOperatorsRequestObject,
) (openapi.SearchMachineJobOperatorsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.machineLogbook.SearchOperators(
		ctx,
		p,
		defaultString(r.Params.Search),
		defaultInt(r.Params.Limit, 20),
	)
	if err != nil {
		return nil, err
	}
	dto := make([]openapi.Operator, 0, len(items))
	for _, item := range items {
		dto = append(dto, mlOperatorDTO(item))
	}
	return openapi.SearchMachineJobOperators200JSONResponse{Items: dto}, nil
}

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
		string(r.Body.Kind),
		uuidNullable(r.Body.MachineTypeId),
		uuidNullable(r.Body.MaterialTypeId),
		runMeasureKeyNullable(r.Body.Measure),
		string(r.Body.Rate),
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
		string(r.Body.Kind),
		uuidNullable(r.Body.MachineTypeId),
		uuidNullable(r.Body.MaterialTypeId),
		runMeasureKeyNullable(r.Body.Measure),
		string(r.Body.Rate),
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
		machinelogbook.PartyReference{Kind: string(r.Body.Party.Kind), ID: r.Body.Party.Id},
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

func (s *Server) ListMaterials(
	ctx context.Context,
	r openapi.ListMaterialsRequestObject,
) (openapi.ListMaterialsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, total, value, err := s.machineLogbook.ListMaterials(
		ctx,
		p,
		defaultString(r.Params.Search),
		r.Params.MaterialTypeId,
		valueString(r.Params.StockState),
		defaultInt(r.Params.Page, 1),
		defaultInt(r.Params.PageSize, 25),
	)
	if err != nil {
		return nil, err
	}
	dto := make([]openapi.Material, 0, len(items))
	for _, item := range items {
		dto = append(dto, mlMaterialDTO(item))
	}
	return openapi.ListMaterials200JSONResponse{
		Items:               dto,
		Page:                defaultInt(r.Params.Page, 1),
		PageSize:            defaultInt(r.Params.PageSize, 25),
		Total:               total,
		TotalInventoryValue: value,
	}, nil
}

func (s *Server) CreateMaterial(
	ctx context.Context,
	r openapi.CreateMaterialRequestObject,
) (openapi.CreateMaterialResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	unit := materialUnitPointer(r.Body.Unit)
	item, err := s.machineLogbook.CreateMaterial(
		ctx,
		p,
		machinelogbook.MaterialInput{
			Name:           r.Body.Name,
			MaterialTypeID: r.Body.MaterialTypeId,
			Unit:           unit,
			ColorName:      nullableStringPointer(r.Body.ColorName),
			ColorHex:       nullableStringPointer(r.Body.ColorHex),
			LowStockThreshold: decimalNullable(
				r.Body.LowStockThreshold,
			),
			FilamentDiameterMM: decimalNullable(r.Body.FilamentDiameterMm),
		},
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.CreateMaterial201JSONResponse(mlMaterialDTO(item)), nil
}

func (s *Server) GetMaterial(
	ctx context.Context,
	r openapi.GetMaterialRequestObject,
) (openapi.GetMaterialResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	item, err := s.machineLogbook.GetMaterial(ctx, p, r.MaterialId)
	if err != nil {
		return nil, err
	}
	return openapi.GetMaterial200JSONResponse(mlMaterialDTO(item)), nil
}

func (s *Server) UpdateMaterial(
	ctx context.Context,
	r openapi.UpdateMaterialRequestObject,
) (openapi.UpdateMaterialResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	diameter := decimalNullable(r.Body.FilamentDiameterMm)
	if !r.Body.FilamentDiameterMm.IsSpecified() {
		current, getErr := s.machineLogbook.GetMaterial(ctx, p, r.MaterialId)
		if getErr != nil {
			return nil, getErr
		}
		diameter = current.FilamentDiameterMM
	}
	item, err := s.machineLogbook.UpdateMaterial(
		ctx,
		p,
		r.MaterialId,
		machinelogbook.MaterialInput{
			Name:           r.Body.Name,
			MaterialTypeID: r.Body.MaterialTypeId,
			Unit:           materialUnitPointer(r.Body.Unit),
			ColorName:      nullableStringPointer(r.Body.ColorName),
			ColorHex:       nullableStringPointer(r.Body.ColorHex),
			LowStockThreshold: decimalNullable(
				r.Body.LowStockThreshold,
			),
			FilamentDiameterMM: diameter,
			Active:             r.Body.Active,
			ExpectedVersion:    r.Body.ExpectedVersion,
		},
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateMaterial200JSONResponse(mlMaterialDTO(item)), nil
}

func (s *Server) AddMaterialPurchase(
	ctx context.Context,
	r openapi.AddMaterialPurchaseRequestObject,
) (openapi.AddMaterialPurchaseResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.AddPurchase(
		ctx,
		p,
		r.MaterialId,
		r.Body.ExpectedInventoryVersion,
		string(r.Body.Quantity),
		string(r.Body.TotalPrice),
		r.Body.OccurredAt,
		nullableStringPointer(r.Body.Supplier),
		nullableStringPointer(r.Body.Note),
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.AddMaterialPurchase201JSONResponse(mlInventoryResultDTO(item)), nil
}

func (s *Server) RecordMaterialConsumption(
	ctx context.Context,
	r openapi.RecordMaterialConsumptionRequestObject,
) (openapi.RecordMaterialConsumptionResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.RecordConsumption(
		ctx,
		p,
		r.MaterialId,
		r.Body.ExpectedInventoryVersion,
		string(r.Body.Quantity),
		r.Body.OccurredAt,
		r.Body.Disposal,
		nullableStringPointer(r.Body.Reason),
		nullableStringPointer(r.Body.Note),
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.RecordMaterialConsumption201JSONResponse(mlInventoryResultDTO(item)), nil
}

func (s *Server) CorrectMaterialStock(
	ctx context.Context,
	r openapi.CorrectMaterialStockRequestObject,
) (openapi.CorrectMaterialStockResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.CorrectStock(
		ctx,
		p,
		r.MaterialId,
		r.Body.ExpectedInventoryVersion,
		string(r.Body.PhysicalQuantity),
		decimalNullable(r.Body.AcquisitionUnitCost),
		r.Body.OccurredAt,
		string(r.Body.Reason),
		nullableStringPointer(r.Body.Note),
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.CorrectMaterialStock201JSONResponse(mlInventoryResultDTO(item)), nil
}

func (s *Server) MarkMaterialEmpty(
	ctx context.Context,
	r openapi.MarkMaterialEmptyRequestObject,
) (openapi.MarkMaterialEmptyResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.MarkEmpty(
		ctx,
		p,
		r.MaterialId,
		r.Body.ExpectedInventoryVersion,
		r.Body.OccurredAt,
		nullableStringPointer(r.Body.Note),
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.MarkMaterialEmpty201JSONResponse(mlInventoryResultDTO(item)), nil
}

func (s *Server) ListMaterialTransactions(
	ctx context.Context,
	r openapi.ListMaterialTransactionsRequestObject,
) (openapi.ListMaterialTransactionsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, total, err := s.machineLogbook.ListMaterialTransactions(
		ctx,
		p,
		r.MaterialId,
		defaultInt(r.Params.Page, 1),
		defaultInt(r.Params.PageSize, 25),
	)
	if err != nil {
		return nil, err
	}
	dto := make([]openapi.InventoryTransaction, 0, len(items))
	for _, item := range items {
		dto = append(dto, mlInventoryTransactionDTO(item))
	}
	return openapi.ListMaterialTransactions200JSONResponse{
		Items:    dto,
		Page:     defaultInt(r.Params.Page, 1),
		PageSize: defaultInt(r.Params.PageSize, 25),
		Total:    total,
	}, nil
}

func (s *Server) ListMachineJobs(
	ctx context.Context,
	r openapi.ListMachineJobsRequestObject,
) (openapi.ListMachineJobsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, total, err := s.machineLogbook.ListJobs(
		ctx,
		p,
		machinelogbook.JobFilters{
			Search:     defaultString(r.Params.Search),
			MachineID:  r.Params.MachineId,
			CustomerID: r.Params.CustomerId,
			OperatorID: r.Params.OperatorPersonId,
			MaterialID: r.Params.MaterialId,
			Outcome:    stringEnum(r.Params.Outcome),
			From:       r.Params.From,
			To:         r.Params.To,
			Page:       defaultInt(r.Params.Page, 1),
			PageSize:   defaultInt(r.Params.PageSize, 25),
		},
	)
	if err != nil {
		return nil, err
	}
	dto := make([]openapi.MachineJob, 0, len(items))
	for _, item := range items {
		dto = append(dto, mlJobDTO(item))
	}
	return openapi.ListMachineJobs200JSONResponse{
		Items:    dto,
		Page:     defaultInt(r.Params.Page, 1),
		PageSize: defaultInt(r.Params.PageSize, 25),
		Total:    total,
	}, nil
}

func (s *Server) CreateMachineJob(
	ctx context.Context,
	r openapi.CreateMachineJobRequestObject,
) (openapi.CreateMachineJobResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	run := manualRunInput(r.Body.Run)
	outcome := ""
	if run.Outcome != nil {
		outcome = *run.Outcome
	}
	item, err := s.machineLogbook.CreateManualJob(
		ctx,
		p,
		machinelogbook.JobInput{
			MachineID:        r.Body.MachineId,
			StartsAt:         run.StartsAt,
			EndsAt:           run.EndsAt,
			Customer:         partyInput(r.Body.Customer),
			OperatorPersonID: r.Body.OperatorPersonId,
			Outcome:          outcome,
			Title:            nullableStringPointer(r.Body.Title),
			Notes:            nullableStringPointer(r.Body.Notes),
			PricingGroupID:   uuidNullable(r.Body.PricingGroupId),
			Usages:           run.Usages,
			Measures:         run.Measures,
		},
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.CreateMachineJob201JSONResponse(mlJobDTO(item)), nil
}

func (s *Server) GetMachineJob(
	ctx context.Context,
	r openapi.GetMachineJobRequestObject,
) (openapi.GetMachineJobResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	item, err := s.machineLogbook.GetJob(ctx, p, r.MachineJobId)
	if err != nil {
		return nil, err
	}
	return openapi.GetMachineJob200JSONResponse(mlJobDTO(item)), nil
}

func (s *Server) UpdateMachineJob(
	ctx context.Context,
	r openapi.UpdateMachineJobRequestObject,
) (openapi.UpdateMachineJobResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	customer := machinelogbook.PartyReference{}
	if r.Body.Customer != nil {
		customer = partyInput(*r.Body.Customer)
	}
	item, err := s.machineLogbook.UpdateJobFacts(
		ctx,
		p,
		r.MachineJobId,
		r.Body.ExpectedVersion,
		machinelogbook.JobUpdate{
			MachineID:        r.Body.MachineId,
			Customer:         customer,
			OperatorPersonID: r.Body.OperatorPersonId,
			OutcomeOverride:  nullableStringPointer(r.Body.OutcomeOverride),
			Title:            nullableStringPointer(r.Body.Title),
			Notes:            nullableStringPointer(r.Body.Notes),
			PricingGroupID:   uuidNullable(r.Body.PricingGroupId),
		},
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateMachineJob200JSONResponse(mlJobDTO(item)), nil
}

func (s *Server) SetMachineJobPriceAdjustment(
	ctx context.Context,
	r openapi.SetMachineJobPriceAdjustmentRequestObject,
) (openapi.SetMachineJobPriceAdjustmentResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.SetJobPriceAdjustment(
		ctx,
		p,
		r.MachineJobId,
		r.Body.ExpectedVersion,
		string(r.Body.Kind),
		string(r.Body.Value),
		r.Body.Reason,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.SetMachineJobPriceAdjustment200JSONResponse(mlJobDTO(item)), nil
}

func (s *Server) ClearMachineJobPriceAdjustment(
	ctx context.Context,
	r openapi.ClearMachineJobPriceAdjustmentRequestObject,
) (openapi.ClearMachineJobPriceAdjustmentResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.ClearJobPriceAdjustment(
		ctx,
		p,
		r.MachineJobId,
		r.Body.ExpectedVersion,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.ClearMachineJobPriceAdjustment200JSONResponse(mlJobDTO(item)), nil
}
func derefSlice[T any](values *[]T) []T {
	if values == nil {
		return nil
	}
	return *values
}
func stringSlice[T ~string](values *[]T) []string {
	result := make([]string, 0, len(derefSlice(values)))
	for _, v := range derefSlice(values) {
		result = append(result, string(v))
	}
	return result
}

func (s *Server) ListMachineLogbookWorkItems(
	ctx context.Context,
	r openapi.ListMachineLogbookWorkItemsRequestObject,
) (openapi.ListMachineLogbookWorkItemsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	page, size := defaultInt(r.Params.Page, 1), defaultInt(r.Params.PageSize, 25)
	items, total, err := s.machineLogbook.ListWorkItems(
		ctx,
		p,
		machinelogbook.WorkItemFilters{
			Search:   defaultString(r.Params.Search),
			Statuses: stringSlice(r.Params.Status),
			Sources:  stringSlice(r.Params.Source),
			Billing: stringSlice(
				r.Params.Billing,
			),
			MachineIDs:  derefSlice(r.Params.MachineId),
			MaterialIDs: derefSlice(r.Params.MaterialId),
			CustomerID:  r.Params.CustomerId,
			OperatorID:  r.Params.OperatorPersonId,
			From:        r.Params.From,
			To:          r.Params.To,
			Sort:        defaultString(stringEnum(r.Params.Sort)),
			Direction:   defaultString(stringEnum(r.Params.Direction)),
			Page:        page,
			PageSize:    size,
		},
	)
	if err != nil {
		return nil, err
	}
	return openapi.ListMachineLogbookWorkItems200JSONResponse{
		Items:    mlWorkItemDTOs(items),
		Page:     page,
		PageSize: size,
		Total:    total,
	}, nil
}

func (s *Server) ListMachineActivity(
	ctx context.Context,
	_ openapi.ListMachineActivityRequestObject,
) (openapi.ListMachineActivityResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.machineLogbook.MachineActivity(ctx, p)
	if err != nil {
		return nil, err
	}
	dto := make([]openapi.MachineActivity, 0, len(items))
	for _, item := range items {
		dto = append(dto, mlMachineActivityDTO(item))
	}
	return openapi.ListMachineActivity200JSONResponse{Items: dto}, nil
}

func (s *Server) GetMachineLogbookOverview(
	ctx context.Context,
	_ openapi.GetMachineLogbookOverviewRequestObject,
) (openapi.GetMachineLogbookOverviewResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	item, err := s.machineLogbook.Overview(ctx, p)
	if err != nil {
		return nil, err
	}
	return openapi.GetMachineLogbookOverview200JSONResponse(mlOverviewDTO(item)), nil
}

func (s *Server) GetMachineLogbookStatistics(
	ctx context.Context,
	r openapi.GetMachineLogbookStatisticsRequestObject,
) (openapi.GetMachineLogbookStatisticsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	from, to := utcDayBounds(r.Params.From.Time, r.Params.To.Time)
	item, err := s.machineLogbook.Statistics(ctx, p, from, to)
	if err != nil {
		return nil, err
	}
	return openapi.GetMachineLogbookStatistics200JSONResponse(mlStatisticsDTO(item)), nil
}

func valueString[T ~string](value *T) string {
	if value == nil {
		return ""
	}
	return string(*value)
}

func (s *Server) DeleteMachineJob(
	ctx context.Context,
	r openapi.DeleteMachineJobRequestObject,
) (openapi.DeleteMachineJobResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err := s.machineLogbook.DeleteJob(
		ctx,
		p,
		r.MachineJobId,
		machinelogbook.DeleteJobInput{
			ExpectedVersion:    r.Body.ExpectedVersion,
			ReverseConsumption: r.Body.ReverseConsumption,
			DeleteRecordedRuns: r.Body.DeleteRecordedRuns,
		},
		requestIDPointer(ctx),
	); err != nil {
		return nil, err
	}
	return openapi.DeleteMachineJob204Response{}, nil
}

func (s *Server) ListMaterialTypes(
	ctx context.Context,
	_ openapi.ListMaterialTypesRequestObject,
) (openapi.ListMaterialTypesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.machineLogbook.ListMaterialTypes(ctx, p)
	if err != nil {
		return nil, err
	}
	dto := make([]openapi.MaterialType, 0, len(items))
	for _, item := range items {
		dto = append(dto, mlMaterialTypeDTO(item))
	}
	return openapi.ListMaterialTypes200JSONResponse{Items: dto}, nil
}

func (s *Server) CreateMaterialType(
	ctx context.Context,
	r openapi.CreateMaterialTypeRequestObject,
) (openapi.CreateMaterialTypeResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.CreateMaterialType(
		ctx,
		p,
		r.Body.Name,
		string(r.Body.Unit),
		machineProcessStrings(r.Body.Processes),
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.CreateMaterialType201JSONResponse(mlMaterialTypeDTO(item)), nil
}

func (s *Server) GetMaterialType(
	ctx context.Context,
	r openapi.GetMaterialTypeRequestObject,
) (openapi.GetMaterialTypeResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	item, err := s.machineLogbook.GetMaterialType(ctx, p, r.MaterialTypeId)
	if err != nil {
		return nil, err
	}
	return openapi.GetMaterialType200JSONResponse(mlMaterialTypeDTO(item)), nil
}

func (s *Server) UpdateMaterialType(
	ctx context.Context,
	r openapi.UpdateMaterialTypeRequestObject,
) (openapi.UpdateMaterialTypeResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.machineLogbook.UpdateMaterialType(
		ctx,
		p,
		r.MaterialTypeId,
		r.Body.ExpectedVersion,
		r.Body.Name,
		string(r.Body.Unit),
		machineProcessStringsPointer(r.Body.Processes),
		r.Body.Active,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateMaterialType200JSONResponse(mlMaterialTypeDTO(item)), nil
}

func (s *Server) DeleteMaterialType(
	ctx context.Context,
	r openapi.DeleteMaterialTypeRequestObject,
) (openapi.DeleteMaterialTypeResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err = s.machineLogbook.DeleteMaterialType(
		ctx,
		p,
		r.MaterialTypeId,
		r.Body.ExpectedVersion,
		requestIDPointer(ctx),
	); err != nil {
		return nil, err
	}
	return openapi.DeleteMaterialType204Response{}, nil
}
