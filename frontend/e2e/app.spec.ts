import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import { defaultPublicBrandingConfiguration } from './branding-fixtures';

type ApiState = {
  authenticated: boolean;
  expirePasswordChange?: boolean;
  openDayPeriods?: unknown[];
  person?: ReturnType<typeof managedPerson>;
  people?: ReturnType<typeof managedPerson>[];
  publicBranding?: ReturnType<typeof defaultPublicBrandingConfiguration>;
  makerspaceStatus?: ReturnType<typeof personMakerspaceStatus>;
  role?: ReturnType<typeof customRole>;
  supervisorDashboard?: ReturnType<typeof supervisorDashboard>;
  user?: ReturnType<typeof currentUser>;
};

const personId = '0192f6f8-743e-7c77-a349-cd07c3e8a901';
const accountId = '0192f6f8-743e-7c77-a349-cd07c3e8a902';
const roleId = '0192f6f8-743e-7c77-a349-cd07c3e8a903';
const pageErrors = new WeakMap<Page, Error[]>();
const passwordIdentityId = '0192f6f8-743e-7c77-a349-cd07c3e8a904';
const managedPersonId = '0192f6f8-743e-7c77-a349-cd07c3e8a905';
const managedAccountId = '0192f6f8-743e-7c77-a349-cd07c3e8a906';
const openDayPeriodId = '0192f6f8-743e-7c77-a349-cd07c3e8a932';

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors: Error[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error));
});

test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page) ?? []).toEqual([]);
});

function currentUser(permissions: string[] = []) {
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
        firstAuthenticatedAt: '2026-01-01T00:00:00Z',
        authIdentities: [{ id: passwordIdentityId, kind: 'password', displayIdentifier: 'ada.login@example.test', verifiedAt: '2026-01-01T00:00:00Z', disabledAt: null, usable: true, createdAt: '2026-01-01T00:00:00Z' }],
        status: 'enabled',
        passwordStatus: 'active',
        version: 1,
      },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      version: 1,
    },
    account: {
      id: accountId,
      personId,
      loginEmail: 'ada.login@example.test',
      provisioningSource: 'local',
      firstAuthenticatedAt: '2026-01-01T00:00:00Z',
      authIdentities: [{ id: passwordIdentityId, kind: 'password', displayIdentifier: 'ada.login@example.test', verifiedAt: '2026-01-01T00:00:00Z', disabledAt: null, usable: true, createdAt: '2026-01-01T00:00:00Z' }],
      status: 'enabled',
      passwordStatus: 'active',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      version: 1,
    },
    permissions,
    authenticationAssurance: 'normal',
    managedDevice: null,
    delegablePermissionGrants: permissions.map((permissionId) => ({
      permissionId,
      scope: 'everywhere',
      deviceTypeIds: [],
      minimumAssurance: 'low',
    })),
    laborordnungStatus: { mode: 'not_required', state: 'not_required', actionRequired: false, currentVersion: null, latestConfirmedVersion: null, requestId: null },
  };
}

function customRole() {
  return {
    id: roleId,
    name: 'Workshop supervisors',
    description: 'May manage routine workshop access.',
    systemKey: null,
    permissionGrants: ['people.read.all', 'roles.read', 'roles.manage'].map((permissionId) => ({
      permissionId,
      scope: 'everywhere',
      deviceTypeIds: [],
      minimumAssurance: 'low',
    })),
    profileImageRequired: false,
    laborordnungMode: 'not_required',
    supervisorDashboard: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
  };
}

function managedPerson(role = customRole()) {
  return {
    id: managedPersonId,
    firstName: 'Grace',
    lastName: 'Hopper',
    email: 'grace@example.test',
    phone: null,
    matriculationNumber: 'M-0042',
    roles: [{ id: role.id, name: role.name, systemKey: role.systemKey }],
    account: {
      id: managedAccountId,
      personId: managedPersonId,
      loginEmail: 'grace.login@example.test',
      provisioningSource: 'local',
      firstAuthenticatedAt: '2026-01-01T00:00:00Z',
      authIdentities: [{ id: passwordIdentityId, kind: 'password', displayIdentifier: 'grace.login@example.test', verifiedAt: '2026-01-01T00:00:00Z', disabledAt: null, usable: true, createdAt: '2026-01-01T00:00:00Z' }],
      status: 'enabled',
      passwordStatus: 'active',
      version: 1,
    },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
  };
}

