import type { OpenDay, OpenDayPeriod, OpenDayStaffRequirement, OpenDayTimeslot } from '../../api/generated/models';
import { zonedDateTimeToISO } from '../../app/dateTime';
import type { Viewer } from './model/state';

type RequirementOptions = Partial<
  Pick<OpenDayStaffRequirement, 'assignedCount' | 'eligible' | 'canJoin' | 'eligibleRoleIds'>
>;

export function requirement(
  id: string,
  kind: 'supervisor' | 'trainee',
  requiredCount: number,
  options: RequirementOptions = {},
): OpenDayStaffRequirement {
  return {
    id,
    timeslotId: `${id}-slot`,
    kind,
    requiredCount,
    assignedCount: 0,
    eligible: false,
    canJoin: false,
    ...options,
  };
}

export function slot(
  id: string,
  date: string,
  start: string,
  end: string,
  requirements: OpenDayStaffRequirement[],
  mine = false,
): OpenDayTimeslot {
  return {
    id,
    position: 0,
    startsAt: zonedDateTimeToISO(date, start),
    endsAt: zonedDateTimeToISO(date, end),
    requirements: requirements.map((item) => ({ ...item, timeslotId: id })),
    myAssignment: mine
      ? {
          id: `${id}-mine`,
          openDayId: 'x',
          timeslotId: id,
          requirementId: requirements[0].id,
          personId: 'me',
          displayName: 'Me',
          profileImageUrl: null,
          isCurrentUser: true,
          createdAt: '2026-01-01T00:00:00Z',
        }
      : null,
  };
}

export function openDay(id: string, timeslots: OpenDayTimeslot[], overrides: Partial<OpenDay> = {}): OpenDay {
  return {
    id,
    periodId: 'period-1',
    competencies: [],
    startsAt: timeslots[0].startsAt,
    endsAt: timeslots[timeslots.length - 1].endsAt,
    status: 'scheduled',
    timeslots,
    seriesId: null,
    detachedFromSeriesId: null,
    version: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

export const period = (overrides: Partial<OpenDayPeriod> = {}): OpenDayPeriod => ({
  id: 'period-1',
  name: 'Winter semester',
  startsOn: '2026-10-01',
  endsOn: '2027-01-31',
  signUpDeadline: null,
  status: 'staffing',
  totalOpenDays: 0,
  fullyStaffedCount: 0,
  needsStaffCount: 0,
  openSupervisorPositions: 0,
  cancelledCount: 0,
  myAssignmentCount: 0,
  version: 3,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...overrides,
});

export const supervisorViewer: Viewer = {
  personId: 'me',
  kind: 'supervisor',
  canSignUp: true,
  canAssign: false,
  canManage: false,
  canSeePeople: true,
};
export const managerViewer: Viewer = { ...supervisorViewer, canAssign: true, canManage: true };
