import type { SignageCalendarWidget, SignagePlayerCalendar } from '../../../api/generated/models';
import { dayKey, dayKeyOf, MONTHS, timeText, wallTime } from './dates';

// Pure model of the calendar widget: which days a month or weeks view shows and what happens on each of them.
// Weeks start on Monday; "today" and every entry follow the makerspace time zone.

export type CalendarCategory = 'holiday' | 'break' | 'openDay' | 'event';

export type CalendarEntry = {
  category: CalendarCategory;
  label: string;
  /** `HH:MM` or `HH:MM–HH:MM` on the day an entry starts; empty on its later days. */
  time: string;
  cancelled: boolean;
  /** Open days in the weeks view with `showCompetencies`: the planned competencies, on the day the entry starts. */
  competencies?: readonly string[];
};

export type CalendarDay = {
  key: string;
  day: number;
  /** Month view: false for the days of the neighbouring months that fill the first and last week. */
  inMonth: boolean;
  today: boolean;
  weekend: boolean;
  /** A school break covers the day. */
  breakDay: boolean;
  /** Ordered: holiday, break, open day, then events by time. */
  entries: CalendarEntry[];
};

export type CalendarWeek = { isoWeek: number; days: CalendarDay[] };

export type CalendarModel = {
  /** "October 2026" in month view; empty in weeks view. */
  monthLabel: string;
  weeks: CalendarWeek[];
};

const DAY_MS = 86_400_000;
const ORDER: Record<CalendarCategory, number> = { holiday: 0, break: 1, openDay: 2, event: 3 };

const utcDay = (key: string) => Date.parse(`${key}T00:00:00Z`);

/** ISO 8601 week number of a day (the week belongs to the year of its Thursday). */
export function isoWeek(year: number, month: number, day: number): number {
  const date = new Date(Date.UTC(year, month, day));
  const weekday = (date.getUTCDay() + 6) % 7; // Monday = 0
  date.setUTCDate(date.getUTCDate() - weekday + 3); // Thursday of this week
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstWeekday = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstWeekday + 3);
  return 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
}

/** The days an entry with the given wall-clock span covers; an end exactly at midnight belongs to the day before. */
function spanKeys(startsAt: string, endsAt: string | null | undefined, timeZone: string | undefined) {
  const start = wallTime(startsAt, timeZone);
  const startKey = dayKeyOf(start);
  if (!endsAt || Date.parse(endsAt) <= Date.parse(startsAt)) return { start, startKey, endKey: startKey };
  const end = wallTime(Date.parse(endsAt) - 60_000, timeZone);
  const endKey = dayKeyOf(end);
  return { start, startKey, endKey: endKey < startKey ? startKey : endKey };
}

export function buildCalendar(
  widget: Pick<
    SignageCalendarWidget,
    'view' | 'weeks' | 'showHolidays' | 'showBreaks' | 'showOpenDays' | 'showEvents' | 'showCompetencies'
  >,
  calendar: SignagePlayerCalendar | null | undefined,
  now: number,
  timeZone: string | undefined,
): CalendarModel {
  const today = wallTime(now, timeZone);
  const todayKey = dayKeyOf(today);
  const monthView = widget.view === 'month';

  // First displayed day (a Monday) and number of weeks.
  const anchor = monthView
    ? new Date(Date.UTC(today.year, today.month, 1))
    : new Date(Date.UTC(today.year, today.month, today.day));
  const offset = (anchor.getUTCDay() + 6) % 7;
  const firstDay = new Date(anchor.getTime() - offset * DAY_MS);
  const weekCount = monthView
    ? Math.ceil((offset + new Date(Date.UTC(today.year, today.month + 1, 0)).getUTCDate()) / 7)
    : Math.min(6, Math.max(1, widget.weeks));

  const days: CalendarDay[] = Array.from({ length: weekCount * 7 }, (_unused, index) => {
    const date = new Date(firstDay.getTime() + index * DAY_MS);
    const key = dayKey(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    return {
      key,
      day: date.getUTCDate(),
      inMonth: !monthView || (date.getUTCMonth() === today.month && date.getUTCFullYear() === today.year),
      today: key === todayKey,
      weekend: index % 7 >= 5,
      breakDay: false,
      entries: [],
    };
  });
  const byKey = new Map(days.map((day) => [day.key, day]));
  const lastKey = days[days.length - 1].key;

  if (calendar) {
    if (widget.showHolidays)
      for (const holiday of calendar.holidays)
        byKey.get(holiday.date)?.entries.push({ category: 'holiday', label: holiday.name, time: '', cancelled: false });
    if (widget.showBreaks)
      for (const item of calendar.breaks) {
        if (item.endsOn < days[0].key || item.startsOn > lastKey) continue;
        for (const day of days)
          if (day.key >= item.startsOn && day.key <= item.endsOn) {
            day.breakDay = true;
            day.entries.push({ category: 'break', label: item.name, time: '', cancelled: false });
          }
      }
    const spans = (
      list: readonly { startsAt: string; endsAt?: string | null }[],
      category: CalendarCategory,
      label: (index: number) => string,
      cancelled: (index: number) => boolean,
      competencies: (index: number) => readonly string[] | undefined = () => undefined,
    ) =>
      list.forEach((item, index) => {
        const { start, startKey, endKey } = spanKeys(item.startsAt, item.endsAt, timeZone);
        if (endKey < days[0].key || startKey > lastKey) return;
        const startTime = timeText(start);
        const endTime = item.endsAt ? timeText(wallTime(item.endsAt, timeZone)) : '';
        // Start at the first displayed day: an entry that began long ago must not be walked day by day.
        for (
          let key = startKey < days[0].key ? days[0].key : startKey;
          key <= endKey && key <= lastKey;
          key = nextKey(key)
        ) {
          byKey.get(key)?.entries.push({
            category,
            label: label(index),
            time: key === startKey ? (endTime && startKey === endKey ? `${startTime}–${endTime}` : startTime) : '',
            cancelled: cancelled(index),
            ...(key === startKey && competencies(index)?.length ? { competencies: competencies(index) } : {}),
          });
        }
      });
    if (widget.showOpenDays)
      spans(
        calendar.openDays,
        'openDay',
        () => 'Open day',
        (index) => calendar.openDays[index].status === 'cancelled',
        // Month cells are too small; the weeks view has room for the first ones.
        (index) =>
          widget.showCompetencies && !monthView && calendar.openDays[index].status !== 'cancelled'
            ? (calendar.openDays[index].competencies ?? [])
            : undefined,
      );
    if (widget.showEvents)
      spans(
        calendar.events,
        'event',
        (index) => calendar.events[index].title,
        () => false,
      );
    for (const day of days)
      day.entries.sort(
        (a, b) =>
          ORDER[a.category] - ORDER[b.category] || a.time.localeCompare(b.time) || a.label.localeCompare(b.label),
      );
  }

  const weeks: CalendarWeek[] = Array.from({ length: weekCount }, (_unused, week) => {
    const row = days.slice(week * 7, week * 7 + 7);
    const monday = new Date(utcDay(row[0].key));
    return { isoWeek: isoWeek(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate()), days: row };
  });
  return { monthLabel: monthView ? `${MONTHS[today.month]} ${today.year}` : '', weeks };
}

function nextKey(key: string): string {
  const date = new Date(utcDay(key) + DAY_MS);
  return dayKey(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}
