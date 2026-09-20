import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('clears a completed terminal enrollment before the next visitor', async ({ page }, testInfo) => {
  const errors: Error[] = [];
  page.on('pageerror', (error) => errors.push(error));
  let contexts = 0;
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/visitor-enrollment/context')) {
      contexts += 1;
      await route.fulfill({ status: 204 });
    } else if (path.endsWith('/visitor-enrollment/state')) {
      await route.fulfill({ json: { allowedMethods: ['pin'], currentLabRules: { id: '0192f6f8-743e-7c77-a349-cd07c3e8ab01', humanRevision: '2026-09', effectiveAt: '2026-09-01T00:00:00Z' }, expiresAt: '2030-01-01T00:00:00Z' } });
    } else if (path.endsWith('/visitor-enrollment/submissions')) {
      await route.fulfill({ status: 201, json: { personId: '0192f6f8-743e-7c77-a349-cd07c3e8ab02', accountId: '0192f6f8-743e-7c77-a349-cd07c3e8ab03', accountStatus: 'enabled', invitationDelivery: null, labRulesRequestId: null, admission: 'admitted' } });
    } else {
      await route.fulfill({ status: 401, json: { code: 'invalid_session', message: 'Sign in required' } });
    }
  });
  await page.goto('/visitor-enrollment');
  await page.getByLabel('First name', { exact: true }).fill('Local');
  await page.getByLabel('Last name', { exact: true }).fill('Visitor');
  await page.getByLabel('Email', { exact: true }).fill('local@example.test');
  await page.getByText('Username and PIN', { exact: true }).click();
  await page.getByLabel('PIN login username', { exact: true }).fill('local.visitor');
  await page.getByLabel('PIN (6–12 digits)', { exact: true }).fill('654321');
  await page.getByLabel('or upload a profile photo', { exact: true }).setInputFiles({ name: 'photo.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
  await page.getByText('I am ready to sign the physical Lab Rules document and request supervisor confirmation', { exact: true }).click();
  await page.getByRole('button', { name: 'Submit enrollment and request confirmation' }).click();
  await expect(page.getByRole('heading', { name: 'Enrollment submitted' })).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('visitor-submitted.png'), fullPage: true });
  const priorContexts = contexts;
  await page.getByRole('button', { name: 'Next visitor' }).click();
  await expect(page.getByLabel('First name', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Username and PIN', { exact: true })).not.toBeChecked();
  await expect(page.getByAltText('Selected profile')).toHaveCount(0);
  expect(contexts).toBeGreaterThan(priorContexts);
  await page.setViewportSize({ width: 390, height: 844 });
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('visitor-next-mobile.png'), fullPage: true });
  expect(errors).toEqual([]);
});
