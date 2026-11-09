package notifyrules

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strconv"
	"strings"
	"time"

	notifyrulesdb "github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/database"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

const (
	// ScheduleInterval is how often the scheduler looks for schedule rules that are due.
	ScheduleInterval = time.Minute
	// ScheduleBatch bounds the rules one pass handles.
	ScheduleBatch = 50
	// maxScheduleLate is how long after its time a recurring rule still fires; a longer outage skips the run.
	maxScheduleLate = 2 * time.Hour
	// openDayCatchUp is how long after its time a rule before or after an open day still fires.
	openDayCatchUp = 6 * time.Hour
	// MaxOpenDayOffsetHours is the longest a rule may act before an open day starts or after it ends (seven days). The
	// open-day window the scheduler loads covers it on both sides.
	MaxOpenDayOffsetHours = 168
	// openDayWindow is how far back and ahead of now the scheduler looks for open days: the longest offset, the catch-up
	// time and a day of slack.
	openDayWindow = MaxOpenDayOffsetHours*time.Hour + openDayCatchUp + 24*time.Hour
	// openDayPoll is how often rules before or after open days look for open days that were created meanwhile.
	openDayPoll    = 5 * time.Minute
	scheduleRetry  = 5 * time.Minute
	nextRunHorizon = 400
)

// IsOpenDayRepeat says whether the schedule runs relative to open days instead of the clock.
func IsOpenDayRepeat(repeat Repeat) bool {
	return repeat == RepeatBeforeOpenDay || repeat == RepeatAfterOpenDay
}

func parseClock(text string) (hour, minute int) {
	hourText, minuteText, found := strings.Cut(text, ":")
	if !found {
		return 9, 0
	}
	hour, hourErr := strconv.Atoi(hourText)
	minute, minuteErr := strconv.Atoi(minuteText)
	if hourErr != nil || minuteErr != nil || hour < 0 || hour > 23 || minute < 0 || minute > 59 {
		return 9, 0
	}
	return hour, minute
}

// NextRun is the first moment after the given one at which a recurring schedule fires, with times read in the
// location. A time that does not exist on a day (the hour lost when clocks go forward) fires at the moment the
// clocks jump to, and a time that exists twice fires once, so a day never fires twice or not at all. Schedules that
// run relative to open days have no clock time; they report false.
func NextRun(schedule Schedule, after time.Time, location *time.Location) (time.Time, bool) {
	if IsOpenDayRepeat(schedule.Repeat) {
		return time.Time{}, false
	}
	hour, minute := parseClock(schedule.Time)
	local := after.In(location)
	for offset := 0; offset <= nextRunHorizon; offset++ {
		day := time.Date(local.Year(), local.Month(), local.Day()+offset, 12, 0, 0, 0, location)
		candidate := time.Date(day.Year(), day.Month(), day.Day(), hour, minute, 0, 0, location)
		if !candidate.After(after) {
			continue
		}
		var matches bool
		switch schedule.Repeat {
		case RepeatDaily:
			matches = true
		case RepeatWeekdays:
			matches = day.Weekday() != time.Saturday && day.Weekday() != time.Sunday
		case RepeatWeekly:
			matches = slices.Contains(schedule.Weekdays, weekdayKeys[day.Weekday()])
		case RepeatMonthly:
			matches = day.Day() == schedule.DayOfMonth
		}
		if matches {
			return candidate.UTC(), true
		}
	}
	return time.Time{}, false
}

// RunsBetween counts the times a recurring schedule fires after the start and up to the end.
func RunsBetween(schedule Schedule, start, end time.Time, location *time.Location) int {
	runs := 0
	for cursor := start; ; {
		next, ok := NextRun(schedule, cursor, location)
		if !ok || next.After(end) {
			return runs
		}
		runs++
		cursor = next
	}
}

