package inbox

import (
	"context"
	"fmt"
	"strings"
	"time"

	inboxdb "github.com/Basmatireis/Makerspace-Core/backend/internal/inbox/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// OpenDaySlot is one timeslot an open-day notice talks about. WasStartsAt and WasEndsAt hold the earlier times of a
// timeslot that moved and are zero otherwise.
type OpenDaySlot struct {
	StartsAt, EndsAt       time.Time
	WasStartsAt, WasEndsAt time.Time
}

// OpenDayNotice describes the timeslots of one open day that changed for one person. One notice covers a person's
// whole day, so a save that touches several of their timeslots still sends one notification. A zero OpenDayID names
// an open day that no longer exists; the notice then links to its period.
type OpenDayNotice struct {
	PeriodID, OpenDayID uuid.UUID
	Slots               []OpenDaySlot
}

// OpenDayPersonNotice tells one person, in the app and while mail delivery is on by e-mail, what changed about their
// own staffing of an open day. kind must be one of the open-day change kinds; a person without an enabled account
// gets nothing. The times are written in location. It never decides who caused the change: callers leave out the
// person who acted.
func (e *Emitter) OpenDayPersonNotice(
	ctx context.Context,
	tx pgx.Tx,
	kind Kind,
	personID uuid.UUID,
	input OpenDayNotice,
	location *time.Location,
) error {
	if len(input.Slots) == 0 {
		return nil
	}
	title, body, ok := openDayWording(kind, input, location)
	if !ok {
		return fmt.Errorf("%s is not an open-day change notification", kind)
	}
	link := "/open-days/" + input.PeriodID.String()
	if input.OpenDayID != uuid.Nil {
		link += "/days/" + input.OpenDayID.String()
	}
	queries := inboxdb.New(tx)
	accounts, err := queries.ListEnabledAccountsOfPeople(ctx, uuidTexts([]uuid.UUID{personID}))
	if err != nil {
		return fmt.Errorf("resolve open day notification account: %w", err)
	}
	if len(accounts) == 0 {
		return nil
	}
	recipients := make([]uuid.UUID, 0, len(accounts))
	for _, account := range accounts {
		recipients = append(recipients, account.ID)
	}
	n := notice{kind: kind, title: title, body: body, link: link}
	if err = e.deliver(ctx, tx, n, recipients); err != nil {
		return err
	}
	return queueNoticeMails(ctx, queries, n, []uuid.UUID{personID}, nil)
}

// openDayWording words one open-day change notification.
func openDayWording(kind Kind, input OpenDayNotice, location *time.Location) (title, body string, ok bool) {
	slots := input.Slots
	date := slots[0].StartsAt.In(location).Format("Mon 2 Jan 2006")
	ranges := make([]string, 0, len(slots))
	for _, slot := range slots {
		text := clockRange(slot.StartsAt, slot.EndsAt, location)
		if !slot.WasStartsAt.IsZero() {
			text += " (was " + clockRange(slot.WasStartsAt, slot.WasEndsAt, location) + ")"
		}
		ranges = append(ranges, text)
	}
	list := strings.Join(ranges, ", ")
	plural := len(slots) > 1
	switch kind {
	case KindOpenDayTimeslotChanged:
		return "Your open day times changed",
			fmt.Sprintf(
				"Your %s on the open day of %s %s: %s.", noun(plural), date, verb(plural, "has changed", "have changed"), list,
			),
			true
	case KindOpenDayTimeslotRemoved:
		return "Your open day timeslot was removed",
			fmt.Sprintf(
				"The %s %s on the open day of %s %s removed from the schedule, so you are no longer assigned to %s.",
				noun(plural), list, date, verb(plural, "was", "were"), pronoun(plural),
			), true
	case KindOpenDayCancelled:
		return "Open day cancelled",
			fmt.Sprintf("The open day of %s, where you were assigned (%s), was cancelled.", date, list), true
	case KindOpenDayAssignedByOther:
		return "You were assigned to an open day",
			fmt.Sprintf("You were assigned to the %s %s on the open day of %s.", noun(plural), list, date), true
	case KindOpenDayUnassignedByOther:
		return "You were removed from an open day",
			fmt.Sprintf("You were removed from the %s %s on the open day of %s.", noun(plural), list, date), true
	}
	return "", "", false
}

func clockRange(start, end time.Time, location *time.Location) string {
	return start.In(location).Format("15:04") + "–" + end.In(location).Format("15:04")
}

func noun(plural bool) string {
	if plural {
		return "timeslots"
	}
	return "timeslot"
}

func pronoun(plural bool) string {
	if plural {
		return "them"
	}
	return "it"
}

func verb(plural bool, singular, many string) string {
	if plural {
		return many
	}
	return singular
}
