package calendarfeed

import (
	"bytes"
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	calendarfeeddb "github.com/Basmatireis/Makerspace-Core/backend/internal/calendarfeed/db"
	"github.com/emersion/go-ical"
	"github.com/google/uuid"
)

// ICS returns the iCalendar feed behind a token: the owner's open-day timeslots and event shifts from Window back on.
// The content names only the owner's own commitments, never another person.
func (s *Service) ICS(ctx context.Context, token string) ([]byte, error) {
	person, err := s.ownerOf(ctx, token)
	if err != nil {
		return nil, err
	}
	now := s.now()
	since := now.Add(-Window)
	queries := calendarfeeddb.New(s.pool)
	openDays, err := queries.ListCalendarFeedOpenDays(ctx, calendarfeeddb.ListCalendarFeedOpenDaysParams{
		PersonID: person, Since: since,
	})
	if err != nil {
		return nil, fmt.Errorf("list calendar feed open days: %w", err)
	}
	shifts, err := queries.ListCalendarFeedShifts(ctx, calendarfeeddb.ListCalendarFeedShiftsParams{
		PersonID: person, Since: since,
	})
	if err != nil {
		return nil, fmt.Errorf("list calendar feed shifts: %w", err)
	}
	s.touch(ctx, person, now)

	cal := ical.NewCalendar()
	cal.Props.SetText(ical.PropProductID, "-//HTUGraz Makerspace//My Calendar//EN")
	cal.Props.SetText(ical.PropVersion, "2.0")
	cal.Props.SetText(ical.PropCalendarScale, "GREGORIAN")
	cal.Props.SetText(ical.PropName, "Makerspace")
	if len(openDays)+len(shifts) == 0 {
		// A calendar needs at least one component; an empty feed carries a neutral time zone, as the public feed does.
		cal.Children = append(cal.Children, utcZone())
	}
	stamp := now.Truncate(time.Second)
	for _, row := range openDays {
		event := newEvent(row.TimeslotID, row.StartsAt, row.EndsAt, stamp, row.UpdatedAt, row.Version)
		event.Props.SetText(ical.PropSummary, "Open day · "+placeLabel(row.Kind))
		setStatus(event, row.Status == "cancelled")
		cal.Children = append(cal.Children, event.Component)
	}
	for _, row := range shifts {
		event := newEvent(
			row.ShiftID, row.StartsAt, row.EndsAt, stamp, laterOf(row.ShiftUpdatedAt, row.EventUpdatedAt),
			int64(row.ShiftVersion)+int64(row.EventVersion),
		)
		event.Props.SetText(ical.PropSummary, row.EventName+" · "+row.ShiftName)
		if row.Location != "" {
			event.Props.SetText(ical.PropLocation, row.Location)
		}
		setStatus(event, row.ShiftStatus == "cancelled" || row.EventStatus == "cancelled")
		cal.Children = append(cal.Children, event.Component)
	}
	var buffer bytes.Buffer
	if err := ical.NewEncoder(&buffer).Encode(cal); err != nil {
		return nil, fmt.Errorf("encode calendar feed: %w", err)
	}
	return buffer.Bytes(), nil
}

// newEvent starts an event whose UID is the stable id of the timeslot or shift, so a calendar updates the entry in
// place when times change. SEQUENCE follows the version of the source row, which only grows.
func newEvent(id uuid.UUID, start, end, stamp, modified time.Time, sequence int64) *ical.Event {
	event := ical.NewEvent()
	event.Props.SetText(ical.PropUID, "urn:uuid:"+id.String())
	event.Props.SetDateTime(ical.PropDateTimeStart, start.UTC())
	event.Props.SetDateTime(ical.PropDateTimeEnd, end.UTC())
	event.Props.SetDateTime(ical.PropDateTimeStamp, stamp)
	event.Props.SetDateTime(ical.PropLastModified, modified.UTC())
	// SEQUENCE is an INTEGER; SetText would add a VALUE=TEXT parameter that strict clients reject.
	prop := ical.NewProp(ical.PropSequence)
	prop.Value = strconv.FormatInt(sequence, 10)
	event.Props.Set(prop)
	return event
}

func setStatus(event *ical.Event, cancelled bool) {
	if cancelled {
		event.SetStatus(ical.EventCancelled)
		return
	}
	event.SetStatus(ical.EventConfirmed)
}

func placeLabel(kind string) string {
	if kind == "" {
		return kind
	}
	return strings.ToUpper(kind[:1]) + kind[1:]
}

func laterOf(a, b time.Time) time.Time {
	if b.After(a) {
		return b
	}
	return a
}

func utcZone() *ical.Component {
	zone := ical.NewComponent(ical.CompTimezone)
	zone.Props.SetText(ical.PropTimezoneID, "UTC")
	standard := ical.NewComponent(ical.CompTimezoneStandard)
	standard.Props.SetDateTime(ical.PropDateTimeStart, time.Date(1970, time.January, 1, 0, 0, 0, 0, time.UTC))
	standard.Props.SetText(ical.PropTimezoneOffsetFrom, "+0000")
	standard.Props.SetText(ical.PropTimezoneOffsetTo, "+0000")
	zone.Children = append(zone.Children, standard)
	return zone
}
