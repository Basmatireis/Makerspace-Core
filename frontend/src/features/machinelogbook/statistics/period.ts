import { formatDate } from '../../../app/dateTime';

export type Period = '30d' | '3m' | '6m' | '12m' | 'custom';
export type DateRange = { from: string; to: string };

export const PERIODS: { id: Period; label: string }[] = [
  { id: '30d', label: 'Last 30 days' },
  { id: '3m', label: 'Last 3 months' },
  { id: '6m', label: 'Last 6 months' },
  { id: '12m', label: 'Last 12 months' },
  { id: 'custom', label: 'Custom range…' },
];
export const DEFAULT_PERIOD: Exclude<Period, 'custom'> = '6m';
/** The API refuses longer ranges; five years. */
export const MAX_DAYS = 1830;

const DAY_MS = 86_400_000;
const parseDay = (value: string) => Date.parse(`${value}T12:00:00Z`);
const formatDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const addDays = (value: string, days: number) => formatDay(parseDay(value) + days * DAY_MS);
export const daysBetween = (from: string, to: string) => Math.round((parseDay(to) - parseDay(from)) / DAY_MS) + 1;

export function addMonths(value: string, months: number) {
  const date = new Date(parseDay(value));
  date.setUTCMonth(date.getUTCMonth() + months);
  return formatDay(date.getTime());
}

export const isPeriod = (value: string | null): value is Period => PERIODS.some((item) => item.id === value);

/** The URL and the pickers use an inclusive last day; the API range is half-open, so its `to` is the day after. */
export function presetRange(period: Exclude<Period, 'custom'>, today: string): DateRange {
  if (period === '30d') return { from: addDays(today, -29), to: today };
  const months = { '3m': 3, '6m': 6, '12m': 12 }[period];
  return { from: addMonths(today, -months), to: today };
}

/** Why a range cannot be asked for, or null when it is fine. */
export function rangeProblem(range: DateRange): string | null {
  if (!range.from || !range.to || range.from > range.to) return 'The end date must be on or after the start date.';
  if (daysBetween(range.from, range.to) > MAX_DAYS) return 'Choose a period of at most five years.';
  return null;
}

export const rangeLabel = (range: DateRange) => `${formatDate(range.from)} – ${formatDate(range.to)}`;

export const periodLabel = (period: Period, range: DateRange) =>
  period === 'custom' ? rangeLabel(range) : (PERIODS.find((item) => item.id === period)?.label ?? '');

const monthFormat = new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' });
/** "Sept ’26" for "2026-09": the year keeps the labels of a twelve-month period apart. */
export const monthLabel = (month: string) =>
  `${monthFormat.format(new Date(`${month}-01T12:00:00Z`))} ’${month.slice(2, 4)}`;

const dayMonthFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
/** "7 Sep" for a week or day start. */
export const dayMonthLabel = (day: string) => dayMonthFormat.format(new Date(parseDay(day)));

/** Monday of the week that contains the day. */
export const weekStart = (day: string) => addDays(day, -((new Date(parseDay(day)).getUTCDay() + 6) % 7));

/** Every month ("YYYY-MM") the range touches, in order. */
export function monthsOf(range: DateRange): string[] {
  const months: string[] = [];
  for (
    let month = range.from.slice(0, 7);
    month <= range.to.slice(0, 7);
    month = addMonths(`${month}-01`, 1).slice(0, 7)
  )
    months.push(month);
  return months;
}
