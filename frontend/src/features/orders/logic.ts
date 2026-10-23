import type {
  BillingParty,
  WorkItem,
  CashMovement,
  ExternalInvoiceRequest,
  InvoiceRequestDetails,
  InvoiceRequestEvent,
  Order,
  OrderItem,
  OrderPayment,
  OrderPaymentMethod,
} from '../../api/generated/models';
import { addCalendarDays, dateInAppTimeZone, formatDate, zonedDateTimeToISO } from '../../app/dateTime';
import { formatMoney } from './formatting';
import { methodLabel, requestNextStep } from './labels';
import { toCents } from './money';

// Pure derivations over the orders API types. Settlement itself is derived by the backend and only read here.

export const activeItems = (order: Pick<Order, 'items'>): OrderItem[] => order.items.filter((item) => !item.removedAt);

export const customerLabel = (order: Pick<Order, 'customerName' | 'customerKind'>) =>
  order.customerName || (order.customerKind === 'anonymous' ? 'Anonymous sale' : 'Unnamed customer');

// Order lists ----------------------------------------------------------------------------------------------------------

export type OrderSection = 'open' | 'paid' | 'cancelled';
export const ORDER_SECTIONS: OrderSection[] = ['open', 'paid', 'cancelled'];

export const isPaid = (order: Pick<Order, 'status' | 'settlementState'>) =>
  order.status === 'finalized' && (order.settlementState === 'paid' || order.settlementState === 'no_payment_due');
export const isClosed = (order: Pick<Order, 'status'>) => order.status === 'reversed' || order.status === 'cancelled';
/** Open: not paid and not cancelled or reversed. Paid: paid in full (also by an issued invoice). Cancelled: cancelled or reversed orders, replaced ones included. */
export const sectionOf = (order: Pick<Order, 'status' | 'settlementState'>): OrderSection =>
  isPaid(order) ? 'paid' : isClosed(order) ? 'cancelled' : 'open';
export const isAwaitingPayment = (order: Pick<Order, 'status' | 'outstandingAmount'>) =>
  order.status === 'finalized' && toCents(order.outstandingAmount) > 0;

export type OrderStatusKey =
  'draft' | 'awaiting_payment' | 'partially_paid' | 'paid' | 'no_payment_due' | 'reversed' | 'cancelled';
/** The one combined order status used by every list, header and tile: lifecycle first, then settlement. */
export function orderStatusKey(order: Pick<Order, 'status' | 'settlementState'>): OrderStatusKey {
  if (order.status === 'draft') return 'draft';
  if (order.status === 'cancelled') return 'cancelled';
  if (order.status === 'reversed') return 'reversed';
  return order.settlementState === 'paid'
    ? 'paid'
    : order.settlementState === 'no_payment_due'
      ? 'no_payment_due'
      : order.settlementState === 'partially_paid'
        ? 'partially_paid'
        : 'awaiting_payment';
}

/** The Invoice filter category: one value per order, taken from its active request, or "cancelled" when its latest request was cancelled. A cancellation request counts as issued. */
export type InvoiceKey = 'none' | 'draft' | 'submitted' | 'issued' | 'cancelled';
export const INVOICE_KEYS: InvoiceKey[] = ['none', 'draft', 'submitted', 'issued', 'cancelled'];
export function invoiceKey(
  order: Pick<Order, 'activeExternalRequestState' | 'latestExternalRequestState'>,
): InvoiceKey {
  const state = order.activeExternalRequestState;
  if (!state) return order.latestExternalRequestState === 'cancelled' ? 'cancelled' : 'none';
  return state === 'cancellation_requested'
    ? 'issued'
    : state === 'draft' || state === 'submitted' || state === 'issued'
      ? state
      : 'none';
}

/** An old draft nobody touched. */
export const DRAFT_STALE_DAYS = 7;
export const isStaleDraft = (order: Pick<Order, 'status' | 'updatedAt'>, now = Date.now()) =>
  order.status === 'draft' && now - new Date(order.updatedAt).getTime() > DRAFT_STALE_DAYS * 86_400_000;

