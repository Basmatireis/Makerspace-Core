import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test';

const personId = '0192f6f8-743e-7c77-a349-cd07c3e8b001';
const accountId = '0192f6f8-743e-7c77-a349-cd07c3e8b002';
const periodId = '0192f6f8-743e-7c77-a349-cd07c3e8b003';
const openDayId = '0192f6f8-743e-7c77-a349-cd07c3e8b004';
const supervisorRequirementId = '0192f6f8-743e-7c77-a349-cd07c3e8b005';
const traineeRequirementId = '0192f6f8-743e-7c77-a349-cd07c3e8b006';
const roleId = '0192f6f8-743e-7c77-a349-cd07c3e8b007';
const assignmentId = '0192f6f8-743e-7c77-a349-cd07c3e8b008';
const timestamp = '2026-09-14T10:00:00Z';

function currentUser(permissions: string[]) {
  return {
    person: {
      id: personId,
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.test',
      phone: null,
      account: {
        id: accountId,
        personId,
        loginEmail: 'ada.login@example.test',
        status: 'enabled',
        passwordStatus: 'active',
        roles: [],
        version: 1,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 1,
    },
    account: {
      id: accountId,
      personId,
      loginEmail: 'ada.login@example.test',
      status: 'enabled',
      passwordStatus: 'active',
      roles: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 1,
    },
    permissions,
  };
}

function period(status: 'draft' | 'staffing' | 'published' = 'staffing') {
  return {
    id: periodId,
    name: 'Winter Semester 2026/27',
    startsOn: '2026-10-01',
    endsOn: '2026-10-03',
    status,
    totalOpenDays: status === 'draft' ? 0 : 1,
    fullyStaffedCount: 0,
    needsStaffCount: status === 'draft' ? 0 : 1,
    openSupervisorPositions: status === 'draft' ? 0 : 1,
    cancelledCount: 0,
    myAssignmentCount: 0,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function staffOpenDay(joined = false) {
  return {
    id: openDayId,
    periodId,
    startsAt: '2026-10-02T14:00:00Z',
    endsAt: '2026-10-02T17:00:00Z',
    status: 'scheduled',
    requirements: [
      {
        id: supervisorRequirementId,
        kind: 'supervisor',
        requiredCount: 2,
        assignedCount: 1,
      },
      {
        id: traineeRequirementId,
        kind: 'trainee',
        requiredCount: 1,
        assignedCount: joined ? 1 : 0,
      },
    ],
    ...(joined
      ? {
          myAssignment: {
            id: assignmentId,
            openDayId,
            requirementId: traineeRequirementId,
            personId,
            displayName: 'Ada Lovelace',
            isCurrentUser: true,
            createdAt: timestamp,
          },
        }
      : {}),
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: testInfo.outputPath(name), fullPage: true });
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

test('keeps other identities and management fields private while staff sign up', async ({
  page,
}, testInfo) => {
  let joined = false;
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/v1/auth/me') {
      await json(route, currentUser(['open_days.read', 'open_days.signup']));
      return;
    }
    if (path === `/api/v1/open-days/${openDayId}` && request.method() === 'GET') {
      await json(route, staffOpenDay(joined));
      return;
    }
    if (
      path === `/api/v1/open-day-periods/${periodId}/calendar-context` &&
      request.method() === 'GET'
    ) {
      await json(route, {
        timeZone: 'Europe/Vienna',
        countryCode: 'AT',
        subdivisionCode: 'AT-6',
        languageCode: 'de',
        entries: [],
        academicBreaks: [],
      });
      return;
    }
    if (
      path === `/api/v1/open-days/${openDayId}/assignments/me` &&
      request.method() === 'PUT'
    ) {
      expect(request.postDataJSON()).toEqual({ requirementId: traineeRequirementId });
      joined = true;
      await json(route, staffOpenDay(true).myAssignment);
      return;
    }
    throw new Error(`Unexpected API request: ${request.method()} ${path}`);
  });

  await page.goto(`/open-days/${periodId}/days/${openDayId}`);
  await expect(
    page.getByRole('heading', { name: /Friday, (October 2|2 October)/ }),
  ).toBeVisible();
  await expect(page.getByText('1 position filled')).toBeVisible();
  await expect(page.getByText('Internal note:')).toHaveCount(0);
  await expect(page.getByText('Grace Hopper')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Assign person' })).toHaveCount(0);
  await expectAccessible(page);
  await capture(page, testInfo, 'open-days-staff-privacy.png');

  await page.getByRole('button', { name: 'Join as trainee' }).click();
  await expect(page.getByText('You are assigned as trainee.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Leave Open Day' })).toBeVisible();
});

