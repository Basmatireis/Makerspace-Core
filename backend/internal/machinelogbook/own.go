package machinelogbook

import (
	"context"
	"errors"
	"math"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
)

// OwnRecentJobsLimit is how many of the latest jobs the personal dashboard lists.
const OwnRecentJobsLimit = 5

// OwnStatisticsMonths is how many calendar months the personal jobs-per-month figure covers.
const OwnStatisticsMonths = 12

// OwnUnbilledJob is one of the principal's own jobs that they still owe because it is on no order.
type OwnUnbilledJob struct {
	ID          uuid.UUID
	DisplayID   string
	Title       string
	MachineName string
	StartedAt   time.Time
	Price       decimal.Decimal
}

// OwnRecentJob is a job the principal is the customer or the operator of. Billing and order are set for own jobs only.
type OwnRecentJob struct {
	ID             uuid.UUID
	DisplayID      string
	Title          string
	MachineName    string
	StartedAt      *time.Time
	EndedAt        *time.Time
	Status         WorkItemStatus
	Price          *string
	Own            bool
	Billing        *BillingState
	OrderReference *string
}

// OwnJobMonth counts the principal's jobs of one calendar month (YYYY-MM).
type OwnJobMonth struct {
	Month string
	Jobs  int
}

// OwnFavouriteMachine is the machine with most of the principal's jobs.
type OwnFavouriteMachine struct {
	Name string
	Jobs int
}

// OwnJobStatistics are the all-time figures of the principal's own jobs.
type OwnJobStatistics struct {
	Jobs             int
	SuccessfulJobs   int
	FinishedJobs     int
	SuccessRate      *int
	MaterialGrams    float64
	MachineSeconds   int64
	FavouriteMachine *OwnFavouriteMachine
	JobsPerMonth     []OwnJobMonth
}

// OwnUnbilledJobs lists the principal's own jobs that still have to be paid; never another person's.
func (s *Service) OwnUnbilledJobs(ctx context.Context, p authorization.Principal) ([]OwnUnbilledJob, error) {
	if err := require(p, authorization.OrdersRead); err != nil {
		return nil, err
	}
	rows, err := machinelogbookdb.New(s.pool).ListOwnUnbilledJobs(ctx, &p.PersonID)
	if err != nil {
		return nil, err
	}
	jobs := make([]OwnUnbilledJob, 0, len(rows))
	for _, row := range rows {
		job := OwnUnbilledJob{
			ID:          row.ID,
			DisplayID:   row.DisplayID,
			Title:       row.Title,
			MachineName: row.MachineName,
			Price:       decimalFromNumeric(row.Price),
		}
		if started := anyTime(row.StartedAt); started != nil {
			job.StartedAt = *started
		}
		jobs = append(jobs, job)
	}
	return jobs, nil
}

// OwnRecentJobs lists the latest jobs the principal is the customer or the operator of.
func (s *Service) OwnRecentJobs(ctx context.Context, p authorization.Principal) ([]OwnRecentJob, error) {
	if err := require(p, authorization.MachineJobsRead); err != nil {
		return nil, err
	}
	rows, err := machinelogbookdb.New(s.pool).ListOwnRecentJobs(
		ctx,
		machinelogbookdb.ListOwnRecentJobsParams{PersonID: p.PersonID, PageLimit: OwnRecentJobsLimit},
	)
	if err != nil {
		return nil, err
	}
	jobs := make([]OwnRecentJob, 0, len(rows))
	for _, row := range rows {
		job := OwnRecentJob{
			ID:          row.ID,
			DisplayID:   row.DisplayID,
			Title:       row.Title,
			MachineName: row.MachineName,
			StartedAt:   anyTime(row.StartedAt),
			EndedAt:     anyTime(row.EndedAt),
			Status:      WorkItemStatus(row.Status),
			Own:         row.Own,
		}
		if row.EffectivePrice.Valid {
			price := decimalFromNumeric(row.EffectivePrice).StringFixed(2)
			job.Price = &price
		}
		// A job run for someone else belongs to their billing, which is none of the operator's business.
		if row.Own {
			billing := BillingState(row.BillingState)
			job.Billing = &billing
			job.OrderReference = row.OrderReference
		}
		jobs = append(jobs, job)
	}
	return jobs, nil
}

// OwnStatistics sums up the principal's own jobs of all time, with their jobs per month of the last twelve months.
func (s *Service) OwnStatistics(ctx context.Context, p authorization.Principal) (OwnJobStatistics, error) {
	if err := require(p, authorization.MachineJobsRead); err != nil {
		return OwnJobStatistics{}, err
	}
	q := machinelogbookdb.New(s.pool)
	totals, err := q.GetOwnJobStatistics(ctx, &p.PersonID)
	if err != nil {
		return OwnJobStatistics{}, err
	}
	result := OwnJobStatistics{
		Jobs:           int(totals.Jobs),
		SuccessfulJobs: int(totals.SuccessfulJobs),
		FinishedJobs:   int(totals.FinishedJobs),
		MaterialGrams:  math.Round(totals.MaterialGrams*10) / 10,
		MachineSeconds: totals.MachineSeconds,
		JobsPerMonth:   make([]OwnJobMonth, 0, OwnStatisticsMonths),
	}
	if totals.FinishedJobs > 0 {
		rate := int(math.Round(100 * float64(totals.SuccessfulJobs) / float64(totals.FinishedJobs)))
		result.SuccessRate = &rate
	}
	favourite, err := q.GetOwnFavouriteMachine(ctx, &p.PersonID)
	if err == nil {
		result.FavouriteMachine = &OwnFavouriteMachine{Name: favourite.Name, Jobs: int(favourite.Jobs)}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return OwnJobStatistics{}, err
	}
	now := s.now().UTC()
	from := time.Date(now.Year(), now.Month()-(OwnStatisticsMonths-1), 1, 0, 0, 0, 0, time.UTC)
	months, err := q.ListOwnJobsPerMonth(
		ctx,
		machinelogbookdb.ListOwnJobsPerMonthParams{FromTime: from, Now: now, PersonID: &p.PersonID},
	)
	if err != nil {
		return OwnJobStatistics{}, err
	}
	for _, month := range months {
		result.JobsPerMonth = append(result.JobsPerMonth, OwnJobMonth{Month: month.Month, Jobs: int(month.Jobs)})
	}
	return result, nil
}
