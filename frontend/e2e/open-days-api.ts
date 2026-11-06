import { expect, type Page, type Route } from '@playwright/test';
import { defaultPublicBrandingConfiguration } from './branding-fixtures';
import { welcomeTourSeen } from './guide-progress';

/**
 * A mocked Open Days API for the browser tests: one world (period, open days, series, people) that the page reads and
 * changes through page.route, so a join, a leave or a schedule save is visible in the next response. Every request is
 * recorded; anything the world does not know answers 501 and fails the test through `unexpected`.
 */

export const ids = {
  person: '0192f6f8-743e-7c77-a349-cd07c3e8b001',
  account: '0192f6f8-743e-7c77-a349-cd07c3e8b002',
  period: '0192f6f8-743e-7c77-a349-cd07c3e8b003',
  dayA: '0192f6f8-743e-7c77-a349-cd07c3e8b004',
  dayB: '0192f6f8-743e-7c77-a349-cd07c3e8b014',
  dayC: '0192f6f8-743e-7c77-a349-cd07c3e8b024',
  role: '0192f6f8-743e-7c77-a349-cd07c3e8b007',
  password: '0192f6f8-743e-7c77-a349-cd07c3e8b009',
  grace: '0192f6f8-743e-7c77-a349-cd07c3e8b0a1',
  series: '0192f6f8-743e-7c77-a349-cd07c3e8b0b1',
  breakId: '0192f6f8-743e-7c77-a349-cd07c3e8b0c1',
};
export const timestamp = '2026-09-14T10:00:00Z';
/** A Monday, shortly before the first open day. */
export const clock = new Date('2026-09-28T10:00:00Z');

