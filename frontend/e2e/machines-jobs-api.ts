import type { Page, Route } from '@playwright/test';
import type {
  BillingParty,
  MaterialType,
  FilamentSpool,
  Machine,
  MachineActivity,
  MachineJob,
  MachineLogbookStatistics,
  MachineRun,
  MachineRunDetail,
  Material,
  Operator,
  PrinterProfile,
  WorkItem,
} from '../src/api/generated/models';
import { defaultPublicBrandingConfiguration } from './branding-fixtures';
import { welcomeTourSeen } from './guide-progress';

/**
 * Stateful mock of the Machines & Jobs API for the mocked-API specs. Every request that is not a GET is recorded in
 * `world.requests`, requests the mock does not know answer 500 and are recorded in `world.unhandled`.
 */

export const id = (n: number) => `0192f6f8-743e-7c77-a349-cd07c3e8${String(n).padStart(4, '0')}`;
export const ids = {
  typePrinter: id(10),
  typeLaser: id(11),
  bambu: id(20),
  connector: id(25),
  laser: id(21),
  saw: id(22),
  prusa: id(23),
  mill: id(24),
  pla: id(30),
  plywood: id(31),
  customer: id(40),
  operator: id(41),
  pricingGroup: id(42),
  jobSuccess: id(50),
  jobNeedsOutcome: id(51),
  jobManualBambu: id(52),
  jobLinked: id(53),
  jobRunning: id(54),
  runUnassigned: id(60),
  runLinked: id(61),
  runRunning: id(62),
  runSuccess: id(63),
  runNeedsOutcome: id(64),
  runManualBambu: id(65),
  runLive: id(66),
  runNew: id(112),
  runAdded: id(113),
  spoolReusable: id(70),
  spoolSingle: id(71),
  spoolArchivedNew: id(72),
  spoolArchivedOld: id(73),
  spoolMounted: id(74),
  fillClosed: id(80),
  fillCurrent: id(81),
  nfc: id(95),
  barcode: id(96),
  unit: id(100),
  slot: id(101),
  newJob: id(110),
};

export const staffPermissions = [
  'machines.read',
  'machines.manage',
  'machine_jobs.read',
  'machine_jobs.create',
  'machine_jobs.edit',
  'machine_jobs.override_price',
  'inventory.read',
  'inventory.manage',
  'filament_spools.manage',
  'printer_slots.assign',
  'inventory.delete',
  'inventory.ledger.delete',
  'orders.read',
  'organizations.read',
  'organizations.manage',
  'pricing.read',
  'pricing.manage',
  'statistics.read',
];
/** Can look at everything in Machines & Jobs, but change nothing. */
export const readerPermissions = ['machines.read', 'machine_jobs.read', 'inventory.read', 'statistics.read'];

const minutes = (offset: number) => new Date(Date.now() + offset * 60_000).toISOString();
const created = '2026-09-01T00:00:00Z';
const pageOf = <T>(items: T[], total = items.length) => ({ items, page: 1, pageSize: 100, total });

const processOf = (processId: string, name: string, integration: 'none' | 'fdm_printer') => ({
  id: processId,
  name,
  active: true,
  integration,
  measures: [],
  version: 1,
  createdAt: created,
  updatedAt: created,
});
const types = [
  processOf(ids.typePrinter, '3D printer', 'fdm_printer'),
  processOf(ids.typeLaser, 'Laser cutter', 'none'),
];

const materialTypes: MaterialType[] = [
  {
    id: id(900),
    name: 'PLA',
    code: 'PLA',
    kind: 'filament',
    machineUse: true,
    unit: 'g',
    dimension: 'mass',
    processIds: [ids.typePrinter],
    active: true,
    materialCount: 1,
    pricingRuleCount: 1,
    variants: [
      { id: id(910), materialTypeId: id(900), name: 'Silk', materialCount: 0, pricingRuleCount: 0 },
      { id: id(911), materialTypeId: id(900), name: 'Matte', materialCount: 0, pricingRuleCount: 0 },
    ],
    version: 1,
    createdAt: created,
    updatedAt: created,
  },
  {
    id: id(901),
    name: 'Plywood',
    code: 'PLYWOOD',
    kind: 'consumable',
    machineUse: true,
    unit: 'm2',
    dimension: 'area',
    processIds: [ids.typeLaser],
    active: true,
    materialCount: 1,
    pricingRuleCount: 0,
    variants: [],
    version: 1,
    createdAt: created,
    updatedAt: created,
  },
];

const machine = (
  machineId: string,
  name: string,
  type: (typeof types)[number],
  overrides: Partial<Machine> = {},
): Machine => ({
  id: machineId,
  name,
  process: type,
  status: 'active',
  externalIdentifier: null,
  automaticCollectionEnabled: false,
  lastIngestedAt: null,
  jobCount: 12,
  runtimeSeconds: 72_000,
  failureRate: '4.2',
  attention: [],
  version: 3,
  createdAt: created,
  updatedAt: created,
  ...overrides,
});

export const customer: BillingParty = {
  kind: 'organization',
  id: ids.customer,
  displayName: 'TU Berlin',
  organizationKind: 'institute',
  pricingGroup: { id: ids.pricingGroup, name: 'Partner institute' },
  pricingGroupAssignmentVersion: 1,
};
export const operator: Operator = { personId: ids.operator, displayName: 'Maria Hoffmann' };

const material = (materialId: string, name: string, overrides: Partial<Material> = {}): Material => ({
  id: materialId,
  displayId: 'A-0001',
  name,
  kind: 'filament',
  materialTypeCode: 'PLA',
  machineUse: true,
  prices: [
    {
      pricingGroupId: ids.pricingGroup,
      pricingGroupName: 'Partner institute',
      rate: '0.04',
      source: 'material_type',
      pricingRuleId: id(902),
    },
  ],
  attention: [],
  variant: null,
  manufacturer: null,
  packageSize: null,
  storageLocation: null,
  notes: null,
  materialTypeId: id(900),
  materialTypeName: 'PLA',
  colorName: 'Black',
  colorHex: '#1A1A1A',
  unit: 'g',
  dimension: 'mass',
  active: true,
  lowStockThreshold: '1000',
  quantity: '5000',
  assignedQuantity: '600',
  unassignedQuantity: '4400',
  filamentDiameterMm: '1.75',
  averageUnitCost: '0.018',
  inventoryValue: '90.00',
  stockState: 'in_stock',
  inventoryVersion: 7,
  recentConsumption: '240',
  version: 3,
  createdAt: created,
  updatedAt: created,
  ...overrides,
});

const identifiers = [
  { id: ids.nfc, kind: 'nfc' as const, value: '04AA11', createdAt: '2026-10-02T08:00:00Z' },
  { id: ids.barcode, kind: 'barcode' as const, value: 'BC-100', createdAt: '2026-09-01T08:00:00Z' },
];

const spool = (overrides: Partial<FilamentSpool>): FilamentSpool => ({
  id: ids.spoolReusable,
  displayId: 'S-PLA-BLACK-01',
  materialId: ids.pla,
  materialDisplayId: 'A-0001',
  materialName: 'PLA Black',
  materialTypeName: 'PLA',
  colorName: 'Black',
  colorHex: '#1A1A1A',
  unit: 'g',
  manufacturer: 'Bambu Lab',
  initialNetWeightG: '1000',
  remainingQuantity: '600',
  tareWeightG: '200',
  acquiredOn: '2026-09-01',
  acquisitionReference: null,
  storageLocation: 'Shelf A',
  notes: null,
  lifecycle: 'active',
  archivedAt: null,
  retiredOutcome: null,
  retiredQuantity: null,
  retiredByName: null,
  mounted: false,
  mountedOn: null,
  identifiers,
  attention: [],
  version: 5,
  createdAt: '2026-09-01T08:00:00Z',
  updatedAt: '2026-10-02T08:00:00Z',
  ...overrides,
});

