import { expect, test, type APIResponse, type Page } from '@playwright/test';

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
  calculatedPrice: string | null;
  effectivePrice: string | null;
  finalPrice: string | null;
  pricingStatus: string;
  reviewState: string;
};

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(masterLogin);
  await page.getByLabel('Password', { exact: true }).fill(masterPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

async function parse<T>(response: APIResponse, label: string): Promise<T> {
  const body = await response.text();
  expect(response.ok(), `${label}: ${response.status()} ${body}`).toBeTruthy();
  return JSON.parse(body) as T;
}

test('persists the complete machine-logbook workflow through the live API and UI', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);

  const origin = new URL(page.url()).origin;
  const csrfCookie = (await page.context().cookies()).find((cookie) => cookie.name.includes('csrf'));
  expect(csrfCookie).toBeDefined();
  const headers = { Origin: origin, 'X-CSRF-Token': csrfCookie!.value };
  const post = (path: string, data: unknown) => page.request.post(`${origin}/api/v1${path}`, { headers, data });
  const put = (path: string, data: unknown) => page.request.put(`${origin}/api/v1${path}`, { headers, data });

  const me = await parse<{ person: { id: string } }>(
    await page.request.get(`${origin}/api/v1/auth/me`),
    'current user',
  );
  const machineType = await parse<Identified>(
    await post('/machine-types', { name: 'E2E additive manufacturing' }),
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
  let material = await parse<Material>(
    await post('/materials', {
      name: 'E2E PLA blue',
      category: 'pla-e2e',
      color: 'Blue',
      unit: 'g',
      lowStockThreshold: '100',
    }),
    'create material',
  );
  const occurredAt = new Date().toISOString();
  const purchase = await parse<{ material: Material }>(
    await post(`/materials/${material.id}/purchases`, {
      quantity: '1000',
      totalPrice: '20.00',
      occurredAt,
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
      materialCategory: 'pla-e2e',
      materialUnit: 'g',
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

  const startsAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const endsAt = new Date().toISOString();
  const ingested = await parse<MachineJob>(
    await post('/machine-jobs/automatic', {
      machineId: machine.id,
      externalId: `E2E-${Date.now()}`,
      startsAt,
      endsAt,
      usages: [{ materialId: material.id, quantity: '50' }],
      externalMetadata: { collector: 'playwright' },
    }),
    'ingest automatic job',
  );
  expect(ingested.reviewState).toBe('needs_review');
  expect(ingested.version).toBe(1);

  const confirmed = await parse<MachineJob>(
    await post(`/machine-jobs/${ingested.id}/confirm`, {
      customer: { kind: 'organization', id: organization.id },
      operatorPersonId: me.person.id,
      outcome: 'successful',
      notes: 'Confirmed by the live Playwright slice.',
      expectedVersion: ingested.version,
    }),
    'confirm automatic job',
  );
  expect(confirmed.reviewState).toBe('confirmed');
  expect(confirmed.pricingStatus).toBe('complete');
  expect(Number(confirmed.calculatedPrice)).toBeCloseTo(15, 2);

  material = await parse<Material>(
    await page.request.get(`${origin}/api/v1/materials/${material.id}`),
    'read consumed material',
  );
  expect(material.quantity).toBe('950');

  const overridden = await parse<MachineJob>(
    await put(`/machine-jobs/${confirmed.id}/price-override`, {
      finalPrice: '12.34',
      reason: 'E2E approved adjustment',
      expectedVersion: confirmed.version,
    }),
    'override final price',
  );
  expect(overridden.finalPrice).toBe('12.34');
  expect(overridden.effectivePrice).toBe('12.34');
  expect(overridden.calculatedPrice).toBe(confirmed.calculatedPrice);

  const from = startsAt.slice(0, 10);
  const to = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const statistics = await parse<{ materialUsageByCategory: unknown[]; machineJobCounts: unknown[] }>(
    await page.request.get(`${origin}/api/v1/machine-logbook/statistics?from=${from}&to=${to}`),
    'read statistics',
  );
  expect(statistics.materialUsageByCategory.length).toBeGreaterThan(0);
  expect(statistics.machineJobCounts.length).toBeGreaterThan(0);

  await page.goto(`/machine-logbook/jobs/${confirmed.id}`);
  await expect(page.getByRole('heading', { name: /^J-/ })).toBeVisible();
  await expect(page.getByText('E2E printer', { exact: true })).toBeVisible();
  await expect(page.getByText('€12.34', { exact: true }).first()).toBeVisible();
});
