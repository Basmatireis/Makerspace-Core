package httpapi

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/signage"
)

// Display groups ----------------------------------------------------------------------------------------------

func signagePendingChangesDTO(changes []signage.PendingChange) []openapi.SignagePendingChange {
	pending := make([]openapi.SignagePendingChange, 0, len(changes))
	for _, change := range changes {
		pending = append(pending, openapi.SignagePendingChange{
			Kind:   openapi.SignagePendingChangeKind(change.Kind),
			Name:   change.Name,
			Change: openapi.SignagePendingChangeType(change.Change),
		})
	}
	return pending
}

func signageDisplayGroupDTO(group signage.Group) openapi.SignageDisplayGroup {
	return openapi.SignageDisplayGroup{
		Id:             group.ID,
		Name:           group.Name,
		AspectRatio:    signageAspectRatioDTO(group.AspectRatio),
		DefaultScenes:  signageSceneListDTO(group.DefaultScenes),
		DisplayIds:     append([]openapi.UUIDv7{}, group.DisplayIDs...),
		PendingChanges: signagePendingChangesDTO(group.PendingChanges),
		Version:        group.Version,
		CreatedAt:      group.CreatedAt,
		UpdatedAt:      group.UpdatedAt,
	}
}

func (s *Server) ListSignageDisplayGroups(
	ctx context.Context,
	_ openapi.ListSignageDisplayGroupsRequestObject,
) (openapi.ListSignageDisplayGroupsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	groups, err := s.signage.ListGroups(ctx, p)
	if err != nil {
		return nil, err
	}
	items := make([]openapi.SignageDisplayGroup, 0, len(groups))
	for _, group := range groups {
		items = append(items, signageDisplayGroupDTO(group))
	}
	return openapi.ListSignageDisplayGroups200JSONResponse{Items: items}, nil
}

func (s *Server) CreateSignageDisplayGroup(
	ctx context.Context,
	r openapi.CreateSignageDisplayGroupRequestObject,
) (openapi.CreateSignageDisplayGroupResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	group, err := s.signage.CreateGroup(ctx, p, signage.GroupInput{
		Name: r.Body.Name, AspectRatio: signageAspectRatio(r.Body.AspectRatio),
		DefaultScenes: signageSceneList(r.Body.DefaultScenes),
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateSignageDisplayGroup201JSONResponse(signageDisplayGroupDTO(group)), nil
}

func (s *Server) GetSignageDisplayGroup(
	ctx context.Context,
	r openapi.GetSignageDisplayGroupRequestObject,
) (openapi.GetSignageDisplayGroupResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	group, err := s.signage.GetGroup(ctx, p, r.GroupId)
	if err != nil {
		return nil, err
	}
	return openapi.GetSignageDisplayGroup200JSONResponse(signageDisplayGroupDTO(group)), nil
}

func (s *Server) UpdateSignageDisplayGroup(
	ctx context.Context,
	r openapi.UpdateSignageDisplayGroupRequestObject,
) (openapi.UpdateSignageDisplayGroupResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	group, err := s.signage.UpdateGroup(ctx, p, r.GroupId, r.Body.ExpectedVersion, signage.GroupInput{
		Name: r.Body.Name, AspectRatio: signageAspectRatio(r.Body.AspectRatio),
		DefaultScenes: signageSceneList(r.Body.DefaultScenes),
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateSignageDisplayGroup200JSONResponse(signageDisplayGroupDTO(group)), nil
}

func (s *Server) DeleteSignageDisplayGroup(
	ctx context.Context,
	r openapi.DeleteSignageDisplayGroupRequestObject,
) (openapi.DeleteSignageDisplayGroupResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err := s.signage.DeleteGroup(ctx, p, r.GroupId, r.Body.ExpectedVersion, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.DeleteSignageDisplayGroup204Response{}, nil
}

func (s *Server) PublishSignageDisplayGroup(
	ctx context.Context,
	r openapi.PublishSignageDisplayGroupRequestObject,
) (openapi.PublishSignageDisplayGroupResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	group, err := s.signage.PublishGroup(ctx, p, r.GroupId, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.PublishSignageDisplayGroup200JSONResponse(signageDisplayGroupDTO(group)), nil
}

func (s *Server) GetSignageDisplayGroupPreview(
	ctx context.Context,
	r openapi.GetSignageDisplayGroupPreviewRequestObject,
) (openapi.GetSignageDisplayGroupPreviewResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	preview, err := s.signage.PreviewGroup(ctx, p, r.GroupId)
	if err != nil {
		return nil, err
	}
	body, err := signagePreviewDTO(preview)
	if err != nil {
		return nil, err
	}
	return openapi.GetSignageDisplayGroupPreview200JSONResponse{
		Body:    body,
		Headers: openapi.GetSignageDisplayGroupPreview200ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

// Group rules -------------------------------------------------------------------------------------------------

func (s *Server) ListSignageGroupRules(
	ctx context.Context,
	r openapi.ListSignageGroupRulesRequestObject,
) (openapi.ListSignageGroupRulesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	list, err := s.signage.ListGroupRules(ctx, p, r.GroupId)
	if err != nil {
		return nil, err
	}
	return openapi.ListSignageGroupRules200JSONResponse(signageRuleListDTO(list)), nil
}

func (s *Server) CreateSignageGroupRule(
	ctx context.Context,
	r openapi.CreateSignageGroupRuleRequestObject,
) (openapi.CreateSignageGroupRuleResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	list, err := s.signage.CreateGroupRule(
		ctx, p, r.GroupId, r.Body.ExpectedVersion, signageRuleInput(r.Body), requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.CreateSignageGroupRule201JSONResponse(signageRuleListDTO(list)), nil
}

func (s *Server) UpdateSignageGroupRule(
	ctx context.Context,
	r openapi.UpdateSignageGroupRuleRequestObject,
) (openapi.UpdateSignageGroupRuleResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	list, err := s.signage.UpdateGroupRule(
		ctx, p, r.GroupId, r.RuleId, r.Body.ExpectedVersion, signageRuleInput(r.Body), requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateSignageGroupRule200JSONResponse(signageRuleListDTO(list)), nil
}

func (s *Server) SetSignageGroupRuleEnabled(
	ctx context.Context,
	r openapi.SetSignageGroupRuleEnabledRequestObject,
) (openapi.SetSignageGroupRuleEnabledResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	list, err := s.signage.SetGroupRuleEnabled(
		ctx, p, r.GroupId, r.RuleId, r.Body.ExpectedVersion, r.Body.Enabled, requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.SetSignageGroupRuleEnabled200JSONResponse(signageRuleListDTO(list)), nil
}

func (s *Server) DeleteSignageGroupRule(
	ctx context.Context,
	r openapi.DeleteSignageGroupRuleRequestObject,
) (openapi.DeleteSignageGroupRuleResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	list, err := s.signage.DeleteGroupRule(
		ctx, p, r.GroupId, r.RuleId, r.Body.ExpectedVersion, requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.DeleteSignageGroupRule200JSONResponse(signageRuleListDTO(list)), nil
}

func (s *Server) ReorderSignageGroupRules(
	ctx context.Context,
	r openapi.ReorderSignageGroupRulesRequestObject,
) (openapi.ReorderSignageGroupRulesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	list, err := s.signage.ReorderGroupRules(
		ctx, p, r.GroupId, r.Body.ExpectedVersion, r.Body.RuleIds, requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.ReorderSignageGroupRules200JSONResponse(signageRuleListDTO(list)), nil
}