const pricingSnapshot = {
  id: id(120),
  revision: 1,
  pricingGroupName: 'Partner institute',
  currency: 'EUR',
  reason: 'created',
  complete: true,
  calculatedAmount: '12.50',
  capturedAt: '2026-09-15T11:26:00Z',
  rules: [
    {
      kind: 'machine_runtime',
      label: '3D printer runtime',
      selector: '3D printer',
      unit: 'hour',
      rate: '5.00',
      missing: false,
    },
  ],
};

const usageOf = (n: number, quantity: string) => ({
  id: id(n),
  ownership: 'makerspace' as const,
  materialId: ids.pla,
  spoolId: null,
  spoolDisplayId: null,
  materialName: 'PLA Black',
  materialTypeId: id(900),
  materialTypeName: 'PLA',
  unit: 'g' as const,
  quantity,
  quantityBasis: 'actual' as const,
  staffCorrected: false,
});

type RunInit = Partial<MachineRun> & Pick<MachineRun, 'id' | 'displayId'>;
/** A manual run. `endedAt` is always the real end here; the API shape (running → estimatedEndAt) is applied when it is served. */
export function manualRunFixture(overrides: RunInit): MachineRun {
  return {
    machineId: ids.laser,
    machineName: 'Laser cutter',
    source: 'manual',
    state: 'finished',
    connectorName: null,
    fileName: null,
    startedAt: minutes(-180),
    endedAt: minutes(-90),
    estimatedEndAt: null,
    durationSeconds: 5400,
    progressPercent: null,
    outcome: 'successful',
    outcomeFromMachine: false,
    usages: [usageOf(130, '183.000')],
    measures: {},
    usagesFromMachine: false,
    hiddenFromSignage: false,
    jobHiddenFromSignage: false,
    reportedUsage: null,
    reportedUsageItems: [],
    materialChangedDuringRun: false,
    version: 2,
    ...overrides,
  } as MachineRun;
}

type JobInit = Partial<MachineJob> & Pick<MachineJob, 'id' | 'displayId'>;
export function jobFixture(overrides: JobInit): MachineJob {
  return {
    title: null,
    machine: machine(ids.laser, 'Laser cutter', types[1]),
    runs: [],
    startedAt: null,
    endedAt: null,
    expectedEndAt: null,
    durationSeconds: 0,
    measures: {},
    customer,
    operator,
    outcome: 'successful',
    outcomeOverridden: false,
    status: 'successful',
    notes: 'Print with 0.2 mm layers',
    pricingStatus: 'complete',
    pricingSnapshot,
    calculatedPrice: '12.50',
    priceAdjustment: null,
    effectivePrice: '12.50',
    hiddenFromSignage: false,
    attention: [],
    version: 3,
    createdAt: created,
    updatedAt: created,
    ...overrides,
  } as MachineJob;
}

export type RecordedRequest = { method: string; path: string; search: string; body: unknown };

export type World = ReturnType<typeof createWorld>;

