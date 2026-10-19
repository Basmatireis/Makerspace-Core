import { Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow, Tag } from '@carbon/react';
import { allocationSum, type OrderView } from '../logic';
import { formatDateTime, formatEur, formatSignedEur } from '../format';
import { methodLabel, reasonKindLabel } from '../labels';
import { PaymentKindTag } from '../status';
import { LinkifiedText, RefLink, RichNotification } from '../../components/RefLink';
import type { Allocation, Order, Payment } from '../types';

type Props = {
  order: OrderView; orders: Order[]; payments: Payment[]; allocations: Allocation[];
  /** Why recording is not possible right now, shown as a notice inside the list. Recording itself is the page's primary action. */
  recordBlocked: string | null;
};

/** Receipts and refunds that touch this order, including payments carried over from or to a replacement. */
export function PaymentsSection({ order, orders, payments, allocations, recordBlocked }: Props) {
  const touching = payments.filter((payment) => allocations.some((allocation) => allocation.paymentId === payment.id && allocation.orderId === order.id)
    || (payment.entryKind === 'reversal' && allocations.some((allocation) => allocation.paymentId === payment.id && allocation.orderId === order.id)))
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  const orderRef = (id: string) => orders.find((candidate) => candidate.id === id)?.reference ?? 'another order';

  const note = (payment: Payment) => {
    if (payment.entryKind === 'reversal') return `${reasonKindLabel(payment.reasonKind!)}: ${payment.reason}`;
    const mine = allocations.filter((allocation) => allocation.paymentId === payment.id).sort((a, b) => a.at.localeCompare(b.at));
    const net = allocationSum(allocations, order.id, payment.id);
    const origin = mine[0]?.orderId;
    if (origin && origin !== order.id && net > 0) return `Carried over from ${orderRef(origin)}`;
    const moved = mine.find((allocation) => allocation.orderId !== order.id);
    if (net === 0 && moved && !payments.some((other) => other.reversesPaymentId === payment.id)) return `Moved to ${orderRef(moved.orderId)}`;
    return payment.method === 'card' ? `${payment.terminal} · ${payment.transactionReference}` : payment.method === 'external' ? `Settles invoice ${payment.transactionReference}` : '';
  };

  return (
    <TableContainer
      title="Payments" description={order.status === 'draft' ? 'Payments can be recorded once the order is finalized.' : 'Receipts are never edited. A mistake is undone by a reversal that stays on the record.'}
    >
      <Table aria-label="Payments of this order">
        <TableHead>
          <TableRow><TableHeader>Payment</TableHeader><TableHeader>Method</TableHeader><TableHeader>Time</TableHeader><TableHeader className="sales-num">Amount</TableHeader><TableHeader className="mj-hide-narrow">Recorded by</TableHeader></TableRow>
        </TableHead>
        <TableBody>
          {recordBlocked && (
            <TableRow className="sales-table-notice">
              <TableCell colSpan={5}><RichNotification kind="info" title="Payments paused" className="sales-table-notice__box"><LinkifiedText text={recordBlocked} /></RichNotification></TableCell>
            </TableRow>
          )}
          {touching.length === 0 && <TableRow><TableCell colSpan={5}>No payments yet.</TableCell></TableRow>}
          {touching.map((payment) => {
            const detail = note(payment);
            const reversed = payments.find((other) => other.reversesPaymentId === payment.id);
            const signed = payment.entryKind === 'reversal' ? -payment.amount : payment.amount;
            return (
              <TableRow key={payment.id}>
                <TableCell>
                  <div className="mj-cell-stack">
                    <span className="mj-inline">
                      <RefLink reference={payment.reference} id={payment.id} /><PaymentKindTag payment={payment} />
                      {reversed && <><Tag type="warm-gray" size="sm">Reversed by</Tag><RefLink reference={reversed.reference} id={reversed.id} /></>}
                    </span>
                    {detail && <span className="mj-secondary"><LinkifiedText text={detail} /></span>}
                  </div>
                </TableCell>
                <TableCell>{methodLabel(payment.method)}</TableCell>
                <TableCell>{formatDateTime(payment.occurredAt)}</TableCell>
                <TableCell className="sales-num">{payment.entryKind === 'reversal' ? formatSignedEur(signed) : formatEur(signed)}</TableCell>
                <TableCell className="mj-hide-narrow">{payment.recordedBy}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
