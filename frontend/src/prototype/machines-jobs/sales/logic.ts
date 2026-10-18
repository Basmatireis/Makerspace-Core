import { effectivePrice, isManualRunning } from '../derived';
import { runsOfJob } from '../runs';
import type { BillingParty, Job, Print } from '../types';
import { addCalendarDays, zonedDateTimeToISO } from '../../../app/dateTime';
import { dateInAppTimeZone, formatDateTime, formatEur, round2 } from './format';
import { methodLabel, requestNextStep } from './labels';
import type {
  Allocation, CustomerRecord, DaySession, InvoiceRequest, Order, OrderAdjustment, OrderItem, Payment, PaymentMethod, ReversalReasonKind, SettlementState,
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
  customerKind: 'person' | 'organization' | 'walk_in';
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
      customerLabel: order.customerName ?? 'Walk-in customer', customerKind: order.customer?.kind ?? 'walk_in',
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
    if (!job.customer || job.order) continue;
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
  if (!order.customer) return [];
  const original = order.replacesOrderId;
  const mine = new Set(activeItems(order).map((item) => item.sourceJobId));
  return jobs.filter((job) => job.customer?.id === order.customer!.id && !mine.has(job.id)
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
  const customers = new Set(real.map((job) => job.customer?.id ?? null));
  if (customers.has(null)) return 'Add to order: every job needs a customer.';
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

export type CashbookLine = {
  payment: Payment; order: Order | null; customerLabel: string; customerKind: 'person' | 'organization' | 'walk_in'; signed: number;
  /** The cash of this payment's day is closed. */
  locked: boolean;
};

export function cashbookLines(payments: Payment[], allocations: Allocation[], orders: Order[], sessions: DaySession[]): CashbookLine[] {
  const byId = new Map(orders.map((order) => [order.id, order]));
  return payments.map((payment) => {
    const order = byId.get(paymentOrderId(payment, allocations, payments) ?? '') ?? null;
    return {
      payment, order, customerLabel: order?.customerName ?? (order ? 'Walk-in customer' : '—'), customerKind: (order?.customer?.kind ?? 'walk_in') as CashbookLine['customerKind'],
      signed: payment.entryKind === 'receipt' ? payment.amount : -payment.amount, locked: payment.method === 'cash' && isCashDayClosed(sessions, payment.occurredAt),
    };
  }).sort((a, b) => b.payment.occurredAt.localeCompare(a.payment.occurredAt) || b.payment.reference.localeCompare(a.payment.reference));
}

export const isCashDayClosed = (sessions: Pick<DaySession, 'day'>[], iso: string) => sessions.some((session) => session.day === dateInAppTimeZone(iso));

/** What the till should hold at the end of a day: cash receipts minus cash refunds and corrections, by the day they happened. */
export function cashDayFigures(payments: Payment[], day: string) {
  let receipts = 0; let refunds = 0; let count = 0;
  for (const payment of payments) {
    if (payment.method !== 'cash' || dateInAppTimeZone(payment.occurredAt) !== day) continue;
    count += 1;
    if (payment.entryKind === 'receipt') receipts = round2(receipts + payment.amount); else refunds = round2(refunds + payment.amount);
  }
  return { receipts, refunds, expected: round2(receipts - refunds), count };
}

/** Days within the last two weeks that have cash movements and are not closed yet, newest first. */
export function openCashDays(payments: Payment[], sessions: DaySession[], now = new Date()): string[] {
  const today = dateInAppTimeZone(now);
  const earliest = addCalendarDays(today, -14);
  const days = new Set(payments.filter((payment) => payment.method === 'cash').map((payment) => dateInAppTimeZone(payment.occurredAt)));
  return [...days].filter((day) => day >= earliest && day <= today && !sessions.some((session) => session.day === day)).sort().reverse();
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
  const base = { blocker: null, needsReplacement: !order.customer, needsReference: payment.method === 'card' };
  if (payment.method === 'external') {
    return { ...base, kinds: ['external_correction'], needsReplacement: false, prerequisite: latest && latest.state === 'cancelled' ? null : { text: latest ? `${latest.reference} has to be cancelled in wiRef first (state: ${latest.state.replace('_', ' ')}).` : 'The wiRef request has to be cancelled first.', to: latest ? `/sales/invoicing/${latest.id}` : '/sales/invoicing' }, needsReference: true };
  }
  // A walk-in sale has to stay paid in full: money can only be given back by cancelling the whole order, so here only a mistaken entry can be fixed (with the right receipt).
  return { ...base, kinds: order.customer ? ['refund', 'recording_error'] : ['recording_error'], prerequisite: null };
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
export function requestReadiness(request: Pick<InvoiceRequest, 'details'>, customer: Pick<CustomerRecord, 'kind' | 'requiresPurchaseOrder'> | undefined): ReadinessItem[] {
  const d = request.details;
  const organization = customer?.kind === 'organization';
  const items: ReadinessItem[] = [
    { key: 'recipient', label: 'Recipient name', ok: d.recipientName.trim() !== '', hint: 'Who receives the invoice' },
    { key: 'address', label: 'Billing address', ok: d.addressLine1.trim() !== '' && d.postalCode.trim() !== '' && d.locality.trim() !== '', hint: 'Street, postal code and town' },
    { key: 'country', label: 'Country', ok: /^[A-Za-z]{2}$/.test(d.countryCode.trim()), hint: 'Two-letter code, e.g. AT' },
  ];
  if (organization) items.push({ key: 'contact', label: 'Contact person', ok: d.contactName.trim() !== '', hint: 'Organizations need someone to address the invoice to' });
  if (organization && customer?.requiresPurchaseOrder) items.push({ key: 'po', label: 'Purchase order reference', ok: d.purchaseOrderReference.trim() !== '', hint: 'This organization requires one on every invoice' });
  items.push(
    { key: 'period', label: 'Service period', ok: !!d.serviceStartsOn && !!d.serviceEndsOn && d.serviceStartsOn <= d.serviceEndsOn, hint: 'Start and end date, in order' },
    { key: 'description', label: 'Service description', ok: d.serviceDescription.trim() !== '', hint: 'What the invoice is for' },
  );
  return items;
}

// Customers -----------------------------------------------------------------------------------------------------------------------

export type CustomerSummary = { customer: CustomerRecord; orders: OrderView[]; openBalance: number; lastActivity: string | null; unbilledJobs: number };

export function customerSummaries(customers: CustomerRecord[], views: OrderView[], jobs: Job[], prints: Print[], now: number): CustomerSummary[] {
  const groups = new Map(readyToBill(jobs, views, prints, now).map((group) => [group.customer.id, group]));
  return customers.map((customer) => {
    const orders = views.filter((order) => order.customer?.id === customer.id);
    const jobTimes = jobs.filter((job) => job.customer?.id === customer.id).map((job) => job.endsAt);
    const times = [...orders.map((order) => order.updatedAt), ...jobTimes].sort();
    return {
      customer, orders, openBalance: sum(orders.filter((order) => order.status === 'finalized').map((order) => order.outstanding)), lastActivity: times.at(-1) ?? null,
      unbilledJobs: groups.get(customer.id)?.rows.length ?? 0,
    };
  });
}

/** The state of a request together with its order: an issued invoice whose order is paid is done. */
export function requestProgress(request: Pick<InvoiceRequest, 'state' | 'events'>, orderPaid: boolean): { index: number; invalid: boolean } {
  const reached = (kind: string) => request.events.some((event) => event.kind === kind);
  if (request.state === 'draft') return { index: 0, invalid: false };
  if (request.state === 'ready') return { index: 1, invalid: false };
  if (request.state === 'submitted') return { index: 2, invalid: false };
  if (request.state === 'issued') return { index: orderPaid ? 4 : 3, invalid: false };
  // Cancellation: stay on the last step that was reached and mark it.
  return { index: reached('issued') ? 3 : reached('submitted') ? 2 : reached('ready') ? 1 : 0, invalid: true };
}

/** What happens next, taking the order's payment into account. */
export function requestNext(request: InvoiceRequest, orderPaid: boolean): string {
  return request.state === 'issued' && orderPaid ? 'None, the payment is confirmed' : requestNextStep[request.state];
}