function personMakerspaceStatus() {
  return {
    laborordnungStatus: {
      mode: 'warning',
      state: 'outdated',
      actionRequired: true,
      currentVersion: { humanRevision: '2026-09' },
      latestConfirmedVersion: { humanRevision: '2025-09' },
      requestId: null,
    },
    upcomingOpenDayAssignments: [{
      assignmentId: '0192f6f8-743e-7c77-a349-cd07c3e8a930',
      openDayId: '0192f6f8-743e-7c77-a349-cd07c3e8a931',
      periodId: '0192f6f8-743e-7c77-a349-cd07c3e8a932',
      periodName: 'Autumn Open Days',
      startsAt: '2026-10-10T08:00:00Z',
      endsAt: '2026-10-10T12:00:00Z',
      role: 'supervisor',
    }],
  };
}

function supervisorDashboard() {
  return {
    periods: [{
      id: openDayPeriodId,
      name: 'Autumn Open Days',
      status: 'published',
      supervisorAssignments: 4,
    }],
    supervisors: [{
      personId: managedPersonId,
      name: 'Grace Hopper',
      hasProfileImage: true,
      laborordnungState: 'current',
      assignmentCounts: [{ periodId: openDayPeriodId, supervisorCount: 2, traineeCount: 1 }],
    }],
    totals: {
      supervisors: 1,
      profileImagesComplete: 1,
      laborordnungCurrent: 1,
      laborordnungOutdated: 0,
    },
  };
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function installApi(page: Page, state: ApiState) {
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path === '/api/v1/auth/oidc/providers' && request.method() === 'GET') {
      await json(route, { items: [] });
      return;
    }

    if (path === '/api/v1/public/config' && request.method() === 'GET') {
      await json(route, state.publicBranding ?? defaultPublicBrandingConfiguration());
      return;
    }

    if (path === '/api/v1/auth/me' && request.method() === 'GET') {
      if (!state.authenticated) {
        await json(route, { code: 'invalid_session', message: 'Sign in required.' }, 401);
        return;
      }
      await json(route, state.user ?? currentUser());
      return;
    }

    if (path === '/api/v1/auth/login' && request.method() === 'POST') {
      expect(request.postDataJSON()).toEqual({
        email: 'ada.login@example.test',
        password: 'correct horse battery staple',
      });
      state.authenticated = true;
      await route.fulfill({ status: 204 });
      return;
    }

    if (path === '/api/v1/auth/password' && request.method() === 'PUT') {
      if (state.expirePasswordChange) {
        state.authenticated = false;
        await json(route, { code: 'invalid_session', message: 'Sign in required.' }, 401);
        return;
      }
      await route.fulfill({ status: 204 });
      return;
    }

    if (path === `/api/v1/roles/${roleId}` && request.method() === 'GET' && state.role) {
      await json(route, state.role);
      return;
    }

    if (path === '/api/v1/roles' && request.method() === 'GET' && state.role) {
      await json(route, { items: [state.role], nextCursor: null });
      return;
    }

    if (path === '/api/v1/roles/effective-permissions' && request.method() === 'GET' && state.role) {
      await json(route, {
        items: [{
          roleId: state.role.id,
          roleVersion: state.role.version,
          permissionIds: state.role.permissionGrants.map((grant) => grant.permissionId),
        }],
      });
      return;
    }

    if (path === '/api/v1/permissions' && request.method() === 'GET' && state.role) {
      await json(route, {
        items: state.role.permissionGrants.map(({ permissionId: id }) => ({
          id,
          description: `Description for ${id}.`,
        })),
      });
      return;
    }

    if (path === '/api/v1/managed-device-types' && request.method() === 'GET') {
      await json(route, { items: [] });
      return;
    }

    if (state.person && path === `/api/v1/people/${state.person.id}` && request.method() === 'GET') {
      await json(route, state.person);
      return;
    }

    const makerspaceStatusPersonId = path.match(/^\/api\/v1\/people\/([^/]+)\/makerspace-status$/)?.[1];
    const mayReturnMakerspaceStatus = makerspaceStatusPersonId && (
      state.person?.id === makerspaceStatusPersonId ||
      state.people?.some((person) => person.id === makerspaceStatusPersonId)
    );
    if (state.makerspaceStatus && mayReturnMakerspaceStatus && request.method() === 'GET') {
      await json(route, state.makerspaceStatus);
      return;
    }

    if (path === '/api/v1/people' && request.method() === 'GET') {
      const people = state.people ?? [];
      await json(route, { items: people, page: 1, pageSize: 25, total: people.length });
      return;
    }

    if (path === '/api/v1/open-day-periods' && request.method() === 'GET' && state.openDayPeriods) {
      await json(route, { items: state.openDayPeriods });
      return;
    }

    if (path === '/api/v1/supervisor-dashboard' && request.method() === 'GET' && state.supervisorDashboard) {
      await json(route, state.supervisorDashboard);
      return;
    }

    throw new Error(`Unexpected API request: ${request.method()} ${path}`);
  });
}

async function expectNoSeriousAccessibilityViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

async function expectNoHorizontalPageOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
}

async function expectNoVerticalPageOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    clientHeight: document.documentElement.clientHeight,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  expect(dimensions.scrollHeight).toBeLessThanOrEqual(dimensions.clientHeight);
}

async function expectShellHeaderAndContentAligned(page: Page) {
  const shell = page.locator('[data-page-shell]');
  const header = shell.locator(':scope > .page-header');
  const content = shell.locator(':scope > .page-shell__content');
  const [headerBounds, contentBounds] = await Promise.all([
    header.boundingBox(),
    content.boundingBox(),
  ]);
  if (!headerBounds || !contentBounds) throw new Error('Could not measure the page shell.');
  expect(Math.abs(headerBounds.x - contentBounds.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(headerBounds.width - contentBounds.width)).toBeLessThanOrEqual(1);
}

test('signs in, renders the protected shell, and passes an accessibility scan', async ({ page }) => {
  const state: ApiState = {
    authenticated: false,
    user: currentUser(['people.read.all', 'roles.read', 'people.update.self']),
  };
  await installApi(page, state);

  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Makerspace' })).toBeVisible();
  await expectNoSeriousAccessibilityViolations(page);

  await page.getByLabel('Email').fill('ada.login@example.test');
  await page
    .getByLabel('Password', { exact: true })
    .fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.locator('[data-page-shell]')).toHaveAttribute('data-page-width', 'standard');
  await expectShellHeaderAndContentAligned(page);
  await expectNoHorizontalPageOverflow(page);
  await expectNoVerticalPageOverflow(page);
  await expect(page.getByText('Welcome, Ada.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByText('Administration', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();
  const skipLink = page.getByRole('link', { name: 'Skip to main content' });
  await expect(skipLink).toHaveAttribute('href', '#main-content');
  await skipLink.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();
  await expectNoSeriousAccessibilityViolations(page);
});

test('shows promoted Directory navigation and exposes self-service profile access', async ({ page }) => {
  await installApi(page, {
    authenticated: true,
    user: currentUser(['people.read.all', 'people.update.self']),
  });

  await page.goto('/people');
  await expect(page.getByRole('heading', { name: 'Directory', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Directory' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Settings' })).toHaveCount(0);
  await expectNoSeriousAccessibilityViolations(page);

  const profileMenuButton = page.getByRole('button', {
    name: 'Open profile menu for Ada Lovelace',
  });
  await profileMenuButton.click();
  await expect(
    page.getByRole('button', { name: 'Close profile menu for Ada Lovelace' }),
  ).toBeVisible();
  await expect(page.getByText('ada@example.test')).toBeVisible();
  await page.getByRole('button', { name: 'View profile' }).focus();
  await page.keyboard.press('Escape');
  await expect(profileMenuButton).toBeFocused();

  await profileMenuButton.click();
  await page.getByRole('button', { name: 'View profile' }).click();

  await expect(page).toHaveURL(/\/profile$/);
  await expect(page.getByRole('heading', { name: 'Profile', exact: true })).toBeVisible();
  const profileCard = page
    .getByRole('heading', { name: 'Profile picture', exact: true })
    .locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " person-detail-card ")][1]');
  const personalInformationCard = page
    .getByRole('heading', { name: 'Personal information', exact: true })
    .locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " person-detail-card ")][1]');
  await expect(profileCard.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
  await expect(personalInformationCard.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Authentication methods' })).toBeVisible();

  const cardBounds = async (heading: string) => {
    const bounds = await page
      .getByRole('heading', { name: heading, exact: true })
      .locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " person-detail-card ")][1]')
      .boundingBox();
    if (!bounds) throw new Error(`Could not measure the ${heading} profile card.`);
    return bounds;
  };
  const [profile, accountAccess, personalInformation, authenticationMethods] = await Promise.all([
    cardBounds('Profile picture'),
    cardBounds('Account access'),
    cardBounds('Personal information'),
    cardBounds('Authentication methods'),
  ]);
  expect(Math.abs(profile.y - accountAccess.y)).toBeLessThanOrEqual(1);
  expect(Math.abs((profile.y + profile.height) - (accountAccess.y + accountAccess.height))).toBeLessThanOrEqual(1);
  expect(Math.abs(profile.x - personalInformation.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(accountAccess.x - authenticationMethods.x)).toBeLessThanOrEqual(1);
  await expect(page.getByText('Matriculation number')).toHaveCount(0);
  await expectNoSeriousAccessibilityViolations(page);
});

