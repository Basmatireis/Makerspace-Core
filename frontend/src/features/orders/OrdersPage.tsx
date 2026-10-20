import { useMemo, useState } from 'react';
import { Button, ComboBox } from '@carbon/react';
import { Add, ListChecked } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { Order } from '../../api/generated/models';
import { DateInput } from '../../app/DateInput';
import { PageShell } from '../../app/PageShell';
import { RefLink } from '../../app/RefLink';
import { SectionSwitcher } from '../../app/SectionSwitcher';
import { dateInAppTimeZone, formatDateTime } from '../../app/dateTime';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { DirectoryTable, type Column } from '../machinelogbook/shared/DirectoryTable';
import { QueryBoundary } from '../machinelogbook/shared/QueryBoundary';
import { customerTypeOptions, requestStateLabel } from './labels';
import { activeItems, customerLabel, INVOICE_KEYS, invoiceKey, isAwaitingPayment, ORDER_SECTIONS, requestNext, sectionOf, type InvoiceKey, type OrderSection } from './logic';
import { formatCents, toCents } from './money';
import { EditOrderModal } from './OrderDialogs';
import { allOrdersQuery, readyToBillQuery } from './queries';
import { ReadyToBillModal } from './ReadyToBillModal';
import { OrderStatusTag, RequestStateTag } from './status';
import { readyToBillGroups, readyTotals } from './logic';
import './sales.scss';
import '../machinelogbook/shared/shared.scss';

const list = (value: string | null) => (value ?? '').split(',').filter(Boolean);
const STATUS_VIEWS = [
  { id: 'drafts', label: 'Drafts', has: (order: Order) => order.status === 'draft' },
  { id: 'awaiting', label: 'Awaiting payment', has: (order: Order) => isAwaitingPayment(order) },
];
const invoiceLabel = (key: InvoiceKey) => key === 'none' ? 'No invoice' : requestStateLabel[key];
const SECTION_LABEL: Record<OrderSection, string> = { open: 'Open', paid: 'Paid', cancelled: 'Cancelled' };

