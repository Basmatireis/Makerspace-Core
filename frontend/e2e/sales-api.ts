import type { Page, Route } from '@playwright/test';
import type {
  ExternalInvoiceRequest,
  Material,
  Order,
  OrderItem,
  OrderPayment,
  PricingGroup,
  PricingRule,
  WorkItem,
} from '../src/api/generated/models';
import { defaultPublicBrandingConfiguration } from './branding-fixtures';

/**
 * Stateful mock of the Sales & payments API for the mocked-API sales spec: orders with attention flags, payments,
 * pricing groups with stock_article rules and inventory articles with their group prices. Requests the mock does not
 * know answer 500 and are recorded in `world.unhandled`.
 */

export const id = (n: number) => `0192f6f8-743e-7c77-a349-cd07c3e9${String(n).padStart(4, '0')}`;
const at = (day: number, hour = 10) =>
  `2026-10-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`;

export const salesPermissions = [
  'orders.read',
  'orders.write',
  'orders.finalize',
  'orders.reverse',
  'payments.read',
  'payments.record',
  'payments.reverse',
  'cash_movements.read',
  'cash_movements.record',
  'external_invoice_requests.read',
  'external_invoice_requests.manage',
  'external_invoice_requests.approve',
  'machine_jobs.read',
  'machines.read',
  'inventory.read',
  'pricing.read',
  'pricing.manage',
];

const ids = {
  members: id(1),
  external: id(2),
  fdm: id(3),
  pla: id(4),
  fasteners: id(5),
  plaBlack: id(6),
  insert: id(7),
  institute: id(8),
  sara: id(9),
  draft: id(10),
  open: id(11),
  paid: id(12),
  invoiced: id(13),
  cashPayment: id(14),
  request: id(15),
  readyJob: id(16),
};

function rule(n: number, groupId: string, kind: PricingRule['kind'], rate: string, extra: Partial<PricingRule>) {
  return {
    id: id(100 + n),
    pricingGroupId: groupId,
    kind,
    processId: null,
    materialTypeId: null,
    materialTypeName: null,
    materialUnit: null,
    materialId: null,
    materialName: null,
    materialDisplayId: null,
    measure: null,
    blockSize: null,
    rate,
    active: true,
    version: 1,
    ...extra,
  } as PricingRule;
}

function group(groupId: string, name: string, isDefault: boolean, rules: PricingRule[]): PricingGroup {
  return {
    id: groupId,
    name,
    description: isDefault ? 'HTU members and supervisors' : 'Institutes, companies, associations',
    active: true,
    isDefault,
    rules,
    version: 1,
    createdAt: at(1),
    updatedAt: at(1),
  };
}

function article(
  articleId: string,
  displayId: string,
  name: string,
  extra: Partial<Material> & Pick<Material, 'unit' | 'machineUse' | 'materialTypeId' | 'materialTypeName'>,
) {
  return {
    id: articleId,
    displayId,
    name,
    kind: extra.machineUse ? 'filament' : 'part',
    materialTypeCode: extra.machineUse ? 'PLA' : 'FAST',
    variant: null,
    manufacturer: null,
    packageSize: null,
    storageLocation: null,
    notes: null,
    colorName: null,
    colorHex: null,
    active: true,
    lowStockThreshold: null,
    quantity: '500',
    assignedQuantity: '0',
    unassignedQuantity: '500',
    filamentDiameterMm: null,
    averageUnitCost: '0.02',
    inventoryValue: '10.00',
    stockState: 'in_stock',
    inventoryVersion: 1,
    recentConsumption: '0',
    prices: [],
    attention: [],
    version: 1,
    createdAt: at(1),
    updatedAt: at(1),
    ...extra,
  } as Material;
}

function item(
  n: number,
  kind: OrderItem['kind'],
  description: string,
  quantity: string,
  unitPrice: string,
  amount: string,
) {
  return {
    id: id(200 + n),
    position: n,
    kind,
    description,
    quantity,
    unit: kind === 'machine_job' ? 'job' : kind === 'inventory_item' ? 'piece' : 'piece',
    unitPrice,
    amount,
    sourceChanged: false,
    createdAt: at(20),
  } as OrderItem;
}