/** Cash and card are accepted until the invoice request is submitted for approval; an issued invoice settles the balance by itself. */
export function acceptsCashAndCard(order: Pick<Order, 'activeExternalRequestState'>): boolean {
  const state = order.activeExternalRequestState;
  return !state || state === 'draft';
}

/** The event that cancelled a request: the wiRef reference and procedure when wiRef cancelled it, otherwise the local reason. */
export const cancellationOf = (request: Pick<ExternalInvoiceRequest, 'events'>): InvoiceRequestEvent | null =>
  [...request.events].reverse().find((event) => event.kind === 'cancelled') ?? null;

/** Why no invoice can be requested for this order right now, or null. */
export function invoiceRequestBlocker(
  order: Pick<
    Order,
    'status' | 'customerKind' | 'totalAmount' | 'activeExternalRequestId' | 'activeExternalRequestReference'
  >,
): string | null {
  if (order.status !== 'finalized') return 'The order is not finalized';
  if (order.customerKind === 'anonymous') return 'Invoices need a named customer';
  if (toCents(order.totalAmount) <= 0) return 'Nothing is charged, so there is nothing to invoice';
  if (order.activeExternalRequestId)
    return `${order.activeExternalRequestReference ?? 'A request'} is already active for this order`;
  return null;
}

// Receipt --------------------------------------------------------------------------------------------------------------

/** A receipt can be printed for a finalized order that has been paid, in part or in full. */
export const canPrintReceipt = (order: Pick<Order, 'status' | 'settledAmount'>) =>
  order.status === 'finalized' && toCents(order.settledAmount) > 0;

/** The payments that count towards an order, with the net amount each contributes (refunded and reversed ones drop out). */
export function receiptPaymentShares(
  order: Pick<Order, 'allocations'>,
): Array<{ paymentId: string; reference: string; amount: number }> {
  const shares = new Map<string, { paymentId: string; reference: string; amount: number; at: string }>();
  for (const entry of order.allocations) {
    if (!entry.paymentId) continue;
    const share = shares.get(entry.paymentId) ?? {
      paymentId: entry.paymentId,
      reference: entry.paymentReference,
      amount: 0,
      at: entry.createdAt,
    };
    share.amount += toCents(entry.amount);
    if (entry.createdAt < share.at) share.at = entry.createdAt;
    shares.set(entry.paymentId, share);
  }
  return [...shares.values()]
    .filter((share) => share.amount > 0)
    .sort((a, b) => a.at.localeCompare(b.at))
    .map(({ paymentId, reference, amount }) => ({ paymentId, reference, amount }));
}

// Payments -------------------------------------------------------------------------------------------------------------

/** The order a payment is allocated to now (a positive net allocation), else the first one it was allocated to. */
export function allocatedOrder(
  allocations: Array<{ orderId?: string | null; orderReference: string; amount: string }>,
): { id: string | null; reference: string } | null {
  const live = new Map<string, { reference: string; cents: number }>();
  for (const entry of allocations) {
    if (!entry.orderId) continue;
    const current = live.get(entry.orderId) ?? { reference: entry.orderReference, cents: 0 };
    live.set(entry.orderId, { reference: current.reference, cents: current.cents + toCents(entry.amount) });
  }
  const positive = [...live.entries()].find(([, value]) => value.cents > 0);
  const chosen = positive ?? [...live.entries()][0];
  return chosen ? { id: chosen[0], reference: chosen[1].reference } : null;
}

/** payment id -> the order it counts towards (or last counted towards), from the allocations of every known order. */
export function paymentOrderIndex(orders: Order[]): Map<string, string> {
  const entries = orders.flatMap((order) =>
    order.allocations
      .filter((entry) => entry.paymentId)
      .map((entry) => ({ ...entry, orderId: order.id, orderReference: order.reference })),
  );
  const byPayment = new Map<string, typeof entries>();
  for (const entry of entries) byPayment.set(entry.paymentId!, [...(byPayment.get(entry.paymentId!) ?? []), entry]);
  const index = new Map<string, string>();
  for (const [paymentId, list] of byPayment) {
    const found = allocatedOrder(list);
    if (found?.id) index.set(paymentId, found.id);
  }
  return index;
}

