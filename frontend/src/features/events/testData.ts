import type { Event, EventHelpers, EventParticipation, EventSession, EventShift } from '../../api/generated/models';

// Shared fixtures for the event screens' tests: one confirmed event with a session and a shift.
export const eventId = '0192f6f8-743e-7c77-a349-cd07c3e8b010';
export const sessionId = '0192f6f8-743e-7c77-a349-cd07c3e8b011';
export const shiftId = '0192f6f8-743e-7c77-a349-cd07c3e8b012';
export const positionId = '0192f6f8-743e-7c77-a349-cd07c3e8b013';
export const secondPositionId = '0192f6f8-743e-7c77-a349-cd07c3e8b014';
export const assignmentId = '0192f6f8-743e-7c77-a349-cd07c3e8b015';
export const publicId = 'A'.repeat(43);
export const timestamp = '2026-10-04T12:00:00Z';

export function eventFixture(overrides: Partial<Event> = {}): Event {
  return {
    id: eventId,
    name: 'Autumn exhibition',
    internalDescription: 'Internal plan',
    location: 'Main workshop',
    ownerPersonId: '0192f6f8-743e-7c77-a349-cd07c3e8b020',
    ownerName: 'Grace Hopper',
    status: 'confirmed',
    publicTitle: 'Open workshop exhibition',
    publicDescription: 'Meet the makers.',
    publicLocation: 'Main workshop',
    publicId,
    isPublic: true,
    publicSignupEnabled: true,
    hasBanner: false,
    closedAt: null,
    rangeStartsAt: '2026-11-02T16:00:00Z',
    rangeEndsAt: '2026-11-02T22:00:00Z',
    taskTotal: 4,
    taskCompleted: 2,
    tasksOverdue: 1,
    filledCount: 2,
    requiredCount: 5,
    openPlaces: 3,
    hasAssignmentHistory: true,
    myShifts: [],
    goLive: {
      publicPage: { state: 'live', unmet: [] },
      helperSignup: { state: 'open', opensAt: null, unmet: [] },
      shifts: { accepting: 1, total: 1, notPublic: 0 },
      confirmUnmet: [],
    },
    nextDeadline: null,
    nextScheduleAt: '2026-11-02T16:00:00Z',
    version: 3,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

export function sessionFixture(overrides: Partial<EventSession> = {}): EventSession {
  return {
    id: sessionId,
    eventId,
    name: 'Exhibition',
    location: 'Hall',
    description: null,
    startsAt: '2026-11-02T16:00:00Z',
    endsAt: '2026-11-02T22:00:00Z',
    isPublic: true,
    status: 'scheduled',
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

export function shiftFixture(overrides: Partial<EventShift> = {}): EventShift {
  return {
    id: shiftId,
    eventId,
    sessionId,
    name: 'Bar',
    description: null,
    startsAt: '2026-11-02T16:00:00Z',
    endsAt: '2026-11-02T20:00:00Z',
    signupOpensAt: null,
    signupClosesAt: null,
    isPublic: true,
    status: 'open',
    linkedSessionStatus: 'scheduled',
    requirements: [
      {
        id: positionId,
        eventId,
        shiftId,
        name: 'Bartender',
        description: null,
        requiredCount: 3,
        filledCount: 1,
        eligibilityMode: 'anyone',
        eligibleRoleIds: [],
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: secondPositionId,
        eventId,
        shiftId,
        name: 'First aid',
        description: null,
        requiredCount: 2,
        filledCount: 1,
        eligibilityMode: 'roles',
        eligibleRoleIds: ['0192f6f8-743e-7c77-a349-cd07c3e8b030'],
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    version: 2,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

export function participationFixture(overrides: Partial<EventParticipation> = {}): EventParticipation {
  return {
    eventId,
    status: 'confirmed',
    canSignup: true,
    canSeeNames: false,
    myAssignments: [],
    sessions: [sessionFixture()],
    shifts: [
      {
        id: shiftId,
        sessionId,
        name: 'Bar',
        description: null,
        startsAt: '2026-11-02T16:00:00Z',
        endsAt: '2026-11-02T20:00:00Z',
        status: 'open',
        isPublic: true,
        linkedSessionStatus: 'scheduled',
        signupOpensAt: null,
        signupClosesAt: null,
        positions: [
          {
            id: positionId,
            name: 'Bartender',
            description: null,
            requiredCount: 3,
            filledCount: 1,
            myAssignmentId: null,
            joinable: true,
            reason: null,
            opensAt: null,
            roleNames: [],
            helpers: null,
          },
          {
            id: secondPositionId,
            name: 'First aid',
            description: null,
            requiredCount: 2,
            filledCount: 1,
            myAssignmentId: null,
            joinable: false,
            reason: 'roles_only',
            opensAt: null,
            roleNames: ['First aider'],
            helpers: null,
          },
        ],
      },
    ],
    ...overrides,
  };
}

export function helpersFixture(overrides: Partial<EventHelpers> = {}): EventHelpers {
  return {
    requiredCount: 5,
    filledCount: 2,
    openPlaces: 3,
    helpers: [
      {
        key: 'person-1',
        personId: '0192f6f8-743e-7c77-a349-cd07c3e8b040',
        displayName: 'Alan Turing',
        email: 'alan@example.test',
        phone: null,
        sources: ['authenticated_self'],
        conflictOverridden: false,
        shifts: [
          {
            assignmentId,
            shiftId,
            requirementId: positionId,
            shiftName: 'Bar',
            requirementName: 'Bartender',
            startsAt: '2026-11-02T16:00:00Z',
            endsAt: '2026-11-02T20:00:00Z',
            source: 'authenticated_self',
            conflictOverridden: false,
            version: 1,
          },
        ],
      },
    ],
    unlinkedSignups: [],
    overriddenAssignmentIds: [],
    ...overrides,
  };
}