function order(orderId: string, reference: string, overrides: Partial<Order>): Order {
  return {
    id: orderId,
    reference,
    status: 'finalized',
    currency: 'EUR',
    customerKind: 'organization',
    customer: { kind: 'organization', id: ids.institute },
    customerName: 'Institute of Design',
    fulfillmentMode: 'immediate',
    totalAmount: '0.00',
    netCharge: '0.00',
    settledAmount: '0.00',
    outstandingAmount: '0.00',
    settlementState: 'unpaid',
    replacesOrderId: null,
    replacesOrderReference: null,
    replacedByOrderId: null,
    replacedByOrderReference: null,
    activeExternalRequestId: null,
    activeExternalRequestReference: null,
    activeExternalRequestState: null,
    latestExternalRequestId: null,
    latestExternalRequestReference: null,
    latestExternalRequestState: null,
    items: [],
    allocations: [],
    adjustments: [],
    attention: [],
    version: 1,
    createdAt: at(20),
    updatedAt: at(20),
    createdBy: { id: id(90), displayName: 'Lena Hofer' },
    ...overrides,
  };
}

export type SalesWorld = ReturnType<typeof createSalesWorld>;

export function createSalesWorld(permissions: string[] = salesPermissions) {
  const plaRule = rule(3, ids.members, 'material', '0.025', {
    materialTypeId: ids.pla,
    materialTypeName: 'PLA',
    materialUnit: 'g',
  });
  const insertRule = rule(4, ids.members, 'stock_article', '0.12', {
    materialId: ids.insert,
    materialName: 'M3 heat-set insert',
    materialDisplayId: 'A-0010',
    materialUnit: 'piece',
  });
  const groups = [
    group(ids.members, 'Members', true, [
      rule(1, ids.members, 'machine_runtime', '2.00', { processId: ids.fdm }),
      plaRule,
      insertRule,
    ]),
    group(ids.external, 'External', false, [rule(2, ids.external, 'machine_runtime', '4.00', { processId: ids.fdm })]),
  ];
  const materials = [
    article(ids.plaBlack, 'A-0001', 'Prusament PLA Galaxy Black', {
      unit: 'g',
      machineUse: true,
      materialTypeId: ids.pla,
      materialTypeName: 'PLA',
      prices: [
        {
          pricingGroupId: ids.members,
          pricingGroupName: 'Members',
          rate: '0.025',
          source: 'material_type',
          pricingRuleId: plaRule.id,
        },
      ],
    }),
    article(id(17), 'A-0020', 'Acrylic sheet 3 mm', {
      unit: 'piece',
      machineUse: false,
      materialTypeId: ids.fasteners,
      materialTypeName: 'Sheets',
    }),
    article(ids.insert, 'A-0010', 'M3 heat-set insert', {
      unit: 'piece',
      machineUse: false,
      materialTypeId: ids.fasteners,
      materialTypeName: 'Fasteners',
      prices: [
        {
          pricingGroupId: ids.members,
          pricingGroupName: 'Members',
          rate: '0.12',
          source: 'stock_article',
          pricingRuleId: insertRule.id,
        },
      ],
    }),
  ];
  const cash: OrderPayment = {
    id: ids.cashPayment,
    reference: 'P-2026-000210',
    entryKind: 'receipt',
    method: 'cash',
    amount: '8.60',
    occurredAt: at(31, 11),
    recordedAt: at(31, 11),
    reversesPaymentId: null,
    reversedPaymentReference: null,
    reasonKind: null,
    reason: '',
    externalSource: '',
    externalReference: '',
    allocations: [],
    recordedBy: { id: id(90), displayName: 'Lena Hofer' },
  };
  const orders: Order[] = [
    order(ids.draft, 'O-2026-000105', {
      status: 'draft',
      fulfillmentMode: 'deferred',
      totalAmount: '39.90',
      netCharge: '39.90',
      outstandingAmount: '39.90',
      items: [
        item(1, 'machine_job', 'J-2026-000416 · Gearbox housing', '1', '24.90', '24.90'),
        item(2, 'manual', 'Workshop fee · laser course', '1', '15.00', '15.00'),
      ],
      createdAt: at(30, 13),
      updatedAt: at(30, 13),
    }),
    order(ids.open, 'O-2026-000104', {
      customerKind: 'person',
      customer: { kind: 'person', id: ids.sara },
      customerName: 'Sara Novak',
      totalAmount: '19.30',
      netCharge: '19.30',
      outstandingAmount: '19.30',
      items: [
        item(3, 'machine_job', 'J-2026-000415 · Hoodie logo embroidery', '1', '18.40', '18.40'),
        { ...item(4, 'inventory_item', 'Stabilizer tear-away', '1', '0.90', '0.90'), sourceMaterialId: ids.insert },
      ],
      attention: [{ code: 'balance_overdue', message: 'The balance has been open for more than 14 days.' }],
      createdAt: at(10, 16),
      updatedAt: at(10, 16),
    }),
    order(ids.paid, 'O-2026-000103', {
      customerKind: 'person',
      customer: { kind: 'person', id: ids.sara },
      customerName: 'Sara Novak',
      totalAmount: '8.60',
      netCharge: '8.60',
      settledAmount: '8.60',
      settlementState: 'paid',
      items: [
        item(5, 'machine_job', 'J-2026-000412 · Phone stand', '1', '6.20', '6.20'),
        {
          ...item(6, 'inventory_item', 'M3 heat-set insert', '20', '0.12', '2.40'),
          sourceMaterialId: ids.insert,
        },
      ],
      allocations: [
        {
          id: id(300),
          paymentId: ids.cashPayment,
          paymentReference: cash.reference,
          orderId: ids.paid,
          orderReference: 'O-2026-000103',
          amount: '8.60',
          operationId: id(301),
          createdAt: at(31, 11),
        },
      ],
      createdAt: at(31, 11),
      updatedAt: at(31, 11),
    }),
    order(ids.invoiced, 'O-2026-000100', {
      customerName: 'TU Graz Racing',
      totalAmount: '31.60',
      netCharge: '31.60',
      outstandingAmount: '31.60',
      items: [item(7, 'machine_job', 'J-2026-000410 · Drone arms', '1', '31.60', '31.60')],
      activeExternalRequestId: ids.request,
      activeExternalRequestReference: 'W-2026-000012',
      activeExternalRequestState: 'submitted',
      latestExternalRequestId: ids.request,
      latestExternalRequestReference: 'W-2026-000012',
      latestExternalRequestState: 'submitted',
      attention: [{ code: 'invoice_request_open', message: 'The invoice request W-2026-000012 awaits approval.' }],
      createdAt: at(30, 9),
      updatedAt: at(31, 10),
    }),
  ];
  const request: ExternalInvoiceRequest = {
    id: ids.request,
    reference: 'W-2026-000012',
    orderId: ids.invoiced,
    orderReference: 'O-2026-000100',
    provider: 'wiref',
    state: 'submitted',
    currency: 'EUR',
    requestedAmount: '31.60',
    alreadyPaid: '0.00',
    details: {
      recipientName: 'TU Graz Racing',
      addressLine1: 'Inffeldgasse 25',
      postalCode: '8010',
      locality: 'Graz',
      countryCode: 'AT',
      contactName: 'Paul Egger',
      serviceStartsOn: '2026-10-29',
      serviceEndsOn: '2026-10-30',
      serviceDescription: 'Drone arms, 3D printing',
    },
    requirePurchaseOrderReference: false,
    requirementsVersion: 1,
    itemSummary: [],
    events: [],
    supersedesRequestId: null,
    version: 2,
    createdAt: at(30, 15),
  } as ExternalInvoiceRequest;
  const readyJob = {
    kind: 'job',
    id: ids.readyJob,
    displayId: 'J-2026-000421',
    title: 'Bracket set',
    fileName: null,
    runCount: 1,
    machineId: id(400),
    machineName: 'Prusa CORE One',
    customer: {
      kind: 'organization',
      id: ids.institute,
      displayName: 'Institute of Design',
      pricingGroupAssignmentVersion: 1,
    },
    operator: null,
    status: 'finished',
    source: 'manual',
    startedAt: at(29, 9),
    endsAt: at(29, 12),
    effectivePrice: '12.40',
    billing: { state: 'not_on_order' },
    attention: [],
    version: 3,
  } as unknown as WorkItem;
  return {
    permissions,
    groups,
    materials,
    orders,
    payments: [cash],
    request,
    readyJobs: [readyJob],
    requests: [] as { method: string; path: string; body: unknown }[],
    unhandled: [] as string[],
  };
}

