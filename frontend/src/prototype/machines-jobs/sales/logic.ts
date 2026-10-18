import { effectivePrice, isManualRunning } from '../derived';
import { runsOfJob } from '../runs';
import type { BillingParty, Job, Print } from '../types';
import { addCalendarDays, zonedDateTimeToISO } from '../../../app/dateTime';
import { dateInAppTimeZone, formatDateTime, formatEur, round2 } from './format';
import { methodLabel, requestNextStep, requestStateLabel } from './labels';
import type {
  Allocation, CashMovement, InvoiceRequest, Order, OrderAdjustment, OrderItem, OrganizationRecord, Payment, PaymentMethod, ReversalReasonKind, SettlementState,
} from './types';

// Pure derivations over the sales data. The settlement rules match the backend: settlement is derived from charges,
// full-reversal adjustments and signed allocations, never stored.

export const activeItems = (order: Order) => order.items.filter((item) => item.removedAt === null);
export const sum = (values: number[]) => round2(values.reduce((total, value) => total + value, 0));

export type OrderMoney = { total: number; net: number; settled: number; outstanding: number; settlement: SettlementState | null };

export function orderMoney(order: Order, allocations: Allocation[], adjustments: OrderAdjustment[]): OrderMoney {
  const total = sum(activeItems(order).map((item) => item.amount));
  const adjusted = sum(adjustments.filter((item) => item.orderId === order.id).map((item) => item.amount));
  const net = round2(total - adjusted);
  const settled = sum(allocations.filter((item) => item.orderId === order.id).map((item) => item.amount));
  if (order.status === 'draft' || order.status === 'cancelled') return { total, net: total, settled: 0, outstanding: 0, settlement: null };
  const settlement: SettlementState = net === 0 ? 'no_payment_due' : settled >= net ? 'paid' : settled > 0 ? 'partially_paid' : 'unpaid';
  return { total, net, settled, outstanding: Math.max(0, round2(net - settled)), settlement };
}

export type OrderView = Order & OrderMoney & {
  customerLabel: string;
  customerKind: 'person' | 'organization';
  /** wiRef request that is not cancelled. */
  activeRequest: InvoiceRequest | null;
  /** The latest request regardless of its state. */
  latestRequest: InvoiceRequest | null;
  /** A committed (non-draft, non-cancelled) successor. */
  replacedBy: Order | null;
  replaces: Order | null;
};

type SalesData = { orders: Order[]; allocations: Allocation[]; adjustments: OrderAdjustment[]; requests: InvoiceRequest[] };

