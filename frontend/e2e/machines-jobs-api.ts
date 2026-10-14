import type { Page, Route } from '@playwright/test';
import type {
  BillingParty, FilamentProduct, FilamentSpool, Machine, MachineActivity, MachineJob, MachineLogbookStatistics, Material, Operator, PrintDetail, PrinterProfile, WorkItem,
} from '../src/api/generated/models';
import { defaultPublicBrandingConfiguration } from './branding-fixtures';

/**
 * Stateful mock of the Machines & Jobs API for the mocked-API specs. Every request that is not a GET is recorded in
 * `world.requests`, requests the mock does not know answer 500 and are recorded in `world.unhandled`.
 */

export const id = (n: number) => `0192f6f8-743e-7c77-a349-cd07c3e8${String(n).padStart(4, '0')}`;
export const ids = {
  typePrinter: id(10), typeLaser: id(11),
  bambu: id(20), laser: id(21), saw: id(22), prusa: id(23), mill: id(24),
  pla: id(30), plywood: id(31),
  customer: id(40), operator: id(41), pricingGroup: id(42),
  jobSuccess: id(50), jobNeedsOutcome: id(51), jobManualBambu: id(52), jobLinked: id(53), jobRunning: id(54),
  printUnlinked: id(60), printLinked: id(61), printPrinting: id(62),
  spoolReusable: id(70), spoolSingle: id(71), spoolArchivedNew: id(72), spoolArchivedOld: id(73), spoolMounted: id(74),
  fillClosed: id(80), fillCurrent: id(81),
  productRefill: id(90), productSpool: id(91),
  nfc: id(95), barcode: id(96),
  unit: id(100), slot: id(101), newJob: id(110), newProduct: id(111),
};

export const staffPermissions = [
  'machines.read', 'machines.manage', 'machine_jobs.read', 'machine_jobs.create', 'machine_jobs.edit', 'machine_jobs.override_price',
  'inventory.read', 'inventory.manage', 'filament_spools.manage', 'printer_slots.assign', 'orders.read',
  'organizations.read', 'organizations.manage', 'pricing.read', 'pricing.manage', 'statistics.read',
];
/** Can look at everything in Machines & Jobs, but change nothing. */
export const readerPermissions = ['machines.read', 'machine_jobs.read', 'inventory.read', 'statistics.read'];

const minutes = (offset: number) => new Date(Date.now() + offset * 60_000).toISOString();
const created = '2026-09-01T00:00:00Z';
const pageOf = <T,>(items: T[], total = items.length) => ({ items, page: 1, pageSize: 100, total });

const machineType = (typeId: string, name: string) => ({ id: typeId, name, active: true, version: 1, createdAt: created, updatedAt: created });
const types = [machineType(ids.typePrinter, '3D printer'), machineType(ids.typeLaser, 'Laser cutter')];

const machine = (machineId: string, name: string, type: (typeof types)[number], overrides: Partial<Machine> = {}): Machine => ({
  id: machineId, name, machineType: type, status: 'active', externalIdentifier: null, automaticCollectionEnabled: false, lastIngestedAt: null,
  jobCount: 12, runtimeSeconds: 72_000, failureRate: '4.2', version: 3, createdAt: created, updatedAt: created, ...overrides,
});

export const customer: BillingParty = {
  kind: 'organization', id: ids.customer, displayName: 'TU Berlin', organizationKind: 'institute',
  pricingGroup: { id: ids.pricingGroup, name: 'Partner institute' }, pricingGroupAssignmentVersion: 1,
};
export const operator: Operator = { personId: ids.operator, displayName: 'Maria Hoffmann' };

const material = (materialId: string, name: string, overrides: Partial<Material> = {}): Material => ({
  id: materialId, name, category: 'filament', color: 'Black', unit: 'g', active: true, lowStockThreshold: '1000', quantity: '5000', assignedQuantity: '600', unassignedQuantity: '4400',
  filamentDiameterMm: '1.75', averageUnitCost: '0.018', inventoryValue: '90.00', stockState: 'in_stock', inventoryVersion: 7, recentConsumption: '240', version: 3,
  createdAt: created, updatedAt: created, ...overrides,
});

const product = (productId: string, manufacturer: string, name: string, packaging: 'refill' | 'spool', overrides: Partial<FilamentProduct> = {}): FilamentProduct => ({
  id: productId, manufacturer, name, materialId: ids.pla, materialName: 'PLA Black', netWeightG: '1000', defaultPrice: '19.90', packaging, notes: null, active: true, inUseCount: 1,
  version: 2, createdAt: created, updatedAt: created, ...overrides,
});

