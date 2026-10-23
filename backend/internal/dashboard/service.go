package dashboard

import (
	"context"
	"math"
	"sort"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	dashboarddb "github.com/Basmatireis/Makerspace-Core/backend/internal/dashboard/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/events"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/opendays"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/orders"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/roles"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/staffing"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
)

// OpenPlaceWindow is how far ahead the dashboard looks for an open place to point the person at.
const OpenPlaceWindow = 14 * 24 * time.Hour

// ItemKind tells open-day duties and event shifts apart in the coming-up list.
type ItemKind string

const (
	ItemOpenDay    ItemKind = "open_day"
	ItemEventShift ItemKind = "event_shift"
)

type Person struct {
	FirstName   string
	MemberSince time.Time
}

// NextOpenDay is the person's next booked open day with its supervisor staffing.
type NextOpenDay struct {
	OpenDayID            uuid.UUID
	StartsAt, EndsAt     time.Time
	OpenSupervisorPlaces int
	ShortStaffed         bool
}

type Staffing struct {
	Kind             roles.StaffingLevel
	Semester         *staffing.Semester
	Minimum          int
	TraineeThreshold int
	Counts           staffing.Counts
	Standing         staffing.Standing
	NextOpenPlace    *opendays.OpenPlace
	NextOpenDay      *NextOpenDay
}

// ComingUpItem is one upcoming commitment. OpenDayID, PeriodID and ShortStaffed are set for open days, EventID and
// PublicID for event shifts.
type ComingUpItem struct {
	Kind             ItemKind
	ID               uuid.UUID
	Title            string
	StartsAt, EndsAt time.Time
	OpenDayID        *uuid.UUID
	PeriodID         *uuid.UUID
	ShortStaffed     *bool
	EventID          *uuid.UUID
	PublicID         *string
	// openSupervisorPlaces feeds NextOpenDay; it is not part of the item itself.
	openSupervisorPlaces int
}

type Statistics struct {
	OpenDaysStaffed int
	OpenDayHours    float64
	EventShifts     int
	EventShiftHours float64
	MemberSince     time.Time
	// Jobs is nil when the principal may not read machine jobs.
	Jobs *machinelogbook.OwnJobStatistics
}

// Balance is what the person owes: unpaid own orders and own priced jobs that are on no order yet. Totals are
// decimal strings in EUR with two places.
type Balance struct {
	UnpaidOrders      []orders.OwnOrder
	UnbilledJobs      []machinelogbook.OwnUnbilledJob
	UnpaidOrdersTotal string
	UnbilledJobsTotal string
	Total             string
}

// Dashboard sections are nil when the principal may not see them.
type Dashboard struct {
	Person       Person
	Staffing     *Staffing
	ComingUp     []ComingUpItem
	Statistics   *Statistics
	Balance      *Balance
	RecentJobs   []machinelogbook.OwnRecentJob
	RecentOrders []orders.OwnOrder
}

type Service struct {
	pool     *pgxpool.Pool
	staffing *staffing.Service
	opendays *opendays.Service
	events   *events.Service
	orders   *orders.Service
	jobs     *machinelogbook.Service
}

func NewService(
	pool *pgxpool.Pool,
	staffingService *staffing.Service,
	openDaysService *opendays.Service,
	eventsService *events.Service,
	ordersService *orders.Service,
	jobsService *machinelogbook.Service,
) *Service {
	return &Service{
		pool:     pool,
		staffing: staffingService,
		opendays: openDaysService,
		events:   eventsService,
		orders:   ordersService,
		jobs:     jobsService,
	}
}

// Get builds the dashboard of the principal's own person.
func (s *Service) Get(ctx context.Context, principal authorization.Principal) (Dashboard, error) {
	now := time.Now().UTC()
	person, err := dashboarddb.New(s.pool).GetOwnDashboardPerson(ctx, principal.PersonID)
	if err != nil {
		return Dashboard{}, err
	}
	result := Dashboard{Person: Person{FirstName: person.FirstName, MemberSince: person.MemberSince.Time}}
	kind, err := s.staffing.PersonKind(ctx, principal.PersonID)
	if err != nil {
		return Dashboard{}, err
	}
	canReadOpenDays := principal.Has(authorization.OpenDaysRead)

	result.ComingUp = []ComingUpItem{}
	if canReadOpenDays {
		days, err := s.opendays.OwnComingUp(ctx, principal, now)
		if err != nil {
			return Dashboard{}, err
		}
		for _, day := range days {
			shortStaffed := day.OpenSupervisorPlaces > 0
			result.ComingUp = append(result.ComingUp, ComingUpItem{
				Kind: ItemOpenDay, ID: day.AssignmentID, Title: day.PeriodName,
				StartsAt: day.StartsAt, EndsAt: day.EndsAt, OpenDayID: &day.OpenDayID, PeriodID: &day.PeriodID,
				ShortStaffed:         &shortStaffed,
				openSupervisorPlaces: day.OpenSupervisorPlaces,
			})
		}
	}
	shifts, err := s.events.OwnComingUpShifts(ctx, principal, now)
	if err != nil {
		return Dashboard{}, err
	}
	for _, shift := range shifts {
		item := ComingUpItem{
			Kind: ItemEventShift, ID: shift.AssignmentID, Title: shift.EventTitle + " – " + shift.ShiftName,
			StartsAt: shift.StartsAt, EndsAt: shift.EndsAt, EventID: &shift.EventID,
		}
		if shift.PublicID != "" {
			item.PublicID = &shift.PublicID
		}
		result.ComingUp = append(result.ComingUp, item)
	}
	sort.SliceStable(result.ComingUp, func(i, j int) bool {
		return result.ComingUp[i].StartsAt.Before(result.ComingUp[j].StartsAt)
	})

	if kind != nil && canReadOpenDays {
		section, err := s.staffingSection(ctx, principal, *kind, now, result.ComingUp)
		if err != nil {
			return Dashboard{}, err
		}
		result.Staffing = section
	}
	if kind != nil || principal.Has(authorization.OpenDaysSignup) {
		statistics, err := s.statistics(ctx, principal, now, person.MemberSince.Time)
		if err != nil {
			return Dashboard{}, err
		}
		result.Statistics = statistics
	}
	if err = s.finance(ctx, principal, &result); err != nil {
		return Dashboard{}, err
	}
	return result, nil
}

