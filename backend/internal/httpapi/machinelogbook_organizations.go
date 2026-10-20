package httpapi

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
)

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
			Kind:           enumPointer[machinelogbook.OrganizationKind](kind),
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
		machinelogbook.OrganizationKind(r.Body.Kind),
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
		machinelogbook.OrganizationKind(r.Body.Kind),
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
