import { effectivePrice, jobName, outcomeLabel } from '../derived';
import type { BillingParty, Job, Machine, MachineType, Print } from '../types';
import { addCalendarDays } from '../../../app/dateTime';
import { dateInAppTimeZone, formatDate, formatEur, round2 } from './format';
import { activeItems, activeReceipts, allocationSum, cashDayFigures, isCashDayClosed, jobBlocker, orderMoney, requestReadiness, sum } from './logic';
import type {
  Allocation, CustomerRecord, DaySession, FulfillmentMode, InvoiceEventKind, InvoiceRequest, InvoiceRequestDetails, JobChargeSnapshot, Order, OrderAdjustment, OrderEventKind, OrderItem, Payment, PaymentInput,
  ReconciliationKind, ReversalInput, SalesCounters,
} from './types';
import { methodLabel } from './labels';
import { ruleKey, type PricingConfig, type PricingGroup, type RateRule } from './pricing';

// Pure state transitions of the sales domain. They enforce the backend rules (docs/orders.md) and throw a SalesError that
// names the rule, so a UI that fails to pre-validate still shows a readable message. Nothing is applied when one throws:
// every transition works on a copy, the way the backend commits a mutation and its audit event in one transaction.

export type SalesState = {
  orders: Order[]; payments: Payment[]; allocations: Allocation[]; adjustments: OrderAdjustment[]; requests: InvoiceRequest[]; jobs: Job[]; counters: SalesCounters;
  customers: CustomerRecord[]; daySessions: DaySession[]; pricing: PricingConfig;
};
export type Ctx = { at: string; actor: string; machines: Machine[]; machineTypes: MachineType[]; prints: Print[] };

export class SalesError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
const fail = (code: string, message: string): never => { throw new SalesError(code, message); };

// A counter, not random: the seed replays identically on every page load, so links to seeded orders keep working after a reload.
let sequence = 0;
const uid = (prefix: string) => `${prefix}-${(++sequence).toString(36).padStart(4, '0')}`;
const reference = (letter: string, number: number, at: string) => `${letter}-${new Date(at).getUTCFullYear()}-${String(number).padStart(6, '0')}`;

function transition<T>(state: SalesState, fn: (s: SalesState) => T): { state: SalesState } & T {
  const s = structuredClone(state);
  return { state: s, ...fn(s) };
}
const orderOf = (s: SalesState, id: string) => s.orders.find((order) => order.id === id) ?? fail('not_found', 'The order does not exist');
const money = (s: SalesState, order: Order) => orderMoney(order, s.allocations, s.adjustments);

function note(order: Order, c: Ctx, kind: OrderEventKind, text: string) {
  order.events.push({ id: uid('ev'), at: c.at, actor: c.actor, kind, text });
  order.updatedAt = c.at;
  order.version += 1;
}
function requireDraft(order: Order) {
  if (order.status !== 'draft') fail('order_not_draft', `${order.reference} is no longer a draft and cannot be edited`);
}

// Items ----------------------------------------------------------------------------------------------------------------

export function snapshotOf(job: Job, c: Ctx): JobChargeSnapshot {
  const machine = c.machines.find((item) => item.id === job.machineId);
  return {
    displayId: job.displayId, machineName: machine?.name ?? 'Unknown machine', machineTypeName: c.machineTypes.find((type) => type.id === machine?.machineTypeId)?.name ?? '',
    startsAt: job.startsAt, endsAt: job.endsAt, durationSeconds: job.durationSeconds, outcome: outcomeLabel(job.outcome),
    usages: job.usages.map((usage) => ({ materialName: usage.materialName, unit: usage.unit, quantity: usage.quantity, ownership: usage.ownership })),
    pricingGroupName: job.pricingSnapshot?.pricingGroupName ?? job.customer?.pricingGroup ?? '', calculatedAmount: job.calculatedPrice,
    effectiveAmount: effectivePrice(job) ?? 0, overrideReason: job.priceAdjustment?.reason ?? null, capturedAt: c.at,
  };
}

function itemFromJob(job: Job, c: Ctx, position: number): OrderItem {
  const amount = effectivePrice(job) ?? 0;
  return {
    id: uid('it'), position, kind: 'machine_job', description: jobName(job, c.prints.find((print) => print.id === job.printId)), quantity: 1, unit: 'job', unitPrice: amount, amount,
    sourceJobId: job.id, sourceJobVersion: job.version, snapshot: snapshotOf(job, c), catalogItemId: null, createdAt: c.at, removedAt: null,
  };
}

function assertChargeable(s: SalesState, c: Ctx, order: Order, job: Job) {
  if ((job.customer?.id ?? null) !== (order.customer?.id ?? null)) fail('customer_mismatch', `${job.displayId} belongs to another customer than ${order.reference}`);
  const blocker = jobBlocker(job, c.prints, new Date(c.at).getTime());
  if (blocker) fail('job_not_chargeable', `${job.displayId} cannot be charged yet: ${blocker.charAt(0).toLowerCase()}${blocker.slice(1)}`);
  if (job.order && job.order.orderId !== order.id && job.order.orderId !== order.replacesOrderId) fail('job_already_ordered', `${job.displayId} is already on order ${job.order.orderReference}`);
  if (activeItems(order).some((item) => item.sourceJobId === job.id)) fail('job_already_added', `${job.displayId} is already on this order`);
  void s;
}

export type ManualItemInput = { description: string; quantity: number; unit: string; unitPrice: number; catalogItemId?: string | null };
function manualItem(input: ManualItemInput, c: Ctx, position: number): OrderItem {
  const description = input.description.trim();
  if (!description) fail('validation', 'Describe the item');
  if (!(input.quantity > 0)) fail('validation', 'The quantity must be greater than zero');
  if (!(input.unitPrice >= 0)) fail('validation', 'The unit price cannot be negative');
  return {
    id: uid('it'), position, kind: 'manual', description, quantity: input.quantity, unit: input.unit.trim() || 'piece', unitPrice: input.unitPrice, amount: round2(input.quantity * input.unitPrice),
    sourceJobId: null, sourceJobVersion: null, snapshot: null, catalogItemId: input.catalogItemId ?? null, createdAt: c.at, removedAt: null,
  };
}

