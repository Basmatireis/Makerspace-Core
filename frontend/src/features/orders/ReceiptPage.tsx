import { Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@carbon/react';
import { ArrowLeft, Printer } from '@carbon/icons-react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { Order, OrderPayment } from '../../api/generated/models';
import { BrandMark } from '../../app/BrandMark';
import { EmptyState, ErrorState, FullPageLoading } from '../../app/PageState';
import { PageShell } from '../../app/PageShell';
import { formatDateTime } from '../../app/dateTime';
import { useBranding } from '../branding/branding';
import { formatQuantity } from '../machinelogbook/shared/format';
import { formatMoney } from './formatting';
import { methodLabel } from './labels';
import { activeItems, canPrintReceipt, customerLabel, receiptPaymentShares } from './logic';
import { formatCents, sumCents, toCents } from './money';
import { orderQuery, paymentQuery } from './queries';
import './sales.scss';
import '../machinelogbook/shared/shared.scss';

/**
 * Printable receipt of an order, or of one of its payments (?payment=). It carries no number of its own: the order reference and the
 * payment references identify it, and it is not an invoice.
 */
export function ReceiptPage() {
  const { orderId = '' } = useParams();
  const query = useQuery(orderQuery(orderId));
  const crumbs = [
    { label: 'Sales & payments', to: '/sales' },
    { label: 'Orders', to: '/orders' },
  ];
  if (query.isPending) return <FullPageLoading label="Loading receipt" />;
  if (query.isError)
    return (
      <PageShell title="Receipt" breadcrumbs={crumbs} width="wide">
        <ErrorState message="The receipt could not be loaded." onRetry={() => query.refetch()} />
      </PageShell>
    );
  return <Receipt key={query.data.id} order={query.data} />;
}

function Receipt({ order }: { order: Order }) {
  const branding = useBranding();
  const [params] = useSearchParams();
  const only = params.get('payment');
  const shares = receiptPaymentShares(order).filter((share) => !only || share.paymentId === only);
  const loaded = useQueries({ queries: shares.map((share) => paymentQuery(share.paymentId)) });
  const payments = new Map<string, OrderPayment>(
    loaded.flatMap((result) => (result.data ? [[result.data.id, result.data] as const] : [])),
  );
  const crumbs = [
    { label: 'Sales & payments', to: '/sales' },
    { label: 'Orders', to: '/orders' },
    { label: order.reference, to: `/orders/${order.id}` },
  ];
  const items = activeItems(order);
  const outstanding = toCents(order.outstandingAmount);
  const pending = loaded.some((result) => result.isPending);
  const failed = loaded.some((result) => result.isError);
  const available = canPrintReceipt(order) && shares.length > 0;
  const lastPayment = shares
    .map((share) => payments.get(share.paymentId)?.occurredAt)
    .filter((value): value is string => !!value)
    .sort()
    .at(-1);
  const invoiced = shares
    .map((share) => payments.get(share.paymentId))
    .filter((payment): payment is OrderPayment => payment?.method === 'external');

  return (
    <PageShell
      className="sales-page sales-receipt-page"
      title={`Receipt for ${order.reference}`}
      width="wide"
      breadcrumbs={crumbs}
      actions={
        <>
          <Button as={Link} to={`/orders/${order.id}`} kind="tertiary" renderIcon={ArrowLeft}>
            Back to order
          </Button>
          {available && (
            <Button kind="primary" renderIcon={Printer} disabled={pending || failed} onClick={() => window.print()}>
              Print
            </Button>
          )}
        </>
      }
    >
      {!available && (
        <EmptyState
          title="No receipt available"
          description="A receipt needs a finalized order with at least one payment that still counts."
        />
      )}
      {available && failed && <ErrorState message="The payments of this receipt could not be loaded." />}
      {available && !failed && (
        <article className="sales-receipt" aria-label={`Receipt for ${order.reference}`}>
          <header className="sales-receipt__head">
            <BrandMark kind="logo" className="sales-receipt__logo" />
            <div>
              <strong>{branding.identity.legalOrganizationName}</strong>
              <br />
              <span>{branding.identity.displayName}</span>
            </div>
          </header>
          <h2 className="sales-receipt__title">Payment receipt</h2>
          <dl className="sales-receipt__facts">
            <div>
              <dt>Order</dt>
              <dd>{order.reference}</dd>
            </div>
            <div>
              <dt>Date</dt>
              <dd>{lastPayment ? formatDateTime(lastPayment) : '—'}</dd>
            </div>
            <div>
              <dt>Customer</dt>
              <dd>{customerLabel(order)}</dd>
            </div>
          </dl>
          <Table size="sm" aria-label="Items">
            <TableHead>
              <TableRow>
                <TableHeader>Item</TableHeader>
                <TableHeader className="sales-num">Quantity</TableHeader>
                <TableHeader className="sales-num">Unit price</TableHeader>
                <TableHeader className="sales-num">Amount</TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>{item.description}</TableCell>
                  <TableCell className="sales-num">
                    {item.kind === 'machine_job' ? '1 job' : `${formatQuantity(item.quantity, 6)} ${item.unit}`}
                  </TableCell>
                  <TableCell className="sales-num">{formatMoney(item.unitPrice)}</TableCell>
                  <TableCell className="sales-num">{formatMoney(item.amount)}</TableCell>
                </TableRow>
              ))}
              <TableRow>
                <TableCell colSpan={3}>
                  <strong>Total</strong>
                </TableCell>
                <TableCell className="sales-num">
                  <strong>{formatCents(sumCents(items.map((item) => item.amount)))}</strong>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
          {toCents(order.netCharge) !== sumCents(items.map((item) => item.amount)) && (
            <p className="sales-receipt__note">Net charge after adjustments: {formatCents(toCents(order.netCharge))}</p>
          )}
          <Table size="sm" aria-label="Payments">
            <TableHead>
              <TableRow>
                <TableHeader>Payment</TableHeader>
                <TableHeader>Method</TableHeader>
                <TableHeader>Date</TableHeader>
                <TableHeader className="sales-num">Amount</TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {shares.map((share) => {
                const payment = payments.get(share.paymentId);
                return (
                  <TableRow key={share.paymentId}>
                    <TableCell>{share.reference}</TableCell>
                    <TableCell>{payment ? methodLabel(payment.method) : '—'}</TableCell>
                    <TableCell>{payment ? formatDateTime(payment.occurredAt) : '—'}</TableCell>
                    <TableCell className="sales-num">{formatCents(share.amount)}</TableCell>
                  </TableRow>
                );
              })}
              <TableRow>
                <TableCell colSpan={3}>
                  <strong>{only ? 'Paid with this receipt' : 'Paid'}</strong>
                </TableCell>
                <TableCell className="sales-num">
                  <strong>{formatCents(shares.reduce((total, share) => total + share.amount, 0))}</strong>
                </TableCell>
              </TableRow>
              {outstanding > 0 && (
                <TableRow>
                  <TableCell colSpan={3}>
                    <strong>Outstanding</strong>
                  </TableCell>
                  <TableCell className="sales-num">
                    <strong>{formatCents(outstanding)}</strong>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          {invoiced.length > 0 && (
            <p className="sales-receipt__note">
              {invoiced
                .map((payment) =>
                  payment.externalReference
                    ? `Settled by the wiRef invoice request ${payment.externalReference}.`
                    : 'Settled by a wiRef invoice.',
                )
                .join(' ')}{' '}
              The invoice itself is issued by wiRef.
            </p>
          )}
          <footer className="sales-receipt__foot">
            This is a payment receipt, not an invoice. It is identified by the order reference and the payment
            references above.
          </footer>
        </article>
      )}
    </PageShell>
  );
}
