import type { Page } from '@playwright/test';
import { expect, test, expectNoAccessibilityViolations, expectNoHorizontalScroll } from './machines-jobs-test';
import { ids } from './machines-jobs-api';

const base = '/machine-logbook';
const bambu = 'Bambu H2D #1';
const overflowMenu = (page: Page) => page.locator('.page-header__actions .cds--overflow-menu');

for (const width of [320, 390, 414, 768, 1440]) {
  test(`machine list, detail and printer setup at ${width}px`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    const routes = [
      [`${base}/machines`, 'Machines'],
      [`${base}/machines/${ids.bambu}`, bambu],
      [`${base}/machines/${ids.bambu}?tab=jobs`, bambu],
      [`${base}/machines/${ids.bambu}?tab=printer`, bambu],
    ] as const;
    for (const [route, title] of routes) {
      await page.goto(route);
      await expect(page.getByRole('heading', { name: title, exact: true, level: 1 })).toBeVisible();
      await page.waitForLoadState('networkidle');
      await expectNoHorizontalScroll(page);
      await expectNoAccessibilityViolations(page);
      if (width === 320 || width === 1440)
        await page.screenshot({
          path: testInfo.outputPath(`${route.split('/').at(-1)!.replace(/\W/g, '-')}.png`),
          fullPage: true,
        });
    }

    // The edit dialog is reachable and fits the viewport; cancelling leaves the machine unchanged.
    await page.goto(`${base}/machines/${ids.bambu}`);
    await overflowMenu(page).click();
    await page.getByRole('menuitem', { name: 'Edit machine' }).click();
    const edit = page.getByRole('dialog', { name: 'Edit machine' });
    await edit.getByLabel('Name', { exact: true }).fill('Unsaved machine name');
    await expect(page.getByRole('button', { name: 'Save machine' })).toBeInViewport();
    await expectNoAccessibilityViolations(page);
    await edit.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect(page.getByRole('heading', { name: bambu, level: 1 })).toBeVisible();

    await page.goto(`${base}/machines/${ids.bambu}?tab=printer`);
    await page.getByRole('button', { name: 'Edit spool inputs' }).click();
    const unit = page.getByRole('dialog', { name: 'Edit spool inputs' });
    await unit.getByRole('button', { name: 'Add input unit' }).click();
    await expect(unit.getByRole('button', { name: 'Save spool inputs' })).toBeInViewport();
    await expectNoAccessibilityViolations(page);
  });
}

test('saves a machine with the version it was opened with and shows the new name', async ({ page, world }) => {
  await page.goto(`${base}/machines/${ids.laser}`);
  await overflowMenu(page).click();
  await page.getByRole('menuitem', { name: 'Edit machine' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit machine' });
  await edit.getByLabel('Name', { exact: true }).fill('Laser cutter 2');
  await edit.getByRole('button', { name: 'Save machine' }).click();
  await expect(page.getByRole('heading', { name: 'Laser cutter 2', level: 1 })).toBeVisible();
  expect(world.bodyOf('PATCH', `/api/v1/machines/${ids.laser}`)).toMatchObject({
    name: 'Laser cutter 2',
    status: 'active',
    expectedVersion: 3,
  });
});

test('adds a machine from the list', async ({ page, world }) => {
  await page.goto(`${base}/machines`);
  await page.locator('.cds--table-toolbar').getByRole('button', { name: 'Add machine' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add machine' });
  await dialog.getByLabel('Name', { exact: true }).fill('Vinyl cutter');
  await dialog.getByLabel('Machine type').selectOption({ label: 'Laser cutter' });
  await dialog.getByRole('button', { name: 'Create and continue' }).click();
  await expect.poll(() => world.sent('POST', '/api/v1/machines')).toHaveLength(1);
  expect(world.bodyOf('POST', '/api/v1/machines')).toEqual({
    name: 'Vinyl cutter',
    machineTypeId: ids.typeLaser,
    status: 'active',
    externalIdentifier: null,
    automaticCollectionEnabled: false,
  });
  await expect(page.getByRole('link', { name: 'Vinyl cutter' })).toBeVisible();
});

test('saves the spool inputs of a printer atomically', async ({ page, world }) => {
  await page.goto(`${base}/machines/${ids.bambu}?tab=printer`);
  await page.getByRole('button', { name: 'Edit spool inputs' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit spool inputs' });
  await dialog.getByRole('button', { name: 'Add input unit' }).click();
  await dialog.getByLabel('Input unit name').last().fill('Rear feed');
  await dialog.getByRole('button', { name: 'Save spool inputs' }).click();
  await expect.poll(() => world.sent('PUT', `/api/v1/machines/${ids.bambu}/printer/setup`)).toHaveLength(1);
  expect(world.bodyOf('PUT', `/api/v1/machines/${ids.bambu}/printer/setup`)).toMatchObject({
    expectedVersion: 4,
    enabled: true,
    inputUnits: [
      { id: ids.unit, name: 'AMS A' },
      { name: 'Rear feed', slots: [{ name: 'Slot 1' }] },
    ],
  });
});
