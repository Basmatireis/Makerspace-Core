import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';

const machineTypeId = '0192f6f8-743e-7c77-a349-cd07c3e8a910';
const machineId = '0192f6f8-743e-7c77-a349-cd07c3e8a911';
const materialId = '0192f6f8-743e-7c77-a349-cd07c3e8a912';
const jobId = '0192f6f8-743e-7c77-a349-cd07c3e8a914';
const organizationId = '0192f6f8-743e-7c77-a349-cd07c3e8a915';
const operatorId = '0192f6f8-743e-7c77-a349-cd07c3e8a916';
const pricingGroupId = '0192f6f8-743e-7c77-a349-cd07c3e8a917';
const now = '2026-09-15T11:26:00Z';

const permissions = [
  'machines.read',
  'machines.manage',
  'machine_jobs.read',
  'machine_jobs.create',
  'machine_jobs.edit',
  'machine_jobs.review',
  'machine_jobs.override_price',
  'inventory.read',
  'inventory.manage',
  'organizations.read',
  'organizations.manage',
  'pricing.read',
  'pricing.manage',
  'statistics.read',
];

const machineType = {
  id: machineTypeId,
  name: '3D printer',
  active: true,
  version: 1,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: now,
};

const machine = {
  id: machineId,
  machineType,
  name: 'Bambu H2D #1',
  status: 'active',
  externalIdentifier: 'BH2D-1',
  automaticCollectionEnabled: true,
  lastIngestedAt: now,
  jobCount: 42,
  runtimeSeconds: 84_000,
  failureRate: '4.2',
  version: 1,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: now,
};

const pricingGroup = {
  id: pricingGroupId,
  name: 'Partner institute',
  description: 'Rates for partner institutes.',
  active: true,
  isDefault: true,
  rules: [
    {
      id: '0192f6f8-743e-7c77-a349-cd07c3e8a920',
      kind: 'machine_runtime',
      machineTypeId,
      materialCategory: null,
      materialUnit: null,
      rate: '0.50',
      active: true,
      version: 1,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: '0192f6f8-743e-7c77-a349-cd07c3e8a921',
      kind: 'material',
      machineTypeId: null,
      materialCategory: 'pla',
      materialUnit: 'g',
      rate: '0.025',
      active: true,
      version: 1,
      createdAt: now,
      updatedAt: now,
    },
  ],
  version: 1,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: now,
};

const organization = {
  id: organizationId,
  name: 'TU Berlin — Fachbereich Maschinenbau',
  kind: 'institute',
  active: true,
  pricingGroup: { id: pricingGroupId, name: pricingGroup.name },
  pricingGroupAssignmentVersion: 1,
  version: 1,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: now,
};

const material = {
  id: materialId,
  name: 'PLA Black',
  category: 'pla',
  color: 'Black',
  unit: 'g',
  active: true,
  lowStockThreshold: '500',
  quantity: '8420',
  averageUnitCost: '0.018',
  inventoryValue: '151.56',
  stockState: 'in_stock',
  inventoryVersion: 7,
  recentConsumption: '2140',
  version: 2,
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: now,
};