const identifiers = [
  { id: ids.nfc, kind: 'nfc' as const, value: '04AA11', createdAt: '2026-10-02T08:00:00Z' },
  { id: ids.barcode, kind: 'barcode' as const, value: 'BC-100', createdAt: '2026-09-01T08:00:00Z' },
];

const spool = (overrides: Partial<FilamentSpool>): FilamentSpool => ({
  id: ids.spoolReusable, displayId: 'S-2026-000001', kind: 'reusable', label: 'Bambu spool 01', status: 'loaded', fillNumber: 3, fillId: ids.fillCurrent, filledAt: '2026-10-02T08:00:00Z',
  archivedAt: null, materialId: ids.pla, materialName: 'PLA Black', category: 'filament', color: 'Black', unit: 'g', productId: ids.productRefill, manufacturer: 'Bambu Lab',
  productName: 'PLA Basic Black', initialNetWeightG: '1000', remainingQuantity: '600', tareWeightG: '200', acquiredOn: '2026-09-01', acquisitionReference: null, storageLocation: 'Shelf A',
  notes: null, lifecycle: 'active', mounted: false, identifiers, fills: [], version: 5, createdAt: '2026-09-01T08:00:00Z', updatedAt: '2026-10-02T08:00:00Z', ...overrides,
});

const closedFill = {
  id: ids.fillClosed, fillNumber: 2, materialId: ids.pla, materialName: 'PLA Black', productId: ids.productSpool, manufacturer: 'Prusament', productName: 'PLA Galaxy Black',
  initialNetWeightG: '1000', usedG: '940', leftoverG: '60', leftoverOutcome: 'returned_to_stock' as const, filledAt: '2026-09-01T08:00:00Z', closedAt: '2026-10-02T08:00:00Z',
  identifiers: [{ id: id(97), kind: 'nfc' as const, value: '04OLD1', createdAt: '2026-09-01T08:00:00Z' }],
};

const pricingSnapshot = {
  id: id(120), revision: 1, pricingGroupName: 'Partner institute', currency: 'EUR', reason: 'created', complete: true, calculatedAmount: '12.50', capturedAt: '2026-09-15T11:26:00Z',
  rules: [{ kind: 'machine_runtime', label: '3D printer runtime', selector: '3D printer', unit: 'hour', rate: '5.00', missing: false }],
};

type JobInit = Partial<MachineJob> & Pick<MachineJob, 'id' | 'displayId'>;
export function jobFixture(overrides: JobInit): MachineJob {
  return {
    title: null, machine: machine(ids.laser, 'Laser cutter', types[1]), startsAt: minutes(-180), endsAt: minutes(-90), durationSeconds: 5400, run: 'manual', print: null, customer, operator, outcome: 'successful', status: 'successful', notes: 'Print with 0.2 mm layers',
    usages: [{ id: id(130), ownership: 'makerspace', materialId: ids.pla, spoolId: null, spoolDisplayId: null, materialName: 'PLA Black', category: 'filament', unit: 'g', quantity: '183.000', quantityBasis: 'actual' }],
    pricingStatus: 'complete', pricingSnapshot, calculatedPrice: '12.50', priceAdjustment: null, effectivePrice: '12.50', version: 3, createdAt: created, updatedAt: created, ...overrides,
  } as MachineJob;
}

export type RecordedRequest = { method: string; path: string; search: string; body: unknown };

export type World = ReturnType<typeof createWorld>;

