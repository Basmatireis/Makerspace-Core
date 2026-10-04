import { expect, test, type Route } from '@playwright/test';

const personId = '0192f6f8-743e-7c77-a349-cd07c3e8c001';
const accountId = '0192f6f8-743e-7c77-a349-cd07c3e8c002';

function currentUser() {
  const account = { id: accountId, personId, loginEmail: 'brand.admin@example.test', provisioningSource: 'local', firstAuthenticatedAt: '2026-10-03T10:00:00Z', authIdentities: [], status: 'enabled', passwordStatus: 'active', roles: [], createdAt: '2026-10-03T10:00:00Z', updatedAt: '2026-10-03T10:00:00Z', version: 1 };
  return {
    person: { id: personId, firstName: 'Brand', lastName: 'Administrator', email: 'brand.admin@example.test', phone: null, account, createdAt: '2026-10-03T10:00:00Z', updatedAt: '2026-10-03T10:00:00Z', version: 1 },
    account,
    permissions: ['branding.manage'],
    authenticationAssurance: 'normal', managedDevice: null,
    delegablePermissionGrants: [{ permissionId: 'branding.manage', scope: 'everywhere', deviceTypeIds: [], minimumAssurance: 'low' }],
    laborordnungStatus: { mode: 'not_required', state: 'not_required', actionRequired: false, currentVersion: null, latestConfirmedVersion: null, requestId: null },
  };
}

function defaultAsset(slot: string, url: string) {
  return { slot, mode: 'default', url, originalFilename: null, contentType: null, sizeBytes: null, updatedAt: null };
}

function initialConfiguration() {
  return {
    identity: { legalOrganizationName: 'HTU Graz', displayName: 'Makerspace', applicationName: 'HTU Graz Makerspace', tagline: null },
    colors: { primary: '#57569f', secondary: '#ffbf3d', accent: '#e76f12', background: '#111621' },
    assets: {
      logo: defaultAsset('logo', '/brand/htumkr-symbol.png'),
      compactLogo: defaultAsset('compact_logo', '/brand/htumkr-symbol.png'),
      favicon: defaultAsset('favicon', '/brand/htumkr-symbol.png'),
      applicationBackground: defaultAsset('application_background', '/brand/blueprint-workshop.jpg'),
      authenticationBackground: defaultAsset('authentication_background', '/brand/blueprint-details.jpg'),
    },
    imprint: { mode: 'internal', markdown: '', externalUrl: '' },
    privacy: { mode: 'internal', markdown: '', externalUrl: '' },
    version: 1,
    updatedAt: '2026-10-03T10:00:00Z',
  };
}