export type Requirement = {
  id: string;
  timeslotId: string;
  kind: 'supervisor' | 'trainee';
  requiredCount: number;
  assignedCount: number;
  eligible: boolean;
  canJoin: boolean;
  eligibleRoleIds?: string[];
  assignments?: Assignment[];
};
export type Assignment = {
  id: string;
  openDayId: string;
  timeslotId: string;
  requirementId: string;
  personId: string;
  displayName: string;
  profileImageUrl: string | null;
  isCurrentUser: boolean;
  createdAt: string;
};
export type Timeslot = {
  id: string;
  position: number;
  startsAt: string;
  endsAt: string;
  requirements: Requirement[];
  myAssignment: Assignment | null;
};
export type Day = {
  id: string;
  periodId: string;
  competencies: unknown[];
  startsAt: string;
  endsAt: string;
  internalNote?: string | null;
  status: 'scheduled' | 'cancelled';
  timeslots: Timeslot[];
  seriesId: string | null;
  detachedFromSeriesId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

/**
 * An open day with timeslots given as `[startsAtUtc, endsAtUtc]`; every timeslot has `sup` supervisor and `tr` trainee
 * places. Ids derive from the day id so tests can address them: `<day>-s<slot>-sup` and `-tr`.
 */
export function makeDay(
  id: string,
  slots: Array<[string, string]>,
  options: { sup?: number; tr?: number; seriesId?: string | null; note?: string; roleIds?: string[] } = {},
): Day {
  const { sup = 2, tr = 1 } = options;
  const timeslots = slots.map(([startsAt, endsAt], position): Timeslot => {
    const timeslotId = `${id}-s${position}`;
    const requirement = (kind: 'supervisor' | 'trainee', required: number): Requirement => ({
      id: `${timeslotId}-${kind === 'supervisor' ? 'sup' : 'tr'}`,
      timeslotId,
      kind,
      requiredCount: required,
      assignedCount: 0,
      eligible: false,
      canJoin: false,
      eligibleRoleIds: options.roleIds ?? [],
      assignments: [],
    });
    return {
      id: timeslotId,
      position,
      startsAt,
      endsAt,
      requirements: [requirement('supervisor', sup), requirement('trainee', tr)],
      myAssignment: null,
    };
  });
  return {
    id,
    periodId: ids.period,
    competencies: [],
    startsAt: slots[0][0],
    endsAt: slots[slots.length - 1][1],
    internalNote: options.note ?? null,
    status: 'scheduled',
    timeslots,
    seriesId: options.seriesId ?? null,
    detachedFromSeriesId: null,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export const person = (id: string, displayName: string) => ({ personId: id, displayName });

/** Friday 2 Oct 2026, 16:00-19:00 Vienna. */
export const fridayA = (): Day =>
  makeDay(ids.dayA, [['2026-10-02T14:00:00Z', '2026-10-02T17:00:00Z']], { note: 'Prep' });
/** Friday 9 Oct 2026 with two timeslots, 16:00-18:00 and 18:00-20:00 Vienna. */
export const fridayB = (): Day =>
  makeDay(
    ids.dayB,
    [
      ['2026-10-09T14:00:00Z', '2026-10-09T16:00:00Z'],
      ['2026-10-09T16:00:00Z', '2026-10-09T18:00:00Z'],
    ],
    { sup: 1, tr: 1 },
  );

export function periodOf(status: 'draft' | 'staffing' | 'published', days: Day[]) {
  const active = days.filter((day) => day.status === 'scheduled');
  const staffed = (day: Day) =>
    day.timeslots.every((slot) => slot.requirements.every((item) => item.assignedCount >= item.requiredCount));
  return {
    id: ids.period,
    name: 'Winter Semester 2026/27',
    startsOn: '2026-10-01',
    endsOn: '2027-01-31',
    signUpDeadline: null,
    status,
    totalOpenDays: days.length,
    fullyStaffedCount: active.filter(staffed).length,
    needsStaffCount: active.filter((day) => !staffed(day)).length,
    openSupervisorPositions: active.reduce(
      (sum, day) =>
        sum +
        day.timeslots.reduce((n, slot) => {
          const sup = slot.requirements.find((item) => item.kind === 'supervisor');
          return n + Math.max(0, (sup?.requiredCount ?? 0) - (sup?.assignedCount ?? 0));
        }, 0),
      0,
    ),
    cancelledCount: days.length - active.length,
    myAssignmentCount: active.filter((day) => day.timeslots.some((slot) => slot.myAssignment)).length,
    version: 3,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export type Membership = 'supervisor' | 'trainee' | 'visitor';

export function currentUser(permissions: string[], membership: Membership = 'supervisor', withImage = false) {
  const roleIds = { supervisor: '51', trainee: '52', visitor: '53' };
  const roles = [
    { id: `0192f6f8-743e-7c77-a349-cd07c3e8b0${roleIds[membership]}`, name: membership, systemKey: membership },
  ];
  const identity = {
    id: ids.password,
    kind: 'password',
    displayIdentifier: 'ada.login@example.test',
    verifiedAt: timestamp,
    disabledAt: null,
    usable: true,
    createdAt: timestamp,
  };
  const account = {
    id: ids.account,
    personId: ids.person,
    loginEmail: 'ada.login@example.test',
    provisioningSource: 'local',
    firstAuthenticatedAt: timestamp,
    authIdentities: [identity],
    status: 'enabled',
    passwordStatus: 'active',
    createdAt: timestamp,
    updatedAt: timestamp,
    version: 1,
  };
  return {
    person: {
      id: ids.person,
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.test',
      phone: null,
      roles,
      account,
      ...(withImage
        ? {
            profileImage: {
              fileId: '0192f6f8-743e-7c77-a349-cd07c3e8b0f1',
              source: 'self_upload',
              downloadUrl: `/api/v1/people/${ids.person}/profile-image`,
            },
          }
        : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 1,
    },
    account,
    permissions,
    authenticationAssurance: 'normal',
    authentication: {
      method: 'password',
      assurance: 'normal',
      authenticatedAt: '2026-01-01T00:00:00Z',
      authenticatedAssurance: 'normal',
      mfaEnrolled: false,
      mfaRequired: false,
      mfaSetupRequired: false,
      secondFactorMethods: [],
      reauthenticationRequired: [],
    },
    managedDevice: null,
    session: {
      idleExpiresAt: '2099-01-01T01:00:00Z',
      absoluteExpiresAt: '2099-01-02T00:00:00Z',
      postSessionDestination: 'login',
    },
    delegablePermissionGrants: permissions.map((permissionId) => ({
      permissionId,
      scope: 'everywhere',
      deviceTypeIds: [],
      minimumAssurance: 'low',
    })),
    notificationConsentRequired: false,
    laborordnungStatus: {
      mode: 'not_required',
      state: 'not_required',
      actionRequired: false,
      currentVersion: null,
      latestConfirmedVersion: null,
      latestConfirmedAt: null,
    },
  };
}

export type Recorded = { method: string; path: string; search: string; body: unknown };

export type World = {
  permissions: string[];
  membership: Membership;
  status: 'draft' | 'staffing' | 'published';
  days: Day[];
  series: unknown[];
  periods?: unknown[];
  breaks: unknown[];
  entries: unknown[];
  /** Eligible people the assign panel offers. */
  eligible: Array<{ personId: string; displayName: string }>;
  dashboardRows?: unknown[];
  /** The caller's calendar subscription; created and revoked through the mocked endpoints. */
  feed: { active: boolean; createdAt: string | null; lastUsedAt: string | null };
  requests: Recorded[];
  unexpected: string[];
  /** Whether the signed-in person has a profile image. */
  profileImage?: boolean;
  /** The body a schedule save answered with, for follow-up assertions. */
  onSchedule?: (body: Record<string, unknown>, world: World) => void;
};

export function newWorld(overrides: Partial<World> = {}): World {
  return {
    permissions: ['open_days.read', 'open_days.signup'],
    membership: 'trainee',
    status: 'staffing',
    days: [fridayA(), fridayB()],
    series: [],
    breaks: [],
    entries: [],
    eligible: [person(ids.grace, 'Grace Hopper')],
    feed: { active: false, createdAt: null, lastUsedAt: null },
    requests: [],
    unexpected: [],
    ...overrides,
  };
}

const can = (world: World, permission: string) => world.permissions.includes(permission);

/** What the signed-in person sees of one place: eligibility from their membership, joinability from the timeslot. */
function viewOfDay(world: World, day: Day): Day {
  const seesNames = can(world, 'open_days.read_assignments') || can(world, 'open_days.manage');
  const manager = can(world, 'open_days.manage');
  const joinable = can(world, 'open_days.signup') && world.status !== 'draft' && day.status === 'scheduled';
  return {
    ...day,
    internalNote: manager ? day.internalNote : undefined,
    timeslots: day.timeslots.map((slot) => {
      const mine = slot.requirements.flatMap((item) => item.assignments ?? []).find((a) => a.isCurrentUser) ?? null;
      return {
        ...slot,
        myAssignment: mine,
        requirements: slot.requirements.map((item) => {
          const assignments = item.assignments ?? [];
          const eligible = joinable && item.kind === world.membership;
          return {
            ...item,
            assignedCount: assignments.length,
            eligible,
            canJoin: eligible && !mine && assignments.length < item.requiredCount,
            eligibleRoleIds: manager ? item.eligibleRoleIds : undefined,
            assignments: seesNames ? assignments : undefined,
          };
        }),
      };
    }),
  };
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

const calendarContext = (world: World) => ({
  timeZone: 'Europe/Vienna',
  countryCode: 'AT',
  subdivisionCode: 'AT-6',
  languageCode: 'en',
  entries: world.entries,
  academicBreaks: world.breaks,
});

/** Wires the world to the page. The clock is fixed so "upcoming" and "within 14 days" do not depend on today. */
export async function installOpenDaysApi(page: Page, world: World) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.setFixedTime(clock);
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = request.method();
    const body = method === 'GET' || method === 'DELETE' ? undefined : request.postDataJSON();
    world.requests.push({ method, path, search: url.search, body });
    const period = () => periodOf(world.status, world.days);
    const schedule = () => ({
      period: period(),
      items: world.days.map((day) => viewOfDay(world, day)),
      timeZone: 'Europe/Vienna',
    });

    if (path === '/notifications/unread-count') return json(route, { unreadCount: 0, fresh: [], pinned: [] });
    if (path === '/auth/activity') {
      return json(route, {
        idleExpiresAt: '2099-01-01T01:00:00Z',
        absoluteExpiresAt: '2099-01-02T00:00:00Z',
        postSessionDestination: 'login',
      });
    }
    if (path === '/auth/oidc/providers') return json(route, { items: [] });
    if (path === '/public/config') return json(route, defaultPublicBrandingConfiguration());
    if (path === '/auth/me') return json(route, currentUser(world.permissions, world.membership, world.profileImage));
    if (
      (path === `/people/${ids.person}/profile-image` && world.profileImage) ||
      /^\/open-days\/[^/]+\/assignments\/[^/]+-grace\/profile-image$/.test(path)
    ) {
      // A 1×1 GIF is enough for the browser to load the image.
      return route.fulfill({
        status: 200,
        contentType: 'image/gif',
        body: Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64'),
      });
    }
    if (path === '/me/guides') return json(route, welcomeTourSeen);
    if (path === '/me/dashboard') {
      return json(route, { person: { firstName: 'Ada', memberSince: '2025-09-01' }, comingUp: [] });
    }
    if (path === '/open-day-periods' && method === 'GET') return json(route, { items: world.periods ?? [period()] });
    if (path === '/open-day-academic-breaks') return json(route, { items: world.breaks });
    if (path === '/open-day-eligibility-roles') return json(route, { items: [{ id: ids.role, name: 'Laser team' }] });
    if (path === `/open-day-periods/${ids.period}/open-days`) return json(route, schedule());
    if (path === `/open-day-periods/${ids.period}/calendar-context`) return json(route, calendarContext(world));
    if (path === `/open-day-periods/${ids.period}/series`) return json(route, { items: world.series });
    if (path === '/me/calendar-feed') {
      if (method === 'POST') {
        world.feed = { active: true, createdAt: timestamp, lastUsedAt: null };
        return json(route, { url: '/api/v1/calendar/secret-token.ics', createdAt: timestamp }, 201);
      }
      if (method === 'DELETE') {
        world.feed = { active: false, createdAt: null, lastUsedAt: null };
        return route.fulfill({ status: 204 });
      }
      return json(route, world.feed);
    }
    if (path === '/supervisor-dashboard') {
      return json(route, {
        semester: {
          periodId: ids.period,
          name: 'Winter Semester 2026/27',
          startsOn: '2026-10-01',
          endsOn: '2027-01-31',
          signUpBy: '2027-01-31',
        },
        rules: {
          supervisorMinimum: 2,
          traineeMinimum: 2,
          traineeReadyAfter: 3,
          warningWindowDays: 14,
          countBy: 'timeslot',
          defaultDeadline: 'period_end',
          exceptions: [],
          version: 1,
          updatedAt: timestamp,
        },
        supervisors: world.dashboardRows ?? [],
        totals: { supervisors: 0, profileImagesComplete: 0, laborordnungCurrent: 0, laborordnungOutdated: 0 },
      });
    }

    const requirementPeople = path.match(/^\/open-day-staff-requirements\/([^/]+)\/eligible-people$/);
    if (requirementPeople) return json(route, { items: world.eligible });

    const day = (id: string) => world.days.find((item) => item.id === id);
    const place = (openDay: Day, requirementId: string) => {
      for (const slot of openDay.timeslots)
        for (const item of slot.requirements) if (item.id === requirementId) return { slot, item };
      return undefined;
    };
    const assignIn = (openDay: Day, requirementId: string, who: { id: string; name: string; me: boolean }) => {
      const found = place(openDay, requirementId);
      if (!found) return undefined;
      const assignment: Assignment = {
        id: `${requirementId}-a${(found.item.assignments ?? []).length + 1}-${who.me ? 'me' : 'other'}`,
        openDayId: openDay.id,
        timeslotId: found.slot.id,
        requirementId,
        personId: who.id,
        displayName: who.name,
        // Grace has a profile image; everyone else falls back to initials.
        profileImageUrl:
          who.id === ids.grace
            ? `/api/v1/open-days/${openDay.id}/assignments/${requirementId}-grace/profile-image`
            : null,
        isCurrentUser: who.me,
        createdAt: timestamp,
      };
      found.item.assignments = [...(found.item.assignments ?? []), assignment];
      return assignment;
    };

    const single = path.match(/^\/open-days\/([^/]+)$/);
    if (single && method === 'GET') {
      const found = day(single[1]);
      return found ? json(route, viewOfDay(world, found)) : json(route, { code: 'not_found', message: 'No.' }, 404);
    }
    const mine = path.match(/^\/open-days\/([^/]+)\/assignments\/me$/);
    if (mine) {
      const found = day(mine[1]);
      if (!found) return json(route, { code: 'not_found', message: 'No.' }, 404);
      if (method === 'PUT') {
        const assignment = assignIn(found, (body as { requirementId: string }).requirementId, {
          id: ids.person,
          name: 'Ada Lovelace',
          me: true,
        });
        return json(route, assignment);
      }
      if (method === 'DELETE') {
        const timeslotId = url.searchParams.get('timeslotId');
        for (const slot of found.timeslots)
          for (const item of slot.requirements)
            if (slot.id === timeslotId) item.assignments = (item.assignments ?? []).filter((a) => !a.isCurrentUser);
        return route.fulfill({ status: 204 });
      }
    }
    const assignments = path.match(/^\/open-days\/([^/]+)\/assignments$/);
    if (assignments && method === 'POST') {
      const found = day(assignments[1]);
      const request = body as { requirementId: string; personId: string };
      const who = world.eligible.find((item) => item.personId === request.personId);
      const assignment =
        found && who
          ? assignIn(found, request.requirementId, { id: who.personId, name: who.displayName, me: false })
          : undefined;
      return json(route, assignment, 201);
    }
    const removal = path.match(/^\/open-days\/([^/]+)\/assignments\/([^/]+)$/);
    if (removal && method === 'DELETE') {
      const found = day(removal[1]);
      for (const slot of found?.timeslots ?? [])
        for (const item of slot.requirements)
          item.assignments = (item.assignments ?? []).filter((a) => a.id !== removal[2]);
      return route.fulfill({ status: 204 });
    }
    if (path === `/open-day-periods/${ids.period}/schedule` && method === 'PUT') {
      world.onSchedule?.(body as Record<string, unknown>, world);
      return json(route, schedule());
    }
    if (path === '/open-day-periods' && method === 'POST') {
      return json(route, { ...period(), name: (body as { name: string }).name, status: 'draft' }, 201);
    }

    world.unexpected.push(`${method} ${path}`);
    return json(route, { code: 'unexpected_request', message: `${method} ${path}` }, 501);
  });
  return world;
}

/** The recorded requests with a method and path (path may be a prefix check via startsWith). */
export const sent = (world: World, method: string, path: string) =>
  world.requests.filter((request) => request.method === method && request.path === path);

export function expectNoUnexpectedRequests(world: World) {
  expect(world.unexpected).toEqual([]);
}
