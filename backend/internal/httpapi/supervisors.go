package httpapi

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
)

func (s *Server) GetSupervisorDashboard(ctx context.Context, _ openapi.GetSupervisorDashboardRequestObject) (openapi.GetSupervisorDashboardResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	dashboard, err := s.supervisors.Get(ctx, principal)
	if err != nil {
		return nil, err
	}
	periods := make([]openapi.SupervisorPeriod, 0, len(dashboard.Periods))
	for _, period := range dashboard.Periods {
		periods = append(periods, openapi.SupervisorPeriod{Id: period.ID, Name: period.Name, Status: openapi.SupervisorPeriodStatus(period.Status), SupervisorAssignments: int(period.SupervisorAssignments)})
	}
	rows := make([]openapi.SupervisorRow, 0, len(dashboard.Supervisors))
	for _, supervisor := range dashboard.Supervisors {
		counts := make([]openapi.SupervisorAssignmentCount, 0, len(supervisor.AssignmentCounts))
		for _, count := range supervisor.AssignmentCounts {
			counts = append(counts, openapi.SupervisorAssignmentCount{PeriodId: count.PeriodID, Count: int(count.Count)})
		}
		rows = append(rows, openapi.SupervisorRow{PersonId: supervisor.PersonID, Name: supervisor.Name, HasProfileImage: supervisor.HasProfileImage, LaborordnungState: openapi.SupervisorRowLaborordnungState(supervisor.LaborordnungState), AssignmentCounts: counts})
	}
	return openapi.GetSupervisorDashboard200JSONResponse{
		Periods: periods, Supervisors: rows,
		Totals: openapi.SupervisorTotals{Supervisors: dashboard.Totals.Supervisors, ProfileImagesComplete: dashboard.Totals.ProfileImagesComplete, LaborordnungCurrent: dashboard.Totals.LaborordnungCurrent, LaborordnungOutdated: dashboard.Totals.LaborordnungOutdated},
	}, nil
}
