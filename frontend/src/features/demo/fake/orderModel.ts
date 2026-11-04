import type {
  MachineJob,
  Order,
  OrderAllocation,
  OrderItem,
  OrderItemInput,
  OrderPayment,
  PaymentInput,
} from '../../../api/generated/models';
import { chargeSnapshot } from './chargeSnapshot';
import { billingParty, decimal, money, nextId, nextReference, personName, toCents, type DemoStore } from './store';

const SAMPLE_ORDERS = 2;
const SAMPLE_PAYMENTS = 1;

export const actorOf = (store: DemoStore) => ({
  id: store.user.person.id,
  displayName: personName(store.user.person),
});

/** Totals, settlement and the version of an order, derived from its items and allocations. */
export function recalculateOrder(store: DemoStore, order: Order): Order {
  const total = order.items.filter((item) => !item.removedAt).reduce((sum, item) => sum + toCents(item.amount), 0);
  const adjustments = order.adjustments.reduce((sum, item) => sum + toCents(item.amount), 0);
  const settled = order.allocations.reduce((sum, item) => sum + toCents(item.amount), 0);
  order.totalAmount = money(total);
  order.netCharge = money(total + adjustments);
  order.settledAmount = money(settled);
  order.outstandingAmount = money(Math.max(0, total + adjustments - settled));
  order.settlementState =
    total + adjustments === 0
      ? 'no_payment_due'
      : settled <= 0
        ? 'unpaid'
        : settled >= total + adjustments
          ? 'paid'
          : 'partially_paid';
  order.attention = [];
  order.version += 1;
  order.updatedAt = store.now.toISOString();
  return order;
}

export function newOrder(
  store: DemoStore,
  customer: { kind: 'person' | 'organization'; id: string } | null,
  fulfillmentMode: Order['fulfillmentMode'],
): Order {
  const party = customer ? billingParty(store, customer.kind, customer.id) : undefined;
  return {
    id: nextId(store),
    reference: nextReference(store, 'ORD', SAMPLE_ORDERS),
    status: 'draft',
    currency: 'EUR',
    customerKind: party ? party.kind : 'anonymous',
    customer: party ? { kind: party.kind, id: party.id } : null,
    customerName: party?.displayName ?? null,
    fulfillmentMode,
    totalAmount: '0.00',
    netCharge: '0.00',
    settledAmount: '0.00',
    outstandingAmount: '0.00',
    settlementState: 'no_payment_due',
    replacesOrderId: null,
    replacesOrderReference: null,
    items: [],
    allocations: [],
    adjustments: [],
    version: 1,
    createdAt: store.now.toISOString(),
    updatedAt: store.now.toISOString(),
    createdBy: actorOf(store),
    attention: [],
  };
}

/** Builds an order line from the request; `undefined` when it refers to something that does not exist. */
export function buildOrderItem(store: DemoStore, order: Order, input: OrderItemInput): OrderItem | undefined {
  const base = {
    id: nextId(store),
    position: order.items.length + 1,
    sourceChanged: false,
    createdAt: store.now.toISOString(),
  };
  if (input.kind === 'machine_job') {
    const job: MachineJob | undefined = store.jobs.find((item) => item.id === input.machineJobId);
    if (!job) return undefined;
    const amount = job.effectivePrice ?? '0.00';
    return {
      ...base,
      kind: 'machine_job',
      description: `${job.displayId} · ${job.title ?? job.machine.name}`,
      quantity: '1',
      unit: 'job',
      unitPrice: amount,
      amount,
      sourceMachineJobId: job.id,
      sourceJobVersion: job.version,
      snapshot: chargeSnapshot(store, job),
    };
  }
  const quantity = Number(input.quantity ?? 1);
  if (input.kind === 'inventory_item') {
    const material = store.materials.find((item) => item.id === input.materialId);
    if (!material) return undefined;
    const unitPrice = input.unitPrice ?? material.prices[0]?.rate ?? '0.00';
    return {
      ...base,
      kind: 'inventory_item',
      description: input.description || material.name,
      quantity: decimal(quantity),
      unit: material.unit,
      unitPrice,
      amount: money(Math.round(quantity * toCents(unitPrice))),
      sourceMaterialId: material.id,
    };
  }
  const unitPrice = input.unitPrice ?? '0.00';
  return {
    ...base,
    kind: 'manual',
    description: input.description ?? 'Item',
    quantity: decimal(quantity),
    unit: input.unit ?? 'pc',
    unitPrice,
    amount: money(Math.round(quantity * toCents(unitPrice))),
  };
}

export function recordPayment(
  store: DemoStore,
  order: Order,
  input: PaymentInput,
  reference = nextReference(store, 'PAY', SAMPLE_PAYMENTS),
): OrderPayment {
  const id = nextId(store);
  // A payment never settles more than the order still owes.
  const cents = Math.min(toCents(input.amount), toCents(order.outstandingAmount));
  const allocation: OrderAllocation = {
    id: nextId(store),
    paymentId: id,
    paymentReference: reference,
    orderId: order.id,
    orderReference: order.reference,
    amount: money(cents),
    operationId: nextId(store),
    createdAt: store.now.toISOString(),
  };
  const payment: OrderPayment = {
    id,
    reference,
    entryKind: 'receipt',
    method: input.method,
    amount: money(cents),
    occurredAt: input.occurredAt,
    recordedAt: store.now.toISOString(),
    reversesPaymentId: null,
    reversedPaymentReference: null,
    reasonKind: null,
    reason: '',
    externalSource: input.externalSource ?? '',
    externalReference: input.externalReference ?? '',
    allocations: [allocation],
    recordedBy: actorOf(store),
  };
  order.allocations.push(allocation);
  store.payments.push(payment);
  return payment;
}