/** Net takings per method for payments already limited to a window: receipts minus reversals, by the time they occurred. */
export function takings(
  payments: Array<Pick<OrderPayment, 'entryKind' | 'method' | 'amount'>>,
): Record<OrderPaymentMethod, number> & { total: number } {
  const result = { cash: 0, card: 0, external: 0 };
  for (const payment of payments)
    result[payment.method] += payment.entryKind === 'receipt' ? toCents(payment.amount) : -toCents(payment.amount);
  return { ...result, total: result.cash + result.card + result.external };
}

// Cashbook -------------------------------------------------------------------------------------------------------------

export type PeriodPreset = 'all' | 'today' | 'yesterday' | 'week' | 'month' | 'custom';
/** The cashbook shows everything from the beginning unless another period is chosen. */
export const defaultPeriodPreset: PeriodPreset = 'all';
export const periodPresets: { id: PeriodPreset; label: string }[] = [
  { id: 'all', label: 'All time' },
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'week', label: 'This week' },
  { id: 'month', label: 'This month' },
  { id: 'custom', label: 'Custom' },
];
const midnight = (day: string) => new Date(zonedDateTimeToISO(day, '00:00')).getTime();

/** A period in the app time zone as [from, to) instants. `from` and `to` of a custom range are inclusive calendar days. */
export function periodRange(
  preset: PeriodPreset,
  from = '',
  to = '',
  now = new Date(),
): { from: number; to: number; label: string; valid: boolean } {
  const today = dateInAppTimeZone(now);
  if (preset === 'all') return { from: 0, to: midnight(addCalendarDays(today, 1)), label: 'All time', valid: true };
  if (preset === 'today')
    return { from: midnight(today), to: midnight(addCalendarDays(today, 1)), label: 'Today', valid: true };
  if (preset === 'yesterday')
    return { from: midnight(addCalendarDays(today, -1)), to: midnight(today), label: 'Yesterday', valid: true };
  if (preset === 'week') {
    const weekday = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7;
    return {
      from: midnight(addCalendarDays(today, -weekday)),
      to: midnight(addCalendarDays(today, 1)),
      label: 'This week',
      valid: true,
    };
  }
  if (preset === 'month')
    return {
      from: midnight(`${today.slice(0, 8)}01`),
      to: midnight(addCalendarDays(today, 1)),
      label: 'This month',
      valid: true,
    };
  const valid = !!from && !!to && from <= to;
  return {
    from: from ? midnight(from) : 0,
    to: to ? midnight(addCalendarDays(to, 1)) : 0,
    label: valid ? `${from} to ${to}` : 'Custom range',
    valid,
  };
}

/** "All time · up to 19.10.2026", "Today · 19.10.2026", "This week · 12.10.2026 to 19.10.2026", "Custom range · 01.10.2026 to 05.10.2026". */
export function periodText(
  preset: PeriodPreset,
  range: ReturnType<typeof periodRange>,
  from: string,
  to: string,
): string {
  if (!range.valid) return 'Custom range · choose both dates';
  if (preset === 'all') return `All time · up to ${formatDate(new Date(range.to - 1).toISOString())}`;
  if (preset === 'custom')
    return `Custom range · ${formatDate(`${from}T12:00:00Z`)} to ${formatDate(`${to}T12:00:00Z`)}`;
  const start = formatDate(new Date(range.from).toISOString());
  return `${range.label} · ${preset === 'today' || preset === 'yesterday' ? start : `${start} to ${formatDate(new Date(range.to - 1).toISOString())}`}`;
}

