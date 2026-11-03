import { useQueries, useQuery } from '@tanstack/react-query';
import type { Order, OrderPayment } from '../../api/generated/models';
import { reasonKindLabel } from './labels';
import { toCents } from './money';
import { paymentQuery, paymentsSinceQuery } from './queries';

export type PaymentRow = {
  id: string;
  reference: string;
  paymentId: string;
  payment: OrderPayment | undefined;
  /** Cents; negative for a refund or correction. */
  signed: number;
  reversal: boolean;
  note: string;
  reversedBy?: OrderPayment;
};

/**
 * Receipts and refunds that touch an order, newest first, including payments carried over from or to a replacement.
 * The order only lists allocations, so each payment is loaded for its method, time and recorder.
 */
export function useOrderPaymentRows(order: Order, canRead: boolean): PaymentRow[] {
  const ids = [...new Set(order.allocations.flatMap((entry) => (entry.paymentId ? [entry.paymentId] : [])))];
  const loaded = useQueries({ queries: ids.map((id) => ({ ...paymentQuery(id), enabled: canRead })) });
  const payments = new Map<string, OrderPayment>(
    loaded.flatMap((result) => (result.data ? [[result.data.id, result.data] as const] : [])),
  );
  const netOf = (id: string) =>
    order.allocations
      .filter((entry) => entry.paymentId === id)
      .reduce((total, entry) => total + toCents(entry.amount), 0);
  const gone = ids.filter((id) => netOf(id) === 0);
  const since = gone
    .map((id) => payments.get(id)?.occurredAt)
    .filter((value): value is string => !!value)
    .sort()[0];
  const later = useQuery({ ...paymentsSinceQuery(since ?? ''), enabled: canRead && !!since });
  const reversals = new Map<string, OrderPayment>(
    (later.data ?? []).flatMap((payment) =>
      payment.reversesPaymentId ? [[payment.reversesPaymentId, payment] as const] : [],
    ),
  );

  return ids
    .flatMap((id): PaymentRow[] => {
      const mine = order.allocations
        .filter((entry) => entry.paymentId === id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const payment = payments.get(id);
      const net = netOf(id);
      const reference = mine[0]?.paymentReference ?? payment?.reference ?? '';
      const moved = payment?.allocations.find((entry) => entry.orderId !== order.id && toCents(entry.amount) > 0);
      const carried = payment?.allocations.find((entry) => entry.orderId !== order.id && toCents(entry.amount) < 0);
      const reversal = reversals.get(id);
      let note = '';
      if (net > 0 && carried) note = `Carried over from ${carried.orderReference || 'another order'}`;
      else if (net === 0 && moved && !reversal) note = `Moved to ${moved.orderReference}`;
      else if (payment?.method === 'card')
        note = [payment.externalSource, payment.externalReference].filter(Boolean).join(' · ');
      else if (payment?.method === 'external')
        note = payment.externalReference ? `Settles invoice ${payment.externalReference}` : '';
      const receipt: PaymentRow = {
        id,
        reference,
        paymentId: id,
        payment,
        signed: toCents(payment?.amount ?? mine.find((entry) => toCents(entry.amount) > 0)?.amount),
        reversal: false,
        note,
        reversedBy: reversal,
      };
      if (!reversal) return [receipt];
      return [
        receipt,
        {
          id: reversal.id,
          reference: reversal.reference,
          paymentId: reversal.id,
          payment: reversal,
          signed: -toCents(reversal.amount),
          reversal: true,
          note: `${reasonKindLabel(reversal.reasonKind)}: ${reversal.reason}`,
        },
      ];
    })
    .sort((a, b) => (b.payment?.occurredAt ?? '').localeCompare(a.payment?.occurredAt ?? ''));
}
