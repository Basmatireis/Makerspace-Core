package signage

import (
	"context"
	"encoding/json"
	"time"
)

const (
	calendarMaxHolidays = 60
	calendarMaxBreaks   = 20
	calendarMaxOpenDays = 100
	calendarMaxEvents   = 100

	// The calendar range starts this many days before the first day of the current month (so the
	// leading days of a month grid are filled) and ends this many days after today (seven weeks, which
	// covers the longest weeks view).
	calendarDaysBeforeMonth = 7
	calendarDaysAfterToday  = 49
)

// CalendarHoliday is a public holiday on a calendar date.
type CalendarHoliday struct {
	Date time.Time
	Name string
}

// CalendarBreak is an academic break; both dates are inclusive.
type CalendarBreak struct {
	Name             string
	StartsOn, EndsOn time.Time
}

// CalendarBlock is the data of the calendar widget: everything inside From..To (dates, inclusive) in
// the makerspace time zone. Categories no widget asked for stay empty.
type CalendarBlock struct {
	From, To time.Time
	Holidays []CalendarHoliday
	Breaks   []CalendarBreak
	OpenDays []PublicOpenDay
	Events   []PublicEvent
}

// calendarCategories says which parts of the calendar block some published widget shows.
type calendarCategories struct {
	holidays, breaks, openDays, events bool
}

func allCalendarCategories() calendarCategories {
	return calendarCategories{holidays: true, breaks: true, openDays: true, events: true}
}

// calendarCategoriesOf collects the categories the calendar widgets of a publication show. present
// reports whether the publication has any calendar widget at all.
func calendarCategoriesOf(manifest Manifest) (categories calendarCategories, present bool) {
	for _, scene := range manifest.Scenes {
		for _, raw := range scene.Zones {
			var widget struct {
				Type         WidgetType `json:"type"`
				ShowHolidays bool       `json:"showHolidays"`
				ShowBreaks   bool       `json:"showBreaks"`
				ShowOpenDays bool       `json:"showOpenDays"`
				ShowEvents   bool       `json:"showEvents"`
			}
			if json.Unmarshal(raw, &widget) != nil || widget.Type != WidgetCalendar {
				continue
			}
			present = true
			categories.holidays = categories.holidays || widget.ShowHolidays
			categories.breaks = categories.breaks || widget.ShowBreaks
			categories.openDays = categories.openDays || widget.ShowOpenDays
			categories.events = categories.events || widget.ShowEvents
		}
	}
	return categories, present
}

// calendarRange is the date range of the calendar block: From and To are calendar dates (UTC midnight,
// inclusive); Start and End are the matching instants in the makerspace time zone (End is exclusive).
type calendarRange struct {
	From, To   time.Time
	Start, End time.Time
}

// calendarRangeAt computes the range for the moment now: from 7 days before the first day of the current
// month to 49 days after today, both dates inclusive, in the given time zone.
func calendarRangeAt(now time.Time, location *time.Location) calendarRange {
	year, month, day := now.In(location).Date()
	from := time.Date(year, month, 1, 0, 0, 0, 0, time.UTC).AddDate(0, 0, -calendarDaysBeforeMonth)
	to := time.Date(year, month, day, 0, 0, 0, 0, time.UTC).AddDate(0, 0, calendarDaysAfterToday)
	return calendarRange{
		From:  from,
		To:    to,
		Start: time.Date(from.Year(), from.Month(), from.Day(), 0, 0, 0, 0, location),
		End:   time.Date(to.Year(), to.Month(), to.Day()+1, 0, 0, 0, 0, location),
	}
}

// buildCalendar loads the calendar block with the given categories. Without a public calendar
// source the lists stay empty.
func (s *Service) buildCalendar(ctx context.Context, now time.Time, categories calendarCategories) (*CalendarBlock, error) {
	span := calendarRangeAt(now, s.location)
	block := &CalendarBlock{
		From:     span.From,
		To:       span.To,
		Holidays: []CalendarHoliday{},
		Breaks:   []CalendarBreak{},
		OpenDays: []PublicOpenDay{},
		Events:   []PublicEvent{},
	}
	if s.calendar == nil {
		return block, nil
	}
	var err error
	if categories.holidays {
		if block.Holidays, err = s.calendar.HolidaysBetween(ctx, span.From, span.To); err != nil {
			return nil, err
		}
		block.Holidays = firstN(block.Holidays, calendarMaxHolidays)
	}
	if categories.breaks {
		if block.Breaks, err = s.calendar.BreaksBetween(ctx, span.From, span.To); err != nil {
			return nil, err
		}
		block.Breaks = firstN(block.Breaks, calendarMaxBreaks)
	}
	if categories.openDays {
		if block.OpenDays, err = s.calendar.OpenDaysBetween(ctx, span.Start, span.End, calendarMaxOpenDays); err != nil {
			return nil, err
		}
		block.OpenDays = firstN(block.OpenDays, calendarMaxOpenDays)
	}
	if categories.events {
		if block.Events, err = s.calendar.EventsBetween(ctx, span.Start, span.End, calendarMaxEvents); err != nil {
			return nil, err
		}
		block.Events = firstN(block.Events, calendarMaxEvents)
	}
	return block, nil
}

// firstN returns at most n items and never nil.
func firstN[T any](items []T, n int) []T {
	if items == nil {
		return []T{}
	}
	if len(items) > n {
		return items[:n]
	}
	return items
}
