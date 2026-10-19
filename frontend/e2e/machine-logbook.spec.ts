import { expect, test, expectNoAccessibilityViolations, expectNoHorizontalScroll } from './machines-jobs-test';
import { ids } from './machines-jobs-api';

const widths = [320, 390, 414, 768, 1440];

for (const width of widths) {
  test(`pricing page stays usable at ${width}px`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/pricing');
    await expect(page.getByRole('heading', { name: 'Pricing', exact: true, level: 1 })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /Partner institute/ })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectNoAccessibilityViolations(page);
    await page.screenshot({ path: testInfo.outputPath(`pricing-${width}.png`), fullPage: true });
    await page.getByRole('button', { name: /^Edit .* for Partner institute$/ }).first().click();
    await expect(page.getByRole('button', { name: 'Save rate', exact: true })).toBeVisible();
    await expectNoAccessibilityViolations(page);
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
  });

  test(`overview, jobs, job detail and statistics remain usable at ${width}px`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    const pages = [
      ['/machine-logbook', 'overview', 'Overview'],
      ['/machine-logbook/jobs', 'jobs', 'Jobs'],
      [`/machine-logbook/jobs/${ids.jobSuccess}`, 'job', 'Gearbox housing'],
      ['/machine-logbook/statistics', 'statistics', 'Statistics'],
    ] as const;
    for (const [path, label, title] of pages) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: title, exact: true, level: 1 })).toBeVisible();
      await page.waitForLoadState('networkidle');
      if (label === 'statistics') await expect(page.locator('.mj-stats-chart svg.layout-svg-wrapper').first()).toBeVisible();
      await expectNoHorizontalScroll(page);
      await expectNoAccessibilityViolations(page);
      await page.screenshot({ path: testInfo.outputPath(`${label}-${width}.png`), fullPage: true });
    }
  });
}
