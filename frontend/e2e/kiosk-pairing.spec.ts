import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { defaultPublicBrandingConfiguration } from './branding-fixtures';

async function installUnregisteredKioskApi(page: Page) {
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/v1/public/config') return route.fulfill({ json: defaultPublicBrandingConfiguration() });
    if (path === '/api/v1/terminal/context')
      return route.fulfill({ status: 404, json: { code: 'not_found', message: 'Not found' } });
    if (path === '/api/v1/public/managed-devices/pairing' && request.method() === 'POST') {
      expect(request.postDataJSON()).toEqual({ credentialDelivery: 'bindBrowser' });
      return route.fulfill({
        status: 201,
        json: { code: 'K7F2QX', expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() },
      });
    }
    if (path === '/api/v1/public/managed-devices/pairing' && request.method() === 'GET')
      return route.fulfill({ json: { status: 'pending' } });
    throw new Error(`Unexpected API request: ${request.method()} ${path}`);
  });
}

test('an unregistered kiosk browser shows its pairing code at desktop and phone width', async ({ page }) => {
  await installUnregisteredKioskApi(page);
  await page.goto('/kiosk');
  await expect(page.getByRole('heading', { name: 'This browser is not registered as a kiosk' })).toBeVisible();
  await expect(page.getByLabel('Pairing code K 7 F 2 Q X')).toHaveText('K7F2QX');
  await expect(page.getByText(/Settings › Devices & sessions › Pair device/)).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations).toEqual([]);

  await page.setViewportSize({ width: 320, height: 640 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
