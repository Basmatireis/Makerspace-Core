import { describe, expect, it } from 'vitest';
import type { OpenDay, OpenDayRequirementKind } from '../../api/generated/models';
import { filterOpenDays } from './openDayFilters';

const periodId = '0192f6f8-743e-7c77-a349-cd07c3e8a911';
const personId = '0192f6f8-743e-7c77-a349-cd07c3e8a901';

function requirement(id: string, kind: OpenDayRequirementKind, assignedCount: number, requiredCount: number) {
  return { id, kind, assignedCount, requiredCount };
}

function openDay(id: string, overrides: Partial<OpenDay> = {}): OpenDay {
  return {
    id,
    periodId,
    startsAt: '2026-10-01T08:00:00Z',
    endsAt: '2026-10-01T11:00:00Z',
    status: 'scheduled',
    requirements: [
      requirement(`${id.slice(0, -1)}1`, 'supervisor', 2, 2),
      requirement(`${id.slice(0, -1)}2`, 'trainee', 1, 1),
    ],
    version: 1,
    createdAt: '2026-09-01T10:00:00Z',
    updatedAt: '2026-09-01T10:00:00Z',
    ...overrides,
  };
}

const supervisorVacancy = openDay('0192f6f8-743e-7c77-a349-cd07c3e8a921', {
  requirements: [
    requirement('0192f6f8-743e-7c77-a349-cd07c3e8a931', 'supervisor', 1, 2),
    requirement('0192f6f8-743e-7c77-a349-cd07c3e8a932', 'trainee', 1, 1),
  ],
});
const traineeVacancy = openDay('0192f6f8-743e-7c77-a349-cd07c3e8a922', {
  requirements: [
    requirement('0192f6f8-743e-7c77-a349-cd07c3e8a933', 'supervisor', 2, 2),
    requirement('0192f6f8-743e-7c77-a349-cd07c3e8a934', 'trainee', 0, 1),
  ],
});
const mine = openDay('0192f6f8-743e-7c77-a349-cd07c3e8a923', {
  myAssignment: {
    id: '0192f6f8-743e-7c77-a349-cd07c3e8a941',
    openDayId: '0192f6f8-743e-7c77-a349-cd07c3e8a923',
    requirementId: '0192f6f8-743e-7c77-a349-cd07c3e8a923',
    personId,
    displayName: 'Ada Lovelace',
    isCurrentUser: true,
    createdAt: '2026-09-02T10:00:00Z',
  },
});
const cancelledMine = openDay('0192f6f8-743e-7c77-a349-cd07c3e8a924', {
  status: 'cancelled',
  requirements: [
    requirement('0192f6f8-743e-7c77-a349-cd07c3e8a935', 'supervisor', 0, 2),
    requirement('0192f6f8-743e-7c77-a349-cd07c3e8a936', 'trainee', 1, 1),
  ],
  myAssignment: {
    id: '0192f6f8-743e-7c77-a349-cd07c3e8a942',
    openDayId: '0192f6f8-743e-7c77-a349-cd07c3e8a924',
    requirementId: '0192f6f8-743e-7c77-a349-cd07c3e8a935',
    personId,
    displayName: 'Ada Lovelace',
    isCurrentUser: true,
    createdAt: '2026-09-02T10:00:00Z',
  },
});

const days = [supervisorVacancy, traineeVacancy, mine, cancelledMine];

describe('Open Day filters', () => {
  it('returns every visible Open Day for All', () => {
    expect(filterOpenDays(days, 'all')).toEqual(days);
  });

  it('includes only scheduled Open Days with a supervisor vacancy for Needs staff', () => {
    expect(filterOpenDays(days, 'needs-staff')).toEqual([supervisorVacancy]);
  });

  it('includes current assignments, including retained assignments on cancelled Open Days', () => {
    expect(filterOpenDays(days, 'mine')).toEqual([mine, cancelledMine]);
  });
});