export function buildOrderViews({ orders, allocations, adjustments, requests }: SalesData): OrderView[] {
  const byId = new Map(orders.map((order) => [order.id, order]));
  return orders.map((order) => {
    const mine = requests.filter((request) => request.orderId === order.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return {
      ...order, ...orderMoney(order, allocations, adjustments),
      customerLabel: order.customerName, customerKind: order.customer.kind,
      activeRequest: mine.find((request) => request.state !== 'cancelled') ?? null, latestRequest: mine[0] ?? null,
      replacedBy: orders.find((other) => other.replacesOrderId === order.id && other.status !== 'draft' && other.status !== 'cancelled') ?? null,
      replaces: order.replacesOrderId ? byId.get(order.replacesOrderId) ?? null : null,
    };
  });
}

// Payments -----------------------------------------------------------------------------------------------------------

export const allocationSum = (allocations: Allocation[], orderId: string, paymentId?: string) =>
  sum(allocations.filter((item) => item.orderId === orderId && (!paymentId || item.paymentId === paymentId)).map((item) => item.amount));

/** Receipts that currently count towards an order: allocated to it and not reversed. */
export function activeReceipts(payments: Payment[], allocations: Allocation[], orderId: string) {
  const reversed = new Set(payments.filter((payment) => payment.entryKind === 'reversal').map((payment) => payment.reversesPaymentId));
  return payments.filter((payment) => payment.entryKind === 'receipt' && !reversed.has(payment.id) && allocationSum(allocations, orderId, payment.id) > 0);
}

/** Cash and card the order has received that still count: what an invoice request calls "already paid". */
export const paidByCashOrCard = (payments: Payment[], allocations: Allocation[], orderId: string) =>
  sum(activeReceipts(payments, allocations, orderId).filter((payment) => payment.method !== 'external').map((payment) => payment.amount));

/** The order a payment belongs to: where it is allocated now, else where it was first allocated. */
export function paymentOrderId(payment: Payment, allocations: Allocation[], payments: Payment[]): string | null {
  const own = payment.entryKind === 'reversal' ? payments.find((item) => item.id === payment.reversesPaymentId) ?? payment : payment;
  const mine = allocations.filter((item) => item.paymentId === own.id);
  const live = new Map<string, number>();
  for (const item of mine) live.set(item.orderId, round2((live.get(item.orderId) ?? 0) + item.amount));
  return [...live.entries()].find(([, amount]) => amount > 0)?.[0] ?? mine[0]?.orderId ?? null;
}

/** Net takings per method for a time window: receipts minus reversals, by the time they occurred. */
export function takings(payments: Payment[], from: number, to: number): Record<PaymentMethod, number> & { total: number } {
  const result = { cash: 0, card: 0, external: 0 };
  for (const payment of payments) {
    const at = new Date(payment.occurredAt).getTime();
    if (at >= from && at < to) result[payment.method] = round2(result[payment.method] + (payment.entryKind === 'receipt' ? payment.amount : -payment.amount));
  }
  return { ...result, total: round2(result.cash + result.card + result.external) };
}

/** Midnight (Europe/Vienna) of today plus `offsetDays`. */
export const startOfDay = (offsetDays = 0) => new Date(zonedDateTimeToISO(addCalendarDays(dateInAppTimeZone(new Date()), offsetDays), '00:00')).getTime();

/** The payment methods an order accepts right now. Cash and card until its invoice request is marked ready; a bank transfer only once wiRef issued the invoice. [proposed rule] */
export function acceptedMethods(order: Pick<OrderView, 'activeRequest'>): PaymentMethod[] {
  const request = order.activeRequest;
  if (!request || request.state === 'draft') return ['cash', 'card'];
  return request.state === 'issued' ? ['external'] : [];
}

// Jobs and orders ----------------------------------------------------------------------------------------------------

/** Why a finished job cannot be charged yet, or null. */
export function jobBlocker(job: Job, prints: Print[], now: number): string | null {
  if (runsOfJob(job.id, prints).some((run) => run.state === 'printing') || isManualRunning(job, now)) return 'The run is still going';
  if (job.outcome === 'unknown') return 'Record the outcome first';
  if (job.pricingStatus === 'incomplete') return 'A pricing rate is missing';
  if (job.pricingStatus === 'pending') return 'The price is still pending';
  return null;
}

/** The order that holds the job: its claim after finalization, else a draft that contains it. */
export function orderOfJob(job: Job, orders: Order[]): { order: Order; claimed: boolean } | null {
  const claimed = job.order ? orders.find((order) => order.id === job.order!.orderId) : undefined;
  if (claimed) return { order: claimed, claimed: true };
  const draft = orders.find((order) => order.status === 'draft' && activeItems(order).some((item) => item.sourceJobId === job.id));
  return draft ? { order: draft, claimed: false } : null;
}

export const itemChanged = (item: OrderItem, jobs: Job[]) => {
  const job = item.sourceJobId ? jobs.find((candidate) => candidate.id === item.sourceJobId) : undefined;
  return !!job && item.sourceJobVersion !== job.version;
};

export type ReadyRow = { job: Job; price: number | null; reason: string | null };
export type ReadyGroup = { customer: BillingParty; rows: ReadyRow[]; ready: ReadyRow[]; total: number; oldestEnd: string };

/** Finished jobs without an order, grouped by customer. Jobs that cannot be charged yet stay visible with their reason. */
export function readyToBill(jobs: Job[], orders: Order[], prints: Print[], now: number): ReadyGroup[] {
  const groups = new Map<string, ReadyGroup>();
  for (const job of jobs) {
    if (job.order) continue;
    const draft = orderOfJob(job, orders);
    const reason = draft ? `Already in draft ${draft.order.reference}` : jobBlocker(job, prints, now);
    const row: ReadyRow = { job, price: effectivePrice(job), reason };
    const group = groups.get(job.customer.id) ?? { customer: job.customer, rows: [], ready: [], total: 0, oldestEnd: job.endsAt };
    group.rows.push(row);
    if (!reason) group.ready.push(row);
    if (job.endsAt < group.oldestEnd) group.oldestEnd = job.endsAt;
    groups.set(job.customer.id, group);
  }
  return [...groups.values()].map((group) => ({ ...group, rows: group.rows.sort((a, b) => b.job.endsAt.localeCompare(a.job.endsAt)), total: sum(group.ready.map((row) => row.price ?? 0)) }))
    .sort((a, b) => a.oldestEnd.localeCompare(b.oldestEnd));
}

/** Jobs that can be added to this draft: the customer's finished, priced jobs that are on no order. */
export function eligibleJobs(order: Order, jobs: Job[], orders: Order[], prints: Print[], now: number) {
  const original = order.replacesOrderId;
  const mine = new Set(activeItems(order).map((item) => item.sourceJobId));
  return jobs.filter((job) => job.customer.id === order.customer.id && !mine.has(job.id)
    && (!job.order || job.order.orderId === original) && !orderOfJob(job, orders.filter((candidate) => candidate.id !== order.id && candidate.status === 'draft' && !candidate.replacesOrderId))?.order
    && jobBlocker(job, prints, now) === null);
}

/** Orders that wait for staff: old drafts and finalized orders with an outstanding amount. */
export const DRAFT_STALE_DAYS = 7;
export const isStaleDraft = (order: OrderView) => order.status === 'draft' && Date.now() - new Date(order.updatedAt).getTime() > DRAFT_STALE_DAYS * 86_400_000;

/** Why the selected Jobs rows cannot be put on an order, or null. Used by the Jobs mass edit. */
export function addToOrderBlocker(jobs: (Job | null)[], orders: Order[], prints: Print[], now: number, allowed: boolean): string | null {
  if (!allowed) return 'Add to order: you do not have permission to create orders.';
  if (jobs.length === 0) return 'Add to order: select finished jobs first.';
  if (jobs.some((job) => job === null)) return 'Add to order: only jobs can be added — deselect the unassigned runs.';
  const real = jobs as Job[];
  const customers = new Set(real.map((job) => job.customer.id));
  if (customers.size > 1) return 'Add to order: the jobs belong to different customers.';
  for (const job of real) {
    if (job.order) return `Add to order: ${job.displayId} is already on ${job.order.orderReference}.`;
    const draft = orderOfJob(job, orders);
    if (draft) return `Add to order: ${job.displayId} is already in draft ${draft.order.reference}.`;
    const blocker = jobBlocker(job, prints, now);
    if (blocker) return `Add to order: ${job.displayId}: ${blocker.charAt(0).toLowerCase()}${blocker.slice(1)}.`;
  }
  return null;
}

// Cashbook ------------------------------------------------------------------------------------------------------------------------

export type PeriodPreset = 'today' | 'yesterday' | 'week' | 'month' | 'custom';
export const periodPresets: { id: PeriodPreset; label: string }[] = [
  { id: 'today', label: 'Today' }, { id: 'yesterday', label: 'Yesterday' }, { id: 'week', label: 'This week' }, { id: 'month', label: 'This month' }, { id: 'custom', label: 'Custom range' },
];
const midnight = (day: string) => new Date(zonedDateTimeToISO(day, '00:00')).getTime();

/** A period in the app time zone as [from, to) instants. `from` and `to` of a custom range are inclusive calendar days. */
export function periodRange(preset: PeriodPreset, from = '', to = '', now = new Date()): { from: number; to: number; label: string; valid: boolean } {
  const today = dateInAppTimeZone(now);
  if (preset === 'today') return { from: midnight(today), to: midnight(addCalendarDays(today, 1)), label: 'Today', valid: true };
  if (preset === 'yesterday') return { from: midnight(addCalendarDays(today, -1)), to: midnight(today), label: 'Yesterday', valid: true };
  if (preset === 'week') {
    const weekday = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7;
    return { from: midnight(addCalendarDays(today, -weekday)), to: midnight(addCalendarDays(today, 1)), label: 'This week', valid: true };
  }
  if (preset === 'month') return { from: midnight(`${today.slice(0, 8)}01`), to: midnight(addCalendarDays(today, 1)), label: 'This month', valid: true };
  const valid = !!from && !!to && from <= to;
  return { from: from ? midnight(from) : 0, to: to ? midnight(addCalendarDays(to, 1)) : 0, label: valid ? `${from} to ${to}` : 'Custom range', valid };
}

/** One line of the cashbook: a payment (receipt, refund or correction) or a cash movement that is not tied to an order. */
export type CashbookLine =
  | { type: 'payment'; id: string; at: string; reference: string; payment: Payment; order: Order | null; customerLabel: string; customerKind: 'person' | 'organization' | null; signed: number; method: PaymentMethod; recordedBy: string }
  | { type: 'movement'; id: string; at: string; reference: string; movement: CashMovement; order: null; customerLabel: string; customerKind: null; signed: number; method: 'cash'; recordedBy: string };

export function cashbookLines(payments: Payment[], allocations: Allocation[], orders: Order[], movements: CashMovement[]): CashbookLine[] {
  const byId = new Map(orders.map((order) => [order.id, order]));
  const paymentLines = payments.map((payment): CashbookLine => {
    const order = byId.get(paymentOrderId(payment, allocations, payments) ?? '') ?? null;
    return {
      type: 'payment', id: payment.id, at: payment.occurredAt, reference: payment.reference, payment, order, customerLabel: order?.customerName ?? '—', customerKind: order?.customer.kind ?? null,
      signed: payment.entryKind === 'receipt' ? payment.amount : -payment.amount, method: payment.method, recordedBy: payment.recordedBy,
    };
  });
  const movementLines = movements.map((movement): CashbookLine => ({
    type: 'movement', id: movement.id, at: movement.occurredAt, reference: movement.reference, movement, order: null, customerLabel: '—', customerKind: null,
    signed: movement.kind === 'deposit' ? movement.amount : -movement.amount, method: 'cash', recordedBy: movement.recordedBy,
  }));
  return [...paymentLines, ...movementLines].sort((a, b) => b.at.localeCompare(a.at) || b.reference.localeCompare(a.reference));
}

export type CashFigures = { receipts: number; refunds: number; withdrawals: number; deposits: number; expected: number };

/** The cash the register should hold: cash receipts minus cash refunds and corrections, minus withdrawals, plus deposits. All time up to (excluding) `to`. */
export function cashInRegister(payments: Payment[], movements: CashMovement[], to = Infinity): CashFigures {
  let receipts = 0; let refunds = 0; let withdrawals = 0; let deposits = 0;
  for (const payment of payments) {
    if (payment.method !== 'cash' || new Date(payment.occurredAt).getTime() >= to) continue;
    if (payment.entryKind === 'receipt') receipts = round2(receipts + payment.amount); else refunds = round2(refunds + payment.amount);
  }
  for (const movement of movements) {
    if (new Date(movement.occurredAt).getTime() >= to) continue;
    if (movement.kind === 'withdrawal') withdrawals = round2(withdrawals + movement.amount); else deposits = round2(deposits + movement.amount);
  }
  return { receipts, refunds, withdrawals, deposits, expected: round2(receipts - refunds - withdrawals + deposits) };
}

export type ReversalOptions = {
  kinds: ReversalReasonKind[];
  /** The payment cannot be refunded or corrected at all right now. */
  blocker: string | null;
  /** The correction is possible, but only after something else happens (cancel the wiRef request). */
  prerequisite: { text: string; to: string } | null;
  needsReplacement: boolean;
  needsReference: boolean;
};

/** Which reasons a receipt can be undone with, and what stands in the way. Mirrors the engine so the dialog never offers an option that fails. */
export function reversalOptions(payment: Payment, order: Order | null, data: { payments: Payment[]; allocations: Allocation[]; requests: InvoiceRequest[] }): ReversalOptions {
  const none = (blocker: string): ReversalOptions => ({ kinds: [], blocker, prerequisite: null, needsReplacement: false, needsReference: false });
  if (payment.entryKind !== 'receipt') return none('Only receipts can be refunded or corrected. This entry is itself a reversal.');
  const reversal = data.payments.find((other) => other.reversesPaymentId === payment.id);
  if (reversal) return none(`${reversal.reference} already reversed this payment.`);
  if (!order) return none('This payment is not allocated to an order.');
  if (!activeReceipts(data.payments, data.allocations, order.id).some((receipt) => receipt.id === payment.id)) return none('This payment no longer counts towards an order. Open the order it moved to.');
  if (order.status !== 'finalized') return none(`${order.reference} is ${order.status === 'reversed' ? 'reversed' : 'not finalized'}, so there is nothing to refund here.`);
  const latest = data.requests.filter((request) => request.orderId === order.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const base = { blocker: null, needsReplacement: false, needsReference: payment.method === 'card' };
  const orderLink = `/sales/orders/${order.id}`;
  if (payment.method === 'external') {
    return { ...base, kinds: ['external_correction'], prerequisite: latest && latest.state === 'cancelled' ? null : { text: latest ? `${latest.reference} has to be cancelled in wiRef first (state: ${requestStateLabel[latest.state].toLowerCase()}).` : 'The invoice request has to be cancelled first.', to: orderLink }, needsReference: true };
  }
  // Cash and card on an order whose invoice request moved past the draft are part of what the invoice says was paid.
  const active = latest && latest.state !== 'cancelled' ? latest : null;
  const frozen = active && active.state !== 'draft';
  return { ...base, kinds: ['refund', 'recording_error'], prerequisite: frozen ? { text: `${active.reference} is ${requestStateLabel[active.state].toLowerCase()} and states what was already paid, so it has to be cancelled first.`, to: orderLink } : null };
}

type HistoryLine = { at: string; text: string };
/** The life of a payment in plain words, from its allocations. A transfer is a negative entry for one order and a positive one for another with the same operation. */
export function paymentHistory(payment: Payment, data: { payments: Payment[]; allocations: Allocation[]; orders: Order[] }): HistoryLine[] {
  const ref = (id: string) => data.orders.find((order) => order.id === id)?.reference ?? 'another order';
  const lines: HistoryLine[] = [];
  const sourceId = payment.entryKind === 'reversal' ? payment.reversesPaymentId ?? payment.id : payment.id;
  const source = data.payments.find((item) => item.id === sourceId) ?? payment;
  const groups = new Map<string, Allocation[]>();
  for (const allocation of data.allocations.filter((item) => item.paymentId === source.id || item.paymentId === payment.id).sort((a, b) => a.at.localeCompare(b.at))) {
    groups.set(allocation.operationId, [...(groups.get(allocation.operationId) ?? []), allocation]);
  }
  const reversal = data.payments.find((item) => item.reversesPaymentId === source.id);
  lines.push({ at: source.occurredAt, text: `${methodLabel(source.method)} payment of ${formatEur(source.amount)} received at ${formatDateTime(source.occurredAt)}.` });
  let first = true;
  for (const group of groups.values()) {
    const added = group.filter((item) => item.amount > 0 && item.paymentId === source.id);
    const removed = group.filter((item) => item.amount < 0);
    const at = group[0].at;
    if (first && added.length && !removed.length) { lines.push({ at, text: `Counted towards ${ref(added[0].orderId)}.` }); first = false; continue; }
    first = false;
    if (removed.length && added.length && removed[0].orderId !== added[0].orderId) lines.push({ at, text: `Moved from ${ref(removed[0].orderId)} to ${ref(added[0].orderId)} when the order was replaced. No money moved.` });
    else if (removed.length && reversal) lines.push({ at, text: `Taken off ${ref(removed[0].orderId)} by ${reversal.reference}: ${reversal.reasonKind === 'refund' ? 'the money was given back' : reversal.reasonKind === 'recording_error' ? 'it had been recorded by mistake' : 'an accounting correction in wiRef'}.` });
  }
  if (reversal) lines.push({ at: reversal.occurredAt, text: `${reversal.reasonKind === 'refund' ? 'Refunded' : 'Corrected'} by ${reversal.reference}: ${reversal.reason}` });
  return lines.sort((a, b) => a.at.localeCompare(b.at));
}

// wiRef readiness ---------------------------------------------------------------------------------------------------------------------

export type ReadinessItem = { key: string; label: string; ok: boolean; hint: string };
/** What has to be filled in before a wiRef request can be marked ready. The purchase order rule follows the customer's invoicing requirements at that moment. */
export function requestReadiness(request: Pick<InvoiceRequest, 'details'>, customer: { kind: 'person' | 'organization' } | undefined, organization?: Pick<OrganizationRecord, 'requiresPurchaseOrder'>): ReadinessItem[] {
  const d = request.details;
  const isOrganization = customer?.kind === 'organization';
  const items: ReadinessItem[] = [
    { key: 'recipient', label: 'Recipient name', ok: d.recipientName.trim() !== '', hint: 'Who receives the invoice' },
    { key: 'address', label: 'Billing address', ok: d.addressLine1.trim() !== '' && d.postalCode.trim() !== '' && d.locality.trim() !== '', hint: 'Street, postal code and town' },
    { key: 'country', label: 'Country', ok: /^[A-Za-z]{2}$/.test(d.countryCode.trim()), hint: 'Two-letter code, e.g. AT' },
  ];
  if (isOrganization) items.push({ key: 'contact', label: 'Contact person', ok: d.contactName.trim() !== '', hint: 'Organizations need someone to address the invoice to' });
  if (isOrganization && organization?.requiresPurchaseOrder) items.push({ key: 'po', label: 'Purchase order reference', ok: d.purchaseOrderReference.trim() !== '', hint: 'This organization requires one on every invoice' });
  items.push(
    { key: 'period', label: 'Service period', ok: !!d.serviceStartsOn && !!d.serviceEndsOn && d.serviceStartsOn <= d.serviceEndsOn, hint: 'Start and end date, in order' },
    { key: 'description', label: 'Service description', ok: d.serviceDescription.trim() !== '', hint: 'What the invoice is for' },
  );
  return items;
}

export const INVOICE_STEPS = ['Draft', 'Ready to submit', 'Submitted', 'Invoice issued'] as const;

/** Where a request is on the progress indicator. An issued invoice completes all steps; a cancellation marks the last step that was reached. */
export function requestProgress(request: Pick<InvoiceRequest, 'state' | 'events'>): { index: number; invalid: boolean } {
  const reached = (kind: string) => request.events.some((event) => event.kind === kind);
  if (request.state === 'draft') return { index: 0, invalid: false };
  if (request.state === 'ready') return { index: 1, invalid: false };
  if (request.state === 'submitted') return { index: 2, invalid: false };
  if (request.state === 'issued') return { index: INVOICE_STEPS.length, invalid: false };
  return { index: reached('issued') ? 3 : reached('submitted') ? 2 : reached('ready') ? 1 : 0, invalid: true };
}

/** What happens next, taking the order's payment into account. */
export function requestNext(request: InvoiceRequest, orderPaid: boolean, detailsComplete?: boolean): string {
  if (request.state === 'issued' && orderPaid) return 'Complete, invoice paid';
  if (request.state === 'draft' && detailsComplete) return 'Mark it as ready to submit';
  return requestNextStep[request.state];
}

/** An invoice request that still waits for someone: anything before issued, a cancellation to confirm, or an issued invoice that is not paid yet. */
export const invoiceNeedsStep = (request: InvoiceRequest | null, orderPaid: boolean) => !!request && request.state !== 'cancelled' && !(request.state === 'issued' && orderPaid);
