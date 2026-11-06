import type {
  CurrentUser,
  FilamentSpool,
  InventoryTransaction,
  Machine,
  MachineJob,
  MachineJobUsage,
  MachineRunDetail,
  Material,
  MaterialType,
  OpenDay,
  OpenDayStaffRequirement,
  Order,
  Organization,
  PricingGroup,
  PricingRule,
  Process,
  Role,
} from '../../../api/generated/models';
import { dimensionOf } from '../../machinelogbook/units';
import { DEMO_IDS, sampleDemoId } from './ids';
import { refreshJob, runDuration } from './jobModel';
import { actorOf, recalculateOrder, recordPayment } from './orderModel';
import { refreshPeriod } from './openDayModel';
import {
  daysFromNow,
  decimal,
  hoursAgo,
  organizationParty,
  personParty,
  type DemoPerson,
  type DemoStore,
} from './store';

const T = '2026-01-01T00:00:00.000Z';
const ID = {
  fdm: sampleDemoId(0xd01),
  laserProcess: sampleDemoId(0xd02),
  pla: sampleDemoId(0xe01),
  petg: sampleDemoId(0xe02),
  plywood: sampleDemoId(0xe03),
  white: sampleDemoId(0x202),
  orange: sampleDemoId(0x203),
  plywoodSheet: sampleDemoId(0x204),
  members: sampleDemoId(0xb01),
  external: sampleDemoId(0xb02),
  supervisorRole: sampleDemoId(0xa01),
  traineeRole: sampleDemoId(0xa02),
  memberRole: sampleDemoId(0xa03),
};

const OTHER_PEOPLE: DemoPerson[] = [
  { id: DEMO_IDS.customer, firstName: 'Robin', lastName: 'Sample' },
  { id: sampleDemoId(0x702), firstName: 'Alex', lastName: 'Demo' },
  { id: sampleDemoId(0x703), firstName: 'Jordan', lastName: 'Example' },
  { id: sampleDemoId(0x704), firstName: 'Sam', lastName: 'Placeholder' },
  { id: sampleDemoId(0x705), firstName: 'Kim', lastName: 'Testwell' },
  { id: sampleDemoId(0x706), firstName: 'Noa', lastName: 'Fiction' },
];

const role = (id: string, name: string, systemKey: Role['systemKey']): Role => ({
  id,
  name,
  description: null,
  systemKey,
  permissionGrants: [],
  profileImageRequired: false,
  laborordnungMode: 'not_required',
  createdAt: T,
  updatedAt: T,
  version: 1,
});

const process = (id: string, name: string, integration: Process['integration']): Process => ({
  id,
  name,
  active: true,
  integration,
  measures: [],
  version: 1,
  createdAt: T,
  updatedAt: T,
});

const machine = (id: string, name: string, process: Process, externalIdentifier: string | null): Machine => ({
  id,
  name,
  process,
  status: 'active',
  externalIdentifier,
  automaticCollectionEnabled: process.integration === 'fdm_printer',
  lastIngestedAt: null,
  jobCount: 0,
  runtimeSeconds: 0,
  failureRate: '0.00',
  attention: [],
  version: 1,
  createdAt: T,
  updatedAt: T,
});

const materialType = (
  id: string,
  name: string,
  code: string,
  kind: MaterialType['kind'],
  unit: MaterialType['unit'],
  processIds: string[],
  variants: string[],
): MaterialType => ({
  id,
  name,
  code,
  kind,
  machineUse: true,
  unit,
  dimension: dimensionOf(unit),
  processIds,
  variants: variants.map((variant, index) => ({
    id: sampleDemoId(0xf00 + parseInt(id.slice(-3), 16) + index),
    materialTypeId: id,
    name: variant,
    materialCount: 1,
    pricingRuleCount: 0,
  })),
  active: true,
  materialCount: 0,
  pricingRuleCount: 1,
  version: 1,
  createdAt: T,
  updatedAt: T,
});

