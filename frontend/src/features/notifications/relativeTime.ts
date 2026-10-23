import { APP_LOCALE, formatDateTime } from '../../app/dateTime';

const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];

const formatter = new Intl.RelativeTimeFormat(APP_LOCALE, { numeric: 'auto' });

/** "5 minutes ago", "yesterday"; anything older than a week falls back to the date. */
export function relativeTime(iso: string, now: number): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const age = Math.abs(seconds);
  if (age < 60) return 'just now';
  if (age >= 7 * 86_400) return formatDateTime(iso);
  for (const [unit, size] of UNITS) {
    if (age >= size) return formatter.format(Math.trunc(seconds / size), unit);
  }
  return 'just now';
}
