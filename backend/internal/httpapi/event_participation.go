package httpapi

import (
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/events"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/google/uuid"
)

func (s *Server) GetEventParticipation(
	ctx context.Context,
	r openapi.GetEventParticipationRequestObject,
) (openapi.GetEventParticipationResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	item, err := s.events.Participation(ctx, p, r.EventId)
	if err != nil {
		return nil, err
	}
	result := openapi.EventParticipation{
		EventId:       item.EventID,
		Status:        openapi.EventStatus(item.Status),
		CanSignup:     item.CanSignup,
		CanSeeNames:   item.CanSeeNames,
		MyAssignments: eventMyAssignmentDTOs(item.MyAssignments),
		Sessions:      make([]openapi.EventSession, 0, len(item.Sessions)),
		Shifts:        make([]openapi.EventParticipationShift, 0, len(item.Shifts)),
	}
	for _, session := range item.Sessions {
		result.Sessions = append(result.Sessions, eventSessionDTO(session))
	}
	for _, shift := range item.Shifts {
		dto := openapi.EventParticipationShift{
			Id:        shift.ID,
			SessionId: nullablePointer[openapi.UUIDv7](shift.SessionID, func(x uuid.UUID) openapi.UUIDv7 { return x }),
			Name:      shift.Name,
			Description: nullablePointer[string](
				shift.Description,
				func(x string) string { return x },
			),
			StartsAt: shift.StartsAt,
			EndsAt:   shift.EndsAt,
			Status:   openapi.EventShiftStatus(shift.Status),
			IsPublic: shift.IsPublic,
			LinkedSessionStatus: nullablePointer(
				shift.LinkedSessionStatus,
				func(x events.SessionStatus) openapi.EventSessionStatus { return openapi.EventSessionStatus(x) },
			),
			SignupOpensAt:  nullablePointer(shift.SignupOpensAt, func(x time.Time) time.Time { return x }),
			SignupClosesAt: nullablePointer(shift.SignupClosesAt, func(x time.Time) time.Time { return x }),
			Positions:      make([]openapi.EventParticipationPosition, 0, len(shift.Positions)),
		}
		for _, position := range shift.Positions {
			dto.Positions = append(dto.Positions, eventParticipationPositionDTO(position))
		}
		result.Shifts = append(result.Shifts, dto)
	}
	return openapi.GetEventParticipation200JSONResponse(result), nil
}

func (s *Server) JoinEventPosition(
	ctx context.Context,
	r openapi.JoinEventPositionRequestObject,
) (openapi.JoinEventPositionResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	item, err := s.events.Join(ctx, p, r.EventId, r.EventShiftId, r.EventRequirementId, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.JoinEventPosition201JSONResponse(eventMyAssignmentDTO(item)), nil
}

func (s *Server) LeaveEventPosition(
	ctx context.Context,
	r openapi.LeaveEventPositionRequestObject,
) (openapi.LeaveEventPositionResponseObject, error) {
	p, b, err := eventActionInput(ctx, r.Body)
	if err != nil {
		return nil, err
	}
	if err = s.events.Leave(ctx, p, r.EventId, r.EventAssignmentId, b.ExpectedVersion, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.LeaveEventPosition204Response{}, nil
}

func eventParticipationPositionDTO(v events.ParticipationPosition) openapi.EventParticipationPosition {
	result := openapi.EventParticipationPosition{
		Id:            v.ID,
		Name:          v.Name,
		Description:   nullablePointer[string](v.Description, func(x string) string { return x }),
		RequiredCount: v.RequiredCount,
		FilledCount:   v.FilledCount,
		MyAssignmentId: nullablePointer[openapi.UUIDv7](
			v.MyAssignmentID,
			func(x uuid.UUID) openapi.UUIDv7 { return x },
		),
		Joinable:  v.Joinable,
		OpensAt:   nullablePointer(v.OpensAt, func(x time.Time) time.Time { return x }),
		RoleNames: v.RoleNames,
	}
	if v.Reason != "" {
		reason := v.Reason
		result.Reason = nullablePointer(&reason, func(x events.JoinReason) openapi.EventJoinReason {
			return openapi.EventJoinReason(x)
		})
	}
	if v.Helpers != nil {
		helpers := make([]openapi.EventParticipationHelper, 0, len(v.Helpers))
		for _, helper := range v.Helpers {
			helpers = append(helpers, openapi.EventParticipationHelper{
				DisplayName: nullablePointer[string](helper.DisplayName, func(x string) string { return x }),
				IsMe:        helper.IsMe,
			})
		}
		result.Helpers = nullablePointer(&helpers, func(x []openapi.EventParticipationHelper) []openapi.EventParticipationHelper {
			return x
		})
	}
	return result
}

func eventMyAssignmentDTO(v events.MyAssignment) openapi.EventMyAssignment {
	result := openapi.EventMyAssignment{
		AssignmentId:    v.AssignmentID,
		ShiftId:         v.ShiftID,
		RequirementId:   v.RequirementID,
		ShiftName:       v.ShiftName,
		RequirementName: v.RequirementName,
		StartsAt:        v.StartsAt,
		EndsAt:          v.EndsAt,
		ShiftStatus:     openapi.EventShiftStatus(v.ShiftStatus),
		Version:         v.Version,
		CanLeave:        v.LeaveBlocked == "",
	}
	if v.LeaveBlocked != "" {
		reason := v.LeaveBlocked
		result.LeaveBlockedReason = nullablePointer(&reason, func(x events.LeaveBlock) openapi.EventMyAssignmentLeaveBlockedReason {
			return openapi.EventMyAssignmentLeaveBlockedReason(x)
		})
	}
	return result
}

func eventMyAssignmentDTOs(values []events.MyAssignment) []openapi.EventMyAssignment {
	result := make([]openapi.EventMyAssignment, 0, len(values))
	for _, value := range values {
		result = append(result, eventMyAssignmentDTO(value))
	}
	return result
}
