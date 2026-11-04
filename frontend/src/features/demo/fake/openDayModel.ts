import type {
  ComingUpItem,
  OpenDay,
  OpenDayAssignment,
  PersonalDashboardStaffing,
} from '../../../api/generated/models';
import { can, type DemoStore } from './store';

const ACTIVE = (day: OpenDay) => day.status === 'scheduled';
const mine = (store: DemoStore, assignment: OpenDayAssignment) => assignment.personId === store.user.person.id;

/** Recomputes the counters of the period from its Open Days. */
export function refreshPeriod(store: DemoStore): void {
  const days = store.openDays.filter(ACTIVE);
  const staffed = (day: OpenDay) => day.requirements.every((item) => item.assignedCount >= item.requiredCount);
  store.period.totalOpenDays = store.openDays.length;
  store.period.cancelledCount = store.openDays.length - days.length;
  store.period.fullyStaffedCount = days.filter(staffed).length;
  store.period.needsStaffCount = days.length - store.period.fullyStaffedCount;
  store.period.openSupervisorPositions = days.reduce((sum, day) => {
    const supervisors = day.requirements.find((item) => item.kind === 'supervisor');
    return sum + Math.max(0, (supervisors?.requiredCount ?? 0) - (supervisors?.assignedCount ?? 0));
  }, 0);
  store.period.myAssignmentCount = days.filter((day) =>
    day.requirements.some((item) => item.assignments?.some((a) => mine(store, a))),
  ).length;
}

/** The Open Day as the signed-in person sees it: own assignment flagged, names only for those who may see them. */
export function openDayView(store: DemoStore, day: OpenDay): OpenDay {
  const seesNames =
    can(store, 'open_days.read_assignments') || can(store, 'open_days.assign') || can(store, 'open_days.manage');
  let myAssignment: OpenDayAssignment | null = null;
  const requirements = day.requirements.map((requirement) => {
    const assignments = (requirement.assignments ?? []).map((a) => ({ ...a, isCurrentUser: mine(store, a) }));
    myAssignment ??= assignments.find((a) => a.isCurrentUser) ?? null;
    return {
      ...requirement,
      assignedCount: assignments.length,
      assignments: seesNames ? assignments : assignments.filter((a) => a.isCurrentUser),
    };
  });
  return { ...day, requirements, myAssignment };
}

export function comingUp(store: DemoStore): ComingUpItem[] {
  return store.openDays
    .filter(ACTIVE)
    .filter((day) => day.requirements.some((item) => item.assignments?.some((a) => mine(store, a))))
    .map((day) => ({
      kind: 'open_day' as const,
      id: day.id,
      title: 'Open Day',
      startsAt: day.startsAt,
      endsAt: day.endsAt,
      openDayId: day.id,
      periodId: day.periodId,
    }));
}

/** The staffing block of the dashboard: the person's semester progress and the next place they could take. */
export function staffingOf(store: DemoStore): PersonalDashboardStaffing {
  const kind = can(store, 'open_days.signup') ? 'supervisor' : 'trainee';
  const booked = store.period.myAssignmentCount;
  const minimum = 2;
  const free = store.openDays.filter(ACTIVE).find((day) => {
    const requirement = day.requirements.find((item) => item.kind === kind);
    const taken = day.requirements.some((item) => item.assignments?.some((a) => mine(store, a)));
    return requirement && !taken && requirement.assignedCount < requirement.requiredCount;
  });
  const place = free?.requirements.find((item) => item.kind === kind);
  const next = store.openDays.filter(ACTIVE)[0];
  const nextSupervisors = next?.requirements.find((item) => item.kind === 'supervisor');
  return {
    kind,
    semester: {
      periodId: store.period.id,
      name: store.period.name,
      startsOn: store.period.startsOn,
      endsOn: store.period.endsOn,
      signUpBy: (store.openDays[store.openDays.length - 1]?.startsAt ?? store.period.endsOn).slice(0, 10),
    },
    minimum,
    traineeThreshold: 3,
    staffed: 0,
    booked,
    staffedAsTrainee: 0,
    status: booked >= minimum ? 'ready' : 'missing',
    missing: Math.max(0, minimum - booked),
    nextOpenPlace:
      free && place
        ? {
            openDayId: free.id,
            periodId: free.periodId,
            requirementId: place.id,
            startsAt: free.startsAt,
            endsAt: free.endsAt,
            freePlaces: place.requiredCount - place.assignedCount,
          }
        : null,
    nextOpenDay: next
      ? {
          openDayId: next.id,
          startsAt: next.startsAt,
          endsAt: next.endsAt,
          openSupervisorPlaces: Math.max(
            0,
            (nextSupervisors?.requiredCount ?? 0) - (nextSupervisors?.assignedCount ?? 0),
          ),
          shortStaffed: (nextSupervisors?.assignedCount ?? 0) < (nextSupervisors?.requiredCount ?? 0),
        }
      : null,
  };
}
