import type { OpenDay } from '../../../api/generated/models';
import { clockOf, dateOf } from './dates';
import { overallRange, rangesOverlap } from './timeslots';

/** Another scheduled open day on `date` whose range overlaps the given timeslots, if any. */
export function findOverlap(
  days: readonly OpenDay[],
  date: string,
  slots: readonly { start: string; end: string }[],
  ignoreId?: string,
): OpenDay | undefined {
  if (!slots.length || slots.some((slot) => !slot.start || !slot.end)) return undefined;
  const range = overallRange(slots);
  return days.find(
    (day) =>
      day.id !== ignoreId &&
      day.status === 'scheduled' &&
      dateOf(day.startsAt) === date &&
      rangesOverlap(range, overallRange([{ start: clockOf(day.startsAt), end: clockOf(day.endsAt) }])),
  );
}
