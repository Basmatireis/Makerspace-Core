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

// OwnShiftStatistics counts the ended shifts the current person worked, all time, with their scheduled duration.
func (s *Service) OwnShiftStatistics(
	ctx context.Context,
	principal authorization.Principal,
	now time.Time,
) (int, time.Duration, error) {
	row, err := eventsdb.New(s.pool).GetOwnShiftStatistics(
		ctx,
		eventsdb.GetOwnShiftStatisticsParams{PersonID: &principal.PersonID, Now: now},
	)
	if err != nil {
		return 0, 0, err
	}
	return int(row.Shifts), time.Duration(row.ScheduledSeconds * float64(time.Second)), nil
}
