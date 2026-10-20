package httpapi

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/people"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/roles"
	"github.com/google/uuid"
	"github.com/oapi-codegen/nullable"
)

func (s *Server) ListPermissions(
	ctx context.Context,
	_ openapi.ListPermissionsRequestObject,
) (openapi.ListPermissionsResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	definitions, err := s.permissions.ListPermissions(principal)
	if err != nil {
		return nil, err
	}
	items := make([]openapi.Permission, 0, len(definitions))
	for _, definition := range definitions {
		items = append(
			items,
			openapi.Permission{Id: openapi.PermissionId(definition.ID), Description: definition.Description},
		)
	}
	return openapi.ListPermissions200JSONResponse{Items: items}, nil
}

func (s *Server) ListRoles(
	ctx context.Context,
	request openapi.ListRolesRequestObject,
) (openapi.ListRolesResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	limit, cursor := 50, ""
	if request.Params.Limit != nil {
		limit = *request.Params.Limit
	}
	if request.Params.Cursor != nil {
		cursor = *request.Params.Cursor
	}
	page, err := s.roles.List(ctx, principal, limit, cursor)
	if err != nil {
		return nil, err
	}
	return openapi.ListRoles200JSONResponse(rolePageDTO(page)), nil
}

func (s *Server) EvaluateRolePermissions(
	ctx context.Context,
	request openapi.EvaluateRolePermissionsRequestObject,
) (openapi.EvaluateRolePermissionsResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	var deviceTypeID *uuid.UUID
	if request.Params.DeviceTypeId != nil {
		id := *request.Params.DeviceTypeId
		deviceTypeID = &id
	}
	evaluations, err := s.roles.EvaluatePermissions(ctx, principal, authorization.EvaluationContext{
		Assurance: authorization.Assurance(request.Params.AuthenticationAssurance), DeviceTypeID: deviceTypeID,
	})
	if err != nil {
		return nil, err
	}
	if deviceTypeID != nil {
		if _, err := s.managedDevices.GetType(ctx, principal, *deviceTypeID); err != nil {
			return nil, err
		}
	}
	items := make([]openapi.RoleEffectivePermissionEvaluation, 0, len(evaluations))
	for _, evaluation := range evaluations {
		permissionIDs := make([]openapi.PermissionId, 0, len(evaluation.PermissionIDs))
		for _, permission := range evaluation.PermissionIDs {
			permissionIDs = append(permissionIDs, openapi.PermissionId(permission))
		}
		items = append(items, openapi.RoleEffectivePermissionEvaluation{
			RoleId: evaluation.RoleID, RoleVersion: evaluation.RoleVersion, PermissionIds: permissionIDs,
		})
	}
	return openapi.EvaluateRolePermissions200JSONResponse{Items: items}, nil
}

func (s *Server) CreateRole(
	ctx context.Context,
	request openapi.CreateRoleRequestObject,
) (openapi.CreateRoleResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	grants := make([]authorization.PermissionGrant, 0, len(request.Body.PermissionGrants))
	for _, grant := range request.Body.PermissionGrants {
		grants = append(grants, grantDomain(grant))
	}
	profileImageRequired := request.Body.ProfileImageRequired != nil && *request.Body.ProfileImageRequired
	laborordnungMode := "not_required"
	if request.Body.LaborordnungMode != nil {
		laborordnungMode = string(*request.Body.LaborordnungMode)
	}
	supervisorDashboard := request.Body.SupervisorDashboard != nil && *request.Body.SupervisorDashboard
	role, err := s.roles.CreateWithBehaviors(
		ctx,
		principal,
		request.Body.Name,
		nullableStringPointer(request.Body.Description),
		grants,
		profileImageRequired,
		laborordnungMode,
		supervisorDashboard,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.CreateRole201JSONResponse{
		Body: roleDTO(
			role,
		), Headers: openapi.CreateRole201ResponseHeaders{Location: apiBasePath + "/roles/" + role.ID.String()},
	}, nil
}

func (s *Server) DeleteRole(
	ctx context.Context,
	request openapi.DeleteRoleRequestObject,
) (openapi.DeleteRoleResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err := s.roles.Delete(
		ctx,
		principal,
		request.RoleId,
		request.Body.ExpectedVersion,
		requestIDPointer(ctx),
	); err != nil {
		return nil, err
	}
	return openapi.DeleteRole204Response{}, nil
}

func (s *Server) GetRole(
	ctx context.Context,
	request openapi.GetRoleRequestObject,
) (openapi.GetRoleResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	role, err := s.roles.Get(ctx, principal, request.RoleId)
	if err != nil {
		return nil, err
	}
	return openapi.GetRole200JSONResponse(roleDTO(role)), nil
}

func (s *Server) UpdateRole(
	ctx context.Context,
	request openapi.UpdateRoleRequestObject,
) (openapi.UpdateRoleResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	role, err := s.roles.UpdateWithBehaviors(
		ctx,
		principal,
		request.RoleId,
		request.Body.ExpectedVersion,
		request.Body.Name,
		request.Body.Description.IsSpecified(),
		nullableStringPointer(request.Body.Description),
		request.Body.ProfileImageRequired,
		stringPointer(request.Body.LaborordnungMode),
		request.Body.SupervisorDashboard,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateRole200JSONResponse(roleDTO(role)), nil
}

func (s *Server) ReplaceRolePermissions(
	ctx context.Context,
	request openapi.ReplaceRolePermissionsRequestObject,
) (openapi.ReplaceRolePermissionsResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	grants := make([]authorization.PermissionGrant, 0, len(request.Body.PermissionGrants))
	for _, grant := range request.Body.PermissionGrants {
		grants = append(grants, grantDomain(grant))
	}
	role, err := s.roles.ReplacePermissions(
		ctx,
		principal,
		request.RoleId,
		request.Body.ExpectedVersion,
		grants,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.ReplaceRolePermissions200JSONResponse(roleDTO(role)), nil
}

func roleSummaryDTO(role people.RoleSummary) openapi.RoleSummary {
	response := openapi.RoleSummary{Id: role.ID, Name: role.Name}
	if role.SystemKey != nil {
		response.SystemKey = nullable.NewNullableWithValue(openapi.RoleSummarySystemKey(*role.SystemKey))
	}
	return response
}

func roleDTO(role roles.Role) openapi.Role {
	grants := make([]openapi.PermissionGrant, 0, len(role.PermissionGrants))
	for _, grant := range role.PermissionGrants {
		grants = append(grants, grantDTO(grant))
	}
	response := openapi.Role{
		Id: role.ID, Name: role.Name, PermissionGrants: grants, Version: role.Version,
		ProfileImageRequired: role.ProfileImageRequired,
		LaborordnungMode:     openapi.RoleLaborordnungMode(role.LaborordnungMode),
		SupervisorDashboard:  role.SupervisorDashboard,
		CreatedAt:            role.CreatedAt, UpdatedAt: role.UpdatedAt,
		Description: nullablePointer[string](role.Description, func(value string) string { return value }),
	}
	if role.SystemKey == nil {
		response.SystemKey = nullable.NewNullNullable[openapi.RoleSystemKey]()
	} else {
		response.SystemKey = nullable.NewNullableWithValue(openapi.RoleSystemKey(*role.SystemKey))
	}
	return response
}

func rolePageDTO(page roles.Page) openapi.RolePage {
	items := make([]openapi.Role, 0, len(page.Items))
	for _, role := range page.Items {
		items = append(items, roleDTO(role))
	}
	return openapi.RolePage{
		Items:      items,
		NextCursor: nullablePointer[string](page.NextCursor, func(value string) string { return value }),
	}
}