function material(
  type: MaterialType,
  id: string,
  displayId: string,
  name: string,
  colorName: string | null,
  colorHex: string | null,
  quantity: number,
  assigned: number,
  unitCost: number,
  lowStock: number,
  rate: string,
  priceGroup: PricingGroup,
): Material {
  const packageSize = type.kind === 'filament' ? '1000' : '1.5';
  return {
    id,
    displayId,
    name,
    kind: type.kind,
    materialTypeId: type.id,
    materialTypeName: type.name,
    materialTypeCode: type.code,
    machineUse: true,
    variantId: type.variants[0]?.id ?? null,
    variant: type.variants[0]?.name ?? null,
    manufacturer: type.kind === 'filament' ? 'Demo Filaments' : 'Demo Timber',
    packageSize,
    storageLocation: type.kind === 'filament' ? 'Shelf A' : 'Sheet rack',
    notes: null,
    colorName,
    colorHex,
    unit: type.unit,
    dimension: type.dimension,
    active: true,
    lowStockThreshold: decimal(lowStock, 1),
    quantity: decimal(quantity, 3),
    assignedQuantity: decimal(assigned, 3),
    unassignedQuantity: decimal(quantity - assigned, 3),
    filamentDiameterMm: type.kind === 'filament' ? '1.75' : null,
    averageUnitCost: decimal(unitCost, 4),
    inventoryValue: decimal(quantity * unitCost, 2),
    stockState: quantity <= 0 ? 'empty' : quantity <= lowStock ? 'low_stock' : 'in_stock',
    inventoryVersion: 1,
    recentConsumption: decimal(quantity / 10, 3),
    prices: [
      {
        pricingGroupId: priceGroup.id,
        pricingGroupName: priceGroup.name,
        rate,
        source: 'material_type',
        pricingRuleId: sampleDemoId(0xb20),
      },
    ],
    attention: quantity <= lowStock ? [{ code: 'low_stock', message: 'Stock is running low.' }] : [],
    version: 1,
    createdAt: T,
    updatedAt: T,
  };
}

function spool(m: Material, id: string, displayId: string, remaining: number, location: string): FilamentSpool {
  return {
    id,
    displayId,
    materialId: m.id,
    materialDisplayId: m.displayId,
    materialName: m.name,
    materialTypeName: m.materialTypeName,
    colorName: m.colorName,
    colorHex: m.colorHex,
    manufacturer: m.manufacturer,
    unit: 'g',
    initialNetWeightG: '1000',
    remainingQuantity: decimal(remaining, 1),
    tareWeightG: '230',
    acquiredOn: T.slice(0, 10),
    acquisitionReference: null,
    storageLocation: location,
    notes: null,
    lifecycle: 'active',
    archivedAt: null,
    retiredOutcome: null,
    retiredQuantity: null,
    retiredByName: null,
    mounted: false,
    mountedOn: null,
    identifiers: [],
    attention: [],
    version: 1,
    createdAt: T,
    updatedAt: T,
  };
}

function usageOf(m: Material, grams: number, id: string, s?: FilamentSpool): MachineJobUsage {
  return {
    id,
    ownership: 'makerspace',
    materialId: m.id,
    spoolId: s?.id ?? null,
    spoolDisplayId: s?.displayId ?? null,
    materialName: m.name,
    materialTypeId: m.materialTypeId,
    materialTypeName: m.materialTypeName,
    label: null,
    unit: m.unit,
    quantity: decimal(grams, 3),
    quantityBasis: 'actual',
    staffCorrected: false,
  };
}

function rule(group: PricingGroup, id: number, fields: Partial<PricingRule> & Pick<PricingRule, 'kind' | 'rate'>) {
  group.rules.push({ id: sampleDemoId(id), pricingGroupId: group.id, active: true, version: 1, ...fields });
}