// refreshNextRun stores when a saved schedule rule runs next. Rules before or after open days poll instead, so they
// start without one.
func (s *Service) refreshNextRun(ctx context.Context, queries *notifyrulesdb.Queries, id uuid.UUID, input RuleInput) error {
	var next pgtype.Timestamptz
	if schedule := input.Definition.Trigger.Schedule; input.Enabled && input.Definition.Trigger.Type == TriggerSchedule &&
		schedule != nil {
		if at, ok := NextRun(*schedule, s.now(), s.location); ok {
			next = pgtype.Timestamptz{Time: at, Valid: true}
		}
	}
	if err := queries.SetNextRun(ctx, notifyrulesdb.SetNextRunParams{ID: id, NextRunAt: next}); err != nil {
		return fmt.Errorf("schedule rule: %w", err)
	}
	return nil
}

// RunSchedules runs the schedule rules that are due and returns how many it handled. Each rule runs in its own
// transaction; one that keeps failing is retried every few minutes and cannot hold the others back.
func (d *Dispatcher) RunSchedules(ctx context.Context, limit int) (int, error) {
	handled := 0
	for handled < limit {
		found, err := d.runOneSchedule(ctx)
		if err != nil {
			return handled, err
		}
		if !found {
			break
		}
		handled++
	}
	return handled, nil
}

func (d *Dispatcher) runOneSchedule(ctx context.Context) (bool, error) {
	now := d.now()
	var claimed uuid.UUID
	found := false
	err := database.InTx(ctx, d.pool, func(tx pgx.Tx) error {
		q := newStore(tx)
		row, err := q.ClaimDueScheduleRule(ctx, pgtype.Timestamptz{Time: now, Valid: true})
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("claim schedule rule: %w", err)
		}
		found, claimed = true, row.ID
		return d.runScheduledRule(ctx, q, infoFromClaimRow(row), now)
	})
	if err == nil || !found || ctx.Err() != nil {
		return found, err
	}
	slog.WarnContext(ctx, "scheduled notification rule failed", "rule_id", claimed, "error", err)
	if err = newStore(d.pool).SetNextRun(ctx, notifyrulesdb.SetNextRunParams{
		ID: claimed, NextRunAt: pgtype.Timestamptz{Time: now.Add(scheduleRetry), Valid: true},
	}); err != nil {
		return true, fmt.Errorf("defer schedule rule: %w", err)
	}
	return true, nil
}

func (d *Dispatcher) runScheduledRule(ctx context.Context, q *store, rule ruleInfo, now time.Time) error {
	def, err := ParseDefinition(rule.Definition)
	if err != nil || def.Trigger.Schedule == nil {
		return errors.New("the rule's schedule cannot be read")
	}
	schedule := *def.Trigger.Schedule
	if IsOpenDayRepeat(schedule.Repeat) {
		return d.runOpenDaySchedule(ctx, q, rule, def, schedule, now)
	}
	if rule.NextRunAt != nil && !rule.NextRunAt.After(now) && now.Sub(*rule.NextRunAt) <= maxScheduleLate {
		if err = d.fireRun(ctx, q, rule, def, TriggerSchedule, nil, now, fireOptions{}); err != nil {
			return err
		}
	}
	var next pgtype.Timestamptz
	if at, ok := NextRun(schedule, now, d.location); ok {
		next = pgtype.Timestamptz{Time: at, Valid: true}
	}
	return q.SetNextRun(ctx, notifyrulesdb.SetNextRunParams{ID: rule.ID, NextRunAt: next})
}

// openDayFireAt is when the rule acts on an open day: the given hours before it starts or after it ends.
func openDayFireAt(schedule Schedule, day Item) time.Time {
	hours := 0
	if schedule.Hours != nil {
		hours = *schedule.Hours
	}
	offset := time.Duration(hours) * time.Hour
	starts, _ := day.Fields["startsAt"].(time.Time)
	ends, _ := day.Fields["endsAt"].(time.Time)
	if schedule.Repeat == RepeatBeforeOpenDay {
		return starts.Add(-offset)
	}
	return ends.Add(offset)
}

