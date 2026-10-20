import { Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow, Tag } from '@carbon/react';
import { useQueries, useQuery } from '@tanstack/react-query';
import type { Order, OrderPayment } from '../../api/generated/models';
import { LinkifiedText, RefLink } from '../../app/RefLink';
import { RichNotification } from '../../app/RichNotification';
import { formatDateTime } from '../../app/dateTime';
import { methodLabel, reasonKindLabel } from './labels';
import { formatCents, formatSignedCents, toCents } from './money';
import { paymentQuery, paymentsSinceQuery } from './queries';
import { PaymentKindTag } from './status';

type Row = {
  id: string;
  reference: string;
  paymentId: string;
  payment: OrderPayment | undefined;
  signed: number;
  reversal: boolean;
  note: string;
  reversedBy?: OrderPayment;
};

/** Receipts and refunds that touch this order, including payments carried over from or to a replacement. */
export function PaymentsSection({
  order,
  notice,
  canRead,
}: {
  order: Order;
  /** Why recording is not possible right now, shown as a notice inside the list. Recording itself is the page's primary action. */
  notice: string | null;
  canRead: boolean;
}) {
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

  const rows: Row[] = ids
    .flatMap((id): Row[] => {
      const mine = order.allocations
        .filter((entry) => entry.paymentId === id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const payment = payments.get(id);
      const net = netOf(id);
      const reference = mine[0]?.paymentReference ?? payment?.reference ?? '';
      const origin = mine[0];
      const moved = payment?.allocations.find((entry) => entry.orderId !== order.id && toCents(entry.amount) > 0);
      const reversal = reversals.get(id);
      let note = '';
      if (net > 0 && origin && toCents(origin.amount) < 0) note = '';
      if (
        net > 0 &&
        payment &&
        payment.allocations.some((entry) => entry.orderId !== order.id && toCents(entry.amount) < 0)
      ) {
        const from = payment.allocations.find((entry) => entry.orderId !== order.id && toCents(entry.amount) < 0);
        note = `Carried over from ${from?.orderReference ?? 'another order'}`;
      } else if (net === 0 && moved && !reversal) note = `Moved to ${moved.orderReference}`;
      else if (payment?.method === 'card')
        note = [payment.externalSource, payment.externalReference].filter(Boolean).join(' · ');
      else if (payment?.method === 'external')
        note = payment.externalReference ? `Settles invoice ${payment.externalReference}` : '';
      const receipt: Row = {
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

  return (
    <TableContainer
      title="Payments"
      description={
        order.status === 'draft'
          ? 'Payments can be recorded once the order is finalized.'
          : 'Receipts are never edited. A mistake is undone by a reversal that stays on the record.'
      }
    >
      <Table aria-label="Payments of this order">
        <TableHead>
          <TableRow>
            <TableHeader>Payment</TableHeader>
            <TableHeader>Method</TableHeader>
            <TableHeader>Time</TableHeader>
            <TableHeader className="sales-num">Amount</TableHeader>
            <TableHeader className="mj-hide-narrow">Recorded by</TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          {notice && (
            <TableRow className="sales-table-notice">
              <TableCell colSpan={5}>
                <RichNotification kind="info" title="Payments paused" className="sales-table-notice__box">
                  <LinkifiedText text={notice} targets={{}} />
                </RichNotification>
              </TableCell>
            </TableRow>
          )}
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={5}>No payments yet.</TableCell>
            </TableRow>
          )}
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell>
                <div className="mj-cell-stack">
                  <span className="mj-inline">
                    <RefLink reference={row.reference} id={row.paymentId} kind="payment" />
                    {row.payment && <PaymentKindTag payment={row.payment} />}
                    {row.reversedBy && (
                      <>
                        <Tag type="warm-gray" size="sm">
                          Reversed by
                        </Tag>
                        <RefLink reference={row.reversedBy.reference} id={row.reversedBy.id} kind="payment" />
                      </>
                    )}
                  </span>
                  {row.note && <span className="mj-secondary">{row.note}</span>}
                </div>
              </TableCell>
              <TableCell>{row.payment ? methodLabel(row.payment.method) : '—'}</TableCell>
              <TableCell>{row.payment ? formatDateTime(row.payment.occurredAt) : '—'}</TableCell>
              <TableCell className="sales-num">
                {row.reversal ? formatSignedCents(row.signed) : formatCents(row.signed)}
              </TableCell>
              <TableCell className="mj-hide-narrow">{row.payment?.recordedBy?.displayName ?? '—'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
