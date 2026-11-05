import type { ReactNode } from 'react';
import { Button, IconButton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@carbon/react';
import { ArrowRight, Close } from '@carbon/icons-react';
import { Link } from 'react-router-dom';
import type { Order } from '../../api/generated/models';
import { AttentionFlag, type AttentionItem } from '../../app/components/AttentionFlag';
import { DetailPanel, DetailPanelHead, DetailPanelSection, PanelBleed } from '../../app/components/DetailPanel';
import { Fact, FactsGrid } from '../../app/components/Facts';
import { formatDateTime } from '../../app/dateTime';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { formatQuantity } from '../machinelogbook/shared/format';
import { formatMoney } from './formatting';
import { customerKindLabel, methodLabel, requestStateLabel } from './labels';
import { activeItems, canPrintReceipt, customerLabel } from './logic';
import { formatCents, formatSignedCents, toCents } from './money';
import { useOrderPaymentRows } from './paymentRows';
import { OrderStatusTag, PaymentKindTag, RequestStateTag } from './status';
import { unitDisplay } from '../machinelogbook/units';

const itemKind = { machine_job: 'Job', inventory_item: 'Stock', manual: 'Custom' } as const;

/**
 * The detail panel of the selected order on the Orders list: who, how much, what is open, items and payments.
 * `attention` defaults to the API's reasons; `actions` sits next to Open order (the list's overflow menu).
 */
export function OrderPanel({
  order,
  attention = order.attention,
  actions,
  onClose,
}: {
  order: Order;
  attention?: readonly AttentionItem[];
  actions?: ReactNode;
  onClose: () => void;
}) {
  const user = useCurrentUser();
  const canReadPayments = hasPermission(user, PermissionId.paymentsread);
  const rows = useOrderPaymentRows(order, canReadPayments);
  const items = activeItems(order);
  const draft = order.status === 'draft';
  const outstanding = toCents(order.outstandingAmount);
  const last = rows.find((row) => row.payment && !row.reversal)?.payment;
  const invoiceState = order.latestExternalRequestState;
  const titleId = `order-panel-${order.id}`;
  return (
    <DetailPanel>
      <DetailPanelHead
        title={customerLabel(order)}
        titleId={titleId}
        meta={`${customerKindLabel(order.customerKind)} · ${order.fulfillmentMode === 'immediate' ? 'Hand-over now' : 'Hand-over later'}`}
        secondary={`${order.reference} · created ${formatDateTime(order.createdAt)}${order.createdBy ? ` by ${order.createdBy.displayName}` : ''}`}
        helper={
          <span className="sales-inline">
            <OrderStatusTag order={order} size="sm" />
            {invoiceState && <RequestStateTag state={invoiceState} />}
            <AttentionFlag attention={attention} align="bottom" />
          </span>
        }
        actions={
          <IconButton label="Close panel" kind="ghost" size="md" align="left" onClick={onClose}>
            <Close />
          </IconButton>
        }
      />
      <div className="sales-inline">
        <Button as={Link} to={`/orders/${order.id}`} kind="primary" size="md" renderIcon={ArrowRight}>
          Open order
        </Button>
        {actions}
      </div>
      <FactsGrid>
        <Fact label="Total" helper={`${items.length} ${items.length === 1 ? 'item' : 'items'}`}>
          {formatCents(toCents(order.totalAmount))}
        </Fact>
        <Fact
          label="Outstanding"
          helper={draft ? 'Not finalized yet' : outstanding > 0 ? 'Net charge minus payments' : 'Settled'}
        >
          {draft ? '—' : formatCents(outstanding)}
        </Fact>
        <Fact
          label="Paid"
          helper={last ? `${methodLabel(last.method)} · ${formatDateTime(last.occurredAt)}` : 'No payment yet'}
        >
          {formatCents(toCents(order.settledAmount))}
        </Fact>
        <Fact
          label="Invoice"
          helper={
            invoiceState
              ? (requestStateLabel[invoiceState as keyof typeof requestStateLabel] ?? invoiceState)
              : 'Cash or card'
          }
        >
          {order.latestExternalRequestReference ?? '—'}
        </Fact>
        <Fact label="Updated">{formatDateTime(order.updatedAt)}</Fact>
        <Fact label="Receipt" helper={canPrintReceipt(order) ? 'On the order page' : 'After a payment'}>
          {canPrintReceipt(order) ? 'Available' : '—'}
        </Fact>
      </FactsGrid>
      <DetailPanelSection title={`Items (${items.length})`}>
        <PanelBleed>
          <Table size="sm" aria-label="Items of the selected order">
            <TableHead>
              <TableRow>
                <TableHeader>Item</TableHeader>
                <TableHeader className="sales-num">Qty</TableHeader>
                <TableHeader className="sales-num">Amount</TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="sales-empty-cell">
                    No items yet.
                  </TableCell>
                </TableRow>
              )}
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <span className="sales-cell">
                      <span className="sales-ellipsis" title={item.description}>
                        {item.description}
                      </span>
                      <span className="sales-secondary">
                        {itemKind[item.kind]} · {formatMoney(item.unitPrice)} per{' '}
                        {item.kind === 'machine_job' ? 'job' : unitDisplay(item.unit)}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell className="sales-num">
                    {item.kind === 'machine_job' ? '1' : formatQuantity(item.quantity, 6)}
                  </TableCell>
                  <TableCell className="sales-num">{formatMoney(item.amount)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </PanelBleed>
      </DetailPanelSection>
      {canReadPayments && (
        <DetailPanelSection title={`Payments (${rows.length})`}>
          <PanelBleed>
            <Table size="sm" aria-label="Payments of the selected order">
              <TableHead>
                <TableRow>
                  <TableHeader>Date</TableHeader>
                  <TableHeader>Method</TableHeader>
                  <TableHeader className="sales-num">Amount</TableHeader>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="sales-empty-cell">
                      {draft
                        ? 'Finalize the order to take a payment.'
                        : order.activeExternalRequestId
                          ? 'Settled through the invoice once wiRef issues it.'
                          : 'No payments yet.'}
                    </TableCell>
                  </TableRow>
                )}
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="sales-secondary">
                      {row.payment ? formatDateTime(row.payment.occurredAt) : '—'}
                    </TableCell>
                    <TableCell>
                      <span className="sales-cell">
                        <span className="sales-inline">
                          {row.payment ? methodLabel(row.payment.method) : '—'}
                          {row.payment && row.payment.entryKind !== 'receipt' && (
                            <PaymentKindTag payment={row.payment} />
                          )}
                        </span>
                        <span className="sales-secondary">
                          {row.reference}
                          {row.payment?.recordedBy ? ` · ${row.payment.recordedBy.displayName}` : ''}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="sales-num">
                      {row.reversal ? formatSignedCents(row.signed) : formatCents(row.signed)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </PanelBleed>
        </DetailPanelSection>
      )}
    </DetailPanel>
  );
}
