import { expect, test, type Page } from '@playwright/test';
import { installPdfTemplatesApi, newWorld, realBuiltins, realSchemas } from './pdf-templates-api';

const LABELS: Record<string, string> = {
  wiref: 'wiRef invoice request',
  cashbook: 'Cashbook (Kassabuch)',
  receipt: 'Order receipt',
};

// Runs in Chromium with the rest of the suite and, opt-in, in WebKit (PLAYWRIGHT_WEBKIT=true, --project=webkit):
// Safari once crashed the editor when switching to the cashbook document.

async function boot(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}\n${e.stack ?? ''}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  await installPdfTemplatesApi(page, newWorld({ builtins: realBuiltins(), schemas: realSchemas() }));
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/settings/pdf-templates');
  await expect(page.getByRole('treeitem', { name: /Page setup/ })).toBeVisible();
  return errors;
}

test('switches between the real built-in documents and opens every node and tab', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = await boot(page);
  for (const kind of ['cashbook', 'receipt', 'wiref', 'cashbook']) {
    await page.getByRole('button', { name: /choose the document/ }).click();
    await page.getByRole('menuitemradio', { name: LABELS[kind] }).click();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
    await expect(page.getByRole('treeitem', { name: /Page setup/ })).toBeVisible();
    // Select every row of the structure, then open every tab on both sides.
    const keys = await page
      .locator('[data-row-key]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-row-key')!));
    for (const key of keys) {
      const row = page.locator(`[data-row-key="${key}"]`);
      if (await row.count()) await row.first().click();
      await expect(page.getByText('Something went wrong')).toHaveCount(0);
    }
    for (const tab of ['Variables', 'Structure', 'Styles', 'Properties']) {
      await page.getByRole('tab', { name: tab }).click();
      await expect(page.getByText('Something went wrong')).toHaveCount(0);
    }
  }
  expect(errors).toEqual([]);
});
