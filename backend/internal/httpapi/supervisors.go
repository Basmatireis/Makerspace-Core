package httpapi

import (
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/staffing"
	"github.com/oapi-codegen/nullable"
	openapi_types "github.com/oapi-codegen/runtime/types"
)

func (s *Server) GetSupervisorDashboard(
	ctx context.Context,
	_ openapi.GetSupervisorDashboardRequestObject,
) (openapi.GetSupervisorDashboardResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	dashboard, err := s.supervisors.Get(ctx, principal)
	if err != nil {
		return nil, err
	}
	rows := make([]openapi.SupervisorRow, 0, len(dashboard.Supervisors))
	for _, supervisor := range dashboard.Supervisors {
		row := openapi.SupervisorRow{
			PersonId:          supervisor.PersonID,
			PersonVersion:     supervisor.PersonVersion,
			Name:              supervisor.Name,
			Kind:              openapi.StaffingLevel(supervisor.Kind),
			HasProfileImage:   supervisor.HasProfileImage,
			LaborordnungState: openapi.SupervisorRowLaborordnungState(supervisor.LaborordnungState),
			Staffed:           supervisor.Counts.Staffed,
			Booked:            supervisor.Counts.Booked,
			StaffedAsTrainee:  supervisor.Counts.StaffedAsTrainee,
			Status:            openapi.StaffingStatus(supervisor.Standing.Status),
			Missing:           supervisor.Standing.Missing,
			MemberSince:       supervisor.MemberSince,
			LastOpenDayAt:     nullable.NewNullNullable[time.Time](),
		}
		if supervisor.LastOpenDayAt != nil {
			row.LastOpenDayAt = nullable.NewNullableWithValue(*supervisor.LastOpenDayAt)
		}
		rows = append(rows, row)
	}
	return openapi.GetSupervisorDashboard200JSONResponse{
		Semester: semesterDTO(dashboard.Semester),
		Requirements: openapi.SupervisorDashboardRequirements{
			MinOpenDaysPerSemester:      dashboard.Requirements.MinOpenDaysPerSemester,
			TraineeOpenDaysForPromotion: dashboard.Requirements.TraineeOpenDaysForPromotion,
			SupervisorRoleConfigured:    dashboard.Requirements.SupervisorRoleID != nil,
		},
		Supervisors: rows,
		Totals: openapi.SupervisorTotals{
			Supervisors:           dashboard.Totals.Supervisors,
			ProfileImagesComplete: dashboard.Totals.ProfileImagesComplete,
			LaborordnungCurrent:   dashboard.Totals.LaborordnungCurrent,
			LaborordnungOutdated:  dashboard.Totals.LaborordnungOutdated,
		},
	}, nil
}

func semesterDTO(semester *staffing.Semester) nullable.Nullable[openapi.Semester] {
	if semester == nil {
		return nullable.NewNullNullable[openapi.Semester]()
	}
	return nullable.NewNullableWithValue(openapi.Semester{
		PeriodId: semester.ID,
		Name:     semester.Name,
		StartsOn: openapi_types.Date{Time: semester.StartsOn},
		EndsOn:   openapi_types.Date{Time: semester.EndsOn},
	})
}
