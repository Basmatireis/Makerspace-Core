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
	request openapi.GetSupervisorDashboardRequestObject,
) (openapi.GetSupervisorDashboardResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	dashboard, err := s.supervisors.Get(ctx, principal, request.Params.PeriodId)
	if err != nil {
		return nil, err
	}
	rows := make([]openapi.SupervisorRow, 0, len(dashboard.Supervisors))
	for _, supervisor := range dashboard.Supervisors {
		row := openapi.SupervisorRow{
			PersonId:             supervisor.PersonID,
			PersonVersion:        supervisor.PersonVersion,
			Name:                 supervisor.Name,
			Membership:           openapi.StaffingKind(supervisor.Membership),
			ExtraRoles:           supervisor.ExtraRoles,
			Competencies:         competencyDTOs(supervisor.Competencies),
			HasProfileImage:      supervisor.HasProfileImage,
			LaborordnungState:    openapi.SupervisorRowLaborordnungState(supervisor.LaborordnungState),
			Staffed:              supervisor.Counts.Staffed,
			Booked:               supervisor.Counts.Booked,
			StaffedAsTrainee:     supervisor.Counts.StaffedAsTrainee,
			Minimum:              supervisor.Minimum.Value,
			MinimumSource:        openapi.StaffingMinimumSource(supervisor.Minimum.Source),
			MinimumExceptionRole: nullable.NewNullNullable[string](),
			Excused:              supervisor.Excusal != nil,
			ExcusalReason:        nullable.NewNullNullable[string](),
			Status:               openapi.StaffingStatus(supervisor.Standing.Status),
			Missing:              supervisor.Standing.Missing,
			MemberSince:          openapi_types.Date{Time: supervisor.MemberSince},
			LastOpenDayAt:        nullable.NewNullNullable[time.Time](),
			NextAssignment:       nullable.NewNullNullable[openapi.StaffingNextAssignment](),
		}
		if row.ExtraRoles == nil {
			row.ExtraRoles = []string{}
		}
		if supervisor.Minimum.ExceptionRole != nil {
			row.MinimumExceptionRole = nullable.NewNullableWithValue(*supervisor.Minimum.ExceptionRole)
		}
		if supervisor.Excusal != nil {
			row.ExcusalReason = nullable.NewNullableWithValue(supervisor.Excusal.Reason)
		}
		if supervisor.LastOpenDayAt != nil {
			row.LastOpenDayAt = nullable.NewNullableWithValue(*supervisor.LastOpenDayAt)
		}
		if next := supervisor.NextAssignment; next != nil {
			row.NextAssignment = nullable.NewNullableWithValue(openapi.StaffingNextAssignment{
				OpenDayId: next.OpenDayID, StartsAt: next.StartsAt, EndsAt: next.EndsAt,
			})
		}
		rows = append(rows, row)
	}
	return openapi.GetSupervisorDashboard200JSONResponse{
		Semester:    semesterDTO(dashboard.Semester),
		Rules:       staffingRulesDTO(dashboard.Rules),
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
		SignUpBy: openapi_types.Date{Time: semester.SignUpBy},
	})
}
