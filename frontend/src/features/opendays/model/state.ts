import type { CurrentUser, OpenDay, OpenDayStaffRequirement, OpenDayTimeslot } from '../../../api/generated/models';
import { hasPermission } from '../../auth/permissions';
import { dateOf, dayDiff, plural, shortTimeRange } from './dates';

/** What the signed-in person may do with open days; the backend enforces all of it again. */
export type Viewer = {
  personId: string | null;
  /** The membership system role, which decides which places the person may take. */
  kind: 'supervisor' | 'trainee' | 'visitor' | null;
  canSignUp: boolean;
  canAssign: boolean;
  canManage: boolean;
  canSeePeople: boolean;
};

export function viewerOf(user: CurrentUser): Viewer {
  const membership = user.person.roles.find(
    (role) => role.systemKey === 'supervisor' || role.systemKey === 'trainee' || role.systemKey === 'visitor',
  )?.systemKey;
  return {
    personId: user.person.id,
    kind: membership === 'supervisor' || membership === 'trainee' || membership === 'visitor' ? membership : null,
    canSignUp: hasPermission(user, 'open_days.signup'),
    canAssign: hasPermission(user, 'open_days.assign'),
    canManage: hasPermission(user, 'open_days.manage'),
    canSeePeople: hasPermission(user, 'open_days.read_assignments') || hasPermission(user, 'open_days.manage'),
  };
}

/** Clock and rules the states depend on. `warningDays` is the staffing rules' warning window. */
export type StateContext = { viewer: Viewer; now: Date; warningDays: number };

export const DEFAULT_WARNING_DAYS = 14;

export type SlotState =
  'cancelled' | 'mine' | 'staffed' | 'past' | 'urgent' | 'short' | 'open' | 'full' | 'ok' | 'other' | 'neutral';

/** The most telling state first: a day shows the strongest state of its timeslots. */
const STATE_ORDER: SlotState[] = [
  'mine',
  'urgent',
  'short',
  'open',
  'full',
  'ok',
  'other',
  'neutral',
  'staffed',
  'past',
];

export const free = (requirement: OpenDayStaffRequirement | undefined) =>
  requirement ? Math.max(0, requirement.requiredCount - requirement.assignedCount) : 0;

export const supervisorsOf = (slot: OpenDayTimeslot) => slot.requirements.find((item) => item.kind === 'supervisor');
export const traineesOf = (slot: OpenDayTimeslot) => slot.requirements.find((item) => item.kind === 'trainee');

export const slotEnded = (slot: Pick<OpenDayTimeslot, 'endsAt'>, now: Date) => new Date(slot.endsAt) <= now;
export const dayEnded = (day: Pick<OpenDay, 'endsAt'>, now: Date) => new Date(day.endsAt) <= now;

/** An open slot starts within the warning window: unfilled supervisor places there are urgent. */
export function startsSoon(slot: Pick<OpenDayTimeslot, 'startsAt' | 'endsAt'>, ctx: StateContext) {
  return !slotEnded(slot, ctx.now) && dayDiff(dateOf(slot.startsAt), dateOf(ctx.now)) <= ctx.warningDays;
}

/** Supervisor places still free in timeslots that have not ended; trainee places never count as short-staffed. */
export function missingSupervisors(day: OpenDay, now: Date) {
  if (day.status === 'cancelled') return 0;
  return day.timeslots
    .filter((slot) => !slotEnded(slot, now))
    .reduce((sum, slot) => sum + free(supervisorsOf(slot)), 0);
}

export const isShortStaffed = (day: OpenDay, now: Date) => missingSupervisors(day, now) > 0;

/** The places in a timeslot the viewer can take right now, from the API's `canJoin` flags. */
export function joinablePlaces(slot: OpenDayTimeslot) {
  return slot.requirements.filter((item) => item.canJoin && free(item) > 0);
}

export const placesInSlot = (slot: OpenDayTimeslot) => joinablePlaces(slot).reduce((sum, item) => sum + free(item), 0);
export const placesForMe = (day: OpenDay) =>
  day.status === 'cancelled' ? 0 : day.timeslots.reduce((sum, slot) => sum + placesInSlot(slot), 0);

/** The place the viewer holds in a timeslot, if any. */
export function myRequirement(slot: OpenDayTimeslot) {
  const mine = slot.myAssignment;
  return mine ? slot.requirements.find((item) => item.id === mine.requirementId) : undefined;
}

