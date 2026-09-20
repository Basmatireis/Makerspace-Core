package supervisors

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	supervisorsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/supervisors/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Period struct {
	ID                    uuid.UUID
	Name                  string
	Status                string
	SupervisorAssignments int64
}

type AssignmentCount struct {
	PeriodID uuid.UUID
	Count    int64
}

type Row struct {
	PersonID          uuid.UUID
	Name              string
	HasProfileImage   bool
	LaborordnungState string
	AssignmentCounts  []AssignmentCount
}

type Totals struct {
	Supervisors           int
	ProfileImagesComplete int
	LaborordnungCurrent   int
	LaborordnungOutdated  int
}

type Dashboard struct {
	Periods     []Period
	Supervisors []Row
	Totals      Totals
}

type Service struct{ pool *pgxpool.Pool }

func NewService(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

func (s *Service) Get(ctx context.Context, principal authorization.Principal) (Dashboard, error) {
	if !principal.Has(authorization.SupervisorDashboardRead) {
		return Dashboard{}, apperror.PermissionDenied
	}
	queries := supervisorsdb.New(s.pool)
	periodRows, err := queries.ListOpenPeriods(ctx)
	if err != nil {
		return Dashboard{}, err
	}
	supervisorRows, err := queries.ListSupervisors(ctx)
	if err != nil {
		return Dashboard{}, err
	}
	counts, err := queries.ListSupervisorAssignmentCounts(ctx)
	if err != nil {
		return Dashboard{}, err
	}
	byPerson := make(map[uuid.UUID]map[uuid.UUID]int64, len(supervisorRows))
	periodTotals := make(map[uuid.UUID]int64, len(periodRows))
	for _, count := range counts {
		if byPerson[count.PersonID] == nil {
			byPerson[count.PersonID] = map[uuid.UUID]int64{}
		}
		byPerson[count.PersonID][count.PeriodID] = count.AssignmentCount
		periodTotals[count.PeriodID] += count.AssignmentCount
	}
	dashboard := Dashboard{Periods: make([]Period, 0, len(periodRows)), Supervisors: make([]Row, 0, len(supervisorRows))}
	for _, period := range periodRows {
		dashboard.Periods = append(dashboard.Periods, Period{ID: period.ID, Name: period.Name, Status: period.Status, SupervisorAssignments: periodTotals[period.ID]})
	}
	for _, supervisor := range supervisorRows {
		row := Row{PersonID: supervisor.PersonID, Name: supervisor.FirstName + " " + supervisor.LastName, HasProfileImage: supervisor.HasProfileImage, LaborordnungState: supervisor.LaborordnungState, AssignmentCounts: make([]AssignmentCount, 0, len(periodRows))}
		for _, period := range periodRows {
			row.AssignmentCounts = append(row.AssignmentCounts, AssignmentCount{PeriodID: period.ID, Count: byPerson[supervisor.PersonID][period.ID]})
		}
		dashboard.Supervisors = append(dashboard.Supervisors, row)
		dashboard.Totals.Supervisors++
		if row.HasProfileImage {
			dashboard.Totals.ProfileImagesComplete++
		}
		if row.LaborordnungState == "current" || row.LaborordnungState == "not_required" {
			dashboard.Totals.LaborordnungCurrent++
		} else {
			dashboard.Totals.LaborordnungOutdated++
		}
	}
	return dashboard, nil
}
