import { useMemo } from 'react';
import { Button, ClickableTile, ContainedList, ContainedListItem, SkeletonText, Tag } from '@carbon/react';
import { ArrowRight } from '@carbon/icons-react';
import { Link, useNavigate } from 'react-router-dom';
import { PageShell } from '../../../../app/PageShell';
import { ErrorState } from '../../../../app/PageState';
import { useStore } from '../../store';
import { RequirePermission } from '../components/RequirePermission';
import { formatDateTime, formatEur, round2 } from '../format';
import { requestNextStep, requestStateLabel } from '../labels';
import { cashInRegister, invoiceNeedsStep, isStaleDraft, readyToBill, startOfDay, sum, takings, type OrderView } from '../logic';
import { OrderStatusTag } from '../status';
import { useSalesData } from '../useSalesData';
import '../sales.scss';

type Takings = ReturnType<typeof takings>;
const breakdown = (value: Takings) => [`Cash ${formatEur(value.cash)}`, `Card ${formatEur(value.card)}`, ...(value.external ? [`Bank transfer ${formatEur(value.external)}`] : [])].join(' · ');
const daysOld = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);

type Attention = { key: string; title: string; detail: string; to: string; tag: { label: string; type: 'warm-gray' | 'blue' | 'green' | 'purple' | 'red' } };

