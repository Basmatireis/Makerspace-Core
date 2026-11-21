package events

import (
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	eventsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/events/db"
	"github.com/google/uuid"
)

// ComingUpShift is an upcoming shift the current person is actively assigned to.
type ComingUpShift struct {
	AssignmentID, EventID uuid.UUID
	// PublicID is empty for events that are not public.
	PublicID         string
	EventTitle       string
	ShiftName        string
	StartsAt, EndsAt time.Time
}

// OwnComingUpShifts lists the current person's active assignments on shifts that have not ended, across all events.
// It is scoped to the principal's own person and needs no permission beyond authentication.
func (s *Service) OwnComingUpShifts(
	ctx context.Context,
	principal authorization.Principal,
	now time.Time,
) ([]ComingUpShift, error) {
	rows, err := eventsdb.New(s.pool).ListOwnComingUpShifts(
		ctx,
		eventsdb.ListOwnComingUpShiftsParams{PersonID: &principal.PersonID, Now: now},
	)
	if err != nil {
		return nil, err
	}
	items := make([]ComingUpShift, 0, len(rows))
	for _, row := range rows {
		items = append(items, ComingUpShift{
			AssignmentID: row.AssignmentID, EventID: row.EventID, PublicID: row.PublicID,
			EventTitle: row.EventTitle, ShiftName: row.ShiftName, StartsAt: row.StartsAt, EndsAt: row.EndsAt,
		})
	}
	return items, nil
}

// OwnShiftStatistics are the ended shifts the current person worked, all time.
type OwnShiftStatistics struct {
	Shifts   int
	Duration time.Duration
	// LastStartedAt is the start of the latest of them; nil without any.
	LastStartedAt *time.Time
}

// OwnShiftStatistics counts the ended shifts the current person worked, all time, with their scheduled duration.
func (s *Service) OwnShiftStatistics(
	ctx context.Context,
	principal authorization.Principal,
	now time.Time,
) (OwnShiftStatistics, error) {
	row, err := eventsdb.New(s.pool).GetOwnShiftStatistics(
		ctx,
		eventsdb.GetOwnShiftStatisticsParams{PersonID: &principal.PersonID, Now: now},
	)
	if err != nil {
		return OwnShiftStatistics{}, err
	}
	result := OwnShiftStatistics{
		Shifts:   int(row.Shifts),
		Duration: time.Duration(row.ScheduledSeconds * float64(time.Second)),
	}
	if last, ok := row.LastStartedAt.(time.Time); ok {
		last = last.UTC()
		result.LastStartedAt = &last
	}
	return result, nil
}