export function createWorld(permissions: string[] = staffPermissions) {
  const bambu = machine(ids.bambu, 'Bambu H2D #1', types[0], {
    automaticCollectionEnabled: true,
    externalIdentifier: 'BH2D-1',
    lastIngestedAt: minutes(-5),
    jobCount: 42,
  });
  const laser = machine(ids.laser, 'Laser cutter', types[1]);
  const saw = machine(ids.saw, 'Old saw', types[1], { status: 'retired' });
  const machines: Machine[] = [bambu, laser, saw];

  const materials: Material[] = [
    material(ids.pla, 'PLA Black'),
    material(ids.plywood, 'Birch plywood', {
      displayId: 'A-0002',
      materialTypeCode: 'PLYWOOD',
      prices: [],
      kind: 'consumable',
      materialTypeId: id(901),
      materialTypeName: 'Plywood',
      colorName: null,
      colorHex: null,
      unit: 'm2',
      lowStockThreshold: null,
      quantity: '12',
      assignedQuantity: '0',
      unassignedQuantity: '12',
      filamentDiameterMm: null,
      averageUnitCost: '9',
      inventoryValue: '108',
      inventoryVersion: 4,
      version: 1,
    }),
  ];
  const spools: FilamentSpool[] = [
    spool({}),
    spool({
      id: ids.spoolSingle,
      displayId: 'S-PLA-BLACK-02',
      remainingQuantity: '80',
      tareWeightG: null,
      identifiers: [],
      attention: [{ code: 'remainder_low', message: 'Almost empty · 80 g left' }],
    }),
    spool({
      id: ids.spoolArchivedNew,
      displayId: 'S-2026-000003',
      lifecycle: 'archived',
      archivedAt: minutes(-60 * 24 * 150),
      retiredOutcome: 'empty',
      retiredQuantity: '0',
      retiredByName: 'Maria Hoffmann',
      remainingQuantity: '0',
      identifiers: [],
    }),
    spool({
      id: ids.spoolArchivedOld,
      displayId: 'S-2026-000004',
      lifecycle: 'archived',
      archivedAt: minutes(-60 * 24 * 420),
      retiredOutcome: 'discarded',
      retiredQuantity: '40',
      retiredByName: 'Maria Hoffmann',
      remainingQuantity: '0',
      identifiers: [],
    }),
  ];

  const jobs: MachineJob[] = [
    jobFixture({
      id: ids.jobSuccess,
      displayId: 'J-2026-000001',
      title: 'Gearbox housing',
      runs: [manualRunFixture({ id: ids.runSuccess, displayId: 'RN-2026-000001' })],
    }),
    jobFixture({
      id: ids.jobNeedsOutcome,
      displayId: 'J-2026-000002',
      title: 'Lamp shade',
      calculatedPrice: null,
      effectivePrice: null,
      pricingStatus: 'pending',
      pricingSnapshot: undefined,
      runs: [
        manualRunFixture({
          id: ids.runNeedsOutcome,
          displayId: 'RN-2026-000002',
          startedAt: minutes(-90),
          endedAt: minutes(-10),
          durationSeconds: 4800,
          outcome: null,
        }),
      ],
    }),
    jobFixture({
      id: ids.jobManualBambu,
      displayId: 'J-2026-000003',
      title: 'Prototype bracket',
      machine: bambu,
      runs: [
        manualRunFixture({
          id: ids.runManualBambu,
          displayId: 'RN-2026-000003',
          machineId: ids.bambu,
          machineName: bambu.name,
          startedAt: minutes(-200),
          endedAt: minutes(-140),
          durationSeconds: 3600,
        }),
      ],
    }),
    jobFixture({ id: ids.jobLinked, displayId: 'J-2026-000004', title: null, machine: bambu }),
    jobFixture({
      id: ids.jobRunning,
      displayId: 'J-2026-000005',
      title: 'Engraving run',
      calculatedPrice: null,
      effectivePrice: null,
      pricingStatus: 'pending',
      pricingSnapshot: undefined,
      runs: [
        manualRunFixture({
          id: ids.runLive,
          displayId: 'RN-2026-000006',
          startedAt: minutes(-30),
          endedAt: minutes(30),
          durationSeconds: 3600,
          outcome: null,
          usages: [],
        }),
      ],
    }),
  ];

  const recordedRun = (
    run: Partial<MachineRunDetail> & Pick<MachineRunDetail, 'id' | 'displayId' | 'state'>,
  ): MachineRunDetail =>
    ({
      machineId: ids.bambu,
      machineName: bambu.name,
      source: 'recorded',
      connectorName: 'Bambu LAN',
      fileName: 'bracket_v2.gcode',
      startedAt: minutes(-180),
      endedAt: minutes(-120),
      estimatedEndAt: null,
      durationSeconds: 3600,
      progressPercent: 100,
      outcome: 'successful',
      outcomeFromMachine: true,
      usages: [],
      measures: {},
      usagesFromMachine: false,
      hiddenFromSignage: false,
      reportedUsageItems: [],
      materialChangedDuringRun: false,
      reportedUsage: {
        quantity: '42.000',
        quantityBasis: 'actual',
        materialId: ids.pla,
        materialName: 'PLA Black',
        spoolId: null,
        spoolDisplayId: null,
      },
      job: null,
      version: 1,
      events: [
        { id: id(140), kind: 'operational_state', occurredAt: minutes(-180), state: 'printing' },
        { id: id(141), kind: 'terminal_outcome', occurredAt: minutes(-120), state: 'finished' },
      ],
      ...run,
    }) as MachineRunDetail;
  /** Recorded runs, assigned or not. A job's recorded runs are looked up here by `run.job`. */
  const runs: MachineRunDetail[] = [
    recordedRun({ id: ids.runUnassigned, displayId: 'RN-2026-000008', state: 'finished' }),
    recordedRun({
      id: ids.runLinked,
      displayId: 'RN-2026-000007',
      state: 'finished',
      fileName: 'gearbox_housing_v3.gcode',
      startedAt: minutes(-600),
      endedAt: minutes(-500),
      durationSeconds: 6000,
      usages: [usageOf(131, '42.000')],
      usagesFromMachine: true,
      hiddenFromSignage: false,
      job: { id: ids.jobLinked, displayId: 'J-2026-000004', title: null },
    }),
    recordedRun({
      id: ids.runRunning,
      displayId: 'RN-2026-000009',
      state: 'running',
      fileName: 'enclosure_lid.gcode',
      startedAt: minutes(-30),
      endedAt: null,
      estimatedEndAt: minutes(60),
      durationSeconds: 5400,
      progressPercent: 45,
      outcome: null,
      outcomeFromMachine: false,
      reportedUsage: null,
    }),
  ];

  const activity: MachineActivity[] = [
    {
      machineId: ids.bambu,
      availability: 'in_use',
      connector: { runtimeState: 'degraded', runtimeErrorCode: 'E42' },
      current: {
        kind: 'run',
        id: ids.runRunning,
        displayId: 'RN-2026-000009',
        fileName: 'enclosure_lid.gcode',
        startedAt: minutes(-30),
        endsAt: minutes(60),
      },
    },
    { machineId: ids.laser, availability: 'available', lastJobStartedAt: minutes(-180) },
    { machineId: ids.saw, availability: 'retired' },
  ];

  const printerProfile: PrinterProfile = {
    machineId: ids.bambu,
    machineName: bambu.name,
    enabled: true,
    model: null,
    nozzleCount: 1,
    version: 4,
    createdAt: created,
    updatedAt: created,
    inputUnits: [
      {
        id: ids.unit,
        machineId: ids.bambu,
        name: 'AMS A',
        enabled: true,
        position: 0,
        nozzle: null,
        nozzleIndex: 1,
        version: 1,
      },
    ],
    slots: [
      {
        id: ids.slot,
        machineId: ids.bambu,
        inputUnitId: ids.unit,
        inputUnitName: 'AMS A',
        name: 'Slot 1',
        position: 0,
        nozzleIndex: 1,
        status: 'available',
        spoolId: ids.spoolMounted,
        spoolDisplayId: 'S-2026-000001',
        version: 1,
      },
      {
        id: id(102),
        machineId: ids.bambu,
        inputUnitId: ids.unit,
        inputUnitName: 'AMS A',
        name: 'Slot 2',
        position: 1,
        nozzleIndex: 1,
        status: 'available',
        version: 1,
      },
    ],
  };

  const statisticsRequests: URLSearchParams[] = [];
  const totals = (jobs: number, runtimeHours: string, charges: string, materialCost: string, failureRate: string) => ({
    jobs,
    runtimeHours,
    charges,
    materialCost,
    failureRate,
    notBilled: '0.00',
    discounts: '0.00',
    utilization: '12.5',
    openDayUtilization: '40.0',
  });
  const statMachine = (machineId: string, name: string, typeName: string, runtimeHours: string, count: number) => ({
    machineId,
    name,
    processName: typeName,
    jobs: count,
    runtimeHours,
    failureRate: '5.0',
    charges: '100.00',
    runtimeShare: '10.0',
    utilization: '12.5',
    openDayUtilization: '40.0',
  });
  const statistics: MachineLogbookStatistics = {
    totals: totals(120, '300.0', '1500.00', '400.00', '7.5'),
    previousTotals: totals(100, '250.0', '1250.00', '200.00', '5.0'),
    months: [
      { month: '2026-09', charges: '900.00', materialCost: '200.00', losses: '12.00' },
      { month: '2026-10', charges: '600.00', materialCost: '200.00', losses: '0.00' },
    ],
    runtimeGranularity: 'month',
    runtime: [
      { bucketStart: '2026-09-01', machineId: ids.bambu, hours: '10.0' },
      { bucketStart: '2026-09-01', machineId: ids.laser, hours: '6.0' },
    ],
    materialCostByType: [
      { key: id(130), label: 'PLA', value: '300.00' },
      { key: id(131), label: 'Plywood', value: '100.00' },
    ],
    machines: [
      statMachine(ids.bambu, 'Bambu H2D #1', '3D printer', '50.0', 10),
      statMachine(ids.laser, 'Laser cutter', 'Laser cutter', '120.0', 40),
      statMachine(ids.prusa, 'Prusa MK4', '3D printer', '90.0', 30),
      statMachine(ids.mill, 'CNC mill', 'Laser cutter', '10.0', 5),
    ],
    materialUsageByType: [],
    machineRuntimeHours: [],
    machineJobCounts: [],
    acquisitionCost: [],
    customerCharges: [],
    adjustmentLoss: [],
    machineFailureRates: [],
    usageByWeekdayHour: [
      { weekday: 1, hour: 15, runs: 3, minutes: '120' },
      { weekday: 1, hour: 16, runs: 5, minutes: '240' },
      { weekday: 3, hour: 17, runs: 4, minutes: '180' },
      { weekday: 5, hour: 11, runs: 2, minutes: '90' },
    ],
    jobsByOutcome: [
      { outcome: 'successful', jobs: 100 },
      { outcome: 'failed', jobs: 8 },
      { outcome: 'cancelled', jobs: 4 },
      { outcome: 'unknown', jobs: 8 },
    ],
    jobsByWeek: [
      { weekStart: '2026-09-07', jobs: 12 },
      { weekStart: '2026-09-14', jobs: 9 },
      { weekStart: '2026-09-21', jobs: 15 },
    ],
    materialByMonth: [
      {
        month: '2026-09',
        materialTypeId: id(130),
        materialTypeName: 'PLA',
        unit: 'g',
        quantity: '6000',
        cost: '150.00',
      },
      {
        month: '2026-10',
        materialTypeId: id(130),
        materialTypeName: 'PLA',
        unit: 'g',
        quantity: '6000',
        cost: '150.00',
      },
      {
        month: '2026-09',
        materialTypeId: id(131),
        materialTypeName: 'Plywood',
        unit: 'sheet',
        quantity: '4',
        cost: '100.00',
      },
    ],
    materialLossByType: [{ key: id(130), label: 'PLA', value: '12.00' }],
    materialChargesByType: [
      { key: id(130), label: 'PLA', value: '420.00' },
      { key: id(131), label: 'Plywood', value: '90.00' },
    ],
    pricingGroups: [
      { pricingGroupName: 'Members', jobs: 90, charges: '900.00', discounts: '20.00' },
      { pricingGroupName: 'External', jobs: 30, charges: '600.00', discounts: '0.00' },
    ],
    pricingGroupMonths: [
      { month: '2026-09', pricingGroupName: 'Members', charges: '500.00' },
      { month: '2026-09', pricingGroupName: 'External', charges: '400.00' },
      { month: '2026-10', pricingGroupName: 'Members', charges: '400.00' },
      { month: '2026-10', pricingGroupName: 'External', charges: '200.00' },
    ],
  };

  const requests: RecordedRequest[] = [];
  const unhandled: string[] = [];
  const world = {
    permissions,
    machines,
    materials,
    spools,
    jobs,
    runs,
    activity,
    printerProfile,
    statistics,
    statisticsRequests,
    requests,
    unhandled,
    /** Requests of one kind, for example `world.sent('POST', '/api/v1/machine-jobs')`. */
    sent: (method: string, path: string | RegExp) =>
      requests.filter(
        (request) =>
          request.method === method && (typeof path === 'string' ? request.path === path : path.test(request.path)),
      ),
    bodyOf: (method: string, path: string | RegExp) =>
      world.sent(method, path).at(-1)?.body as Record<string, unknown> | undefined,
  };
  return world;
}

