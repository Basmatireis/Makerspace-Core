import type { OpenDay } from '../../../api/generated/models';
import { clockOf, dateOf, longDate, weekdayName, weekdayOf } from './dates';
import { free, isShortStaffed, supervisorsOf, supporters, type Viewer } from './state';

export type FilterKey = 'weekday' | 'time' | 'staffing' | 'support' | 'slots' | 'series';
export type FilterValues = Partial<Record<FilterKey, string[]>>;

export type FilterDef = { key: FilterKey; label: string; options: { id: string; label: string }[] };

export function filterDefs(days: OpenDay[], viewer: Viewer): FilterDef[] {
  const weekdays = [...new Set(days.map((day) => weekdayOf(dateOf(day.startsAt))))].sort((a, b) => a - b);
  const support = [...new Set(days.flatMap(supporters))].sort();
  const defs: FilterDef[] = [
    { key: 'weekday', label: 'Weekday', options: weekdays.map((n) => ({ id: String(n), label: weekdayName(n) })) },
    {
      key: 'time',
      label: 'Time of day',
      options: [
        { id: 'morning', label: 'Starts before 12:00' },
        { id: 'afternoon', label: 'Starts 12:00–16:59' },
        { id: 'evening', label: 'Starts 17:00 or later' },
      ],
    },
  ];
  if (viewer.canSignUp || viewer.canManage) {
    defs.push({
      key: 'staffing',
      label: 'Staffing',
      options: [
        { id: 'short', label: 'Supervisor missing' },
        { id: 'full', label: 'All supervisor places filled' },
        { id: 'cancelled', label: 'Cancelled' },
      ],
    });
  }
  defs.push(
    { key: 'support', label: 'Planned support', options: support.map((label) => ({ id: label, label })) },
    {
      key: 'slots',
      label: 'Timeslots',
      options: [
        { id: 'one', label: 'One timeslot' },
        { id: 'several', label: 'Several timeslots' },
      ],
    },
  );
  if (viewer.canManage) {
    defs.push({
      key: 'series',
      label: 'Series',
      options: [
        { id: 'series', label: 'Part of a series' },
        { id: 'separate', label: 'Edited separately' },
        { id: 'single', label: 'Single open day' },
      ],
    });
  }
  return defs;
}

export const activeFilterCount = (values: FilterValues) =>
  Object.values(values).reduce((sum, list) => sum + (list?.length ?? 0), 0);

/** A day passes when, for every category with a choice, it matches at least one chosen option. */
export function dayPasses(day: OpenDay, values: FilterValues, now: Date): boolean {
  const matches = (key: FilterKey, test: (id: string) => boolean) => !values[key]?.length || values[key].some(test);
  const hour = Number(clockOf(day.startsAt).slice(0, 2));
  return (
    matches('weekday', (id) => weekdayOf(dateOf(day.startsAt)) === Number(id)) &&
    matches('time', (id) =>
      id === 'morning' ? hour < 12 : id === 'afternoon' ? hour >= 12 && hour < 17 : hour >= 17,
    ) &&
    matches('staffing', (id) =>
      id === 'cancelled'
        ? day.status === 'cancelled'
        : id === 'short'
          ? isShortStaffed(day, now)
          : day.status !== 'cancelled' && !day.timeslots.some((slot) => free(supervisorsOf(slot)) > 0),
    ) &&
    matches('support', (id) => supporters(day).includes(id)) &&
    matches('slots', (id) => (id === 'one') === (day.timeslots.length === 1)) &&
    matches('series', (id) =>
      id === 'series'
        ? Boolean(day.seriesId)
        : id === 'separate'
          ? Boolean(day.detachedFromSeriesId && !day.seriesId)
          : !day.seriesId && !day.detachedFromSeriesId,
    )
  );
}

/** Search by date, time, a signed-up person or planned support. */
export function dayMatchesSearch(day: OpenDay, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const people = day.timeslots.flatMap((slot) =>
    slot.requirements.flatMap((item) => (item.assignments ?? []).map((assignment) => assignment.displayName)),
  );
  const haystack = [longDate(dateOf(day.startsAt)), clockOf(day.startsAt), ...people, ...supporters(day)]
    .join(' ')
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}
