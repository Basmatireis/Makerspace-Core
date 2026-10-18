import { effectivePrice, isManualRunning } from '../derived';
import { runsOfJob } from '../runs';
import type { BillingParty, Job, Print } from '../types';
import { addCalendarDays, zonedDateTimeToISO } from '../../../app/dateTime';
import { dateInAppTimeZone, round2 } from './format';
import type { Allocation, InvoiceRequest, Order, OrderAdjustment, OrderItem, Payment, PaymentMethod, SettlementState } from './types';

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
