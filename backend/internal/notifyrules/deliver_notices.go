package notifyrules

import (
	"context"
	"fmt"
	"time"

	notifyrulesdb "github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
)

// How long a tablet notice stays when the rule does not say: a banner for a day, the notice that goes with one
// person's check-in for a few minutes, the one waiting for a person's next check-in for a month.
const (
	bannerLifetime        = 24 * time.Hour
	personCheckInLifetime = 10 * time.Minute
	nextCheckInLifetime   = 30 * 24 * time.Hour
)

// deliverSignage puts the notice on signage for the action's duration. The rule does not name displays: the notice is
// stored once and every display shows it that opted in to the rule or to all notices, itself or through its group,
// while the notice lasts. It carries text only: signage never shows job media or people here.
func (d *Dispatcher) deliverSignage(ctx context.Context, q *store, runtime *ruleRuntime, in deliveryInput, now time.Time) error {
	target := in.Action.Signage
	if target == nil {
		return nil
	}
	if err := q.InsertSignageRuleNotice(ctx, notifyrulesdb.InsertSignageRuleNoticeParams{
		ID: ids.New(), FiringID: &in.FiringID, RuleID: runtime.ID, Title: Clip(in.Action.Title, MaxTitleLength),
		Body: Clip(in.Action.Body, MaxBodyLength), Tone: string(target.Tone), StartsAt: now,
		EndsAt: now.Add(time.Duration(target.DurationMinutes) * time.Minute),
	}); err != nil {
		return fmt.Errorf("insert signage notice: %w", err)
	}
	shown, err := q.CountSignageDisplaysShowingRule(ctx, runtime.ID)
	if err != nil {
		return fmt.Errorf("count signage displays: %w", err)
	}
	if shown == 0 {
		return nil
	}
	d.countSent(runtime, ChannelSignage, int(shown))
	return d.logChannel(ctx, q, in, nil, ChannelSignage, statusSent, now)
}

// deliverTablet puts the notice on each chosen tablet. The two person modes address the person the event is about
// (in.People) and respect the category's consent and the rule's conditions on the recipient; the other two address
// whoever is at the tablet.
func (d *Dispatcher) deliverTablet(ctx context.Context, q *store, runtime *ruleRuntime, in deliveryInput, now time.Time) error {
	target := in.Action.Tablet
	if target == nil {
		return nil
	}
	personMode := target.Mode == TabletPersonCheckIn || target.Mode == TabletNextCheckIn
	if !personMode {
		count, err := d.insertKioskNotices(ctx, q, in, nil, now)
		if err != nil || count == 0 {
			return err
		}
		d.countSent(runtime, ChannelTablet, count)
		return d.logChannel(ctx, q, in, nil, ChannelTablet, statusSent, now)
	}
	people := dedupePeople(in.People)
	granted := map[uuid.UUID]bool{}
	if runtime.Consent && len(people) > 0 {
		consented, err := q.ListGrantedConsentPeople(ctx, notifyrulesdb.ListGrantedConsentPeopleParams{
			CategoryID: *runtime.CategoryID, TextVersion: runtime.TextVersion, PersonIds: uuidStrings(people),
		})
		if err != nil {
			return fmt.Errorf("load consents: %w", err)
		}
		for _, person := range consented {
			granted[person] = true
		}
	}
	for _, person := range people {
		person := person
		if runtime.Pass != nil && !runtime.Pass(person) {
			if err := d.logChannel(ctx, q, in, &person, ChannelTablet, statusSkippedCondition, now); err != nil {
				return err
			}
			continue
		}
		if ok, status := channelDecision(runtime.Consent, granted[person], nil, runtime.Mandatory, ChannelTablet); !ok {
			if err := d.logChannel(ctx, q, in, &person, ChannelTablet, status, now); err != nil {
				return err
			}
			continue
		}
		count, err := d.insertKioskNotices(ctx, q, in, &person, now)
		if err != nil {
			return err
		}
		if count == 0 {
			continue
		}
		d.countSent(runtime, ChannelTablet, 1)
		if err = d.logChannel(ctx, q, in, &person, ChannelTablet, statusSent, now); err != nil {
			return err
		}
	}
	return nil
}

// insertKioskNotices writes one row per chosen tablet that share a group, so a notice for a person's next check-in is
// shown once whichever tablet the person uses. It returns how many tablets got a row.
func (d *Dispatcher) insertKioskNotices(
	ctx context.Context,
	q *store,
	in deliveryInput,
	person *uuid.UUID,
	now time.Time,
) (int, error) {
	target := in.Action.Tablet
	group := ids.New()
	expires := d.noticeExpiry(target.Mode, now)
	count := 0
	for _, device := range target.DeviceIDs {
		rows, err := q.InsertKioskRuleNotice(ctx, notifyrulesdb.InsertKioskRuleNoticeParams{
			ID: ids.New(), GroupID: group, FiringID: &in.FiringID, DeviceID: device, Mode: string(target.Mode),
			PersonID: person, Title: Clip(in.Action.Title, MaxTitleLength), Body: Clip(in.Action.Body, MaxBodyLength),
			Level: string(LevelInfo), MustTap: target.MustTap, CreatedAt: now, ExpiresAt: expires,
		})
		if err != nil {
			return 0, fmt.Errorf("insert tablet notice: %w", err)
		}
		count += int(rows)
	}
	return count, nil
}

// noticeExpiry is when a tablet notice of the mode stops being shown.
func (d *Dispatcher) noticeExpiry(mode TabletMode, now time.Time) time.Time {
	switch mode {
	case TabletPersonCheckIn:
		return now.Add(personCheckInLifetime)
	case TabletNextCheckIn:
		return now.Add(nextCheckInLifetime)
	case TabletEveryoneToday:
		location := d.location
		if location == nil {
			location = time.UTC
		}
		local := now.In(location)
		return time.Date(local.Year(), local.Month(), local.Day()+1, 0, 0, 0, 0, location)
	default:
		return now.Add(bannerLifetime)
	}
}

func (d *Dispatcher) countSent(runtime *ruleRuntime, channel Channel, count int) {
	if runtime.Stats == nil {
		return
	}
	if runtime.Stats.Sent == nil {
		runtime.Stats.Sent = map[Channel]int{}
	}
	runtime.Stats.Sent[channel] += count
}

// logChannel writes the delivery log line of a channel that does not address accounts.
func (d *Dispatcher) logChannel(
	ctx context.Context,
	q *store,
	in deliveryInput,
	person *uuid.UUID,
	channel Channel,
	status string,
	now time.Time,
) error {
	if err := q.InsertFiringRecipient(ctx, notifyrulesdb.InsertFiringRecipientParams{
		ID: ids.New(), FiringID: in.FiringID, PersonID: person, Channel: string(channel), Step: int32(in.Step), //nolint:gosec // 0..5
		Status: status, SentAt: now,
	}); err != nil {
		return fmt.Errorf("log recipient: %w", err)
	}
	return nil
}
