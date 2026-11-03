import type { ReactNode } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Tag } from '@carbon/react';
import type { Order } from '../../api/generated/models';
import { LinkifiedText, RefLink } from '../../app/RefLink';
import { RichNotification } from '../../app/RichNotification';
import { formatDateTime } from '../../app/dateTime';
import { methodLabel } from './labels';
import { formatCents, formatSignedCents } from './money';
import type { PaymentRow } from './paymentRows';
import { PaymentKindTag } from './status';
import { TableCard } from './TableCard';

/** The payments of an order on its page: receipts, refunds and corrections, newest first. */
export function PaymentsSection({
  order,
  rows,
  notice,
  action,
}: {
  order: Order;
  rows: PaymentRow[];
  /** Why recording is not possible right now, shown as a notice above the list. */
  notice: string | null;
  /** The "Record" button, when recording is possible. */
  action?: ReactNode;
}) {
  const empty =
    order.status === 'draft'
      ? 'Finalize the order to take a payment.'
      : order.activeExternalRequestId
        ? 'Settled through the invoice once wiRef issues it.'
        : 'No payments yet.';
  return (
    <TableCard title="Payments" count={rows.length} action={action}>
      {notice && (
        <RichNotification kind="info" title="Payments paused" className="sales-card-notice">
          <LinkifiedText text={notice} targets={{}} />
        </RichNotification>
      )}
      <Table aria-label="Payments" size="lg">
        <TableHead>
          <TableRow>
            <TableHeader>Time</TableHeader>
            <TableHeader>Payment</TableHeader>
            <TableHeader className="sales-hide-narrow">Method</TableHeader>
            <TableHeader className="sales-hide-narrow">Recorded by</TableHeader>
            <TableHeader className="sales-num">Amount</TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="sales-empty-cell">
                {empty}
              </TableCell>
            </TableRow>
          )}
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell>{row.payment ? formatDateTime(row.payment.occurredAt) : '—'}</TableCell>
              <TableCell>
                <div className="sales-cell">
                  <span className="sales-inline">
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
                  {row.note && <span className="sales-secondary">{row.note}</span>}
                  <span className="sales-secondary sales-show-narrow">
                    {row.payment ? methodLabel(row.payment.method) : ''}
                  </span>
                </div>
              </TableCell>
              <TableCell className="sales-hide-narrow">{row.payment ? methodLabel(row.payment.method) : '—'}</TableCell>
              <TableCell className="sales-hide-narrow">{row.payment?.recordedBy?.displayName ?? '—'}</TableCell>
              <TableCell className="sales-num">
                {row.reversal ? formatSignedCents(row.signed) : formatCents(row.signed)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableCard>
  );
}
