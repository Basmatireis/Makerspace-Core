import { expect, test, type APIResponse, type Page } from '@playwright/test';
import { signInWithPassword } from './totp';

const masterLogin = 'e2e-master@example.test';
const masterPassword = 'E2E master workshop passphrase 42';

test.skip(
  process.env.PLAYWRIGHT_FULL_STACK !== 'true',
  'Run through make test-e2e against the isolated Go/PostgreSQL stack.',
);

test.describe.configure({ mode: 'serial' });

type Identified = { id: string; version: number };
type Material = Identified & {
  inventoryVersion: number;
  quantity: string;
};
type MachineJob = Identified & {
  displayId: string;
  status: string;
  outcome: string;
  runs: { id: string; version: number; source: string }[];
  calculatedPrice: string | null;
  effectivePrice: string | null;
  priceAdjustment: { kind: string; value: string; reason: string } | null;
  pricingStatus: string;
};
type WorkItemPage = { items: { kind: string; id: string; status: string; source: string }[]; total: number };

async function signIn(page: Page) {
  await signInWithPassword(page, masterLogin, masterPassword);
}

async function parse<T>(response: APIResponse, label: string): Promise<T> {
  const body = await response.text();
  expect(response.ok(), `${label}: ${response.status()} ${body}`).toBeTruthy();
  return JSON.parse(body) as T;
}