export type PaymentLine = {
  type: 'payment';
  id: string;
  at: string;
  reference: string;
  payment: OrderPayment;
  order: Order | null;
  orderId: string | null;
  orderReference: string | null;
  customerLabel: string;
  customerKind: string | null;
  customerId: string | null;
  signed: number;
  method: OrderPaymentMethod;
  recordedBy: string;
};
export type MovementLine = {
  type: 'movement';
  id: string;
  at: string;
  reference: string;
  movement: CashMovement;
  signed: number;
  method: 'cash';
  recordedBy: string;
};
/** One line of the cashbook: a payment (receipt, refund or correction) or a cash movement that is not tied to an order. */
export type CashbookLine = PaymentLine | MovementLine;

export function cashbookLines(
  payments: OrderPayment[],
  movements: CashMovement[],
  orders: Order[] | undefined,
): CashbookLine[] {
  const byId = new Map((orders ?? []).map((order) => [order.id, order]));
  const index = orders ? paymentOrderIndex(orders) : new Map<string, string>();
  const paymentLines = payments.map((payment): CashbookLine => {
    const sourceId = payment.entryKind === 'reversal' ? (payment.reversesPaymentId ?? payment.id) : payment.id;
    const own = allocatedOrder(payment.allocations);
    const order = byId.get(index.get(sourceId) ?? own?.id ?? '') ?? null;
    return {
      type: 'payment',
      id: payment.id,
      at: payment.occurredAt,
      reference: payment.reference,
      payment,
      order,
      orderId: order?.id ?? own?.id ?? null,
      orderReference: order?.reference ?? own?.reference ?? null,
      customerLabel: order ? customerLabel(order) : '—',
      customerKind: order?.customerKind ?? null,
      customerId: order?.customer?.id ?? null,
      signed: payment.entryKind === 'receipt' ? toCents(payment.amount) : -toCents(payment.amount),
      method: payment.method,
      recordedBy: payment.recordedBy?.displayName ?? '—',
    };
  });
  const movementLines = movements.map((movement): CashbookLine => ({
    type: 'movement',
    id: movement.id,
    at: movement.occurredAt,
    reference: movement.reference,
    movement,
    signed: movement.kind === 'deposit' ? toCents(movement.amount) : -toCents(movement.amount),
    method: 'cash',
    recordedBy: movement.recordedBy?.displayName ?? '—',
  }));
  return [...paymentLines, ...movementLines].sort(
    (a, b) => b.at.localeCompare(a.at) || b.reference.localeCompare(a.reference),
  );
}

/** The filter id of a line's kind: receipt, refund, correction, withdrawal or deposit. */
export const lineKindId = (line: CashbookLine): string =>
  line.type === 'movement'
    ? line.movement.kind
    : line.payment.entryKind === 'receipt'
      ? 'receipt'
      : line.payment.reasonKind === 'refund'
        ? 'refund'
        : 'correction';

