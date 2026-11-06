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
	"github.com/Basmatireis/Makerspace-Core/backend/internal/trainings"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Row is one supervisor or trainee and their standing in the semester.
type Row struct {
	PersonID      uuid.UUID
	PersonVersion int64
	Name          string
	Membership    roles.Membership
	ExtraRoles    []string
	// Competencies are the active competency categories the person's training records cover.
	Competencies      []trainings.Competency
	HasProfileImage   bool
	LaborordnungState string
	Counts            staffing.Counts
	Minimum           staffing.Minimum
	// Excusal is the person's excusal for the semester; its reason is shown to supervisor_dashboard.read only.
	Excusal        *staffing.Excusal
	Standing       staffing.Standing
	LastOpenDayAt  *time.Time
	NextAssignment *staffing.NextAssignment
	MemberSince    time.Time
}

type Totals struct {
	Supervisors           int
	ProfileImagesComplete int
	LaborordnungCurrent   int
	LaborordnungOutdated  int
}

type Dashboard struct {
	Semester    *staffing.Semester
	Rules       staffing.Rules
	Supervisors []Row
	Totals      Totals
}

type Service struct {
	pool     *pgxpool.Pool
	staffing *staffing.Service
}

func NewService(pool *pgxpool.Pool, staffingService *staffing.Service) *Service {
	return &Service{pool: pool, staffing: staffingService}
}

// Get evaluates every supervisor and trainee against the semester of periodID, or the current semester when nil.
// Draft periods are visible to open_days.manage only.
func (s *Service) Get(
	ctx context.Context,
	principal authorization.Principal,
	periodID *uuid.UUID,
) (Dashboard, error) {
	if !principal.Has(authorization.SupervisorDashboardRead) {
		return Dashboard{}, apperror.PermissionDenied
	}
	now := time.Now().UTC()
	rules, err := s.staffing.Settings(ctx)
	if err != nil {
		return Dashboard{}, err
	}
	var semester *staffing.Semester
	if periodID != nil {
		semester, err = s.staffing.SemesterForPeriod(ctx, rules, *periodID, principal.Has(authorization.OpenDaysManage))
	} else {
		semester, err = s.staffing.CurrentSemester(ctx, rules, now)
	}
	if err != nil {
		return Dashboard{}, err
	}
	minimums, err := s.staffing.Minimums(ctx, rules, semester, nil)
	if err != nil {
		return Dashboard{}, err
	}
	people, err := supervisorsdb.New(s.pool).ListStaffingPeople(ctx)
	if err != nil {
		return Dashboard{}, err
	}
	personIDs := make([]uuid.UUID, 0, len(people))
	for _, person := range people {
		personIDs = append(personIDs, person.PersonID)
	}
	competencies, err := trainings.PersonCompetencies(ctx, s.pool, personIDs)
	if err != nil {
		return Dashboard{}, err
	}
	counts, err := s.staffing.Counts(ctx, rules, semester, now, nil)
	if err != nil {
		return Dashboard{}, err
	}
	lastStaffed, err := s.staffing.LastStaffed(ctx, now, nil)
	if err != nil {
		return Dashboard{}, err
	}
	next, err := s.staffing.NextAssignments(ctx, now, nil)
	if err != nil {
		return Dashboard{}, err
	}
	dashboard := Dashboard{Semester: semester, Rules: rules, Supervisors: make([]Row, 0, len(people))}
	for _, person := range people {
		membership := roles.Membership(person.Membership)
		personCounts := counts[person.PersonID]
		minimum := minimums.For(person.PersonID, membership)
		row := Row{
			PersonID:          person.PersonID,
			PersonVersion:     person.PersonVersion,
			Name:              strings.TrimSpace(person.FirstName + " " + person.LastName),
			Membership:        membership,
			ExtraRoles:        person.ExtraRoles,
			Competencies:      competencies[person.PersonID],
			HasProfileImage:   person.HasProfileImage,
			LaborordnungState: person.LaborordnungState,
			Counts:            personCounts,
			Minimum:           minimum,
			Excusal:           minimums.Excusal(person.PersonID),
			Standing:          staffing.StatusFor(membership, personCounts, rules, minimum),
			MemberSince:       person.MemberSince.Time,
		}
		if last, ok := lastStaffed[person.PersonID]; ok {
			row.LastOpenDayAt = &last
		}
		if assignment, ok := next[person.PersonID]; ok {
			row.NextAssignment = &assignment
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
