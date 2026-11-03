import type { Locator, Page } from '@playwright/test';
import { expect, test, expectNoAccessibilityViolations, expectNoHorizontalScroll } from './machines-jobs-test';
import { ids, readerPermissions } from './machines-jobs-api';

const base = '/workshop';
const heading = (name: string | RegExp, level?: number) => (page: Page) => page.getByRole('heading', { name, level });
const text = (value: string | RegExp) => (page: Page) => page.getByText(value).first();

type Target = { name: string; path: string; ready: (page: Page) => Locator };

const targets: Target[] = [
  { name: 'Jobs', path: `${base}/jobs`, ready: (page) => page.getByRole('table', { name: 'Jobs' }) },
  {
    name: 'Jobs filtered to unassigned runs',
    path: `${base}/jobs?status=unassigned`,
    ready: (page) => page.getByRole('button', { name: 'bracket_v2.gcode' }),
  },
  { name: 'Job detail (finished)', path: `${base}/jobs/${ids.jobSuccess}`, ready: heading('Gearbox housing', 1) },
  { name: 'Job detail (running)', path: `${base}/jobs/${ids.jobRunning}`, ready: heading('Engraving run', 1) },
  {
    name: 'Job detail (needs outcome)',
    path: `${base}/jobs/${ids.jobNeedsOutcome}`,
    ready: text('Record the outcome'),
  },
  {
    name: 'Job detail (manual run, recorded runs available)',
    path: `${base}/jobs/${ids.jobManualBambu}`,
    ready: (page) => page.getByRole('button', { name: 'Add', exact: true }),
  },
  {
    name: 'Job detail (recorded run)',
    path: `${base}/jobs/${ids.jobLinked}`,
    ready: (page) => page.getByRole('table', { name: 'Runs' }).getByText('From machine').first(),
  },
  {
    name: 'Run detail (unassigned)',
    path: `${base}/jobs/runs/${ids.runUnassigned}`,
    ready: (page) => page.getByRole('button', { name: 'Claim', exact: true }).first(),
  },
  { name: 'Run detail (running)', path: `${base}/jobs/runs/${ids.runRunning}`, ready: text('Run in progress') },
  {
    name: 'Run detail (in a job)',
    path: `${base}/jobs/runs/${ids.runLinked}`,
    ready: (page) => page.getByRole('link', { name: /J-2026-000004/ }),
  },
  {
    name: 'Machines',
    path: `${base}/machines`,
    ready: (page) => page.getByRole('table', { name: 'Machines' }).getByText('Bambu H2D #1'),
  },
  {
    name: 'Machine detail, Overview tab',
    path: `${base}/machines/${ids.bambu}`,
    ready: text('Degraded · E42'),
  },
  {
    name: 'Machine detail, Jobs tab',
    path: `${base}/machines/${ids.bambu}?tab=jobs`,
    ready: (page) => page.getByRole('table', { name: 'Jobs' }),
  },
  {
    name: 'Machine detail, Printer setup tab',
    path: `${base}/machines/${ids.bambu}/printer`,
    ready: (page) => page.getByRole('switch', { name: 'Printer profile enabled' }),
  },
  {
    name: 'Machines, Processes tab',
    path: `${base}/machines?tab=processes`,
    ready: (page) => page.getByRole('table', { name: 'Processes' }),
  },
  {
    name: 'Inventory, Filament tab',
    path: `${base}/inventory`,
    ready: (page) =>
      page.getByRole('table', { name: 'Articles' }).getByRole('link', { name: 'PLA Black', exact: true }),
  },
  {
    name: 'Inventory, Spools tab',
    path: `${base}/inventory?tab=spools`,
    ready: (page) => page.getByRole('table', { name: 'Spools' }).getByRole('link', { name: 'S-PLA-BLACK-01' }),
  },
  {
    name: 'Inventory, Recycle bin tab',
    path: `${base}/inventory?tab=bin`,
    ready: (page) => page.getByRole('table', { name: 'Retired spools' }).getByRole('link', { name: 'S-2026-000003' }),
  },
  {
    name: 'Inventory, Materials tab',
    path: `${base}/inventory?tab=articles`,
    ready: (page) => page.getByRole('table', { name: 'Articles' }).getByRole('link', { name: 'Birch plywood' }),
  },
  {
    name: 'Material detail (filament)',
    path: `${base}/inventory/materials/${ids.pla}`,
    ready: heading('PLA Black', 1),
  },
  {
    name: 'Material detail (sheet)',
    path: `${base}/inventory/materials/${ids.plywood}`,
    ready: heading('Birch plywood', 1),
  },
  {
    name: 'Spool detail (with identifiers)',
    path: `${base}/inventory/spools/${ids.spoolReusable}`,
    ready: (page) => page.getByRole('table', { name: 'Identifiers' }),
  },
  {
    name: 'Spool detail (almost empty)',
    path: `${base}/inventory/spools/${ids.spoolSingle}`,
    ready: (page) => page.getByRole('button', { name: 'Weigh' }),
  },
  {
    name: 'Statistics',
    path: `${base}/statistics?tab=machines`,
    ready: (page) => page.getByRole('table', { name: 'Machines' }),
  },
];

