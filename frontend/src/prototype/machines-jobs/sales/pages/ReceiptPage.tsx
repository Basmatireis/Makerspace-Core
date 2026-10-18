import { Button } from '@carbon/react';
import { Link, useParams } from 'react-router-dom';
import { PageShell } from '../../../../app/PageShell';
import { EmptyState } from '../../../../app/PageState';
import { QueryBoundary } from '../../components/QueryBoundary';
import { ReceiptPreview } from '../components/Receipt';
import { RequirePermission } from '../components/RequirePermission';
import { activeReceipts } from '../logic';
import { useSalesData } from '../useSalesData';
import '../sales.scss';

/** Printable receipt of an order. [proposed] receipt numbers and a PDF export. */
export function ReceiptPage() {
  const { orderId } = useParams();
  const { query, data, views } = useSalesData();
  const order = views.find((item) => item.id === orderId);
  const crumbs = [{ label: 'Sales & payments', to: '/sales' }, { label: 'Orders', to: '/sales/orders' }];
  return (
    <RequirePermission permission="payments.read" title="Receipt" crumbs={crumbs}>
      <PageShell title={order ? `Receipt for ${order.reference}` : 'Receipt'} width="wide" breadcrumbs={order ? [...crumbs, { label: order.reference, to: `/sales/orders/${order.id}` }] : crumbs}
        actions={order ? <Button as={Link} to={`/sales/orders/${order.id}`} kind="tertiary">Back to order</Button> : undefined}>
        <QueryBoundary query={query} errorMessage="The receipt could not be loaded.">
          {order && order.status !== 'draft' && order.status !== 'cancelled'
            ? <ReceiptPreview order={order} payments={activeReceipts(data.payments, data.allocations, order.id).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))} />
            : <EmptyState title="No receipt available" description="Only finalized orders have a receipt." />}
        </QueryBoundary>
      </PageShell>
    </RequirePermission>
  );
}