test('shows Lab Rules between roles and a centered Status column', async ({ page }) => {
  const role = { ...customRole(), supervisorDashboard: true };
  const person = managedPerson(role);
  await installApi(page, {
    authenticated: true,
    people: [person],
    makerspaceStatus: personMakerspaceStatus(),
    role,
    user: currentUser([
      'people.read.all',
      'accounts.read',
      'roles.read',
      'laborordnung.requests.read',
    ]),
  });

  await page.goto('/people');
  const rolesHeader = page.getByRole('columnheader', { name: 'Roles' });
  const labRulesHeader = page.getByRole('columnheader', { name: 'Lab Rules' });
  const statusHeader = page.getByRole('columnheader', { name: 'Status' });
  const personRow = page.getByRole('row', { name: /Grace Hopper/ });
  const statusTag = personRow.getByText('Active', { exact: true });
  const statusCell = statusTag.locator('xpath=ancestor::td[1]');
  await expect(personRow.getByText('Acknowledgement outdated')).toBeVisible();
  const [rolesBounds, labRulesBounds, headerBounds, cellBounds, tagBounds] = await Promise.all([
    rolesHeader.boundingBox(),
    labRulesHeader.boundingBox(),
    statusHeader.boundingBox(),
    statusCell.boundingBox(),
    statusTag.boundingBox(),
  ]);
  if (!rolesBounds || !labRulesBounds || !headerBounds || !cellBounds || !tagBounds) {
    throw new Error('Could not measure the Directory table column alignment.');
  }
  expect(rolesBounds.x).toBeLessThan(labRulesBounds.x);
  expect(labRulesBounds.x).toBeLessThan(headerBounds.x);
  expect(await statusHeader.evaluate((element) => getComputedStyle(element).textAlign)).toBe('center');
  expect(Math.abs(
    (cellBounds.x + (cellBounds.width / 2)) - (tagBounds.x + (tagBounds.width / 2)),
  )).toBeLessThanOrEqual(1);
  await expect(personRow.getByLabel(`${role.name}, supervisor role`)).toHaveClass(/cds--tag--blue/);
});

