import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test';
import { defaultPublicBrandingConfiguration } from './branding-fixtures';

const personId = '0192f6f8-743e-7c77-a349-cd07c3e8b001';
const accountId = '0192f6f8-743e-7c77-a349-cd07c3e8b002';
const periodId = '0192f6f8-743e-7c77-a349-cd07c3e8b003';
const openDayId = '0192f6f8-743e-7c77-a349-cd07c3e8b004';
const supervisorRequirementId = '0192f6f8-743e-7c77-a349-cd07c3e8b005';
const traineeRequirementId = '0192f6f8-743e-7c77-a349-cd07c3e8b006';
const roleId = '0192f6f8-743e-7c77-a349-cd07c3e8b007';
const assignmentId = '0192f6f8-743e-7c77-a349-cd07c3e8b008';
const timestamp = '2026-09-14T10:00:00Z';
const passwordIdentityId = '0192f6f8-743e-7c77-a349-cd07c3e8b009';

function currentUser(permissions: string[]) {
  return {
    person: {
      id: personId,
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.test',
      phone: null,
      roles: [],
      account: {
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
      },
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 1,
    },
    account: {
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
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 1,
    },
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

function period(status: 'draft' | 'staffing' | 'published' = 'staffing') {
  return {
    id: periodId,
    name: 'Winter Semester 2026/27',
    startsOn: '2026-10-01',
    endsOn: '2026-10-03',
    signUpDeadline: null,
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
    competencies: [],
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
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations).toEqual([]);
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: testInfo.outputPath(name), fullPage: true });
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/v1/auth/oidc/providers', async (route) => {
    await json(route, { items: [] });
  });
});

