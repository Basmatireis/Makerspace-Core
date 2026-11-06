import { Fragment } from 'react';
import { Button, Checkbox, Tag } from '@carbon/react';
import { Document, Renew } from '@carbon/icons-react';
import type { CalendarEntry, OpenDay, OpenDayStaffRequirement, OpenDayTimeslot } from '../../../api/generated/models';
import { EmptyState } from '../../../app/PageState';
import {
  dateOf,
  dayMonth,
  dayOfMonth,
  isoWeek,
  longDate,
  mondayOf,
  monthShort,
  plural,
  relativeDay,
  shortDate,
  timeRange,
  weekdayShort,
} from '../model/dates';
import type { ChangeKind } from '../model/derive';
import type { SectionId } from '../model/sections';
import {
  dayState,
  joinablePlaces,
  slotState,
  stateTag,
  supervisorsOf,
  supporters,
  traineesOf,
  type StateContext,
} from '../model/state';
import { addCalendarDays } from '../../../app/dateTime';
import { PlaceDots, StateTag } from './Places';

export type ListViewProps = {
  days: OpenDay[];
  entries: CalendarEntry[];
  periodStartsOn: string;
  periodEndsOn: string;
  section: SectionId;
  ctx: StateContext;
  selectedId: string | null;
  selecting: boolean;
  checked: ReadonlySet<string>;
  changes: ReadonlyMap<string, ChangeKind>;
  seriesLabels: ReadonlyMap<string, string>;
  onOpen: (id: string) => void;
  onToggle: (id: string) => void;
  onJoin: (day: OpenDay, slot: OpenDayTimeslot, requirement: OpenDayStaffRequirement) => void;
  joinDisabled: boolean;
};

type Item = { date: string; day?: OpenDay; entry?: CalendarEntry; continued?: boolean };

const SECTION_EMPTY: Record<SectionId, { title: string; description?: string }> = {
  upcoming: { title: 'No open days' },
  short: { title: 'Every upcoming open day has its supervisors' },
  forme: { title: 'No free places for you', description: 'Every place you can take is filled. Check again later.' },
  mine: { title: 'You are not signed up for any open day', description: 'Pick a day under Open for me.' },
  past: { title: 'No past open days' },
};

function groupByWeek(items: Item[], descending: boolean) {
  const sign = descending ? -1 : 1;
  const sorted = [...items].sort((a, b) =>
    a.date === b.date ? (a.entry ? -1 : b.entry ? 1 : 0) : a.date < b.date ? -sign : sign,
  );
  const groups = new Map<string, Item[]>();
  for (const item of sorted) groups.set(mondayOf(item.date), [...(groups.get(mondayOf(item.date)) ?? []), item]);
  return groups;
}

function ContextRow({ entry, continued }: { entry: CalendarEntry; continued?: boolean }) {
  const holiday = entry.category === 'publicHoliday';
  const weeks = Math.round(
    ((new Date(entry.endsOn).getTime() - new Date(entry.startsOn).getTime()) / 86_400_000 + 1) / 7,
  );
  const when =
    entry.startsOn === entry.endsOn
      ? shortDate(entry.startsOn)
      : `${shortDate(entry.startsOn)} – ${shortDate(entry.endsOn)}${weeks >= 1 ? ` · ${plural(weeks, 'week')}` : ''}`;
  return (
    <div className={`od-ctx${continued ? ' is-cont' : ''}`} role="listitem">
      <span className="od-ctx__date">
        {!continued && (
          <>
            <span className="od-date__wd">{weekdayShort(entry.startsOn)}</span>
            <span className="od-date__d">{dayOfMonth(entry.startsOn)}</span>
            <span className="od-date__m">{monthShort(entry.startsOn)}</span>
          </>
        )}
      </span>
      <span className="od-ctx__text">
        <b>
          {entry.name}
          {continued ? ' continues' : ''}
        </b>
        <small>
          {continued
            ? `Until ${shortDate(entry.endsOn)} · no open days before then`
            : `${holiday ? 'Public holiday' : 'Academic break'} · ${when} · no open days`}
        </small>
      </span>
      {!continued && (
        <span className="od-ctx__tag">
          <Tag size="sm" type="warm-gray">
            {holiday ? 'Holiday' : 'Break'}
          </Tag>
        </span>
      )}
    </div>
  );
}

