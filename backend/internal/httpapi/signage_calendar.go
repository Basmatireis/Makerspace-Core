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

func publicOpenDay(day opendays.PublicOpenDay) signage.PublicOpenDay {
	return signage.PublicOpenDay{StartsAt: day.StartsAt.UTC(), EndsAt: day.EndsAt.UTC(), Status: string(day.Status)}
}

func publicEvent(event events.UpcomingPublicEvent) signage.PublicEvent {
	endsAt := event.EndsAt
	return signage.PublicEvent{
		Title: event.Title, StartsAt: event.StartsAt, EndsAt: &endsAt, Location: event.Location,
	}
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
			result = append(result, publicOpenDay(day))
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
		result = append(result, publicEvent(event))
	}
	return result, nil
}

// OpenDaysBetween lists the open days of published periods that overlap [from, to), past ones included.
func (c publicCalendar) OpenDaysBetween(
	ctx context.Context,
	from, to time.Time,
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
		if day.StartsAt.Before(to) && day.EndsAt.After(from) {
			result = append(result, publicOpenDay(day))
		}
	}
	return result, nil
}

// EventsBetween lists the public sessions of publicly visible events that overlap [from, to), past ones included.
func (c publicCalendar) EventsBetween(
	ctx context.Context,
	from, to time.Time,
	limit int,
) ([]signage.PublicEvent, error) {
	sessions, err := c.events.ListPublicBetween(ctx, from, to, limit)
	if err != nil {
		return nil, err
	}
	result := make([]signage.PublicEvent, 0, len(sessions))
	for _, session := range sessions {
		result = append(result, publicEvent(session))
	}
	return result, nil
}

func (c publicCalendar) HolidaysBetween(_ context.Context, from, to time.Time) ([]signage.CalendarHoliday, error) {
	holidays, err := c.openDays.PublicHolidaysBetween(from, to)
	if err != nil {
		return nil, err
	}
	result := make([]signage.CalendarHoliday, 0, len(holidays))
	for _, holiday := range holidays {
		result = append(result, signage.CalendarHoliday{Date: holiday.Date, Name: holiday.Name})
	}
	return result, nil
}

func (c publicCalendar) BreaksBetween(ctx context.Context, from, to time.Time) ([]signage.CalendarBreak, error) {
	breaks, err := c.openDays.PublicAcademicBreaksBetween(ctx, from, to)
	if err != nil {
		return nil, err
	}
	result := make([]signage.CalendarBreak, 0, len(breaks))
	for _, item := range breaks {
		result = append(result, signage.CalendarBreak{Name: item.Name, StartsOn: item.StartsOn, EndsOn: item.EndsOn})
	}
	return result, nil
}
