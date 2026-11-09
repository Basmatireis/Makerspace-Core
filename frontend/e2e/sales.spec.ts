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
  test('Needs attention lists flagged orders and the finished jobs without an order', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/sales');
    await expect(page).toHaveURL(/\/orders$/);
    const nav = page.getByRole('navigation', { name: 'Primary navigation' });
    const group = nav.getByRole('listitem').filter({ has: page.getByRole('button', { name: 'Sales & payments' }) });
    await expect(group.getByRole('link')).toHaveText(['Orders', 'Payments', 'Pricing']);
    await page.getByRole('tab', { name: /^Needs attention/ }).click();
    const table = page.getByRole('table', { name: 'Orders' });
    await expect(table.getByRole('button', { name: 'O-2026-000104', exact: true })).toBeVisible();
    await expect(table).toContainText('W-2026-000012');
    await expect(table.getByRole('button', { name: 'O-2026-000103', exact: true })).toHaveCount(0);
    await expect(page.getByText('1 finished job is not on an order')).toBeVisible();
    await expect(page.getByText(/J-2026-000421 · €12\.40 ready to bill\./)).toBeVisible();
    await expectNoAccessibilityViolations(page, '#main-content');
    await page.screenshot({ path: testInfo.outputPath('orders-needs-attention.png'), fullPage: true });
    await page.getByRole('button', { name: 'Review jobs', exact: true }).click();
    await expect(dialogTitled(page, 'Jobs ready to bill')).toBeVisible();
  });

  test('the row menu holds the order actions the order page no longer has', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/orders');
    const row = page.getByRole('row').filter({ hasText: 'O-2026-000105' });
    await row.locator('.cds--overflow-menu').click();
    await expect(page.getByRole('menuitem', { name: 'Edit customer' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Cancel draft' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.goto(`/orders/${salesIds.draft}`);
    await expect(page.getByRole('button', { name: 'Edit order' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'More order actions' })).toHaveCount(0);
  });

  test('a row opens the order in the panel with its flag, items and payments', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/orders');
    const table = page.getByRole('table', { name: 'Orders' });
    await expect(table).toBeVisible();
    await expect(page.getByText('Select an order to see its items, payments and invoice.')).toBeVisible();
    await table.getByRole('button', { name: 'O-2026-000104', exact: true }).click();
    const panel = page.getByRole('complementary', { name: 'Order details' });
    await expect(panel.getByRole('heading', { name: 'Sara Novak' })).toBeVisible();
    await expect(panel.getByRole('table', { name: 'Items of the selected order' })).toContainText('Stabilizer');
    await expect(page).toHaveURL(new RegExp(`order=${salesIds.open}`));
    await expectNoAccessibilityViolations(page, '#main-content');
    await page.screenshot({ path: testInfo.outputPath('orders-panel.png'), fullPage: true });

    await page.getByRole('tab', { name: /^Paid/ }).click();
    await table.getByRole('button', { name: 'O-2026-000103', exact: true }).click();
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
    // Articles of machine-use types sell at the type rate and have no row; the insert (a fastener) has one.
    await expect(table.getByRole('row').filter({ hasText: 'A-0001 · Prusament PLA Galaxy Black' })).toHaveCount(0);
    const insert = table.getByRole('row').filter({ hasText: 'A-0010 · M3 heat-set insert' });
    await expect(insert).toContainText('0,12');
    await insert.getByRole('button', { name: /Set price for A-0010 .* in External/ }).click();
    const dialog = dialogTitled(page, 'Set rate');
    await dialog.getByLabel(/^Rate for A-0010/).fill('0,05');
    await dialog.getByRole('button', { name: 'Save rate' }).click();
    await expect(dialog).toBeHidden();
    expect(world.requests.at(-1)).toMatchObject({
      method: 'POST',
      body: { kind: 'stock_article', materialId: salesIds.insert, rate: '0.05' },
    });
    await expectNoAccessibilityViolations(page, '#main-content');
    await page.screenshot({ path: testInfo.outputPath('pricing.png'), fullPage: true });
  });

  test('the cash register shows the journal by day and the register next to it', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/payments');
    await expect(page.getByRole('tab', { name: 'Cash register', selected: true })).toBeVisible();
    const table = page.getByRole('table', { name: 'Cash journal' });
    await expect(table.getByRole('row').filter({ hasText: 'Saturday 31 October' })).toContainText(
      'opening balance €0.00',
    );
    await expect(table.getByRole('row').filter({ hasText: 'Tuesday 3 November' })).toContainText('€83.20');
    await expect(table.getByRole('row').filter({ hasText: 'K-2026-0002' })).toContainText('−€2.50 short');
    const panel = page.getByRole('complementary', { name: 'Cash register' });
    await expect(panel.getByRole('heading', { name: 'Expected in the register' })).toBeVisible();
    await expect(panel.getByText('Cash register · All time')).toBeVisible();
    await expect(panel.getByLabel('How the expected cash is calculated')).toContainText('= Expected€83.20');
    await expect(panel.getByText('Counting error')).toBeVisible();
    await expectNoAccessibilityViolations(page, '#main-content');
    await page.screenshot({ path: testInfo.outputPath('payments-register.png'), fullPage: true });

    await table.getByRole('button', { name: 'P-2026-000210' }).click();
    await expect(panel.getByRole('heading', { name: 'P-2026-000210' })).toBeVisible();
    await expect(panel.getByRole('link', { name: 'Go to order' })).toHaveAttribute('href', `/orders/${salesIds.paid}`);
    await expect(panel.getByRole('link', { name: 'Show receipt' })).toBeVisible();
    await expectNoAccessibilityViolations(page, '#main-content');
    await page.screenshot({ path: testInfo.outputPath('payments-entry.png'), fullPage: true });
    await panel.getByRole('button', { name: 'Close panel' }).click();
    await expect(panel.getByRole('heading', { name: 'Expected in the register' })).toBeVisible();
  });

  test('counts the register and books the difference', async ({ page, world }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/payments');
    await page.getByRole('button', { name: 'Count', exact: true }).click();
    const dialog = dialogTitled(page, 'Count the register');
    await dialog.getByLabel('Counted amount (€)').fill('80,70');
    await expect(dialog.getByText('Less cash than expected.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Record count and book −€2.50' })).toBeVisible();
    await dialog.getByLabel('Reason for the difference').selectOption('unknown');
    await dialog.getByRole('button', { name: 'Record count and book −€2.50' }).click();
    await expect(dialog.getByText('Say what you found')).toBeVisible();
    await dialog.getByLabel('Note (required)').fill('Coin missing');
    await expectNoAccessibilityViolations(page, '[role="dialog"]');
    await page.screenshot({ path: testInfo.outputPath('payments-count.png') });
    await dialog.getByRole('button', { name: 'Record count and book −€2.50' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Difference −€2.50 booked as a correction')).toBeVisible();
    expect(world.requests.at(-1)).toMatchObject({
      method: 'POST',
      path: '/api/v1/payments/cash-counts',
      body: { countedAmount: '80.70', reason: 'unknown', note: 'Coin missing', expectedAmount: '83.20' },
    });
  });

  test('without cash_movements.manage an entry offers no Edit or Delete', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/payments');
    const panel = page.getByRole('complementary', { name: 'Cash register' });
    await page.getByRole('table', { name: 'Cash journal' }).getByRole('button', { name: 'C-2026-000004' }).click();
    await expect(panel.getByRole('heading', { name: 'C-2026-000004' })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Edit' })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Delete' })).toHaveCount(0);
  });

  test('edits a withdrawal and a count and deletes the count', async ({ page, world }, testInfo) => {
    world.permissions = [...world.permissions, 'cash_movements.manage'];
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/payments');
    const table = page.getByRole('table', { name: 'Cash journal' });
    const panel = page.getByRole('complementary', { name: 'Cash register' });

    await table.getByRole('button', { name: 'C-2026-000004' }).click();
    await expect(panel.getByRole('heading', { name: 'C-2026-000004' })).toBeVisible();
    await expectNoAccessibilityViolations(page, '#main-content');
    await panel.getByRole('button', { name: 'Edit' }).click();
    const withdrawal = dialogTitled(page, 'Edit withdrawal');
    await expect(withdrawal.getByLabel('Amount (€)')).toHaveValue('80,00');
    await withdrawal.getByLabel('Amount (€)').fill('75');
    await expectNoAccessibilityViolations(page, '[role="dialog"]');
    await page.screenshot({ path: testInfo.outputPath('payments-edit-withdrawal.png') });
    await withdrawal.getByRole('button', { name: 'Save' }).click();
    await expect(withdrawal).toBeHidden();
    await expect(page.getByText('Withdrawal saved')).toBeVisible();
    expect(world.requests.at(-1)).toMatchObject({
      method: 'PATCH',
      path: expect.stringMatching(/^\/api\/v1\/cash-movements\//),
      body: { expectedVersion: 1, amount: '75.00', reason: 'bank_deposit', note: 'Slip 2211' },
    });
    await expect(table.getByRole('row').filter({ hasText: 'C-2026-000004' })).toContainText('€75.00');
    await expect(panel.getByText('Last edited')).toBeVisible();

    await table.getByRole('button', { name: 'K-2026-0002' }).click();
    await panel.getByRole('button', { name: 'Edit' }).click();
    const count = dialogTitled(page, 'Edit count');
    await expect(count.getByLabel('Counted amount (€)')).toHaveValue('83,20');
    await count.getByLabel('Counted amount (€)').fill('85,70');
    await expect(count.getByText('The count matches.')).toBeVisible();
    await count.getByRole('button', { name: 'Save' }).click();
    await expect(count).toBeHidden();
    await expect(page.getByText('Count saved')).toBeVisible();
    expect(world.requests.at(-1)).toMatchObject({
      method: 'PATCH',
      path: expect.stringMatching(/^\/api\/v1\/payments\/cash-counts\//),
      body: { expectedVersion: 1, countedAmount: '85.70', note: '', expectedAmount: '85.70' },
    });

    await panel.getByRole('button', { name: 'Delete' }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm.getByRole('heading', { name: 'Delete count?' })).toBeVisible();
    await expect(confirm).toContainText('Count K-2026-0002 found €85.70.');
    await expectNoAccessibilityViolations(page, '[role="alertdialog"]');
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByText('Count deleted')).toBeVisible();
    expect(world.requests.at(-1)).toMatchObject({ method: 'DELETE', body: { expectedVersion: 2 } });
    await expect(table.getByRole('button', { name: 'K-2026-0002' })).toHaveCount(0);
    await expect(panel.getByRole('heading', { name: 'Expected in the register' })).toBeVisible();
  });

  test('filters by period and exports the cashbook', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/payments?tab=cashbook');
    await expect(page.getByRole('tab', { name: 'Cashbook', selected: true })).toBeVisible();
    await expect(page.getByLabel('Takings by method')).toContainText('Net takings');
    const table = page.getByRole('table', { name: 'Payments' });
    await expect(table).toContainText('Not tied to an order');
    await page.getByRole('button', { name: /^Filters/ }).click();
    await page.getByRole('radio', { name: 'Custom range…' }).check({ force: true });
    const range = dialogTitled(page, 'Custom range');
    await range.getByLabel('From').fill('31.10.2026');
    await range.getByLabel('Through').fill('02.11.2026');
    await range.getByText('Whole days.').click();
    await range.getByRole('button', { name: 'Apply' }).click();
    await expect(page).toHaveURL(/period=custom&from=2026-10-31&to=2026-11-02/);
    await expect(page.getByText('Custom range · 31 Oct – 2 Nov 2026')).toBeVisible();
    await expectNoAccessibilityViolations(page, '#main-content');
    await page.screenshot({ path: testInfo.outputPath('payments-cashbook.png'), fullPage: true });

    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const dialog = dialogTitled(page, 'Export cashbook');
    await expect(dialog.getByLabel('From')).toHaveValue('31.10.2026');
    await dialog.getByText('CSV for Excel').click();
    await expectNoAccessibilityViolations(page, '[role="dialog"]');
    const download = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Download CSV' }).click();
    expect((await download).suggestedFilename()).toBe('cashbook-all-payments-2026-10-31-2026-11-02.csv');
    await expect(page.getByText('Cashbook downloaded')).toBeVisible();

    await page.getByRole('tab', { name: 'Cash register' }).click();
    await expect(page).toHaveURL(/\/payments$/);
    await expect(page.getByText('All time · up to now')).toBeVisible();
  });

  for (const width of [375, 1440]) {
    test(`sales pages stay usable in dark mode at ${width}px`, async ({ page }, testInfo) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: 'dark' });
      for (const [path, heading] of [
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

  for (const scheme of ['light', 'dark'] as const)
    for (const width of [375, 1440]) {
      test(`both payments tabs fit ${width}px in ${scheme} mode`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: scheme });
        for (const tab of ['register', 'cashbook']) {
          await page.goto(tab === 'register' ? '/payments' : '/payments?tab=cashbook');
          await expect(page.getByRole('heading', { name: 'Payments', level: 1 })).toBeVisible();
          await expect(
            page.getByRole('table', { name: tab === 'register' ? 'Cash journal' : 'Payments' }),
          ).toBeVisible();
          await page.waitForLoadState('networkidle');
          await expectNoHorizontalScroll(page);
          await expectNoAccessibilityViolations(page, '#main-content');
          await page.screenshot({
            path: testInfo.outputPath(`payments-${tab}-${scheme}-${width}.png`),
            fullPage: true,
          });
        }
        if (width === 375) {
          // Without room for the panel the register sits above the journal and a payment row opens its page.
          await page.goto('/payments');
          await expect(page.getByRole('heading', { name: 'Expected in the register' })).toBeVisible();
          await page.getByRole('link', { name: 'P-2026-000210' }).click();
          await expect(page).toHaveURL(new RegExp(`/payments/${salesIds.cashPayment}$`));
        }
      });
    }
});