function SalesOverview() {
  const store = useStore();
  const navigate = useNavigate();
  const { query, data, views } = useSalesData();
  const loading = query.status === 'pending';
  const canOrders = store.can('orders.read');
  const canInvoices = store.can('external_invoice_requests.read');

  const figures = useMemo(() => ({
    today: takings(data.payments, startOfDay(0), startOfDay(1)),
    register: cashInRegister(data.payments, data.cashMovements),
  }), [data.payments, data.cashMovements]);
  const awaiting = views.filter((order) => order.status === 'finalized' && order.outstanding > 0);
  const groups = useMemo(() => readyToBill(data.jobs, data.orders, data.prints, Date.now()), [data.jobs, data.orders, data.prints]);
  const readyJobs = groups.reduce((total, group) => total + group.ready.length, 0);
  const readyCustomers = groups.filter((group) => group.ready.length > 0);
  const stepping = data.requests.flatMap((request) => {
    const order = views.find((item) => item.id === request.orderId);
    return order && order.status === 'finalized' && invoiceNeedsStep(order.activeRequest?.id === request.id ? request : null, order.settlement === 'paid') ? [{ request, order }] : [];
  });

  const attention: Attention[] = [
    ...views.filter(isStaleDraft).map((order) => ({ key: order.id, title: `${order.reference} · ${order.customerLabel}`, detail: `Draft untouched for ${daysOld(order.updatedAt)} days. Finalize or cancel it.`, to: `/sales/orders/${order.id}`, tag: { label: 'Old draft', type: 'warm-gray' as const } })),
    ...[...awaiting].filter((order) => !order.activeRequest).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).slice(0, 3).map((order) => ({ key: order.id, title: `${order.reference} · ${order.customerLabel}`, detail: `${formatEur(order.outstanding)} outstanding of ${formatEur(order.net)}`, to: `/sales/orders/${order.id}`, tag: { label: order.settlement === 'partially_paid' ? 'Partially paid' : 'Awaiting payment', type: 'blue' as const } })),
    ...readyCustomers.slice(0, 3).map((group) => ({ key: `ready-${group.customer.id}`, title: group.customer.displayName, detail: `${group.ready.length} ${group.ready.length === 1 ? 'job' : 'jobs'} ready to bill · ${formatEur(group.total)}`, to: '/sales/orders', tag: { label: 'Ready to bill', type: 'green' as const } })),
    ...(canInvoices ? stepping.slice(0, 4).map(({ request, order }) => ({ key: request.id, title: `${request.reference} · ${order.reference} · ${order.customerLabel}`, detail: `${requestStateLabel[request.state]}. Next: ${(request.state === 'issued' ? requestNextStep.issued : requestNextStep[request.state]).toLowerCase()}`, to: `/sales/orders/${order.id}`, tag: { label: 'Invoice', type: 'purple' as const } })) : []),
  ];
  const recent = [...views].filter((order) => order.status !== 'draft' && order.status !== 'cancelled').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8);

  const tiles: { key: string; label: string; value: string; detail: string; to: string }[] = [
    { key: 'register', label: 'Cash in register (expected)', value: formatEur(figures.register.expected), detail: 'Cash receipts − refunds − withdrawals + deposits', to: '/sales/payments' },
    { key: 'today', label: 'Takings today', value: formatEur(figures.today.total), detail: breakdown(figures.today), to: '/sales/payments' },
    { key: 'awaiting', label: 'Awaiting payment', value: String(awaiting.length), detail: awaiting.length ? `${formatEur(round2(sum(awaiting.map((order) => order.outstanding))))} outstanding` : 'Everything is paid', to: '/sales/orders?view=awaiting' },
    { key: 'invoices', label: 'Invoice requests to handle', value: String(stepping.length), detail: stepping.length ? `${stepping.filter(({ request }) => request.state === 'issued').length} issued, waiting for the bank transfer` : 'No invoice waits for a step', to: '/sales/orders?view=invoice' },
    { key: 'ready', label: 'Jobs ready to bill', value: String(readyJobs), detail: readyJobs ? `${readyCustomers.length} ${readyCustomers.length === 1 ? 'customer' : 'customers'}` : 'No finished job waits', to: '/sales/orders' },
  ];

  return (
    <PageShell
      title="Sales overview" width="wide" breadcrumbs={[{ label: 'Sales & payments' }]} description="What is in the register, what is open and what needs you."
      actions={store.can('orders.write') ? <Button as={Link} to="/sales/orders" kind="primary">New order</Button> : undefined}
    >
      {query.status === 'error' ? <ErrorState message="The sales overview could not be loaded." onRetry={query.retry} /> : (
        <div className="mj-overview">
          <section aria-label="Key figures" className="mj-overview__metrics">
            {tiles.filter((tile) => canOrders || tile.key === 'register' || tile.key === 'today').filter((tile) => canInvoices || tile.key !== 'invoices').map((tile) => (
              <ClickableTile key={tile.key} href={`#${tile.to}`} renderIcon={ArrowRight} className="mj-metric">
                <span className="mj-metric__label">{tile.label}</span>
                {loading ? <SkeletonText heading width="5rem" /> : <span className="mj-metric__value">{tile.value}</span>}
                <span className="mj-secondary">{loading ? '' : tile.detail}</span>
              </ClickableTile>
            ))}
          </section>
          <div className="mj-overview__panels">
            <ContainedList label="Needs attention" kind="on-page" className="mj-overview__panel" action={canOrders ? <Button as={Link} to="/sales/orders" kind="ghost" size="sm" renderIcon={ArrowRight}>All orders</Button> : undefined}>
              {loading && <ContainedListItem><SkeletonText paragraph lineCount={3} /></ContainedListItem>}
              {!loading && attention.length === 0 && <ContainedListItem>Nothing needs attention right now.</ContainedListItem>}
              {!loading && attention.map((item) => (
                <ContainedListItem key={item.key} onClick={() => navigate(item.to)} action={<Tag type={item.tag.type} size="sm">{item.tag.label}</Tag>}>
                  <span className="mj-cell-stack"><strong>{item.title}</strong><span className="mj-secondary">{item.detail}</span></span>
                </ContainedListItem>
              ))}
            </ContainedList>
            <ContainedList label="Recent orders" kind="on-page" className="mj-overview__panel">
              {loading && <ContainedListItem><SkeletonText paragraph lineCount={3} /></ContainedListItem>}
              {!loading && recent.length === 0 && <ContainedListItem>No orders yet.</ContainedListItem>}
              {!loading && recent.map((order: OrderView) => (
                <ContainedListItem key={order.id} onClick={() => navigate(`/sales/orders/${order.id}`)} action={<OrderStatusTag order={order} size="sm" />}>
                  <span className="mj-cell-stack"><strong>{order.reference} · {formatEur(order.total)}</strong><span className="mj-secondary">{order.customerLabel} · {formatDateTime(order.updatedAt)}</span></span>
                </ContainedListItem>
              ))}
            </ContainedList>
          </div>
        </div>
      )}
    </PageShell>
  );
}

export function SalesOverviewPage() {
  return (
    <RequirePermission permission={['payments.read']} title="Sales overview" crumbs={[{ label: 'Sales & payments' }]}>
      <SalesOverview />
    </RequirePermission>
  );
}
