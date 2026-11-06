import type { CalendarEntry } from '../../../api/generated/models';
import { datesOnWeekday } from './dates';
import { overallRange, rangesOverlap } from './timeslots';

export type OccupiedRanges = (date: string) => readonly (readonly [number, number])[];

export type SeriesPlan = {
  /** Dates that get an open day. */
  make: string[];
  /** Holiday or break dates that stay empty unless ticked. */
  blocked: { date: string; label: string }[];
  /** Dates where another open day already overlaps; these can never be forced. */
  conflicts: string[];
};

export const entriesOn = (entries: readonly CalendarEntry[], date: string) =>
  entries.filter((entry) => entry.startsOn <= date && entry.endsOn >= date);

/**
 * Which dates of a weekly series get an open day: holidays and breaks are skipped unless forced, overlaps with an
 * existing open day always are. Mirrors what the server does when it saves the series.
 */
export function planSeries(args: {
  weekday: number;
  from: string;
  until: string;
  slots: readonly { start: string; end: string }[];
  forced: readonly string[];
  entries: readonly CalendarEntry[];
  occupied: OccupiedRanges;
  /** Only dates for which this returns true are considered (for example dates after a series' old end). */
  only?: (date: string) => boolean;
}): SeriesPlan {
  const plan: SeriesPlan = { make: [], blocked: [], conflicts: [] };
  const range = args.slots.length ? overallRange(args.slots) : null;
  for (const date of datesOnWeekday(args.weekday, args.from, args.until)) {
    if (args.only && !args.only(date)) continue;
    if (range && args.occupied(date).some((other) => rangesOverlap(range, other))) {
      plan.conflicts.push(date);
      continue;
    }
    const context = entriesOn(args.entries, date);
    if (context.length && !args.forced.includes(date)) plan.blocked.push({ date, label: context[0].name });
    else plan.make.push(date);
  }
  return plan;
}
