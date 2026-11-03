import type { Locator, Page } from '@playwright/test';
import { expect, expectNoAccessibilityViolations, expectNoHorizontalScroll, test } from './machines-jobs-test';
import { customer, ids, operator } from './machines-jobs-api';

const base = '/workshop';
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

/** The recipient starts empty; the operator defaults to the signed-in person and is only changed when it differs. */
async function chooseCustomerAndOperator(page: Page, dialog = page.getByRole('dialog')) {
  await pickOption(page, dialog.getByRole('combobox', { name: 'Recipient' }), customer.displayName);
  const operatorField = dialog.getByRole('combobox', { name: 'Operator' });
  if ((await operatorField.inputValue()) !== operator.displayName)
    await pickOption(page, operatorField, operator.displayName);
}

/** Picks a material in the catalog picker that opens from a usage row. */
async function pickMaterial(page: Page, dialog: Locator, name: string) {
  await dialog.getByRole('button', { name: 'Select material' }).click();
  await page.getByRole('cell', { name, exact: true }).click();
}

test.describe('jobs', () => {
  test('a new job whose first run ends in the future runs, the run is cancelled early and the job ends as Cancelled', async ({
    page,
    world,
  }) => {
    await page.goto(`${base}/jobs`);
    await page.getByRole('button', { name: 'New job' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'New job' });
    // Machine and recipient start empty, so a job cannot be created yet.
    await expect(dialog.getByRole('button', { name: 'Create job' })).toBeDisabled();
    await dialog.getByLabel('Title (optional)').fill('Lamp prototype');
    await pickOption(page, dialog.getByRole('combobox', { name: 'Machine' }), /^Laser cutter/);
    await dialog.getByRole('radio', { name: 'Starts now' }).check({ force: true });
    await dialog.getByLabel('Duration (h)').fill('3');
    // A run that is still going has no outcome yet.
    await expect(dialog.getByRole('combobox', { name: 'Outcome' })).toHaveCount(0);
    await expect(dialog.getByText(/Runs until/)).toBeVisible();
    await chooseCustomerAndOperator(page, dialog);
    await pickMaterial(page, dialog, 'Birch plywood');
    await dialog.getByLabel('Quantity (m²)').fill('25');
    await dialog.getByRole('button', { name: 'Create job' }).click();

    await expect(page).toHaveURL(`${base}/jobs/${ids.newJob}`);
    await expect(page.getByRole('heading', { name: 'Lamp prototype' })).toBeVisible();
    await expect(page.getByRole('progressbar', { name: 'Run progress' })).toBeVisible();

    // The first run carries start, end, outcome and material; the job itself carries none of them.
    const created = world.bodyOf('POST', '/api/v1/machine-jobs') as { run: Record<string, unknown> } & Record<
      string,
      unknown
    >;
    expect(created).toMatchObject({
      machineId: ids.laser,
      title: 'Lamp prototype',
      customer: { kind: 'organization', id: customer.id },
      operatorPersonId: operator.personId,
      run: {
        outcome: null,
        usages: [{ ownership: 'makerspace', materialId: ids.plywood, quantity: '25', quantityBasis: 'actual' }],
      },
    });
    expect(new Date(String(created.run.endsAt)).getTime()).toBeGreaterThan(Date.now() + 3_600_000);

    const runs = page.getByRole('table', { name: 'Runs' });
    await runs.locator('.cds--overflow-menu').click();
    await page.getByRole('menuitem', { name: 'Cancel run' }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toBeVisible();
    expect(world.sent('POST', `/api/v1/machine-runs/${ids.runNew}/cancellation`)).toHaveLength(0);
    await confirm.getByRole('button', { name: 'Cancel run' }).click();

    await expect(page.getByText('Run cancelled', { exact: true })).toBeVisible();
    expect(world.bodyOf('POST', `/api/v1/machine-runs/${ids.runNew}/cancellation`)).toEqual({ expectedVersion: 1 });
    // The job reads as finished: the outcome tag says Cancelled and the run can no longer be cancelled.
    await expect(runs.getByText('Cancelled', { exact: true }).first()).toBeVisible();
    await expect(runs.locator('.cds--overflow-menu').first()).toBeVisible();
    await expect(runs.getByRole('progressbar')).toHaveCount(0);
  });

  test('keeps unsaved input of the job form until the person discards it', async ({ page, world }) => {
    await page.goto(`${base}/jobs`);
    await page.getByRole('button', { name: 'New job' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'New job' });
    await dialog.getByLabel('Title (optional)').fill('Unsaved job name');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('button', { name: 'Keep editing' }).click();
    await expect(dialog.getByLabel('Title (optional)')).toHaveValue('Unsaved job name');
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
    await page.getByLabel('Outcome of RN-2026-000002').selectOption('failed');
    await save.click();
    await expect(page.getByText('Outcome recorded', { exact: true })).toBeVisible();
    expect(world.bodyOf('PATCH', `/api/v1/machine-runs/${ids.runNeedsOutcome}`)).toEqual({
      outcome: 'failed',
      expectedVersion: 2,
    });
    await expect(page.getByText('Record the outcome', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Failed', { exact: true }).first()).toBeVisible();
  });

  test('adjusts the price with a percentage discount and shows calculated, adjustment and final', async ({
    page,
    world,
  }) => {
    await page.goto(`${base}/jobs/${ids.jobSuccess}`);
    await expect(page.getByRole('heading', { name: 'Gearbox housing' })).toBeVisible();
    const prices = page.locator('.mj-price-details').first();
    await expect(prices).toContainText('Calculated');
    await expect(prices).toContainText('€12.50');
    await expect(prices).not.toContainText('Final');

    await page.getByRole('button', { name: 'Adjust price' }).click();
    const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Adjust price' }) });
    await expect(dialog).toBeVisible();
    // A job with a calculated price starts on the percentage discount.
    await expect(dialog.getByRole('radio', { name: 'Discount (%)' })).toBeChecked();
    await dialog.getByRole('textbox', { name: 'Discount (%)' }).fill('20');
    await expect(dialog.getByText('€10.00')).toBeVisible();
    await dialog.getByLabel('Reason').fill('Member discount');
    await dialog.getByRole('button', { name: 'Save adjustment' }).click();

    await expect(page.getByText('Price adjusted', { exact: true })).toBeVisible();
    expect(world.bodyOf('PUT', `/api/v1/machine-jobs/${ids.jobSuccess}/price-adjustment`)).toEqual({
      kind: 'discount_percent',
      value: '20',
      reason: 'Member discount',
      expectedVersion: 3,
    });
    await expect(prices).toContainText('Calculated');
    await expect(prices).toContainText('Discount 20 %');
    await expect(prices).toContainText('−€2.50');
    await expect(prices).toContainText('Final');
    await expect(prices).toContainText('€10.00');
    await expect(prices).toContainText('Member discount');
  });
});

test.describe('runs', () => {
  test('adds a run (a reprint) to a job and sums the runtime', async ({ page, world }) => {
    await page.goto(`${base}/jobs/${ids.jobSuccess}`);
    await expect(page.getByRole('heading', { name: 'Gearbox housing' })).toBeVisible();
    const facts = page.locator('.fact-tiles').first();
    await expect(facts).toContainText('1 h 30 min');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add to job' });
    await dialog.getByRole('radio', { name: 'A manual run' }).check({ force: true });
    await dialog.getByRole('radio', { name: 'Already done' }).check({ force: true });
    await expect(dialog.getByRole('combobox', { name: 'Outcome' })).toHaveValue('Successful');
    await pickMaterial(page, dialog, 'Birch plywood');
    await dialog.getByLabel('Quantity (m²)').fill('25');
    await dialog.getByRole('button', { name: 'Add run' }).click();

    await expect(page.getByText('Run added', { exact: true })).toBeVisible();
    expect(world.bodyOf('POST', `/api/v1/machine-jobs/${ids.jobSuccess}/runs`)).toMatchObject({
      expectedJobVersion: 3,
      run: {
        outcome: 'successful',
        usages: [{ ownership: 'makerspace', materialId: ids.plywood, quantity: '25', quantityBasis: 'actual' }],
      },
    });
    const runs = page.getByRole('table', { name: 'Runs' });
    await expect(runs.getByRole('link', { name: 'RN-2026-000020' })).toBeVisible();
    await expect(runs.getByRole('link', { name: 'RN-2026-000001' })).toBeVisible();
    await expect(facts).toContainText('2 h 30 min');
  });

  test('creates a job from an unassigned recorded run', async ({ page, world }) => {
    await page.goto(`${base}/jobs/runs/${ids.runUnassigned}`);
    await expect(page.getByRole('heading', { name: 'Bracket v2' })).toBeVisible();
    await page.getByRole('button', { name: 'Claim', exact: true }).first().click();

    const dialog = page.getByRole('dialog', { name: 'Claim run' });
    await dialog.getByRole('radio', { name: 'New job' }).check({ force: true });
    await expect(dialog.getByLabel('Title')).toHaveValue('Bracket v2');
    await dialog.getByLabel('Title').fill('Bracket for Jonas');
    await expect(dialog.getByRole('button', { name: 'Create job' })).toBeDisabled();
    await chooseCustomerAndOperator(page, dialog);
    await dialog.getByRole('button', { name: 'Create job' }).click();

    await expect(page.getByText('Job created', { exact: true })).toBeVisible();
    expect(world.bodyOf('POST', `/api/v1/machine-runs/${ids.runUnassigned}/job`)).toMatchObject({
      title: 'Bracket for Jonas',
      customer: { kind: 'organization', id: customer.id },
      operatorPersonId: operator.personId,
    });
    // The new job opens.
    await expect(page).toHaveURL(`${base}/jobs/${ids.newJob}`);
    await expect(page.getByRole('heading', { name: 'Bracket for Jonas' })).toBeVisible();
  });

  test('attaches an unassigned run to a manual job and replaces the manual run', async ({ page, world }) => {
    await page.goto(`${base}/jobs/runs/${ids.runUnassigned}`);
    await page.getByRole('button', { name: 'Claim', exact: true }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Claim run' });
    await dialog.getByRole('radio', { name: /^Attach to a job on/ }).check({ force: true });
    await pickOption(page, dialog.getByRole('combobox', { name: 'Job' }), /J-2026-000003/);

    await expect(dialog.getByRole('checkbox', { name: /^Replace the job’s manual run/ })).toBeChecked();
    await dialog.getByRole('button', { name: 'Attach to job' }).click();

    expect(world.bodyOf('PUT', `/api/v1/machine-runs/${ids.runUnassigned}/job`)).toMatchObject({
      machineJobId: ids.jobManualBambu,
      replaceManualRuns: true,
      expectedJobVersion: 3,
    });
    // The job opens, and the run is no longer unassigned.
    await expect(page).toHaveURL(`${base}/jobs/${ids.jobManualBambu}`);
    await page.goto(`${base}/jobs/runs/${ids.runUnassigned}`);
    await expect(page.getByRole('link', { name: /J-2026-000003/ }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Claim', exact: true })).toHaveCount(0);
  });

  test('attaches a running recorded run from the job and detaches it again', async ({ page, world }) => {
    await page.goto(`${base}/jobs/${ids.jobManualBambu}`);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add to job' });
    await dialog.getByRole('radio', { name: /^A run .* recorded$/ }).check({ force: true });
    await pickOption(page, dialog.getByRole('combobox', { name: 'Recorded run' }), /Enclosure lid/);
    await dialog.getByRole('checkbox', { name: /^Replace the job’s manual run/ }).uncheck({ force: true });
    await dialog.getByRole('button', { name: 'Attach run' }).click();
    await expect(page.getByText('RN-2026-000009 → J-2026-000003')).toBeVisible();
    expect(world.bodyOf('PUT', `/api/v1/machine-runs/${ids.runRunning}/job`)).toMatchObject({
      machineJobId: ids.jobManualBambu,
      replaceManualRuns: false,
      expectedJobVersion: 3,
    });
    const runs = page.getByRole('table', { name: 'Runs' });
    await expect(runs.getByRole('link', { name: 'RN-2026-000009' })).toBeVisible();
    await expect(runs.getByRole('progressbar')).toBeVisible();

    await runs
      .getByRole('row', { name: /RN-2026-000009/ })
      .locator('.cds--overflow-menu')
      .click();
    await page.getByRole('menuitem', { name: 'Detach from job' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Detach' }).click();
    await expect(page.getByText('Run detached', { exact: true })).toBeVisible();
    expect(world.sent('DELETE', `/api/v1/machine-runs/${ids.runRunning}/job`)).toHaveLength(1);
    await expect(runs.getByRole('link', { name: 'RN-2026-000009' })).toHaveCount(0);
  });

  test('shows the recorded run of a job with the "From machine" labels', async ({ page }) => {
    await page.goto(`${base}/jobs/${ids.jobLinked}`);
    const runs = page.getByRole('table', { name: 'Runs' });
    await expect(runs.getByRole('link', { name: 'RN-2026-000007' })).toBeVisible();
    await expect(runs.getByText('From machine', { exact: true })).toHaveCount(2);
    await runs.getByRole('link', { name: 'RN-2026-000007' }).click();
    await expect(page).toHaveURL(`${base}/jobs/runs/${ids.runLinked}`);
    await expect(page.getByRole('heading', { name: 'Gearbox housing v3' })).toBeVisible();
  });

  test('redirects the former print URL to the run', async ({ page }) => {
    await page.goto(`${base}/jobs/prints/${ids.runUnassigned}`);
    await expect(page).toHaveURL(`${base}/jobs/runs/${ids.runUnassigned}`);
  });
});

test.describe('inventory', () => {
  test('retires a spool whose rest was thrown away', async ({ page, world }) => {
    await page.goto(`${base}/inventory/spools/${ids.spoolSingle}`);
    await expect(page.getByRole('heading', { level: 1, name: 'S-PLA-BLACK-02' })).toBeVisible();
    await openOverflow(page);
    await page.getByRole('menuitem', { name: 'Retire' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Retire S-PLA-BLACK-02?' });
    await dialog.getByText(/The rest was thrown away/).click();
    await dialog.getByRole('button', { name: 'Write off 80 g' }).click();
    await expect(page.getByText('S-PLA-BLACK-02 retired')).toBeVisible();
    expect(world.bodyOf('POST', `/api/v1/filament-spools/${ids.spoolSingle}/retire`)).toEqual({
      expectedVersion: 5,
      outcome: 'discarded',
    });
  });

  test('restores a retired spool from the inventory recycle bin', async ({ page, world }) => {
    await page.goto(`${base}/inventory?tab=bin`);
    const spools = page.getByRole('table', { name: 'Retired spools' });
    await expect(spools.getByText('40 g thrown away')).toBeVisible();
    await spools.getByRole('button', { name: 'Restore S-2026-000004' }).click();
    const dialog = page.getByRole('dialog', { name: 'Restore S-2026-000004?' });
    await expect(dialog.getByText('The 40 g written off come back as stock.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Restore' }).click();
    await expect(page.getByText('S-2026-000004 restored')).toBeVisible();
    expect(world.bodyOf('POST', `/api/v1/inventory/recycle-bin/spools/${ids.spoolArchivedOld}/restore`)).toEqual({
      expectedVersion: 5,
    });
  });
});

test.describe('statistics', () => {
  test('keeps the machine selection in the URL and requests an exclusive end when the period changes', async ({
    page,
    world,
  }) => {
    await page.goto(`/statistics?period=custom&from=2026-01-01&to=2026-01-31`);
    await expect(page.getByLabel('Key figures')).toBeVisible();
    expect(world.statisticsRequests[0].get('from')).toBe('2026-01-01');
    expect(world.statisticsRequests[0].get('to')).toBe('2026-02-01');

    await page.getByRole('combobox', { name: 'Period' }).click();
    await page.getByRole('option', { name: 'Last 30 days' }).click();
    await expect(page).toHaveURL(/period=30d/);
    await expect.poll(() => world.statisticsRequests.length).toBeGreaterThan(1);
    const [from, to] = [world.statisticsRequests.at(-1)!.get('from')!, world.statisticsRequests.at(-1)!.get('to')!];
    // 30 days including today, so the exclusive end is the day after today.
    expect((Date.parse(to) - Date.parse(from)) / 86_400_000).toBe(30);
    expect(Date.parse(to)).toBeGreaterThan(Date.now() - 86_400_000);

    // The four busiest machines are compared by default; a different choice lives in the URL and survives a reload.
    await page.getByRole('tab', { name: 'Machines' }).click();
    await expect(page).toHaveURL(/tab=machines/);
    const picker = page.getByRole('combobox', { name: /Machines/ });
    await expect(picker).toContainText('4 selected');
    await picker.click();
    await page.getByRole('option', { name: 'CNC mill' }).click();
    await expect(page).toHaveURL(new RegExp('machines='));
    await page.keyboard.press('Escape');
    const machines = new URL(page.url()).searchParams.get('machines')!.split(',');
    expect(machines).toHaveLength(3);
    expect(machines).not.toContain(ids.mill);
    await page.reload();
    await expect(page.getByRole('combobox', { name: /Machines/ })).toContainText('3 selected');
    expect(new URL(page.url()).searchParams.get('machines')!.split(',')).toEqual(machines);
    expect(new URL(page.url()).searchParams.get('period')).toBe('30d');
  });

  for (const width of [375, 1440])
    test(`every statistics tab passes axe and fits ${width}px`, async ({ page }) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ width, height: 900 });
      for (const tab of ['Overview', 'Machines', 'Materials', 'Money', 'Explore']) {
        await page.goto(`/statistics?tab=${tab.toLowerCase()}`);
        await expect(page.getByRole('tab', { name: tab, selected: true })).toBeVisible();
        await expect(page.locator('.stats-card__chart svg.layout-svg-wrapper').first()).toBeVisible();
        await expectNoHorizontalScroll(page);
        await expectNoAccessibilityViolations(page);
      }
    });

  test('chooses a custom period in a dialog and shows a chart as a table', async ({ page, world }) => {
    await page.goto('/statistics?tab=money');
    await expect(page.getByLabel('Money figures')).toBeVisible();
    await page.getByRole('combobox', { name: 'Period' }).click();
    await page.getByRole('option', { name: 'Custom range…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Custom period' });
    await dialog.getByLabel('From').fill('01.01.2026');
    await dialog.getByLabel('To').fill('31.01.2026');
    await dialog.getByLabel('To').press('Tab');
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await expect(page).toHaveURL(/period=custom.*from=2026-01-01.*to=2026-01-31/);
    await expect.poll(() => world.statisticsRequests.at(-1)?.get('to')).toBe('2026-02-01');
    await expect(page.getByRole('combobox', { name: 'Period' })).toContainText('Custom · 01.01.2026 – 31.01.2026');

    await page.getByLabel('Show Share of charges by pricing group as table').click();
    const table = page.getByRole('table', { name: 'Share of charges by pricing group' });
    await expect(table.getByRole('row', { name: /Members €900.00/ })).toBeVisible();
    await expectNoAccessibilityViolations(page);
  });
});
