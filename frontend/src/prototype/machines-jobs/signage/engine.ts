import type { Announcement, AnnouncementContext, AnnouncementField, AnnouncementTemplate, AnnouncementTiming, Condition, Display, MachineKey, PlaybackResult, RenderedMessage, Rule, Sim } from './types';

// Resolution engine: the first matching enabled rule wins, the default playlist sits fixed at the bottom.
// Announcements are ordinary data: a rule with the condition "Announcement active" matches while one targets the display.
// There is no implicit priority; the position in the list is the only priority.

export const MACHINE_NAMES: Record<MachineKey, string> = { h2d: 'H2D', x1c: 'X1C' };
export const MACHINE_KEYS: MachineKey[] = ['h2d', 'x1c'];

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** ISO weekday: Monday = 1 … Sunday = 7. */
export const isoWeekday = (date: Date) => (date.getDay() === 0 ? 7 : date.getDay());

export function toMinutes(value: string): number {
  const [hours, minutes] = value.split(':').map(Number);
  return (hours || 0) * 60 + (minutes || 0);
}

export function timeWindowActive(condition: Extract<Condition, { kind: 'time' }>, now: Date): boolean {
  const minute = now.getHours() * 60 + now.getMinutes();
  const from = toMinutes(condition.from);
  const to = toMinutes(condition.to);
  const today = isoWeekday(now);
  if (from === to) return false;
  if (from < to) return condition.days.includes(today) && minute >= from && minute < to;
  // Over midnight: the evening belongs to the listed day, the early morning to the day after it.
  const yesterday = today === 1 ? 7 : today - 1;
  return (condition.days.includes(today) && minute >= from) || (condition.days.includes(yesterday) && minute < to);
}

export function printingMachines(sim: Sim): MachineKey[] {
  return MACHINE_KEYS.filter((key) => sim[key] !== 'idle');
}

export function conditionMatches(condition: Condition, sim: Sim, now: Date, active: Announcement[]): boolean {
  switch (condition.kind) {
    case 'time': return timeWindowActive(condition, now);
    case 'machines': {
      if (condition.machines.length === 0) return false;
      const printing = printingMachines(sim);
      return condition.mode === 'any' ? condition.machines.some((key) => printing.includes(key)) : condition.machines.every((key) => printing.includes(key));
    }
    case 'announcement': return condition.templateIds.length === 0 ? active.length > 0 : active.some((item) => condition.templateIds.includes(item.templateId));
    case 'stale': return !sim.coreReachable;
  }
}

/** "Mon–Fri", "Mon, Wed", "Every day". */
export function describeDays(days: number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.length === 0) return 'No day';
  if (sorted.length === 7) return 'Every day';
  const runs: number[][] = [];
  for (const day of sorted) {
    const last = runs.at(-1);
    if (last && last.at(-1) === day - 1) last.push(day); else runs.push([day]);
  }
  return runs.map((run) => run.length >= 3 ? `${DAY_NAMES[run[0] - 1]}–${DAY_NAMES[run.at(-1)! - 1]}` : run.map((day) => DAY_NAMES[day - 1]).join(', ')).join(', ');
}

const joinNames = (keys: MachineKey[]) => keys.map((key) => MACHINE_NAMES[key]).join(', ');

/** `templateName` turns a template id into its name for the "only these templates" variant. */
export function describeCondition(condition: Condition, templateName: (id: string) => string = (id) => id): string {
  switch (condition.kind) {
    case 'time': return `${describeDays(condition.days)} ${condition.from}–${condition.to}`;
    case 'machines': return condition.mode === 'any' ? `Any of ${joinNames(condition.machines)} printing` : `All of ${joinNames(condition.machines)} printing`;
    case 'announcement': return condition.templateIds.length === 0 ? 'Announcement active' : `Announcement active (${condition.templateIds.map(templateName).join(', ')})`;
    case 'stale': return 'Live data unavailable';
  }
}

/** Short condition text for "why is this on screen": the template names are left out of announcement conditions. */
const reasonOf = (condition: Condition): string => {
  if (condition.kind === 'time') return describeCondition(condition);
  return describeCondition(condition.kind === 'announcement' ? { kind: 'announcement', templateIds: [] } : condition).replace(/^./, (char) => char.toLowerCase());
};