export function createWorld(permissions: string[] = staffPermissions) {
  const bambu = machine(ids.bambu, 'Bambu H2D #1', types[0], { automaticCollectionEnabled: true, externalIdentifier: 'BH2D-1', lastIngestedAt: minutes(-5), jobCount: 42 });
  const laser = machine(ids.laser, 'Laser cutter', types[1]);
  const saw = machine(ids.saw, 'Old saw', types[1], { status: 'retired' });
  const machines: Machine[] = [bambu, laser, saw];

  const materials: Material[] = [
    material(ids.pla, 'PLA Black'),
    material(ids.plywood, 'Birch plywood', { category: 'sheet', color: null, unit: 'm2', lowStockThreshold: null, quantity: '12', assignedQuantity: '0', unassignedQuantity: '12', filamentDiameterMm: null, averageUnitCost: '9', inventoryValue: '108', inventoryVersion: 4, version: 1 }),
  ];
  const products: FilamentProduct[] = [
    product(ids.productRefill, 'Bambu Lab', 'PLA Basic Black', 'refill'),
    product(ids.productSpool, 'Prusament', 'PLA Galaxy Black', 'spool', { defaultPrice: '24.99', inUseCount: 0 }),
  ];
  const spools: FilamentSpool[] = [
    spool({ fills: [closedFill] }),
    spool({ id: ids.spoolSingle, displayId: 'S-2026-000002', kind: 'single_use', label: null, status: 'active', fillNumber: 1, remainingQuantity: '120', initialNetWeightG: '1000', tareWeightG: null, identifiers: [], productId: ids.productSpool, manufacturer: 'Prusament', productName: 'PLA Galaxy Black' }),
    spool({ id: ids.spoolArchivedNew, displayId: 'S-2026-000003', kind: 'single_use', label: null, status: 'archived', lifecycle: 'archived', archivedAt: minutes(-60 * 24 * 150), remainingQuantity: '0', identifiers: [] }),
    spool({ id: ids.spoolArchivedOld, displayId: 'S-2026-000004', kind: 'single_use', label: null, status: 'archived', lifecycle: 'archived', archivedAt: minutes(-60 * 24 * 420), remainingQuantity: '0', identifiers: [] }),
  ];

  const jobs: MachineJob[] = [
    jobFixture({ id: ids.jobSuccess, displayId: 'J-2026-000001', title: 'Gearbox housing' }),
    jobFixture({ id: ids.jobNeedsOutcome, displayId: 'J-2026-000002', title: 'Lamp shade', startsAt: minutes(-90), endsAt: minutes(-10), durationSeconds: 4800, outcome: 'unknown', status: 'needs_outcome', calculatedPrice: null, effectivePrice: null, pricingStatus: 'pending', pricingSnapshot: undefined }),
    jobFixture({ id: ids.jobManualBambu, displayId: 'J-2026-000003', title: 'Prototype bracket', machine: bambu, startsAt: minutes(-200), endsAt: minutes(-140), durationSeconds: 3600 }),
    jobFixture({
      id: ids.jobLinked, displayId: 'J-2026-000004', title: null, machine: bambu, run: 'automatic', startsAt: minutes(-600), endsAt: minutes(-500), durationSeconds: 6000,
      print: { id: ids.printLinked, displayId: 'PR-2026-000007', fileName: 'gearbox_housing_v3.gcode', state: 'finished', connectorName: 'Bambu LAN' },
    }),
    jobFixture({ id: ids.jobRunning, displayId: 'J-2026-000005', title: 'Engraving run', startsAt: minutes(-30), endsAt: minutes(30), durationSeconds: 3600, outcome: 'unknown', status: 'running', calculatedPrice: null, effectivePrice: null, pricingStatus: 'pending', pricingSnapshot: undefined }),
  ];

  const printDetail = (print: Partial<PrintDetail> & Pick<PrintDetail, 'id' | 'displayId' | 'state'>): PrintDetail => ({
    machineId: ids.bambu, machineName: bambu.name, connectorName: 'Bambu LAN', fileName: 'bracket_v2.gcode', startedAt: minutes(-180), endedAt: minutes(-120), estimatedEndAt: null, progressPercent: 100,
    reportedUsage: { quantity: '42.000', quantityBasis: 'actual', materialId: ids.pla, materialName: 'PLA Black', spoolId: null, spoolDisplayId: null }, job: null, version: 1,
    events: [
      { id: id(140), kind: 'operational_state', occurredAt: minutes(-180), state: 'printing' },
      { id: id(141), kind: 'terminal_outcome', occurredAt: minutes(-120), state: 'finished' },
    ], ...print,
  } as PrintDetail);
  const prints: PrintDetail[] = [
    printDetail({ id: ids.printUnlinked, displayId: 'PR-2026-000008', state: 'finished' }),
    printDetail({ id: ids.printLinked, displayId: 'PR-2026-000007', state: 'finished', fileName: 'gearbox_housing_v3.gcode', startedAt: minutes(-600), endedAt: minutes(-500), job: { id: ids.jobLinked, displayId: 'J-2026-000004', title: null } }),
    printDetail({ id: ids.printPrinting, displayId: 'PR-2026-000009', state: 'printing', fileName: 'enclosure_lid.gcode', startedAt: minutes(-30), endedAt: null, estimatedEndAt: minutes(60), progressPercent: 45, reportedUsage: null }),
  ];

  const activity: MachineActivity[] = [
    { machineId: ids.bambu, availability: 'in_use', connector: { runtimeState: 'degraded', runtimeErrorCode: 'E42' }, current: { kind: 'print', id: ids.printPrinting, displayId: 'PR-2026-000009', fileName: 'enclosure_lid.gcode', startedAt: minutes(-30), endsAt: minutes(60) } },
    { machineId: ids.laser, availability: 'available', lastJobStartedAt: minutes(-180) },
    { machineId: ids.saw, availability: 'retired' },
  ];

  const printerProfile: PrinterProfile = {
    machineId: ids.bambu, machineName: bambu.name, enabled: true, version: 4, createdAt: created, updatedAt: created,
    inputUnits: [{ id: ids.unit, machineId: ids.bambu, name: 'AMS A', enabled: true, position: 0, version: 1 }],
    slots: [
      { id: ids.slot, machineId: ids.bambu, inputUnitId: ids.unit, inputUnitName: 'AMS A', name: 'Slot 1', position: 0, status: 'available', spoolId: ids.spoolMounted, spoolDisplayId: 'S-2026-000001', version: 1 },
      { id: id(102), machineId: ids.bambu, inputUnitId: ids.unit, inputUnitName: 'AMS A', name: 'Slot 2', position: 1, status: 'available', version: 1 },
    ],
  };

  const statisticsRequests: URLSearchParams[] = [];
  const totals = (jobs: number, runtimeHours: string, charges: string, materialCost: string, failureRate: string) => ({ jobs, runtimeHours, charges, materialCost, failureRate });
  const statMachine = (machineId: string, name: string, typeName: string, runtimeHours: string, count: number) => ({ machineId, name, machineTypeName: typeName, jobs: count, runtimeHours, failureRate: '5.0', charges: '100.00', runtimeShare: '10.0' });
  const statistics: MachineLogbookStatistics = {
    totals: totals(120, '300.0', '1500.00', '400.00', '7.5'), previousTotals: totals(100, '250.0', '1250.00', '200.00', '5.0'),
    months: [{ month: '2026-09', charges: '900.00', materialCost: '200.00', losses: '12.00' }, { month: '2026-10', charges: '600.00', materialCost: '200.00', losses: '0.00' }],
    runtimeGranularity: 'month',
    runtime: [{ bucketStart: '2026-09-01', machineId: ids.bambu, hours: '10.0' }, { bucketStart: '2026-09-01', machineId: ids.laser, hours: '6.0' }],
    materialCostByCategory: [{ key: 'filament', label: 'Filament', value: '300.00' }],
    machines: [
      statMachine(ids.bambu, 'Bambu H2D #1', '3D printer', '50.0', 10), statMachine(ids.laser, 'Laser cutter', 'Laser cutter', '120.0', 40),
      statMachine(ids.prusa, 'Prusa MK4', '3D printer', '90.0', 30), statMachine(ids.mill, 'CNC mill', 'Laser cutter', '10.0', 5),
    ],
    materialUsageByCategory: [], machineRuntimeHours: [], machineJobCounts: [], acquisitionCost: [], customerCharges: [], adjustmentLoss: [], machineFailureRates: [],
  };

  const requests: RecordedRequest[] = [];
  const unhandled: string[] = [];
  const world = {
    permissions, machines, materials, products, spools, jobs, prints, activity, printerProfile, statistics, statisticsRequests, requests, unhandled,
    /** Requests of one kind, for example `world.sent('POST', '/api/v1/machine-jobs')`. */
    sent: (method: string, path: string | RegExp) => requests.filter((request) => request.method === method && (typeof path === 'string' ? request.path === path : path.test(request.path))),
    bodyOf: (method: string, path: string | RegExp) => world.sent(method, path).at(-1)?.body as Record<string, unknown> | undefined,
  };
  return world;
}

