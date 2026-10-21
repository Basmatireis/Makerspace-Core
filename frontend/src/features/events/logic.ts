import type {
  Event,
  EventFile,
  EventGoLive,
  EventParticipationPosition,
  EventReadinessCode,
  EventSession,
  EventShift,
  EventShiftStatus,
  EventStatus,
  PublicEvent,
  PublicEventRequirementAvailability,
} from '../../api/generated/models';
import { APP_TIME_ZONE } from '../../app/dateTime';
import { dayKey, fmtDate, plural } from './format';

// Pure rules and derived values. The backend owns every rule; this only words its answers and groups data for display.

export type EditTab = 'overview' | 'programme' | 'helpers' | 'tasks' | 'public' | 'files';

export const STATUS_LABEL: Record<EventStatus, string> = {
  draft: 'Draft',
  confirmed: 'Confirmed',
  completed: 'Completed',
  cancelled: 'Cancelled',
};
export const SHIFT_LABEL: Record<EventShiftStatus, string> = {
  draft: 'Draft',
  open: 'Signup open',
  closed: 'Signup closed',
  cancelled: 'Cancelled',
};
export const isClosed = (status: EventStatus) => status === 'completed' || status === 'cancelled';

export const closedNotice = (status: EventStatus) =>
  `This event is ${status}. Details, programme and helpers are read-only; tasks and files can still be edited.`;

// Programme -------------------------------------------------------------------------------------------------------

export type ProgrammeDay<S, H> = {
  key: string;
  date: string;
  sessions: { session: S; shifts: H[] }[];
  loose: H[];
};

/** Groups sessions and their shifts by day; shifts without a (known) session sit in `loose`. */
export function programme<
  S extends { id: string; startsAt: string },
  H extends { sessionId?: string | null; startsAt: string },
>(sessions: S[], shifts: H[]): ProgrammeDay<S, H>[] {
  const days = new Map<string, ProgrammeDay<S, H>>();
  const dayOf = (iso: string) => {
    const key = dayKey(iso);
    let day = days.get(key);
    if (!day) {
      day = { key, date: iso, sessions: [], loose: [] };
      days.set(key, day);
    }
    return day;
  };
  const byStart = <T extends { startsAt: string }>(a: T, b: T) => Date.parse(a.startsAt) - Date.parse(b.startsAt);
  for (const session of [...sessions].sort(byStart)) {
    dayOf(session.startsAt).sessions.push({
      session,
      shifts: shifts.filter((shift) => shift.sessionId === session.id).sort(byStart),
    });
  }
  const known = new Set(sessions.map((session) => session.id));
  for (const shift of [...shifts].sort(byStart)) {
    if (!shift.sessionId || !known.has(shift.sessionId)) dayOf(shift.startsAt).loose.push(shift);
  }
  return [...days.values()].sort((a, b) => a.key.localeCompare(b.key));
}

// Go live ---------------------------------------------------------------------------------------------------------

/** Where the missing piece of a readiness item is fixed. `null`: nothing to do (informational). */
export type FixTarget = 'details' | 'programme' | 'public' | 'confirm' | 'page' | 'signup' | null;

export const READINESS: Record<EventReadinessCode, { text: string; fix: FixTarget }> = {
  event_closed: { text: 'The event is closed', fix: null },
  event_not_confirmed: { text: 'The event is confirmed', fix: 'confirm' },
  owner_missing: { text: 'An owner is assigned', fix: 'details' },
  programme_missing: { text: 'At least one session or shift exists', fix: 'programme' },
  public_title_missing: { text: 'A public title is set', fix: 'public' },
  public_content_missing: { text: 'At least one public session or shift exists', fix: 'programme' },
  public_page_off: { text: 'The public page is live', fix: 'page' },
  signup_disabled: { text: 'Helper signup is switched on', fix: 'signup' },
  no_public_open_shift: { text: 'At least one public shift is open with a position', fix: 'programme' },
};

export type Check = { code: EventReadinessCode; label: string; ok: boolean; fix: FixTarget };

/** Every requirement of a checklist; the ones the backend reports as unmet are marked open. */
export function checklist(all: EventReadinessCode[], unmet: EventReadinessCode[]): Check[] {
  return all.map((code) => ({
    code,
    label: READINESS[code].text,
    ok: !unmet.includes(code),
    fix: READINESS[code].fix,
  }));
}
export const PAGE_REQUIREMENTS: EventReadinessCode[] = [
  'owner_missing',
  'public_title_missing',
  'public_content_missing',
];
export const SIGNUP_REQUIREMENTS: EventReadinessCode[] = [
  'event_not_confirmed',
  'public_page_off',
  'no_public_open_shift',
];

export function signupTag(goLive: EventGoLive): { label: string; type: 'green' | 'gray' | 'blue' } {
  const { state, opensAt } = goLive.helperSignup;
  if (state === 'open') return { label: 'Open', type: 'green' };
  if (state === 'opens_at') return { label: opensAt ? `Opens ${fmtDate(opensAt)}` : 'Opens later', type: 'blue' };
  if (state === 'closed') return { label: 'Closed', type: 'gray' };
  return { label: 'Off', type: 'gray' };
}

// Next steps ------------------------------------------------------------------------------------------------------

export type NextStep = {
  id: string;
  label: string;
  tab?: EditTab;
  action?: 'edit-details' | 'go-live' | 'confirm' | 'complete';
};