export function describePaymentHistory(
  payment: OrderPayment,
  original: OrderPayment | undefined,
  reversal: OrderPayment | undefined,
  formatAt: (value: string) => string,
): Array<{ at: string; text: string }> {
  const source = payment.entryKind === 'reversal' ? original : payment;
  const lines: Array<{ at: string; text: string }> = [];
  if (source) {
    lines.push({
      at: source.occurredAt,
      text: `${methodLabel(source.method)} payment of ${formatMoney(source.amount)} received at ${formatAt(source.occurredAt)}.`,
    });
    const operations = new Map<string, typeof source.allocations>();
    for (const entry of [...source.allocations].sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
      operations.set(entry.operationId, [...(operations.get(entry.operationId) ?? []), entry]);
    let first = true;
    for (const group of operations.values()) {
      const added = group.filter((entry) => toCents(entry.amount) > 0);
      const removed = group.filter((entry) => toCents(entry.amount) < 0);
      const at = group[0].createdAt;
      if (first && added.length && !removed.length) {
        lines.push({ at, text: `Counted towards ${added[0].orderReference}.` });
        first = false;
        continue;
      }
      first = false;
      if (removed.length && added.length && removed[0].orderId !== added[0].orderId)
        lines.push({
          at,
          text: `Moved from ${removed[0].orderReference} to ${added[0].orderReference} when the order was replaced. No money moved.`,
        });
      else if (removed.length)
        lines.push({
          at,
          text: `Taken off ${removed[0].orderReference}${reversal ? ` by ${reversal.reference}` : ''}.`,
        });
    }
  }
  const undo = payment.entryKind === 'reversal' ? payment : reversal;
  if (undo)
    lines.push({
      at: undo.occurredAt,
      text: `${undo.reasonKind === 'refund' ? 'Refunded' : 'Corrected'} by ${undo.reference}: ${undo.reason}`,
    });
  return lines.sort((a, b) => a.at.localeCompare(b.at));
}

// wiRef readiness ------------------------------------------------------------------------------------------------------

export type ReadinessItem = { key: string; label: string; ok: boolean; hint: string };
const text = (value: string | undefined) => (value ?? '').trim();

/** What has to be filled in before a wiRef request can be submitted for approval and forwarded. */
export function requestReadiness(
  details: InvoiceRequestDetails,
  customerKind: string,
  requirePurchaseOrder: boolean,
): ReadinessItem[] {
  const items: ReadinessItem[] = [
    {
      key: 'recipient',
      label: 'Recipient name',
      ok: text(details.recipientName) !== '',
      hint: 'Who receives the invoice',
    },
    {
      key: 'address',
      label: 'Billing address',
      ok: text(details.addressLine1) !== '' && text(details.postalCode) !== '' && text(details.locality) !== '',
      hint: 'Street, postal code and town',
    },
    {
      key: 'country',
      label: 'Country',
      ok: /^[A-Za-z]{2}$/.test(text(details.countryCode)),
      hint: 'Two-letter code, e.g. AT',
    },
  ];
  if (customerKind === 'organization')
    items.push({
      key: 'contact',
      label: 'Contact person',
      ok: text(details.contactName) !== '',
      hint: 'Organizations need someone to address the invoice to',
    });
  if (customerKind === 'organization' && requirePurchaseOrder)
    items.push({
      key: 'po',
      label: 'Purchase order reference',
      ok: text(details.purchaseOrderReference) !== '',
      hint: 'This organization requires one on every invoice',
    });
  items.push(
    {
      key: 'period',
      label: 'Service period',
      ok: !!details.serviceStartsOn && !!details.serviceEndsOn && details.serviceStartsOn <= details.serviceEndsOn,
      hint: 'Start and end date, in order',
    },
    {
      key: 'description',
      label: 'Service description',
      ok: text(details.serviceDescription) !== '',
      hint: 'What the invoice is for',
    },
  );
  return items;
}

export const INVOICE_STEPS = ['Draft', 'Awaiting approval', 'Issued'] as const;

/** Where a request is on the progress indicator. An issued request completes all steps; a cancellation marks the last step that was reached. */
export function requestProgress(request: Pick<ExternalInvoiceRequest, 'state' | 'events'>): {
  index: number;
  invalid: boolean;
} {
  if (request.state === 'draft') return { index: 0, invalid: false };
  if (request.state === 'submitted') return { index: 1, invalid: false };
  if (request.state === 'issued') return { index: INVOICE_STEPS.length, invalid: false };
  let reached = 0;
  for (const event of request.events) {
    if (event.kind === 'submitted') reached = 1;
    else if (event.kind === 'returned') reached = 0;
    else if (event.kind === 'issued') reached = 2;
  }
  return { index: reached, invalid: true };
}

/** The comment the approver left when returning the request, while it is a draft again. It disappears when the request is submitted again. */
export function latestReturn(request: Pick<ExternalInvoiceRequest, 'state' | 'events'>): InvoiceRequestEvent | null {
  if (request.state !== 'draft') return null;
  for (let index = request.events.length - 1; index >= 0; index -= 1) {
    const event = request.events[index];
    if (event.kind === 'returned') return event;
    if (event.kind === 'submitted') return null;
  }
  return null;
}

/** The wiRef invoice number, if one was recorded (the latest correction wins). */
export const invoiceNumberOf = (request: Pick<ExternalInvoiceRequest, 'events'>): InvoiceRequestEvent | null =>
  [...request.events]
    .reverse()
    .find(
      (event) =>
        (event.kind === 'reference_added' || event.kind === 'reference_corrected') && !!event.externalReference,
    ) ?? null;

/** What happens next, taking the order's payment into account. */
export function requestNext(
  request: Pick<ExternalInvoiceRequest, 'state' | 'events'>,
  orderPaid: boolean,
  detailsComplete?: boolean,
): string {
  if (request.state === 'issued' && orderPaid) return 'Complete, invoice paid';
  if (request.state === 'draft') {
    const returned = latestReturn(request) !== null;
    if (detailsComplete) return returned ? 'Submit for approval again' : 'Submit for approval';
    return returned ? 'Correct what the approver asked for' : requestNextStep.draft;
  }
  return requestNextStep[request.state];
}

/** The invoice data as plain text for pasting into wiRef. The bank-transfer note stays a placeholder until the wording exists. */
export function wiRefCopyText(request: ExternalInvoiceRequest): string {
  const d = request.details;
  const toPay = Math.max(0, toCents(request.requestedAmount) - toCents(request.alreadyPaid));
  const day = (value: string | undefined) => (value ? formatDate(`${value}T12:00:00Z`) : '—');
  const lines = [
    `Order: ${request.orderReference}`,
    `Invoice request: ${request.reference}`,
    '',
    `Recipient: ${d.recipientName ?? ''}`,
    ...(d.contactName ? [`Contact person: ${d.contactName}`] : []),
    'Address:',
    `  ${d.addressLine1 ?? ''}`,
    ...(d.addressLine2 ? [`  ${d.addressLine2}`] : []),
    `  ${`${d.postalCode ?? ''} ${d.locality ?? ''}`.trim()}`,
    `  Country: ${(d.countryCode ?? '').toUpperCase()}`,
    ...(d.purchaseOrderReference ? [`Purchase order: ${d.purchaseOrderReference}`] : []),
    '',
    `Service period: ${day(d.serviceStartsOn)} to ${day(d.serviceEndsOn)}`,
    `Service description: ${d.serviceDescription ?? ''}`,
    '',
    'Items:',
    ...request.itemSummary.map(
      (item, index) =>
        `${index + 1}. ${item.description} · ${item.quantity} ${item.unit} · ${formatMoney(item.unitPrice)} · ${formatMoney(item.amount)}`,
    ),
    '',
    `Total: ${formatMoney(request.requestedAmount)}`,
    `Already paid (cash or card): ${formatMoney(request.alreadyPaid)}`,
    `Still to pay (by bank transfer to HTU): ${formatMoney((toPay / 100).toFixed(2))}`,
    '',
    'Bank transfer note: [HTU bank-transfer note to be defined]',
  ];
  return lines.join('\n');
}

// Jobs ready to bill ---------------------------------------------------------------------------------------------------

export type ReadyRow = { job: WorkItem; price: number | null; reason: string | null };
export type ReadyGroup = {
  key: string;
  customer: BillingParty | null;
  rows: ReadyRow[];
  ready: ReadyRow[];
  total: number;
  oldestEnd: string;
};

/** Finished jobs without an order, grouped by customer. Jobs that cannot be charged yet stay visible with their reason. */
export function readyToBillGroups(jobs: WorkItem[]): ReadyGroup[] {
  const groups = new Map<string, ReadyGroup>();
  for (const job of jobs) {
    const reason = !job.customer
      ? 'Choose a customer first'
      : job.effectivePrice == null
        ? 'The price is not set'
        : job.version == null
          ? 'The job cannot be charged'
          : null;
    const row: ReadyRow = { job, price: job.effectivePrice == null ? null : toCents(job.effectivePrice), reason };
    const key = job.customer?.id ?? 'none';
    const end = job.endsAt ?? job.startedAt;
    const group = groups.get(key) ?? {
      key,
      customer: job.customer ?? null,
      rows: [],
      ready: [],
      total: 0,
      oldestEnd: end,
    };
    group.rows.push(row);
    if (!reason) {
      group.ready.push(row);
      group.total += row.price ?? 0;
    }
    if (end < group.oldestEnd) group.oldestEnd = end;
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      rows: group.rows.sort((a, b) => (b.job.endsAt ?? b.job.startedAt).localeCompare(a.job.endsAt ?? a.job.startedAt)),
    }))
    .sort((a, b) => a.oldestEnd.localeCompare(b.oldestEnd));
}
export const readyTotals = (groups: ReadyGroup[]) => ({
  jobs: groups.reduce((n, g) => n + g.ready.length, 0),
  customers: groups.filter((g) => g.ready.length > 0).length,
  total: groups.reduce((n, g) => n + g.total, 0),
});

