import type { Event } from '../../api/generated/models';
import { APP_LOCALE, APP_TIME_ZONE, dateInAppTimeZone, formatTime, zonedDateTimeValueToISO } from '../../app/dateTime';

export function formatInstant(value?: string | null, timeZone = APP_TIME_ZONE) {
  return value
    ? new Intl.DateTimeFormat(APP_LOCALE, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(value))
    : 'Not set';
}
export function formatLocalDate(value: string, timeZone = APP_TIME_ZONE) {
  return new Intl.DateTimeFormat(APP_LOCALE, { dateStyle: 'full', timeZone }).format(new Date(value));
}
export function formatTimeRange(start: string, end: string, timeZone = APP_TIME_ZONE) {
  const formatter = new Intl.DateTimeFormat(APP_LOCALE, { timeStyle: 'short', timeZone });
  return `${formatter.format(new Date(start))}–${formatter.format(new Date(end))}`;
}

/** "Sun 2 Nov": weekday, day and month in the lab's time zone. */
export function fmtDay(value: string) {
  return new Intl.DateTimeFormat(APP_LOCALE, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: APP_TIME_ZONE,
  })
    .format(new Date(value))
    .replace(',', '');
}
/** "2 Nov". */
export function fmtDate(value: string) {
  return new Intl.DateTimeFormat(APP_LOCALE, { day: 'numeric', month: 'short', timeZone: APP_TIME_ZONE }).format(
    new Date(value),
  );
}
export const fmtRange = (start: string, end: string) => `${formatTime(start)}–${formatTime(end)}`;
export const fmtDateTime = (value: string) => `${fmtDate(value)}, ${formatTime(value)}`;
export const dayKey = dateInAppTimeZone;
export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** One-line date of an event: a single day with its times, or the first and last day. */
export function rangeLabel(event: Pick<Event, 'rangeStartsAt' | 'rangeEndsAt'>) {
  if (!event.rangeStartsAt || !event.rangeEndsAt) return 'No dates yet';
  return dayKey(event.rangeStartsAt) === dayKey(event.rangeEndsAt)
    ? `${fmtDay(event.rangeStartsAt)} · ${fmtRange(event.rangeStartsAt, event.rangeEndsAt)}`
    : `${fmtDay(event.rangeStartsAt)} – ${fmtDay(event.rangeEndsAt)}`;
}

/** A date input value plus a time to an instant; throws a readable message for non-existent local times. */
export function toInstant(date: string, time: string) {
  return zonedDateTimeValueToISO(`${date}T${time}`);
}
export const toISO = zonedDateTimeValueToISO;

export const publicLink = (publicId: string) => `${window.location.origin}/events/public/${publicId}`;