/** Presents a stored manual run like the API: a run that has not ended is running and carries its planned end as estimate. */
function presentRun(run: MachineRun): MachineRun {
  if (run.source !== 'manual' || run.state === 'replaced') return run;
  const end = run.endedAt ?? run.estimatedEndAt!;
  const live = new Date(end).getTime() > Date.now() && run.outcome !== 'cancelled';
  const state: MachineRun['state'] = live ? 'running' : run.outcome === 'cancelled' ? 'cancelled' : 'finished';
  return {
    ...run,
    state,
    endedAt: live ? null : end,
    estimatedEndAt: live ? end : null,
    outcome: live ? null : run.outcome,
    durationSeconds: Math.max(0, Math.round((new Date(end).getTime() - new Date(run.startedAt).getTime()) / 1000)),
  };
}

const derivedOutcome = (runs: MachineRun[]): MachineJob['outcome'] => {
  if (runs.some((run) => !run.outcome)) return 'unknown';
  const set = new Set(runs.map((run) => run.outcome));
  return set.size === 1 ? (runs[0].outcome as MachineJob['outcome']) : 'partial_failure';
};

/** The job as the API serves it: runs, totals, outcome and status derived from the runs. */
function viewJob(world: World, job: MachineJob): MachineJob {
  const stored = job.runs.filter((run) => run.source === 'manual');
  const runs = [...stored, ...world.runs.filter((run) => run.job?.id === job.id)]
    .map(presentRun)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const active = runs.filter((run) => run.state !== 'replaced');
  const live = active.some((run) => run.state === 'running');
  const outcome = job.outcomeOverridden ? job.outcome : derivedOutcome(active);
  const status: MachineJob['status'] = live
    ? 'running'
    : outcome === 'unknown'
      ? 'needs_outcome'
      : (outcome as MachineJob['status']);
  const ended = active.every((run) => run.endedAt);
  return {
    ...job,
    runs,
    startedAt: runs[0]?.startedAt ?? null,
    endedAt: ended
      ? (active
          .map((run) => run.endedAt!)
          .sort()
          .at(-1) ?? null)
      : null,
    expectedEndAt: live
      ? (active
          .map((run) => run.endedAt ?? run.estimatedEndAt!)
          .sort()
          .at(-1) ?? null)
      : null,
    durationSeconds: active.reduce((sum, run) => sum + run.durationSeconds, 0),
    outcome,
    status,
  };
}

function priceOf(job: MachineJob): string | null {
  if (job.calculatedPrice == null) return null;
  const base = Number(job.calculatedPrice);
  const adjustment = job.priceAdjustment;
  if (!adjustment) return base.toFixed(2);
  const value = Number(adjustment.value);
  const price =
    adjustment.kind === 'fixed'
      ? value
      : adjustment.kind === 'discount_percent'
        ? base * (1 - value / 100)
        : adjustment.kind === 'discount_amount'
          ? base - value
          : base * value;
  return Math.max(0, price).toFixed(2);
}

function workItems(world: World): WorkItem[] {
  const jobItems = world.jobs
    .map((stored) => viewJob(world, stored))
    .map((job): WorkItem => {
      const recorded = job.runs.filter((run) => run.source === 'recorded' && run.state !== 'replaced');
      return {
        kind: 'job',
        id: job.id,
        displayId: job.displayId,
        title: job.title,
        fileName: recorded.at(-1)?.fileName ?? null,
        runCount: job.runs.filter((run) => run.state !== 'replaced').length,
        machineId: job.machine.id,
        machineName: job.machine.name,
        customer: job.customer,
        operator: job.operator,
        status: job.status,
        source: recorded.length ? 'recorded' : 'manual',
        startedAt: job.startedAt!,
        endsAt: job.endedAt ?? job.expectedEndAt,
        effectivePrice: job.effectivePrice ?? null,
        billing: { state: 'not_on_order' },
        version: job.version,
      } as WorkItem;
    });
  const runItems = world.runs
    .filter((run) => !run.job)
    .map(
      (run): WorkItem =>
        ({
          kind: 'run',
          id: run.id,
          displayId: run.displayId,
          title: null,
          fileName: run.fileName,
          runCount: 1,
          machineId: run.machineId,
          machineName: run.machineName,
          status: run.state === 'running' ? 'running_unassigned' : 'unassigned',
          source: 'recorded',
          startedAt: run.startedAt,
          endsAt: run.endedAt ?? null,
          estimatedEndAt: run.estimatedEndAt ?? null,
          progressPercent: run.progressPercent ?? null,
          effectivePrice: null,
        }) as WorkItem,
    );
  return [...jobItems, ...runItems].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function overview(world: World) {
  const items = workItems(world);
  const active = items.filter((item) =>
    ['running', 'running_unassigned', 'unassigned', 'needs_outcome'].includes(item.status),
  );
  const count = (...statuses: string[]) => items.filter((item) => statuses.includes(item.status)).length;
  return {
    jobsToday: 4,
    jobsThisWeek: 9,
    unassignedJobs: 0,
    unassignedEstimatedAmount: '0.00',
    failedOrPartialThisWeek: 1,
    runningNow: count('running', 'running_unassigned'),
    runningMachineNames: [
      ...new Set(
        items.filter((item) => ['running', 'running_unassigned'].includes(item.status)).map((item) => item.machineName),
      ),
    ],
    needsOutcome: count('needs_outcome'),
    unassignedRuns: count('unassigned'),
    billingIssues: 0,
    activeItems: active.slice(0, 6),
    activeTotal: active.length,
    lowStockItems: 0,
    recentJobs: [],
    lowStockMaterials: [],
    activity: [{ date: '2026-09-14', count: 7 }],
  };
}

function ok(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}
const notFound = (route: Route) => ok(route, { code: 'not_found', message: 'Not found' }, 404);

function currentUser(permissions: string[]) {
  const personId = id(1);
  const accountId = id(2);
  const account = {
    id: accountId,
    personId,
    loginEmail: 'ada.login@example.test',
    provisioningSource: 'local',
    firstAuthenticatedAt: '2026-01-01T00:00:00Z',
    authIdentities: [],
    status: 'enabled',
    passwordStatus: 'active',
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
      roles: [],
      account,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      version: 1,
    },
    account,
    permissions,
    authenticationAssurance: 'normal',
    authentication: {
      method: 'password',
      assurance: 'normal',
      authenticatedAt: '2026-01-01T00:00:00Z',
      authenticatedAssurance: 'normal',
      mfaEnrolled: false,
      mfaRequired: false,
      mfaSetupRequired: false,
      secondFactorMethods: [],
      reauthenticationRequired: [],
    },
    managedDevice: null,
    session: {
      idleExpiresAt: '2099-01-01T01:00:00Z',
      absoluteExpiresAt: '2099-01-02T00:00:00Z',
      postSessionDestination: 'login',
    },
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
      latestConfirmedAt: null,
    },
  };
}