// Refund or correct ----------------------------------------------------------------------------------------------------

export type ReversalOptions = {
  kinds: Array<'refund' | 'recording_error' | 'external_correction'>;
  /** The payment cannot be refunded or corrected at all right now. */
  blocker: string | null;
  /** The correction is possible, but only after something else happens (cancel the wiRef request). */
  prerequisite: string | null;
};

/** Which reasons a receipt can be undone with, and what stands in the way. Mirrors the backend so the dialog never offers an option that fails. */
export function reversalOptions(
  payment: OrderPayment,
  reversal: OrderPayment | undefined,
  order: Order | null,
): ReversalOptions {
  const none = (blocker: string): ReversalOptions => ({ kinds: [], blocker, prerequisite: null });
  if (payment.entryKind !== 'receipt')
    return none('Only receipts can be refunded or corrected. This entry is itself a reversal.');
  if (reversal) return none(`${reversal.reference} already reversed this payment.`);
  if (!order) return none('This payment is not allocated to an order you can see.');
  const counts =
    payment.allocations
      .filter((entry) => entry.orderId === order.id)
      .reduce((total, entry) => total + toCents(entry.amount), 0) > 0;
  if (!counts) return none('This payment no longer counts towards an order. Open the order it moved to.');
  if (order.status !== 'finalized')
    return none(
      `${order.reference} is ${order.status === 'reversed' ? 'reversed' : 'not finalized'}, so there is nothing to refund here.`,
    );
  if (order.customerKind === 'anonymous')
    return none('An anonymous sale must stay fully paid. Reverse the whole order from its page instead.');
  const state = order.activeExternalRequestState;
  if (payment.method === 'external') {
    return {
      kinds: ['external_correction'],
      blocker: null,
      prerequisite: state ? `${order.activeExternalRequestReference} has to be cancelled in wiRef first.` : null,
    };
  }
  return {
    kinds: ['refund', 'recording_error'],
    blocker: null,
    prerequisite:
      state && state !== 'draft'
        ? `${order.activeExternalRequestReference} states what was already paid, so it has to be cancelled first.`
        : null,
  };
}

/** The refusal of a finalization (409 insufficient_stock): which article is short and how much loose stock there is. Null for any other error. */
export function insufficientStock(error: unknown): { materialId: string; available: string } | null {
  const data = error as {
    status?: number;
    data?: { code?: string; details?: { materialId?: unknown; available?: unknown } };
  } | null;
  if (data?.status !== 409 || data.data?.code !== 'insufficient_stock') return null;
  const details = data.data.details;
  return {
    materialId: typeof details?.materialId === 'string' ? details.materialId : '',
    available:
      typeof details?.available === 'string' || typeof details?.available === 'number' ? String(details.available) : '',
  };
}
