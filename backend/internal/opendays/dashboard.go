package opendays

import (
	"context"
	"errors"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	opendaysdb "github.com/Basmatireis/Makerspace-Core/backend/internal/opendays/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ComingUpOpenDay is an upcoming open day the current person is on.
type ComingUpOpenDay struct {
	AssignmentID         uuid.UUID
	OpenDayID            uuid.UUID
	PeriodName           string
	StartsAt, EndsAt     time.Time
	OpenSupervisorPlaces int
}

// OpenPlace is an open day with a free place the current person could take.
type OpenPlace struct {
	OpenDayID, RequirementID uuid.UUID
	StartsAt, EndsAt         time.Time
	FreePlaces               int
}

// OwnComingUp lists the current person's upcoming open days, never another person's.
func (s *Service) OwnComingUp(
	ctx context.Context,
	principal authorization.Principal,
	now time.Time,
) ([]ComingUpOpenDay, error) {
	if !principal.Has(authorization.OpenDaysRead) {
		return nil, apperror.PermissionDenied
	}
	rows, err := opendaysdb.New(s.pool).ListOwnComingUpOpenDays(
		ctx,
		opendaysdb.ListOwnComingUpOpenDaysParams{PersonID: principal.PersonID, Now: now},
	)
	if err != nil {
		return nil, err
	}
	items := make([]ComingUpOpenDay, 0, len(rows))
	for _, row := range rows {
		items = append(items, ComingUpOpenDay{
			AssignmentID: row.AssignmentID, OpenDayID: row.OpenDayID, PeriodName: row.PeriodName,
			StartsAt: row.StartsAt, EndsAt: row.EndsAt, OpenSupervisorPlaces: int(row.OpenSupervisorPlaces),
		})
	}
	return items, nil
}

// NextOpenPlace finds the next open day starting within window where the current person is not on yet and a place
// of the given kind is free and open to them; nil when there is none.
func (s *Service) NextOpenPlace(
	ctx context.Context,
	principal authorization.Principal,
	kind RequirementKind,
	now time.Time,
	window time.Duration,
) (*OpenPlace, error) {
	if !principal.Has(authorization.OpenDaysRead) {
		return nil, apperror.PermissionDenied
	}
	row, err := opendaysdb.New(s.pool).GetNextOpenPlace(ctx, opendaysdb.GetNextOpenPlaceParams{
		Kind: string(kind), Now: now, Until: now.Add(window), PersonID: principal.PersonID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &OpenPlace{
		OpenDayID: row.OpenDayID, RequirementID: row.RequirementID,
		StartsAt: row.StartsAt, EndsAt: row.EndsAt, FreePlaces: int(row.FreePlaces),
	}, nil
}

// OwnStatistics counts the ended open days the current person staffed, all time, with their scheduled duration.
func (s *Service) OwnStatistics(
	ctx context.Context,
	principal authorization.Principal,
	now time.Time,
) (int, time.Duration, error) {
	row, err := opendaysdb.New(s.pool).GetOwnOpenDayStatistics(
		ctx,
		opendaysdb.GetOwnOpenDayStatisticsParams{PersonID: principal.PersonID, Now: now},
	)
	if err != nil {
		return 0, 0, err
	}
	return int(row.Staffed), time.Duration(row.ScheduledSeconds * float64(time.Second)), nil
}
