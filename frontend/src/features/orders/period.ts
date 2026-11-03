import { addCalendarDays, APP_LOCALE, dateInAppTimeZone, zonedDateTimeToISO } from '../../app/dateTime';

// The period of the Payments screen: whole days in the makerspace time zone, as the cash journal and the cashbook
// export take them. "All time" has no bounds at all.

export type PeriodPreset = 'all' | 'today' | 'week' | 'month' | 'custom';

export const periodOptions: { id: PeriodPreset; label: string }[] = [
  { id: 'all', label: 'All time' },
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'This week' },
  { id: 'month', label: 'This month' },
  { id: 'custom', label: 'Custom range…' },
];

export const parsePreset = (value: string | null | undefined): PeriodPreset =>
  periodOptions.find((option) => option.id === value)?.id ?? 'all';

export type Period = {
  preset: PeriodPreset;
  /** First day, inclusive (YYYY-MM-DD); null for all time. */
  from: string | null;
  /** Last day, inclusive; null for all time. */
  to: string | null;
  /** "All time", "This month", "Custom range". */
  label: string;
  /** What the period covers: "up to now", "3 Nov 2026", "1 – 3 Nov 2026". */
  note: string;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Start of a day in the makerspace time zone, as an ISO instant. */
export const dayStart = (day: string) => zonedDateTimeToISO(day, '00:00');

const at = (day: string) => new Date(`${day}T12:00:00Z`);
const format = (options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(APP_LOCALE, { ...options, timeZone: 'UTC' });
const fullDay = format({ day: 'numeric', month: 'short', year: 'numeric' });
const dayMonth = format({ day: 'numeric', month: 'short' });
const dayOnly = format({ day: 'numeric' });

/** "3 Nov 2026", "1 – 3 Nov 2026", "28 Oct – 3 Nov 2026" or "28 Dec 2025 – 3 Jan 2026". */
export function dayRangeText(from: string, to: string): string {
  if (from === to) return fullDay.format(at(from));
  const start =
    from.slice(0, 7) === to.slice(0, 7)
      ? dayOnly.format(at(from))
      : from.slice(0, 4) === to.slice(0, 4)
        ? dayMonth.format(at(from))
        : fullDay.format(at(from));
  return `${start} – ${fullDay.format(at(to))}`;
}

/**
 * The days a preset covers on the day `now` falls on. The week starts on Monday. A custom range needs two valid days
 * with From not after Through; anything else falls back to all time.
 */
export function resolvePeriod(preset: PeriodPreset, from = '', to = '', now = new Date()): Period {
  const today = dateInAppTimeZone(now);
  const bounded = (first: string, label: string): Period => ({
    preset,
    from: first,
    to: today,
    label,
    note: dayRangeText(first, today),
  });
  if (preset === 'today') return bounded(today, 'Today');
  if (preset === 'week') {
    const weekday = (at(today).getUTCDay() + 6) % 7;
    return bounded(addCalendarDays(today, -weekday), 'This week');
  }
  if (preset === 'month') return bounded(`${today.slice(0, 8)}01`, 'This month');
  if (preset === 'custom' && DAY.test(from) && DAY.test(to) && from <= to)
    return { preset, from, to, label: 'Custom range', note: dayRangeText(from, to) };
  return { preset: 'all', from: null, to: null, label: 'All time', note: 'up to now' };
}

/** The period as [from, to) instants for endpoints that take times; unbounded sides are omitted. */
export function periodInstants(period: Pick<Period, 'from' | 'to'>): { from?: string; to?: string } {
  return {
    ...(period.from ? { from: dayStart(period.from) } : {}),
    ...(period.to ? { to: dayStart(addCalendarDays(period.to, 1)) } : {}),
  };
}

/** "Cash register · This month" names a custom range by its days. */
export const periodName = (period: Period) => (period.preset === 'custom' ? period.note : period.label);
