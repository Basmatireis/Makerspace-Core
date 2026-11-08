import { expect, test, expectNoAccessibilityViolations, expectNoHorizontalScroll } from './machines-jobs-test';
import { ids } from './machines-jobs-api';

const base = '/workshop';

test('opens a machine in the panel next to the table on wide screens', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/machines`);
  await page.getByRole('button', { name: 'Bambu H2D #1' }).click();
  const panel = page.getByRole('complementary', { name: 'Machine details' });
  await expect(panel.getByRole('heading', { name: 'Bambu H2D #1' })).toBeVisible();
  await expect(panel.getByRole('link', { name: 'Open machine' })).toHaveAttribute(
    'href',
    `${base}/machines/${ids.bambu}`,
  );
  await expect(page).toHaveURL(new RegExp(`machine=${ids.bambu}`));
  await expectNoAccessibilityViolations(page);
});

test('goes to the machine page from a row on narrow screens', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`${base}/machines`);
  await page.getByRole('link', { name: 'Bambu H2D #1' }).click();
  await expect(page).toHaveURL(`${base}/machines/${ids.bambu}`);
});

test('points to the notification rules next to the error catalog', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/machines?tab=printers`);
  await expect(
    page.getByRole('table', { name: 'Printer error catalog' }).getByText('AMS filament stuck'),
  ).toBeVisible();
  await expect(page.getByText('Printer notifications are rules now: Settings › Notification center.')).toBeVisible();
  await expectNoAccessibilityViolations(page);
});

test('edits a catalog meaning from its row', async ({ page, world }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/machines?tab=printers`);
  await page.getByRole('table', { name: 'Printer error catalog' }).getByText('SD card read error').click();
  const dialog = page.getByRole('dialog', { name: 'Edit code meaning' });
  await dialog.getByRole('textbox', { name: 'Meaning' }).fill('SD card cannot be read');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => world.sent('PUT', '/api/v1/printer-error-codes/print/0500-4001')).toHaveLength(1);
  expect(world.bodyOf('PUT', '/api/v1/printer-error-codes/print/0500-4001')).toEqual({
    title: 'SD card cannot be read',
    description: '',
    link: null,
  });
});

for (const width of [390, 1440]) {
  test(`the Printers tab fits at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${base}/machines?tab=printers`);
    await expect(page.getByRole('table', { name: 'Printer error catalog' })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
}
