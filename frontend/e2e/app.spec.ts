import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';

type ApiState = {
  authenticated: boolean;
  expirePasswordChange?: boolean;
  role?: ReturnType<typeof customRole>;
  user?: ReturnType<typeof currentUser>;
};

const personId = '0192f6f8-743e-7c77-a349-cd07c3e8a901';
const accountId = '0192f6f8-743e-7c77-a349-cd07c3e8a902';
const roleId = '0192f6f8-743e-7c77-a349-cd07c3e8a903';
const pageErrors = new WeakMap<Page, Error[]>();
const passwordIdentityId = '0192f6f8-743e-7c77-a349-cd07c3e8a904';

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
      account: {
        id: accountId,
        personId,
        loginEmail: 'ada.login@example.test',
        provisioningSource: 'local',
        firstAuthenticatedAt: '2026-01-01T00:00:00Z',
        authIdentities: [{ id: passwordIdentityId, kind: 'password', displayIdentifier: 'ada.login@example.test', verifiedAt: '2026-01-01T00:00:00Z', disabledAt: null, createdAt: '2026-01-01T00:00:00Z' }],
        status: 'enabled',
        passwordStatus: 'active',
        roles: [],
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
      authIdentities: [{ id: passwordIdentityId, kind: 'password', displayIdentifier: 'ada.login@example.test', verifiedAt: '2026-01-01T00:00:00Z', disabledAt: null, createdAt: '2026-01-01T00:00:00Z' }],
      status: 'enabled',
      passwordStatus: 'active',
      roles: [],
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

    throw new Error(`Unexpected API request: ${request.method()} ${path}`);
  });
}

async function expectNoSeriousAccessibilityViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
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
  await expect(page.getByText('Welcome, Ada.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Administration' })).toBeVisible();
  const skipLink = page.getByRole('link', { name: 'Skip to main content' });
  await expect(skipLink).toHaveAttribute('href', '#main-content');
  await skipLink.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();
  await expectNoSeriousAccessibilityViolations(page);
});

test('shows only authorized settings tools and exposes self-service profile access', async ({ page }) => {
  await installApi(page, {
    authenticated: true,
    user: currentUser(['people.read.all', 'people.update.self']),
  });

  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Roles' })).toHaveCount(0);
  await expectNoSeriousAccessibilityViolations(page);

  const profileMenuButton = page.getByRole('button', {
    name: 'Open profile menu for Ada Lovelace',
  });
  await profileMenuButton.click();
  await expect(
    page.getByRole('button', { name: 'Close profile menu for Ada Lovelace' }),
  ).toBeVisible();
  await expect(page.getByText('ada.login@example.test')).toBeVisible();
  await page.getByRole('button', { name: 'View profile' }).focus();
  await page.keyboard.press('Escape');
  await expect(profileMenuButton).toBeFocused();

  await profileMenuButton.click();
  await page.getByRole('button', { name: 'View profile' }).click();

  await expect(page).toHaveURL(/\/profile$/);
  await expect(page.getByRole('heading', { name: 'Profile', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit profile' })).toBeVisible();
  await expect(page.getByText('Matriculation number')).toHaveCount(0);
  await expectNoSeriousAccessibilityViolations(page);
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
  await page.getByLabel('Current password').fill('old password value');
  await page
    .getByLabel('New password', { exact: true })
    .fill('correct horse battery staple');
  await page.getByLabel('Confirm new password').fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Change password' }).click();

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});