function JoinButton({
  day,
  slot,
  props,
}: {
  day: OpenDay;
  slot: OpenDayTimeslot;
  props: Pick<ListViewProps, 'selecting' | 'onJoin' | 'joinDisabled' | 'changes'>;
}) {
  const open = joinablePlaces(slot);
  if (props.selecting || day.status === 'cancelled' || !open.length) return null;
  return (
    <Button
      kind="tertiary"
      size="sm"
      disabled={props.joinDisabled || props.changes.has(day.id)}
      onClick={(event) => {
        event.stopPropagation();
        props.onJoin(day, slot, open[0]);
      }}
    >
      Join{open.length > 1 ? ` as ${open[0].kind}` : ''}
    </Button>
  );
}

function DayRow({
  day,
  sameDate,
  props,
  staffing,
}: {
  day: OpenDay;
  sameDate: boolean;
  props: ListViewProps;
  staffing: boolean;
}) {
  const { ctx } = props;
  const date = dateOf(day.startsAt);
  const state = stateTag(day, null, ctx, true);
  const selected = props.selecting ? props.checked.has(day.id) : props.selectedId === day.id;
  const multi = day.timeslots.length > 1;
  const first = day.timeslots[0];
  const relative = relativeDay(date, dateOf(ctx.now));
  const seriesLabel = day.seriesId ? props.seriesLabels.get(day.seriesId) : undefined;
  const change = props.changes.get(day.id);
  const rowClass = (extra = '') =>
    `od-row state-${dayState(day, ctx)}${selected ? ' is-selected' : ''}${staffing ? '' : ' is-guest'}${extra}`;
  const open = () => props.onOpen(day.id);
  const onKey = (event: React.KeyboardEvent) => {
    if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      open();
    }
  };
  return (
    <>
      <div
        className={rowClass(`${sameDate ? ' is-samedate' : ''}${multi ? ' has-slots' : ''}`)}
        role="listitem"
        tabIndex={0}
        aria-current={props.selectedId === day.id ? 'true' : undefined}
        aria-label={`${longDate(date)}, ${timeRange(day.startsAt, day.endsAt)}`}
        data-guide="open-days-day"
        onClick={open}
        onKeyDown={onKey}
      >
        {props.selecting && (
          <span className="od-check" onClick={(event) => event.stopPropagation()}>
            <Checkbox
              id={`od-check-${day.id}`}
              labelText={`Select ${longDate(date)} ${timeRange(day.startsAt, day.endsAt)}`}
              hideLabel
              checked={props.checked.has(day.id)}
              onChange={() => props.onToggle(day.id)}
            />
          </span>
        )}
        {sameDate ? (
          <span className="od-date od-date--same" aria-hidden="true" />
        ) : (
          <span className="od-date">
            <span className="od-date__wd">{weekdayShort(date)}</span>
            <span className="od-date__d">{dayOfMonth(date)}</span>
            <span className="od-date__m">{monthShort(date)}</span>
          </span>
        )}
        <span className="od-when">
          <b>{timeRange(day.startsAt, day.endsAt)}</b>
          {multi && <small>{plural(day.timeslots.length, 'timeslot')}</small>}
          {relative && !sameDate && <small>{relative}</small>}
          {change && change !== 'cancelled' && <small className="od-unsaved">Unsaved</small>}
          {ctx.viewer.canManage && day.seriesId && (
            <small className="od-sermark" title={seriesLabel}>
              <Renew size={12} aria-hidden="true" /> Series
            </small>
          )}
          {ctx.viewer.canManage && !day.seriesId && day.detachedFromSeriesId && (
            <small className="od-sermark is-off" title="Edited on its own, no longer follows its series">
              <Renew size={12} aria-hidden="true" /> Edited separately
            </small>
          )}
          {ctx.viewer.canManage && day.internalNote && (
            <small className="od-note" title={day.internalNote}>
              <Document size={12} aria-hidden="true" /> Note
            </small>
          )}
        </span>
        {staffing &&
          (multi ? (
            <>
              <span className="od-col od-col--sup od-col--sum" />
              <span className="od-col od-col--tr od-col--sum" />
            </>
          ) : (
            <>
              <span className="od-col od-col--sup" data-k="Supervisors">
                <PlaceDots day={day} slot={first} requirement={supervisorsOf(first)} now={ctx.now} />
                {supervisorsOf(first)?.eligibleRoleIds?.length ? (
                  <small className="od-restrict">Restricted</small>
                ) : null}
              </span>
              <span className="od-col od-col--tr" data-k="Trainees">
                <PlaceDots day={day} slot={first} requirement={traineesOf(first)} now={ctx.now} />
              </span>
            </>
          ))}
        <span className="od-support">
          <SupportTags day={day} />
        </span>
        <span className="od-state">
          <StateTag info={state} />
        </span>
        <span className="od-act">{!multi && <JoinButton day={day} slot={first} props={props} />}</span>
      </div>
      {multi &&
        day.timeslots.map((slot) => (
          <div
            key={slot.id}
            className={`od-row od-row--slot state-${slotState(day, slot, ctx)}${selected ? ' is-selected' : ''}${staffing ? '' : ' is-guest'}`}
            role="listitem"
            aria-label={`Timeslot ${timeRange(slot.startsAt, slot.endsAt)}`}
            onClick={open}
          >
            <span className="od-date od-date--same" aria-hidden="true" />
            <span className="od-when od-when--slot">{timeRange(slot.startsAt, slot.endsAt)}</span>
            {staffing && (
              <>
                <span className="od-col od-col--sup" data-k="Supervisors">
                  <PlaceDots day={day} slot={slot} requirement={supervisorsOf(slot)} now={ctx.now} />
                </span>
                <span className="od-col od-col--tr" data-k="Trainees">
                  <PlaceDots day={day} slot={slot} requirement={traineesOf(slot)} now={ctx.now} />
                </span>
              </>
            )}
            <span className="od-support" />
            <span className="od-state">
              <StateTag info={stateTag(day, slot, ctx, true)} />
            </span>
            <span className="od-act">
              <JoinButton day={day} slot={slot} props={props} />
            </span>
          </div>
        ))}
    </>
  );
}

