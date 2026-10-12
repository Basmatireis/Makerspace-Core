import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { currentUserFixture } from '../src/test/fixtures';
import { PermissionId } from '../src/api/generated/models';
import { defaultPublicBrandingConfiguration } from './branding-fixtures';

const machineId = '0192f6f8-743e-7c77-a349-cd07c3e8a911';
const submissionId = '0192f6f8-743e-7c77-a349-cd07c3e8a912';
const now = '2026-09-15T11:26:00Z';
const machine = { id: machineId, name: 'Workshop laser cutter', machineType: { id: '0192f6f8-743e-7c77-a349-cd07c3e8a910', name: 'Laser cutter', active: true, version: 1, createdAt: now, updatedAt: now }, status: 'active', automaticCollectionEnabled: false, jobCount: 3, runtimeSeconds: 600, failureRate: '0', version: 7, createdAt: now, updatedAt: now };
const submission = { id: submissionId, displayId: 'P-2026-00001', machineId, machineName: machine.name, title: 'An enclosure with a long descriptive name', state: 'in_progress', declarations: [], attempts: [{ id: 'attempt-1', submissionId, attemptNumber: 1, machineId, machineName: machine.name, state: 'printing', machineJobId: '0192f6f8-743e-7c77-a349-cd07c3e8a999', declarations: [], events: [{ id: 'event-1', kind: 'consumption_report', occurredAt: now, sourceId: 'connector', reconciliationState: 'pending', payload: { grams: 20 } }], version: 6, createdAt: now, updatedAt: now }], version: 8, createdAt: now, updatedAt: now };
async function install(page: Page) {
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/v1/auth/me') return json(currentUserFixture([PermissionId.machinesread, PermissionId.machinesmanage, PermissionId.printer_slotsassign, PermissionId.inventoryread, PermissionId.print_submissionsread, PermissionId.print_submissionsmanage, PermissionId.machine_jobsread, PermissionId.machine_jobsedit]));
    if (path === '/api/v1/auth/activity') return json({ idleExpiresAt: '2099-01-01T00:00:00Z', absoluteExpiresAt: '2099-01-02T00:00:00Z', postSessionDestination: 'login' });
    if (path === '/api/v1/public/config') return json(defaultPublicBrandingConfiguration());
    if (path === '/api/v1/auth/oidc/providers') return json({ items: [] });
    if (path === '/api/v1/machines') return json({ items: [machine], total: 1, page: 1, pageSize: 25 });
    if (path === `/api/v1/machines/${machineId}`) return json(machine);
    if (path === '/api/v1/machine-types') return json({ items: [machine.machineType] });
    if (path === `/api/v1/machines/${machineId}/printer`) return json({ machineId, machineName: machine.name, enabled: true, version: 4, inputUnits: [{ id: 'unit-1', name: 'Direct feed', position: 0 }], slots: [{ id: 'slot-1', inputUnitId: 'unit-1', name: 'Front feed slot', position: 0, status: 'available' }] });
    if (path === '/api/v1/print-submissions') return json({ items: [submission], total: 1, page: 1, pageSize: 25 });
    if (path === `/api/v1/print-submissions/${submissionId}`) return json(submission);
    if (path === '/api/v1/materials' || path === '/api/v1/filament-spools') return json({ items: [], total: 0, page: 1, pageSize: 25 });
    throw new Error(`Unexpected catalog request: ${request.method()} ${path}`);
  });
}
for (const width of [320, 390, 414, 768, 1440]) {
  test(`catalog, detail, printer and print workflows at ${width}px`, async ({ page }, testInfo) => {
    test.setTimeout(120000);
    await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ reducedMotion: 'reduce' }); await install(page);
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    const routes = [['/machine-logbook/machines', 'Machines'], [`/machine-logbook/machines/${machineId}`, machine.name], [`/machine-logbook/machines/${machineId}/printer`, machine.name], ['/machine-logbook/print-submissions', 'Print submissions'], [`/machine-logbook/print-submissions/${submissionId}`, submission.displayId]];
    for (const [route, title] of routes) {
      await page.goto(route); await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if (route.endsWith(submissionId)) { const status = page.getByText('printing', { exact: true }); await expect(status).toBeVisible(); expect(await status.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true); }
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze(); expect(results.violations).toEqual([]);
      if (width === 320 || width === 1440) await page.screenshot({ path: testInfo.outputPath(`${route.split('/').at(-1)}.png`), fullPage: true });
    }
    await page.getByRole('button', { name: 'Cancel attempt', exact: true }).click();
    const confirm = page.getByRole('alertdialog'); await expect(confirm.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await expect(confirm.getByRole('button', { name: 'Cancel attempt', exact: true })).toBeInViewport();
    await page.keyboard.press('Escape'); await expect(confirm).not.toBeVisible();
    await page.goto(`/machine-logbook/machines/${machineId}`);
    await page.getByRole('button', { name: 'Edit machine' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Unsaved machine name');
    await expect(page.getByRole('button', { name: 'Save machine' })).toBeInViewport();
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    await page.keyboard.press('Escape'); await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('button', { name: 'Keep editing' }).click(); await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Unsaved machine name');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await page.getByRole('button', { name: 'Discard changes' }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit machine' })).toBeFocused();
    await page.goto(`/machine-logbook/machines/${machineId}/printer`);
    await page.getByRole('button', { name: 'Add input unit' }).click(); await page.getByLabel('Name', { exact: true }).fill('Rear feed');
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeInViewport();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await page.getByRole('button', { name: 'Discard changes' }).click();
    await page.goto('/machine-logbook/print-submissions'); await page.getByRole('button', { name: 'New submission' }).click();
    await page.getByLabel('Title', { exact: true }).fill('New enclosure');
    await expect(page.getByRole('button', { name: 'Create submission', exact: true })).toBeInViewport();
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'Keep editing' }).click();
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue('New enclosure');
    expect(errors).toEqual([]);
  });
}