test('creates and atomically saves a manager schedule working copy', async ({
  page,
}, testInfo) => {
  let savedRequest: Record<string, unknown> | undefined;
  const draftPeriod = period('draft');
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/v1/auth/me') {
      await json(route, currentUser(['open_days.manage']));
      return;
    }
    if (path === `/api/v1/open-day-periods/${periodId}/open-days`) {
      await json(route, { period: draftPeriod, items: [], timeZone: 'Europe/Vienna' });
      return;
    }
    if (path === '/api/v1/open-day-eligibility-roles') {
      await json(route, { items: [{ id: roleId, name: 'Open Day team' }] });
      return;
    }
    if (
      path === `/api/v1/open-day-periods/${periodId}/calendar-context` &&
      request.method() === 'GET'
    ) {
      await json(route, {
        timeZone: 'Europe/Vienna',
        countryCode: 'AT',
        subdivisionCode: 'AT-6',
        languageCode: 'de',
        entries: [],
        academicBreaks: [],
      });
      return;
    }
    if (
      path === `/api/v1/open-day-periods/${periodId}/schedule` &&
      request.method() === 'PUT'
    ) {
      savedRequest = request.postDataJSON();
      const create = (savedRequest.creates as Array<Record<string, unknown>>)[0];
      await json(route, {
        period: { ...draftPeriod, totalOpenDays: 1, needsStaffCount: 1, version: 2 },
        items: [
          {
            id: openDayId,
            periodId,
            ...create,
            status: 'scheduled',
            requirements: [
              {
                id: supervisorRequirementId,
                ...(create.requirements as Array<Record<string, unknown>>)[0],
                assignedCount: 0,
              },
              {
                id: traineeRequirementId,
                ...(create.requirements as Array<Record<string, unknown>>)[1],
                assignedCount: 0,
              },
            ],
            version: 1,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
        timeZone: 'Europe/Vienna',
      });
      return;
    }
    if (path === '/api/v1/open-day-periods' && request.method() === 'GET') {
      await json(route, { items: [] });
      return;
    }
    throw new Error(`Unexpected API request: ${request.method()} ${path}`);
  });

  await page.goto(`/open-days/${periodId}/schedule`);
  await expect(page.getByRole('heading', { name: 'Edit Winter Semester 2026/27' })).toBeVisible();
  await expect(page.getByText('Calendar planning · Europe/Vienna')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save & close' })).toBeDisabled();
  await expectAccessible(page);

  await page.getByRole('button', { name: 'Add Open Day on 2026-10-02' }).click();
  await expect(page.getByRole('button', { name: /^Drag or edit Open Day 16:00 to 19:00/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save & close' })).toBeEnabled();
  await capture(page, testInfo, 'open-days-manager-working-copy.png');
  await page.getByRole('button', { name: 'Save & close' }).click();

  await expect.poll(() => savedRequest).toBeDefined();
  expect(savedRequest).toMatchObject({
    expectedPeriodVersion: 1,
    updates: [],
    removals: [],
    creates: [
      {
        requirements: [
          { kind: 'supervisor', requiredCount: 2, eligibleRoleIds: [roleId] },
          { kind: 'trainee', requiredCount: 1, eligibleRoleIds: [roleId] },
        ],
      },
    ],
  });
  const created = (savedRequest!.creates as Array<{ startsAt: string; endsAt: string }>)[0];
  expect(created.startsAt).toContain('2026-10-02');
  expect(new Date(created.endsAt).getTime() - new Date(created.startsAt).getTime()).toBe(
    3 * 60 * 60 * 1000,
  );
  await expect(page.getByRole('button', { name: 'Save & close' })).toBeDisabled();
});

test('manages draft metadata and inclusive academic-break context', async ({
  page,
}, testInfo) => {
  let periodName = 'Winter Semester 2026/27';
  let updatedPeriod: Record<string, unknown> | undefined;
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/v1/auth/me') {
      await json(route, currentUser(['open_days.manage']));
      return;
    }
    if (path === '/api/v1/open-day-periods' && request.method() === 'GET') {
      await json(route, { items: [{ ...period('draft'), name: periodName }] });
      return;
    }
    if (
      path === `/api/v1/open-day-periods/${periodId}/calendar-context` &&
      request.method() === 'GET'
    ) {
      await json(route, {
        timeZone: 'Europe/Vienna',
        countryCode: 'AT',
        subdivisionCode: 'AT-6',
        languageCode: 'de',
        entries: [
          {
            name: 'Nationalfeiertag',
            startsOn: '2026-10-26',
            endsOn: '2026-10-26',
            source: 'public_holiday',
            category: 'public_holiday',
          },
        ],
        academicBreaks: [
          {
            id: assignmentId,
            name: 'Autumn break',
            startsOn: '2026-10-01',
            endsOn: '2026-10-03',
            version: 2,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
      });
      return;
    }
    if (
      path === `/api/v1/open-day-periods/${periodId}` &&
      request.method() === 'PATCH'
    ) {
      updatedPeriod = request.postDataJSON();
      periodName = String(updatedPeriod.name);
      await json(route, { ...period('draft'), name: periodName, version: 2 });
      return;
    }
    throw new Error(`Unexpected API request: ${request.method()} ${path}`);
  });

  await page.goto('/open-days/manage');
  await expect(page.getByRole('heading', { name: 'Manage Open Days' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Autumn break', exact: true })).toBeVisible();
  await expect(page.getByText('2026-10-03')).toBeVisible();
  await page.getByRole('button', { name: 'Edit metadata' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Winter Workshops 2026/27');
  await page.getByRole('button', { name: 'Save period' }).click();
  await expect.poll(() => updatedPeriod).toMatchObject({
    name: 'Winter Workshops 2026/27',
    startsOn: '2026-10-01',
    endsOn: '2026-10-03',
    expectedVersion: 1,
  });
  await expect(page.locator('.managed-period strong')).toHaveText(
    'Winter Workshops 2026/27',
  );
  await expect(page.getByRole('dialog', { name: 'Edit draft period' })).toBeHidden();
  await expectAccessible(page);
  await capture(page, testInfo, 'open-days-management.png');
});