function pricingGroup(id: string, name: string, isDefault: boolean, factor: number, base: number): PricingGroup {
  const group: PricingGroup = {
    id,
    name,
    description: isDefault ? 'Rates for members and supervisors.' : 'Rates for outside organizations.',
    active: true,
    isDefault,
    rules: [],
    version: 1,
    createdAt: T,
    updatedAt: T,
  };
  const rates: [string, string, number][] = [
    ['machine', ID.fdm, 2 * factor],
    ['machine', ID.laserProcess, 12 * factor],
  ];
  rates.forEach(([, processId, rate], index) =>
    rule(group, base + index, {
      kind: 'machine_runtime',
      processId,
      rate: decimal(rate, 2),
    }),
  );
  [
    [ID.pla, 'PLA', 0.03],
    [ID.petg, 'PETG', 0.035],
  ].forEach(([typeId, name, rate], index) =>
    rule(group, base + 10 + index, {
      kind: 'material',
      materialTypeId: typeId as string,
      materialTypeName: name as string,
      materialUnit: 'g',
      rate: decimal((rate as number) * factor, 3),
    }),
  );
  rule(group, base + 20, {
    kind: 'material',
    materialTypeId: ID.plywood,
    materialTypeName: 'Plywood',
    materialUnit: 'm2',
    rate: decimal(8 * factor, 2),
  });
  return group;
}

function openDaySeed(store: DemoStore): OpenDay[] {
  const others = OTHER_PEOPLE.slice(1);
  const assignments = [
    { supervisor: [0, 1], trainee: [2] },
    { supervisor: [0], trainee: [] },
    { supervisor: [0, 1, 3], trainee: [2] },
    { supervisor: [], trainee: [] },
  ];
  const offsets = [3, 10, 17, 24];
  return DEMO_IDS.openDays.map((id, index) => {
    const timeslotId = sampleDemoId(0x980 + index);
    const requirements: OpenDayStaffRequirement[] = (['supervisor', 'trainee'] as const).map((kind, k) => {
      const requirementId = sampleDemoId(0x900 + index * 2 + k);
      const people = assignments[index][kind].map((personIndex, a) => ({
        id: sampleDemoId(0xa00 + index * 10 + k * 5 + a),
        openDayId: id,
        timeslotId,
        requirementId,
        personId: others[personIndex].id,
        displayName: `${others[personIndex].firstName} ${others[personIndex].lastName}`,
        isCurrentUser: false,
        createdAt: T,
      }));
      return {
        id: requirementId,
        timeslotId,
        kind,
        requiredCount: kind === 'supervisor' ? 3 : 2,
        assignedCount: people.length,
        eligible: false,
        canJoin: false,
        eligibleRoleIds: [],
        assignments: people,
      };
    });
    return {
      id,
      periodId: DEMO_IDS.period,
      competencies: [
        { id: sampleDemoId(0x950), label: '3D printing' },
        { id: sampleDemoId(0x951), label: 'Laser cutting' },
      ],
      startsAt: daysFromNow(store, offsets[index], 16),
      endsAt: daysFromNow(store, offsets[index], 20),
      internalNote: null,
      status: 'scheduled',
      timeslots: [
        {
          id: timeslotId,
          position: 0,
          startsAt: daysFromNow(store, offsets[index], 16),
          endsAt: daysFromNow(store, offsets[index], 20),
          requirements,
          myAssignment: null,
        },
      ],
      seriesId: null,
      detachedFromSeriesId: null,
      version: 1,
      createdAt: T,
      updatedAt: T,
    };
  });
}