function publicConfiguration(configuration: ReturnType<typeof initialConfiguration>) {
  const assetURL = (asset: { url: string | null }) => asset.url;
  return {
    identity: configuration.identity,
    colors: configuration.colors,
    assets: {
      logoUrl: assetURL(configuration.assets.logo), compactLogoUrl: assetURL(configuration.assets.compactLogo), faviconUrl: assetURL(configuration.assets.favicon),
      applicationBackgroundUrl: assetURL(configuration.assets.applicationBackground), authenticationBackgroundUrl: assetURL(configuration.assets.authenticationBackground),
    },
    legal: { imprint: { mode: configuration.imprint.mode, href: '/legal/imprint' }, privacy: { mode: configuration.privacy.mode, href: '/legal/privacy' } },
    version: configuration.version,
  };
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

test('rebrands without a rebuild, cache-busts replaced assets, and exposes legal content anonymously', async ({ page }) => {
  let configuration = initialConfiguration();
  let uploaded = 0;

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === '/api/v1/public/config' && request.method() === 'GET') return json(route, publicConfiguration(configuration));
    if (path === '/api/v1/public/legal/imprint' && request.method() === 'GET') return json(route, { kind: 'imprint', title: 'Imprint', mode: 'internal', markdown: configuration.imprint.markdown, externalUrl: null });
    if (path === '/api/v1/auth/me' && request.method() === 'GET') return json(route, currentUser());
    if (path === '/api/v1/branding/configuration' && request.method() === 'GET') return json(route, configuration);
    if (path === '/api/v1/branding/configuration' && request.method() === 'PUT') {
      const body = request.postDataJSON();
      expect(body.expectedVersion).toBe(configuration.version);
      configuration = { ...configuration, identity: body.identity, colors: body.colors, imprint: body.imprint, privacy: body.privacy, version: configuration.version + 1, updatedAt: '2026-10-03T10:01:00Z' };
      return json(route, configuration);
    }
    if (path === '/api/v1/branding/assets/logo' && request.method() === 'PUT') {
      expect(Number(url.searchParams.get('expectedVersion'))).toBe(configuration.version);
      expect(request.headers()['content-type']).toBe('application/octet-stream');
      expect(request.postDataBuffer()?.toString()).toBe(uploaded === 0 ? 'first-logo' : 'second-logo');
      uploaded += 1;
      const digest = String(uploaded).repeat(64);
      configuration = {
        ...configuration,
        version: configuration.version + 1,
        updatedAt: `2026-10-03T10:0${uploaded + 1}:00Z`,
        assets: { ...configuration.assets, logo: { slot: 'logo', mode: 'custom', url: `/api/v1/public/branding/assets/logo/${digest}`, originalFilename: request.headers()['x-file-name'] ?? 'logo.png', contentType: 'image/png', sizeBytes: request.postDataBuffer()?.length ?? 0, updatedAt: '2026-10-03T10:02:00Z' } },
      };
      return json(route, configuration);
    }
    if (path.startsWith('/api/v1/public/branding/assets/logo/') && request.method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('mock-image') });
      return;
    }
    throw new Error(`Unexpected API request: ${request.method()} ${path}`);
  });

  await page.goto('/settings/branding-legal');
  await page.getByLabel('Legal organization name').fill('Open Workshop Association');
  await page.getByLabel('Display name').fill('Open Workshop');
  await page.getByLabel('Application name').fill('Open Workshop Portal');
  await page.getByLabel('Primary color picker').fill('#123456');
  await expect(page.getByLabel('Primary', { exact: true })).toHaveValue('#123456');
  await page.getByLabel('Primary', { exact: true }).fill('#654321');
  await expect(page.getByLabel('Primary color picker')).toHaveValue('#654321');
  await page.getByRole('tab', { name: 'Legal' }).click();
  await page.getByLabel('Markdown', { exact: true }).first().fill('# Publisher\n\nOpen Workshop Association');
  await page.getByRole('button', { name: 'Save configuration' }).click();
  await expect(page).toHaveTitle(/Open Workshop Portal/);
  await page.getByLabel('Markdown', { exact: true }).first().fill('# Publisher\n\nOpen Workshop Association\n');
  const saveButton = page.getByRole('button', { name: 'Save configuration' });
  await expect(saveButton).toBeEnabled();
  await expect.poll(() => saveButton.evaluate((element) => getComputedStyle(element).getPropertyValue('--cds-button-primary').trim())).toBe('#654321');
  expect(await saveButton.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe('rgb(15, 98, 254)');

  await page.reload();
  await expect(page.getByLabel('Display name')).toHaveValue('Open Workshop');
  await expect(page).toHaveTitle(/Open Workshop Portal/);

  await page.getByRole('tab', { name: 'Assets' }).click();
  const logoUpload = page.getByLabel('Choose or drop an image').first();
  await logoUpload.setInputFiles({ name: 'logo-one.png', mimeType: 'image/png', buffer: Buffer.from('first-logo') });
  await page.getByRole('button', { name: 'Upload selected' }).first().click();
  const firstURL = configuration.assets.logo.url;
  await expect(page.getByText('Saved file: logo-one.png')).toBeVisible();

  await logoUpload.setInputFiles({ name: 'logo-two.png', mimeType: 'image/png', buffer: Buffer.from('second-logo') });
  await page.getByRole('button', { name: 'Upload selected' }).first().click();
  await expect(page.getByText('Saved file: logo-two.png')).toBeVisible();
  expect(configuration.assets.logo.url).not.toBe(firstURL);

  await page.context().clearCookies();
  await page.goto('/legal/imprint');
  await expect(page.getByRole('heading', { name: 'Publisher' })).toBeVisible();
  await expect(page.getByRole('paragraph').filter({ hasText: 'Open Workshop Association' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to sign in' })).toBeVisible();
});
