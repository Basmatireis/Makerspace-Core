import { Button, Checkbox } from '@carbon/react';
import { User } from '@carbon/icons-react';
import type { CalendarEntry, OpenDay } from '../../../api/generated/models';
import { addCalendarDays } from '../../../app/dateTime';
import {
  dateOf,
  dayMonth,
  dayOfMonth,
  isoWeek,
  longDate,
  mondayOf,
  monthShort,
  plural,
  shortTimeRange,
  timeRange,
  WEEKDAY_SHORT,
} from '../model/dates';
import type { ChangeKind } from '../model/derive';
import { entriesOn } from '../model/seriesPlan';
import { dayState, signedUpCount, slotState, type SlotState, type StateContext } from '../model/state';

export type CalendarViewProps = {
  days: OpenDay[];
  matching: ReadonlySet<string>;
  entries: CalendarEntry[];
  periodStartsOn: string;
  periodEndsOn: string;
  ctx: StateContext;
  showEarlier: boolean;
  onToggleEarlier: () => void;
  selectedId: string | null;
  selecting: boolean;
  checked: ReadonlySet<string>;
  changes: ReadonlyMap<string, ChangeKind>;
  onOpen: (id: string) => void;
  onToggle: (id: string) => void;
};

function Legend({ ctx }: { ctx: StateContext }) {
  const { viewer, warningDays } = ctx;
  const items: [SlotState, string][] =
    !viewer.canSignUp && !viewer.canManage
      ? [['neutral', 'Open day']]
      : viewer.canManage
        ? [
            ['urgent', `Supervisor missing, within ${warningDays} days`],
            ['short', 'Supervisor missing'],
            ['mine', "You're in"],
            ['ok', 'Staffed'],
          ]
        : [
            ['urgent', `Supervisor needed within ${warningDays} days`],
            ['open', 'Place for you'],
            ['mine', "You're in"],
            ['full', 'Full for you'],
          ];
  return (
    <ul className="od-legend" aria-label="Legend">
      {items.map(([state, label]) => (
        <li key={state}>
          <i className={`state-${state}`} aria-hidden="true" />
          {label}
        </li>
      ))}
      <li>
        <i className="is-break" aria-hidden="true" />
        Holiday or break
      </li>
    </ul>
  );
}

function Block({ day, props }: { day: OpenDay; props: CalendarViewProps }) {
  const { ctx } = props;
  const state = dayState(day, ctx);
  const selected = props.selecting ? props.checked.has(day.id) : props.selectedId === day.id;
  const multi = day.timeslots.length > 1;
  const date = dateOf(day.startsAt);
  const staffing = ctx.viewer.canSignUp || ctx.viewer.canSeePeople || ctx.viewer.canManage;
  const signed = signedUpCount(day.timeslots[0]);
  const unsaved = props.changes.get(day.id);
  return (
    <button
      type="button"
      className={`od-blk state-${state}${props.matching.has(day.id) ? '' : ' is-dim'}${selected ? ' is-selected' : ''}${unsaved && unsaved !== 'cancelled' ? ' is-unsaved' : ''}`}
      aria-pressed={selected}
      data-guide="open-days-day"
      aria-label={`${longDate(date)}, ${timeRange(day.startsAt, day.endsAt)}${multi ? `, ${day.timeslots.length} timeslots` : ''}${state === 'cancelled' ? ', cancelled' : ''}${unsaved ? ', unsaved' : ''}`}
      onClick={() => props.onOpen(day.id)}
    >
      <span className="od-blk__t">
        <span className="od-l">{timeRange(day.startsAt, day.endsAt)}</span>
        <span className="od-s">{shortTimeRange(day.startsAt, day.endsAt)}</span>
      </span>
      <span className="od-blk__row">
        {props.selecting && (
          <span className="od-check od-check--sm" onClick={(event) => event.stopPropagation()}>
            <Checkbox
              id={`od-cal-check-${day.id}`}
              labelText={`Select ${longDate(date)}`}
              hideLabel
              checked={props.checked.has(day.id)}
              onChange={() => props.onToggle(day.id)}
            />
          </span>
        )}
        {staffing &&
          (multi ? (
            <span className="od-segs">
              {day.timeslots.map((slot) => (
                <i
                  key={slot.id}
                  className={`state-${slotState(day, slot, ctx)}`}
                  title={timeRange(slot.startsAt, slot.endsAt)}
                />
              ))}
            </span>
          ) : (
            <span
              className={`od-pp${signed ? '' : ' is-empty'}`}
              title={`${plural(signed, 'person', 'people')} signed up`}
            >
              <User size={14} aria-hidden="true" />
              <span>×{signed}</span>
            </span>
          ))}
      </span>
    </button>
  );
}