// Draft lifecycle ------------------------------------------------------------------------------------------------------

export type DraftInput = { customer: BillingParty | null; fulfillmentMode: FulfillmentMode };

function newDraft(s: SalesState, c: Ctx, input: DraftInput, replacesOrderId: string | null = null): Order {
  if (!input.customer && input.fulfillmentMode === 'deferred') fail('anonymous_requires_full_settlement', 'Picking up later needs a named customer');
  s.counters.order += 1;
  const order: Order = {
    id: uid('ord'), reference: reference('O', s.counters.order, c.at), status: 'draft', customer: input.customer ? { kind: input.customer.kind, id: input.customer.id } : null,
    customerName: input.customer?.displayName ?? null, fulfillmentMode: input.fulfillmentMode, items: [], replacesOrderId, version: 1, createdAt: c.at, updatedAt: c.at, createdBy: c.actor, events: [],
  };
  order.events.push({ id: uid('ev'), at: c.at, actor: c.actor, kind: 'created', text: replacesOrderId ? 'Replacement draft created' : 'Draft created' });
  s.orders.unshift(order);
  return order;
}

export const createDraft = (state: SalesState, c: Ctx, input: DraftInput) => transition(state, (s) => ({ orderId: newDraft(s, c, input).id }));

export function updateDraft(state: SalesState, c: Ctx, orderId: string, input: DraftInput) {
  return transition(state, (s) => {
    const order = orderOf(s, orderId);
    requireDraft(order);
    if (!input.customer && input.fulfillmentMode === 'deferred') fail('anonymous_requires_full_settlement', 'Picking up later needs a named customer');
    const blocking = activeItems(order).filter((item) => item.sourceJobId && (s.jobs.find((job) => job.id === item.sourceJobId)?.customer?.id ?? null) !== (input.customer?.id ?? null));
    if (blocking.length) fail('customer_mismatch', `Remove ${blocking.map((item) => item.snapshot?.displayId ?? item.description).join(', ')} first: ${blocking.length === 1 ? 'that job belongs' : 'those jobs belong'} to another customer`);
    order.customer = input.customer ? { kind: input.customer.kind, id: input.customer.id } : null;
    order.customerName = input.customer?.displayName ?? null;
    order.fulfillmentMode = input.fulfillmentMode;
    note(order, c, 'edited', input.customer ? `Customer set to ${input.customer.displayName}` : 'Customer removed (walk-in sale)');
    return {};
  });
}

export function addManualItem(state: SalesState, c: Ctx, orderId: string, input: ManualItemInput) {
  return transition(state, (s) => {
    const order = orderOf(s, orderId);
    requireDraft(order);
    const item = manualItem(input, c, order.items.length + 1);
    order.items.push(item);
    note(order, c, 'item_added', `Added “${item.description}” · ${formatEur(item.amount)}`);
    return {};
  });
}

export function addJobItems(state: SalesState, c: Ctx, orderId: string, jobIds: string[]) {
  return transition(state, (s) => {
    const order = orderOf(s, orderId);
    requireDraft(order);
    for (const id of jobIds) {
      const job = s.jobs.find((candidate) => candidate.id === id) ?? fail('not_found', 'The job does not exist');
      assertChargeable(s, c, order, job);
      const item = itemFromJob(job, c, order.items.length + 1);
      order.items.push(item);
      note(order, c, 'item_added', `Added job ${job.displayId} · ${formatEur(item.amount)}`);
    }
    return {};
  });
}

export function updateManualItem(state: SalesState, c: Ctx, orderId: string, itemId: string, input: ManualItemInput) {
  return transition(state, (s) => {
    const order = orderOf(s, orderId);
    requireDraft(order);
    const index = order.items.findIndex((item) => item.id === itemId && item.removedAt === null);
    const old = order.items[index];
    if (!old || old.kind !== 'manual') return fail('validation', 'Only manual items can be edited');
    // A changed item is a new row; the old one stays as history, like the backend.
    const next = { ...manualItem(input, c, old.position), catalogItemId: old.catalogItemId };
    old.removedAt = c.at;
    order.items.push(next);
    note(order, c, 'item_added', `Changed “${next.description}” to ${formatEur(next.amount)}`);
    return {};
  });
}

export function removeItem(state: SalesState, c: Ctx, orderId: string, itemId: string) {
  return transition(state, (s) => {
    const order = orderOf(s, orderId);
    requireDraft(order);
    const item = order.items.find((candidate) => candidate.id === itemId && candidate.removedAt === null) ?? fail('not_found', 'The item does not exist');
    item.removedAt = c.at;
    note(order, c, 'item_removed', `Removed “${item.description}”`);
    return {};
  });
}

export function refreshItem(state: SalesState, c: Ctx, orderId: string, itemId: string) {
  return transition(state, (s) => {
    const order = orderOf(s, orderId);
    requireDraft(order);
    const item = order.items.find((candidate) => candidate.id === itemId && candidate.removedAt === null && candidate.sourceJobId) ?? fail('not_found', 'The item does not exist');
    const job = s.jobs.find((candidate) => candidate.id === item.sourceJobId) ?? fail('source_unavailable', 'The job no longer exists');
    const next = itemFromJob(job, c, item.position);
    item.removedAt = c.at;
    order.items.push(next);
    note(order, c, 'item_refreshed', `Refreshed ${job.displayId} to ${formatEur(next.amount)}`);
    return {};
  });
}