test('keeps other identities and management fields private while staff sign up', async ({ page }, testInfo) => {
  let joined = false;
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // The header bell polls the unread count on every page.
    if (path === '/api/v1/notifications/unread-count') {
      await json(route, { unreadCount: 0 });
      return;
    }
    if (path === '/api/v1/auth/activity' && request.method() === 'POST') {
      await json(route, {
        idleExpiresAt: '2099-01-01T01:00:00Z',
        absoluteExpiresAt: '2099-01-02T00:00:00Z',
        postSessionDestination: 'login',
      });
      return;
    }
    if (path === '/api/v1/auth/oidc/providers') {
      await json(route, { items: [] });
      return;
    }
    if (path === '/api/v1/public/config') {
      await json(route, defaultPublicBrandingConfiguration());
      return;
    }
    if (path === '/api/v1/auth/me') {
      await json(route, currentUser(['open_days.read', 'open_days.signup']));
      return;
    }
    if (path === `/api/v1/open-days/${openDayId}` && request.method() === 'GET') {
      await json(route, staffOpenDay(joined));
      return;
    }
    if (path === `/api/v1/open-day-periods/${periodId}/calendar-context` && request.method() === 'GET') {
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
    if (path === `/api/v1/open-days/${openDayId}/assignments/me` && request.method() === 'PUT') {
      expect(request.postDataJSON()).toEqual({ requirementId: traineeRequirementId });
      joined = true;
      await json(route, staffOpenDay(true).myAssignment);
      return;
    }
    throw new Error(`Unexpected API request: ${request.method()} ${path}`);
  });

  await page.goto(`/open-days/${periodId}/days/${openDayId}`);
  await expect(page.getByRole('heading', { name: /Friday, 02\.10\.2026/ })).toBeVisible();
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

test('creates and atomically saves a manager schedule working copy', async ({ page }, testInfo) => {
  let savedRequest: Record<string, unknown> | undefined;
  const draftPeriod = period('draft');
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // The header bell polls the unread count on every page.
    if (path === '/api/v1/notifications/unread-count') {
      await json(route, { unreadCount: 0 });
      return;
    }
    if (path === '/api/v1/auth/activity' && request.method() === 'POST') {
      await json(route, {
        idleExpiresAt: '2099-01-01T01:00:00Z',
        absoluteExpiresAt: '2099-01-02T00:00:00Z',
        postSessionDestination: 'login',
      });
      return;
    }
    if (path === '/api/v1/auth/oidc/providers') {
      await json(route, { items: [] });
      return;
    }
    if (path === '/api/v1/public/config') {
      await json(route, defaultPublicBrandingConfiguration());
      return;
    }
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
    if (path === `/api/v1/open-day-periods/${periodId}/calendar-context` && request.method() === 'GET') {
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
    if (path === `/api/v1/open-day-periods/${periodId}/schedule` && request.method() === 'PUT') {
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
            competencies: [],
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
  await expect(page.getByRole('heading', { name: 'Winter Semester 2026/27' })).toBeVisible();
  await expect(page.getByText('1 October 2026 – 3 October 2026')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
  await expectAccessible(page);

  await page.getByRole('button', { name: '2, Add Open Day on 02.10.2026' }).click();
  await capture(page, testInfo, 'open-days-create-modal.png');
  await page.getByRole('dialog', { name: 'Create Open Day' }).getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('button', { name: /^Drag or edit Open Day 16:00–19:00/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled();
  const editWorkspaceHeight = await page.locator('.app-main').evaluate((main) => main.getBoundingClientRect().height);
  await capture(page, testInfo, 'open-days-manager-working-copy.png');
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page).toHaveURL(new RegExp(`/open-days/${periodId}$`));
  await expect(page.getByRole('group', { name: 'Open Days tools' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Supervisor position open/ })).toBeVisible();
  await expect
    .poll(() => page.locator('.app-main').evaluate((main) => main.getBoundingClientRect().height))
    .toBe(editWorkspaceHeight);
  const previewOutsideBackground = await page
    .locator('.calendar-cell--outside-period')
    .first()
    .evaluate((cell) => getComputedStyle(cell).backgroundColor);
  await capture(page, testInfo, 'open-days-manager-unsaved-preview.png');
  await page.getByRole('button', { name: 'Edit' }).click();
  await expect(page).toHaveURL(new RegExp(`/open-days/${periodId}\\?mode=edit$`));
  await expect(page.getByRole('group', { name: 'Schedule editor tools' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Drag or edit Open Day 16:00–19:00/ })).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator('.calendar-cell--outside-period')
        .first()
        .evaluate((cell) => getComputedStyle(cell).backgroundColor),
    )
    .toBe(previewOutsideBackground);
  await page.getByRole('button', { name: 'List view' }).click();
  const editableTable = page.getByRole('table', { name: 'Editable Open Days' });
  await expect(editableTable).toBeVisible();
  const dateHeader = editableTable.getByRole('columnheader', { name: /Date/ });
  await expect(dateHeader).toBeVisible();
  await expect(editableTable.getByRole('columnheader', { name: 'Staffing status' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Filter' }).click();
  const dateTimeFilters = page.getByRole('group', { name: 'Filter by day and time' });
  await dateTimeFilters.getByRole('combobox', { name: 'Filter by weekday' }).click();
  const clippedWeekdayLabels = await dateTimeFilters
    .locator('.open-days-weekday-filter .cds--list-box__menu-item')
    .evaluateAll((options) =>
      options.flatMap((option) => {
        const label = option.querySelector<HTMLElement>('.cds--checkbox-label-text');
        if (!label) return [option.getAttribute('aria-label') ?? 'missing label'];
        const labelBounds = label.getBoundingClientRect();
        const optionBounds = option.getBoundingClientRect();
        return getComputedStyle(label).textOverflow === 'ellipsis' || labelBounds.right > optionBounds.right
          ? [option.getAttribute('aria-label') ?? label.textContent ?? 'unknown']
          : [];
      }),
    );
  expect(clippedWeekdayLabels).toEqual([]);
  await capture(page, testInfo, 'open-days-weekday-filter.png');
  await dateTimeFilters.getByRole('option', { name: 'Friday' }).click();
  await dateTimeFilters.getByRole('combobox', { name: 'Filter by start time' }).click();
  await dateTimeFilters.getByRole('option', { name: '16:00' }).click();
  await dateHeader.getByRole('button', { name: 'Date' }).click();
  await expect(dateHeader).toHaveAttribute('aria-sort', 'ascending');
  await editableTable.getByRole('checkbox', { name: /select row/i }).check({ force: true });
  await expect(page.getByRole('button', { name: 'Edit selected' })).toBeVisible();
  await expectAccessible(page);
  await capture(page, testInfo, 'open-days-manager-table-working-copy.png');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Save' }).click();

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
  expect(new Date(created.endsAt).getTime() - new Date(created.startsAt).getTime()).toBe(3 * 60 * 60 * 1000);
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page).toHaveURL(new RegExp(`/open-days/${periodId}\\?view=list$`));
  await expect(page.getByRole('heading', { name: 'Winter Semester 2026/27' })).toBeVisible();
});

test('manages inclusive academic-break context on a focused screen', async ({ page }, testInfo) => {
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // The header bell polls the unread count on every page.
    if (path === '/api/v1/notifications/unread-count') {
      await json(route, { unreadCount: 0 });
      return;
    }
    if (path === '/api/v1/auth/activity' && request.method() === 'POST') {
      await json(route, {
        idleExpiresAt: '2099-01-01T01:00:00Z',
        absoluteExpiresAt: '2099-01-02T00:00:00Z',
        postSessionDestination: 'login',
      });
      return;
    }
    if (path === '/api/v1/auth/oidc/providers') {
      await json(route, { items: [] });
      return;
    }
    if (path === '/api/v1/public/config') {
      await json(route, defaultPublicBrandingConfiguration());
      return;
    }
    if (path === '/api/v1/auth/me') {
      await json(route, currentUser(['open_days.manage']));
      return;
    }
    if (path === '/api/v1/open-day-periods' && request.method() === 'GET') {
      await json(route, { items: [period('draft')] });
      return;
    }
    if (path === '/api/v1/open-day-academic-breaks' && request.method() === 'GET') {
      await json(route, {
        items: [
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
    if (path === `/api/v1/open-day-periods/${periodId}/calendar-context` && request.method() === 'GET') {
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
    throw new Error(`Unexpected API request: ${request.method()} ${path}`);
  });

  await page.goto('/open-days/manage');
  await expect(page.getByRole('heading', { name: 'Academic breaks', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Periods' })).toHaveCount(0);
  await expect(page.getByRole('cell', { name: 'Autumn break', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '03.10.2026', exact: true })).toBeVisible();
  await expectAccessible(page);
  await capture(page, testInfo, 'open-days-academic-breaks.png');
});

test('rejects ambiguous local schedule times without adding a slot', async ({ page }) => {
  const draft = { ...period('draft'), startsOn: '2026-10-25', endsOn: '2026-10-25' };
  const errors: Error[] = [];
  page.on('pageerror', (error) => errors.push(error));
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    // The header bell polls the unread count on every page.
    if (path === '/api/v1/notifications/unread-count') {
      await json(route, { unreadCount: 0 });
      return;
    }
    if (path.endsWith('/auth/activity') && route.request().method() === 'POST')
      return json(route, {
        idleExpiresAt: '2099-01-01T01:00:00Z',
        absoluteExpiresAt: '2099-01-02T00:00:00Z',
        postSessionDestination: 'login',
      });
    if (path.endsWith('/public/config')) {
      return json(route, defaultPublicBrandingConfiguration());
    }
    if (path.endsWith('/auth/me')) return json(route, currentUser(['open_days.manage']));
    if (path.endsWith('/open-days')) return json(route, { period: draft, items: [], timeZone: 'Europe/Vienna' });
    if (path.endsWith('/open-day-eligibility-roles')) return json(route, { items: [{ id: roleId, name: 'Team' }] });
    if (path.endsWith('/calendar-context'))
      return json(route, { timeZone: 'Europe/Vienna', entries: [], academicBreaks: [] });
    return json(route, { items: [] });
  });
  await page.goto(`/open-days/${periodId}/schedule`);
  await expect(page.getByRole('heading', { name: 'Winter Semester 2026/27' })).toBeVisible();
  await page.getByRole('button', { name: /Add Open Day.*25|Add.*25\.10\.2026/ }).click();
  const defaultsDialog = page.getByRole('dialog', { name: 'Create Open Day' });
  const visibleModal = page.locator('.cds--modal.is-visible');
  const [dialogBox, viewport] = await Promise.all([defaultsDialog.boundingBox(), page.viewportSize()]);
  expect(dialogBox).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(Math.abs(dialogBox!.x + dialogBox!.width / 2 - viewport!.width / 2)).toBeLessThan(2);
  expect(await page.evaluate(() => Boolean(document.elementFromPoint(100, 200)?.closest('.cds--modal')))).toBe(true);
  await expect(visibleModal).toHaveCSS('position', 'fixed');
  await defaultsDialog.locator('#create-start').fill('02:30');
  await defaultsDialog.locator('#create-end').fill('04:00');
  await defaultsDialog.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText(/Local time 25\.10\.2026 02:30 is ambiguous/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
  expect(errors).toEqual([]);
});

async function mockResponsivePeriod(page: Page) {
  const draft = { ...period('draft'), totalOpenDays: 1 };
  const assigned = {
    id: assignmentId,
    openDayId,
    requirementId: supervisorRequirementId,
    personId,
    displayName: 'Ada Lovelace',
    isCurrentUser: true,
    createdAt: timestamp,
  };
  const day = {
    ...staffOpenDay(),
    internalNote: 'Workshop preparation',
    requirements: [
      { ...staffOpenDay().requirements[0], eligibleRoleIds: [roleId], assignments: [assigned] },
      { ...staffOpenDay().requirements[1], eligibleRoleIds: [roleId], assignments: [] },
    ],
  };
  const saveRequests: unknown[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    // The header bell polls the unread count on every page.
    if (path === '/api/v1/notifications/unread-count') {
      await json(route, { unreadCount: 0 });
      return;
    }
    if (path.endsWith('/auth/activity'))
      return json(route, {
        idleExpiresAt: '2099-01-01T01:00:00Z',
        absoluteExpiresAt: '2099-01-02T00:00:00Z',
        postSessionDestination: 'login',
      });
    if (path.endsWith('/auth/me'))
      return json(route, currentUser(['open_days.read', 'open_days.manage', 'open_days.assign', 'open_days.signup']));
    if (path.endsWith('/public/config')) return json(route, defaultPublicBrandingConfiguration());
    if (path.endsWith('/auth/oidc/providers')) return json(route, { items: [] });
    if (path === '/api/v1/open-day-periods') return json(route, { items: [draft] });
    if (path === `/api/v1/open-day-periods/${periodId}/open-days`)
      return json(route, { period: draft, items: [day], timeZone: 'Europe/Vienna' });
    if (path === `/api/v1/open-days/${openDayId}`) return json(route, day);
    if (path.endsWith('/calendar-context'))
      return json(route, { timeZone: 'Europe/Vienna', entries: [], academicBreaks: [] });
    if (path.endsWith('/open-day-eligibility-roles')) return json(route, { items: [{ id: roleId, name: 'Team' }] });
    if (path.endsWith('/eligible-people')) return json(route, { items: [{ personId, displayName: 'Ada Lovelace' }] });
    if (path.endsWith('/recurrence-preview'))
      return json(route, {
        occurrences: [
          {
            date: '2026-10-03',
            startsAt: '2026-10-03T14:00:00Z',
            endsAt: '2026-10-03T17:00:00Z',
            disposition: 'create',
          },
        ],
      });
    if (path.endsWith('/schedule') && method === 'PUT') {
      saveRequests.push(route.request().postDataJSON());
      return json(route, { period: draft, items: [day], timeZone: 'Europe/Vienna' });
    }
    throw new Error(`Unexpected API request: ${method} ${path}`);
  });
  return { saveRequests };
}

for (const width of [320, 390, 414, 768, 1440]) {
  test(`supports schedule, calendar and staffing at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await mockResponsivePeriod(page);
    await page.goto(`/open-days/${periodId}?mode=edit&source=responsive`);
    await expect(page.getByRole('heading', { name: 'Winter Semester 2026/27' })).toBeVisible();
    const phone = width < 672;
    if (phone) {
      await expect(page.locator('.open-day-agenda')).toBeVisible();
      await expect(page.getByRole('table')).toHaveCount(0);
      await page.locator('.open-day-agenda .cds--checkbox-label').click();
      await page.getByRole('button', { name: 'Edit selected' }).click();
      const bulk = page.getByRole('dialog', { name: 'Edit 1 selected Open Day' });
      await bulk.getByLabel('Internal note').fill('Mobile working copy');
      await bulk.getByRole('button', { name: 'Apply to selected' }).click();
      await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled();
    } else await page.getByRole('button', { name: 'List view' }).click();
    await expectAccessible(page);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await capture(page, testInfo, `open-days-list-${width}.png`);
    await page.getByRole('button', { name: 'Calendar view' }).click();
    await expect(page).toHaveURL(/mode=edit.*source=responsive.*view=calendar/);
    const toolbar = page.getByRole('group', { name: 'Schedule editor tools' });
    const legend = page.locator('.calendar-legend');
    await expect(toolbar).toBeVisible();
    await expect(legend).toBeVisible();
    const toolbarBox = await toolbar.boundingBox();
    const legendBox = await legend.boundingBox();
    expect(legendBox!.y).toBeGreaterThanOrEqual(toolbarBox!.y + toolbarBox!.height - 1);
    if (phone) {
      await expect(page.getByRole('button', { name: /Drag or edit/ })).toHaveCount(0);
      await page.getByRole('button', { name: '2, Show Open Days on 02.10.2026' }).click();
      await expect(
        page.locator('.open-day-agenda-selection').getByRole('button', { name: 'Edit', exact: true }),
      ).toBeVisible();
      await expect(page.getByText('Mobile working copy')).toBeVisible();
    }
    await expectAccessible(page);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await capture(page, testInfo, `open-days-calendar-${width}.png`);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    const create = page.getByRole('dialog', { name: 'Create Open Day' });
    await create.locator('label[for="create-open-day-series"]').click();
    await create.getByRole('button', { name: 'Preview series' }).click();
    const review = page.getByRole('dialog', { name: 'Review Open Day series' });
    await expect(review.getByRole('checkbox', { name: '03.10.2026 · create' })).toBeChecked();
    await expect(review.getByRole('button', { name: 'Add selected' })).toBeInViewport();
    await expectAccessible(page);
    await capture(page, testInfo, `open-days-series-${width}.png`);
    await page.keyboard.press('Escape');
    const discard = page.getByRole('dialog', { name: 'Discard Open Day inputs?' });
    await expect(discard.getByRole('button', { name: 'Keep editing' })).toBeFocused();
    await discard.getByRole('button', { name: 'Discard inputs' }).click();
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Filter by day and time' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    if (phone) {
      await page.getByRole('button', { name: /Show Open Days on Friday, 02.10.2026/ }).click();
      await page.locator('.open-day-agenda').getByRole('button', { name: /16:00/ }).click();
    } else await page.getByRole('button', { name: /Supervisor position open/ }).click();
    await page.getByRole('button', { name: 'Assign person', exact: true }).first().click();
    await expect(page.locator('.cds--modal.is-visible')).toHaveCount(1);
    const assign = page.getByRole('dialog', { name: 'Assign supervisor' });
    await expect(assign.getByRole('searchbox', { name: 'Search eligible people' })).toBeVisible();
    await expectAccessible(page);
    await assign.getByRole('button', { name: 'Back to Open Day' }).click();
    await page.getByRole('button', { name: 'Remove Ada Lovelace' }).click();
    const remove = page.getByRole('dialog', { name: 'Remove assignment?' });
    await expect(page.locator('.cds--modal.is-visible')).toHaveCount(1);
    await expect(remove.getByRole('button', { name: 'Keep assignment' })).toBeFocused();
    await remove.getByRole('button', { name: 'Keep assignment' }).click();
    await expectAccessible(page);
    await capture(page, testInfo, `open-days-staffing-${width}.png`);
  });
}

test('protects period inputs and keeps its controlled dialog open during creation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.setFixedTime(new Date('2026-10-11T12:00:00Z'));
  await mockResponsivePeriod(page);
  let releaseCreation: (() => void) | undefined;
  await page.route('**/api/v1/open-day-periods', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await new Promise<void>((resolve) => {
      releaseCreation = resolve;
    });
    return json(route, period('draft'), 201);
  });
  await page.goto('/open-days');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Create Period' });
  await dialog.getByLabel('Name', { exact: true }).fill('Next semester');
  await page.keyboard.press('Escape');
  const discard = page.getByRole('dialog', { name: 'Discard period inputs?' });
  await expect(discard).toBeVisible();
  await expect(discard.getByRole('button', { name: 'Keep editing' })).toBeFocused();
  await expectAccessible(page);
  await expect(page.locator('.cds--modal.is-visible')).toHaveCount(1);
  await discard.getByRole('button', { name: 'Keep editing' }).click();
  dialog = page.getByRole('dialog', { name: 'Create Period' });
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('Next semester');
  await dialog.getByLabel('Start date', { exact: true }).click();
  await page.getByRole('button', { name: 'Thursday, October 1, 2026', exact: true }).click();
  await page.getByRole('button', { name: 'Saturday, October 3, 2026', exact: true }).click();
  await dialog.getByRole('button', { name: 'Create Period', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Creating…' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeVisible();
  releaseCreation?.();
  await expect(page.getByRole('heading', { name: 'Winter Semester 2026/27' })).toBeVisible();
  await expect(page).toHaveURL(/mode=edit/);
});

test('protects a creation date chosen through the calendar picker', async ({ page }) => {
  await mockResponsivePeriod(page);
  await page.goto(`/open-days/${periodId}?mode=edit`);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const create = page.getByRole('dialog', { name: 'Create Open Day' });
  await create.getByLabel('Date', { exact: true }).click();
  await page.locator('.flatpickr-calendar.open [aria-label="Friday, October 2, 2026"]').click();
  await expect(create.getByLabel('Date', { exact: true })).toHaveValue('02.10.2026');
  await create.getByRole('button', { name: 'Cancel', exact: true }).click();
  const discard = page.getByRole('dialog', { name: 'Discard Open Day inputs?' });
  await expect(discard).toBeVisible();
  await discard.getByRole('button', { name: 'Keep editing' }).click();
  await expect(create.getByLabel('Date', { exact: true })).toHaveValue('02.10.2026');
});

test('creates a period whose calendar range spans several months', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-11T12:00:00Z'));
  await mockResponsivePeriod(page);
  // Like Core, every activity report extends the idle expiry, which changes the current user.
  let activityReports = 0;
  await page.route('**/api/v1/auth/activity', async (route) => {
    activityReports += 1;
    return json(route, {
      idleExpiresAt: new Date(Date.UTC(2099, 0, 1, 1, activityReports)).toISOString(),
      absoluteExpiresAt: '2099-01-02T00:00:00Z',
      postSessionDestination: 'login',
    });
  });
  let body: unknown;
  await page.route('**/api/v1/open-day-periods', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    body = route.request().postDataJSON();
    return json(route, period('draft'), 201);
  });
  await page.goto('/open-days');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create Period' });
  await dialog.getByLabel('Name', { exact: true }).fill('Winter semester');
  await dialog.getByLabel('Start date', { exact: true }).click();
  const calendar = page.locator('.flatpickr-calendar.open');
  await calendar.locator('.flatpickr-next-month').click();
  await expect(calendar.locator('.cur-month')).toHaveText('November');
  await calendar.locator('[aria-label="Monday, November 2, 2026"]').click();
  await expect(dialog.getByLabel('Start date', { exact: true })).toHaveValue('02.11.2026');
  // Moving on to the end month must not snap back to the start month.
  await calendar.locator('.flatpickr-next-month').click();
  await calendar.locator('.flatpickr-next-month').click();
  await expect(calendar.locator('.cur-month')).toHaveText('January');
  await calendar.locator('[aria-label="Friday, January 29, 2027"]').click();
  await expect(dialog.getByLabel('Start date', { exact: true })).toHaveValue('02.11.2026');
  await expect(dialog.getByLabel('End date', { exact: true })).toHaveValue('29.01.2027');
  await dialog.getByRole('button', { name: 'Create Period', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Winter Semester 2026/27' })).toBeVisible();
  expect(body).toEqual({ name: 'Winter semester', startsOn: '2026-11-02', endsOn: '2027-01-29', signUpDeadline: null });
  // Activity is reported at most once a minute, not on every click.
  expect(activityReports).toBe(1);
});