const pricingGroup = {
  id: ids.pricingGroup,
  name: 'Partner institute',
  description: 'Rates for partner institutes.',
  active: true,
  isDefault: true,
  rules: [
    {
      id: id(150),
      kind: 'machine_runtime',
      processId: ids.typePrinter,
      materialTypeId: null,
      materialTypeName: null,
      materialUnit: null,
      rate: '0.50',
      active: true,
      version: 1,
      createdAt: created,
      updatedAt: created,
    },
    {
      id: id(151),
      kind: 'material',
      processId: null,
      materialTypeId: id(900),
      materialTypeName: 'PLA',
      materialUnit: 'g',
      rate: '0.025',
      active: true,
      version: 1,
      createdAt: created,
      updatedAt: created,
    },
  ],
  version: 1,
  createdAt: created,
  updatedAt: created,
};
const organization = {
  id: ids.customer,
  name: 'TU Berlin',
  kind: 'institute',
  active: true,
  addressLine: '',
  postalCode: '',
  locality: '',
  countryCode: '',
  contactName: '',
  contactEmail: '',
  memberCount: 0,
  pricingGroup: { id: ids.pricingGroup, name: pricingGroup.name },
  pricingGroupAssignmentVersion: 1,
  version: 1,
  createdAt: created,
  updatedAt: created,
};

function paginate<T>(items: T[], params: URLSearchParams) {
  const pageNumber = Number(params.get('page') ?? 1);
  const pageSize = Number(params.get('pageSize') ?? 100);
  return {
    items: items.slice((pageNumber - 1) * pageSize, pageNumber * pageSize),
    page: pageNumber,
    pageSize,
    total: items.length,
  };
}

function filterWorkItems(world: World, params: URLSearchParams) {
  const statuses = params.getAll('status');
  const machineIds = params.getAll('machineId');
  const sources = params.getAll('source');
  const search = params.get('search')?.toLowerCase();
  const attention = params.get('attention') === 'true';
  const items = workItems(world).filter(
    (item) =>
      (!attention || item.attention.length > 0) &&
      (statuses.length === 0 || statuses.includes(item.status)) &&
      (machineIds.length === 0 || machineIds.includes(item.machineId)) &&
      (sources.length === 0 || sources.includes(item.source)) &&
      (!search || `${item.displayId} ${item.title ?? ''} ${item.fileName ?? ''}`.toLowerCase().includes(search)),
  );
  return paginate(items, params);
}

/** Replaces a job in the world and returns the served copy (version bumped, derived fields and price recomputed). */
function saveJob(world: World, job: MachineJob): MachineJob {
  const next = { ...job, effectivePrice: null, version: job.version + 1, updatedAt: new Date().toISOString() };
  next.effectivePrice = priceOf(next);
  const index = world.jobs.findIndex((item) => item.id === job.id);
  if (index >= 0) world.jobs[index] = next;
  else world.jobs.push(next);
  return viewJob(world, next);
}

/** Every run in the world as the API serves it, with the job reference filled in. */
function allRuns(world: World): MachineRunDetail[] {
  const manual = world.jobs.flatMap((job) =>
    job.runs
      .filter((run) => run.source === 'manual')
      .map(
        (run) =>
          ({
            ...presentRun(run),
            job: { id: job.id, displayId: job.displayId, title: job.title },
            events: [],
          }) as MachineRunDetail,
      ),
  );
  return [...manual, ...world.runs];
}