async function settle(page: Page) {
  await page.waitForLoadState('networkidle');
  // Carbon Charts load lazily behind the statistics boundary.
  if (page.url().includes('/statistics'))
    await expect(page.locator('.stats-card__chart svg.layout-svg-wrapper').first()).toBeVisible();
}

test.describe('every page passes axe and fits a 375px phone', () => {
  for (const target of targets) {
    test(target.name, async ({ page, world }) => {
      test.setTimeout(60_000);
      await page.goto(target.path);
      await expect(target.ready(page)).toBeVisible();
      await settle(page);
      await expectNoHorizontalScroll(page);
      await expectNoAccessibilityViolations(page);

      await page.setViewportSize({ width: 375, height: 812 });
      await expect(target.ready(page)).toBeVisible();
      await settle(page);
      await expectNoHorizontalScroll(page);
      await expectNoAccessibilityViolations(page);
      expect(world.requests).toEqual([]);
    });
  }
});

test.describe('dialogs pass axe and fit a 375px phone', () => {
  async function checkDialog(page: Page, dialog: Locator) {
    await expect(dialog).toBeVisible();
    await expectNoAccessibilityViolations(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await expectNoHorizontalScroll(page);
    const box = await dialog.boundingBox();
    expect(box, 'the dialog is laid out').not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(375);
    // The footer buttons stay reachable without scrolling the page.
    const primary = dialog.locator('.cds--modal-footer .cds--btn--primary, .cds--btn--danger').last();
    await expect(primary).toBeInViewport();
    await expectNoAccessibilityViolations(page);
  }

  test('new job', async ({ page }) => {
    await page.goto(`${base}/jobs`);
    await page.getByRole('button', { name: 'New job' }).first().click();
    await checkDialog(page, page.getByRole('dialog', { name: 'New job' }));
  });

  test('new job from a run', async ({ page }) => {
    await page.goto(`${base}/jobs/runs/${ids.runUnassigned}`);
    await page.getByRole('button', { name: 'Claim', exact: true }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Claim run' });
    await dialog.getByRole('radio', { name: 'New job' }).check({ force: true });
    await checkDialog(page, dialog);
  });

  test('edit job', async ({ page }) => {
    await page.goto(`${base}/jobs/${ids.jobSuccess}`);
    await page.getByRole('button', { name: 'Edit job' }).click();
    await checkDialog(page, page.getByRole('dialog', { name: 'Edit job' }));
  });

  test('adjust price', async ({ page }) => {
    await page.goto(`${base}/jobs/${ids.jobSuccess}`);
    await page.getByRole('button', { name: 'Adjust price' }).click();
    await checkDialog(
      page,
      page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Adjust price' }) }),
    );
  });

  test('cancel run confirmation', async ({ page }) => {
    await page.goto(`${base}/jobs/${ids.jobRunning}`);
    await page.getByRole('table', { name: 'Runs' }).locator('.cds--overflow-menu').click();
    await page.getByRole('menuitem', { name: 'Cancel run' }).click();
    await checkDialog(page, page.getByRole('alertdialog'));
  });

  test('attach run to job (from a run, with the comparison)', async ({ page }) => {
    await page.goto(`${base}/jobs/runs/${ids.runUnassigned}`);
    await page.getByRole('button', { name: 'Claim', exact: true }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Claim run' });
    await dialog.getByRole('radio', { name: /^Attach to a job on/ }).check({ force: true });
    const job = dialog.getByRole('combobox', { name: 'Job' });
    await expect(async () => {
      const option = page.getByRole('option', { name: /J-2026-000003/ });
      if (!(await option.isVisible())) await job.click();
      await expect(option).toBeVisible({ timeout: 1000 });
    }).toPass();
    await page.getByRole('option', { name: /J-2026-000003/ }).click();
    await expect(dialog.getByText('Manual run', { exact: true }).first()).toBeVisible();
    await checkDialog(page, dialog);
  });

  test('attach recorded run to a job (from a job, with the comparison)', async ({ page }) => {
    await page.goto(`${base}/jobs/${ids.jobManualBambu}`);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add to job' });
    await dialog.getByRole('radio', { name: /^A run .* recorded$/ }).check({ force: true });
    const run = dialog.getByRole('combobox', { name: 'Recorded run' });
    await expect(async () => {
      const option = page.getByRole('option', { name: /Bracket v2/ });
      if (!(await option.isVisible())) await run.click();
      await expect(option).toBeVisible({ timeout: 1000 });
    }).toPass();
    await page.getByRole('option', { name: /Bracket v2/ }).click();
    await expect(dialog.getByText('Manual run', { exact: true }).first()).toBeVisible();
    await checkDialog(page, dialog);
  });

  test('add run', async ({ page }) => {
    await page.goto(`${base}/jobs/${ids.jobSuccess}`);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add to job' });
    await dialog.getByRole('radio', { name: 'A manual run' }).check({ force: true });
    await checkDialog(page, dialog);
  });

  test('detach run confirmation', async ({ page }) => {
    await page.goto(`${base}/jobs/${ids.jobLinked}`);
    await page.getByRole('table', { name: 'Runs' }).locator('.cds--overflow-menu').click();
    await page.getByRole('menuitem', { name: 'Detach from job' }).click();
    await checkDialog(page, page.getByRole('alertdialog'));
  });

  test('register spool', async ({ page }) => {
    await page.goto(`${base}/inventory?tab=spools`);
    await page.getByRole('button', { name: 'Register spool' }).click();
    await checkDialog(page, page.getByRole('dialog', { name: 'Register spool' }));
  });

  test('retire spool', async ({ page }) => {
    await page.goto(`${base}/inventory/spools/${ids.spoolSingle}`);
    await page.locator('.page-header__actions .cds--overflow-menu').click();
    await page.getByRole('menuitem', { name: 'Retire' }).click();
    await checkDialog(page, page.getByRole('alertdialog', { name: 'Retire S-PLA-BLACK-02?' }));
  });

  test('weigh spool', async ({ page }) => {
    await page.goto(`${base}/inventory/spools/${ids.spoolReusable}`);
    await page.getByRole('button', { name: 'Weigh' }).click();
    await checkDialog(page, page.getByRole('dialog', { name: /S-PLA-BLACK-01/ }));
  });

  test('delete ledger entry', async ({ page }) => {
    await page.goto(`${base}/inventory/materials/${ids.pla}`);
    await page.getByRole('table', { name: 'Ledger' }).locator('.inv-actions-column button').first().click();
    await checkDialog(page, page.getByRole('alertdialog', { name: 'Delete ledger entry?' }));
  });

  test('add machine', async ({ page }) => {
    await page.goto(`${base}/machines`);
    await page.locator('.cds--table-toolbar').getByRole('button', { name: 'Add machine' }).click();
    await checkDialog(page, page.getByRole('dialog', { name: 'Add machine' }));
  });

  test('add machine wizard, printer type', async ({ page }) => {
    await page.goto(`${base}/machines`);
    await page.locator('.cds--table-toolbar').getByRole('button', { name: 'Add machine' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add machine' });
    await dialog.getByLabel('Process').selectOption({ label: '3D printer' });
    await expect(dialog.getByRole('radio', { name: /Bambu Lab H2D/ })).toBeVisible();
    await checkDialog(page, dialog);
  });
});

test.describe('navigation and former URLs', () => {
  test('lists Jobs, Machines, Inventory and Statistics in that order', async ({ page }) => {
    await page.goto(base);
    await expect(page).toHaveURL(`${base}/jobs`);
    const nav = page.getByRole('navigation', { name: 'Primary navigation' });
    const group = nav.getByRole('listitem').filter({ has: page.getByRole('button', { name: 'Workshop' }) });
    await expect(group.getByRole('link')).toHaveText(['Jobs', 'Machines', 'Inventory', 'Statistics']);
    await expect(nav.getByRole('link', { name: 'Review' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Print submissions' })).toHaveCount(0);
    await expect(group.getByRole('link', { name: 'Jobs' })).toHaveAttribute('aria-current', 'page');
    await group.getByRole('link', { name: 'Statistics' }).click();
    await expect(page).toHaveURL(`${base}/statistics`);
    await expect(group.getByRole('link', { name: 'Statistics' })).toHaveAttribute('aria-current', 'page');
  });

  test('is reachable through the navigation drawer on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`${base}/jobs`);
    await page.getByRole('button', { name: 'Open navigation' }).click();
    const nav = page.getByRole('navigation', { name: 'Primary navigation' });
    await expect(nav.getByRole('link', { name: 'Machines' })).toBeVisible();
    await expectNoAccessibilityViolations(page);
    await nav.getByRole('link', { name: 'Machines' }).click();
    await expect(page).toHaveURL(`${base}/machines`);
    await expect(page.getByRole('heading', { name: 'Machines', level: 1 })).toBeVisible();
  });

  test('Machines & Jobs URLs move to Workshop with their sub-path and query', async ({ page }) => {
    await page.goto('/machine-logbook');
    await expect(page).toHaveURL(`${base}/jobs`);
    await page.goto('/machine-logbook/overview');
    await expect(page).toHaveURL(`${base}/jobs`);
    await page.goto('/machine-logbook/jobs?status=unassigned');
    await expect(page).toHaveURL(`${base}/jobs?status=unassigned`);
    await page.goto(`/machine-logbook/machines/${ids.bambu}?tab=printer`);
    await expect(page).toHaveURL(`${base}/machines/${ids.bambu}/printer`);
  });

  test('older inventory and printer URLs land on the new pages', async ({ page }) => {
    await page.goto(`${base}/inventory/${ids.pla}`);
    await expect(page).toHaveURL(`${base}/inventory/materials/${ids.pla}`);
    await page.goto(`${base}/machines/${ids.bambu}?tab=printer`);
    await expect(page).toHaveURL(`${base}/machines/${ids.bambu}/printer`);
    await expect(page.getByRole('tab', { name: 'Printer setup', selected: true })).toBeVisible();
    await page.goto(`${base}/spools`);
    await expect(page).toHaveURL(`${base}/inventory?tab=spools`);
  });
});

test.describe('read-only role', () => {
  test.use({ userPermissions: readerPermissions });

  test('offers no job actions on Jobs, job detail and run detail', async ({ page, world }) => {
    await page.goto(`${base}/jobs`);
    await expect(page.getByRole('table', { name: 'Jobs' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New job' })).toHaveCount(0);

    await page.goto(`${base}/jobs/${ids.jobRunning}`);
    await expect(page.getByRole('progressbar', { name: 'Run progress' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add', exact: true })).toHaveCount(0);
    await expect(page.getByRole('table', { name: 'Runs' }).locator('.cds--overflow-menu')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Edit job' })).toHaveCount(0);
    await expect(page.locator('.page-header__actions .cds--overflow-menu')).toHaveCount(0);

    await page.goto(`${base}/jobs/${ids.jobSuccess}`);
    await expect(page.getByRole('heading', { name: 'Gearbox housing', level: 1 })).toBeVisible();
    await expect(page.getByText('Adjust price')).toHaveCount(0);
    await expect(page.locator('.page-header__actions .cds--overflow-menu')).toHaveCount(0);

    await page.goto(`${base}/jobs/${ids.jobNeedsOutcome}`);
    await expect(page.getByText('Outcome not recorded yet')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save outcome' })).toHaveCount(0);

    await page.goto(`${base}/jobs/runs/${ids.runUnassigned}`);
    await expect(page.getByRole('heading', { name: 'Bracket v2' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Claim', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'More run actions' })).toHaveCount(0);
    expect(world.requests).toEqual([]);
  });

  test('offers no inventory changes: Weigh, Retire, Register spool, Receive stock, Delete', async ({ page }) => {
    await page.goto(`${base}/inventory/spools/${ids.spoolReusable}`);
    await expect(page.getByRole('heading', { name: 'S-PLA-BLACK-01', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Weigh' })).toHaveCount(0);
    await expect(page.locator('.page-header__actions .cds--overflow-menu')).toHaveCount(0);

    await page.goto(`${base}/inventory?tab=spools`);
    await expect(page.getByRole('table', { name: 'Spools' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Register spool' })).toHaveCount(0);

    await page.goto(`${base}/inventory`);
    await expect(
      page.getByRole('table', { name: 'Articles' }).getByRole('link', { name: 'PLA Black', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Receive stock' })).toHaveCount(0);

    await page.goto(`${base}/inventory?tab=bin`);
    await expect(page.getByRole('table', { name: 'Retired spools' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Restore/ })).toHaveCount(0);
  });

  test('offers no machine changes: Add machine, New job, Printer setup', async ({ page }) => {
    await page.goto(`${base}/machines`);
    await expect(page.getByRole('table', { name: 'Machines' }).getByText('Bambu H2D #1')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add machine' })).toHaveCount(0);
    await page.goto(`${base}/machines/${ids.laser}`);
    await expect(page.getByRole('heading', { name: 'Laser cutter', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New job' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Printer setup' })).toHaveCount(0);
  });

  test('every page of the area stays readable and passes axe', async ({ page, world }) => {
    test.slow(); // six pages with a full axe scan each; ~20s alone, so it exceeds 30s when workers compete for CPU
    for (const path of [
      base,
      `${base}/jobs`,
      `${base}/jobs/${ids.jobSuccess}`,
      `${base}/machines`,
      `${base}/inventory`,
      `${base}/statistics`,
    ]) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expectNoAccessibilityViolations(page);
    }
    expect(world.requests).toEqual([]);
  });
});

test.describe('role without job access', () => {
  test.use({ userPermissions: ['statistics.read'] });

  test('shows Statistics only and sends Jobs, Machines and Inventory back to the dashboard', async ({ page }) => {
    await page.goto(`${base}/statistics`);
    const group = page
      .getByRole('navigation', { name: 'Primary navigation' })
      .getByRole('listitem')
      .filter({ has: page.getByRole('button', { name: 'Workshop' }) });
    await expect(group.getByRole('link')).toHaveText(['Statistics']);
    for (const path of ['jobs', 'machines', 'inventory']) {
      await page.goto(`${base}/${path}`);
      await expect(page).toHaveURL(/\/dashboard$/);
    }
  });
});

test.describe('printer connectors under Settings, Local services', () => {
  test.use({
    userPermissions: ['machines.read', 'printer_connectors.read', 'printer_connectors.manage'],
  });

  test('the former Connectors tab leads there, and the page passes axe and fits a phone', async ({ page, world }) => {
    test.setTimeout(60_000);
    await page.goto(`${base}/machines?tab=connectors`);
    await expect(page).toHaveURL(/\/settings\/local-services\?tab=connectors$/);
    await expect(page.getByRole('table', { name: 'Printer connectors' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectNoAccessibilityViolations(page);

    await page.getByRole('tab', { name: 'Versions and updates' }).click();
    const updates = page.getByRole('table', { name: 'Versions and updates' });
    await expect(updates.getByText('Update available')).toBeVisible();
    await expect(updates.getByRole('button', { name: 'Update to 0.8.3' })).toBeVisible();
    await page.setViewportSize({ width: 375, height: 812 });
    await expectNoHorizontalScroll(page);
    await expectNoAccessibilityViolations(page);
    expect(world.requests).toEqual([]);
  });
});
