import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import { defaultPublicBrandingConfiguration } from './branding-fixtures';
import { welcomeTourSeen } from './guide-progress';

const personId = '0192f6f8-743e-7c77-a349-cd07c3e8d009';
const accountId = '0192f6f8-743e-7c77-a349-cd07c3e8d010';
const passwordIdentityId = '0192f6f8-743e-7c77-a349-cd07c3e8d011';
const embedId = '0192f6f8-743e-7c77-a349-cd07c3e8d101';
const machineId = '0192f6f8-743e-7c77-a349-cd07c3e8d102';
const sceneId = '0192f6f8-743e-7c77-a349-cd07c3e8d104';
const timestamp = '2026-11-09T12:00:00Z';

function currentUser(permissions: string[]) {
  const account = {
    id: accountId,
    personId,
    loginEmail: 'ada.login@example.test',
    emailCodeEnabled: false,
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

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations).toEqual([]);
}

const embedOf = (overrides: Record<string, unknown> = {}) => ({
  id: embedId,
  name: 'Open days on the student council site',
  aspectRatio: { width: 16, height: 9 },
  groupId: null,
  defaultScenes: [],
  embedKey: 'k7Hq2pX9wLm4k7Hq2pX9wLm4k7Hq2pX9',
  embedUrl: 'https://core.example/embed/k7Hq2pX9wLm4k7Hq2pX9wLm4k7Hq2pX9',
  allowedOrigins: ['https://fachschaft-muster.example'],
  openDirectly: false,
  enabled: true,
  cameraEnabled: false,
  cameraMachineIds: [],
  cameraViewerLimit: 10,
  timelapseEnabled: false,
  timelapseCount: 5,
  timelapseMaxAgeDays: 14,
  publishedRevision: 2,
  publishedAt: timestamp,
  pendingChanges: [],
  hasUnpublishedChanges: false,
  lastLoadedAt: null,
  loadsToday: 0,
  version: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
  ...overrides,
});

type Recorded = { method: string; path: string; body: unknown };

/** Mocks the API for the web embed screens; `embeds` is the live list and the recorded writes update it. */
async function mockApi(page: Page, permissions: string[]) {
  const embeds = [embedOf()];
  const writes: Recorded[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path === '/api/v1/notifications/unread-count') return json(route, { unreadCount: 0, fresh: [], pinned: [] });
    if (path === '/api/v1/auth/activity' && method === 'POST')
      return json(route, {
        idleExpiresAt: '2099-01-01T01:00:00Z',
        absoluteExpiresAt: '2099-01-02T00:00:00Z',
        postSessionDestination: 'login',
      });
    if (path === '/api/v1/public/config') return json(route, defaultPublicBrandingConfiguration());
    if (path === '/api/v1/auth/oidc/providers') return json(route, { items: [] });
    if (path === '/api/v1/auth/me') return json(route, currentUser(permissions));
    if (path === '/api/v1/me/guides') return route.fulfill({ json: welcomeTourSeen });
    if (path === '/api/v1/signage/web-embeds' && method === 'GET') return json(route, { items: embeds });
    if (path === '/api/v1/signage/web-embeds' && method === 'POST') {
      const body = request.postDataJSON();
      writes.push({ method, path, body });
      const created = embedOf({
        id: '0192f6f8-743e-7c77-a349-cd07c3e8d103',
        name: body.name,
        allowedOrigins: body.allowedOrigins,
        publishedRevision: null,
      });
      embeds.push(created);
      return json(route, created, 201);
    }
    const match = /^\/api\/v1\/signage\/web-embeds\/([^/]+)$/.exec(path);
    if (match) {
      const embed = embeds.find((item) => item.id === match[1]);
      if (!embed) return json(route, { code: 'not_found', message: 'Not found', requestId: 'r' }, 404);
      if (method === 'PATCH') {
        const body = request.postDataJSON();
        writes.push({ method, path, body });
        const changes = { ...body };
        delete changes.expectedVersion;
        Object.assign(embed, changes, { version: embed.version + 1 });
      }
      return json(route, embed);
    }
    if (/^\/api\/v1\/signage\/displays\/[^/]+\/rules$/.test(path))
      return json(route, { items: [], ownerVersion: embeds[0].version });
    if (/^\/api\/v1\/signage\/displays\/[^/]+\/preview$/.test(path))
      return json(route, { code: 'not_found', message: 'Not found', requestId: 'r' }, 404);
    if (path === '/api/v1/signage/machines')
      return json(route, { items: [{ id: machineId, name: 'Prusa CORE One', kind: 'printer', hasCamera: true }] });
    if (path === '/api/v1/signage/scenes')
      return json(route, {
        items: [
          {
            id: sceneId,
            name: 'Printer status',
            aspectRatio: { width: 16, height: 9 },
            backgroundColor: '#161616',
            backgroundAssetId: null,
            backgroundFit: 'cover',
            backgroundDim: 0,
            fontFamily: 'sans',
            fontAssetId: null,
            theme: 'dark',
            blocks: [],
            version: 1,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
      });
    if (path === '/api/v1/signage/groups' || path === '/api/v1/signage/displays') return json(route, { items: [] });
    if (path === '/api/v1/signage/announcement-templates' || path === '/api/v1/signage/custom-layouts')
      return json(route, { items: [] });
    if (path === '/api/v1/signage/assets') return json(route, { items: [] });
    if (path === '/api/v1/signage/calendar') return json(route, { openDays: [], events: [], calendar: null });
    throw new Error(`Unexpected API request: ${method} ${path}`);
  });
  return { writes };
}

