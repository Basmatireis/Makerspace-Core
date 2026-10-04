import type { Event } from '../../api/generated/models';
import { APP_LOCALE, APP_TIME_ZONE, zonedDateTimeValueToISO } from '../../app/dateTime';

const defaultTimeZone = APP_TIME_ZONE;

export function formatInstant(value?: string | null, timeZone = defaultTimeZone) {
  return value ? new Intl.DateTimeFormat(APP_LOCALE, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(value)) : 'Not set';
}
export function formatLocalDate(value: string, timeZone = defaultTimeZone) {
  return new Intl.DateTimeFormat(APP_LOCALE, { dateStyle: 'full', timeZone }).format(new Date(value));
}
export function formatTimeRange(start: string, end: string, timeZone = defaultTimeZone) {
  const formatter = new Intl.DateTimeFormat(APP_LOCALE, { timeStyle: 'short', timeZone });
  return `${formatter.format(new Date(start))}–${formatter.format(new Date(end))}`;
}
export function eventRange(event: Pick<Event, 'rangeStartsAt' | 'rangeEndsAt'>) { return event.rangeStartsAt && event.rangeEndsAt ? `${formatInstant(event.rangeStartsAt)} – ${formatInstant(event.rangeEndsAt)}` : 'Schedule not set'; }
export function eventDateLines(event: Pick<Event, 'rangeStartsAt' | 'rangeEndsAt'>) {
  if (!event.rangeStartsAt || !event.rangeEndsAt) return { date: 'Schedule not set', time: null };
  const start = new Date(event.rangeStartsAt);
  const end = new Date(event.rangeEndsAt);
  const dateFormatter = new Intl.DateTimeFormat(APP_LOCALE, { dateStyle: 'medium', timeZone: defaultTimeZone });
  const timeFormatter = new Intl.DateTimeFormat(APP_LOCALE, { timeStyle: 'short', timeZone: defaultTimeZone });
  return {
    date: dateFormatter.formatRange(start, end),
    time: timeFormatter.formatRange(start, end),
  };
}
export function statusTagType(status: string): 'gray' | 'blue' | 'cyan' | 'green' | 'red' | 'warm-gray' {
  const types: Record<string, 'gray' | 'blue' | 'cyan' | 'green' | 'red' | 'warm-gray'> = {
    draft: 'gray', planning: 'blue', confirmed: 'cyan', completed: 'green', done: 'green',
    open: 'blue', in_progress: 'cyan', blocked: 'red', cancelled: 'red', archived: 'warm-gray',
  };
  return types[status] ?? 'gray';
}

export function toISO(localValue: string) { return zonedDateTimeValueToISO(localValue); }
