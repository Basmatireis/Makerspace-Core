import type { ReactNode } from 'react';
import { Link as CarbonLink } from '@carbon/react';
import { Link } from 'react-router-dom';
import type { Order } from '../../api/generated/models';
import { StackCard } from '../../app/components/CardList';
import { RefLink } from '../../app/RefLink';
import { formatDateTime } from '../../app/dateTime';
import { customerKindLabel, methodLabel, requestStateLabel } from './labels';
import { activeItems, customerLabel } from './logic';
import { formatCents, sumCents, toCents } from './money';
import type { PaymentRow } from './paymentRows';

/** What is owed: the hero amount (outstanding, or the total of a draft) and how it is made up. */
export function BalanceCard({ order, rows, action }: { order: Order; rows: PaymentRow[]; action?: ReactNode }) {
  const draft = order.status === 'draft';
  const total = sumCents(activeItems(order).map((item) => item.amount));
  const outstanding = toCents(order.outstandingAmount);
  const state = order.activeExternalRequestState;
  const line = draft
    ? 'Draft · prices are frozen when you finalize'
    : order.status === 'cancelled'
      ? 'Cancelled · never charged'
      : order.status === 'reversed'
        ? 'Reversed · nothing owed'
        : outstanding > 0
          ? order.activeExternalRequestId
            ? `Open · invoice ${order.activeExternalRequestReference} ${(requestStateLabel[state as keyof typeof requestStateLabel] ?? state ?? '').toLowerCase()}`
            : 'Open · take payment in cash or by card'
          : toCents(order.netCharge) === 0
            ? 'No payment due'
            : 'Settled';
  // Each payment counts with what is allocated to this order, so moved and reversed receipts drop out.
  const counted = rows
    .filter((row) => !row.reversal)
    .map((row) => ({
      row,
      net: order.allocations
        .filter((entry) => entry.paymentId === row.paymentId)
        .reduce((sum, entry) => sum + toCents(entry.amount), 0),
    }))
    .filter((entry) => entry.net !== 0);
  return (
    <StackCard title="Balance" action={action} className="sales-balance">
      <p className="sales-hero">{formatCents(draft ? total : outstanding)}</p>
      <p className="sales-secondary">{line}</p>
      <dl className="sales-summary sales-summary--amounts">
        <div>
          <dt>Items</dt>
          <dd>{formatCents(total)}</dd>
        </div>
        {order.adjustments.map((adjustment) => (
          <div key={adjustment.id}>
            <dt>Reversal {adjustment.reference}</dt>
            <dd>−{formatCents(Math.abs(toCents(adjustment.amount)))}</dd>
          </div>
        ))}
        {counted.map(({ row, net }) => (
          <div key={row.id}>
            <dt>
              {row.payment ? methodLabel(row.payment.method) : row.reference}
              {row.payment && ` · ${formatDateTime(row.payment.occurredAt)}`}
            </dt>
            <dd>{net > 0 ? `−${formatCents(net)}` : `+${formatCents(-net)}`}</dd>
          </div>
        ))}
        <div className="sales-summary__total">
          <dt>{draft ? 'Total' : 'Outstanding'}</dt>
          <dd>{formatCents(draft ? total : outstanding)}</dd>
        </div>
      </dl>
    </StackCard>
  );
}

/** Who pays, how the order is handed over and its history. */
export function CustomerCard({ order, action }: { order: Order; action?: ReactNode }) {
  return (
    <StackCard title="Customer" action={action}>
      <dl className="sales-summary">
        <div>
          <dt>Name</dt>
          <dd>
            {order.customer ? (
              <CarbonLink as={Link} to={`/orders?customer=${order.customer.id}`}>
                {customerLabel(order)}
              </CarbonLink>
            ) : (
              customerLabel(order)
            )}
          </dd>
        </div>
        <div>
          <dt>Type</dt>
          <dd>{customerKindLabel(order.customerKind)}</dd>
        </div>
        <div>
          <dt>Hand-over</dt>
          <dd>{order.fulfillmentMode === 'immediate' ? 'Handed over' : 'Picks up later'}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>
            {formatDateTime(order.createdAt)}
            {order.createdBy && <span className="sales-secondary"> · {order.createdBy.displayName}</span>}
          </dd>
        </div>
        <div>
          <dt>Last change</dt>
          <dd>{formatDateTime(order.updatedAt)}</dd>
        </div>
        {order.replacesOrderId && (
          <div>
            <dt>Replaces</dt>
            <dd>
              <RefLink reference={order.replacesOrderReference ?? ''} id={order.replacesOrderId} kind="order" />
            </dd>
          </div>
        )}
        {order.replacedByOrderId && (
          <div>
            <dt>Replaced by</dt>
            <dd>
              <RefLink reference={order.replacedByOrderReference ?? ''} id={order.replacedByOrderId} kind="order" />
            </dd>
          </div>
        )}
        {order.latestExternalRequestReference && (
          <div>
            <dt>Invoice request</dt>
            <dd>
              {order.latestExternalRequestReference}
              {order.latestExternalRequestState === 'cancelled' && (
                <span className="sales-secondary"> · cancelled</span>
              )}
            </dd>
          </div>
        )}
        {order.adjustments.map((adjustment) => (
          <div key={adjustment.id}>
            <dt>{adjustment.reference}</dt>
            <dd>
              Full reversal · {formatCents(toCents(adjustment.amount))}
              <br />
              <span className="sales-secondary">{adjustment.reason}</span>
            </dd>
          </div>
        ))}
      </dl>
    </StackCard>
  );
}