function OrdersTable({ orders }: { orders: Order[] }) {
  const user = useCurrentUser();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const canWrite = hasPermission(user, PermissionId.orderswrite);
  const canReadJobs = hasPermission(user, PermissionId.machine_jobsread);
  const ready = useQuery({ ...readyToBillQuery(), enabled: canReadJobs });
  const readyGroups = readyToBillGroups(ready.data ?? []);
  const readySummary = readyTotals(readyGroups);
  const reviewing = params.get('review') === '1';
  const setParam = (patch: Record<string, string | null>) => setParams((previous) => {
    const next = new URLSearchParams(previous);
    for (const [name, value] of Object.entries(patch)) { if (value) next.set(name, value); else next.delete(name); }
    next.delete('page');
    return next;
  }, { replace: true });

  const invoices = list(params.get('invoice'));
  const explicit = params.get('section');
  // A link that filters by invoice without a section (the overview) lands on the first section that has such orders, so none of them is hidden.
  const landing = explicit === null && invoices.length > 0 ? ORDER_SECTIONS.find((id) => orders.some((order) => sectionOf(order) === id && invoices.includes(invoiceKey(order)))) : undefined;
  const section: OrderSection = explicit === 'paid' || explicit === 'cancelled' ? explicit : landing ?? 'open';
  const views = section === 'open' ? STATUS_VIEWS.filter((view) => list(params.get('status')).includes(view.id)) : [];
  const types = list(params.get('type'));
  const customerId = params.get('customer') ?? '';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';

  // Counts every order once per section, status view and invoice state, so it is kept until the orders change.
  const counts = useMemo(() => ({
    sections: Object.fromEntries(ORDER_SECTIONS.map((id) => [id, orders.filter((order) => sectionOf(order) === id).length])) as Record<OrderSection, number>,
    views: Object.fromEntries(STATUS_VIEWS.map((view) => [view.id, orders.filter((order) => view.has(order)).length])),
    invoices: Object.fromEntries(INVOICE_KEYS.map((id) => [id, orders.filter((order) => invoiceKey(order) === id).length])),
  }), [orders]);
  const customers = useMemo(() => [...new Map(orders.filter((order) => order.customer).map((order) => [order.customer!.id, { id: order.customer!.id, label: customerLabel(order) }])).values()].sort((a, b) => a.label.localeCompare(b.label)), [orders]);

  const rows = orders.filter((order) => {
    const day = dateInAppTimeZone(order.createdAt);
    return sectionOf(order) === section
      && (views.length === 0 || views.some((view) => view.has(order)))
      && (invoices.length === 0 || invoices.includes(invoiceKey(order)))
      && (types.length === 0 || types.includes(order.customerKind))
      && (!customerId || order.customer?.id === customerId)
      && (!from || day >= from) && (!to || day <= to);
  });

  const columns: Column<Order>[] = [
    {
      key: 'order', header: 'Order', sortValue: (order) => order.reference,
      render: (order) => (
        <div className="mj-cell-stack">
          <RefLink reference={order.reference} id={order.id} />
          <span className="mj-secondary">{customerLabel(order)} · {activeItems(order).length} {activeItems(order).length === 1 ? 'item' : 'items'}</span>
        </div>
      ),
    },
    {
      key: 'status', header: 'Status',
      render: (order) => (
        <div className="mj-cell-stack">
          <OrderStatusTag order={order} size="sm" />
          {order.replacedByOrderId && <span className="mj-secondary">Replaced by <RefLink reference={order.replacedByOrderReference ?? ''} id={order.replacedByOrderId} kind="order" /></span>}
          {order.replacesOrderId && <span className="mj-secondary">Replaces <RefLink reference={order.replacesOrderReference ?? ''} id={order.replacesOrderId} kind="order" /></span>}
        </div>
      ),
    },
    {
      key: 'payment', header: 'Payment', sortValue: (order) => toCents(order.outstandingAmount), firstDirection: 'DESC',
      render: (order) => {
        if (order.status !== 'finalized') return <span className="mj-secondary">—</span>;
        if (toCents(order.netCharge) === 0) return <span className="mj-secondary">No payment due</span>;
        return isAwaitingPayment(order)
          ? <div className="mj-cell-stack"><span className="sales-num--due">{formatCents(toCents(order.outstandingAmount))} outstanding</span><span className="mj-secondary">{formatCents(toCents(order.settledAmount))} paid of {formatCents(toCents(order.netCharge))}</span></div>
          : <div className="mj-cell-stack"><span>Paid in full</span><span className="mj-secondary">{formatCents(toCents(order.settledAmount))}</span></div>;
      },
    },
    {
      key: 'invoice', header: 'Invoice', narrow: true,
      render: (order) => {
        const state = order.activeExternalRequestState ?? (order.latestExternalRequestState === 'cancelled' ? 'cancelled' : null);
        if (!state) return <span className="mj-secondary">—</span>;
        return <div className="mj-cell-stack"><RequestStateTag state={state} />{(state === 'draft' || state === 'submitted' || state === 'issued' || state === 'cancellation_requested') && <span className="mj-secondary">{requestNext({ state, events: [] }, order.settlementState === 'paid')}</span>}</div>;
      },
    },
    { key: 'total', header: 'Total', sortValue: (order) => toCents(order.totalAmount), firstDirection: 'DESC', render: (order) => <span className="sales-num">{formatCents(toCents(order.totalAmount))}</span> },
    { key: 'updated', header: 'Updated', sortValue: (order) => order.updatedAt, firstDirection: 'DESC', narrow: true, render: (order) => formatDateTime(order.updatedAt) },
  ];

  const emptyTitle = section === 'paid' ? 'No paid orders' : section === 'cancelled' ? 'No cancelled or reversed orders' : 'No open orders';
  return (
    <>
      <DirectoryTable<Order>
        id="orders" urlPrefix="" label="Orders" columns={columns} rows={rows} totalCount={orders.length} searchText={(order) => `${order.reference} ${customerLabel(order)}`}
        defaultSort={{ key: 'updated', direction: 'DESC' }} pageSizes={[10, 25, 50]} onRowClick={(order) => navigate(`/orders/${order.id}`)}
        switcher={(
          <SectionSwitcher
            label="Order sections" selected={section}
            sections={ORDER_SECTIONS.map((id) => ({ id, label: `${SECTION_LABEL[id]} (${counts.sections[id]})` }))}
            onChange={(id) => setParam({ section: id === 'open' ? (landing ? 'open' : null) : id, status: null })}
          />
        )}
        filterCategories={[
          // Paid and cancelled orders have a single status each, so the Status category only exists for the open section.
          ...(section === 'open' ? [{ key: 'status', label: 'Status', options: STATUS_VIEWS.map((view) => ({ id: view.id, label: `${view.label} (${counts.views[view.id]})` })) }] : []),
          { key: 'invoice', label: 'Invoice', options: INVOICE_KEYS.map((id) => ({ id, label: `${invoiceLabel(id)} (${counts.invoices[id]})` })) },
          { key: 'type', label: 'Customer type', options: customerTypeOptions },
          {
            key: 'customer', label: 'Customer',
            render: ({ idPrefix, staged, set }) => (
              <ComboBox<{ id: string; label: string }>
                autoAlign id={`${idPrefix}-customer`} titleText="Customer" placeholder="Any customer" items={customers} itemToString={(item) => item?.label ?? ''}
                selectedItem={customers.find((item) => item.id === staged.customer?.[0]) ?? null} onChange={({ selectedItem }) => set('customer', selectedItem ? [selectedItem.id] : [])}
              />
            ),
          },
          {
            key: 'created', label: 'Created', keys: ['from', 'to'],
            render: ({ idPrefix, staged, set }) => (
              <>
                <DateInput id={`${idPrefix}-from`} labelText="Created from" value={staged.from?.[0] ?? ''} onChange={(value) => set('from', value ? [value] : [])} />
                <DateInput id={`${idPrefix}-to`} labelText="Created through" value={staged.to?.[0] ?? ''} onChange={(value) => set('to', value ? [value] : [])} />
              </>
            ),
          },
        ]}
        toolbarAction={(
          <>
            {readySummary.jobs > 0 && (
              <>
                <span id="orders-review-hint" className="cds--visually-hidden">{formatCents(readySummary.total)} from {readySummary.customers} {readySummary.customers === 1 ? 'customer' : 'customers'}</span>
                <Button kind="secondary" size="lg" renderIcon={ListChecked} className="sales-toolbar-action" aria-describedby="orders-review-hint" onClick={() => setParam({ review: '1' })}>Review jobs ({readySummary.jobs})</Button>
              </>
            )}
            {canWrite && <Button kind="primary" size="lg" renderIcon={Add} className="sales-toolbar-action" onClick={() => setCreating(true)}>New order</Button>}
          </>
        )}
        empty={{ title: orders.length === 0 ? 'No orders yet' : emptyTitle, description: orders.length === 0 ? 'Orders are created from finished jobs or by hand.' : 'Orders appear here as they move through their life.', action: canWrite && orders.length === 0 ? <Button kind="tertiary" onClick={() => setCreating(true)}>New order</Button> : undefined }}
      />
      {reviewing && <ReadyToBillModal canCreate={canWrite} onClose={() => setParam({ review: null })} />}
      {creating && <EditOrderModal order={null} onClose={() => setCreating(false)} onSaved={(id) => navigate(`/orders/${id}`)} />}
    </>
  );
}

export function OrdersPage() {
  const query = useQuery(allOrdersQuery());
  return (
    <PageShell className="sales-page" title="Orders" description="Charges for jobs and items, what has been paid and what is invoiced." width="wide" breadcrumbs={[{ label: 'Sales & payments', to: '/sales' }, { label: 'Orders' }]}>
      <QueryBoundary query={query} errorMessage="The orders could not be loaded.">
        {(orders) => <OrdersTable orders={orders} />}
      </QueryBoundary>
    </PageShell>
  );
}
