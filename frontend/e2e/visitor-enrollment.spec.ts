import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// A real one-page PDF (pdf.js tolerates the missing xref, so offsets need not be exact).
const labRulesPdf = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R>>endobj\n' +
    '4 0 obj<</Length 36>>stream\n0 0 0 rg 20 20 160 160 re f\nendstream\nendobj\n' +
    'trailer<</Root 1 0 R/Size 5>>\n%%EOF\n',
);

test('clears a completed kiosk enrollment before the next visitor', async ({ page }, testInfo) => {
  // Carbon button transitions would let the accessibility scan measure half-faded colours.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors: Error[] = [];
  page.on('pageerror', (error) => errors.push(error));
  let contexts = 0;
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/visitor-enrollment/context')) {
      contexts += 1;
      await route.fulfill({ status: 204 });
    } else if (path.endsWith('/visitor-enrollment/state')) {
      await route.fulfill({
        json: {
          allowedMethods: ['pin'],
          currentLabRules: {
            id: '0192f6f8-743e-7c77-a349-cd07c3e8ab01',
            humanRevision: '2026-09',
            effectiveAt: '2026-09-01T00:00:00Z',
          },
          expiresAt: '2030-01-01T00:00:00Z',
        },
      });
    } else if (path.endsWith('/visitor-enrollment/lab-rules.pdf')) {
      await route.fulfill({ contentType: 'application/pdf', body: labRulesPdf });
    } else if (path.endsWith('/visitor-enrollment/submissions')) {
      await route.fulfill({
        status: 201,
        json: {
          personId: '0192f6f8-743e-7c77-a349-cd07c3e8ab02',
          accountId: '0192f6f8-743e-7c77-a349-cd07c3e8ab03',
          accountStatus: 'enabled',
          invitationDelivery: null,
          labRulesRequestId: null,
          admission: 'admitted',
          attendance: 'checked_in',
        },
      });
    } else {
      await route.fulfill({ status: 401, json: { code: 'invalid_session', message: 'Sign in required' } });
    }
  });
  await page.goto('/visitor-enrollment');
  await expect(page.getByRole('heading', { name: 'About you' })).toBeFocused();
  await page.getByLabel('First name', { exact: true }).fill('Local');
  await page.getByLabel('Last name', { exact: true }).fill('Visitor');
  await page.getByLabel('Email', { exact: true }).fill('local@example.test');
  await page
    .getByLabel('or upload a profile photo', { exact: true })
    .setInputFiles({ name: 'photo.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
  await expect(page.getByAltText('Selected profile')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next' })).toBeEnabled();
  await page.mouse.move(0, 0);
  // The whole step fits the viewport: the page itself never scrolls.
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('visitor-step-1.png') });
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Sign-in method' })).toBeFocused();
  await page.getByLabel('PIN login username', { exact: true }).fill('local.visitor');
  await page.getByLabel('PIN (6–12 digits)', { exact: true }).fill('654321');
  await page.screenshot({ path: testInfo.outputPath('visitor-step-2.png') });
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Lab Rules' })).toBeFocused();
  await page.getByRole('button', { name: 'View current Lab Rules PDF' }).click();
  const rules = page.getByRole('dialog', { name: 'Lab Rules, revision 2026-09' });
  await expect(rules.getByRole('img', { name: 'Page 1 of 1' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('visitor-lab-rules-pdf.png') });
  await page.keyboard.press('Escape');
  await expect(rules).toBeHidden();
  await page.getByText(/I am ready to sign the physical Lab Rules document/).click();
  await page.screenshot({ path: testInfo.outputPath('visitor-step-3.png') });
  await page.getByRole('button', { name: 'Submit enrollment' }).click();
  await expect(page.getByRole('heading', { name: 'Local, your account is ready.' })).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('visitor-submitted.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('visitor-submitted-mobile.png'), fullPage: true });
  expect(contexts).toBe(1);
  expect(errors).toEqual([]);
});