const staff = ['signage.read', 'signage.manage', 'signage.publish'];

test('lists web embeds, creates one and shows its embed code', async ({ page }) => {
  const { writes } = await mockApi(page, staff);
  await page.goto('/signage/embeds');
  await expect(page.getByRole('heading', { name: 'Web embeds', level: 1 })).toBeVisible();
  const table = page.getByRole('table', { name: 'Web embeds' });
  await expect(table.getByRole('row', { name: /Open days on the student council site/ })).toContainText(
    'Public information only',
  );
  await expectAccessible(page);

  await page.getByRole('button', { name: 'New web embed' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('Printer wall');
  await dialog.getByLabel('Website').fill('https://blog.example/news');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog.getByText("Enter the website's https address without a path.")).toBeVisible();
  await dialog.getByLabel('Website').fill('https://blog.example');
  await dialog.getByLabel('Scene 1').selectOption('Printer status');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: 'Printer wall', level: 1 })).toBeVisible();
  expect(writes[0].body).toMatchObject({
    name: 'Printer wall',
    aspectRatio: { width: 16, height: 9 },
    allowedOrigins: ['https://blog.example'],
    defaultScenes: [{ sceneId, seconds: 20, transition: 'fade' }],
  });

  await page.getByRole('tab', { name: 'Embed code' }).click();
  await expect(page.getByText('referrerpolicy="strict-origin"')).toBeVisible();
  await expect(page.getByText('aspect-ratio:16/9;border:0')).toBeVisible();
});

test('refuses to remove the last website and asks before cameras are shown', async ({ page }) => {
  const { writes } = await mockApi(page, staff);
  await page.goto(`/signage/embeds/${embedId}`);
  await page.getByRole('tab', { name: 'Websites' }).click();
  await expect(page.getByRole('button', { name: /Remove https:\/\/fachschaft-muster\.example/ })).toBeDisabled();

  await page.getByRole('tab', { name: 'Data shown' }).click();
  await page.locator('label[for="embed-camera"]').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Allow cameras' })).toBeDisabled();
  await dialog.getByText(/The cameras point at the print beds/).click();
  await dialog.getByRole('button', { name: 'Allow cameras' }).click();
  await expect(page.getByRole('checkbox', { name: 'Prusa CORE One' })).toBeChecked();
  expect(writes.at(-1)?.body).toEqual({
    expectedVersion: 1,
    cameraEnabled: true,
    cameraMachineIds: [machineId],
  });
});

test('shows no manage or publish controls without the permissions', async ({ page }) => {
  await mockApi(page, ['signage.read']);
  await page.goto('/signage/embeds');
  await expect(page.getByRole('table', { name: 'Web embeds' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New web embed' })).toHaveCount(0);
  await page.goto(`/signage/embeds/${embedId}`);
  await expect(page.getByRole('heading', { name: 'Open days on the student council site', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Turn off' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Publish changes' })).toHaveCount(0);
});