export async function installMachinesJobsApi(page: Page, world: World = createWorld()): Promise<World> {
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const params = url.searchParams;
    const body =
      method === 'GET' || (method === 'DELETE' && !request.postData())
        ? undefined
        : (request.postDataJSON() as Record<string, unknown>);
    let match: RegExpMatchArray | null;

    if (path === '/api/v1/auth/activity' && method === 'POST') return ok(route, currentUser(world.permissions).session);
    // The header bell polls the unread count on every page.
    if (path === '/api/v1/notifications/unread-count') return ok(route, { unreadCount: 0 });
    if (method !== 'GET')
      world.requests.push({
        method,
        path,
        search: url.search,
        body: body ?? (request.postData() ? request.postDataJSON() : undefined),
      });

    // Session, branding
    if (path === '/api/v1/auth/me') return ok(route, currentUser(world.permissions));
    // The dashboard is where redirects land; it asks for these three once it renders.
    if (path === '/api/v1/me/dashboard') return ok(route, { person: { firstName: 'Ada', memberSince: '2025-01-01' } });
    if (path === '/api/v1/laborordnung/status/me') return ok(route, currentUser(world.permissions).laborordnungStatus);
    if (path === '/api/v1/me/guides') return ok(route, welcomeTourSeen);
    if (path === '/api/v1/public/open-days') return ok(route, { items: [] });
    if (path === '/api/v1/auth/oidc/providers') return ok(route, { items: [] });
    if (path === '/api/v1/public/config') return ok(route, defaultPublicBrandingConfiguration());

    // Overview, activity, work items, statistics
    if (path === '/api/v1/machine-logbook/overview') return ok(route, overview(world));
    if (path === '/api/v1/machine-logbook/machine-activity') return ok(route, { items: world.activity });
    if (path === '/api/v1/machine-logbook/work-items') return ok(route, filterWorkItems(world, params));
    if (path === '/api/v1/machine-logbook/statistics') {
      world.statisticsRequests.push(params);
      return ok(route, world.statistics);
    }

    // Lookups
    if (path === '/api/v1/billing-parties') return ok(route, { items: [customer] });
    if (path === '/api/v1/machine-job-operators') return ok(route, { items: [operator] });
    if (path === '/api/v1/organizations') return ok(route, pageOf([organization]));
    if (path === '/api/v1/pricing-role-groups') return ok(route, { items: [] });
    if (path === '/api/v1/pricing-groups') return ok(route, { items: [pricingGroup] });

    // Machines
    if (path === '/api/v1/processes') return ok(route, { items: types });
    if (path === '/api/v1/material-types') return ok(route, { items: materialTypes });
    if (path === '/api/v1/machines' && method === 'GET') return ok(route, pageOf(world.machines));
    if (path === '/api/v1/machines' && method === 'POST') {
      const created_ = machine(
        id(160),
        String(body?.name),
        types.find((type) => type.id === body?.processId) ?? types[0],
        { status: 'active', version: 1 },
      );
      world.machines.push(created_);
      return ok(route, created_, 201);
    }
    if (path.match(/^\/api\/v1\/machines\/([^/]+)\/printer\/live-status$/)) return notFound(route);
    // No printer reports live status in this world, so no slot reads a spool tag either.
    if (path === '/api/v1/printers/detected-spool-tags' && method === 'GET') return ok(route, { items: [] });
    if (path === '/api/v1/invoicing/wiref-settings' && method === 'GET')
      return ok(route, {
        enabled: false,
        recipientEmail: '',
        ccEmails: [],
        replyToEmail: '',
        mailSubject: 'Invoice request {{request_number}} for {{organization}}',
        mailIntro: 'Please issue the invoice described below.',
        mailClosing: 'This message was sent automatically.',
        pdfTitle: 'Invoice request {{request_number}}',
        pdfIntro: 'Please invoice {{organization}}.',
        pdfClosing: 'Approved on {{approved_on}}.',
        showContactPerson: true,
        showApprover: true,
        showPurchaseOrder: true,
        showServicePeriod: true,
        showServiceDescription: true,
        placeholders: [{ token: '{{organization}}', description: 'Name of the invoice recipient.' }],
        version: 1,
        updatedAt: '2026-10-21T00:00:00Z',
      });
    // Settings, Local services: one connector that runs an older release with the updater sidecar.
    if (path === '/api/v1/printer-connectors' && method === 'GET')
      return ok(route, {
        coreVersion: '0.8.3',
        items: [
          {
            id: ids.connector,
            name: 'Bambu LAN',
            locationLabel: 'Print room',
            lifecycle: 'active',
            configurationRevision: 2,
            appliedConfigurationRevision: 2,
            softwareVersion: '0.8.2',
            protocolVersion: 1,
            healthState: 'connected',
            healthSummary: null,
            pendingEventCount: 0,
            quarantinedEventCount: 0,
            lastHeartbeatAt: minutes(-1),
            enrolledAt: created,
            disabledAt: null,
            revokedAt: null,
            eventsClearedAt: null,
            eventsClearedByName: null,
            updaterAvailable: true,
            update: null,
            version: 3,
            createdAt: created,
            updatedAt: created,
          },
        ],
      });
    if (path.match(/^\/api\/v1\/printer-connectors\/[^/]+\/assignments$/) && method === 'GET')
      return ok(route, { items: [] });
    if (path.match(/^\/api\/v1\/machines\/([^/]+)\/printer\/setup$/) && method === 'PUT')
      return ok(route, { ...world.printerProfile, version: world.printerProfile.version + 1 });
    if ((match = path.match(/^\/api\/v1\/machines\/([^/]+)\/printer$/))) {
      return match[1] === ids.bambu ? ok(route, world.printerProfile) : notFound(route);
    }
    if ((match = path.match(/^\/api\/v1\/machines\/([^/]+)$/))) {
      const found = world.machines.find((item) => item.id === match![1]);
      if (!found) return notFound(route);
      if (method === 'PATCH') {
        const updated = {
          ...found,
          name: String(body?.name ?? found.name),
          status: (body?.status ?? found.status) as Machine['status'],
          version: found.version + 1,
        };
        world.machines[world.machines.indexOf(found)] = updated;
        return ok(route, updated);
      }
      return ok(route, found);
    }

    // Jobs
    const jobOf = (jobId: string) => world.jobs.find((item) => item.id === jobId);
    const newManualRun = (
      input: Record<string, unknown>,
      job: MachineJob,
      runId: string,
      displayId: string,
    ): MachineRun =>
      manualRunFixture({
        id: runId,
        displayId,
        machineId: job.machine.id,
        machineName: job.machine.name,
        startedAt: String(input.startsAt),
        endedAt: String(input.endsAt),
        outcome: (input.outcome as MachineRun['outcome']) ?? null,
        version: 1,
        usages: ((input.usages as Record<string, unknown>[]) ?? []).map((usage, index) =>
          usageOf(200 + index, String(usage.quantity)),
        ),
      });
    if ((match = path.match(/^\/api\/v1\/machine-jobs\/([^/]+)\/order-association$/)))
      return ok(route, { orderId: null, orderReference: null, sourceChanged: false });
    if ((match = path.match(/^\/api\/v1\/machine-jobs\/([^/]+)\/price-adjustment$/))) {
      const job = jobOf(match[1]);
      if (!job) return notFound(route);
      if (method === 'PUT')
        return ok(
          route,
          saveJob(world, {
            ...job,
            priceAdjustment: {
              kind: body?.kind as 'fixed',
              value: String(body?.value),
              reason: String(body?.reason),
              adjustedAt: new Date().toISOString(),
            },
          }),
        );
      if (method === 'DELETE') return ok(route, saveJob(world, { ...job, priceAdjustment: null }));
    }
    if ((match = path.match(/^\/api\/v1\/machine-jobs\/([^/]+)\/runs$/)) && method === 'POST') {
      const job = jobOf(match[1]);
      if (!job) return notFound(route);
      return ok(
        route,
        saveJob(world, {
          ...job,
          runs: [...job.runs, newManualRun(body!.run as Record<string, unknown>, job, ids.runAdded, 'RN-2026-000020')],
        }),
        201,
      );
    }
    if ((match = path.match(/^\/api\/v1\/machine-jobs\/([^/]+)$/))) {
      const job = jobOf(match[1]);
      if (!job) return notFound(route);
      if (method === 'PATCH') {
        const override = (body?.outcomeOverride as MachineJob['outcome'] | null) ?? null;
        return ok(
          route,
          saveJob(world, {
            ...job,
            outcomeOverridden: override !== null,
            outcome: override ?? job.outcome,
            title: (body?.title as string | null) ?? null,
            notes: (body?.notes as string | null) ?? null,
          }),
        );
      }
      return ok(route, viewJob(world, job));
    }
    if (path === '/api/v1/machine-jobs' && method === 'POST') {
      const machineFor = world.machines.find((item) => item.id === body?.machineId) ?? world.machines[0];
      const job = jobFixture({
        id: ids.newJob,
        displayId: 'J-2026-000010',
        title: (body?.title as string | null) ?? null,
        machine: machineFor,
        notes: (body?.notes as string | null) ?? null,
        version: 0,
        calculatedPrice: '8.00',
        effectivePrice: '8.00',
      });
      return ok(
        route,
        saveJob(world, {
          ...job,
          runs: [newManualRun(body!.run as Record<string, unknown>, job, ids.runNew, 'RN-2026-000010')],
        }),
        201,
      );
    }

    // Runs
    if (path === '/api/v1/machine-runs' && method === 'GET') {
      let items: MachineRun[] = allRuns(world);
      if (params.get('machineId')) items = items.filter((run) => run.machineId === params.get('machineId'));
      if (params.get('source')) items = items.filter((run) => run.source === params.get('source'));
      if (params.get('assigned'))
        items = items.filter((run) => Boolean(run.job) === (params.get('assigned') === 'true'));
      return ok(route, paginate(items, params));
    }
    // Print files, previews, timelapse and consumption of recorded runs: none in the mock.
    if ((match = path.match(/^\/api\/v1\/machine-runs\/([^/]+)\/recording$/)) && method === 'GET') {
      const run = allRuns(world).find((item) => item.id === match![1]);
      if (!run) return notFound(route);
      return ok(route, {
        runId: run.id,
        runDisplayId: run.displayId,
        source: run.source,
        state: run.state,
        startedAt: run.startedAt,
        consumptionStatus: null,
        artifact: null,
        previews: [],
        timelapse: null,
        timelapseStatus: null,
        commands: [],
      });
    }
    if ((match = path.match(/^\/api\/v1\/machine-jobs\/([^/]+)\/recordings$/)) && method === 'GET') {
      return ok(route, { items: [] });
    }
    if (path === '/api/v1/machine-logbook/recording-settings' && method === 'GET') {
      return ok(route, {
        timelapseEnabled: true,
        timelapseRetentionDays: 90,
        timelapseMaxBytes: 209715200,
        version: 1,
        updatedAt: '2026-09-01T00:00:00Z',
      });
    }
    if ((match = path.match(/^\/api\/v1\/machine-runs\/([^/]+)\/signage-visibility$/)) && method === 'PUT') {
      const run = world.runs.find((item) => item.id === match![1]);
      if (!run) return notFound(route);
      run.hiddenFromSignage = body?.hidden === true;
      return ok(route, run);
    }
    if ((match = path.match(/^\/api\/v1\/machine-runs\/([^/]+)\/job$/))) {
      const run = world.runs.find((item) => item.id === match![1]);
      if (!run) return notFound(route);
      if (method === 'POST') {
        const job = saveJob(
          world,
          jobFixture({
            id: ids.newJob,
            displayId: 'J-2026-000011',
            title: (body?.title as string | null) ?? null,
            machine: world.machines.find((item) => item.id === run.machineId)!,
            version: 0,
          }),
        );
        run.job = { id: job.id, displayId: job.displayId, title: job.title };
        return ok(route, viewJob(world, job), 201);
      }
      if (method === 'PUT') {
        const job = jobOf(String(body?.machineJobId));
        if (!job) return notFound(route);
        const replace = body?.replaceManualRuns === true;
        run.job = { id: job.id, displayId: job.displayId, title: job.title };
        return ok(
          route,
          saveJob(world, {
            ...job,
            runs: job.runs.map((item) =>
              replace && item.source === 'manual' ? { ...item, state: 'replaced' as const } : item,
            ),
          }),
        );
      }
      if (method === 'DELETE') {
        const job = jobOf(run.job?.id ?? '');
        run.job = null;
        if (!job) return notFound(route);
        const remaining = job.runs.filter((item) => item.state !== 'replaced');
        // The last run leaves a manual copy with the same times and outcome.
        const copy =
          remaining.length === 0
            ? [
                manualRunFixture({
                  id: id(210),
                  displayId: 'RN-2026-000030',
                  machineId: run.machineId,
                  machineName: run.machineName,
                  startedAt: run.startedAt,
                  endedAt: run.endedAt ?? run.estimatedEndAt,
                  outcome: run.outcome,
                  usages: [],
                }),
              ]
            : [];
        return ok(route, saveJob(world, { ...job, runs: [...job.runs, ...copy] }));
      }
    }
    if ((match = path.match(/^\/api\/v1\/machine-runs\/([^/]+)\/(cancellation|usages)$/))) {
      const job = world.jobs.find((item) => item.runs.some((run) => run.id === match![1]));
      const stored = job?.runs.find((run) => run.id === match![1]);
      if (!job || !stored) return notFound(route);
      if (match[2] === 'cancellation' && method === 'POST') {
        const now = new Date().toISOString();
        const runs = job.runs.map((run) =>
          run.id === stored.id
            ? { ...run, endedAt: now, outcome: 'cancelled' as const, version: run.version + 1 }
            : run,
        );
        return ok(route, saveJob(world, { ...job, runs, calculatedPrice: '3.10' }));
      }
      if (match[2] === 'usages' && method === 'PUT') {
        const usages = ((body?.usages as Record<string, unknown>[]) ?? []).map((usage, index) =>
          usageOf(220 + index, String(usage.quantity)),
        );
        const runs = job.runs.map((run) => (run.id === stored.id ? { ...run, usages, version: run.version + 1 } : run));
        const saved = saveJob(world, { ...job, runs });
        return ok(route, { run: saved.runs.find((run) => run.id === stored.id), job: saved });
      }
    }
    if ((match = path.match(/^\/api\/v1\/machine-runs\/([^/]+)$/))) {
      const job = world.jobs.find((item) => item.runs.some((run) => run.id === match![1]));
      const stored = job?.runs.find((run) => run.id === match![1]);
      if (method === 'GET') {
        const found = allRuns(world).find((run) => run.id === match![1]);
        return found ? ok(route, found) : notFound(route);
      }
      if (!job || !stored) return notFound(route);
      if (method === 'DELETE') {
        if (job.runs.filter((run) => run.state !== 'replaced').length <= 1)
          return ok(route, { code: 'job_needs_run', message: 'A job needs at least one run' }, 409);
        return ok(route, saveJob(world, { ...job, runs: job.runs.filter((run) => run.id !== stored.id) }));
      }
      if (method === 'PATCH') {
        const runs = job.runs.map((run) =>
          run.id === stored.id
            ? {
                ...run,
                startedAt: String(body?.startsAt ?? run.startedAt),
                endedAt: String(body?.endsAt ?? run.endedAt),
                outcome: (body?.outcome as MachineRun['outcome']) ?? null,
                version: run.version + 1,
              }
            : run,
        );
        const saved = saveJob(world, { ...job, runs });
        return ok(route, { run: saved.runs.find((run) => run.id === stored.id), job: saved });
      }
    }

    // Inventory
    if (path === '/api/v1/materials') return ok(route, { ...pageOf(world.materials), totalInventoryValue: '198.00' });
    if ((match = path.match(/^\/api\/v1\/materials\/([^/]+)\/transactions$/))) {
      return ok(
        route,
        pageOf([
          {
            id: id(170),
            materialId: match[1],
            kind: 'purchase',
            quantityDelta: '1000',
            unitAcquisitionCost: '0.02',
            inventoryValueDelta: '20',
            totalPurchasePrice: '20',
            occurredAt: '2026-09-10T10:00:00Z',
            supplier: 'Filament shop',
            createdAt: '2026-09-10T10:00:00Z',
          },
          {
            id: id(171),
            materialId: match[1],
            kind: 'spool_transfer',
            quantityDelta: '0',
            unitAcquisitionCost: '0',
            inventoryValueDelta: '0',
            transferQuantity: '1000',
            toSpoolId: ids.spoolReusable,
            toSpoolDisplayId: 'S-PLA-BLACK-01',
            occurredAt: '2026-10-02T08:00:00Z',
            createdAt: '2026-10-02T08:00:00Z',
          },
        ]),
      );
    }
    if ((match = path.match(/^\/api\/v1\/materials\/([^/]+)$/))) {
      const found = world.materials.find((item) => item.id === match![1]);
      return found ? ok(route, found) : notFound(route);
    }
    if ((match = path.match(/^\/api\/v1\/materials\/([^/]+)$/)) && method === 'DELETE') {
      world.materials.splice(0, world.materials.length, ...world.materials.filter((item) => item.id !== match![1]));
      return route.fulfill({ status: 204 });
    }
    if ((match = path.match(/^\/api\/v1\/inventory\/ledger\/([^/]+)$/)) && method === 'DELETE') {
      return route.fulfill({ status: 204 });
    }
    if (path === '/api/v1/inventory/recycle-bin' && method === 'GET') {
      return ok(route, {
        materials: [],
        spools: world.spools.filter((item) => item.lifecycle === 'archived'),
        ledgerEntries: [],
      });
    }
    if ((match = path.match(/^\/api\/v1\/inventory\/recycle-bin\/spools\/([^/]+)\/(restore|purge)$/))) {
      const found = world.spools.find((item) => item.id === match![1]);
      if (!found) return notFound(route);
      if (match[2] === 'purge') {
        world.spools.splice(world.spools.indexOf(found), 1);
        return route.fulfill({ status: 204 });
      }
      const restored = {
        ...found,
        lifecycle: 'active' as const,
        archivedAt: null,
        retiredOutcome: null,
        version: found.version + 1,
      };
      world.spools[world.spools.indexOf(found)] = restored;
      return ok(route, restored);
    }
    if ((match = path.match(/^\/api\/v1\/filament-spools\/([^/]+)\/retire$/)) && method === 'POST') {
      const found = world.spools.find((item) => item.id === match![1]);
      if (!found) return notFound(route);
      const retired = {
        ...found,
        lifecycle: 'archived' as const,
        archivedAt: new Date().toISOString(),
        retiredOutcome: body?.outcome as 'empty' | 'discarded',
        retiredQuantity: found.remainingQuantity,
        retiredByName: 'Maria Hoffmann',
        remainingQuantity: '0',
        mounted: false,
        mountedOn: null,
        version: found.version + 1,
      };
      world.spools[world.spools.indexOf(found)] = retired;
      return ok(route, retired);
    }
    if (path === '/api/v1/filament-spools' && method === 'GET') {
      let items = world.spools;
      if (params.get('lifecycle')) items = items.filter((item) => item.lifecycle === params.get('lifecycle'));
      if (params.get('materialId')) items = items.filter((item) => item.materialId === params.get('materialId'));
      if (params.get('mounted')) items = items.filter((item) => String(item.mounted) === params.get('mounted'));
      if (params.get('consumable') === 'true')
        items = items.filter((item) => item.lifecycle === 'active' && Number(item.remainingQuantity) > 0);
      return ok(route, paginate(items, params));
    }
    if ((match = path.match(/^\/api\/v1\/filament-spools\/([^/]+)\/transactions$/))) {
      return ok(
        route,
        pageOf([
          {
            id: id(172),
            materialId: ids.pla,
            kind: 'machine_run_consumption',
            quantityDelta: '-183',
            unitAcquisitionCost: '0.018',
            inventoryValueDelta: '-3.29',
            occurredAt: '2026-10-03T08:00:00Z',
            machineJobId: ids.jobSuccess,
            machineJobDisplayId: 'J-2026-000001',
            spoolId: match[1],
            spoolDisplayId: 'S-PLA-BLACK-01',
            createdAt: '2026-10-03T08:00:00Z',
          },
        ]),
      );
    }
    if ((match = path.match(/^\/api\/v1\/filament-spools\/([^/]+)$/))) {
      const found = world.spools.find((item) => item.id === match![1]);
      return found ? ok(route, found) : notFound(route);
    }

    // Machines › Printers and the printer setup page (see printerMock below).
    const printerResponse = printerMock(world, method, path, params, body);
    if (printerResponse) return ok(route, printerResponse.body, printerResponse.status);

    world.unhandled.push(`${method} ${path}${url.search}`);
    return route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'unhandled_in_e2e_mock', message: `${method} ${path}` }),
    });
  });
  return world;
}