/** Builds the sample workshop, shop and Open Day data a demo session starts from. Dates are relative to `now`. */
export function createStore(user: CurrentUser, now: Date = new Date()): DemoStore {
  const members = pricingGroup(ID.members, 'Members', true, 1, 0xb30);
  const external = pricingGroup(ID.external, 'External', false, 2, 0xb50);
  const fdm = process(ID.fdm, '3D printing', 'fdm_printer');
  const laserProcess = process(ID.laserProcess, 'Laser cutting', 'none');
  const me: DemoPerson = { id: user.person.id, firstName: user.person.firstName, lastName: user.person.lastName };
  const organization: Organization = {
    id: DEMO_IDS.organization,
    name: 'Demo Robotics Club',
    kind: 'association',
    active: true,
    addressLine: '1 Example Street',
    postalCode: '8010',
    locality: 'Graz',
    countryCode: 'AT',
    contactName: 'Robin Sample',
    contactEmail: 'club@example.invalid',
    memberCount: 3,
    pricingGroup: { id: external.id, name: external.name },
    pricingGroupAssignmentVersion: 1,
    version: 1,
    createdAt: T,
    updatedAt: T,
  };
  const types = [
    materialType(ID.pla, 'PLA', 'PLA', 'filament', 'g', [ID.fdm], ['Basic', 'Matte']),
    materialType(ID.petg, 'PETG', 'PETG', 'filament', 'g', [ID.fdm], []),
    materialType(ID.plywood, 'Plywood', 'PLY', 'consumable', 'm2', [ID.laserProcess], ['3 mm']),
  ];
  const [pla, petg, plywood] = types;
  const black = material(
    pla,
    DEMO_IDS.material,
    'M-0001',
    'PLA Basic Black',
    'Black',
    '#1f1f1f',
    1640,
    640,
    0.022,
    300,
    '0.030',
    members,
  );
  const white = material(
    pla,
    ID.white,
    'M-0002',
    'PLA Basic White',
    'White',
    '#f2f2f2',
    820,
    820,
    0.022,
    300,
    '0.030',
    members,
  );
  const orange = material(
    petg,
    ID.orange,
    'M-0003',
    'PETG Orange',
    'Orange',
    '#f28c28',
    90,
    90,
    0.026,
    200,
    '0.035',
    members,
  );
  const sheet = material(
    plywood,
    ID.plywoodSheet,
    'M-0004',
    'Birch plywood 3 mm',
    null,
    null,
    6.5,
    0,
    6,
    2,
    '8.00',
    members,
  );
  types.forEach((type) => {
    type.materialCount = 0;
  });
  const materials = [black, white, orange, sheet];
  materials.forEach((m) => {
    const type = types.find((item) => item.id === m.materialTypeId);
    if (type) type.materialCount += 1;
  });
  const spools = [
    spool(black, sampleDemoId(0x301), 'SP-0001', 640, 'Printer A shelf'),
    spool(white, sampleDemoId(0x302), 'SP-0002', 820, 'Shelf A'),
    spool(orange, sampleDemoId(0x303), 'SP-0003', 90, 'Shelf B'),
  ];
  const transactions: InventoryTransaction[] = materials.map((m, index) => ({
    id: sampleDemoId(0x350 + index),
    materialId: m.id,
    kind: 'purchase',
    quantityDelta: m.quantity,
    unitAcquisitionCost: m.averageUnitCost,
    inventoryValueDelta: m.inventoryValue,
    totalPurchasePrice: m.inventoryValue,
    occurredAt: daysFromNow({ now } as DemoStore, -40),
    supplier: 'Demo Supplies',
    note: 'Initial stock',
    reference: null,
    actorName: 'Alex Demo',
    createdAt: daysFromNow({ now } as DemoStore, -40),
  }));

  const store: DemoStore = {
    user,
    now,
    sequence: 0,
    counters: {},
    people: [me, ...OTHER_PEOPLE],
    organizations: [organization],
    roles: [
      role(ID.supervisorRole, 'Supervisor', 'supervisor'),
      role(ID.traineeRole, 'Trainee', 'trainee'),
      role(ID.memberRole, 'Member', null),
    ],
    processes: [fdm, laserProcess],
    machines: [
      machine(DEMO_IDS.machines.printer, 'Prusa CORE One', fdm, 'demo-printer-a'),
      machine(DEMO_IDS.machines.printer2, 'Bambu H2D', fdm, 'demo-printer-b'),
      machine(DEMO_IDS.machines.laser, 'Laser cutter', laserProcess, null),
    ],
    materialTypes: types,
    materials,
    spools,
    transactions,
    runs: [],
    jobs: [],
    orders: [],
    payments: [],
    pricingGroups: [members, external],
    rolePricingGroups: [ID.supervisorRole, ID.traineeRole, ID.memberRole].map((roleId, index) => ({
      roleId,
      roleName: ['Supervisor', 'Trainee', 'Member'][index],
      pricingGroupId: members.id,
      pricingGroupName: members.name,
      priority: index + 1,
    })),
    period: {
      id: DEMO_IDS.period,
      name: 'Demo semester',
      startsOn: daysFromNow({ now } as DemoStore, -30).slice(0, 10),
      endsOn: daysFromNow({ now } as DemoStore, 90).slice(0, 10),
      signUpDeadline: null,
      status: 'published',
      totalOpenDays: 0,
      fullyStaffedCount: 0,
      needsStaffCount: 0,
      openSupervisorPositions: 0,
      cancelledCount: 0,
      myAssignmentCount: 0,
      version: 1,
      createdAt: T,
      updatedAt: T,
    },
    openDays: [],
    series: [],
    staffingRules: {
      supervisorMinimum: 2,
      traineeMinimum: 2,
      traineeReadyAfter: 3,
      warningWindowDays: 14,
      countBy: 'timeslot',
      defaultDeadline: 'period_end',
      exceptions: [],
      version: 1,
      updatedAt: T,
    },
    // The welcome tour counts as handled, so demo mode does not offer it again.
    guideProgress: [{ guideId: 'welcome', status: 'dismissed', updatedAt: T }],
  };
  store.openDays = openDaySeed(store);
  refreshPeriod(store);

  const [printerA, printerB, laser] = store.machines;
  const runOf = (
    n: number,
    m: Machine,
    file: string | null,
    startedHoursAgo: number,
    hours: number,
    outcome: MachineRunDetail['outcome'],
    usages: MachineJobUsage[],
    source: 'recorded' | 'manual' = 'recorded',
  ): MachineRunDetail => {
    const run: MachineRunDetail = {
      id: sampleDemoId(0x500 + n),
      displayId: `R-${String(n).padStart(4, '0')}`,
      machineId: m.id,
      machineName: m.name,
      source,
      state: outcome === 'failed' || outcome === 'partial_failure' ? 'failed' : 'finished',
      job: null,
      connectorName: source === 'recorded' ? 'Demo connector' : null,
      fileName: file,
      startedAt: hoursAgo(store, startedHoursAgo),
      endedAt: hoursAgo(store, startedHoursAgo - hours),
      estimatedEndAt: null,
      durationSeconds: 0,
      progressPercent: 100,
      outcome,
      outcomeFromMachine: source === 'recorded',
      usages,
      measures: {},
      usagesFromMachine: source === 'recorded',
      reportedUsage: null,
      reportedUsageItems: [],
      materialChangedDuringRun: false,
      artifact: null,
      consumptionStatus: null,
      hiddenFromSignage: false,
      jobHiddenFromSignage: false,
      version: 1,
      events: [],
    };
    run.durationSeconds = runDuration(run, store);
    return run;
  };
  const r1 = runOf(1, printerA, 'benchy.3mf', 3, 1.5, 'successful', [
    usageOf(black, 18, sampleDemoId(0x560), spools[0]),
  ]);
  const r2 = runOf(2, printerB, 'bracket.3mf', 26, 2, 'successful', [
    usageOf(white, 34, sampleDemoId(0x561), spools[1]),
  ]);
  const r3 = runOf(3, printerA, 'phone-stand.3mf', 30, 2.5, 'successful', [
    usageOf(black, 41, sampleDemoId(0x562), spools[0]),
  ]);
  const r4 = runOf(4, printerB, 'gear.3mf', 52, 1, 'partial_failure', [
    usageOf(orange, 12, sampleDemoId(0x563), spools[2]),
  ]);
  const r5 = runOf(5, laser, null, 72, 0.75, 'successful', [usageOf(sheet, 0.25, sampleDemoId(0x564))], 'manual');
  store.runs = [r1, r2, r3, r4, r5];

  const jobOf = (
    id: string,
    n: number,
    title: string,
    m: Machine,
    customer: MachineJob['customer'],
    operator: DemoPerson,
    run: MachineRunDetail,
  ): MachineJob => {
    const job: MachineJob = {
      id,
      displayId: `J-${String(n).padStart(4, '0')}`,
      title,
      artifact: null,
      machine: m,
      runs: [],
      startedAt: null,
      endedAt: null,
      expectedEndAt: null,
      durationSeconds: 0,
      measures: {},
      customer,
      operator: { personId: operator.id, displayName: `${operator.firstName} ${operator.lastName}` },
      outcome: 'unknown',
      outcomeOverridden: false,
      status: 'needs_outcome',
      notes: null,
      pricingStatus: 'pending',
      pricingSnapshot: null,
      calculatedPrice: null,
      priceAdjustment: null,
      effectivePrice: null,
      hiddenFromSignage: false,
      attention: [],
      version: 1,
      createdAt: run.startedAt,
      updatedAt: run.endedAt ?? run.startedAt,
    };
    run.job = { id: job.id, displayId: job.displayId, title: job.title };
    return job;
  };
  const robin = personParty(OTHER_PEOPLE[0]);
  const jordan = personParty(OTHER_PEOPLE[2]);
  store.jobs = [
    jobOf(DEMO_IDS.job, 1, 'Phone stand', printerA, robin, me, r3),
    jobOf(sampleDemoId(0x402), 2, 'Laser name tags', laser, organizationParty(organization), me, r5),
    jobOf(sampleDemoId(0x403), 3, 'Gear prototype', printerB, jordan, OTHER_PEOPLE[1], r4),
  ];
  store.jobs.forEach((job) => refreshJob(store, job));

  const { nextId } = { nextId: (n: number) => sampleDemoId(0x650 + n) };
  const finalized = (id: string, reference: string, party: ReturnType<typeof personParty>, item: Order['items']) => {
    const order: Order = {
      id,
      reference,
      status: 'finalized',
      currency: 'EUR',
      customerKind: party.kind,
      customer: { kind: party.kind, id: party.id },
      customerName: party.displayName,
      fulfillmentMode: 'deferred',
      totalAmount: '0.00',
      netCharge: '0.00',
      settledAmount: '0.00',
      outstandingAmount: '0.00',
      settlementState: 'unpaid',
      replacesOrderId: null,
      replacesOrderReference: null,
      items: item,
      allocations: [],
      adjustments: [],
      version: 1,
      createdAt: hoursAgo(store, 20),
      updatedAt: hoursAgo(store, 20),
      createdBy: actorOf(store),
      attention: [],
    };
    return recalculateOrder(store, order);
  };
  const tags = store.jobs[1];
  const tagsPrice = tags.effectivePrice ?? '0.00';
  const unpaid = finalized(DEMO_IDS.order, 'ORD-0001', organizationParty(organization), [
    {
      id: nextId(1),
      position: 1,
      kind: 'machine_job',
      description: `${tags.displayId} · ${tags.title}`,
      quantity: '1',
      unit: 'job',
      unitPrice: tagsPrice,
      amount: tagsPrice,
      sourceMachineJobId: tags.id,
      sourceJobVersion: tags.version,
      sourceChanged: false,
      createdAt: hoursAgo(store, 20),
    },
  ]);
  const sold = finalized(sampleDemoId(0x602), 'ORD-0002', robin, [
    {
      id: nextId(2),
      position: 1,
      kind: 'manual',
      description: 'PLA filament, 500 g (sold from stock)',
      quantity: '1',
      unit: 'pc',
      unitPrice: '15.00',
      amount: '15.00',
      sourceChanged: false,
      createdAt: hoursAgo(store, 30),
    },
  ]);
  store.orders = [sold, unpaid];
  recordPayment(store, sold, { method: 'cash', amount: '15.00', occurredAt: hoursAgo(store, 29) }, 'PAY-0001');
  recalculateOrder(store, sold);
  store.counters = { J: 3, R: 5, ORD: 2, PAY: 1, SP: 3, M: 4 };
  return store;
}