const job = {
  id: jobId,
  displayId: 'J-2026-000001',
  machine,
  startsAt: '2026-09-15T08:12:00Z',
  endsAt: now,
  durationSeconds: 11_640,
  source: 'automatic',
  externalId: 'BH2D-00441',
  reviewState: 'confirmed',
  customer: {
    kind: 'organization',
    id: organizationId,
    displayName: organization.name,
    organizationKind: 'institute',
    pricingGroup: { id: pricingGroupId, name: pricingGroup.name },
    pricingGroupAssignmentVersion: 1,
  },
  operator: { personId: operatorId, displayName: 'Maria Hoffmann' },
  outcome: 'successful',
  notes: 'Front cover prototype.',
  usages: [
    {
      id: '0192f6f8-743e-7c77-a349-cd07c3e8a922',
      materialId,
      materialName: material.name,
      category: material.category,
      unit: 'g',
      quantity: '183',
    },
  ],
  pricingStatus: 'complete',
  pricingSnapshot: {
    id: '0192f6f8-743e-7c77-a349-cd07c3e8a923',
    revision: 1,
    reason: 'initial',
    pricingGroupName: pricingGroup.name,
    currency: 'EUR',
    complete: true,
    rules: [
      { kind: 'machine_runtime', label: '3D printer runtime', selector: machineTypeId, unit: 'hour', rate: '0.50', sourceRuleId: pricingGroup.rules[0].id, missing: false },
      { kind: 'material', label: 'PLA Black', selector: 'pla', unit: 'g', rate: '0.025', sourceRuleId: pricingGroup.rules[1].id, missing: false },
    ],
    calculatedAmount: '6.20',
    capturedAt: now,
  },
  calculatedPrice: '6.20',
  finalPrice: null,
  effectivePrice: '6.20',
  priceOverrideReason: null,
  priceOverriddenAt: null,
  billingStatus: 'unbilled',
  billingReference: null,
  version: 3,
  createdAt: now,
  updatedAt: now,
};

function currentUser() {
  const personId = '0192f6f8-743e-7c77-a349-cd07c3e8a901';
  const accountId = '0192f6f8-743e-7c77-a349-cd07c3e8a902';
  const account = {
    id: accountId,
    personId,
    loginEmail: 'ada.login@example.test',
    provisioningSource: 'local',
    firstAuthenticatedAt: '2026-01-01T00:00:00Z',
    authIdentities: [],
    status: 'enabled',
    passwordStatus: 'active',
    roles: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
  };
  return {
    person: {
      id: personId,
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.test',
      phone: null,
      account,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      version: 1,
    },
    account,
    permissions,
    authenticationAssurance: 'normal',
    managedDevice: null,
    delegablePermissionGrants: permissions.map((permissionId) => ({
      permissionId,
      scope: 'everywhere',
      deviceTypeIds: [],
      minimumAssurance: 'low',
    })),
    laborordnungStatus: {
      mode: 'not_required',
      state: 'not_required',
      actionRequired: false,
      currentVersion: null,
      latestConfirmedVersion: null,
      requestId: null,
    },
  };
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function installMachineLogbookApi(page: Page) {
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') {
      throw new Error(`Unexpected mutation in read-only page coverage: ${request.method()} ${path}`);
    }
    if (path === '/api/v1/auth/me') return json(route, currentUser());
    if (path === '/api/v1/auth/oidc/providers') return json(route, { items: [] });
    if (path === '/api/v1/machine-logbook/overview') {
      return json(route, {
        jobsToday: 4,
        jobsThisWeek: 34,
        unbilledJobs: 1,
        unbilledAmount: '6.20',
        needsReview: 1,
        failedOrPartialThisWeek: 2,
        lowStockItems: 1,
        activity: [
          { date: '2026-09-14', count: 7 },
          { date: '2026-09-15', count: 4 },
        ],
        lowStockMaterials: [{ ...material, quantity: '280', stockState: 'low_stock' }],
        recentJobs: [job],
      });
    }
    if (path === '/api/v1/machine-logbook/statistics') {
      return json(route, {
        materialUsageByCategory: [{ key: 'pla', label: 'PLA', value: '2140' }],
        machineRuntimeHours: [{ key: machineId, label: machine.name, value: '68.2' }],
        machineJobCounts: [{ key: machineId, label: machine.name, value: '42' }],
        acquisitionCost: [{ key: '2026-09', label: 'Sep 2026', value: '151.56' }],
        customerCharges: [{ key: '2026-09', label: 'Sep 2026', value: '428.20' }],
        adjustmentLoss: [{ key: '2026-09', label: 'Sep 2026', value: '18.30' }],
        machineFailureRates: [{ key: machineId, label: machine.name, value: '4.2' }],
      });
    }
    if (path === `/api/v1/machine-jobs/${jobId}`) return json(route, job);
    if (path === '/api/v1/machine-jobs/review-queue') {
      return json(route, { items: [{ ...job, reviewState: 'needs_review', customer: null, operator: null, outcome: 'unknown', pricingStatus: 'pending', pricingSnapshot: null, calculatedPrice: null, effectivePrice: null, version: 1 }] });
    }
    if (path === '/api/v1/machine-jobs') return json(route, { items: [job], page: 1, pageSize: 25, total: 1 });
    if (path === '/api/v1/billing-parties') {
      return json(route, { items: [{ kind: 'organization', id: organizationId, displayName: organization.name, organizationKind: 'institute', pricingGroup: organization.pricingGroup, pricingGroupAssignmentVersion: 1 }] });
    }
    if (path === '/api/v1/machine-job-operators') return json(route, { items: [{ personId: operatorId, displayName: 'Maria Hoffmann' }] });
    if (path === `/api/v1/materials/${materialId}/transactions`) {
      return json(route, {
        items: [{
          id: '0192f6f8-743e-7c77-a349-cd07c3e8a924',
          materialId,
          kind: 'machine_job_consumption',
          quantityDelta: '-183',
          unitAcquisitionCost: '0.018',
          inventoryValueDelta: '-3.294',
          totalPurchasePrice: null,
          occurredAt: now,
          supplier: null,
          note: null,
          adjustmentReason: null,
          machineJobId: jobId,
          machineJobDisplayId: job.displayId,
          createdAt: now,
        }],
        page: 1,
        pageSize: 25,
        total: 1,
      });
    }
    if (path === `/api/v1/materials/${materialId}`) return json(route, material);
    if (path === '/api/v1/materials') return json(route, { items: [material], page: 1, pageSize: 25, total: 1, totalInventoryValue: material.inventoryValue });
    if (path === `/api/v1/machines/${machineId}`) return json(route, machine);
    if (path === '/api/v1/machines') return json(route, { items: [machine], page: 1, pageSize: 100, total: 1 });
    if (path === '/api/v1/machine-types') return json(route, { items: [machineType] });
    if (path === '/api/v1/organizations') return json(route, { items: [organization], page: 1, pageSize: 100, total: 1 });
    if (path === '/api/v1/pricing-groups') return json(route, { items: [pricingGroup] });
    throw new Error(`Unexpected machine-logbook API request: ${request.method()} ${path}`);
  });
}