const statusOf = (job: MachineJob): MachineJob['status'] => {
  if (job.outcome === 'unknown') return new Date(job.endsAt).getTime() > Date.now() ? 'running' : 'needs_outcome';
  return job.outcome as MachineJob['status'];
};
const withStatus = (job: MachineJob): MachineJob => ({ ...job, status: statusOf(job) });

function priceOf(job: MachineJob): string | null {
  if (job.calculatedPrice == null) return null;
  const base = Number(job.calculatedPrice);
  const adjustment = job.priceAdjustment;
  if (!adjustment) return base.toFixed(2);
  const value = Number(adjustment.value);
  const price = adjustment.kind === 'fixed' ? value : adjustment.kind === 'discount_percent' ? base * (1 - value / 100) : adjustment.kind === 'discount_amount' ? base - value : base * value;
  return Math.max(0, price).toFixed(2);
}

function workItems(world: World): WorkItem[] {
  const jobItems = world.jobs.map(withStatus).map((job): WorkItem => ({
    kind: 'job', id: job.id, displayId: job.displayId, title: job.title, fileName: job.print?.fileName ?? null, printId: job.print?.id ?? null, printDisplayId: job.print?.displayId ?? null,
    machineId: job.machine.id, machineName: job.machine.name, customer: job.customer, operator: job.operator, status: job.status, run: job.run === 'manual' ? 'manual' : 'printer',
    startedAt: job.startsAt, endsAt: job.endsAt, effectivePrice: job.effectivePrice ?? null, billing: { state: 'not_on_order' }, version: job.version,
  } as WorkItem));
  const printItems = world.prints.filter((print) => !print.job).map((print): WorkItem => ({
    kind: 'print', id: print.id, displayId: print.displayId, title: null, fileName: print.fileName, machineId: print.machineId, machineName: print.machineName, customer: null, operator: null,
    status: print.state === 'printing' ? 'printing' : 'unlinked', run: 'printer', startedAt: print.startedAt, endsAt: print.endedAt ?? null, estimatedEndAt: print.estimatedEndAt ?? null,
    progressPercent: print.progressPercent ?? null, effectivePrice: null,
  } as WorkItem));
  return [...jobItems, ...printItems].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function overview(world: World) {
  const items = workItems(world);
  const active = items.filter((item) => ['running', 'printing', 'unlinked', 'needs_outcome'].includes(item.status));
  const count = (...statuses: string[]) => items.filter((item) => statuses.includes(item.status)).length;
  return {
    jobsToday: 4, jobsThisWeek: 9, unassignedJobs: 0, unassignedEstimatedAmount: '0.00', failedOrPartialThisWeek: 1,
    runningNow: count('running', 'printing'), runningMachineNames: [...new Set(items.filter((item) => ['running', 'printing'].includes(item.status)).map((item) => item.machineName))],
    needsOutcome: count('needs_outcome'), unlinkedPrints: count('unlinked'), billingIssues: 0, activeItems: active.slice(0, 6), activeTotal: active.length,
    lowStockItems: 0, recentJobs: [], lowStockMaterials: [], activity: [{ date: '2026-09-14', count: 7 }],
  };
}

const money = (value: string | null | undefined) => value ?? null;

function ok(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}
const notFound = (route: Route) => ok(route, { code: 'not_found', message: 'Not found' }, 404);

function currentUser(permissions: string[]) {
  const personId = id(1);
  const accountId = id(2);
  const account = { id: accountId, personId, loginEmail: 'ada.login@example.test', provisioningSource: 'local', firstAuthenticatedAt: '2026-01-01T00:00:00Z', authIdentities: [], status: 'enabled', passwordStatus: 'active', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', version: 1 };
  return {
    person: { id: personId, firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test', phone: null, roles: [], account, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', version: 1 },
    account, permissions, authenticationAssurance: 'normal', managedDevice: null,
    session: { idleExpiresAt: '2099-01-01T01:00:00Z', absoluteExpiresAt: '2099-01-02T00:00:00Z', postSessionDestination: 'login' },
    delegablePermissionGrants: permissions.map((permissionId) => ({ permissionId, scope: 'everywhere', deviceTypeIds: [], minimumAssurance: 'low' })),
    laborordnungStatus: { mode: 'not_required', state: 'not_required', actionRequired: false, currentVersion: null, latestConfirmedVersion: null, requestId: null },
  };
}

const pricingGroup = {
  id: ids.pricingGroup, name: 'Partner institute', description: 'Rates for partner institutes.', active: true, isDefault: true,
  rules: [
    { id: id(150), kind: 'machine_runtime', machineTypeId: ids.typePrinter, materialCategory: null, materialUnit: null, rate: '0.50', active: true, version: 1, createdAt: created, updatedAt: created },
    { id: id(151), kind: 'material', machineTypeId: null, materialCategory: 'filament', materialUnit: 'g', rate: '0.025', active: true, version: 1, createdAt: created, updatedAt: created },
  ],
  version: 1, createdAt: created, updatedAt: created,
};
const organization = {
  id: ids.customer, name: 'TU Berlin', kind: 'institute', active: true, pricingGroup: { id: ids.pricingGroup, name: pricingGroup.name }, pricingGroupAssignmentVersion: 1, version: 1, createdAt: created, updatedAt: created,
};

function paginate<T>(items: T[], params: URLSearchParams) {
  const pageNumber = Number(params.get('page') ?? 1);
  const pageSize = Number(params.get('pageSize') ?? 100);
  return { items: items.slice((pageNumber - 1) * pageSize, pageNumber * pageSize), page: pageNumber, pageSize, total: items.length };
}

function filterWorkItems(world: World, params: URLSearchParams) {
  const statuses = params.getAll('status');
  const machineIds = params.getAll('machineId');
  const runs = params.getAll('run');
  const search = params.get('search')?.toLowerCase();
  const items = workItems(world).filter((item) => (
    (statuses.length === 0 || statuses.includes(item.status)) && (machineIds.length === 0 || machineIds.includes(item.machineId)) && (runs.length === 0 || runs.includes(item.run))
    && (!search || `${item.displayId} ${item.title ?? ''} ${item.fileName ?? ''}`.toLowerCase().includes(search))
  ));
  return paginate(items, params);
}

/** Replaces a job in the world and returns the stored copy (version bumped, status and effective price derived). */
function saveJob(world: World, job: MachineJob): MachineJob {
  const next = withStatus({ ...job, effectivePrice: priceOf(job), version: job.version + 1, updatedAt: new Date().toISOString() });
  const index = world.jobs.findIndex((item) => item.id === job.id);
  if (index >= 0) world.jobs[index] = next; else world.jobs.push(next);
  return next;
}

export async function installMachinesJobsApi(page: Page, world: World = createWorld()): Promise<World> {
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const params = url.searchParams;
    const body = method === 'GET' || method === 'DELETE' && !request.postData() ? undefined : request.postDataJSON() as Record<string, unknown>;
    let match: RegExpMatchArray | null;

    if (path === '/api/v1/auth/activity' && method === 'POST') return ok(route, currentUser(world.permissions).session);
    if (method !== 'GET') world.requests.push({ method, path, search: url.search, body: body ?? (request.postData() ? request.postDataJSON() : undefined) });

    // Session, branding
    if (path === '/api/v1/auth/me') return ok(route, currentUser(world.permissions));
    if (path === '/api/v1/auth/oidc/providers') return ok(route, { items: [] });
    if (path === '/api/v1/public/config') return ok(route, defaultPublicBrandingConfiguration());

    // Overview, activity, work items, statistics
    if (path === '/api/v1/machine-logbook/overview') return ok(route, overview(world));
    if (path === '/api/v1/machine-logbook/machine-activity') return ok(route, { items: world.activity });
    if (path === '/api/v1/machine-logbook/work-items') return ok(route, filterWorkItems(world, params));
    if (path === '/api/v1/machine-logbook/statistics') { world.statisticsRequests.push(params); return ok(route, world.statistics); }

    // Lookups
    if (path === '/api/v1/billing-parties') return ok(route, { items: [customer] });
    if (path === '/api/v1/machine-job-operators') return ok(route, { items: [operator] });
    if (path === '/api/v1/organizations') return ok(route, pageOf([organization]));
    if (path === '/api/v1/pricing-groups') return ok(route, { items: [pricingGroup] });

    // Machines
    if (path === '/api/v1/machine-types') return ok(route, { items: types });
    if (path === '/api/v1/machines' && method === 'GET') return ok(route, pageOf(world.machines));
    if (path === '/api/v1/machines' && method === 'POST') {
      const created_ = machine(id(160), String(body?.name), types.find((type) => type.id === body?.machineTypeId) ?? types[0], { status: 'active', version: 1 });
      world.machines.push(created_);
      return ok(route, created_, 201);
    }
    if ((match = path.match(/^\/api\/v1\/machines\/([^/]+)\/printer\/input-units$/)) && method === 'POST') {
      return ok(route, { id: id(103), machineId: match[1], name: body?.name, position: body?.position, enabled: true, version: 1 }, 201);
    }
    if ((match = path.match(/^\/api\/v1\/machines\/([^/]+)\/printer$/))) {
      return match[1] === ids.bambu ? ok(route, world.printerProfile) : notFound(route);
    }
    if ((match = path.match(/^\/api\/v1\/machines\/([^/]+)$/))) {
      const found = world.machines.find((item) => item.id === match![1]);
      if (!found) return notFound(route);
      if (method === 'PATCH') {
        const updated = { ...found, name: String(body?.name ?? found.name), status: (body?.status ?? found.status) as Machine['status'], version: found.version + 1 };
        world.machines[world.machines.indexOf(found)] = updated;
        return ok(route, updated);
      }
      return ok(route, found);
    }

    // Jobs
    if ((match = path.match(/^\/api\/v1\/machine-jobs\/([^/]+)\/order-association$/))) return ok(route, { orderId: null, orderReference: null, sourceChanged: false });
    if ((match = path.match(/^\/api\/v1\/machine-jobs\/([^/]+)\/run-cancellation$/)) && method === 'POST') {
      const job = world.jobs.find((item) => item.id === match![1]);
      if (!job) return notFound(route);
      return ok(route, saveJob(world, { ...job, outcome: 'cancelled', endsAt: new Date().toISOString(), durationSeconds: Math.max(1, Math.round((Date.now() - new Date(job.startsAt).getTime()) / 1000)), calculatedPrice: '3.10' }));
    }
    if ((match = path.match(/^\/api\/v1\/machine-jobs\/([^/]+)\/price-adjustment$/))) {
      const job = world.jobs.find((item) => item.id === match![1]);
      if (!job) return notFound(route);
      if (method === 'PUT') return ok(route, saveJob(world, { ...job, priceAdjustment: { kind: body?.kind as 'fixed', value: String(body?.value), reason: String(body?.reason), adjustedAt: new Date().toISOString() } }));
      if (method === 'DELETE') return ok(route, saveJob(world, { ...job, priceAdjustment: null }));
    }
    if ((match = path.match(/^\/api\/v1\/machine-jobs\/([^/]+)$/))) {
      const job = world.jobs.find((item) => item.id === match![1]);
      if (!job) return notFound(route);
      if (method === 'PATCH') return ok(route, saveJob(world, { ...job, outcome: body?.outcome as MachineJob['outcome'], title: (body?.title as string | null) ?? null, notes: (body?.notes as string | null) ?? null }));
      return ok(route, withStatus(job));
    }
    if (path === '/api/v1/machine-jobs' && method === 'POST') {
      const machineFor = world.machines.find((item) => item.id === body?.machineId) ?? world.machines[0];
      const startsAt = String(body?.startsAt);
      const endsAt = String(body?.endsAt);
      const job = saveJob(world, jobFixture({
        id: ids.newJob, displayId: 'J-2026-000010', title: (body?.title as string | null) ?? null, machine: machineFor, startsAt, endsAt, durationSeconds: Math.round((new Date(endsAt).getTime() - new Date(startsAt).getTime()) / 1000),
        outcome: body?.outcome as MachineJob['outcome'], notes: (body?.notes as string | null) ?? null, version: 0, calculatedPrice: '8.00', effectivePrice: '8.00',
      }));
      return ok(route, job, 201);
    }

    // Prints
    if (path === '/api/v1/prints' && method === 'GET') {
      let items = world.prints as PrintDetail[];
      if (params.get('machineId')) items = items.filter((print) => print.machineId === params.get('machineId'));
      if (params.get('linked') === 'false') items = items.filter((print) => !print.job);
      return ok(route, paginate(items, params));
    }
    if ((match = path.match(/^\/api\/v1\/prints\/([^/]+)\/job$/))) {
      const print = world.prints.find((item) => item.id === match![1]);
      if (!print) return notFound(route);
      if (method === 'POST') {
        const job = saveJob(world, jobFixture({
          id: ids.newJob, displayId: 'J-2026-000011', title: (body?.title as string | null) ?? null, machine: world.machines.find((item) => item.id === print.machineId)!, run: 'automatic', startsAt: print.startedAt, endsAt: print.endedAt ?? minutes(0), durationSeconds: 3600, outcome: body?.outcome as MachineJob['outcome'], version: 0,
          print: { id: print.id, displayId: print.displayId, fileName: print.fileName, state: print.state, connectorName: print.connectorName },
        }));
        print.job = { id: job.id, displayId: job.displayId, title: job.title };
        return ok(route, job, 201);
      }
      if (method === 'PUT') {
        const job = world.jobs.find((item) => item.id === body?.machineJobId);
        if (!job) return notFound(route);
        const linked = saveJob(world, {
          ...job, run: 'automatic', startsAt: print.startedAt, endsAt: print.endedAt ?? job.endsAt,
          print: { id: print.id, displayId: print.displayId, fileName: print.fileName, state: print.state, connectorName: print.connectorName },
        });
        print.job = { id: linked.id, displayId: linked.displayId, title: linked.title };
        return ok(route, linked);
      }
      if (method === 'DELETE') {
        const job = world.jobs.find((item) => item.id === print.job?.id);
        print.job = null;
        return job ? ok(route, saveJob(world, { ...job, run: 'manual', print: null })) : notFound(route);
      }
    }
    if ((match = path.match(/^\/api\/v1\/prints\/([^/]+)$/))) {
      const print = world.prints.find((item) => item.id === match![1]);
      return print ? ok(route, print) : notFound(route);
    }

    // Inventory
    if (path === '/api/v1/materials') return ok(route, { ...pageOf(world.materials), totalInventoryValue: '198.00' });
    if ((match = path.match(/^\/api\/v1\/materials\/([^/]+)\/transactions$/))) {
      return ok(route, pageOf([
        { id: id(170), materialId: match[1], kind: 'purchase', quantityDelta: '1000', unitAcquisitionCost: '0.02', inventoryValueDelta: '20', totalPurchasePrice: '20', occurredAt: '2026-09-10T10:00:00Z', supplier: 'Filament shop', createdAt: '2026-09-10T10:00:00Z' },
        { id: id(171), materialId: match[1], kind: 'spool_transfer', quantityDelta: '0', unitAcquisitionCost: '0', inventoryValueDelta: '0', transferQuantity: '1000', toSpoolId: ids.spoolReusable, toSpoolDisplayId: 'S-2026-000001', toFillNumber: 3, occurredAt: '2026-10-02T08:00:00Z', createdAt: '2026-10-02T08:00:00Z' },
      ]));
    }
    if ((match = path.match(/^\/api\/v1\/materials\/([^/]+)$/))) {
      const found = world.materials.find((item) => item.id === match![1]);
      return found ? ok(route, found) : notFound(route);
    }
    if (path === '/api/v1/filament-products' && method === 'GET') return ok(route, pageOf(world.products));
    if (path === '/api/v1/filament-products' && method === 'POST') {
      const added = product(ids.newProduct, String(body?.manufacturer), String(body?.name), body?.packaging as 'refill', { defaultPrice: money(body?.defaultPrice as string), inUseCount: 0, version: 1, notes: (body?.notes as string | null) ?? null });
      world.products.push(added);
      return ok(route, added, 201);
    }
    if ((match = path.match(/^\/api\/v1\/filament-products\/([^/]+)$/))) {
      const found = world.products.find((item) => item.id === match![1]);
      if (!found) return notFound(route);
      if (method === 'PATCH') {
        const updated = { ...found, name: String(body?.name ?? found.name), manufacturer: String(body?.manufacturer ?? found.manufacturer), defaultPrice: money(body?.defaultPrice as string), active: Boolean(body?.active ?? found.active), version: found.version + 1 };
        world.products[world.products.indexOf(found)] = updated;
        return ok(route, updated);
      }
      return ok(route, found);
    }
    if (path === '/api/v1/filament-spools/cleanup' && method === 'POST') {
      const months = Number(body?.olderThanMonths);
      const cutoff = Date.now() - months * 30 * 86_400_000;
      const candidates = world.spools.filter((item) => item.status === 'archived' && item.kind === 'single_use' && new Date(item.archivedAt!).getTime() < cutoff);
      if (body?.dryRun) return ok(route, { items: candidates.map((item) => ({ id: item.id, displayId: item.displayId, label: item.label, archivedAt: item.archivedAt })), deleted: false });
      const doomed = new Set(body?.spoolIds as string[]);
      world.spools.splice(0, world.spools.length, ...world.spools.filter((item) => !doomed.has(item.id)));
      return ok(route, { items: candidates.filter((item) => doomed.has(item.id)).map((item) => ({ id: item.id, displayId: item.displayId, label: item.label, archivedAt: item.archivedAt })), deleted: true });
    }
    if (path === '/api/v1/filament-spools' && method === 'GET') {
      let items = world.spools;
      if (params.get('lifecycle')) items = items.filter((item) => item.lifecycle === params.get('lifecycle'));
      if (params.get('kind')) items = items.filter((item) => item.kind === params.get('kind'));
      if (params.get('materialId')) items = items.filter((item) => item.materialId === params.get('materialId'));
      if (params.get('mounted')) items = items.filter((item) => String(item.mounted) === params.get('mounted'));
      if (params.get('consumable') === 'true') items = items.filter((item) => item.lifecycle === 'active' && Number(item.remainingQuantity) > 0);
      return ok(route, paginate(items, params));
    }
    if ((match = path.match(/^\/api\/v1\/filament-spools\/([^/]+)\/transactions$/))) {
      return ok(route, pageOf([{ id: id(172), materialId: ids.pla, kind: 'machine_job_consumption', quantityDelta: '-183', unitAcquisitionCost: '0.018', inventoryValueDelta: '-3.29', occurredAt: '2026-10-03T08:00:00Z', machineJobId: ids.jobSuccess, machineJobDisplayId: 'J-2026-000001', spoolId: match[1], spoolDisplayId: 'S-2026-000001', fillNumber: 3, createdAt: '2026-10-03T08:00:00Z' }]));
    }
    if ((match = path.match(/^\/api\/v1\/filament-spools\/([^/]+)\/(fills|finish)$/)) && method === 'POST') {
      const found = world.spools.find((item) => item.id === match![1]);
      if (!found) return notFound(route);
      const updated = match[2] === 'fills'
        ? { ...found, fillNumber: found.fillNumber + 1, version: found.version + 1 }
        : { ...found, status: found.kind === 'single_use' ? 'archived' as const : 'needs_refill' as const, lifecycle: found.kind === 'single_use' ? 'archived' as const : found.lifecycle, remainingQuantity: '0', version: found.version + 1 };
      world.spools[world.spools.indexOf(found)] = updated;
      return ok(route, updated);
    }
    if ((match = path.match(/^\/api\/v1\/filament-spools\/([^/]+)$/))) {
      const found = world.spools.find((item) => item.id === match![1]);
      return found ? ok(route, found) : notFound(route);
    }

    world.unhandled.push(`${method} ${path}${url.search}`);
    return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'unhandled_in_e2e_mock', message: `${method} ${path}` }) });
  });
  return world;
}