// runOpenDaySchedule fires the rule for every open day whose moment has come and that was not handled before. A
// cancelled day never fires, and a day whose moment passed before the rule was saved, or long ago, is skipped.
func (d *Dispatcher) runOpenDaySchedule(
	ctx context.Context,
	q *store,
	rule ruleInfo,
	def Definition,
	schedule Schedule,
	now time.Time,
) error {
	days, err := d.openDayItems(ctx, q, nil, now.Add(-openDayWindow), now.Add(openDayWindow), now)
	if err != nil {
		return err
	}
	next := now.Add(openDayPoll)
	for _, day := range days {
		if cancelled, _ := day.Fields["cancelled"].(bool); cancelled {
			continue
		}
		at := openDayFireAt(schedule, day)
		switch {
		case at.After(now):
			if at.Before(next) {
				next = at
			}
		case at.After(rule.UpdatedAt) && now.Sub(at) <= openDayCatchUp:
			claimed, err := q.ClaimRuleRun(ctx, notifyrulesdb.ClaimRuleRunParams{
				RuleID: rule.ID, RunKey: "open_day:" + day.Key, Now: now,
			})
			if err != nil {
				return fmt.Errorf("claim open day run: %w", err)
			}
			if claimed == 0 {
				continue
			}
			day := day
			if err = d.fireRun(ctx, q, rule, def, TriggerSchedule, &day, now, fireOptions{}); err != nil {
				return err
			}
		}
	}
	return q.SetNextRun(ctx, notifyrulesdb.SetNextRunParams{
		ID: rule.ID, NextRunAt: pgtype.Timestamptz{Time: next, Valid: true},
	})
}

// openDayEvent is the event a rule before or after an open day sees: the day's counts as e. fields and
// placeholders, the people signed up for it as "day_team".
func (d *Dispatcher) openDayEvent(rule ruleInfo, day *Item, now time.Time) Event {
	ev := Event{
		Placeholders: map[string]string{}, Recipients: map[string][]uuid.UUID{}, OccurredAt: now,
	}
	if day == nil {
		return ev
	}
	ev.Fields = map[string]any{}
	for _, key := range []string{"supervisors", "free", "trainees", "weekday"} {
		ev.Fields[key] = day.Fields[key]
	}
	team := day.Recipients["team"]
	if rule.OwnerPersonID != nil {
		ev.Fields["mine"] = slices.Contains(team, *rule.OwnerPersonID)
	}
	ev.Recipients["day_team"] = team
	ev.Placeholders = map[string]string{
		"day": day.Text["day"], "time": day.Text["time"], "supervisors": formatValue(Field{}, day.Fields["supervisors"]),
		"trainees": formatValue(Field{}, day.Fields["trainees"]), "free": formatValue(Field{}, day.Fields["free"]),
	}
	ev.Link = day.Link
	return ev
}

// fireRun runs a schedule or manual rule once: it expands the loop and fires for every occurrence.
func (d *Dispatcher) fireRun(
	ctx context.Context,
	q *store,
	rule ruleInfo,
	def Definition,
	trigger TriggerType,
	day *Item,
	now time.Time,
	opts fireOptions,
) error {
	ev := d.openDayEvent(rule, day, now)
	base, err := d.baseValues(ctx, q, def, eventValues(ev.Fields), now)
	if err != nil {
		return err
	}
	exp, err := d.expand(ctx, q, def, ev, base, now, trigger)
	if err != nil {
		return err
	}
	if opts.Stats != nil {
		opts.Stats.Examined += len(exp.Items)
	}
	for _, occ := range exp.Occurrences {
		if _, err = d.fireOccurrence(ctx, q, rule, def, occ, now, opts); err != nil {
			return err
		}
		if opts.Test != nil {
			break
		}
	}
	return nil
}
