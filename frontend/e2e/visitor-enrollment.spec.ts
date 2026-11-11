import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { deflateSync } from 'node:zlib';

// A real one-page PDF (pdf.js tolerates the missing xref, so offsets need not be exact).
const labRulesPdf = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R>>endobj\n' +
    '4 0 obj<</Length 36>>stream\n0 0 0 rg 20 20 160 160 re f\nendstream\nendobj\n' +
    'trailer<</Root 1 0 R/Size 5>>\n%%EOF\n',
);

// A decodable 64x64 PNG: the photo goes through the cropper, which needs a real image to position under the mask.
function photoPng(): Buffer {
  const size = 64;
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(body));
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const rows = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) rows.set([x * 4, y * 4, 160], y * (size * 3 + 1) + 1 + x * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('clears a completed kiosk enrollment before the next visitor', async ({ page }, testInfo) => {
  // Carbon button transitions would let the accessibility scan measure half-faded colours.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors: Error[] = [];
  page.on('pageerror', (error) => errors.push(error));
  let contexts = 0;
  let pendingEmail: string | null = null;
  let verifiedEmail: string | null = null;
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/visitor-enrollment/context')) {
      contexts += 1;
      await route.fulfill({ status: 204 });
    } else if (path.endsWith('/visitor-enrollment/state')) {
      await route.fulfill({
        json: {
          email: verifiedEmail,
          emailVerified: verifiedEmail !== null,
          capabilities: ['camera', 'file_upload'],
          labRulesRequired: true,
          currentLabRules: {
            id: '0192f6f8-743e-7c77-a349-cd07c3e8ab01',
            humanRevision: '2026-09',
            effectiveAt: '2026-09-01T00:00:00Z',
          },
          consentCategories: [
            {
              id: '0192f6f8-743e-7c77-a349-cd07c3e8ab21',
              name: 'News & events',
              description: 'Workshops, events and other news.',
              basis: 'consent',
            },
          ],
          expiresAt: '2030-01-01T00:00:00Z',
        },
      });
    } else if (path.endsWith('/visitor-enrollment/email-verification')) {
      pendingEmail = (route.request().postDataJSON() as { email: string }).email;
      await route.fulfill({ status: 202 });
    } else if (path.endsWith('/visitor-enrollment/email-verification/confirm')) {
      if ((route.request().postDataJSON() as { code: string }).code !== '123456') {
        await route.fulfill({
          status: 422,
          json: { code: 'challenge_invalid', message: 'The code is invalid or expired' },
        });
        return;
      }
      verifiedEmail = pendingEmail;
      await route.fulfill({ status: 204 });
    } else if (path.endsWith('/visitor-enrollment/lab-rules.pdf')) {
      await route.fulfill({ contentType: 'application/pdf', body: labRulesPdf });
    } else if (path.endsWith('/visitor-enrollment/submissions')) {
      await route.fulfill({
        status: 201,
        json: {
          personId: '0192f6f8-743e-7c77-a349-cd07c3e8ab02',
          accountId: '0192f6f8-743e-7c77-a349-cd07c3e8ab03',
          accountStatus: 'enabled',
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
  await expect(page.getByRole('button', { name: 'Send code' })).toBeEnabled();
  await page.mouse.move(0, 0);
  // The whole step fits the viewport: the page itself never scrolls.
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('visitor-step-1.png') });
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByRole('heading', { name: 'Code' })).toBeVisible();
  await expect(page.getByLabel('Code', { exact: true })).toBeFocused();
  // A wrong code stays on the step; the mock accepts 123456.
  await page.getByLabel('Code', { exact: true }).fill('000000');
  await page.getByRole('button', { name: 'Verify code' }).click();
  await expect(page.getByText(/The code is not correct or has expired/)).toBeVisible();
  await page.getByLabel('Code', { exact: true }).fill('123456');
  await page.mouse.move(0, 0);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('visitor-code.png') });
  await page.getByRole('button', { name: 'Verify code' }).click();
  await expect(page.getByRole('heading', { name: 'Profile photo' })).toBeFocused();
  await page
    .getByLabel('or upload a profile photo', { exact: true })
    .setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: photoPng() });
  // Positioning the photo fits the screen; "Retake photo" and "Use photo" stand in the footer in place of Next.
  await expect(page.getByRole('button', { name: 'Retake photo' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next' })).toHaveCount(0);
  await page.mouse.move(0, 0);
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('visitor-photo.png') });
  // "Use photo" keeps the photo and moves on.
  await page.getByRole('button', { name: 'Use photo' }).click();
  await expect(page.getByRole('heading', { name: 'Messages' })).toBeFocused();
  // Carbon draws the switch over its button; a visitor taps the drawn switch.
  await page
    .locator('.visitor-flow__consent-item', { hasText: 'News & events' })
    .locator('.cds--toggle__appearance')
    .click();
  await expect(page.getByRole('switch', { name: 'News & events' })).toBeChecked();
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('visitor-messages.png') });
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Lab Rules' })).toBeFocused();
  await expect(page.getByLabel('I have read and accept the Lab Rules')).toBeDisabled();
  await page.getByRole('button', { name: 'View current Lab Rules PDF' }).click();
  const rules = page.getByRole('dialog', { name: 'Lab Rules, revision 2026-09' });
  await expect(rules.getByRole('img', { name: 'Page 1 of 1' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('visitor-lab-rules-pdf.png') });
  await page.keyboard.press('Escape');
  await expect(rules).toBeHidden();
  await page.getByText(/I have read and accept the Lab Rules/).click();
  await page.screenshot({ path: testInfo.outputPath('visitor-step-4.png') });
  await page.getByRole('button', { name: 'Register and check in' }).click();
  await expect(page.getByRole('heading', { name: 'Local, your account is ready.' })).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('visitor-submitted.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('visitor-submitted-mobile.png'), fullPage: true });
  expect(contexts).toBe(1);
  expect(errors).toEqual([]);
});