async function expectNoAccessibilityViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installMachineLogbookApi(page);
});

test('renders every machine-logbook page without browser errors and passes axe', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: Error[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => errors.push(error));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(`${new URL(page.url()).pathname}: ${message.text()}`);
  });
  const pages = [
    ['/machine-logbook', 'Machine logbook'],
    ['/machine-logbook/jobs', 'Jobs'],
    [`/machine-logbook/jobs/${jobId}`, job.displayId],
    ['/machine-logbook/review', 'Review queue'],
    ['/machine-logbook/inventory', 'Inventory'],
    [`/machine-logbook/inventory/${materialId}`, material.name],
    ['/machine-logbook/machines', 'Machines'],
    ['/machine-logbook/statistics', 'Statistics'],
    ['/settings/machine-logbook', 'Machine logbook configuration'],
  ] as const;

  for (const [path, heading] of pages) {
    await test.step(path, async () => {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: heading, exact: true }).first()).toBeVisible();
      await expectNoAccessibilityViolations(page);
      expect(consoleErrors).toEqual([]);
    });
  }
  expect(errors).toEqual([]);
});

test('keeps navigation and the review workflow usable at a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/machine-logbook/review');
  await expect(page.getByRole('heading', { name: 'Review queue' })).toBeVisible();

  const reviewList = page.getByLabel('Jobs awaiting review');
  const reviewDetail = page.locator('.review-detail');
  await expect(reviewList).toBeVisible();
  await expect(reviewDetail).toBeVisible();
  const listBox = await reviewList.boundingBox();
  const detailBox = await reviewDetail.boundingBox();
  expect(listBox).not.toBeNull();
  expect(detailBox).not.toBeNull();
  expect(detailBox!.y).toBeGreaterThan(listBox!.y);

  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Review' })).toBeVisible();
  await expectNoAccessibilityViolations(page);
});