export function cancelDraft(state: SalesState, c: Ctx, orderId: string) {
  return transition(state, (s) => {
    const order = orderOf(s, orderId);
    requireDraft(order);
    order.status = 'cancelled';
    note(order, c, 'cancelled', 'Draft cancelled');
    return {};
  });
}

function finalizeIn(s: SalesState, c: Ctx, order: Order, committingReplacement = false) {
  requireDraft(order);
  if (order.replacesOrderId && !committingReplacement) fail('replacement_commit_required', 'Commit a replacement through the order it replaces');
  const items = activeItems(order);
  if (items.length === 0) fail('validation', 'An order needs at least one item');
  if (!order.customer && order.fulfillmentMode !== 'immediate') fail('anonymous_requires_full_settlement', 'A walk-in sale must be handed over immediately');
  for (const item of items) {
    if (!item.sourceJobId) continue;
    const job = s.jobs.find((candidate) => candidate.id === item.sourceJobId) ?? fail('source_unavailable', 'A job of this order no longer exists');
    if (job.version !== item.sourceJobVersion) fail('source_snapshot_stale', `${job.displayId} changed since it was added: refresh it first`);
    if (job.order && job.order.orderId !== order.id) fail('job_already_ordered', `${job.displayId} is already on order ${job.order.orderReference}`);
  }
  for (const item of items) {
    const job = item.sourceJobId ? s.jobs.find((candidate) => candidate.id === item.sourceJobId) : undefined;
    if (job) job.order = { orderId: order.id, orderReference: order.reference, sourceChanged: false };
  }
  order.status = 'finalized';
  note(order, c, 'finalized', `Finalized at ${formatEur(sum(items.map((item) => item.amount)))}`);
}

export const finalizeOrder = (state: SalesState, c: Ctx, orderId: string) => transition(state, (s) => { finalizeIn(s, c, orderOf(s, orderId)); return {}; });

// Payments -------------------------------------------------------------------------------------------------------------