test('persists the manual-run, cancel and price-adjustment workflow through the live API and UI', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);

  const origin = new URL(page.url()).origin;
  const csrfCookie = (await page.context().cookies()).find((cookie) => cookie.name.includes('csrf'));
  expect(csrfCookie).toBeDefined();
  const headers = { Origin: origin, 'X-CSRF-Token': csrfCookie!.value };
  const get = (path: string) => page.request.get(`${origin}/api/v1${path}`);
  const post = (path: string, data: unknown) => page.request.post(`${origin}/api/v1${path}`, { headers, data });
  const put = (path: string, data: unknown) => page.request.put(`${origin}/api/v1${path}`, { headers, data });

  const me = await parse<{ person: { id: string } }>(await get('/auth/me'), 'current user');
  const machineType = await parse<Identified>(
    await post('/machine-types', { name: 'E2E additive manufacturing', process: 'fdm_printing' }),
    'create machine type',
  );
  const machine = await parse<Identified>(
    await post('/machines', {
      name: 'E2E printer',
      machineTypeId: machineType.id,
      status: 'active',
      externalIdentifier: 'E2E-PRINTER-01',
      automaticCollectionEnabled: true,
    }),
    'create machine',
  );
  const materialType = await parse<Identified>(
    await post('/material-types', {
      name: `E2E PLA ${Date.now()}`,
      kind: 'filament',
      unit: 'g',
      processes: ['fdm_printing'],
    }),
    'create material type',
  );
  let material = await parse<Material>(
    await post('/materials', {
      name: 'E2E PLA blue',
      materialTypeId: materialType.id,
      colorName: 'Blue',
      colorHex: '#1E40AF',
      lowStockThreshold: '100',
    }),
    'create material',
  );
  const purchase = await parse<{ material: Material }>(
    await post(`/materials/${material.id}/purchases`, {
      quantity: '1000',
      totalPrice: '20.00',
      occurredAt: new Date().toISOString(),
      supplier: 'E2E supplier',
      expectedInventoryVersion: material.inventoryVersion,
    }),
    'purchase material',
  );
  material = purchase.material;

  const organization = await parse<Identified & { pricingGroupAssignmentVersion: number }>(
    await post('/organizations', { name: 'E2E partner institute', kind: 'institute' }),
    'create organization',
  );
  const pricingGroup = await parse<Identified>(
    await post('/pricing-groups', {
      name: 'E2E partner pricing',
      description: 'Live browser-test pricing.',
      isDefault: false,
    }),
    'create pricing group',
  );
  await parse<Identified>(
    await post(`/pricing-groups/${pricingGroup.id}/rules`, {
      kind: 'machine_runtime',
      machineTypeId: machineType.id,
      rate: '5.00',
    }),
    'create runtime rule',
  );
  await parse<Identified>(
    await post(`/pricing-groups/${pricingGroup.id}/rules`, {
      kind: 'material',
      materialTypeId: materialType.id,
      rate: '0.10',
    }),
    'create material rule',
  );
  const assignment = await put('/billing-party-pricing-group', {
    party: { kind: 'organization', id: organization.id },
    pricingGroupId: pricingGroup.id,
    expectedVersion: organization.pricingGroupAssignmentVersion,
  });
  expect(assignment.status(), await assignment.text()).toBe(204);

  // A finished manual job: exactly two hours at 5.00 per hour plus 50 g at 0.10 per gram.
  const second = Math.floor(Date.now() / 1000) * 1000;
  const startsAt = new Date(second - 121 * 60_000).toISOString();
  const endsAt = new Date(second - 60_000).toISOString();
  const finished = await parse<MachineJob>(
    await post('/machine-jobs', {
      machineId: machine.id,
      title: 'E2E gearbox housing',
      customer: { kind: 'organization', id: organization.id },
      operatorPersonId: me.person.id,
      notes: 'Created by the live Playwright slice.',
      run: {
        startsAt,
        endsAt,
        outcome: 'successful',
        usages: [{ ownership: 'makerspace', materialId: material.id, quantity: '50', quantityBasis: 'actual' }],
      },
    }),
    'create finished manual job',
  );
  expect(finished.runs).toHaveLength(1);
  expect(finished.runs[0].source).toBe('manual');
  expect(finished.status).toBe('successful');
  expect(finished.pricingStatus).toBe('complete');
  expect(Number(finished.calculatedPrice)).toBeCloseTo(15, 2);
  expect(finished.priceAdjustment).toBeNull();

  material = await parse<Material>(await get(`/materials/${material.id}`), 'read consumed material');
  expect(material.quantity).toBe('950');

  // A job whose end lies in the future runs until it ends or is cancelled early; its outcome is not recorded yet.
  const running = await parse<MachineJob>(
    await post('/machine-jobs', {
      machineId: machine.id,
      title: 'E2E long run',
      customer: { kind: 'organization', id: organization.id },
      operatorPersonId: me.person.id,
      run: {
        startsAt: new Date(second - 10 * 60_000).toISOString(),
        endsAt: new Date(second + 110 * 60_000).toISOString(),
        outcome: null,
        usages: [{ ownership: 'makerspace', materialId: material.id, quantity: '10', quantityBasis: 'actual' }],
      },
    }),
    'create running manual job',
  );
  expect(running.status).toBe('running');
  const runningItems = await parse<WorkItemPage>(
    await get(`/machine-logbook/work-items?status=running&machineId=${machine.id}`),
    'running work items',
  );
  expect(runningItems.items.map((item) => item.id)).toContain(running.id);

  const cancelled = await parse<MachineJob>(
    await post(`/machine-runs/${running.runs[0].id}/cancellation`, { expectedVersion: running.runs[0].version }),
    'cancel run',
  );
  expect(cancelled.status).toBe('cancelled');
  expect(cancelled.outcome).toBe('cancelled');
  expect(cancelled.version).toBeGreaterThan(running.version);
  const cancelledItems = await parse<WorkItemPage>(
    await get(`/machine-logbook/work-items?status=cancelled&machineId=${machine.id}`),
    'cancelled work items',
  );
  expect(cancelledItems.items.map((item) => item.id)).toEqual([running.id]);

  // A price adjustment keeps the calculated price and changes the effective one.
  const adjusted = await parse<MachineJob>(
    await put(`/machine-jobs/${finished.id}/price-adjustment`, {
      kind: 'fixed',
      value: '12.34',
      reason: 'E2E approved adjustment',
      expectedVersion: finished.version,
    }),
    'adjust price',
  );
  expect(adjusted.priceAdjustment).toMatchObject({ kind: 'fixed', value: '12.34', reason: 'E2E approved adjustment' });
  expect(adjusted.effectivePrice).toBe('12.34');
  expect(adjusted.calculatedPrice).toBe(finished.calculatedPrice);

  // No machine has reported a run yet (they come from connectors); the unassigned recorded runs list is empty.
  const recorded = await parse<{ items: unknown[] }>(
    await get(`/machine-runs?machineId=${machine.id}&assigned=false&source=recorded`),
    'list unassigned runs',
  );
  expect(recorded.items).toEqual([]);

  // Statistics take a half-open range, so the end is the day after today.
  const from = startsAt.slice(0, 10);
  const to = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const statistics = await parse<{ totals: { jobs: number }; machines: { machineId: string; jobs: number }[] }>(
    await get(`/machine-logbook/statistics?from=${from}&to=${to}`),
    'read statistics',
  );
  expect(statistics.totals.jobs).toBeGreaterThanOrEqual(2);
  expect(statistics.machines.find((row) => row.machineId === machine.id)?.jobs).toBe(2);

  await page.goto(`/machine-logbook/jobs/${finished.id}`);
  await expect(page.getByRole('heading', { name: 'E2E gearbox housing', level: 1 })).toBeVisible();
  await expect(page.getByText('E2E printer', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('€12.34', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('€15.00', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('E2E approved adjustment')).toBeVisible();

  await page.goto(`/machine-logbook/jobs/${running.id}`);
  await expect(page.getByRole('heading', { name: 'E2E long run', level: 1 })).toBeVisible();
  await expect(page.getByText('Cancelled', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('table', { name: 'Runs' }).getByRole('progressbar')).toHaveCount(0);
});
