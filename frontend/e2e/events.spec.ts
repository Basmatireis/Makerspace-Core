import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import { defaultPublicBrandingConfiguration } from './branding-fixtures';

const eventId = '0192f6f8-743e-7c77-a349-cd07c3e8c001';
const sessionId = '0192f6f8-743e-7c77-a349-cd07c3e8c002';
const shiftId = '0192f6f8-743e-7c77-a349-cd07c3e8c003';
const openRequirementId = '0192f6f8-743e-7c77-a349-cd07c3e8c004';
const roleRequirementId = '0192f6f8-743e-7c77-a349-cd07c3e8c005';
const taskListId = '0192f6f8-743e-7c77-a349-cd07c3e8c006';
const taskId = '0192f6f8-743e-7c77-a349-cd07c3e8c007';
const assignmentId = '0192f6f8-743e-7c77-a349-cd07c3e8c008';
const personId = '0192f6f8-743e-7c77-a349-cd07c3e8c009';
const accountId = '0192f6f8-743e-7c77-a349-cd07c3e8c010';
const passwordIdentityId = '0192f6f8-743e-7c77-a349-cd07c3e8c011';
const publicId = 'A'.repeat(43);
const timestamp = '2026-10-04T12:00:00Z';

function currentUser(permissions: string[]) {
  const account = {
    id: accountId,
    personId,
    loginEmail: 'ada.login@example.test',
    provisioningSource: 'local',
    firstAuthenticatedAt: timestamp,
    authIdentities: [
      {
        id: passwordIdentityId,
        kind: 'password',
        displayIdentifier: 'ada.login@example.test',
        verifiedAt: timestamp,
        disabledAt: null,
        usable: true,
        createdAt: timestamp,
      },
    ],
    status: 'enabled',
    passwordStatus: 'active',
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return {
    person: {
      id: personId,
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.test',
      phone: null,
      roles: [],
      account,
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 1,
    },
    account,
    permissions,
    authenticationAssurance: 'normal',
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
    laborordnungStatus: {
      mode: 'not_required',
      state: 'not_required',
      actionRequired: false,
      currentVersion: null,
      latestConfirmedVersion: null,
      requestId: null,
    },
  };
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations).toEqual([]);
}

async function expectNoHorizontalOverflow(page: Page) {
  for (const width of [320, 390, 414, 768, 1440]) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
      .toBeLessThanOrEqual(1);
  }
}

const goLive = (overrides: Record<string, unknown> = {}) => ({
  publicPage: { state: 'live', unmet: [] },
  helperSignup: { state: 'open', opensAt: null, unmet: [] },
  shifts: { accepting: 1, total: 1, notPublic: 0 },
  confirmUnmet: [],
  ...overrides,
});

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: eventId,
    name: 'Autumn exhibition',
    internalDescription: 'Supplier arrival and setup notes.',
    location: 'Main workshop',
    ownerPersonId: personId,
    ownerName: 'Ada Lovelace',
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
    taskTotal: 1,
    taskCompleted: 0,
    tasksOverdue: 1,
    filledCount: 1,
    requiredCount: 4,
    openPlaces: 3,
    hasAssignmentHistory: true,
    myShifts: [],
    goLive: goLive(),
    nextDeadline: null,
    nextScheduleAt: '2026-11-02T14:00:00Z',
    version: 4,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

