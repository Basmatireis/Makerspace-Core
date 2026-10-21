import type { Locator, Page } from '@playwright/test';
import { expect, test, expectNoAccessibilityViolations, expectNoHorizontalScroll } from './machines-jobs-test';
import { ids, readerPermissions } from './machines-jobs-api';

const base = '/machine-logbook';
const heading = (name: string | RegExp, level?: number) => (page: Page) => page.getByRole('heading', { name, level });
const text = (value: string | RegExp) => (page: Page) => page.getByText(value).first();

type Target = { name: string; path: string; ready: (page: Page) => Locator };

const targets: Target[] = [
  { name: 'Overview', path: base, ready: heading('Overview', 1) },
  { name: 'Jobs', path: `${base}/jobs`, ready: (page) => page.getByRole('table', { name: 'Jobs' }) },
  {
    name: 'Jobs filtered to unassigned runs',
    path: `${base}/jobs?status=unassigned`,
    ready: (page) => page.getByRole('link', { name: 'bracket_v2.gcode' }),
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
    ready: (page) => page.getByRole('button', { name: 'Attach recorded run' }),
  },
  {
    name: 'Job detail (recorded run)',
    path: `${base}/jobs/${ids.jobLinked}`,
    ready: (page) => page.getByRole('table', { name: 'Runs' }).getByText('From machine').first(),
  },
  {
    name: 'Run detail (unassigned)',
    path: `${base}/jobs/runs/${ids.runUnassigned}`,
    ready: (page) => page.getByRole('button', { name: 'Create job' }),
  },
  { name: 'Run detail (running)', path: `${base}/jobs/runs/${ids.runRunning}`, ready: text('Run in progress') },
  {
    name: 'Run detail (in a job)',
    path: `${base}/jobs/runs/${ids.runLinked}`,
    ready: (page) => page.getByRole('link', { name: /J-2026-000004/ }),
  },
  { name: 'Machines', path: `${base}/machines`, ready: (page) => page.getByRole('link', { name: 'Bambu H2D #1' }) },
  {
    name: 'Machine detail, Overview tab',
    path: `${base}/machines/${ids.bambu}`,
    ready: text('Connector degraded · E42'),
  },
  {
    name: 'Machine detail, Jobs tab',
    path: `${base}/machines/${ids.bambu}?tab=jobs`,
    ready: (page) => page.getByRole('link', { name: 'Open in Jobs' }),
  },
  {
    name: 'Machine detail, Printer setup tab',
    path: `${base}/machines/${ids.bambu}?tab=printer`,
    ready: (page) => page.getByRole('switch', { name: 'Printer profile enabled' }),
  },
  {
    name: 'Machines, Machine types tab',
    path: `${base}/machines?tab=types`,
    ready: (page) => page.getByRole('table', { name: 'Machine types' }),
  },
  {
    name: 'Inventory, Filament tab',
    path: `${base}/inventory`,
    ready: (page) => page.getByRole('table', { name: 'Materials' }).getByRole('link', { name: 'Black', exact: true }),
  },
  {
    name: 'Inventory, Spools tab',
    path: `${base}/inventory?tab=spools`,
    ready: (page) => page.getByRole('table', { name: 'Spools' }).getByRole('link', { name: 'S-2026-000001' }),
  },
  {
    name: 'Inventory, Spools tab with archived spools',
    path: `${base}/inventory?tab=spools&spoolsarchived=1`,
    ready: (page) => page.getByRole('table', { name: 'Spools' }).getByRole('link', { name: 'S-2026-000003' }),
  },
  {
    name: 'Inventory, Materials tab',
    path: `${base}/inventory?tab=materials`,
    ready: (page) => page.getByRole('table', { name: 'Materials' }).getByRole('link', { name: 'Birch plywood' }),
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
    name: 'Spool detail (reusable, with fill history)',
    path: `${base}/inventory/spools/${ids.spoolReusable}`,
    ready: (page) => page.getByRole('table', { name: 'Fills' }),
  },
  {
    name: 'Spool detail (single-use)',
    path: `${base}/inventory/spools/${ids.spoolSingle}`,
    ready: (page) => page.getByRole('button', { name: 'Record consumption' }),
  },
  { name: 'Statistics', path: `${base}/statistics`, ready: (page) => page.getByRole('table', { name: 'Machines' }) },
];