export const mySlots = (day: OpenDay) => day.timeslots.filter((slot) => slot.myAssignment);

/**
 * How a timeslot looks from the viewer's side. "Full" means every place the viewer may take is taken; that comes from
 * the API's `eligible` and `canJoin` flags, never from a role name.
 */
export function slotState(day: OpenDay, slot: OpenDayTimeslot, ctx: StateContext): SlotState {
  if (day.status === 'cancelled') return 'cancelled';
  const ended = slotEnded(slot, ctx.now);
  if (slot.myAssignment) return ended ? 'staffed' : 'mine';
  if (ended) return 'past';
  if (ctx.viewer.canManage && free(supervisorsOf(slot)) > 0) return startsSoon(slot, ctx) ? 'urgent' : 'short';
  if (!ctx.viewer.canSignUp || !ctx.viewer.personId) return 'neutral';
  const eligible = slot.requirements.filter((item) => item.eligible);
  if (!eligible.length) return 'other';
  const joinable = joinablePlaces(slot);
  if (joinable.length)
    return joinable.some((item) => item.kind === 'supervisor') && startsSoon(slot, ctx) ? 'urgent' : 'open';
  if (eligible.every((item) => free(item) === 0)) return ctx.viewer.canManage ? 'ok' : 'full';
  return 'neutral';
}

export function dayState(day: OpenDay, ctx: StateContext): SlotState {
  if (day.status === 'cancelled') return 'cancelled';
  const states = day.timeslots.map((slot) => slotState(day, slot, ctx));
  return states.sort((a, b) => STATE_ORDER.indexOf(a) - STATE_ORDER.indexOf(b))[0] ?? 'neutral';
}

export type StateTagInfo = { label: string; color: 'green' | 'red' | 'blue' | 'gray' | 'outline'; urgent?: boolean };

const kindName = (kind: string) => (kind === 'supervisor' ? 'Supervisor' : 'Trainee');

/** The short state tag of a day (or one of its timeslots). `compact` drops the place count. */
export function stateTag(
  day: OpenDay,
  slot: OpenDayTimeslot | null,
  ctx: StateContext,
  compact = false,
): StateTagInfo | null {
  const state = slot ? slotState(day, slot, ctx) : dayState(day, ctx);
  const missing = slot ? free(supervisorsOf(slot)) : missingSupervisors(day, ctx.now);
  const places = slot ? placesInSlot(slot) : placesForMe(day);
  const mine = slot ? [slot] : mySlots(day);
  switch (state) {
    case 'mine': {
      const first = mine[0];
      const upcoming = mine.filter((item) => !slotEnded(item, ctx.now));
      const label =
        !slot && day.timeslots.length > 1
          ? `You're in · ${upcoming.map((item) => shortTimeRange(item.startsAt, item.endsAt)).join(', ')}`
          : `You're in · ${kindName(myRequirement(first)?.kind ?? 'supervisor')}`;
      return { label, color: 'green' };
    }
    case 'staffed':
      return {
        label: `You staffed${slot || day.timeslots.length === 1 ? ` · ${kindName(myRequirement(mine[0])?.kind ?? 'supervisor')}` : ''}`,
        color: 'outline',
      };
    case 'urgent':
      return ctx.viewer.canManage
        ? { label: `${plural(missing, 'supervisor')} missing`, color: 'red', urgent: true }
        : {
            label: compact ? 'Supervisor needed' : `Supervisor needed · ${plural(places, 'place')} open`,
            color: 'red',
            urgent: true,
          };
    case 'short':
      return { label: `${plural(missing, 'supervisor')} missing`, color: 'red' };
    case 'open':
      return { label: compact ? 'Place for you' : `${plural(places, 'place')} for you`, color: 'blue' };
    case 'full':
      return { label: 'Full', color: 'gray' };
    case 'ok':
      return { label: 'Staffed', color: 'gray' };
    case 'other':
      return { label: 'Other roles only', color: 'outline' };
    case 'cancelled':
      return { label: 'Cancelled', color: 'gray' };
    default:
      return null;
  }
}

export const supporters = (day: OpenDay) => day.competencies.map((item) => item.label);

export const signedUpCount = (slot: OpenDayTimeslot) =>
  slot.requirements.reduce((sum, item) => sum + item.assignedCount, 0);

export const isUnsavedKey = (day: Pick<OpenDay, 'id'>) => day.id.startsWith('new-') || day.id.startsWith('gen-');