test('opens responsive Directory filters for roles, Lab Rules, and account status', async ({ page }) => {
  const role = customRole();
  await installApi(page, {
    authenticated: true,
    role,
    user: currentUser([
      'people.read.all',
      'accounts.read',
      'roles.read',
      'laborordnung.requests.read',
    ]),
  });

  await page.goto('/people');
  const filterButton = page.getByRole('button', { name: 'Filters', exact: true });
  await expect(filterButton).toHaveAttribute('aria-expanded', 'false');
  await filterButton.click();
  await expect(filterButton).toHaveAttribute('aria-expanded', 'true');

  const filters = page.getByRole('region', { name: 'Directory filters' });
  const roleFilter = filters.getByRole('combobox', { name: 'Role' });
  const labRulesFilter = filters.getByRole('combobox', { name: 'Lab Rules' });
  const statusFilter = filters.getByRole('combobox', { name: 'Status' });
  await expect(roleFilter).toBeVisible();
  await expect(labRulesFilter).toBeVisible();
  await expect(statusFilter).toBeVisible();
  await expectNoHorizontalPageOverflow(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.app-main')).toHaveCSS('margin-inline-start', '0px');
  await expect(filters).toBeVisible();
  const [roleBounds, labRulesBounds, statusBounds] = await Promise.all([
    roleFilter.boundingBox(),
    labRulesFilter.boundingBox(),
    statusFilter.boundingBox(),
  ]);
  if (!roleBounds || !labRulesBounds || !statusBounds) {
    throw new Error('Could not measure the Directory filter layout.');
  }
  expect(Math.abs(roleBounds.x - labRulesBounds.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(labRulesBounds.x - statusBounds.x)).toBeLessThanOrEqual(1);
  expect(roleBounds.y).toBeLessThan(labRulesBounds.y);
  expect(labRulesBounds.y).toBeLessThan(statusBounds.y);
  await expectNoHorizontalPageOverflow(page);
  await expectNoSeriousAccessibilityViolations(page);
});

test('renders the Directory-styled Members table without summary statistics', async ({ page }) => {
  await installApi(page, {
    authenticated: true,
    supervisorDashboard: supervisorDashboard(),
    user: currentUser([
      'supervisor_dashboard.read',
      'people.read.all',
      'open_days.read',
    ]),
  });

  await page.goto('/people/staffing');
  const breadcrumbs = page.getByLabel('Breadcrumb');
  await expect(breadcrumbs.getByText('Members', { exact: true })).toBeVisible();
  await expect(breadcrumbs.getByText('Supervisor staffing', { exact: true })).toHaveCount(0);

  const tableContainer = page.locator('.people-table-container.supervisor-staffing-table');
  await expect(page.getByRole('heading', { name: 'Summary' })).toHaveCount(0);
  await expect(page.getByText('Member readiness')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Designated supervisors' })).toHaveCount(0);
  const toolbar = page.getByLabel('Members table toolbar');
  const directoryButton = page.getByRole('button', { name: 'Directory' });
  await expect(toolbar).toBeVisible();
  const periodSelector = toolbar.getByRole('combobox', { name: 'Open Days period' });
  await expect(periodSelector).toBeVisible();
  await expect(periodSelector).toHaveAttribute('title', 'Autumn Open Days');
  await expect(toolbar.getByRole('button', { name: 'Directory' })).toBeVisible();
  await expect(page.locator('.page-header').getByRole('button', { name: 'Directory' })).toHaveCount(0);
  await expect(directoryButton).toBeVisible();
  await expect(page.getByRole('columnheader', { name: /Member$/ })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: /Supervisor$/ })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: /Trainee$/ })).toBeVisible();
  const memberCells = page.getByRole('row', { name: /Grace Hopper/ }).getByRole('cell');
  await expect(memberCells.nth(3)).toHaveText('2');
  await expect(memberCells.nth(4)).toHaveText('1');
  const [periodSelectorBounds, directoryButtonBounds] = await Promise.all([
    periodSelector.boundingBox(),
    directoryButton.boundingBox(),
  ]);
  if (!periodSelectorBounds || !directoryButtonBounds) {
    throw new Error('Could not measure the Members toolbar controls.');
  }
  expect(Math.abs(periodSelectorBounds.y - directoryButtonBounds.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(periodSelectorBounds.height - directoryButtonBounds.height)).toBeLessThanOrEqual(1);
  const filterButton = toolbar.getByRole('button', { name: 'Filters' });
  await filterButton.click();
  const filters = page.getByRole('region', { name: 'Members filters' });
  await expect(filters.getByRole('combobox', { name: 'Profile picture' })).toBeVisible();
  await expect(filters.getByRole('combobox', { name: 'Lab Rules' })).toBeVisible();
  await expect(tableContainer.locator('.cds--pagination')).toBeVisible();
  await expect(tableContainer).toBeVisible();
  await expectNoHorizontalPageOverflow(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.app-main')).toHaveCSS('margin-inline-start', '0px');
  await expect(tableContainer).toBeVisible();
  await expectNoHorizontalPageOverflow(page);
  await expectNoSeriousAccessibilityViolations(page);
});

test('renders the responsive person detail hierarchy and functional tabs', async ({ page }) => {
  const role = customRole();
  const person = managedPerson(role);
  await installApi(page, {
    authenticated: true,
    person,
    makerspaceStatus: personMakerspaceStatus(),
    role,
    user: currentUser([
      'people.read.all',
      'people.read.matriculation',
      'people.update.all',
      'people.profile_image.update.all',
      'accounts.read',
      'accounts.password.reset',
      'people.roles.assign',
      'roles.read',
      'open_days.read_assignments',
      'laborordnung.requests.read',
    ]),
  });

  await page.goto(`/people/${person.id}`);
  await expect(page.getByRole('heading', { name: 'Grace Hopper' })).toBeVisible();
  await expect(page.locator('.page-header__tabs').getByRole('tablist', { name: 'Person detail sections' })).toBeVisible();
  await expect(page.locator('.page-shell__content').locator('.cds--tab-content')).toHaveCount(5);
  await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Overview' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Personal information' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Overview' }).click();
  await expect(page.getByRole('heading', { name: 'Profile picture', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Account access' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Makerspace status' })).toBeVisible();
  await expect(page.getByText(/Included in supervisor staffing through/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Supervisor staffing' })).toHaveCount(0);

  const cardBounds = async (heading: string) => {
    const headingLocator = page.getByRole('heading', { name: heading, exact: true });
    await expect(headingLocator).toBeVisible();
    const card = headingLocator.locator(
      'xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " person-detail-card ")][1]',
    );
    await expect(card).toBeVisible();
    const bounds = await card.boundingBox();
    if (!bounds) throw new Error(`Could not measure the ${heading} card.`);
    return bounds;
  };
  const [profile, accountAccess, personalInformation, authenticationMethods, roles] = await Promise.all([
    cardBounds('Profile picture'),
    cardBounds('Account access'),
    cardBounds('Personal information'),
    cardBounds('Authentication methods'),
    cardBounds('Roles'),
  ]);
  expect(Math.abs(profile.y - accountAccess.y)).toBeLessThanOrEqual(1);
  expect(Math.abs((profile.y + profile.height) - (accountAccess.y + accountAccess.height))).toBeLessThanOrEqual(1);
  expect(profile.height).toBeLessThanOrEqual(260);
  const actionsButton = await page.getByRole('button', { name: 'Actions', exact: true }).boundingBox();
  if (!actionsButton) throw new Error('Could not measure the page Actions button.');
  expect(Math.abs(
    (actionsButton.x + actionsButton.width) - (accountAccess.x + accountAccess.width),
  )).toBeLessThanOrEqual(1);
  expect(accountAccess.x - (profile.x + profile.width)).toBeGreaterThanOrEqual(16);
  expect(Math.abs(profile.x - personalInformation.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(accountAccess.x - authenticationMethods.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(personalInformation.y - authenticationMethods.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(
    (personalInformation.y + personalInformation.height) - (roles.y + roles.height),
  )).toBeLessThanOrEqual(1);

  const profileCard = page
    .getByRole('heading', { name: 'Profile picture', exact: true })
    .locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " person-detail-card ")][1]');
  const [profileHeading, profileAvatar, profileEdit, accountHeading] = await Promise.all([
    profileCard.getByRole('heading', { name: 'Profile picture', exact: true }).boundingBox(),
    profileCard.locator('.person-detail-card__heading-content .person-avatar').boundingBox(),
    profileCard.getByRole('button', { name: 'Edit', exact: true }).boundingBox(),
    page.getByRole('heading', { name: 'Account access', exact: true }).boundingBox(),
  ]);
  if (!profileHeading || !profileAvatar || !profileEdit || !accountHeading) {
    throw new Error('Could not measure the compact Profile picture header.');
  }
  const profileHeadingCenter = profileHeading.x + (profileHeading.width / 2);
  const profileAvatarCenter = profileAvatar.x + (profileAvatar.width / 2);
  const profileAvatarMiddle = profileAvatar.y + (profileAvatar.height / 2);
  const profileEditCenter = profileEdit.x + (profileEdit.width / 2);
  expect(profileHeadingCenter).toBeLessThan(profileAvatarCenter);
  expect(profileAvatarCenter).toBeLessThan(profileEditCenter);
  expect(Math.abs(profileAvatarCenter - (profile.x + (profile.width / 2)))).toBeLessThanOrEqual(1);
  expect(Math.abs(profileAvatarMiddle - (profile.y + (profile.height / 2)))).toBeLessThanOrEqual(1);
  await expect(profileCard.getByText('Grace Hopper', { exact: true })).toHaveCount(0);
  expect(Math.abs(profileHeading.y - accountHeading.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(
    (profileEdit.y + (profileEdit.height / 2)) - (accountHeading.y + (accountHeading.height / 2)),
  )).toBeLessThanOrEqual(8);

  await page.getByRole('tab', { name: 'Personal information' }).click();
  await expect(page.getByRole('heading', { name: 'Profile picture', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Personal information', exact: true })).toBeVisible();
  const [focusedProfile, focusedPersonalInformation] = await Promise.all([
    cardBounds('Profile picture'),
    cardBounds('Personal information'),
  ]);
  expect(Math.abs(focusedProfile.x - profile.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(focusedProfile.width - profile.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(focusedPersonalInformation.x - accountAccess.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(focusedPersonalInformation.width - accountAccess.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(focusedProfile.y - focusedPersonalInformation.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(
    (focusedProfile.y + focusedProfile.height) -
    (focusedPersonalInformation.y + focusedPersonalInformation.height),
  )).toBeLessThanOrEqual(1);

  await page.getByRole('tab', { name: 'Account access' }).click();
  await expect(page).toHaveURL(new RegExp(`/people/${person.id}\\?tab=account-access$`));
  await page.getByRole('button', { name: 'Actions for Local password' }).click();
  await expect(page.getByRole('menuitem', { name: 'Send reset code' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('tab', { name: 'Makerspace status' }).click();
  await expect(page.getByRole('heading', { name: 'Lab Rules' })).toBeVisible();
  await expect(page.getByText('Autumn Open Days')).toBeVisible();
  await expectNoHorizontalPageOverflow(page);
  await expectNoSeriousAccessibilityViolations(page);
});

test('keeps multiple page actions aligned without desktop overflow', async ({ page }) => {
  await installApi(page, {
    authenticated: true,
    openDayPeriods: [],
    user: currentUser(['open_days.read', 'open_days.manage']),
  });

  await page.goto('/open-days');
  const actions = page.locator('.page-header__actions');
  await expect(actions.getByRole('button', { name: 'Manage periods' })).toBeVisible();
  await expect(actions.getByRole('button', { name: 'New period' })).toBeVisible();
  await expect(actions.getByRole('button')).toHaveCount(2);
  await expectShellHeaderAndContentAligned(page);
  await expectNoHorizontalPageOverflow(page);
});

test('wraps a long breadcrumb title and action menu at 390px without page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const person = {
    ...managedPerson(),
    firstName: 'Grace Alexandra Extremely-Long',
    lastName: 'Hopper-Murray-Researcher',
  };
  await installApi(page, {
    authenticated: true,
    person,
    user: currentUser(['people.read.all', 'people.update.all']),
  });

  await page.goto(`/people/${person.id}`);
  const title = page.locator('.page-header__title');
  const actions = page.locator('.page-header__actions');
  const [titleBounds, actionsBounds] = await Promise.all([
    title.boundingBox(),
    actions.boundingBox(),
  ]);
  if (!titleBounds || !actionsBounds) throw new Error('Could not measure the mobile page header.');
  expect(actionsBounds.y).toBeGreaterThanOrEqual(titleBounds.y + titleBounds.height);
  await expect(page.getByLabel('Breadcrumb').getByText(/Grace Alexandra/)).toBeVisible();
  await expect(actions.getByRole('button', { name: 'Actions' })).toBeVisible();
  await expectNoHorizontalPageOverflow(page);
});

test('keeps the page header readable over light, dark, and detailed backgrounds', async ({ page }) => {
  const state: ApiState = { authenticated: true, user: currentUser() };
  await installApi(page, state);
  const base = defaultPublicBrandingConfiguration();
  const backgrounds = [
    {
      name: 'light',
      color: '#f4f4f4',
      image: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#f4f4f4"/></svg>',
    },
    {
      name: 'dark',
      color: '#080808',
      image: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#080808"/></svg>',
    },
    {
      name: 'detailed',
      color: '#111621',
      image: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#111621"/><path d="M0 0L80 80M80 0L0 80M40 0V80M0 40H80" stroke="#ffbf3d" stroke-width="5"/><circle cx="40" cy="40" r="18" fill="#57569f"/></svg>',
    },
  ];

  for (const [index, background] of backgrounds.entries()) {
    const imageUrl = `data:image/svg+xml;base64,${Buffer.from(background.image).toString('base64')}`;
    state.publicBranding = {
      ...base,
      colors: { ...base.colors, background: background.color },
      assets: { ...base.assets, applicationBackgroundUrl: imageUrl },
      version: index + 10,
    };

    await page.goto(`/dashboard?background=${background.name}`);
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect.poll(() => page.evaluate(() =>
      document.documentElement.style.getPropertyValue('--app-background-image'),
    )).toContain('data:image/svg+xml');

    const header = page.locator('.page-shell > .page-header');
    const main = page.locator('#main-content');
    const [headerBounds, mainBounds, headerBackground] = await Promise.all([
      header.boundingBox(),
      main.boundingBox(),
      header.evaluate((element) => getComputedStyle(element).backgroundColor),
    ]);
    if (!headerBounds || !mainBounds) throw new Error('Could not measure the branded page frame.');
    expect(headerBackground).toBe('rgba(255, 255, 255, 0.94)');
    expect(headerBounds.x).toBeGreaterThan(mainBounds.x);
    expect(headerBounds.width).toBeLessThan(mainBounds.width);

    const contrast = await new AxeBuilder({ page })
      .include('.page-header')
      .withRules(['color-contrast'])
      .analyze();
    expect(contrast.violations).toEqual([]);
  }
});

test('collapses and opens the SideNav at the responsive breakpoint', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installApi(page, { authenticated: true, user: currentUser() });

  await page.goto('/dashboard');
  const menuButton = page.getByRole('button', { name: 'Open navigation' });
  await expect(menuButton).toBeVisible();
  await menuButton.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Close navigation' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
});

test('shows an accessible destructive confirmation before deleting a custom role', async ({ page }) => {
  const role = customRole();
  await installApi(page, {
    authenticated: true,
    role,
    user: currentUser(role.permissionGrants.map((grant) => grant.permissionId)),
  });

  await page.goto('/settings/roles');
  await expect(page.getByRole('heading', { name: 'Roles & Permissions' })).toBeVisible();
  await page.getByRole('tab', { name: 'Effective permissions' }).click();
  await expect(page.getByRole('button', { name: /View View all people for Workshop supervisors: Granted in this context/ })).toBeVisible();
  await page.getByRole('tab', { name: 'Configuration' }).click();
  await page.getByRole('button', { name: `Actions for ${role.name}` }).click();
  await page.getByRole('menuitem', { name: 'Delete role' }).click();

  await expect(page.getByRole('heading', { name: 'Delete role?' })).toBeVisible();
  await expect(page.getByText(/This cannot be undone/)).toBeVisible();
  await expect(page.getByRole('dialog').locator(':focus')).toHaveCount(1);
  await expectNoSeriousAccessibilityViolations(page);

  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('heading', { name: 'Delete role?' })).toBeHidden();
  await expect(page).toHaveURL(/\/settings\/roles$/);
});

test('redirects to sign in when an authenticated request reports session expiry', async ({ page }) => {
  const state: ApiState = {
    authenticated: true,
    expirePasswordChange: true,
    user: currentUser(['people.update.self']),
  };
  await installApi(page, state);

  await page.goto('/profile');
  await page.getByRole('button', { name: 'Actions for Local password' }).click();
  await page.getByRole('menuitem', { name: 'Change password' }).click();
  const passwordModal = page.getByRole('dialog', { name: 'Change password' });
  await expect(passwordModal).toBeVisible();
  await passwordModal.getByLabel('Current password').fill('old password value');
  await passwordModal
    .getByLabel('New password', { exact: true })
    .fill('correct horse battery staple');
  await passwordModal.getByLabel('Confirm new password').fill('correct horse battery staple');
  await passwordModal.getByRole('button', { name: 'Change password' }).click();

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});
