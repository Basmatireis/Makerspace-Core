package opendays

import (
	"context"
	"sort"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/inbox"
	opendaysdb "github.com/Basmatireis/Makerspace-Core/backend/internal/opendays/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// heldSlot is one person's place in one timeslot as a schedule save sees it.
type heldSlot struct {
	person, openDay, timeslot uuid.UUID
	startsAt, endsAt          time.Time
	scheduled                 bool
}

// snapshotHeldSlots lists the assignments of a period by assignment id.
func snapshotHeldSlots(ctx context.Context, q *opendaysdb.Queries, periodID uuid.UUID) (map[uuid.UUID]heldSlot, error) {
	rows, err := q.ListPeriodAssignmentSlots(ctx, periodID)
	if err != nil {
		return nil, err
	}
	held := make(map[uuid.UUID]heldSlot, len(rows))
	for _, row := range rows {
		held[row.ID] = heldSlot{
			person:    row.PersonID,
			openDay:   row.OpenDayID,
			timeslot:  row.TimeslotID,
			startsAt:  row.StartsAt,
			endsAt:    row.EndsAt,
			scheduled: DayStatus(row.Status) == DayScheduled,
		}
	}
	return held, nil
}

// dayNotice is what one person is told about one open day after a save.
type dayNotice struct {
	person  uuid.UUID
	openDay uuid.UUID
	kind    inbox.Kind
	slots   []inbox.OpenDaySlot
}

// noticePriority ranks the kinds for a person whose day changed in several ways in one save: the most serious
// change is the one they hear about.
func noticePriority(kind inbox.Kind) int {
	switch kind {
	case inbox.KindOpenDayCancelled:
		return 3
	case inbox.KindOpenDayTimeslotRemoved:
		return 2
	}
	return 1
}

// diffHeldSlots compares the assignments before and after a save and returns one notice per person and open day:
// cancelled when the day was cancelled or deleted, removed when the timeslot (and with it the place) is gone, changed
// when its times moved. Places in timeslots that had ended before now and the actor's own places stay quiet.
func diffHeldSlots(
	before, after map[uuid.UUID]heldSlot,
	removedDays map[uuid.UUID]bool,
	actor uuid.UUID,
	now time.Time,
) []dayNotice {
	type key struct{ person, openDay uuid.UUID }
	grouped := map[key]*dayNotice{}
	for id, old := range before {
		if !old.scheduled || !old.endsAt.After(now) || old.person == actor {
			continue
		}
		var kind inbox.Kind
		slot := inbox.OpenDaySlot{StartsAt: old.startsAt, EndsAt: old.endsAt}
		current, kept := after[id]
		switch {
		case removedDays[old.openDay]:
			kind = inbox.KindOpenDayCancelled
		case !kept:
			kind = inbox.KindOpenDayTimeslotRemoved
		case !current.startsAt.Equal(old.startsAt) || !current.endsAt.Equal(old.endsAt):
			kind = inbox.KindOpenDayTimeslotChanged
			slot = inbox.OpenDaySlot{
				StartsAt: current.startsAt, EndsAt: current.endsAt, WasStartsAt: old.startsAt, WasEndsAt: old.endsAt,
			}
		default:
			continue
		}
		k := key{person: old.person, openDay: old.openDay}
		entry, ok := grouped[k]
		if !ok || noticePriority(kind) > noticePriority(entry.kind) {
			grouped[k] = &dayNotice{person: old.person, openDay: old.openDay, kind: kind, slots: []inbox.OpenDaySlot{slot}}
			continue
		}
		if kind == entry.kind {
			entry.slots = append(entry.slots, slot)
		}
	}
	notices := make([]dayNotice, 0, len(grouped))
	for _, entry := range grouped {
		sort.Slice(entry.slots, func(i, j int) bool { return entry.slots[i].StartsAt.Before(entry.slots[j].StartsAt) })
		notices = append(notices, *entry)
	}
	sort.Slice(notices, func(i, j int) bool {
		if notices[i].person != notices[j].person {
			return notices[i].person.String() < notices[j].person.String()
		}
		return notices[i].openDay.String() < notices[j].openDay.String()
	})
	return notices
}

// notifyScheduleChanges tells the people whose places a save moved, removed or cancelled, in the save's transaction.
// A deleted open day (draft periods) has no page any more, so its notice links to the period.
func (w *scheduleWriter) notifyScheduleChanges(ctx context.Context, before map[uuid.UUID]heldSlot) error {
	after, err := snapshotHeldSlots(ctx, w.q, w.period.ID)
	if err != nil {
		return err
	}
	for _, notice := range diffHeldSlots(before, after, w.removedDays, w.principal.PersonID, w.now) {
		target := inbox.OpenDayNotice{PeriodID: w.period.ID, OpenDayID: notice.openDay, Slots: notice.slots}
		if w.deletedDays[notice.openDay] {
			target.OpenDayID = uuid.Nil
		}
		if err := w.s.inbox.OpenDayPersonNotice(ctx, w.tx, notice.kind, notice.person, target, w.s.location); err != nil {
			return err
		}
	}
	return nil
}

// notifyAssignmentChange tells a person that somebody else assigned them to, or removed them from, a timeslot.
func (s *Service) notifyAssignmentChange(
	ctx context.Context,
	tx pgx.Tx,
	kind inbox.Kind,
	personID uuid.UUID,
	periodID, openDayID uuid.UUID,
	slot opendaysdb.OpenDayTimeslot,
) error {
	return s.inbox.OpenDayPersonNotice(ctx, tx, kind, personID, inbox.OpenDayNotice{
		PeriodID:  periodID,
		OpenDayID: openDayID,
		Slots:     []inbox.OpenDaySlot{{StartsAt: slot.StartsAt, EndsAt: slot.EndsAt}},
	}, s.location)
}