/** The whole period, one row per week and seven equal day columns; several open days on a date are separate blocks. */
export function CalendarView(props: CalendarViewProps) {
  const { days, entries, ctx } = props;
  const today = dateOf(ctx.now);
  const first = mondayOf(props.periodStartsOn);
  const firstShown = props.showEarlier ? first : mondayOf(today) > first ? mondayOf(today) : first;
  const hiddenWeeks = Math.round((new Date(firstShown).getTime() - new Date(first).getTime()) / (7 * 86_400_000));
  const weeks: string[] = [];
  for (let week = firstShown; week <= props.periodEndsOn; week = addCalendarDays(week, 7)) weeks.push(week);
  const byDate = new Map<string, OpenDay[]>();
  for (const day of days) byDate.set(dateOf(day.startsAt), [...(byDate.get(dateOf(day.startsAt)) ?? []), day]);
  return (
    <div className="od-cal-card">
      <div className="od-cal-bar">
        <Legend ctx={ctx} />
        {(hiddenWeeks > 0 || props.showEarlier) && (
          <Button kind="ghost" size="sm" onClick={props.onToggleEarlier}>
            {hiddenWeeks > 0 ? `Show ${plural(hiddenWeeks, 'earlier week')}` : 'Hide earlier weeks'}
          </Button>
        )}
      </div>
      <div className="od-cal" role="group" aria-label="Period calendar" data-guide="open-days-schedule">
        <div className="od-cal__h">Wk</div>
        {WEEKDAY_SHORT.map((name) => (
          <div key={name} className="od-cal__h">
            {name}
          </div>
        ))}
        {weeks.flatMap((monday) => {
          const monthStart = Array.from({ length: 7 }, (_, index) => addCalendarDays(monday, index)).find(
            (date) => dayOfMonth(date) === 1,
          );
          return [
            <div key={`wk-${monday}`} className="od-cal__wk">
              <b>{isoWeek(monday)}</b>
              {(monthStart || monday === firstShown) && <small>{monthShort(monthStart ?? monday)}</small>}
            </div>,
            ...Array.from({ length: 7 }, (_, index) => {
              const date = addCalendarDays(monday, index);
              const context = entriesOn(entries, date);
              const here = byDate.get(date) ?? [];
              const outside = date < props.periodStartsOn || date > props.periodEndsOn;
              const label = dayOfMonth(date) === 1 || date === firstShown ? dayMonth(date) : String(dayOfMonth(date));
              return (
                <div
                  key={date}
                  className={`od-cell${outside ? ' is-out' : ''}${context.length ? ` is-${context[0].category === 'academicBreak' ? 'break' : 'holiday'}` : ''}${date === today ? ' is-today' : ''}${here.length ? ' has-day' : ''}`}
                  title={context.map((entry) => entry.name).join(', ') || undefined}
                >
                  <span className="od-cell__n">{label}</span>
                  {!here.length && context.length > 0 && (context[0].startsOn === date || index === 0) && (
                    <span className="od-cell__ctx">{context[0].name}</span>
                  )}
                  {here.map((day) => (
                    <Block key={day.id} day={day} props={props} />
                  ))}
                </div>
              );
            }),
          ];
        })}
      </div>
    </div>
  );
}
