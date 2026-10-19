import { expect, test, expectNoAccessibilityViolations, expectNoHorizontalScroll } from './machines-jobs-test';
import { ids } from './machines-jobs-api';

const widths = [320, 390, 414, 768, 1440];

for (const width of widths) {
  test(`pricing configuration stays usable at ${width}px`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/settings/machine-logbook');
    await expect(page.getByRole('heading', { name: 'Partner institute', exact: true })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectNoAccessibilityViolations(page);
    await page.screenshot({ path: testInfo.outputPath(`configuration-${width}.png`), fullPage: true });
    const editRule = width < 672
      ? page.getByRole('button', { name: 'Edit rule', exact: true }).first()
      : page.getByRole('button', { name: 'Edit rule for Partner institute', exact: true }).first();
    await editRule.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Save rule', exact: true }).scrollIntoViewIfNeeded();
    const footer = await page.getByRole('button', { name: 'Save rule', exact: true }).boundingBox();
    expect(footer!.y + footer!.height).toBeLessThanOrEqual(900);
    await expectNoAccessibilityViolations(page);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
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
