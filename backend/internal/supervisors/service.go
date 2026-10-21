package supervisors

import (
	"context"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/roles"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/staffing"
	supervisorsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/supervisors/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Row is one person with a staffing level and their standing in the current semester.
type Row struct {
	PersonID          uuid.UUID
	PersonVersion     int64
	Name              string
	Kind              roles.StaffingLevel
	HasProfileImage   bool
	LaborordnungState string
	Counts            staffing.Counts
	Standing          staffing.Standing
	LastOpenDayAt     *time.Time
	MemberSince       time.Time
}

type Totals struct {
	Supervisors           int
	ProfileImagesComplete int
	LaborordnungCurrent   int
	LaborordnungOutdated  int
}

type Dashboard struct {
	Semester     *staffing.Semester
	Requirements staffing.Requirements
	Supervisors  []Row
	Totals       Totals
}

type Service struct {
	pool     *pgxpool.Pool
	staffing *staffing.Service
}

func NewService(pool *pgxpool.Pool, staffingService *staffing.Service) *Service {
	return &Service{pool: pool, staffing: staffingService}
}

func (s *Service) Get(ctx context.Context, principal authorization.Principal) (Dashboard, error) {
	if !principal.Has(authorization.SupervisorDashboardRead) {
		return Dashboard{}, apperror.PermissionDenied
	}
	now := time.Now().UTC()
	semester, err := s.staffing.CurrentSemester(ctx, now)
	if err != nil {
		return Dashboard{}, err
	}
	requirements, err := s.staffing.Settings(ctx)
	if err != nil {
		return Dashboard{}, err
	}
	people, err := supervisorsdb.New(s.pool).ListStaffingPeople(ctx)
	if err != nil {
		return Dashboard{}, err
	}
	counts, err := s.staffing.Counts(ctx, semester, now, nil)
	if err != nil {
		return Dashboard{}, err
	}
	lastStaffed, err := s.staffing.LastStaffed(ctx, now, nil)
	if err != nil {
		return Dashboard{}, err
	}
	dashboard := Dashboard{
		Semester:     semester,
		Requirements: requirements,
		Supervisors:  make([]Row, 0, len(people)),
	}
	for _, person := range people {
		kind := roles.StaffingLevel(person.Kind)
		personCounts := counts[person.PersonID]
		row := Row{
			PersonID:          person.PersonID,
			PersonVersion:     person.PersonVersion,
			Name:              strings.TrimSpace(person.FirstName + " " + person.LastName),
			Kind:              kind,
			HasProfileImage:   person.HasProfileImage,
			LaborordnungState: person.LaborordnungState,
			Counts:            personCounts,
			Standing:          staffing.StatusFor(kind, personCounts, requirements),
			MemberSince:       person.MemberSince,
		}
		if last, ok := lastStaffed[person.PersonID]; ok {
			row.LastOpenDayAt = &last
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