const activeRequestOf = (s: SalesState, orderId: string) => s.requests.filter((request) => request.orderId === orderId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).find((request) => request.state !== 'cancelled');
const latestRequestOf = (s: SalesState, orderId: string) => s.requests.filter((request) => request.orderId === orderId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

function receiptIn(s: SalesState, c: Ctx, order: Order, input: PaymentInput, op: string) {
  if (order.status !== 'finalized') fail('order_not_finalized', 'Payments need a finalized order');
  if (!(input.amount > 0) || round2(input.amount) !== input.amount) fail('validation', 'Enter an amount greater than zero with at most two decimals');
  if (!input.occurredAt || Number.isNaN(new Date(input.occurredAt).getTime())) fail('validation', 'The payment time is required');
  if (input.method === 'cash' && isCashDayClosed(s.daySessions, input.occurredAt)) fail('day_closed', `The cash of ${formatDate(input.occurredAt)} is closed, so a cash payment cannot be booked on that day`);
  if (input.method === 'card') {
    if (!input.terminal.trim() || !input.transactionReference.trim()) fail('validation', 'Card payments need the terminal and its transaction reference');
    const duplicate = s.payments.find((payment) => payment.entryKind === 'receipt' && payment.method === 'card' && payment.transactionReference === input.transactionReference.trim()
      && !s.payments.some((other) => other.reversesPaymentId === payment.id));
    if (duplicate) fail('duplicate_transaction', `That transaction reference was already recorded as ${duplicate.reference}`);
  }
  const request = activeRequestOf(s, order.id);
  if (input.method === 'external') {
    if (request?.state !== 'issued') fail('external_reconciliation_required', 'A payment confirmed by wiRef needs an issued invoice');
    if (!input.transactionReference.trim()) fail('validation', 'The wiRef confirmation reference is required');
  } else if (request) fail('settlement_workflow_conflict', `${request.reference} is active, so cash and card payments cannot be recorded`);
  for (const existing of activeReceipts(s.payments, s.allocations, order.id)) {
    if ((existing.method === 'external') !== (input.method === 'external')) fail('settlement_workflow_conflict', 'Cash/card and wiRef-confirmed payments cannot be mixed on one order');
  }
  const outstanding = money(s, order).outstanding;
  if (input.amount > outstanding) fail('payment_exceeds_outstanding', `The payment exceeds the outstanding ${formatEur(outstanding)}`);
  s.counters.payment += 1;
  const payment: Payment = {
    id: uid('pay'), reference: reference('P', s.counters.payment, c.at), entryKind: 'receipt', method: input.method, amount: input.amount, occurredAt: input.occurredAt, recordedAt: c.at, recordedBy: c.actor,
    reversesPaymentId: null, reasonKind: null, reason: '', terminal: input.terminal.trim(), transactionReference: input.transactionReference.trim(),
  };
  s.payments.push(payment);
  s.allocations.push({ id: uid('al'), paymentId: payment.id, orderId: order.id, amount: input.amount, operationId: op, at: c.at });
  note(order, c, 'paid', `${methodLabel(input.method)} payment of ${formatEur(input.amount)} recorded (${payment.reference})`);
  return payment;
}

function assertFullySettledIfWalkIn(s: SalesState, order: Order) {
  if (!order.customer && order.status === 'finalized' && money(s, order).outstanding > 0) fail('anonymous_requires_full_settlement', 'A walk-in sale has to be paid in full');
}

export function recordPayments(state: SalesState, c: Ctx, orderId: string, inputs: PaymentInput[]) {
  return transition(state, (s) => {
    const order = orderOf(s, orderId);
    const op = uid('op');
    if (inputs.length === 0) fail('validation', 'Add at least one payment');
    for (const input of inputs) receiptIn(s, c, order, input, op);
    assertFullySettledIfWalkIn(s, order);
    return {};
  });
}

/** Finalizes a draft and records its payments in one step (walk-in checkout). */
export function checkoutOrder(state: SalesState, c: Ctx, orderId: string, inputs: PaymentInput[]) {
  return transition(state, (s) => {
    const order = orderOf(s, orderId);
    finalizeIn(s, c, order);
    const op = uid('op');
    for (const input of inputs) receiptIn(s, c, order, input, op);
    assertFullySettledIfWalkIn(s, order);
    return {};
  });
}

export function reverseReceiptIn(s: SalesState, c: Ctx, order: Order, input: ReversalInput, op: string) {
  const original = s.payments.find((payment) => payment.id === input.paymentId) ?? fail('not_found', 'The payment does not exist');
  if (original.entryKind !== 'receipt') fail('validation', 'Only original receipts can be reversed');
  if (s.payments.some((payment) => payment.reversesPaymentId === original.id)) fail('payment_already_reversed', `${original.reference} was already reversed`);
  if (!activeReceipts(s.payments, s.allocations, order.id).some((payment) => payment.id === original.id)) fail('payment_allocation_changed', `${original.reference} is no longer allocated to ${order.reference}`);
  const reason = input.reason.trim();
  if (!reason || reason.length > 500) fail('validation', 'Give a reason of up to 500 characters');
  if (original.method === 'external') {
    if (input.reasonKind !== 'external_correction' || !input.transactionReference.trim()) fail('validation', 'An accounting correction needs its external reference');
    if (latestRequestOf(s, order.id)?.state !== 'cancelled') fail('external_reconciliation_required', 'Cancel the wiRef request and record the external correction first');
  } else if (input.reasonKind !== 'refund' && input.reasonKind !== 'recording_error') fail('validation', 'Choose refund or recording error');
  if (original.method === 'card' && !input.transactionReference.trim()) fail('validation', 'A card refund or correction needs the terminal reference');
  const bookedAt = input.reasonKind === 'recording_error' ? original.occurredAt : input.occurredAt;
  if (!input.occurredAt || Number.isNaN(new Date(input.occurredAt).getTime())) fail('validation', 'The time of the refund or correction is required');
  if (original.method === 'cash' && isCashDayClosed(s.daySessions, bookedAt)) {
    fail('day_closed', input.reasonKind === 'recording_error'
      ? `The cash of ${formatDate(original.occurredAt)} is closed, so it cannot be corrected afterwards. Give the money back as a refund instead.`
      : `The cash of ${formatDate(input.occurredAt)} is closed. Book the refund at the time it really happens.`);
  }
  s.counters.payment += 1;
  const reversal: Payment = {
    id: uid('pay'), reference: reference('P', s.counters.payment, c.at), entryKind: 'reversal', method: original.method, amount: original.amount,
    // A recording error is undone at the original time; an actual refund happens when it happens.
    occurredAt: bookedAt, recordedAt: c.at, recordedBy: c.actor,
    reversesPaymentId: original.id, reasonKind: input.reasonKind, reason, terminal: original.terminal, transactionReference: input.transactionReference.trim(),
  };
  s.payments.push(reversal);
  s.allocations.push({ id: uid('al'), paymentId: reversal.id, orderId: order.id, amount: -original.amount, operationId: op, at: c.at });
  note(order, c, input.reasonKind === 'refund' ? 'refund' : 'correction', `${original.reference} ${input.reasonKind === 'refund' ? 'refunded' : 'corrected'} (${reversal.reference}): ${reason}`);
  return reversal;
}

/** Reverses one receipt. A walk-in order has to stay fully paid, so it needs a replacement receipt. */
export function reversePayment(state: SalesState, c: Ctx, input: ReversalInput, replacement?: PaymentInput) {
  return transition(state, (s) => {
    const payment = s.payments.find((item) => item.id === input.paymentId) ?? fail('not_found', 'The payment does not exist');
    const orderId = s.allocations.find((allocation) => allocation.paymentId === payment.id && allocationSum(s.allocations, allocation.orderId, payment.id) > 0)?.orderId ?? fail('payment_allocation_changed', 'The payment is not allocated to an order');
    const order = orderOf(s, orderId);
    if (order.status !== 'finalized') fail('order_not_finalized', 'The order is not finalized');
    const op = uid('op');
    reverseReceiptIn(s, c, order, input, op);
    if (replacement) receiptIn(s, c, order, replacement, op);
    assertFullySettledIfWalkIn(s, order);
    return {};
  });
}

// Reversal and replacement --------------------------------------------------------------------------------------------

function reverseIn(s: SalesState, c: Ctx, order: Order, reason: string) {
  if (order.status !== 'finalized') fail('order_not_finalized', 'Only finalized orders can be reversed');
  if (!reason.trim() || reason.trim().length > 500) fail('validation', 'Give a reason of up to 500 characters');
  const latest = latestRequestOf(s, order.id);
  if (latest && latest.state !== 'cancelled') fail('external_reconciliation_required', `Cancel or reconcile ${latest.reference} in wiRef first`);
  if (allocationSum(s.allocations, order.id) !== 0) fail('payment_reconciliation_required', 'Refund, correct or carry over all payments first');
  s.counters.adjustment += 1;
  s.adjustments.push({ id: uid('adj'), reference: reference('A', s.counters.adjustment, c.at), orderId: order.id, amount: money(s, order).total, reason: reason.trim(), at: c.at, by: c.actor });
  for (const job of s.jobs) if (job.order?.orderId === order.id) job.order = null;
  order.status = 'reversed';
  note(order, c, 'reversed', `Order reversed: ${reason.trim()}`);
}

export type ReverseOrderInput = { reason: string; reversals: ReversalInput[] };
export function reverseOrder(state: SalesState, c: Ctx, orderId: string, input: ReverseOrderInput) {
  return transition(state, (s) => {
    const order = orderOf(s, orderId);
    const op = uid('op');
    for (const reversal of input.reversals) reverseReceiptIn(s, c, order, reversal, op);
    reverseIn(s, c, order, input.reason);
    return {};
  });
}

/** Creates a draft that copies the active manual items and captures the current facts of the source jobs. */
export function startReplacement(state: SalesState, c: Ctx, orderId: string) {
  return transition(state, (s) => {
    const original = orderOf(s, orderId);
    if (original.status !== 'finalized' && original.status !== 'reversed') fail('order_not_finalized', 'Only finalized or reversed orders can be replaced');
    const successor = s.orders.find((order) => order.replacesOrderId === original.id && order.status !== 'cancelled');
    if (successor) {
      if (successor.status === 'draft') return { orderId: successor.id };
      fail('order_already_replaced', `${original.reference} was already replaced by ${successor.reference}`);
    }
    const customer = original.customer ? { kind: original.customer.kind, id: original.customer.id, displayName: original.customerName ?? '', pricingGroup: '' } : null;
    const draft = newDraft(s, c, { customer, fulfillmentMode: original.fulfillmentMode }, original.id);
    for (const item of activeItems(original)) {
      if (item.kind === 'manual') draft.items.push({ ...manualItem({ description: item.description, quantity: item.quantity, unit: item.unit, unitPrice: item.unitPrice, catalogItemId: item.catalogItemId }, c, draft.items.length + 1) });
      else {
        const job = s.jobs.find((candidate) => candidate.id === item.sourceJobId);
        if (!job) fail('source_unavailable', 'A job of the original order no longer exists. Add a manual item instead.');
        else { assertChargeable(s, c, draft, job); draft.items.push(itemFromJob(job, c, draft.items.length + 1)); }
      }
    }
    note(original, c, 'replacement_started', `Replacement draft ${draft.reference} created`);
    note(draft, c, 'created', `Items copied from ${original.reference}`);
    return { orderId: draft.id };
  });
}

export type CommitReplacementInput = { reason: string; reversals: ReversalInput[]; payments: PaymentInput[] };
export function commitReplacement(state: SalesState, c: Ctx, originalId: string, replacementId: string, input: CommitReplacementInput) {
  return transition(state, (s) => {
    const original = orderOf(s, originalId);
    const next = orderOf(s, replacementId);
    requireDraft(next);
    if (next.replacesOrderId !== original.id) fail('validation', 'The draft does not replace this order');
    if (original.status !== 'finalized' && original.status !== 'reversed') fail('order_not_finalized', 'The original is no longer replaceable');
    const latest = latestRequestOf(s, original.id);
    if (latest && latest.state !== 'cancelled') fail('external_reconciliation_required', `Cancel or reconcile ${latest.reference} in wiRef first`);
    const op = uid('op');
    for (const reversal of input.reversals) reverseReceiptIn(s, c, original, reversal, op);
    const carried = activeReceipts(s.payments, s.allocations, original.id);
    if (carried.some((payment) => payment.method === 'external')) fail('external_reconciliation_required', 'Payments confirmed by wiRef cannot be carried over');
    const paid = sum(carried.map((payment) => payment.amount));
    const newTotal = sum(activeItems(next).map((item) => item.amount));
    if (paid > newTotal) fail('payment_exceeds_outstanding', `The new total ${formatEur(newTotal)} is lower than the ${formatEur(paid)} paid. Refund or correct at least ${formatEur(round2(paid - newTotal))} first.`);
    for (const payment of carried) s.allocations.push({ id: uid('al'), paymentId: payment.id, orderId: original.id, amount: -payment.amount, operationId: op, at: c.at });
    if (original.status === 'finalized') reverseIn(s, c, original, input.reason);
    else note(original, c, 'reversed', 'Replacement committed');
    finalizeIn(s, c, next, true);
    for (const payment of carried) s.allocations.push({ id: uid('al'), paymentId: payment.id, orderId: next.id, amount: payment.amount, operationId: op, at: c.at });
    if (carried.length) note(next, c, 'paid', `${carried.length === 1 ? `${carried[0].reference} carried` : `${carried.length} payments carried`} over from ${original.reference}`);
    for (const payment of input.payments) receiptIn(s, c, next, payment, op);
    assertFullySettledIfWalkIn(s, next);
    note(original, c, 'replaced', `Replaced by ${next.reference}`);
    return {};
  });
}

// Composite flows ------------------------------------------------------------------------------------------------------

export type CounterSaleInput = { job: Job; extras: ManualItemInput[]; payments: PaymentInput[] };
/** Anonymous sale: the new job, the order with its items, finalization and complete settlement succeed or fail together. */
export function counterSale(state: SalesState, c: Ctx, input: CounterSaleInput) {
  return transition(state, (s) => {
    s.jobs.unshift(structuredClone(input.job));
    const order = newDraft(s, c, { customer: null, fulfillmentMode: 'immediate' });
    order.events[0].text = 'Counter sale started';
    const job = s.jobs[0];
    assertChargeable(s, c, order, job);
    order.items.push(itemFromJob(job, c, 1));
    input.extras.forEach((extra) => order.items.push(manualItem(extra, c, order.items.length + 1)));
    finalizeIn(s, c, order);
    const op = uid('op');
    for (const payment of input.payments) receiptIn(s, c, order, payment, op);
    assertFullySettledIfWalkIn(s, order);
    return { orderId: order.id };
  });
}

export function duplicateAsDraft(state: SalesState, c: Ctx, orderId: string) {
  return transition(state, (s) => {
    const source = orderOf(s, orderId);
    const customer = source.customer ? { kind: source.customer.kind, id: source.customer.id, displayName: source.customerName ?? '', pricingGroup: '' } : null;
    const draft = newDraft(s, c, { customer, fulfillmentMode: source.fulfillmentMode });
    const manual = activeItems(source).filter((item) => item.kind === 'manual');
    manual.forEach((item) => draft.items.push(manualItem(item, c, draft.items.length + 1)));
    note(draft, c, 'created', `Copied from ${source.reference}${activeItems(source).length > manual.length ? '. Jobs are not copied; add them again if they are free.' : ''}`);
    return { orderId: draft.id };
  });
}

/** Batch: one draft for a customer holding the given jobs. */
export function draftFromJobs(state: SalesState, c: Ctx, customer: BillingParty, jobIds: string[]) {
  return transition(state, (s) => {
    const draft = newDraft(s, c, { customer, fulfillmentMode: 'immediate' });
    for (const id of jobIds) {
      const job = s.jobs.find((candidate) => candidate.id === id) ?? fail('not_found', 'The job does not exist');
      assertChargeable(s, c, draft, job);
      const item = itemFromJob(job, c, draft.items.length + 1);
      draft.items.push(item);
      note(draft, c, 'item_added', `Added job ${job.displayId} · ${formatEur(item.amount)}`);
    }
    return { orderId: draft.id };
  });
}

// wiRef requests -------------------------------------------------------------------------------------------------------

const requestOf = (s: SalesState, id: string) => s.requests.find((request) => request.id === id) ?? fail('not_found', 'The wiRef request does not exist');
const customerOf = (s: SalesState, id: string | null | undefined) => s.customers.find((customer) => customer.id === id);

function requestNote(s: SalesState, c: Ctx, request: InvoiceRequest, kind: InvoiceEventKind, text: string, extra: Partial<Pick<InvoiceRequest['events'][number], 'externalReference' | 'effectiveOn' | 'reconciliationKind' | 'reason'>> = {}) {
  request.events.push({ id: uid('we'), at: c.at, actor: c.actor, kind, text, ...extra });
  request.version += 1;
  const order = s.orders.find((candidate) => candidate.id === request.orderId);
  if (order) note(order, c, 'invoicing', `${request.reference}: ${text.charAt(0).toLowerCase()}${text.slice(1)}`);
}
function requireState(request: InvoiceRequest, allowed: InvoiceRequest['state'][], message: string) {
  if (!allowed.includes(request.state)) fail('invalid_request_transition', message);
}
function checkExternalText(reference: string, reason = '') {
  if (reference.length > 200 || reason.length > 500) fail('validation', 'The reference or reason is too long');
}
const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T12:00:00Z`).getTime());

/** Why an order cannot get a wiRef request, or null. The Invoicing picker and the order menu use the same rules as the transition. */
export function invoiceRequestBlocker(s: Pick<SalesState, 'requests' | 'payments' | 'allocations'>, order: Order): string | null {
  if (order.status !== 'finalized') return 'The order is not finalized';
  if (!order.customer) return 'A walk-in sale has no one to invoice';
  const active = s.requests.filter((request) => request.orderId === order.id && request.state !== 'cancelled')[0];
  if (active) return `${active.reference} is already active for this order`;
  if (activeReceipts(s.payments, s.allocations, order.id).length) return 'Cash or card payments were recorded on it';
  return null;
}

/** Creates a wiRef request (draft state) for a finalized, named order that has no payments yet. A cancelled request may have a successor. */
export function prepareInvoiceRequest(state: SalesState, c: Ctx, orderId: string) {
  return transition(state, (s) => {
    const order = orderOf(s, orderId);
    if (order.status !== 'finalized') fail('order_not_finalized', 'A wiRef request needs a finalized order');
    if (!order.customer) fail('external_invoice_requires_customer', 'A wiRef request needs a named customer');
    if (activeRequestOf(s, order.id)) fail('request_already_exists', `This order already has an active wiRef request: ${activeRequestOf(s, order.id)!.reference}`);
    if (activeReceipts(s.payments, s.allocations, order.id).length) fail('settlement_workflow_conflict', 'An order with cash or card payments cannot be invoiced through wiRef');
    const jobs = activeItems(order).flatMap((item) => (item.snapshot ? [item.snapshot] : []));
    const previous = latestRequestOf(s, order.id);
    s.counters.request += 1;
    const request: InvoiceRequest = {
      id: uid('wr'), reference: reference('W', s.counters.request, c.at), orderId: order.id, orderReference: order.reference, state: 'draft', requestedAmount: money(s, order).net,
      details: {
        recipientName: order.customerName ?? '', addressLine1: '', postalCode: '', locality: '', countryCode: 'AT', contactName: '',
        serviceStartsOn: jobs.length ? dateInAppTimeZone(jobs.map((job) => job.startsAt).sort()[0]) : dateInAppTimeZone(c.at),
        serviceEndsOn: jobs.length ? dateInAppTimeZone(jobs.map((job) => job.endsAt).sort().at(-1)!) : addCalendarDays(dateInAppTimeZone(c.at), 0),
        serviceDescription: `Machine services and materials, ${activeItems(order).length} ${activeItems(order).length === 1 ? 'item' : 'items'}`, purchaseOrderReference: '',
      },
      events: [{ id: uid('we'), at: c.at, actor: c.actor, kind: 'created', text: previous ? `Request prepared again after ${previous.reference} was cancelled` : 'Request prepared from the order' }],
      supersedesRequestId: previous?.id ?? null, version: 1, createdAt: c.at,
    };
    s.requests.push(request);
    note(order, c, 'invoicing', `wiRef request ${request.reference} prepared`);
    return { requestId: request.id };
  });
}

/** Recipient details are editable while the request is a draft; they freeze when it becomes ready. */
export function updateRequestDetails(state: SalesState, c: Ctx, requestId: string, details: InvoiceRequestDetails) {
  return transition(state, (s) => {
    const request = requestOf(s, requestId);
    if (request.state !== 'draft') fail('request_frozen', 'Recipient details can only be changed while the request is a draft');
    const text = Object.values(details).join('');
    if ([details.recipientName, details.addressLine1, details.postalCode, details.locality, details.contactName, details.purchaseOrderReference].some((value) => value.length > 200) || text.length > 2000) fail('validation', 'Invoice recipient fields exceed their length limits');
    if (details.serviceDescription.length > 500) fail('validation', 'The service description is too long');
    if (details.countryCode && !/^[A-Za-z]{2}$/.test(details.countryCode)) fail('validation', 'Use the two-letter country code, e.g. AT');
    if ((details.serviceStartsOn && !validDate(details.serviceStartsOn)) || (details.serviceEndsOn && !validDate(details.serviceEndsOn))) fail('validation', 'Service period dates must be valid');
    if (details.serviceStartsOn && details.serviceEndsOn && details.serviceStartsOn > details.serviceEndsOn) fail('validation', 'The service period must end on or after its start');
    request.details = { ...details, countryCode: details.countryCode.toUpperCase() };
    requestNote(s, c, request, 'details_saved', 'Recipient details saved');
    return {};
  });
}

export function markRequestReady(state: SalesState, c: Ctx, requestId: string) {
  return transition(state, (s) => {
    const request = requestOf(s, requestId);
    requireState(request, ['draft'], 'Only drafts can become ready');
    const missing = requestReadiness(request, customerOf(s, s.orders.find((order) => order.id === request.orderId)?.customer?.id)).filter((item) => !item.ok);
    if (missing.length) fail('validation', `Complete these first: ${missing.map((item) => item.label.toLowerCase()).join(', ')}`);
    requestNote(s, c, request, 'ready', 'Marked as ready to submit');
    request.state = 'ready';
    return {};
  });
}

export function markRequestSubmitted(state: SalesState, c: Ctx, requestId: string) {
  return transition(state, (s) => {
    const request = requestOf(s, requestId);
    requireState(request, ['ready'], 'Only ready requests can be submitted');
    request.state = 'submitted';
    requestNote(s, c, request, 'submitted', 'Submitted to wiRef');
    return {};
  });
}

export type RecordIssuedInput = { externalReference: string; effectiveOn: string; amount: number };
export function recordRequestIssued(state: SalesState, c: Ctx, requestId: string, input: RecordIssuedInput) {
  return transition(state, (s) => {
    const request = requestOf(s, requestId);
    requireState(request, ['submitted'], 'Only submitted requests can record an external invoice');
    const reference = input.externalReference.trim();
    if (!reference || !validDate(input.effectiveOn)) fail('validation', 'External invoice reference and issue date are required');
    if (round2(input.amount) !== request.requestedAmount) fail('validation', `The invoice amount must equal the requested ${formatEur(request.requestedAmount)}`);
    checkExternalText(reference);
    request.state = 'issued';
    requestNote(s, c, request, 'issued', `Invoice ${reference} issued by wiRef for ${formatEur(request.requestedAmount)}`, { externalReference: reference, effectiveOn: input.effectiveOn });
    return {};
  });
}

/** Local cancellation: only drafts and ready requests, because wiRef has not seen them yet. */
export function cancelRequest(state: SalesState, c: Ctx, requestId: string, reason = '') {
  return transition(state, (s) => {
    const request = requestOf(s, requestId);
    if (request.state !== 'draft' && request.state !== 'ready') fail('external_reconciliation_required', 'Submitted requests need external cancellation evidence. Request the cancellation instead.');
    checkExternalText('', reason.trim());
    request.state = 'cancelled';
    requestNote(s, c, request, 'cancelled', reason.trim() ? `Request cancelled: ${reason.trim()}` : 'Request cancelled', { reason: reason.trim() || undefined });
    return {};
  });
}

export function requestCancellation(state: SalesState, c: Ctx, requestId: string, reason: string) {
  return transition(state, (s) => {
    const request = requestOf(s, requestId);
    requireState(request, ['submitted', 'issued'], 'Only submitted or issued requests require external cancellation');
    if (!reason.trim()) fail('validation', 'Say why the request has to be cancelled');
    checkExternalText('', reason.trim());
    request.state = 'cancellation_requested';
    requestNote(s, c, request, 'cancellation_requested', `Cancellation requested: ${reason.trim()}`, { reason: reason.trim() });
    return {};
  });
}

export const RECONCILIATION_KINDS: ReconciliationKind[] = ['cancellation', 'credit_note', 'corrected_invoice', 'reallocation', 'other'];
export type ConfirmCancellationInput = { reconciliationKind: ReconciliationKind; externalReference: string; effectiveOn: string };
export function confirmRequestCancellation(state: SalesState, c: Ctx, requestId: string, input: ConfirmCancellationInput) {
  return transition(state, (s) => {
    const request = requestOf(s, requestId);
    requireState(request, ['cancellation_requested'], 'Request the external cancellation first');
    const reference = input.externalReference.trim();
    if (!reference || !validDate(input.effectiveOn)) fail('validation', 'External correction kind, reference and date are required');
    if (!RECONCILIATION_KINDS.includes(input.reconciliationKind)) fail('validation', 'Unsupported external accounting procedure');
    checkExternalText(reference);
    request.state = 'cancelled';
    requestNote(s, c, request, 'cancelled', `Cancellation confirmed in wiRef (${reference})`, { externalReference: reference, effectiveOn: input.effectiveOn, reconciliationKind: input.reconciliationKind });
    return {};
  });
}

export type CorrectReferenceInput = { externalReference: string; reason: string; effectiveOn: string };
export function correctRequestReference(state: SalesState, c: Ctx, requestId: string, input: CorrectReferenceInput) {
  return transition(state, (s) => {
    const request = requestOf(s, requestId);
    requireState(request, ['issued', 'cancellation_requested'], 'Reference correction requires an issued invoice');
    const reference = input.externalReference.trim();
    if (!reference || !input.reason.trim() || !validDate(input.effectiveOn)) fail('validation', 'Corrected reference, reason and date are required');
    checkExternalText(reference, input.reason.trim());
    requestNote(s, c, request, 'reference_corrected', `Invoice reference corrected to ${reference}`, { externalReference: reference, effectiveOn: input.effectiveOn, reason: input.reason.trim() });
    return {};
  });
}

// Cash day close [proposed] ----------------------------------------------------------------------------------------------------

export type CloseDayInput = { day: string; countedCash: number; denominations: Record<string, number>; note: string };
/** Closes the cash of one calendar day. Afterwards cash entries cannot be added to or corrected on that day. */
export function closeDay(state: SalesState, c: Ctx, input: CloseDayInput) {
  return transition(state, (s) => {
    if (!validDate(input.day)) fail('validation', 'Choose the day to close');
    if (input.day > dateInAppTimeZone(c.at)) fail('validation', 'A day that has not happened yet cannot be closed');
    if (s.daySessions.some((session) => session.day === input.day)) fail('day_already_closed', `${formatDate(`${input.day}T12:00:00Z`)} is already closed`);
    if (!(input.countedCash >= 0) || round2(input.countedCash) !== input.countedCash) fail('validation', 'Enter the counted cash with at most two decimals');
    const expected = cashDayFigures(s.payments, input.day).expected;
    const difference = round2(input.countedCash - expected);
    const text = input.note.trim();
    if (difference !== 0 && !text) fail('validation', `Explain the difference of ${formatEur(Math.abs(difference))} in the note`);
    if (text.length > 500) fail('validation', 'The note can have up to 500 characters');
    s.daySessions.push({ id: uid('day'), day: input.day, expectedCash: expected, countedCash: input.countedCash, difference, note: text, denominations: input.denominations, closedAt: c.at, closedBy: c.actor });
    return {};
  });
}

// Customers and pricing ---------------------------------------------------------------------------------------------------------

export function assignPricingGroup(state: SalesState, c: Ctx, customerId: string, group: string | null) {
  return transition(state, (s) => {
    const customer = customerOf(s, customerId) ?? fail('not_found', 'The customer does not exist');
    if (group !== null && !s.pricing.groups.find((item) => item.name === group)?.active) fail('pricing_group_inactive', 'That pricing group is inactive');
    customer.pricingGroup = group;
    void c;
    return {};
  });
}

/** Applies to wiRef requests that are marked ready from now on; ready requests keep what they captured. */
export function setPurchaseOrderRequirement(state: SalesState, c: Ctx, customerId: string, required: boolean) {
  return transition(state, (s) => {
    const customer = customerOf(s, customerId) ?? fail('not_found', 'The customer does not exist');
    if (customer.kind !== 'organization') fail('validation', 'Only organizations have invoicing requirements');
    customer.requiresPurchaseOrder = required;
    void c;
    return {};
  });
}

export type PricingGroupInput = { id?: string; name: string; description: string; active: boolean; isDefault: boolean };
export function savePricingGroup(state: SalesState, c: Ctx, input: PricingGroupInput) {
  return transition(state, (s) => {
    const name = input.name.trim();
    if (!name || name.length > 80) fail('validation', 'Give the group a name of up to 80 characters');
    if (input.description.trim().length > 300) fail('validation', 'The description can have up to 300 characters');
    if (s.pricing.groups.some((group) => group.id !== input.id && group.name.toLowerCase() === name.toLowerCase())) fail('conflict', `A pricing group named “${name}” already exists`);
    if (input.isDefault && !input.active) fail('validation', 'The default pricing group must be active');
    const existing = input.id ? s.pricing.groups.find((group) => group.id === input.id) ?? fail('not_found', 'The pricing group does not exist') : null;
    if (existing?.isDefault && !input.isDefault) fail('validation', 'There always has to be a default group. Make another group the default instead.');
    if (input.isDefault) for (const group of s.pricing.groups) group.isDefault = false;
    if (existing) {
      // Customers and jobs refer to the group by name, so a rename keeps them attached.
      for (const customer of s.customers) if (customer.pricingGroup === existing.name) customer.pricingGroup = name;
      Object.assign(existing, { name, description: input.description.trim(), active: input.active, isDefault: input.isDefault });
      return { groupId: existing.id };
    }
    const group: PricingGroup = { id: uid('pg'), name, description: input.description.trim(), active: input.active, isDefault: input.isDefault || s.pricing.groups.length === 0 };
    s.pricing.groups.push(group);
    void c;
    return { groupId: group.id };
  });
}

export type RateInput = Pick<RateRule, 'groupId' | 'kind' | 'machineTypeId' | 'category' | 'unit'> & { rate: number };
/** Sets the rate of one selector in one group. Creates the rule when it does not exist yet (a "missing rule"). */
export function setRate(state: SalesState, c: Ctx, input: RateInput) {
  return transition(state, (s) => {
    const group = s.pricing.groups.find((item) => item.id === input.groupId) ?? fail('not_found', 'The pricing group does not exist');
    if (!group.active) fail('pricing_group_inactive', `${group.name} is inactive`);
    if (!(input.rate >= 0) || Math.round(input.rate * 10_000) / 10_000 !== input.rate) fail('validation', 'The rate must be zero or more, with at most four decimals');
    const candidate: RateRule = { id: '', ...input };
    const existing = s.pricing.rules.find((rule) => rule.groupId === input.groupId && ruleKey(rule) === ruleKey(candidate));
    if (existing) existing.rate = input.rate;
    else s.pricing.rules.push({ ...candidate, id: uid('pr') });
    void c;
    return {};
  });
}
