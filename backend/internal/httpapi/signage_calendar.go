package httpapi

import (
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/events"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/opendays"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/signage"
)

// publicCalendar feeds the signage live data from the public Open Days and Events views.
type publicCalendar struct {
	openDays *opendays.Service
	events   *events.Service
}

func (c publicCalendar) UpcomingOpenDays(
	ctx context.Context,
	now time.Time,
	limit int,
) ([]signage.PublicOpenDay, error) {
	days, err := c.openDays.ListPublic(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]signage.PublicOpenDay, 0, limit)
	for _, day := range days { // already ordered by start
		if len(result) == limit {
			break
		}
		if day.EndsAt.After(now) {
			result = append(
				result,
				signage.PublicOpenDay{StartsAt: day.StartsAt.UTC(), EndsAt: day.EndsAt.UTC(), Status: string(day.Status)},
			)
		}
	}
	return result, nil
}

func (c publicCalendar) UpcomingEvents(ctx context.Context, now time.Time, limit int) ([]signage.PublicEvent, error) {
	upcoming, err := c.events.ListUpcomingPublic(ctx, now, limit)
	if err != nil {
		return nil, err
	}
	result := make([]signage.PublicEvent, 0, len(upcoming))
	for _, event := range upcoming {
		result = append(
			result,
			signage.PublicEvent{Title: event.Title, StartsAt: event.StartsAt, Location: event.Location},
		)
	}
	return result, nil
}