// finance fills the balance, recent orders and recent jobs the principal may see.
func (s *Service) finance(ctx context.Context, principal authorization.Principal, result *Dashboard) error {
	if principal.Has(authorization.OrdersRead) {
		unpaid, err := s.orders.OwnPayableOrders(ctx, principal)
		if err != nil {
			return err
		}
		unbilled, err := s.jobs.OwnUnbilledJobs(ctx, principal)
		if err != nil {
			return err
		}
		ordersTotal, jobsTotal := decimal.Zero, decimal.Zero
		for _, order := range unpaid {
			outstanding, err := decimal.NewFromString(order.OutstandingAmount)
			if err != nil {
				return err
			}
			ordersTotal = ordersTotal.Add(outstanding)
		}
		for _, job := range unbilled {
			jobsTotal = jobsTotal.Add(job.Price)
		}
		result.Balance = &Balance{
			UnpaidOrders:      unpaid,
			UnbilledJobs:      unbilled,
			UnpaidOrdersTotal: ordersTotal.StringFixed(2),
			UnbilledJobsTotal: jobsTotal.StringFixed(2),
			Total:             ordersTotal.Add(jobsTotal).StringFixed(2),
		}
		if result.RecentOrders, err = s.orders.OwnRecentOrders(ctx, principal); err != nil {
			return err
		}
	}
	if principal.Has(authorization.MachineJobsRead) {
		jobs, err := s.jobs.OwnRecentJobs(ctx, principal)
		if err != nil {
			return err
		}
		result.RecentJobs = jobs
	}
	return nil
}

func (s *Service) staffingSection(
	ctx context.Context,
	principal authorization.Principal,
	kind roles.StaffingLevel,
	now time.Time,
	comingUp []ComingUpItem,
) (*Staffing, error) {
	semester, err := s.staffing.CurrentSemester(ctx, now)
	if err != nil {
		return nil, err
	}
	requirements, err := s.staffing.Settings(ctx)
	if err != nil {
		return nil, err
	}
	counts, err := s.staffing.Counts(ctx, semester, now, &principal.PersonID)
	if err != nil {
		return nil, err
	}
	minimums, err := s.staffing.Minimums(ctx, requirements.MinOpenDaysPerSemester, &principal.PersonID)
	if err != nil {
		return nil, err
	}
	minimum := minimums.For(principal.PersonID)
	personCounts := counts[principal.PersonID]
	place, err := s.opendays.NextOpenPlace(ctx, principal, opendays.RequirementKind(kind), now, OpenPlaceWindow)
	if err != nil {
		return nil, err
	}
	section := &Staffing{
		Kind:             kind,
		Semester:         semester,
		Minimum:          minimum,
		TraineeThreshold: requirements.TraineeOpenDaysForPromotion,
		Counts:           personCounts,
		Standing:         staffing.StatusFor(kind, personCounts, requirements, minimum),
		NextOpenPlace:    place,
	}
	for _, item := range comingUp {
		if item.Kind == ItemOpenDay {
			section.NextOpenDay = &NextOpenDay{
				OpenDayID: *item.OpenDayID, StartsAt: item.StartsAt, EndsAt: item.EndsAt,
				OpenSupervisorPlaces: item.openSupervisorPlaces, ShortStaffed: item.openSupervisorPlaces > 0,
			}
			break
		}
	}
	return section, nil
}

func (s *Service) statistics(
	ctx context.Context,
	principal authorization.Principal,
	now, memberSince time.Time,
) (*Statistics, error) {
	days, dayDuration, err := s.opendays.OwnStatistics(ctx, principal, now)
	if err != nil {
		return nil, err
	}
	shifts, shiftDuration, err := s.events.OwnShiftStatistics(ctx, principal, now)
	if err != nil {
		return nil, err
	}
	result := &Statistics{
		OpenDaysStaffed: days, OpenDayHours: hours(dayDuration),
		EventShifts: shifts, EventShiftHours: hours(shiftDuration), MemberSince: memberSince,
	}
	if principal.Has(authorization.MachineJobsRead) {
		jobs, err := s.jobs.OwnStatistics(ctx, principal)
		if err != nil {
			return nil, err
		}
		result.Jobs = &jobs
	}
	return result, nil
}

// hours rounds a duration to tenths of an hour.
func hours(duration time.Duration) float64 { return math.Round(duration.Hours()*10) / 10 }
