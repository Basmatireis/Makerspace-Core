import type { Announcement, Condition, Display, MachineKey, PlaybackResult, Rule, Sim, Target } from './types';

// Resolution engine: the first matching enabled rule wins, the default playlist sits fixed at the bottom.
// An active announcement takes the top of the list unless the list contains an "Announcement active" rule;
// then the announcement wins only from that rule's position on.

export const MACHINE_NAMES: Record<MachineKey, string> = { h2d: 'H2D', x1c: 'X1C' };
export const MACHINE_KEYS: MachineKey[] = ['h2d', 'x1c'];
/** Scene used when an announcement is switched on without a choice (the simulation toggle). */
export const DEFAULT_ANNOUNCEMENT_SCENE = 'scene-closed';

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

export function conditionMatches(condition: Condition, sim: Sim, now: Date, announcementActive: boolean): boolean {
  switch (condition.kind) {
    case 'time': return timeWindowActive(condition, now);
    case 'machines': {
      if (condition.machines.length === 0) return false;
      const printing = printingMachines(sim);
      return condition.mode === 'any' ? condition.machines.some((key) => printing.includes(key)) : condition.machines.every((key) => printing.includes(key));
    }
    case 'announcement': return announcementActive;
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

export function describeCondition(condition: Condition): string {
  switch (condition.kind) {
    case 'time': return `${describeDays(condition.days)} ${condition.from}–${condition.to}`;
    case 'machines': return condition.mode === 'any' ? `Any of ${joinNames(condition.machines)} printing` : `All of ${joinNames(condition.machines)} printing`;
    case 'announcement': return 'Announcement active';
    case 'stale': return 'Live data unavailable';
  }
}

/** The announcement in force: the display's own takeover (unless it has run out), else the simulated one. */
export function activeAnnouncement(display: Pick<Display, 'announcement'>, sim: Sim, now: Date): Announcement | null {
  const own = display.announcement;
  if (own && (!own.until || Date.parse(own.until) > now.getTime())) return own;
  return sim.announcement ? { sceneId: DEFAULT_ANNOUNCEMENT_SCENE, text: null, until: null } : null;
}

export function resolvePlayback(display: Pick<Display, 'defaultPlaylistId' | 'announcement'>, rules: Rule[], sim: Sim, now: Date): PlaybackResult {
  const announcement = activeAnnouncement(display, sim, now);
  const activeMachines = printingMachines(sim);
  const announcementTarget = (fallback: Target): Target => announcement?.sceneId ? { type: 'scene', id: announcement.sceneId } : announcement?.text ? { type: 'scene', id: '' } : fallback;
  const hasAnnouncementRule = rules.some((rule) => rule.enabled && rule.condition.kind === 'announcement');

  if (announcement && !hasAnnouncementRule) {
    return { ruleId: 'announcement', target: announcementTarget({ type: 'scene', id: DEFAULT_ANNOUNCEMENT_SCENE }), reason: 'Announcement takeover', activeMachines, multiMode: null, alternateSeconds: 10, announcement };
  }
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    if (!rule.enabled || !conditionMatches(rule.condition, sim, now, announcement !== null)) continue;
    const isAnnouncement = rule.condition.kind === 'announcement';
    return {
      ruleId: rule.id,
      target: isAnnouncement ? announcementTarget(rule.target) : rule.target,
      reason: `Rule ${index + 1}: ${rule.condition.kind === 'time' ? describeCondition(rule.condition) : describeCondition(rule.condition).replace(/^./, (char) => char.toLowerCase())}`,
      activeMachines,
      multiMode: rule.multiMode,
      alternateSeconds: rule.alternateSeconds,
      announcement: isAnnouncement ? announcement : null,
    };
  }
  return { ruleId: 'default', target: { type: 'playlist', id: display.defaultPlaylistId }, reason: 'Otherwise: default playlist', activeMachines, multiMode: null, alternateSeconds: 10, announcement: null };
}