export function nextSteps(event: Event, now: number, unlinkedSignups = 0): NextStep[] {
  const steps: NextStep[] = [];
  const pageUnmet = event.goLive.publicPage.unmet;
  if (isClosed(event.status)) {
    const open = event.taskTotal - event.taskCompleted;
    if (open > 0) steps.push({ id: 'tasks', label: `${plural(open, 'follow-up task')} still open`, tab: 'tasks' });
    return steps;
  }
  const confirmUnmet = event.goLive.confirmUnmet;
  if (confirmUnmet.includes('owner_missing'))
    steps.push({ id: 'owner', label: 'Assign an owner', action: 'edit-details' });
  if (confirmUnmet.includes('programme_missing'))
    steps.push({ id: 'programme', label: 'Add a session or a helper shift', tab: 'programme' });
  if (pageUnmet.includes('public_title_missing'))
    steps.push({ id: 'title', label: 'Add a public title', tab: 'public' });
  if (event.openPlaces > 0)
    steps.push({ id: 'open', label: `${plural(event.openPlaces, 'place')} still open`, tab: 'helpers' });
  if (unlinkedSignups > 0)
    steps.push({
      id: 'unlinked',
      label: `${plural(unlinkedSignups, 'public signup')} not linked to a person`,
      tab: 'helpers',
    });
  if (event.tasksOverdue > 0)
    steps.push({ id: 'overdue', label: `${plural(event.tasksOverdue, 'task')} overdue`, tab: 'tasks' });
  if (event.status === 'draft' && confirmUnmet.length === 0)
    steps.push({ id: 'confirm', label: 'Confirm the event', action: 'confirm' });
  if (event.goLive.publicPage.state === 'off' && pageUnmet.length === 0)
    steps.push({ id: 'live', label: 'Put the public page live', action: 'go-live' });
  if (event.status === 'confirmed' && event.rangeEndsAt && Date.parse(event.rangeEndsAt) < now)
    steps.push({ id: 'complete', label: 'The event is over: mark it completed', action: 'complete' });
  return steps;
}

// Participation -----------------------------------------------------------------------------------------------------

/** Short text for a position the caller cannot join; `null` when there is nothing to say. */
export function joinReasonLabel(position: EventParticipationPosition): string | null {
  switch (position.reason) {
    case 'full':
      return 'Full';
    case 'closed':
      return 'Signup closed';
    case 'not_open':
      return 'Not open yet';
    case 'opens_at':
      return position.opensAt ? `Opens ${fmtDate(position.opensAt)}` : 'Not open yet';
    case 'already_joined':
      return 'Already in this shift';
    case 'roles_only':
      return position.roleNames.length > 0
        ? `Members with role ${position.roleNames.join(' or ')} only`
        : 'Members with a required role only';
    default:
      return null;
  }
}

// Tasks -------------------------------------------------------------------------------------------------------------

export const isOverdue = (task: { status: string; dueAt?: string | null }, now: number) =>
  task.status === 'open' && Boolean(task.dueAt) && Date.parse(task.dueAt!) < now;

// Public page preview -----------------------------------------------------------------------------------------------

/**
 * The public page as visitors get it from the API, built from the organizer's data so the Public page tab can render
 * the real page component. Mirrors the server's availability rules only for display; it never writes anything.
 */
export function previewPublicEvent(
  event: Event,
  sessions: EventSession[],
  shifts: EventShift[],
  files: EventFile[],
  now: number,
): PublicEvent {
  const signupEnabled = event.publicSignupEnabled && event.status === 'confirmed';
  return {
    publicId: event.publicId,
    title: event.publicTitle ?? '',
    description: event.publicDescription ?? null,
    location: event.publicLocation ?? null,
    status: event.status,
    timeZone: APP_TIME_ZONE,
    publicSignupEnabled: signupEnabled,
    hasBanner: files.some((file) => file.isBanner && file.visibility === 'public'),
    sessions: sessions
      .filter((session) => session.isPublic && session.status === 'scheduled')
      .map((session) => ({
        id: session.id,
        name: session.name ?? null,
        location: session.location ?? null,
        description: session.description ?? null,
        startsAt: session.startsAt,
        endsAt: session.endsAt,
      })),
    shifts: shifts
      .filter((shift) => shift.isPublic && shift.status !== 'cancelled')
      .map((shift) => {
        const effective =
          signupEnabled &&
          shift.status === 'open' &&
          shift.linkedSessionStatus !== 'cancelled' &&
          Date.parse(shift.endsAt) > now &&
          (!shift.signupOpensAt || Date.parse(shift.signupOpensAt) <= now) &&
          (!shift.signupClosesAt || Date.parse(shift.signupClosesAt) > now);
        return {
          id: shift.id,
          sessionId: shift.sessionId ?? null,
          name: shift.name,
          description: shift.description ?? null,
          startsAt: shift.startsAt,
          endsAt: shift.endsAt,
          requirements: shift.requirements.map((requirement) => {
            const remaining = requirement.requiredCount - requirement.filledCount;
            let availability: PublicEventRequirementAvailability = remaining <= 0 ? 'full' : 'available';
            if (remaining > 0 && requirement.eligibilityMode === 'roles') availability = 'authenticated_only';
            if (!effective) availability = 'not_open';
            return {
              id: requirement.id,
              name: requirement.name,
              description: requirement.description ?? null,
              requiredCount: requirement.requiredCount,
              filledCount: requirement.filledCount,
              remainingCount: Math.max(0, remaining),
              availability,
            };
          }),
        };
      }),
    files: files
      .filter((file) => !file.isBanner && file.visibility === 'public')
      .map((file) => ({
        id: file.id,
        description: file.description ?? null,
        originalFilename: file.originalFilename,
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
      })),
  };
}
