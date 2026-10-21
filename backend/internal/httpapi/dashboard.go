package httpapi

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/dashboard"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/oapi-codegen/nullable"
)

func (s *Server) GetPersonalDashboard(
	ctx context.Context,
	_ openapi.GetPersonalDashboardRequestObject,
) (openapi.GetPersonalDashboardResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	result, err := s.dashboard.Get(ctx, principal)
	if err != nil {
		return nil, err
	}
	response := openapi.PersonalDashboard{
		Person: openapi.PersonalDashboardPerson{FirstName: result.Person.FirstName, MemberSince: result.Person.MemberSince},
	}
	comingUp := make([]openapi.ComingUpItem, 0, len(result.ComingUp))
	for _, item := range result.ComingUp {
		comingUp = append(comingUp, openapi.ComingUpItem{
			Kind:         openapi.ComingUpItemKind(item.Kind),
			Id:           item.ID,
			Title:        item.Title,
			StartsAt:     item.StartsAt,
			EndsAt:       item.EndsAt,
			OpenDayId:    item.OpenDayID,
			PeriodId:     item.PeriodID,
			ShortStaffed: item.ShortStaffed,
			EventId:      item.EventID,
			PublicId:     item.PublicID,
		})
	}
	response.ComingUp = &comingUp
	if result.Staffing != nil {
		response.Staffing = staffingDTO(result.Staffing)
	}
	if result.Statistics != nil {
		response.Statistics = &openapi.PersonalStatistics{
			OpenDaysStaffed: result.Statistics.OpenDaysStaffed,
			OpenDayHours:    result.Statistics.OpenDayHours,
			EventShifts:     result.Statistics.EventShifts,
			EventShiftHours: result.Statistics.EventShiftHours,
			MemberSince:     result.Statistics.MemberSince,
		}
	}
	return openapi.GetPersonalDashboard200JSONResponse(response), nil
}

func staffingDTO(section *dashboard.Staffing) *openapi.PersonalDashboardStaffing {
	response := &openapi.PersonalDashboardStaffing{
		Kind:             openapi.StaffingLevel(section.Kind),
		Semester:         semesterDTO(section.Semester),
		Minimum:          section.Minimum,
		TraineeThreshold: section.TraineeThreshold,
		Staffed:          section.Counts.Staffed,
		Booked:           section.Counts.Booked,
		StaffedAsTrainee: section.Counts.StaffedAsTrainee,
		Status:           openapi.StaffingStatus(section.Standing.Status),
		Missing:          section.Standing.Missing,
		NextOpenPlace:    nullable.NewNullNullable[openapi.OpenPlace](),
		NextOpenDay:      nullable.NewNullNullable[openapi.NextOpenDayStaffing](),
	}
	if place := section.NextOpenPlace; place != nil {
		response.NextOpenPlace = nullable.NewNullableWithValue(openapi.OpenPlace{
			OpenDayId: place.OpenDayID, PeriodId: place.PeriodID, RequirementId: place.RequirementID,
			StartsAt: place.StartsAt, EndsAt: place.EndsAt, FreePlaces: place.FreePlaces,
		})
	}
	if day := section.NextOpenDay; day != nil {
		response.NextOpenDay = nullable.NewNullableWithValue(openapi.NextOpenDayStaffing{
			OpenDayId: day.OpenDayID, StartsAt: day.StartsAt, EndsAt: day.EndsAt,
			OpenSupervisorPlaces: day.OpenSupervisorPlaces, ShortStaffed: day.ShortStaffed,
		})
	}
	return response
}
