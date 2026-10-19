// TypeScript copy of backend/internal/signage/render.go for the admin preview. Go is authoritative; both run the shared
// vectors in api/testdata/signage-announcement-render.json. Pure TS: no Carbon, no src/app imports (the player reuses it).

export type FieldType = 'text' | 'longtext' | 'time' | 'date' | 'datetime' | 'number' | 'choice' | 'machine';
export type Tone = 'info' | 'warning' | 'critical' | 'neutral';

/** The part of a template field the renderer and the editor need. */
export type EngineField = { key: string; type: FieldType };
export type EngineTemplate = { fields: EngineField[]; title: string; body: string; tone: Tone };
export type AnnouncementTiming = { startsAt: Date; endsAt: Date | null };
/** `timeZone` is the makerspace IANA time zone; `machines` maps a machine id to its name. */
export type AnnouncementContext = { now: Date; timeZone: string; displayName: string; location: string; machines: Record<string, string> };
export type RenderedMessage = { title: string; body: string; tone: Tone };

export const BUILT_IN_VARIABLES = [
  { key: 'ends_at', label: 'End time', sample: '14:30' },
  { key: 'ends_on', label: 'End date', sample: 'Mon 21 Oct' },
  { key: 'ends', label: 'End, in words', sample: 'at 14:30' },
  { key: 'starts_at', label: 'Start time', sample: '09:00' },
  { key: 'today', label: 'Today’s date', sample: 'Mon 21 Oct' },
  { key: 'display', label: 'Display name', sample: 'Entrance window' },
  { key: 'location', label: 'Location', sample: 'Ground floor' },
] as const;
const BUILT_IN_KEYS: string[] = BUILT_IN_VARIABLES.map((item) => item.key);

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (value: number) => String(value).padStart(2, '0');

/**
 * A wall-clock reading as UTC fields, so calendar arithmetic is exact across daylight-saving changes. Instants are
 * converted with Intl; text values (`YYYY-MM-DD[THH:MM]`) are read as-is and roll over like the JavaScript Date constructor.
 */
type Clock = Date;

function wallClock(instant: Date, timeZone: string): Clock {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(instant);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return new Date(Date.UTC(value('year'), value('month') - 1, value('day'), value('hour'), value('minute')));
}

const formatTime = (clock: Clock) => `${pad(clock.getUTCHours())}:${pad(clock.getUTCMinutes())}`;
const formatDate = (clock: Clock) => `${WEEKDAY_SHORT[clock.getUTCDay()]} ${clock.getUTCDate()} ${MONTH_SHORT[clock.getUTCMonth()]}`;
const calendarDay = (clock: Clock) => Date.UTC(clock.getUTCFullYear(), clock.getUTCMonth(), clock.getUTCDate());
const dayDifference = (clock: Clock, now: Clock) => Math.trunc((calendarDay(clock) - calendarDay(now)) / 86_400_000);

/** "at 14:30" today, "on Mon 21 Oct at 10:00" otherwise. */
function describeMoment(clock: Clock, now: Clock): string {
  return dayDifference(clock, now) === 0 ? `at ${formatTime(clock)}` : `on ${formatDate(clock)} at ${formatTime(clock)}`;
}

/** Reads `YYYY-MM-DD[THH:MM]` as a wall-clock reading; null when the text has another shape. */
export function parseLocal(value: string): Clock | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(value);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4] ?? 0), Number(match[5] ?? 0)));
}

function formatFieldValue(field: EngineField, value: string, now: Clock, machines: Record<string, string>): string {
  if (value.trim() === '') return '';
  switch (field.type) {
    case 'date': { const date = parseLocal(value); return date ? formatDate(date) : value; }
    case 'datetime': {
      const date = parseLocal(value);
      if (!date) return value;
      const days = dayDifference(date, now);
      return days === 0 ? `today at ${formatTime(date)}` : days === 1 ? `tomorrow at ${formatTime(date)}` : `on ${formatDate(date)} at ${formatTime(date)}`;
    }
    case 'machine': return Object.hasOwn(machines, value) ? machines[value] : value;
    default: return value;
  }
}

/** Keys of all `{placeholders}` in the text, in order of appearance. */
export function placeholdersIn(text: string): string[] {
  return [...text.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]);
}

/** Placeholders in the message that are neither a field of the template nor a built-in variable, sorted. */
export function unknownPlaceholders(template: { fields: { key: string }[]; title: string; body: string }): string[] {
  const known = new Set([...BUILT_IN_KEYS, ...template.fields.map((field) => field.key)]);
  return [...new Set([...placeholdersIn(template.title), ...placeholdersIn(template.body)])].filter((key) => !known.has(key)).sort();
}

/** A field key derived from its label ("Back on" -> "back_on"), unique among `taken` and never a built-in name. */
export function fieldKeyFor(label: string, taken: string[]): string {
  const base = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^[0-9_]+/, '').slice(0, 36) || 'field';
  let key = base;
  for (let counter = 2; taken.includes(key) || BUILT_IN_KEYS.includes(key); counter += 1) key = `${base}_${counter}`;
  return key;
}

/** Renders a template. Missing optional values become empty, unknown placeholders stay visible as typed. */
export function renderAnnouncement(template: EngineTemplate, values: Record<string, string>, timing: AnnouncementTiming, context: AnnouncementContext): RenderedMessage {
  const now = wallClock(context.now, context.timeZone);
  const startsAt = wallClock(timing.startsAt, context.timeZone);
  const endsAt = timing.endsAt ? wallClock(timing.endsAt, context.timeZone) : null;
  const lookup: Record<string, string> = {
    ends_at: endsAt ? formatTime(endsAt) : '',
    ends_on: endsAt ? formatDate(endsAt) : '',
    ends: endsAt ? describeMoment(endsAt, now) : 'until further notice',
    starts_at: formatTime(startsAt),
    today: formatDate(now),
    display: context.displayName,
    location: context.location,
  };
  for (const field of template.fields) lookup[field.key] = formatFieldValue(field, values[field.key] ?? '', now, context.machines);
  const fill = (text: string) => text.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) => (Object.hasOwn(lookup, key) ? lookup[key] : match));
  return { title: fill(template.title), body: fill(template.body), tone: template.tone };
}