// ---------------------------------------------------------------------------
// Machines › Printers (error catalog, code list fetch, notification rules) and the printer error history.
// ---------------------------------------------------------------------------

type PrinterCodeMock = {
  id: string;
  sourceFamily: 'hms' | 'print';
  code: string;
  title: string;
  description: string;
  link: string | null;
  source: 'bambu' | 'manual';
  updatedAt: string;
};
type PrinterMockState = {
  codes: PrinterCodeMock[];
};

const printerMockStates = new WeakMap<object, PrinterMockState>();

function printerMockState(world: object): PrinterMockState {
  const existing = printerMockStates.get(world);
  if (existing) return existing;
  const at = '2026-11-01T03:00:00Z';
  const entry = (
    n: number,
    sourceFamily: PrinterCodeMock['sourceFamily'],
    code: string,
    title: string,
    description: string,
    source: PrinterCodeMock['source'],
  ): PrinterCodeMock => ({ id: id(n), sourceFamily, code, title, description, link: null, source, updatedAt: at });
  const state: PrinterMockState = {
    codes: [
      entry(901, 'hms', '0300-0D00-0001-0001', 'Heatbed temperature abnormal', 'Check the heatbed cable.', 'bambu'),
      entry(902, 'hms', '0700-2000-0002-0001', 'AMS filament stuck', 'Clear the filament path.', 'bambu'),
      entry(903, 'print', '0500-4001', 'SD card read error', '', 'manual'),
    ],
  };
  printerMockStates.set(world, state);
  return state;
}

