import { expect, expectNoAccessibilityViolations, expectNoHorizontalScroll, test } from './machines-jobs-test';

const darkClass = /cds--g100/;

test.describe('color scheme', () => {
  test('follows the system setting and remembers an explicit choice', async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/workshop/jobs');
    await expect(page.getByRole('table', { name: 'Jobs' })).toBeVisible();
    await expect(page.locator('html')).toHaveClass(darkClass);
    await expectNoAccessibilityViolations(page);
    await page.screenshot({ path: testInfo.outputPath('jobs-dark.png'), fullPage: true });

    await page.getByRole('button', { name: /Open profile menu/ }).click();
    await page.getByRole('button', { name: 'Use light theme' }).click();
    await expect(page.locator('html')).not.toHaveClass(darkClass);
    await page.reload();
    await expect(page.getByRole('table', { name: 'Jobs' })).toBeVisible();
    await expect(page.locator('html')).not.toHaveClass(darkClass);

    // Choosing what the system prefers again drops the stored choice.
    await page.getByRole('button', { name: /Open profile menu/ }).click();
    await page.getByRole('button', { name: 'Use dark theme' }).click();
    await expect(page.locator('html')).toHaveClass(darkClass);
    expect(await page.evaluate(() => localStorage.getItem('makerspace.colorScheme'))).toBeNull();
  });

  for (const width of [375, 1440]) {
    test(`statistics and inventory stay usable in dark mode at ${width}px`, async ({ page }, testInfo) => {
      test.setTimeout(60_000);
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: 'dark' });
      for (const [path, ready] of [
        ['/statistics', 'Statistics'],
        ['/workshop/inventory', 'Inventory'],
      ] as const) {
        await page.goto(path);
        await expect(page.getByRole('heading', { name: ready, level: 1 })).toBeVisible();
        await page.waitForLoadState('networkidle');
        await expectNoHorizontalScroll(page);
        await expectNoAccessibilityViolations(page);
        await page.screenshot({
          path: testInfo.outputPath(`${ready.toLowerCase()}-dark-${width}.png`),
          fullPage: true,
        });
      }
    });
  }
});