/** `active` are the announcements in force for this display, see `activeAnnouncementsFor`. */
export function resolvePlayback(display: Pick<Display, 'defaultPlaylistId'>, rules: Rule[], sim: Sim, now: Date, active: Announcement[]): PlaybackResult {
  const activeMachines = printingMachines(sim);
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    if (!rule.enabled || !conditionMatches(rule.condition, sim, now, active)) continue;
    return {
      ruleId: rule.id,
      target: rule.target,
      reason: `Rule ${index + 1}: ${reasonOf(rule.condition)}`,
      activeMachines,
      multiMode: rule.multiMode,
      alternateSeconds: rule.alternateSeconds,
    };
  }
  return { ruleId: 'default', target: { type: 'playlist', id: display.defaultPlaylistId }, reason: 'Otherwise: default playlist', activeMachines, multiMode: null, alternateSeconds: 10 };
}

// Announcements -------------------------------------------------------------------------------------------------------------------

/** Announcements whose window contains `now` and that target the display (all displays, or the display is selected). Start inclusive, end exclusive. */
export function activeAnnouncementsFor(displayId: string, announcements: Announcement[], now: Date): Announcement[] {
  const time = now.getTime();
  return announcements.filter((item) => Date.parse(item.startsAt) <= time && (item.endsAt === null || time < Date.parse(item.endsAt)) && (item.displayIds === null || item.displayIds.includes(displayId)));
}

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
const formatTime = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;
const formatDate = (date: Date) => `${WEEKDAY_SHORT[date.getDay()]} ${date.getDate()} ${MONTH_SHORT[date.getMonth()]}`;
const dayStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
const dayDifference = (date: Date, now: Date) => Math.round((dayStart(date) - dayStart(now)) / 86_400_000);

/** "at 14:30" today, "on Mon 21 Oct at 10:00" otherwise. */
function describeMoment(date: Date, now: Date): string {
  return dayDifference(date, now) === 0 ? `at ${formatTime(date)}` : `on ${formatDate(date)} at ${formatTime(date)}`;
}

/** Local date and time from the `YYYY-MM-DD[THH:MM]` form values; null when the value is empty or invalid. */
export function parseLocal(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4] ?? 0), Number(match[5] ?? 0));
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatFieldValue(field: AnnouncementField, value: string, now: Date): string {
  if (value.trim() === '') return '';
  switch (field.type) {
    case 'date': { const date = parseLocal(value); return date ? formatDate(date) : value; }
    case 'datetime': {
      const date = parseLocal(value);
      if (!date) return value;
      const days = dayDifference(date, now);
      return days === 0 ? `today at ${formatTime(date)}` : days === 1 ? `tomorrow at ${formatTime(date)}` : `on ${formatDate(date)} at ${formatTime(date)}`;
    }
    case 'machine': return MACHINE_NAMES[value as MachineKey] ?? value;
    default: return value;
  }
}

/** Keys of all `{placeholders}` in the text, in order of appearance. */
export function placeholdersIn(text: string): string[] {
  return [...text.matchAll(/\{([a-z0-9_]+)\}/gi)].map((match) => match[1]);
}

/** Placeholders in the message that are neither a field of the template nor a built-in variable. */
export function unknownPlaceholders(template: Pick<AnnouncementTemplate, 'fields' | 'title' | 'body'>): string[] {
  const known = new Set([...BUILT_IN_KEYS, ...template.fields.map((field) => field.key)]);
  return [...new Set([...placeholdersIn(template.title), ...placeholdersIn(template.body)])].filter((key) => !known.has(key));
}

/** A field key derived from its label ("Back on" -> "back_on"), unique among `taken` and never a built-in name. */
export function fieldKeyFor(label: string, taken: string[]): string {
  const base = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'field';
  let key = base;
  for (let counter = 2; taken.includes(key) || BUILT_IN_KEYS.includes(key); counter += 1) key = `${base}_${counter}`;
  return key;
}

/** Renders a template. Missing optional values become empty, unknown placeholders stay visible as typed. */
export function renderAnnouncement(template: Pick<AnnouncementTemplate, 'fields' | 'title' | 'body' | 'tone'>, values: Record<string, string>, timing: AnnouncementTiming, context: AnnouncementContext): RenderedMessage {
  const { now } = context;
  const { startsAt, endsAt } = timing;
  const lookup: Record<string, string> = {
    ends_at: endsAt ? formatTime(endsAt) : '',
    ends_on: endsAt ? formatDate(endsAt) : '',
    ends: endsAt ? describeMoment(endsAt, now) : 'until further notice',
    starts_at: formatTime(startsAt),
    today: formatDate(now),
    display: context.displayName,
    location: context.location,
  };
  for (const field of template.fields) lookup[field.key] = formatFieldValue(field, values[field.key] ?? '', now);
  const fill = (text: string) => text.replace(/\{([a-z0-9_]+)\}/gi, (match, key: string) => (Object.hasOwn(lookup, key) ? lookup[key] : match));
  return { title: fill(template.title), body: fill(template.body), tone: template.tone };
}
