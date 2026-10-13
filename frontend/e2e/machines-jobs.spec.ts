import type { Locator, Page } from '@playwright/test';
import { expect, test } from './machines-jobs-test';
import { customer, ids, operator } from './machines-jobs-api';

const base = '/machine-logbook';
const openOverflow = (page: Page) => page.locator('.page-header__actions .cds--overflow-menu').click();

/** Opens a Carbon ComboBox and picks an option; retries the opening because the list renders after the lookup loads. */
async function pickOption(page: Page, combobox: Locator, name: string | RegExp) {
  const option = page.getByRole('option', { name });
  await expect(async () => {
    if (!(await option.isVisible())) await combobox.click();
    await expect(option).toBeVisible({ timeout: 1000 });
  }).toPass();
  await option.click();
}

async function chooseCustomerAndOperator(page: Page, dialog = page.getByRole('dialog')) {
  await pickOption(page, dialog.getByPlaceholder('Search people or organizations'), customer.displayName);
  await pickOption(page, dialog.getByPlaceholder('Search operators'), operator.displayName);
}

test.describe('jobs', () => {
  test('a new job that ends in the future runs, is cancelled early and ends as Cancelled', async ({ page, world }) => {
    await page.goto(`${base}/jobs`);
    await page.getByRole('button', { name: 'New job' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'New job' });
    await dialog.getByLabel('Name (optional)').fill('Lamp prototype');
    await dialog.getByLabel('Machine').selectOption({ label: 'Laser cutter' });
    await dialog.getByLabel('Hours').fill('3');
    // A run that is still going has no outcome yet.
    await expect(dialog.getByLabel('Outcome')).toHaveCount(0);
    await expect(dialog.getByText(/The end is in the future/)).toBeVisible();
    await chooseCustomerAndOperator(page, dialog);
    await dialog.getByLabel('Material', { exact: true }).selectOption({ label: 'PLA Black (g)' });
    await dialog.getByLabel('Quantity (g)').fill('25');
    await dialog.getByRole('button', { name: 'Create job' }).click();

    await expect(page).toHaveURL(`${base}/jobs/${ids.newJob}`);
    await expect(page.getByRole('heading', { name: 'Lamp prototype' })).toBeVisible();
    await expect(page.getByText('Running · manual')).toBeVisible();
    await expect(page.getByRole('progressbar', { name: 'Run progress' })).toBeVisible();

    const created = world.bodyOf('POST', '/api/v1/machine-jobs');
    expect(created).toMatchObject({
      machineId: ids.laser, title: 'Lamp prototype', customer: { kind: 'organization', id: customer.id }, operatorPersonId: operator.personId, outcome: 'unknown',
      usages: [{ ownership: 'makerspace', materialId: ids.pla, quantity: '25', quantityBasis: 'actual' }],
    });
    expect(new Date(String(created!.endsAt)).getTime()).toBeGreaterThan(Date.now() + 3_600_000);

    await page.getByRole('button', { name: 'Cancel run' }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toBeVisible();
    expect(world.sent('POST', `/api/v1/machine-jobs/${ids.newJob}/run-cancellation`)).toHaveLength(0);
    await confirm.getByRole('button', { name: 'Cancel run' }).click();

    await expect(page.getByText('Run cancelled', { exact: true })).toBeVisible();
    expect(world.bodyOf('POST', `/api/v1/machine-jobs/${ids.newJob}/run-cancellation`)).toEqual({ expectedVersion: 1 });
    // The job reads as finished: the outcome tag says Cancelled and the run can no longer be cancelled.
    await expect(page.getByText('Cancelled', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel run' })).toHaveCount(0);
    await expect(page.getByText('Running · manual')).toHaveCount(0);
  });

  test('keeps unsaved input of the job form until the person discards it', async ({ page, world }) => {
    await page.goto(`${base}/jobs`);
    await page.getByRole('button', { name: 'New job' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'New job' });
    await dialog.getByLabel('Name (optional)').fill('Unsaved job name');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('button', { name: 'Keep editing' }).click();
    await expect(dialog.getByLabel('Name (optional)')).toHaveValue('Unsaved job name');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Discard changes' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(world.sent('POST', '/api/v1/machine-jobs')).toHaveLength(0);
  });

  test('records the outcome of a job whose run has ended', async ({ page, world }) => {
    await page.goto(`${base}/jobs?status=needs_outcome`);
    await expect(page.getByRole('link', { name: 'Lamp shade' })).toBeVisible();
    await page.getByRole('link', { name: 'Lamp shade' }).click();
    await expect(page.getByRole('heading', { name: 'Lamp shade' })).toBeVisible();
    await expect(page.getByText('Record the outcome', { exact: true })).toBeVisible();
    const save = page.getByRole('button', { name: 'Save outcome' });
    await expect(save).toBeDisabled();
    await page.getByLabel('Outcome').selectOption('failed');
    await save.click();
    await expect(page.getByText('Outcome recorded', { exact: true })).toBeVisible();
    expect(world.bodyOf('PATCH', `/api/v1/machine-jobs/${ids.jobNeedsOutcome}`)).toMatchObject({
      outcome: 'failed', machineId: ids.laser, operatorPersonId: operator.personId, customer: { kind: 'organization', id: customer.id }, expectedVersion: 3,
    });
    await expect(page.getByText('Record the outcome', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Failed', { exact: true }).first()).toBeVisible();
  });

  test('adjusts the price with a percentage discount and shows calculated, adjustment and final', async ({ page, world }) => {
    await page.goto(`${base}/jobs/${ids.jobSuccess}`);
    await expect(page.getByRole('heading', { name: 'Gearbox housing' })).toBeVisible();
    const prices = page.locator('.mj-price-details').first();
    await expect(prices).toContainText('Calculated');
    await expect(prices).toContainText('€12.50');
    await expect(prices).not.toContainText('Final');

    await openOverflow(page);
    await page.getByRole('menuitem', { name: 'Adjust price' }).click();
    const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Adjust price' }) });
    await expect(dialog).toBeVisible();
    // A job with a calculated price starts on the percentage discount.
    await expect(dialog.getByRole('radio', { name: 'Discount (%)' })).toBeChecked();
    await dialog.getByRole('spinbutton').fill('20');
    await expect(dialog.getByText('€10.00')).toBeVisible();
    await dialog.getByLabel('Reason').fill('Member discount');
    await dialog.getByRole('button', { name: 'Save adjustment' }).click();

    await expect(page.getByText('Price adjusted', { exact: true })).toBeVisible();
    expect(world.bodyOf('PUT', `/api/v1/machine-jobs/${ids.jobSuccess}/price-adjustment`)).toEqual({ kind: 'discount_percent', value: '20', reason: 'Member discount', expectedVersion: 3 });
    await expect(prices).toContainText('Calculated');
    await expect(prices).toContainText('Discount 20 %');
    await expect(prices).toContainText('−€2.50');
    await expect(prices).toContainText('Final');
    await expect(prices).toContainText('€10.00');
    await expect(prices).toContainText('Member discount');
  });
});

test.describe('printer prints', () => {
  test('creates a job from an unlinked print with the print data prefilled', async ({ page, world }) => {
    await page.goto(`${base}/jobs?status=unlinked`);
    await page.getByRole('link', { name: 'bracket_v2.gcode' }).click();
    await expect(page).toHaveURL(`${base}/jobs/prints/${ids.printUnlinked}`);
    await expect(page.getByRole('heading', { name: /bracket_v2\.gcode/ })).toBeVisible();
    await page.getByRole('button', { name: 'Create job' }).click();

    const dialog = page.getByRole('dialog', { name: 'New job' });
    await expect(dialog.getByLabel('Name (optional)')).toHaveValue('Bracket v2');
    await expect(dialog.getByLabel('Machine')).toHaveValue('Bambu H2D #1');
    await expect(dialog.getByLabel('Outcome')).toHaveValue('successful');
    await expect(dialog.getByLabel('Material', { exact: true })).toHaveValue(ids.pla);
    await expect(dialog.getByLabel('Quantity (g)')).toHaveValue('42');
    await dialog.getByLabel('Name (optional)').fill('Bracket for Jonas');
    await chooseCustomerAndOperator(page, dialog);
    await dialog.getByRole('button', { name: 'Create job' }).click();

    await expect(page.getByText('Job created and linked', { exact: true })).toBeVisible();
    expect(world.bodyOf('POST', `/api/v1/prints/${ids.printUnlinked}/job`)).toMatchObject({
      title: 'Bracket for Jonas', customer: { kind: 'organization', id: customer.id }, operatorPersonId: operator.personId, outcome: 'successful',
      usages: [{ ownership: 'makerspace', materialId: ids.pla, quantity: '42', quantityBasis: 'actual' }],
    });
    // The page stays open and now shows the job the print is linked to.
    await expect(page).toHaveURL(`${base}/jobs/prints/${ids.printUnlinked}`);
    await expect(page.getByRole('link', { name: /J-2026-000011/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create job' })).toHaveCount(0);
  });

  test('links an unlinked print to a manual job after comparing both runs', async ({ page, world }) => {
    await page.goto(`${base}/jobs/prints/${ids.printUnlinked}`);
    await page.getByRole('button', { name: 'Link to job' }).click();
    const dialog = page.getByRole('dialog');
    const link = dialog.getByRole('button', { name: /^Link (print|and replace)$/ });
    await expect(link).toBeDisabled();
    await dialog.getByRole('combobox', { name: /Job/ }).click();
    // Jobs that already have printer data are not offered.
    await expect(page.getByRole('option', { name: /Gearbox/ })).toHaveCount(0);
    await page.getByRole('option', { name: /J-2026-000003 Prototype bracket/ }).click();

    await expect(dialog.getByText('Manual entry')).toBeVisible();
    await expect(dialog.getByText('From printer', { exact: true })).toBeVisible();
    await expect(dialog.getByText(/The manual run is replaced with the printer's data\. Price is recalculated\./)).toBeVisible();
    await dialog.getByRole('button', { name: 'Link and replace' }).click();

    await expect(page.getByText('J-2026-000003 now uses the data from PR-2026-000008.')).toBeVisible();
    expect(world.bodyOf('PUT', `/api/v1/prints/${ids.printUnlinked}/job`)).toEqual({ machineJobId: ids.jobManualBambu, expectedJobVersion: 3 });
    // The print is linked now, so it offers neither action any more.
    await expect(page.getByRole('link', { name: /J-2026-000003/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create job' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Link to job' })).toHaveCount(0);
  });
});

test.describe('inventory', () => {
  test('changes the filament on a reusable spool: weighed leftover returned to stock, loose stock, tags', async ({ page, world }) => {
    await page.goto(`${base}/inventory?tab=spools`);
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Change filament' }).click();
    const dialog = page.getByRole('dialog', { name: 'Change filament' });

    // Step 1: choose the spool.
    await dialog.getByRole('combobox', { name: /Spool/ }).click();
    await page.getByRole('option', { name: /S-2026-000001/ }).click();
    await dialog.getByRole('button', { name: 'Next' }).click();

    // Step 2: weigh the leftover and return it to loose stock.
    await dialog.getByLabel('Weigh the spool').check({ force: true });
    await dialog.getByLabel(/Weight of the spool with filament/).fill('850');
    await expect(dialog.getByText('Leftover 650 g (system expected 600 g, difference +50 g recorded as correction).')).toBeVisible();
    await expect(dialog.getByLabel(/Return to loose stock/)).toBeChecked();
    await dialog.getByRole('button', { name: 'Next' }).click();

    // Step 3: the current refill product is preselected; the filament comes from loose stock.
    await expect(dialog.getByLabel('Net weight of the new filament (g)')).toHaveValue('1000');
    await expect(dialog.getByText(/Moves 1,000 g from loose stock to this spool\./)).toBeVisible();
    await dialog.getByRole('button', { name: 'Next' }).click();

    // Step 4: keep the barcode, drop the NFC tag, add a new one and review.
    await expect(dialog.getByLabel('Barcode BC-100')).toBeChecked();
    await expect(dialog.getByLabel('NFC tag 04AA11')).not.toBeChecked();
    await dialog.getByLabel('Value').fill('04BB22');
    await expect(dialog.getByText('Close fill 3')).toBeVisible();
    await expect(dialog.getByText('Start fill 4')).toBeVisible();
    await dialog.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByText('S-2026-000001 refilled with PLA Black (fill 4)')).toBeVisible();
    expect(world.bodyOf('POST', `/api/v1/filament-spools/${ids.spoolReusable}/fills`)).toEqual({
      leftover: { basis: 'weighed', grossWeightG: '850', disposition: 'returned_to_stock' },
      fill: { productId: ids.productRefill, materialId: ids.pla, manufacturer: 'Bambu Lab', productName: 'PLA Basic Black', netWeightG: '1000', source: 'loose_stock', totalPrice: null, supplier: null },
      keepIdentifierIds: [ids.barcode], newIdentifiers: [{ kind: 'nfc', value: '04BB22' }],
      occurredAt: expect.any(String), expectedVersion: 5,
    });
  });

  test('finishes a single-use spool that is used up', async ({ page, world }) => {
    await page.goto(`${base}/inventory/spools/${ids.spoolSingle}`);
    await expect(page.getByRole('heading', { level: 1, name: 'S-2026-000002' })).toBeVisible();
    await openOverflow(page);
    await page.getByRole('menuitem', { name: 'Finish spool' }).click();
    const dialog = page.getByRole('dialog', { name: /S-2026-000002/ });
    await dialog.getByLabel('Nothing left, used up').check({ force: true });
    await dialog.getByRole('button', { name: 'Finish spool' }).click();
    await expect(page.getByText('S-2026-000002 finished')).toBeVisible();
    expect(world.bodyOf('POST', `/api/v1/filament-spools/${ids.spoolSingle}/finish`)).toEqual({ leftover: { basis: 'none', disposition: null }, occurredAt: expect.any(String), expectedVersion: 5 });
  });

  test('cleans up archived spools: previews with a dry run, then deletes exactly the previewed ones', async ({ page, world }) => {
    await page.goto(`${base}/inventory?tab=spools`);
    await page.getByRole('table', { name: 'Spools' }).waitFor();
    await page.locator('.cds--table-toolbar .cds--overflow-menu').click();
    await page.getByRole('menuitem', { name: 'Clean up archived spools' }).click();
    const dialog = page.getByRole('dialog', { name: 'Clean up archived spools' });
    await expect(dialog.getByText('2 archived single-use spools match and will be deleted permanently.')).toBeVisible();
    const list = dialog.getByLabel('Spools that will be deleted');
    await expect(list).toContainText('S-2026-000003');
    await expect(list).toContainText('S-2026-000004');
    expect(world.sent('POST', '/api/v1/filament-spools/cleanup').map((request) => request.body)).toEqual([{ olderThanMonths: 3, dryRun: true }]);

    await dialog.getByRole('button', { name: 'Delete 2 spools' }).click();
    await expect(page.getByText('2 archived spools deleted')).toBeVisible();
    const requests = world.sent('POST', '/api/v1/filament-spools/cleanup').map((request) => request.body);
    expect(requests.at(-1)).toEqual({ olderThanMonths: 3, dryRun: false, spoolIds: [ids.spoolArchivedOld, ids.spoolArchivedNew] });
  });

  test('adds and edits a product in the catalog', async ({ page, world }) => {
    await page.goto(`${base}/inventory?tab=products`);
    const table = page.getByRole('table', { name: 'Products' });
    await expect(table.getByText('PLA Basic Black')).toBeVisible();

    await page.getByRole('button', { name: 'Add product' }).click();
    const add = page.getByRole('dialog');
    await add.getByRole('combobox', { name: 'Manufacturer' }).fill('Polymaker');
    await add.getByLabel('Product', { exact: true }).fill('PETG Orange');
    await add.getByLabel('Material', { exact: true }).selectOption(ids.pla);
    await add.getByLabel('Default price (€, optional)').fill('24.5');
    await add.getByLabel(/Refill/).check({ force: true });
    await add.getByRole('button', { name: 'Add product' }).click();
    await expect(page.getByText('Product added', { exact: true })).toBeVisible();
    expect(world.bodyOf('POST', '/api/v1/filament-products')).toEqual({ manufacturer: 'Polymaker', name: 'PETG Orange', materialId: ids.pla, netWeightG: '1000', defaultPrice: '24.50', packaging: 'refill', notes: null });
    await expect(table.getByText('PETG Orange')).toBeVisible();

    await table.getByRole('button', { name: 'PLA Basic Black' }).click();
    const edit = page.getByRole('dialog');
    await expect(edit.getByText('Edit product')).toBeVisible();
    await edit.getByLabel('Product', { exact: true }).fill('PLA Matte Black');
    await edit.getByRole('button', { name: 'Save product' }).click();
    await expect(page.getByText('Product saved', { exact: true })).toBeVisible();
    expect(world.bodyOf('PATCH', `/api/v1/filament-products/${ids.productRefill}`)).toMatchObject({ manufacturer: 'Bambu Lab', name: 'PLA Matte Black', materialId: ids.pla, packaging: 'refill', active: true, expectedVersion: 2 });
    await expect(table.getByText('PLA Matte Black')).toBeVisible();
  });
});

test.describe('statistics', () => {
  test('keeps the machine selection in the URL and requests an exclusive end when the period changes', async ({ page, world }) => {
    await page.goto(`${base}/statistics?period=custom&from=2026-01-01&to=2026-01-31`);
    await expect(page.getByRole('region', { name: 'Key figures' })).toBeVisible();
    expect(world.statisticsRequests[0].get('from')).toBe('2026-01-01');
    expect(world.statisticsRequests[0].get('to')).toBe('2026-02-01');

    await page.getByRole('tab', { name: '30 days' }).click();
    await expect(page).toHaveURL(/period=30d/);
    await expect.poll(() => world.statisticsRequests.length).toBeGreaterThan(1);
    const [from, to] = [world.statisticsRequests.at(-1)!.get('from')!, world.statisticsRequests.at(-1)!.get('to')!];
    // 30 days including today, so the exclusive end is the day after today.
    expect((Date.parse(to) - Date.parse(from)) / 86_400_000).toBe(30);
    expect(Date.parse(to)).toBeGreaterThan(Date.now() - 86_400_000);

    // The three busiest machines are compared by default; a different choice lives in the URL and survives a reload.
    const picker = page.getByRole('combobox', { name: /Machines/ });
    await expect(picker).toContainText('3 selected');
    await picker.click();
    await page.getByRole('option', { name: 'CNC mill' }).click();
    await expect(page).toHaveURL(new RegExp(`machines=.*${ids.mill}`));
    await page.keyboard.press('Escape');
    const machines = new URL(page.url()).searchParams.get('machines')!.split(',');
    expect(machines).toHaveLength(4);
    await page.reload();
    await expect(page.getByRole('combobox', { name: /Machines/ })).toContainText('4 selected');
    expect(new URL(page.url()).searchParams.get('machines')!.split(',')).toEqual(machines);
    expect(new URL(page.url()).searchParams.get('period')).toBe('30d');
  });
});
