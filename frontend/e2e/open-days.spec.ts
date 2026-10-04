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
        authIdentities: [{ id: passwordIdentityId, kind: 'password', displayIdentifier: 'ada.login@example.test', verifiedAt: timestamp, disabledAt: null, usable: true, createdAt: timestamp }],
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
      authIdentities: [{ id: passwordIdentityId, kind: 'password', displayIdentifier: 'ada.login@example.test', verifiedAt: timestamp, disabledAt: null, usable: true, createdAt: timestamp }],
      status: 'enabled',
      passwordStatus: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 1,
    },
    permissions,
    authenticationAssurance: 'normal',
    managedDevice: null,
    delegablePermissionGrants: permissions.map((permissionId) => ({ permissionId, scope: 'everywhere', deviceTypeIds: [], minimumAssurance: 'low' })),
    laborordnungStatus: { mode: 'not_required', state: 'not_required', actionRequired: false, currentVersion: null, latestConfirmedVersion: null, requestId: null },
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
  await page.route('**/api/v1/auth/oidc/providers', async (route) => {
    await json(route, { items: [] });
  });
});

test('keeps other identities and management fields private while staff sign up', async ({
  page,
}, testInfo) => {
  let joined = false;
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
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
    page.getByRole('heading', { name: /Friday, 02\.10\.2026/ }),
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
  await expect(page.getByRole('heading', { name: 'Winter Semester 2026/27' })).toBeVisible();
  await expect(page.getByText('1 October 2026 – 3 October 2026')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
  await expectAccessible(page);

  await page.getByRole('button', { name: 'Add Open Day on 02.10.2026' }).click();
  await capture(page, testInfo, 'open-days-create-modal.png');
  await page.getByRole('dialog', { name: 'Create Open Day' }).getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('button', { name: /^Drag or edit Open Day 16:00 to 19:00/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled();
  const editWorkspaceHeight = await page.locator('.app-main').evaluate((main) => main.getBoundingClientRect().height);
  await capture(page, testInfo, 'open-days-manager-working-copy.png');
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page).toHaveURL(new RegExp(`/open-days/${periodId}$`));
  await expect(page.getByRole('group', { name: 'Open Days tools' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Supervisor position open/ })).toBeVisible();
  await expect.poll(() => page.locator('.app-main').evaluate((main) => main.getBoundingClientRect().height)).toBe(editWorkspaceHeight);
  const previewOutsideBackground = await page.locator('.calendar-cell--outside-period').first().evaluate((cell) => getComputedStyle(cell).backgroundColor);
  await capture(page, testInfo, 'open-days-manager-unsaved-preview.png');
  await page.getByRole('button', { name: 'Edit' }).click();
  await expect(page).toHaveURL(new RegExp(`/open-days/${periodId}\\?mode=edit$`));
  await expect(page.getByRole('group', { name: 'Schedule editor tools' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Drag or edit Open Day 16:00 to 19:00/ })).toBeVisible();
  await expect.poll(() => page.locator('.calendar-cell--outside-period').first().evaluate((cell) => getComputedStyle(cell).backgroundColor)).toBe(previewOutsideBackground);
  await page.getByRole('button', { name: 'Table view' }).click();
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
    .evaluateAll((options) => options.flatMap((option) => {
      const label = option.querySelector<HTMLElement>('.cds--checkbox-label-text');
      if (!label) return [option.getAttribute('aria-label') ?? 'missing label'];
      const labelBounds = label.getBoundingClientRect();
      const optionBounds = option.getBoundingClientRect();
      return getComputedStyle(label).textOverflow === 'ellipsis' || labelBounds.right > optionBounds.right
        ? [option.getAttribute('aria-label') ?? label.textContent ?? 'unknown']
        : [];
    }));
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
  expect(new Date(created.endsAt).getTime() - new Date(created.startsAt).getTime()).toBe(
    3 * 60 * 60 * 1000,
  );
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page).toHaveURL(new RegExp(`/open-days/${periodId}$`));
  await expect(page.getByRole('heading', { name: 'Winter Semester 2026/27' })).toBeVisible();
});

test('manages draft metadata and inclusive academic-break context', async ({
  page,
}, testInfo) => {
  let periodName = 'Winter Semester 2026/27';
  let updatedPeriod: Record<string, unknown> | undefined;
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
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
  await expect(page.getByRole('cell', { name: '03.10.2026', exact: true })).toBeVisible();
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

test('rejects ambiguous local schedule times without adding a slot', async ({ page }) => {
  const draft = { ...period('draft'), startsOn: '2026-10-25', endsOn: '2026-10-25' };
  const errors: Error[] = [];
  page.on('pageerror', (error) => errors.push(error));
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/public/config')) {
      return json(route, defaultPublicBrandingConfiguration());
    }
    if (path.endsWith('/auth/me')) return json(route, currentUser(['open_days.manage']));
    if (path.endsWith('/open-days')) return json(route, { period: draft, items: [], timeZone: 'Europe/Vienna' });
    if (path.endsWith('/open-day-eligibility-roles')) return json(route, { items: [{ id: roleId, name: 'Team' }] });
    if (path.endsWith('/calendar-context')) return json(route, { timeZone: 'Europe/Vienna', entries: [], academicBreaks: [] });
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