function ok(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}
const pageOf = <T>(items: T[]) => ({ items, page: 1, pageSize: 100, total: items.length });

function currentUser(permissions: string[]) {
  const account = {
    id: id(91),
    personId: id(90),
    loginEmail: 'lena.login@example.test',
    provisioningSource: 'local',
    firstAuthenticatedAt: at(1),
    authIdentities: [],
    status: 'enabled',
    passwordStatus: 'active',
    createdAt: at(1),
    updatedAt: at(1),
    version: 1,
  };
  return {
    person: {
      id: id(90),
      firstName: 'Lena',
      lastName: 'Hofer',
      email: 'lena@example.test',
      phone: null,
      roles: [],
      account,
      createdAt: at(1),
      updatedAt: at(1),
      version: 1,
    },
    account,
    permissions,
    authenticationAssurance: 'normal',
    authentication: {
      method: 'password',
      assurance: 'normal',
      authenticatedAt: at(1),
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
    delegablePermissionGrants: [],
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

const sumAmounts = (items: OrderItem[]) =>
  items
    .filter((entry) => !entry.removedAt)
    .reduce((total, entry) => total + Math.round(Number(entry.amount) * 100), 0) / 100;

export async function installSalesApi(page: Page, world: SalesWorld = createSalesWorld()): Promise<SalesWorld> {
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = method === 'GET' ? undefined : (request.postDataJSON() as Record<string, unknown> | undefined);
    if (method !== 'GET') world.requests.push({ method, path, body });
    let match: RegExpMatchArray | null;

    if (path === '/api/v1/auth/me') return ok(route, currentUser(world.permissions));
    if (path === '/api/v1/auth/activity') return ok(route, currentUser(world.permissions).session);
    if (path === '/api/v1/notifications/unread-count') return ok(route, { unreadCount: 0 });
    if (path === '/api/v1/laborordnung/status/me') return ok(route, currentUser(world.permissions).laborordnungStatus);
    if (path === '/api/v1/public/config') return ok(route, defaultPublicBrandingConfiguration());
    if (path === '/api/v1/public/open-days') return ok(route, { items: [] });
    if (path === '/api/v1/auth/oidc/providers') return ok(route, { items: [] });

    // Orders
    if (path === '/api/v1/orders' && method === 'GET') return ok(route, pageOf(world.orders));
    if ((match = path.match(/^\/api\/v1\/orders\/([^/]+)$/))) {
      const found = world.orders.find((entry) => entry.id === match![1]);
      return found ? ok(route, found) : ok(route, { code: 'not_found', message: 'Not found' }, 404);
    }
    if ((match = path.match(/^\/api\/v1\/orders\/([^/]+)\/items$/)) && method === 'POST') {
      const found = world.orders.find((entry) => entry.id === match![1])!;
      const input = body ?? {};
      if (input.kind === 'inventory_item') {
        const sold = world.materials.find((entry) => entry.id === input.materialId)!;
        const groupPrice = sold.prices.find((price) => price.pricingGroupId === world.groups[0].id);
        const unitPrice = (input.unitPrice as string | undefined) ?? groupPrice?.rate;
        if (!unitPrice)
          return ok(
            route,
            {
              code: 'article_price_missing',
              message: "The article has no price in the customer's pricing group",
              details: { pricingGroup: 'Members' },
            },
            422,
          );
        const amount = (Math.round(Number(input.quantity) * Number(unitPrice) * 100) / 100).toFixed(2);
        found.items.push({
          ...item(found.items.length + 50, 'inventory_item', sold.name, String(input.quantity), unitPrice, amount),
          unit: sold.unit,
          sourceMaterialId: sold.id,
        });
      } else if (input.kind === 'machine_job') {
        const job = world.readyJobs.find((entry) => entry.id === input.machineJobId)!;
        found.items.push(
          item(found.items.length + 50, 'machine_job', `${job.displayId} · ${job.title}`, '1', '12.40', '12.40'),
        );
        world.readyJobs = world.readyJobs.filter((entry) => entry.id !== job.id);
      } else {
        const amount = (Math.round(Number(input.quantity) * Number(input.unitPrice) * 100) / 100).toFixed(2);
        found.items.push({
          ...item(
            found.items.length + 50,
            'manual',
            String(input.description),
            String(input.quantity),
            String(input.unitPrice),
            amount,
          ),
          unit: String(input.unit),
        });
      }
      const total = sumAmounts(found.items).toFixed(2);
      Object.assign(found, {
        totalAmount: total,
        netCharge: total,
        outstandingAmount: total,
        version: found.version + 1,
      });
      return ok(route, found, 201);
    }

    // Payments, register, invoice requests
    if ((match = path.match(/^\/api\/v1\/payments\/([^/]+)$/)) && match[1] !== 'cash-register') {
      const found = world.payments.find((entry) => entry.id === match![1]);
      return found ? ok(route, found) : ok(route, { code: 'not_found', message: 'Not found' }, 404);
    }
    if (path === '/api/v1/payments') return ok(route, pageOf(world.payments));
    if (path === '/api/v1/payments/cash-register')
      return ok(route, {
        expected: '85.70',
        receipts: '115.70',
        refunds: '0.00',
        withdrawals: '80.00',
        deposits: '50.00',
      });
    if (path === '/api/v1/cash-movements') return ok(route, pageOf([]));
    if (path === '/api/v1/external-invoice-requests') return ok(route, pageOf([world.request]));
    if (path === `/api/v1/external-invoice-requests/${world.request.id}`) return ok(route, world.request);
    if ((match = path.match(/^\/api\/v1\/organizations\/([^/]+)\/invoicing-requirements$/)))
      return ok(route, { organizationId: match[1], requirePurchaseOrderReference: false, version: 1 });

    // Jobs and customers
    if (path === '/api/v1/machine-logbook/work-items') {
      const customerId = url.searchParams.get('customerId');
      const jobs = world.readyJobs.filter((job) => !customerId || job.customer?.id === customerId);
      return ok(route, pageOf(jobs));
    }
    if (path === '/api/v1/billing-parties')
      return ok(route, {
        items: [
          {
            kind: 'organization',
            id: ids.institute,
            displayName: 'Institute of Design',
            pricingGroup: { id: ids.members, name: 'Members' },
            pricingGroupAssignmentVersion: 1,
          },
          { kind: 'person', id: ids.sara, displayName: 'Sara Novak', pricingGroupAssignmentVersion: 0 },
        ],
      });

    // Pricing and inventory
    if (path === '/api/v1/pricing-groups' && method === 'GET') return ok(route, { items: world.groups });
    if (path === '/api/v1/pricing-role-groups') return ok(route, { items: [] });
    if (path === '/api/v1/roles') return ok(route, { items: [], nextCursor: null });
    if (path === '/api/v1/organizations') return ok(route, pageOf([]));
    if ((match = path.match(/^\/api\/v1\/pricing-groups\/([^/]+)\/rules$/)) && method === 'POST') {
      const target = world.groups.find((entry) => entry.id === match![1])!;
      const created = rule(target.rules.length + 50, target.id, body!.kind as PricingRule['kind'], String(body!.rate), {
        processId: (body!.processId as string | null) ?? null,
        materialTypeId: (body!.materialTypeId as string | null) ?? null,
        materialId: (body!.materialId as string | null) ?? null,
      });
      target.rules.push(created);
      return ok(route, created, 201);
    }
    if ((match = path.match(/^\/api\/v1\/pricing-rules\/([^/]+)$/)) && method === 'PATCH') {
      for (const entry of world.groups) {
        const found = entry.rules.find((candidate) => candidate.id === match![1]);
        if (found) {
          Object.assign(found, { rate: body!.rate, active: body!.active, version: found.version + 1 });
          return ok(route, found);
        }
      }
    }
    if (path === '/api/v1/processes')
      return ok(route, {
        items: [
          {
            id: ids.fdm,
            name: 'FDM printing',
            active: true,
            integration: 'none',
            measures: [],
            version: 1,
            createdAt: at(1),
            updatedAt: at(1),
          },
        ],
      });
    if (path === '/api/v1/material-types')
      return ok(route, {
        items: [
          { id: ids.pla, name: 'PLA', code: 'PLA', machineUse: true, unit: 'g', active: true, version: 1 },
          {
            id: ids.fasteners,
            name: 'Fasteners',
            code: 'FAST',
            machineUse: false,
            unit: 'piece',
            active: true,
            version: 1,
          },
        ],
      });
    if (path === '/api/v1/materials') return ok(route, { ...pageOf(world.materials), totalInventoryValue: '20.00' });
    if (path === '/api/v1/machines') return ok(route, pageOf([]));
    if (path === '/api/v1/pricing/quote')
      return ok(route, { machine: null, material: null, hours: null, quantity: null, groups: [] });

    world.unhandled.push(`${method} ${path}${url.search}`);
    return route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'unhandled_in_e2e_mock', message: `${method} ${path}` }),
    });
  });
  return world;
}

export const salesIds = ids;