async function settle(page: Page) {
  await page.waitForLoadState('networkidle');
  // Carbon Charts load lazily behind the statistics boundary.
  if (page.url().includes('/statistics'))
    await expect(page.locator('.mj-stats-chart svg.layout-svg-wrapper').first()).toBeVisible();
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
    await page.getByRole('button', { name: 'Create job' }).click();
    await checkDialog(page, page.getByRole('dialog', { name: 'New job' }));
  });

  test('edit job', async ({ page }) => {
    await page.goto(`${base}/jobs/${ids.jobSuccess}`);
    await page.getByRole('button', { name: 'Edit job' }).click();
    await checkDialog(page, page.getByRole('dialog', { name: 'Edit job' }));
  });

  test('adjust price', async ({ page }) => {
    await page.goto(`${base}/jobs/${ids.jobSuccess}`);
    await page.locator('.page-header__actions .cds--overflow-menu').click();
    await page.getByRole('menuitem', { name: 'Adjust price' }).click();
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
    await page.getByRole('button', { name: 'Attach to job' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('combobox', { name: /Job/ }).click();
    await page.getByRole('option', { name: /J-2026-000003/ }).click();
    await expect(dialog.getByText('Manual run', { exact: true })).toBeVisible();
    await checkDialog(page, dialog);
  });

  test('attach recorded run to a job (from a job, with the comparison)', async ({ page }) => {
    await page.goto(`${base}/jobs/${ids.jobManualBambu}`);
    await page.getByRole('button', { name: 'Attach recorded run' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('combobox', { name: /Recorded run/ }).click();
    await page.getByRole('option', { name: /Bracket v2/ }).click();
    await expect(dialog.getByText('Manual run', { exact: true })).toBeVisible();
    await checkDialog(page, dialog);
  });

  test('add run', async ({ page }) => {
    await page.goto(`${base}/jobs/${ids.jobSuccess}`);
    await page.getByRole('button', { name: 'Add run' }).click();
    await checkDialog(page, page.getByRole('dialog', { name: 'Add run' }));
  });

  test('detach run confirmation', async ({ page }) => {
    await page.goto(`${base}/jobs/${ids.jobLinked}`);
    await page.getByRole('table', { name: 'Runs' }).locator('.cds--overflow-menu').click();
    await page.getByRole('menuitem', { name: 'Detach from job' }).click();
    await checkDialog(page, page.getByRole('alertdialog'));
  });

  test('change filament, spool step', async ({ page }) => {
    await page.goto(`${base}/inventory?tab=spools`);
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Change filament' }).click();
    await checkDialog(page, page.getByRole('dialog', { name: 'Change filament' }));
  });

  // Opened from a spool, the dialog starts on the leftover step.
  for (const [step, nextClicks] of [
    ['leftover', 0],
    ['new filament', 1],
    ['tags and review', 2],
  ] as const) {
    test(`change filament, ${step} step`, async ({ page }) => {
      await page.goto(`${base}/inventory/spools/${ids.spoolReusable}`);
      await page.getByRole('button', { name: 'Change filament' }).click();
      const dialog = page.getByRole('dialog', { name: 'Change filament' });
      for (let index = 0; index < nextClicks; index += 1) await dialog.getByRole('button', { name: 'Next' }).click();
      await checkDialog(page, dialog);
    });
  }

  test('finish spool', async ({ page }) => {
    await page.goto(`${base}/inventory/spools/${ids.spoolSingle}`);
    await page.locator('.page-header__actions .cds--overflow-menu').click();
    await page.getByRole('menuitem', { name: 'Finish spool' }).click();
    await checkDialog(page, page.getByRole('dialog', { name: /S-2026-000002/ }));
  });

  test('clean up archived spools', async ({ page }) => {
    await page.goto(`${base}/inventory?tab=spools`);
    await page.getByRole('table', { name: 'Spools' }).waitFor();
    await page.locator('.cds--table-toolbar .cds--overflow-menu').click();
    await page.getByRole('menuitem', { name: 'Clean up archived spools' }).click();
    const dialog = page.getByRole('dialog', { name: 'Clean up archived spools' });
    await expect(dialog.getByText(/archived single-use spools match/)).toBeVisible();
    await checkDialog(page, dialog);
  });

  test('register spool', async ({ page }) => {
    await page.goto(`${base}/inventory?tab=spools`);
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Register spool' }).click();
    await checkDialog(page, page.getByRole('dialog'));
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
    await dialog.getByLabel('Machine type').selectOption({ label: '3D printer' });
    await expect(dialog.getByRole('radio', { name: /Bambu Lab H2D/ })).toBeVisible();
    await checkDialog(page, dialog);
  });
});

test.describe('navigation and former URLs', () => {
  test('lists Overview, Jobs, Machines, Inventory and Statistics in that order', async ({ page }) => {
    await page.goto(base);
    const nav = page.getByRole('navigation', { name: 'Primary navigation' });
    const group = nav.getByRole('listitem').filter({ has: page.getByRole('button', { name: 'Workshop' }) });
    await expect(group.getByRole('link')).toHaveText(['Overview', 'Jobs', 'Machines', 'Inventory', 'Statistics']);
    await expect(nav.getByRole('link', { name: 'Review' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Print submissions' })).toHaveCount(0);
    await expect(group.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
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

  test('older inventory and printer URLs land on the new pages', async ({ page }) => {
    await page.goto(`${base}/inventory/${ids.pla}`);
    await expect(page).toHaveURL(`${base}/inventory/materials/${ids.pla}`);
    await page.goto(`${base}/machines/${ids.bambu}/printer`);
    await expect(page).toHaveURL(`${base}/machines/${ids.bambu}?tab=printer`);
    await expect(page.getByRole('tab', { name: 'Printer setup', selected: true })).toBeVisible();
    await page.goto(`${base}/spools`);
    await expect(page).toHaveURL(`${base}/inventory?tab=spools`);
  });
});

test.describe('read-only role', () => {
  test.use({ userPermissions: readerPermissions });

  test('offers no job actions on Overview, Jobs, job detail and run detail', async ({ page, world }) => {
    await page.goto(`${base}/jobs`);
    await expect(page.getByRole('table', { name: 'Jobs' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New job' })).toHaveCount(0);

    await page.goto(base);
    await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New job' })).toHaveCount(0);

    await page.goto(`${base}/jobs/${ids.jobRunning}`);
    await expect(page.getByRole('progressbar', { name: 'Run progress' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add run' })).toHaveCount(0);
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
    await expect(page.getByRole('button', { name: 'Create job' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Attach to job' })).toHaveCount(0);
    expect(world.requests).toEqual([]);
  });

  test('offers no inventory changes: Change filament, New, Clean up, Receive stock', async ({ page }) => {
    await page.goto(`${base}/inventory/spools/${ids.spoolReusable}`);
    await expect(page.getByRole('heading', { name: 'S-2026-000001', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Change filament' })).toHaveCount(0);
    await expect(page.locator('.page-header__actions .cds--overflow-menu')).toHaveCount(0);

    await page.goto(`${base}/inventory?tab=spools`);
    await expect(page.getByRole('table', { name: 'Spools' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New', exact: true })).toHaveCount(0);
    await expect(page.locator('.cds--table-toolbar .cds--overflow-menu')).toHaveCount(0);

    await page.goto(`${base}/inventory`);
    await expect(
      page.getByRole('table', { name: 'Materials' }).getByRole('link', { name: 'Black', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Receive stock' })).toHaveCount(0);
  });

  test('offers no machine changes: Add machine, New job, Printer setup', async ({ page }) => {
    await page.goto(`${base}/machines`);
    await expect(page.getByRole('link', { name: 'Bambu H2D #1' })).toBeVisible();
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

  test('shows Overview and Statistics only and sends Jobs, Machines and Inventory back to the dashboard', async ({
    page,
  }) => {
    await page.goto(base);
    const group = page
      .getByRole('navigation', { name: 'Primary navigation' })
      .getByRole('listitem')
      .filter({ has: page.getByRole('button', { name: 'Workshop' }) });
    await expect(group.getByRole('link')).toHaveText(['Overview', 'Statistics']);
    for (const path of ['jobs', 'machines', 'inventory']) {
      await page.goto(`${base}/${path}`);
      await expect(page).toHaveURL(/\/dashboard$/);
    }
  });
});
