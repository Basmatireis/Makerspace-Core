package httpapi

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/staffing"
)

func (s *Server) GetStaffingRules(
	ctx context.Context,
	_ openapi.GetStaffingRulesRequestObject,
) (openapi.GetStaffingRulesResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	rules, err := s.staffing.Rules(ctx, principal)
	if err != nil {
		return nil, err
	}
	return openapi.GetStaffingRules200JSONResponse(staffingRulesDTO(rules)), nil
}

func (s *Server) UpdateStaffingRules(
	ctx context.Context,
	request openapi.UpdateStaffingRulesRequestObject,
) (openapi.UpdateStaffingRulesResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	body := request.Body
	input := staffing.UpdateInput{
		ExpectedVersion:   body.ExpectedVersion,
		SupervisorMinimum: body.SupervisorMinimum,
		TraineeMinimum:    body.TraineeMinimum,
		TraineeReadyAfter: body.TraineeReadyAfter,
		WarningWindowDays: body.WarningWindowDays,
		CountBy:           staffing.CountBy(body.CountBy),
		DefaultDeadline:   staffing.DefaultDeadline(body.DefaultDeadline),
		Exceptions:        make([]staffing.ExceptionInput, 0, len(body.Exceptions)),
	}
	for _, exception := range body.Exceptions {
		input.Exceptions = append(input.Exceptions, staffing.ExceptionInput{
			RoleID: exception.RoleId, Minimum: exception.Minimum,
		})
	}
	rules, err := s.staffing.UpdateRules(ctx, principal, input, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateStaffingRules200JSONResponse(staffingRulesDTO(rules)), nil
}

func (s *Server) SetStaffingExcusal(
	ctx context.Context,
	request openapi.SetStaffingExcusalRequestObject,
) (openapi.SetStaffingExcusalResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	excusal, err := s.staffing.SetExcusal(
		ctx, principal, request.PeriodId, request.PersonId, request.Body.Reason, requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.SetStaffingExcusal200JSONResponse{
		PeriodId: excusal.PeriodID, PersonId: excusal.PersonID, Reason: excusal.Reason, CreatedAt: excusal.CreatedAt,
	}, nil
}

func (s *Server) RemoveStaffingExcusal(
	ctx context.Context,
	request openapi.RemoveStaffingExcusalRequestObject,
) (openapi.RemoveStaffingExcusalResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.staffing.RemoveExcusal(
		ctx, principal, request.PeriodId, request.PersonId, requestIDPointer(ctx),
	); err != nil {
		return nil, err
	}
	return openapi.RemoveStaffingExcusal204Response{}, nil
}

func staffingRulesDTO(rules staffing.Rules) openapi.StaffingRules {
	response := openapi.StaffingRules{
		SupervisorMinimum: rules.SupervisorMinimum,
		TraineeMinimum:    rules.TraineeMinimum,
		TraineeReadyAfter: rules.TraineeReadyAfter,
		WarningWindowDays: rules.WarningWindowDays,
		CountBy:           openapi.StaffingCountBy(rules.CountBy),
		DefaultDeadline:   openapi.StaffingDefaultDeadline(rules.DefaultDeadline),
		Exceptions:        make([]openapi.StaffingException, 0, len(rules.Exceptions)),
		Version:           rules.Version,
		UpdatedAt:         rules.UpdatedAt,
	}
	for _, exception := range rules.Exceptions {
		response.Exceptions = append(response.Exceptions, openapi.StaffingException{
			RoleId: exception.RoleID, RoleName: exception.RoleName, Minimum: exception.Minimum,
		})
	}
	return response
}
