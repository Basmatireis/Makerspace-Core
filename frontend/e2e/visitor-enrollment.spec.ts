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
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/visitor-enrollment/context')) {
      contexts += 1;
      await route.fulfill({ status: 204 });
    } else if (path.endsWith('/visitor-enrollment/state')) {
      await route.fulfill({
        json: {
          allowedMethods: ['pin'],
          capabilities: ['camera', 'file_upload'],
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
    .setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: photoPng() });
  await page.getByRole('button', { name: 'Use photo' }).click();
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
