import { expect, test as base, type Page } from '@playwright/test';
import { expectNoAccessibilityViolations, expectNoHorizontalScroll } from './machines-jobs-test';
import { createSalesWorld, installSalesApi, salesIds, type SalesWorld } from './sales-api';

const test = base.extend<{ world: SalesWorld; pageErrors: string[] }>({
  pageErrors: async ({ page }, provide) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().startsWith('Failed to load resource'))
        errors.push(message.text());
    });
    await provide(errors);
    expect(errors).toEqual([]);
  },
  world: [
    async ({ page, pageErrors }, provide) => {
      void pageErrors;
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const world = await installSalesApi(page, createSalesWorld());
      await provide(world);
      expect(world.unhandled).toEqual([]);
    },
    { auto: true },
  ],
});

const dialogTitled = (page: Page, title: string) =>
  page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: title, exact: true }) });

test.describe('sales and payments', () => {
  test('the overview lists what needs attention and the recent orders', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/sales');
    await expect(page.getByRole('heading', { name: 'Sales overview', level: 1 })).toBeVisible();
    const attention = page.getByRole('region', { name: /Needs attention/ });
    await expect(attention.getByText('W-2026-000012 · TU Graz Racing')).toBeVisible();
    await expect(attention.getByRole('button', { name: 'Take payment' }).first()).toBeVisible();
    await expect(page.getByRole('region', { name: 'Recent orders' }).getByRole('link').first()).toBeVisible();
    await expectNoAccessibilityViolations(page, '#main-content');
    await page.screenshot({ path: testInfo.outputPath('sales-overview.png'), fullPage: true });
  });

  test('a row opens the order in the panel with its flag, items and payments', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/orders');
    const table = page.getByRole('table', { name: 'Orders' });
    await expect(table).toBeVisible();
    await expect(page.getByText('Select an order to see its items, payments and invoice.')).toBeVisible();
    await table.getByRole('button', { name: 'O-2026-000104' }).click();
    const panel = page.getByRole('complementary', { name: 'Order details' });
    await expect(panel.getByRole('heading', { name: 'Sara Novak' })).toBeVisible();
    await expect(panel.getByRole('table', { name: 'Items of the selected order' })).toContainText('Stabilizer');
    await expect(page).toHaveURL(new RegExp(`order=${salesIds.open}`));
    await expectNoAccessibilityViolations(page, '#main-content');
    await page.screenshot({ path: testInfo.outputPath('orders-panel.png'), fullPage: true });

    await page.getByRole('tab', { name: /^Paid/ }).click();
    await table.getByRole('button', { name: 'O-2026-000103' }).click();
    await expect(panel.getByRole('table', { name: 'Payments of the selected order' })).toContainText('P-2026-000210');
  });

  test('adds a stock article at the customer’s group price and explains a missing price', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/orders/${salesIds.draft}`);
    await expect(page.getByRole('heading', { name: 'O-2026-000105', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Add item' }).click();
    const choice = dialogTitled(page, 'Add to order');
    await expect(choice.getByText('1 ready for Institute of Design')).toBeVisible();
    await choice.getByText('Something from inventory').click();
    await choice.getByRole('button', { name: 'Continue' }).click();
    const stock = dialogTitled(page, 'Add from inventory');
    await stock.getByRole('combobox', { name: 'Article' }).fill('insert');
    await page.getByRole('option', { name: /A-0010 · M3 heat-set insert/ }).click();
    await expect(stock.getByLabel(/^Unit price/)).toHaveValue('0.12');
    await stock.getByLabel(/^Quantity/).fill('10');
    await expect(stock.getByText('€1.20')).toBeVisible();
    await stock.getByRole('button', { name: 'Add item' }).click();
    await expect(stock).toBeHidden();
    await expect(page.getByRole('table', { name: 'Order items' })).toContainText('M3 heat-set insert');

    await page.getByRole('button', { name: 'Add item' }).click();
    await choice.getByText('Something from inventory').click();
    await choice.getByRole('button', { name: 'Continue' }).click();
    await stock.getByRole('combobox', { name: 'Article' }).fill('acrylic');
    await page.getByRole('option', { name: /A-0020/ }).click();
    await expect(stock.getByText(/This article has no price in any group/)).toBeVisible();
    await stock.getByRole('button', { name: 'Add item' }).click();
    await expect(stock.getByText('No price for this customer')).toBeVisible();
    await expect(stock.getByRole('link', { name: 'Pricing' })).toHaveAttribute('href', '/pricing');
    await page.screenshot({ path: testInfo.outputPath('order-price-missing.png') });
  });

  test('the order page shows attention, balance and customer', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/orders/${salesIds.open}`);
    await expect(page.getByText('The balance has been open for more than 14 days.')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Balance' })).toContainText('€19.30');
    await expect(page.getByRole('region', { name: 'Customer' })).toContainText('Sara Novak');
    await expectNoAccessibilityViolations(page, '#main-content');
    await page.screenshot({ path: testInfo.outputPath('order-page.png'), fullPage: true });
  });

  test('prices articles sold from stock per group', async ({ page, world }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/pricing');
    const table = page.getByRole('table', { name: 'Rates' });
    await expect(table.getByText('Articles sold from stock · per unit')).toBeVisible();
    const pla = table.getByRole('row').filter({ hasText: 'A-0001 · Prusament PLA Galaxy Black' });
    await expect(pla).toContainText('type rate');
    await pla.getByRole('button', { name: /Set price for A-0001 .* in External/ }).click();
    const dialog = dialogTitled(page, 'Set rate');
    await dialog.getByLabel(/^Rate for A-0001/).fill('0,05');
    await dialog.getByRole('button', { name: 'Save rate' }).click();
    await expect(dialog).toBeHidden();
    expect(world.requests.at(-1)).toMatchObject({
      method: 'POST',
      body: { kind: 'stock_article', materialId: salesIds.plaBlack, rate: '0.05' },
    });
    await expectNoAccessibilityViolations(page, '#main-content');
    await page.screenshot({ path: testInfo.outputPath('pricing.png'), fullPage: true });
  });

  for (const width of [375, 1440]) {
    test(`sales pages stay usable in dark mode at ${width}px`, async ({ page }, testInfo) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: 'dark' });
      for (const [path, heading] of [
        ['/sales', 'Sales overview'],
        ['/orders', 'Orders'],
        [`/orders/${salesIds.open}`, 'O-2026-000104'],
        ['/pricing', 'Pricing'],
      ] as const) {
        await page.goto(path);
        await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
        await page.waitForLoadState('networkidle');
        await expectNoHorizontalScroll(page);
        await expectNoAccessibilityViolations(page, '#main-content');
        await page.screenshot({
          path: testInfo.outputPath(`${path.split('/')[1]}${path.split('/')[2] ? '-detail' : ''}-dark-${width}.png`),
          fullPage: true,
        });
      }
    });
  }
});