function SupportTags({ day, max = 3 }: { day: OpenDay; max?: number }) {
  const labels = supporters(day);
  if (!labels.length) return <span className="od-none">—</span>;
  return (
    <span className="od-tags">
      {labels.slice(0, max).map((label) => (
        <Tag key={label} size="sm" type="teal">
          {label}
        </Tag>
      ))}
      {labels.length > max && (
        <Tag size="sm" type="gray">
          +{labels.length - max}
        </Tag>
      )}
    </span>
  );
}

/** The schedule as a list: week groups, holiday and break rows at their date, one row per open day. */
export function ListView(props: ListViewProps) {
  const { days, entries, section, ctx } = props;
  const today = dateOf(ctx.now);
  const staffing = ctx.viewer.canSignUp || ctx.viewer.canSeePeople || ctx.viewer.canManage;
  if (!days.length) {
    const empty = SECTION_EMPTY[section];
    return <EmptyState title={empty.title} description={empty.description} />;
  }
  const past = section === 'past';
  const items: Item[] = days.map((day) => ({ date: dateOf(day.startsAt), day }));
  if (section === 'upcoming' || past) {
    for (const entry of entries) {
      if (entry.endsOn < props.periodStartsOn || entry.startsOn > props.periodEndsOn) continue;
      if (past ? entry.startsOn >= today : entry.endsOn < today) continue;
      items.push({ date: past ? entry.startsOn : entry.startsOn < today ? today : entry.startsOn, entry });
    }
  }
  const groups = groupByWeek(items, past);
  // A break that runs into a later week with open days gets a short reminder row there.
  for (const [monday, list] of groups) {
    for (const entry of entries) {
      if (
        entry.category === 'academicBreak' &&
        monday > entry.startsOn &&
        monday <= entry.endsOn &&
        !list.some((item) => item.entry === entry)
      )
        list.unshift({ date: monday, entry, continued: true });
    }
  }
  return (
    <div className={`od-list${props.selecting ? ' is-selecting' : ''}`} role="list" data-guide="open-days-schedule">
      <div className={`od-row od-row--head${staffing ? '' : ' is-guest'}`} aria-hidden="true">
        <span>Date</span>
        <span>Time</span>
        {staffing && (
          <>
            <span>Supervisors</span>
            <span>Trainees</span>
          </>
        )}
        <span>Planned support</span>
        <span>{ctx.viewer.canManage ? 'Status' : ctx.viewer.canSignUp ? 'For you' : ''}</span>
        <span />
      </div>
      {[...groups].map(([monday, list]) => {
        const thisWeek = monday === mondayOf(today);
        const end = addCalendarDays(monday, 6);
        return (
          <Fragment key={monday}>
            <div className={`od-week${thisWeek ? ' is-now' : ''}`} role="presentation">
              <span>Week {isoWeek(monday)}</span>
              <small>
                {dayMonth(monday)} – {dayMonth(end)}
                {thisWeek ? ' · this week' : ''}
              </small>
            </div>
            {list.map((item, index) =>
              item.entry ? (
                <ContextRow
                  key={`${item.entry.name}-${item.entry.startsOn}-${item.continued ? 'c' : ''}`}
                  entry={item.entry}
                  continued={item.continued}
                />
              ) : item.day ? (
                <DayRow
                  key={item.day.id}
                  day={item.day}
                  sameDate={list[index - 1]?.day !== undefined && list[index - 1].date === item.date}
                  props={props}
                  staffing={staffing}
                />
              ) : null,
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
