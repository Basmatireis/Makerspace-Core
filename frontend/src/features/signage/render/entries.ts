import { dateText, MONTHS, timeText, wallTime, WEEKDAYS } from './dates';
import { fillPlaceholders, type RichTextFormat } from './escape';
import type { RenderEvent, RenderOpenDay } from './types';

// Entries of the open day, event and agenda widgets and the placeholders their templates may use
// (docs/signage.md, "Open day, event and agenda lists").

export type ListEntry = {
  kind: 'open_day' | 'event';
  startsAt: string;
  endsAt: string | null;
  title: string;
  /** Open days: `scheduled` or `cancelled`. */
  status: string;
  location: string;
};

export const PLACEHOLDERS = [
  'kind',
  'title',
  'date',
  'weekday',
  'weekday_short',
  'day',
  'month',
  'month_short',
  'year',
  'start',
  'end',
  'status',
  'location',
] as const;

export const openDayEntry = (day: RenderOpenDay): ListEntry => ({
  kind: 'open_day',
  startsAt: day.startsAt,
  endsAt: day.endsAt,
  title: 'Open day',
  status: day.status,
  location: '',
});

export const eventEntry = (event: RenderEvent): ListEntry => ({
  kind: 'event',
  startsAt: event.startsAt,
  endsAt: event.endsAt ?? null,
  title: event.title,
  status: '',
  location: event.location ?? '',
});

/** Open days and events merged by start time; an open day comes first when both start at the same moment. */
export function mergeAgenda(
  openDays: readonly RenderOpenDay[],
  events: readonly RenderEvent[],
  options: { includeOpenDays: boolean; includeEvents: boolean; count: number },
): ListEntry[] {
  const entries = [
    ...(options.includeOpenDays ? openDays.map(openDayEntry) : []),
    ...(options.includeEvents ? events.map(eventEntry) : []),
  ];
  // Array.prototype.sort is stable, so ties keep the open-days-first order built above.
  return entries.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)).slice(0, options.count);
}

/** The values of every placeholder for one entry, unescaped. */
export function entryValues(entry: ListEntry, timeZone: string | undefined): Record<string, string> {
  const start = wallTime(entry.startsAt, timeZone);
  return {
    kind: entry.kind === 'open_day' ? 'Open day' : 'Event',
    title: entry.title,
    date: dateText(start),
    weekday: WEEKDAYS[start.weekday],
    weekday_short: WEEKDAYS[start.weekday].slice(0, 3),
    day: String(start.day),
    month: MONTHS[start.month],
    month_short: MONTHS[start.month].slice(0, 3),
    year: String(start.year),
    start: timeText(start),
    end: entry.endsAt ? timeText(wallTime(entry.endsAt, timeZone)) : '',
    status: entry.kind === 'open_day' ? (entry.status === 'cancelled' ? 'Cancelled' : 'Scheduled') : '',
    location: entry.location,
  };
}

/** Used for an entry whose widget has a template for the other kind only (agenda). */
const FALLBACK_TEMPLATE: Record<ListEntry['kind'], string> = {
  open_day: '{date}, {start}–{end}',
  event: '{title}, {date} {start}',
};

/**
 * The whole list as one document of `format`: every entry is wrapped in `<div class="entry entry--open_day|entry--event">`
 * so author CSS styles all entries alike. Plain text has no markup, so its entries are lines.
 */
export function entriesDocument(
  entries: readonly ListEntry[],
  templates: { open_day?: string; event?: string },
  format: RichTextFormat | undefined,
  timeZone: string | undefined,
): string {
  const pieces = entries.map((entry) => {
    const template = templates[entry.kind]?.trim() ? templates[entry.kind]! : FALLBACK_TEMPLATE[entry.kind];
    const text = fillPlaceholders(template, entryValues(entry, timeZone), format);
    const wrapper = `<div class="entry entry--${entry.kind}">`;
    if (format === 'html') return `${wrapper}${text}</div>`;
    if (format === 'markdown') return `${wrapper}\n\n${text}\n\n</div>`;
    return text;
  });
  return pieces.join(format === 'markdown' ? '\n\n' : '\n');
}
