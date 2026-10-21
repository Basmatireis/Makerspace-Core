package httpapi

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/staffing"
	"github.com/google/uuid"
	"github.com/oapi-codegen/nullable"
)

func (s *Server) GetOpenDayRequirements(
	ctx context.Context,
	_ openapi.GetOpenDayRequirementsRequestObject,
) (openapi.GetOpenDayRequirementsResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	requirements, err := s.staffing.Requirements(ctx, principal)
	if err != nil {
		return nil, err
	}
	return openapi.GetOpenDayRequirements200JSONResponse(requirementsDTO(requirements)), nil
}

func (s *Server) UpdateOpenDayRequirements(
	ctx context.Context,
	request openapi.UpdateOpenDayRequirementsRequestObject,
) (openapi.UpdateOpenDayRequirementsResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	var roleID *uuid.UUID
	if request.Body.SupervisorRoleId.IsSpecified() && !request.Body.SupervisorRoleId.IsNull() {
		value := request.Body.SupervisorRoleId.MustGet()
		roleID = &value
	}
	requirements, err := s.staffing.UpdateRequirements(
		ctx,
		principal,
		staffing.UpdateInput{
			ExpectedVersion:             request.Body.ExpectedVersion,
			MinOpenDaysPerSemester:      request.Body.MinOpenDaysPerSemester,
			TraineeOpenDaysForPromotion: request.Body.TraineeOpenDaysForPromotion,
			SupervisorRoleID:            roleID,
		},
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateOpenDayRequirements200JSONResponse(requirementsDTO(requirements)), nil
}

func requirementsDTO(requirements staffing.Requirements) openapi.OpenDayRequirements {
	response := openapi.OpenDayRequirements{
		MinOpenDaysPerSemester:      requirements.MinOpenDaysPerSemester,
		TraineeOpenDaysForPromotion: requirements.TraineeOpenDaysForPromotion,
		SupervisorRoleId:            nullable.NewNullNullable[openapi.UUIDv7](),
		Version:                     requirements.Version,
		UpdatedAt:                   requirements.UpdatedAt,
	}
	if requirements.SupervisorRoleID != nil {
		response.SupervisorRoleId = nullable.NewNullableWithValue(*requirements.SupervisorRoleID)
	}
	return response
}