const session = {
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
};
const requirement = (id: string, name: string, required: number, filled: number, mode = 'anyone') => ({
  id,
  eventId,
  shiftId,
  name,
  description: null,
  requiredCount: required,
  filledCount: filled,
  eligibilityMode: mode,
  eligibleRoleIds: [],
  version: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
});
const shift = {
  id: shiftId,
  eventId,
  sessionId,
  name: 'Setup',
  description: 'Prepare the hall.',
  startsAt: '2026-11-02T14:00:00Z',
  endsAt: '2026-11-02T16:00:00Z',
  signupOpensAt: null,
  signupClosesAt: null,
  isPublic: true,
  status: 'open',
  linkedSessionStatus: 'scheduled',
  requirements: [
    requirement(openRequirementId, 'Helper', 3, 1),
    requirement(roleRequirementId, 'Specialist', 1, 0, 'roles'),
  ],
  version: 2,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const task = {
  id: taskId,
  eventId,
  taskListId,
  title: 'Prepare exhibits',
  description: null,
  status: 'open',
  important: true,
  assigneePersonId: null,
  dueAt: '2026-10-01T12:00:00Z',
  completedAt: null,
  completedByAccountId: null,
  sortOrder: 0,
  version: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const helpers = {
  requiredCount: 4,
  filledCount: 1,
  openPlaces: 3,
  helpers: [
    {
      key: 'p1',
      personId,
      displayName: 'Grace Hopper',
      email: 'grace@example.test',
      phone: null,
      sources: ['authenticated_self'],
      conflictOverridden: false,
      shifts: [
        {
          assignmentId,
          shiftId,
          requirementId: openRequirementId,
          shiftName: 'Setup',
          requirementName: 'Helper',
          startsAt: shift.startsAt,
          endsAt: shift.endsAt,
          source: 'authenticated_self',
          conflictOverridden: false,
          version: 1,
        },
      ],
    },
  ],
  unlinkedSignups: [],
  overriddenAssignmentIds: [],
};
const participation = {
  eventId,
  status: 'confirmed',
  canSignup: true,
  canSeeNames: false,
  myAssignments: [],
  sessions: [session],
  shifts: [
    {
      id: shiftId,
      sessionId,
      name: 'Setup',
      description: null,
      startsAt: shift.startsAt,
      endsAt: shift.endsAt,
      status: 'open',
      isPublic: true,
      linkedSessionStatus: 'scheduled',
      signupOpensAt: null,
      signupClosesAt: null,
      positions: [
        {
          id: openRequirementId,
          name: 'Helper',
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
          id: roleRequirementId,
          name: 'Specialist',
          description: null,
          requiredCount: 1,
          filledCount: 0,
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
};
const publicEvent = {
  publicId,
  title: 'Open workshop exhibition',
  description: 'Meet the makers.',
  location: 'Main workshop',
  status: 'confirmed',
  timeZone: 'Europe/Vienna',
  publicSignupEnabled: true,
  hasBanner: false,
  sessions: [
    {
      id: sessionId,
      name: 'Exhibition',
      location: 'Hall',
      description: 'Public programme.',
      startsAt: session.startsAt,
      endsAt: session.endsAt,
    },
  ],
  shifts: [
    {
      id: shiftId,
      sessionId: null,
      name: 'Setup',
      description: 'Prepare the hall.',
      startsAt: shift.startsAt,
      endsAt: shift.endsAt,
      requirements: [
        {
          id: openRequirementId,
          name: 'Helper',
          description: null,
          requiredCount: 3,
          filledCount: 1,
          remainingCount: 2,
          availability: 'available',
        },
        {
          id: roleRequirementId,
          name: 'Specialist',
          description: null,
          requiredCount: 1,
          filledCount: 0,
          remainingCount: 1,
          availability: 'authenticated_only',
        },
      ],
    },
  ],
  files: [
    {
      id: '0192f6f8-743e-7c77-a349-cd07c3e8c012',
      originalFilename: 'visitor-guide.pdf',
      description: null,
      contentType: 'application/pdf',
      sizeBytes: 1024,
    },
  ],
};

type Mock = { permissions?: string[]; signedOut?: boolean; event?: Record<string, unknown>; onJoin?: () => void };

async function mockApi(page: Page, options: Mock = {}) {
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path === '/api/v1/auth/activity' && method === 'POST')
      return json(route, {
        idleExpiresAt: '2099-01-01T01:00:00Z',
        absoluteExpiresAt: '2099-01-02T00:00:00Z',
        postSessionDestination: 'login',
      });
    if (path === '/api/v1/public/config') return json(route, defaultPublicBrandingConfiguration());
    if (path === '/api/v1/auth/oidc/providers') return json(route, { items: [] });
    if (path === '/api/v1/auth/me')
      return options.signedOut
        ? json(route, { code: 'unauthenticated', message: 'Authentication required', requestId: 'r' }, 401)
        : json(route, currentUser(options.permissions ?? []));
    if (path === '/api/v1/events')
      return json(route, { items: [event(options.event)], page: 1, pageSize: 25, total: 1 });
    if (path === `/api/v1/events/${eventId}`) return json(route, event(options.event));
    if (path === `/api/v1/events/${eventId}/participation`) return json(route, participation);
    if (
      path === `/api/v1/events/${eventId}/shifts/${shiftId}/requirements/${openRequirementId}/join` &&
      method === 'POST'
    ) {
      options.onJoin?.();
      return json(route, { assignmentId, shiftId, requirementId: openRequirementId }, 201);
    }
    if (path === `/api/v1/events/${eventId}/sessions`) return json(route, { items: [session] });
    if (path === `/api/v1/events/${eventId}/shifts`) return json(route, { items: [shift] });
    if (path === `/api/v1/events/${eventId}/helpers`) return json(route, helpers);
    if (path === `/api/v1/events/${eventId}/task-lists`)
      return json(route, {
        items: [
          {
            id: taskListId,
            eventId,
            name: 'Preparation',
            description: null,
            sortOrder: 0,
            version: 1,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
      });
    if (path === `/api/v1/events/${eventId}/tasks`) return json(route, { items: [task] });
    if (path === `/api/v1/events/${eventId}/files`) return json(route, { items: [] });
    if (path === '/api/v1/event-eligibility-roles') return json(route, { items: [] });
    if (path === '/api/v1/event-people') return json(route, { items: [] });
    if (path === `/api/v1/public/events/${publicId}`) return json(route, publicEvent);
    if (path === `/api/v1/events/public/${publicId}/assignments/me`) return json(route, { items: [] });
    throw new Error(`Unexpected API request: ${method} ${path}`);
  });
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

test('lists events for organizers and opens them in edit mode', async ({ page }) => {
  await mockApi(page, { permissions: ['events.read', 'events.manage'] });
  await page.goto('/events');
  await expect(page.getByRole('heading', { name: 'Events' })).toBeVisible();
  const toolbar = page.getByLabel('Events toolbar');
  await expect(toolbar.getByRole('searchbox', { name: 'Search events' })).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Filters' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Drafts' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Places filled' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Autumn exhibition' })).toHaveAttribute(
    'href',
    `/events/${eventId}?mode=edit`,
  );
  await expectAccessible(page);
  await expectNoHorizontalOverflow(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('link', { name: 'Autumn exhibition' }).last()).toBeVisible();
  await expectAccessible(page);
});

test('walks through the edit mode tabs at desktop and narrow widths', async ({ page }) => {
  await mockApi(page, { permissions: ['events.read', 'events.manage', 'events.staffing.manage', 'events.assign'] });
  await page.goto(`/events/${eventId}?mode=edit`);
  await expect(page.getByRole('heading', { name: 'Autumn exhibition' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Next steps' })).toBeVisible();
  await expect(page.getByText('3 places still open')).toBeVisible();
  await expectAccessible(page);

  await page.getByRole('tab', { name: 'Programme' }).click();
  await expect(page.getByText('Exhibition', { exact: true })).toBeVisible();
  await expect(page.getByText('Setup').first()).toBeVisible();
  await expectAccessible(page);

  await page.getByRole('tab', { name: 'Helpers' }).click();
  await expect(page.getByText('Grace Hopper').first()).toBeVisible();
  await expect(page.getByText('Open place').first()).toBeVisible();
  await expectAccessible(page);

  await page.getByRole('tab', { name: 'Tasks' }).click();
  await expect(page.getByText('Prepare exhibits', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Overdue/).first()).toBeVisible();
  await expectAccessible(page);

  await page.getByRole('tab', { name: 'Public page' }).click();
  await expect(page.getByRole('heading', { name: 'Live preview' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Help us' })).toBeVisible();
  await expectAccessible(page);
  await expectNoHorizontalOverflow(page);
});

test('opens the Go live panel with the server checklist', async ({ page }) => {
  await mockApi(page, {
    permissions: ['events.read', 'events.manage'],
    event: {
      status: 'draft',
      isPublic: false,
      ownerPersonId: null,
      ownerName: null,
      goLive: goLive({
        publicPage: { state: 'off', unmet: ['owner_missing'] },
        helperSignup: {
          state: 'off',
          opensAt: null,
          unmet: ['public_page_off', 'signup_disabled', 'event_not_confirmed'],
        },
        confirmUnmet: ['owner_missing'],
      }),
    },
  });
  await page.goto(`/events/${eventId}?mode=edit`);
  await page.getByRole('button', { name: 'Go live' }).click();
  await expect(page.getByRole('heading', { name: 'Go live' })).toBeVisible();
  await expect(page.getByText('An owner is assigned')).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Public page' })).toBeDisabled();
  await expectAccessible(page);
});

test('lets a member join a place from the participant view', async ({ page }) => {
  let joined = false;
  await mockApi(page, { permissions: ['events.read', 'events.signup'], onJoin: () => (joined = true) });
  await page.goto(`/events/${eventId}`);
  await expect(page.getByRole('heading', { name: 'Autumn exhibition' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Members with role First aider only' })).toBeVisible();
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Join' }).click();
  await expect.poll(() => joined).toBe(true);
  await expectNoHorizontalOverflow(page);
});

test('shows the public page without the app shell and signs a visitor up', async ({ page }) => {
  await mockApi(page, { signedOut: true });
  await page.route(`**/api/v1/public/events/${publicId}/signups`, (route) =>
    json(
      route,
      {
        assignment: {
          id: assignmentId,
          publicId,
          shiftId,
          requirementId: openRequirementId,
          firstName: 'Grace',
          lastName: 'Hopper',
          email: 'grace@example.test',
          phone: null,
          source: 'public_signup',
          status: 'active',
          cancelledAt: null,
          version: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        managementUrl: '/events/signup/manage#token=one-time-secret',
      },
      201,
    ),
  );
  await page.goto(`/events/public/${publicId}`);
  await expect(page.getByRole('heading', { name: 'Open workshop exhibition' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Help us' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open navigation' })).toHaveCount(0);
  await expect(page.getByText('Members only')).toBeVisible();
  await expectAccessible(page);
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: 'Sign up' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('First name').fill('Grace');
  await dialog.getByLabel('Last name').fill('Hopper');
  await dialog.getByLabel('Email').fill('grace@example.test');
  await expectAccessible(page);
  await dialog.getByRole('button', { name: 'Confirm signup' }).click();
  await expect(dialog.getByLabel('One-time management link')).toHaveValue(/#token=one-time-secret$/);
  await expectAccessible(page);
});

test('captures desktop and narrow screenshots for review', async ({ page }) => {
  test.skip(!process.env.EVENT_SCREENSHOTS, 'only for manual visual review');
  await mockApi(page, {
    permissions: ['events.read', 'events.manage', 'events.staffing.manage', 'events.assign', 'events.signup'],
  });
  for (const [name, width, height] of [
    ['desktop', 1440, 1000],
    ['mobile', 375, 812],
  ] as const) {
    await page.setViewportSize({ width, height });
    for (const [label, url] of [
      ['list', '/events'],
      ['participant', `/events/${eventId}`],
      ['overview', `/events/${eventId}?mode=edit`],
      ['programme', `/events/${eventId}?mode=edit&tab=programme`],
      ['helpers', `/events/${eventId}?mode=edit&tab=helpers`],
      ['tasks', `/events/${eventId}?mode=edit&tab=tasks`],
      ['public-tab', `/events/${eventId}?mode=edit&tab=public`],
      ['public', `/events/public/${publicId}`],
    ]) {
      await page.goto(url);
      await page.waitForLoadState('networkidle');
      await page.screenshot({ path: `${process.env.EVENT_SCREENSHOTS}/${name}-${label}.png`, fullPage: true });
    }
  }
});