/** Answers the printer endpoints of the Machines pages, or returns undefined for any other request. */
function printerMock(
  world: object,
  method: string,
  path: string,
  params: URLSearchParams,
  body: Record<string, unknown> | undefined,
): { body: unknown; status?: number } | undefined {
  const state = printerMockState(world);
  const sync = {
    enabled: true,
    lastAttemptAt: '2026-11-01T03:00:00Z',
    lastSuccessAt: '2026-11-01T03:00:00Z',
    lastError: null,
    importedCount: 2,
  };
  if (path === '/api/v1/printer-error-codes' && method === 'GET') {
    const search = (params.get('search') ?? '').toLowerCase();
    const items = state.codes.filter(
      (item) =>
        (!search || `${item.code} ${item.title} ${item.description}`.toLowerCase().includes(search)) &&
        (!params.get('sourceFamily') || item.sourceFamily === params.get('sourceFamily')) &&
        (!params.get('source') || item.source === params.get('source')),
    );
    const page = Number(params.get('page') ?? 1);
    const pageSize = Number(params.get('pageSize') ?? 25);
    return {
      body: { items: items.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total: items.length, sync },
    };
  }
  if (path === '/api/v1/printer-error-codes/sync' && method === 'POST') return { body: sync };
  const code = path.match(/^\/api\/v1\/printer-error-codes\/([^/]+)\/([^/]+)$/);
  if (code && method === 'PUT') {
    const [, family, value] = code;
    const found = state.codes.find((item) => item.sourceFamily === family && item.code === value);
    const saved: PrinterCodeMock = {
      id: found?.id ?? id(950 + state.codes.length),
      sourceFamily: family as PrinterCodeMock['sourceFamily'],
      code: decodeURIComponent(value),
      title: String(body?.title ?? ''),
      description: String(body?.description ?? ''),
      link: (body?.link as string | null) ?? null,
      source: 'manual',
      updatedAt: new Date().toISOString(),
    };
    state.codes = found ? state.codes.map((item) => (item === found ? saved : item)) : [...state.codes, saved];
    return { body: saved };
  }
  if (code && method === 'DELETE') {
    state.codes = state.codes.filter((item) => !(item.sourceFamily === code[1] && item.code === code[2]));
    return { body: {}, status: 200 };
  }
  if (/^\/api\/v1\/machines\/[^/]+\/printer-errors$/.test(path) && method === 'GET') return { body: { items: [] } };
  return undefined;
}
