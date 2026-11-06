import { APP_LOCALE, addCalendarDays, dateInAppTimeZone, timeInAppTimeZone } from '../../../app/dateTime';

const DAY_MS = 86_400_000;

export const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
export const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/** Noon UTC keeps calendar arithmetic on date-only strings clear of daylight-saving edges. */
const noon = (date: string) => new Date(`${date}T12:00:00Z`);

export const weekdayName = (isoWeekday: number) => WEEKDAY_NAMES[isoWeekday - 1] ?? '';

/** ISO weekday of a `YYYY-MM-DD` date: Monday is 1, Sunday is 7. */
export function weekdayOf(date: string): number {
  const day = noon(date).getUTCDay();
  return day === 0 ? 7 : day;
}

export const mondayOf = (date: string) => addCalendarDays(date, 1 - weekdayOf(date));

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export const dayDiff = (to: string, from: string) => Math.round((noon(to).getTime() - noon(from).getTime()) / DAY_MS);

export function isoWeek(date: string): number {
  const target = noon(date);
  target.setUTCDate(target.getUTCDate() + 4 - weekdayOf(date));
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  return Math.ceil(((target.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
}

const format = (date: string, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(APP_LOCALE, { ...options, timeZone: 'UTC' }).format(noon(date));

export const shortDate = (date: string) => format(date, { weekday: 'short', day: 'numeric', month: 'short' });
export const longDate = (date: string) => format(date, { weekday: 'long', day: 'numeric', month: 'long' });
export const dayMonth = (date: string) => format(date, { day: 'numeric', month: 'short' });
export const dayMonthYear = (date: string) => format(date, { day: 'numeric', month: 'short', year: 'numeric' });
export const weekdayShort = (date: string) => format(date, { weekday: 'short' });
export const monthShort = (date: string) => format(date, { month: 'short' });
export const dayOfMonth = (date: string) => noon(date).getUTCDate();

/** The local (makerspace) calendar date of an instant. */
export const dateOf = (instant: string | Date) => dateInAppTimeZone(instant);
/** The local 24-hour clock time `HH:MM` of an instant. */
export const clockOf = (instant: string | Date) => timeInAppTimeZone(instant);

export const timeRange = (startsAt: string, endsAt: string) => `${clockOf(startsAt)}–${clockOf(endsAt)}`;
/** `15–19` for whole hours: the short form phones use. */
export const shortTimeRange = (startsAt: string, endsAt: string) =>
  `${clockOf(startsAt).replace(':00', '')}–${clockOf(endsAt).replace(':00', '')}`;

export function relativeDay(date: string, today: string): string {
  const diff = dayDiff(date, today);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 1 && diff < 14) return `In ${diff} days`;
  if (diff < -1 && diff > -14) return `${-diff} days ago`;
  return '';
}

export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Every date from `from` to `until` (inclusive) that falls on the ISO weekday. */
export function datesOnWeekday(weekday: number, from: string, until: string): string[] {
  const dates: string[] = [];
  let date = addCalendarDays(from, (weekday - weekdayOf(from) + 7) % 7);
  for (; date <= until; date = addCalendarDays(date, 7)) dates.push(date);
  return dates;
}