test('opens an external privacy policy in a dialog instead of leaving the kiosk', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const privacyUrl = 'https://privacy.example.test/policy';
  await page.route(privacyUrl, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<h1>Privacy at the example lab</h1>' }),
  );
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/public/config')) {
      const response = await route.fetch();
      const configuration = await response.json();
      configuration.legal.privacy = { mode: 'external', href: privacyUrl };
      await route.fulfill({ response, json: configuration });
    } else if (path.endsWith('/public/legal/privacy')) {
      await route.fulfill({
        json: { kind: 'privacy', title: 'Privacy policy', mode: 'external', markdown: '', externalUrl: privacyUrl },
      });
    } else if (path.endsWith('/visitor-enrollment/context')) {
      await route.fulfill({ status: 204 });
    } else if (path.endsWith('/visitor-enrollment/state')) {
      await route.fulfill({
        json: {
          email: null,
          emailVerified: false,
          capabilities: [],
          labRulesRequired: false,
          consentCategories: [],
          expiresAt: '2030-01-01T00:00:00Z',
        },
      });
    } else {
      await route.fulfill({ status: 401, json: { code: 'invalid_session', message: 'Sign in required' } });
    }
  });
  await page.goto('/visitor-enrollment');
  await expect(page.getByRole('heading', { name: 'About you' })).toBeFocused();
  const link = page
    .getByRole('navigation', { name: 'Legal information' })
    .getByRole('link', { name: 'Privacy policy' });
  await expect(link).toHaveAttribute('href', privacyUrl);
  await link.click();
  const dialog = page.getByRole('dialog', { name: 'Privacy policy' });
  await expect(
    dialog.frameLocator('iframe').getByRole('heading', { name: 'Privacy at the example lab' }),
  ).toBeVisible();
  await expect(dialog.getByRole('img', { name: `QR code for ${privacyUrl}` })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('kiosk-privacy-dialog.png') });
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/visitor-enrollment$/);
});
