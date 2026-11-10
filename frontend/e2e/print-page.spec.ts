import { expect, test, expectNoAccessibilityViolations, expectNoHorizontalScroll } from './machines-jobs-test';
import { ids } from './machines-jobs-api';

const widths = [320, 414, 1440];

for (const width of widths) {
  test(`print page renders outside the shell at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/prints/${ids.runLinked}`);
    await expect(page.getByRole('heading', { name: 'Gearbox housing', level: 1 })).toBeVisible();
    await expect(page.getByText(/Print · finished 15\.09\.2026/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'About this print' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Download gearbox\.3mf/ })).toBeVisible();
    // No application shell around it.
    await expect(page.locator('.cds--side-nav')).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await expectNoAccessibilityViolations(page);
  });
}

test('an unknown print shows the unavailable view', async ({ page }) => {
  await page.goto(`/prints/${ids.runUnassigned}`);
  await expect(page.getByRole('heading', { name: "This print isn't available to you", level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with another account' })).toBeVisible();
  await expectNoAccessibilityViolations(page);
});
