// Playback resolution: the first matching enabled rule wins, the display's default playlist sits fixed at the bottom.
// There is no implicit priority; the position in the rule list is the only priority. Pure TS (no Carbon, no src/app):
// the admin preview and the player run the same code. Time windows use the clock of the device the code runs on.

export type RuleKind = 'time_window' | 'machine_printing' | 'announcement_active' | 'live_data_unavailable';
export type TargetKind = 'scene' | 'playlist';
export type MultiMode = 'split' | 'alternate';

/** The fields of an API rule (admin) or a published player rule that the engine reads. Player rules have no `enabled`. */
export type PlaybackRule = {
  id: string;
  enabled?: boolean;
  kind: RuleKind;
  /** ISO weekdays, 1 = Monday … 7 = Sunday. */
  weekdays: readonly number[];
  /** HH:MM; a window with `timeFrom` after `timeTo` runs over midnight. */
  timeFrom: string | null;
  timeTo: string | null;
  machineIds: readonly string[];
  machineMatch: 'any' | 'all' | null;
  /** Empty means any template. */
  announcementTemplateIds: readonly string[];
  targetKind: TargetKind;
  targetId: string;
  minSeconds: number;
  multiMode: MultiMode;
  alternateSeconds: number;
};

export type PlaybackContext = {
  now: Date;
  /** Machines that currently print (any state other than idle, finished, failed or unknown is decided by the caller). */
  printingMachineIds: readonly string[];
  /** Template ids of the announcements in force for the display. */
  activeAnnouncementTemplateIds: readonly string[];
  /** False when the last successful live poll is older than 60 s. */
  liveDataAvailable: boolean;
};

export type Names = { machine: (id: string) => string; template: (id: string) => string };
const defaultNames: Names = { machine: (id) => id, template: (id) => id };

export type PlaybackResult = {
  ruleId: string;
  /** 1-based position of the winning rule; null for the default playlist. */
  rulePosition: number | null;
  target: { kind: TargetKind; id: string };
  reason: string;
  activeMachineIds: string[];
  multiMode: MultiMode | null;
  alternateSeconds: number;
  minSeconds: number;
};

export const DEFAULT_RULE_ID = 'default';
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** ISO weekday: Monday = 1 … Sunday = 7. */
export const isoWeekday = (date: Date) => (date.getDay() === 0 ? 7 : date.getDay());

export function toMinutes(value: string | null): number {
  const [hours, minutes] = (value ?? '').split(':').map(Number);
  return (hours || 0) * 60 + (minutes || 0);
}

export function timeWindowActive(rule: Pick<PlaybackRule, 'weekdays' | 'timeFrom' | 'timeTo'>, now: Date): boolean {
  const minute = now.getHours() * 60 + now.getMinutes();
  const from = toMinutes(rule.timeFrom);
  const to = toMinutes(rule.timeTo);
  const today = isoWeekday(now);
  if (from === to) return false;
  if (from < to) return rule.weekdays.includes(today) && minute >= from && minute < to;
  // Over midnight: the evening belongs to the listed day, the early morning to the day after it.
  const yesterday = today === 1 ? 7 : today - 1;
  return (rule.weekdays.includes(today) && minute >= from) || (rule.weekdays.includes(yesterday) && minute < to);
}

export function conditionMatches(rule: PlaybackRule, context: PlaybackContext): boolean {
  switch (rule.kind) {
    case 'time_window': return timeWindowActive(rule, context.now);
    case 'machine_printing': {
      if (rule.machineIds.length === 0) return false;
      const printing = context.printingMachineIds;
      return rule.machineMatch === 'all' ? rule.machineIds.every((id) => printing.includes(id)) : rule.machineIds.some((id) => printing.includes(id));
    }
    case 'announcement_active': return rule.announcementTemplateIds.length === 0 ? context.activeAnnouncementTemplateIds.length > 0 : context.activeAnnouncementTemplateIds.some((id) => rule.announcementTemplateIds.includes(id));
    case 'live_data_unavailable': return !context.liveDataAvailable;
  }
}

/** "Mon–Fri", "Mon, Wed", "Every day". */
export function describeDays(days: readonly number[]): string {
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

export function describeCondition(rule: Pick<PlaybackRule, 'kind' | 'weekdays' | 'timeFrom' | 'timeTo' | 'machineIds' | 'machineMatch' | 'announcementTemplateIds'>, names: Names = defaultNames): string {
  switch (rule.kind) {
    case 'time_window': return `${describeDays(rule.weekdays)} ${rule.timeFrom ?? ''}–${rule.timeTo ?? ''}`;
    case 'machine_printing': return `${rule.machineMatch === 'all' ? 'All' : 'Any'} of ${rule.machineIds.map(names.machine).join(', ')} printing`;
    case 'announcement_active': return rule.announcementTemplateIds.length === 0 ? 'Announcement active' : `Announcement active (${rule.announcementTemplateIds.map(names.template).join(', ')})`;
    case 'live_data_unavailable': return 'Live data unavailable';
  }
}

/** Short condition text for "why is this on screen": template names are left out of announcement conditions. */
function reasonOf(rule: PlaybackRule, names: Names): string {
  if (rule.kind === 'time_window') return describeCondition(rule, names);
  const text = describeCondition(rule.kind === 'announcement_active' ? { ...rule, announcementTemplateIds: [] } : rule, names);
  return text.replace(/^./, (char) => char.toLowerCase());
}

export function resolvePlayback(defaultPlaylistId: string, rules: readonly PlaybackRule[], context: PlaybackContext, names: Names = defaultNames): PlaybackResult {
  const activeMachineIds = [...context.printingMachineIds];
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    if (rule.enabled === false || !conditionMatches(rule, context)) continue;
    return {
      ruleId: rule.id,
      rulePosition: index + 1,
      target: { kind: rule.targetKind, id: rule.targetId },
      reason: `Rule ${index + 1}: ${reasonOf(rule, names)}`,
      activeMachineIds,
      multiMode: rule.multiMode,
      alternateSeconds: rule.alternateSeconds,
      minSeconds: rule.minSeconds,
    };
  }
  return { ruleId: DEFAULT_RULE_ID, rulePosition: null, target: { kind: 'playlist', id: defaultPlaylistId }, reason: 'Otherwise: default playlist', activeMachineIds, multiMode: null, alternateSeconds: 10, minSeconds: 0 };
}

/** Seconds of one pass through a playlist. */
export const loopSeconds = (items: readonly { seconds: number }[]) => items.reduce((sum, item) => sum + item.seconds, 0);

/** The playlist item that is on screen `elapsedSeconds` after the loop started, and the seconds left of it. */
export function playlistPosition<T extends { seconds: number }>(items: readonly T[], elapsedSeconds: number): { item: T; index: number; secondsLeft: number } | null {
  const loop = loopSeconds(items);
  if (items.length === 0 || loop <= 0) return null;
  let position = ((elapsedSeconds % loop) + loop) % loop;
  for (let index = 0; index < items.length; index += 1) {
    if (position < items[index].seconds) return { item: items[index], index, secondsLeft: Math.ceil(items[index].seconds - position) };
    position -= items[index].seconds;
  }
  return { item: items[0], index: 0, secondsLeft: items[0].seconds };
}
