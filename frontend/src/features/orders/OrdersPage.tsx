import { useMemo, useState } from 'react';
import { Button } from '@carbon/react';
import { Add, ArrowRight, ListChecked } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { ExternalInvoiceRequestState, Order } from '../../api/generated/models';
import { DetailPanel } from '../../app/components/DetailPanel';
import { FuzzyComboBox } from '../../app/components/FuzzyComboBox';
import { ListWithPanel, useListPanelLayout } from '../../app/components/ListWithPanel';
import { DateInput } from '../../app/DateInput';
import { PageShell } from '../../app/PageShell';
import { RefLink } from '../../app/RefLink';
import { RichNotification } from '../../app/RichNotification';
import { PageSectionTabs } from '../machinelogbook/components/machineParts';
import { dateInAppTimeZone, formatDateTime } from '../../app/dateTime';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import type { FilterCategory } from '../../app/BatchFilter';
import { attentionDirectoryColumn, DirectoryTable, type Column } from '../machinelogbook/shared/DirectoryTable';
import { QueryBoundary } from '../machinelogbook/shared/QueryBoundary';
import { customerTypeOptions, requestStateLabel } from './labels';
import {
  activeItems,
  customerLabel,
  INVOICE_KEYS,
  invoiceKey,
  isAwaitingPayment,
  ORDER_ATTENTION_KEYS,
  ORDER_SECTIONS,
  orderAttention,
  readyToBillGroups,
  readyTotals,
  requestNext,
  sectionOf,
  type InvoiceKey,
  type OrderAttentionKey,
  type OrderSection,
} from './logic';
import { formatCents, toCents } from './money';
import { OrderActionsMenu, useOrderActions } from './OrderActions';
import { EditOrderModal } from './OrderDialogs';
import { OrderPanel } from './OrderPanel';
import { allOrdersQuery, readyToBillQuery } from './queries';
import { ReadyToBillModal } from './ReadyToBillModal';
import { OrderStatusTag, orderStatusLabel, RequestStateTag } from './status';
import './sales.scss';
import '../machinelogbook/shared/shared.scss';

const list = (value: string | null) => (value ?? '').split(',').filter(Boolean);
const STATUS_VIEWS = [
  { id: 'drafts', label: 'Drafts', has: (order: Order) => order.status === 'draft' },
  { id: 'awaiting', label: 'Awaiting payment', has: (order: Order) => isAwaitingPayment(order) },
];
const invoiceLabel = (key: InvoiceKey) => (key === 'none' ? 'No invoice' : requestStateLabel[key]);
/** The tabs of the list: the three sections every order belongs to, and Needs attention across them. */
type OrderTab = OrderSection | 'attention';
const TABS: OrderTab[] = ['open', 'attention', 'paid', 'cancelled'];
const TAB_LABEL: Record<OrderTab, string> = {
  open: 'Open',
  attention: 'Needs attention',
  paid: 'Paid',
  cancelled: 'Cancelled',
};
const ATTENTION_LABEL: Record<OrderAttentionKey, string> = {
  balance_overdue: 'Outstanding for over two weeks',
  source_changed: 'Changed since billed',
  invoice_request_open: 'Invoice awaits approval',
  partly_paid: 'Partly paid',
  old_draft: 'Old draft',
};
const EMPTY_TITLE: Record<OrderTab, string> = {
  open: 'No open orders',
  attention: 'Nothing needs attention right now.',
  paid: 'No paid orders',
  cancelled: 'No cancelled or reversed orders',
};
/** How many job numbers the ready-to-bill notice names before it only counts the rest. */
const NAMED_JOBS = 8;

/** What the search matches: reference, customer, status, the linked orders, the invoice request and its state, and the payment wording. */
function orderSearchText(order: Order) {
  const invoiceState =
    order.activeExternalRequestState ?? (order.latestExternalRequestState === 'cancelled' ? 'cancelled' : null);
  const payment =
    order.status !== 'finalized'
      ? null
      : toCents(order.netCharge) === 0
        ? 'No payment due'
        : isAwaitingPayment(order)
          ? 'outstanding'
          : 'Paid in full';
  return [
    order.reference,
    customerLabel(order),
    orderStatusLabel(order),
    order.replacesOrderReference,
    order.replacedByOrderReference,
    order.activeExternalRequestReference ?? order.latestExternalRequestReference,
    invoiceState && (requestStateLabel[invoiceState as ExternalInvoiceRequestState] ?? invoiceState),
    payment,
  ]
    .filter(Boolean)
    .join(' ');
}

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
  const readyIds = readyGroups.flatMap((group) => group.ready.map((row) => row.job.displayId));
  const orderActions = useOrderActions();
  const reviewing = params.get('review') === '1';
  const panelFits = useListPanelLayout();
  const selectedId = params.get('order');
  const selected = panelFits ? (orders.find((order) => order.id === selectedId) ?? null) : null;
  // Selecting keeps the page, search and filters; only the panel changes.
  const select = (id: string | null) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (id) next.set('order', id);
        else next.delete('order');
        return next;
      },
      { replace: true },
    );
  const setParam = (patch: Record<string, string | null>) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        for (const [name, value] of Object.entries(patch)) {
          if (value) next.set(name, value);
          else next.delete(name);
        }
        next.delete('page');
        return next;
      },
      { replace: true },
    );

  const invoices = list(params.get('invoice'));
  const explicit = params.get('section');
  // A link that filters by invoice without a section (the overview) lands on the first section that has such orders, so none of them is hidden.
  const landing =
    explicit === null && invoices.length > 0
      ? ORDER_SECTIONS.find((id) =>
          orders.some((order) => sectionOf(order) === id && invoices.includes(invoiceKey(order))),
        )
      : undefined;
  const tab: OrderTab =
    explicit === 'paid' || explicit === 'cancelled' || explicit === 'attention' ? explicit : (landing ?? 'open');
  const views = tab === 'open' ? STATUS_VIEWS.filter((view) => list(params.get('status')).includes(view.id)) : [];
  const reasons = tab === 'attention' ? list(params.get('attention')) : [];
  const types = list(params.get('type'));
  const customerId = params.get('customer') ?? '';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';

  // Each order's attention reasons, with the ones the list derives itself ("partly paid", "old draft"), once per list.
  const attention = useMemo(() => new Map(orders.map((order) => [order.id, orderAttention(order)])), [orders]);
  const reasonsOf = (order: Order) => attention.get(order.id) ?? [];
  const inTab = (order: Order) => (tab === 'attention' ? reasonsOf(order).length > 0 : sectionOf(order) === tab);

  // Counts every order once per tab, status view, attention reason and invoice state, so it is kept until the orders change.
  const counts = useMemo(() => {
    const reasonsOfOrder = (order: Order) => attention.get(order.id) ?? [];
    return {
      tabs: {
        ...Object.fromEntries(
          ORDER_SECTIONS.map((id) => [id, orders.filter((order) => sectionOf(order) === id).length]),
        ),
        attention: orders.filter((order) => reasonsOfOrder(order).length > 0).length,
      } as Record<OrderTab, number>,
      reasons: Object.fromEntries(
        ORDER_ATTENTION_KEYS.map((id) => [
          id,
          orders.filter((order) => reasonsOfOrder(order).some((reason) => reason.code === id)).length,
        ]),
      ),
      views: Object.fromEntries(
        STATUS_VIEWS.map((view) => [view.id, orders.filter((order) => view.has(order)).length]),
      ),
      invoices: Object.fromEntries(
        INVOICE_KEYS.map((id) => [id, orders.filter((order) => invoiceKey(order) === id).length]),
      ),
    };
  }, [orders, attention]);
  const customers = useMemo(
    () =>
      [
        ...new Map(
          orders
            .filter((order) => order.customer)
            .map((order) => [order.customer!.id, { id: order.customer!.id, label: customerLabel(order) }]),
        ).values(),
      ].sort((a, b) => a.label.localeCompare(b.label)),
    [orders],
  );

  const rows = orders.filter((order) => {
    const day = dateInAppTimeZone(order.createdAt);
    return (
      inTab(order) &&
      (views.length === 0 || views.some((view) => view.has(order))) &&
      (reasons.length === 0 || reasonsOf(order).some((reason) => reasons.includes(reason.code))) &&
      (invoices.length === 0 || invoices.includes(invoiceKey(order))) &&
      (types.length === 0 || types.includes(order.customerKind)) &&
      (!customerId || order.customer?.id === customerId) &&
      (!from || day >= from) &&
      (!to || day <= to)
    );
  });

  const columns: Column<Order>[] = [
    {
      key: 'order',
      header: 'Order',
      sortValue: (order) => order.reference,
      render: (order) => (
        <div className="mj-cell-stack">
          {panelFits ? (
            <button
              type="button"
              className={`sales-ref-button${order.id === selected?.id ? ' sales-row-selected' : ''}`}
              aria-pressed={order.id === selected?.id}
              onClick={() => select(order.id === selected?.id ? null : order.id)}
            >
              {order.reference}
            </button>
          ) : (
            <RefLink reference={order.reference} id={order.id} />
          )}
          <span className="mj-secondary">
            {customerLabel(order)} · {activeItems(order).length} {activeItems(order).length === 1 ? 'item' : 'items'}
          </span>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (order) => (
        <div className="mj-cell-stack">
          <OrderStatusTag order={order} size="sm" />
          {order.replacedByOrderId && (
            <span className="mj-secondary">
              Replaced by{' '}
              <RefLink reference={order.replacedByOrderReference ?? ''} id={order.replacedByOrderId} kind="order" />
            </span>
          )}
          {order.replacesOrderId && (
            <span className="mj-secondary">
              Replaces{' '}
              <RefLink reference={order.replacesOrderReference ?? ''} id={order.replacesOrderId} kind="order" />
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'payment',
      header: 'Payment',
      sortValue: (order) => toCents(order.outstandingAmount),
      firstDirection: 'DESC',
      render: (order) => {
        if (order.status !== 'finalized') return <span className="mj-secondary">—</span>;
        if (toCents(order.netCharge) === 0) return <span className="mj-secondary">No payment due</span>;
        return isAwaitingPayment(order) ? (
          <div className="mj-cell-stack">
            <span className="sales-num--due">{formatCents(toCents(order.outstandingAmount))} outstanding</span>
            <span className="mj-secondary">
              {formatCents(toCents(order.settledAmount))} paid of {formatCents(toCents(order.netCharge))}
            </span>
          </div>
        ) : (
          <div className="mj-cell-stack">
            <span>Paid in full</span>
            <span className="mj-secondary">{formatCents(toCents(order.settledAmount))}</span>
          </div>
        );
      },
    },
    {
      key: 'invoice',
      header: 'Invoice',
      narrow: true,
      render: (order) => {
        const state =
          order.activeExternalRequestState ?? (order.latestExternalRequestState === 'cancelled' ? 'cancelled' : null);
        if (!state) return <span className="mj-secondary">—</span>;
        return (
          <div className="mj-cell-stack">
            <RequestStateTag state={state} />
            {(state === 'draft' ||
              state === 'submitted' ||
              state === 'issued' ||
              state === 'cancellation_requested') && (
              <span className="mj-secondary">
                {requestNext({ state, events: [] }, order.settlementState === 'paid')}
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: 'total',
      header: 'Total',
      sortValue: (order) => toCents(order.totalAmount),
      firstDirection: 'DESC',
      render: (order) => <span className="sales-num">{formatCents(toCents(order.totalAmount))}</span>,
    },
    {
      key: 'updated',
      header: 'Updated',
      sortValue: (order) => order.updatedAt,
      firstDirection: 'DESC',
      narrow: true,
      render: (order) => formatDateTime(order.updatedAt),
    },
    attentionDirectoryColumn<Order>(reasonsOf),
    {
      key: 'actions',
      header: 'Actions',
      hiddenHeader: true,
      narrow: true,
      render: (order) => (
        <OrderActionsMenu
          order={order}
          actions={orderActions.actionsFor(order)}
          onAction={orderActions.run}
          disabled={orderActions.busy}
        />
      ),
    },
  ];

  const customerAndCreated: FilterCategory[] = [
    {
      key: 'customer',
      label: 'Customer',
      render: ({ idPrefix, staged, set }) => (
        <FuzzyComboBox<{ id: string; label: string }>
          autoAlign
          id={`${idPrefix}-customer`}
          titleText="Customer"
          placeholder="Any customer"
          items={customers}
          itemToString={(item) => item?.label ?? ''}
          selectedItem={customers.find((item) => item.id === staged.customer?.[0]) ?? null}
          onChange={({ selectedItem }) => set('customer', selectedItem ? [selectedItem.id] : [])}
        />
      ),
    },
    {
      key: 'created',
      label: 'Created',
      keys: ['from', 'to'],
      render: ({ idPrefix, staged, set }) => (
        <>
          <DateInput
            id={`${idPrefix}-from`}
            labelText="Created from"
            value={staged.from?.[0] ?? ''}
            onChange={(value) => set('from', value ? [value] : [])}
          />
          <DateInput
            id={`${idPrefix}-to`}
            labelText="Created through"
            value={staged.to?.[0] ?? ''}
            onChange={(value) => set('to', value ? [value] : [])}
          />
        </>
      ),
    },
  ];

  const readyNotice =
    tab === 'attention' && readySummary.jobs > 0 ? (
      <RichNotification
        kind="warning"
        title={`${readySummary.jobs} finished ${readySummary.jobs === 1 ? 'job is' : 'jobs are'} not on an order`}
      >
        {readyIds.slice(0, NAMED_JOBS).join(', ')}
        {readyIds.length > NAMED_JOBS && ` and ${readyIds.length - NAMED_JOBS} more`} ·{' '}
        {formatCents(readySummary.total)} ready to bill.
        <span className="sales-notice-actions">
          <Button kind="ghost" size="sm" renderIcon={ArrowRight} onClick={() => setParam({ review: '1' })}>
            Review jobs
          </Button>
        </span>
      </RichNotification>
    ) : undefined;
  const tabs = (
    <PageSectionTabs
      label="Order sections"
      selected={tab}
      sections={TABS.map((id) => ({ id, label: `${TAB_LABEL[id]} (${counts.tabs[id]})` }))}
      onChange={(id) =>
        setParam({
          section: id === 'open' ? (landing ? 'open' : null) : id,
          status: null,
          attention: null,
          // Needs attention has no Customer and Created filters, so their values must not narrow it unseen.
          ...(id === 'attention' ? { customer: null, from: null, to: null } : {}),
        })
      }
    />
  );
  return (
    <PageShell className="sales-page" title="Orders" width="wide" breadcrumbs={ORDERS_CRUMBS} tabs={tabs}>
      <ListWithPanel
        panelLabel="Order details"
        panel={
          selected ? (
            <OrderPanel
              order={selected}
              attention={reasonsOf(selected)}
              onClose={() => select(null)}
              actions={
                <OrderActionsMenu
                  order={selected}
                  actions={orderActions.actionsFor(selected)}
                  onAction={orderActions.run}
                  disabled={orderActions.busy}
                />
              }
            />
          ) : (
            <DetailPanel className="sales-panel-empty">
              <p>Select an order to see its items, payments and invoice.</p>
            </DetailPanel>
          )
        }
      >
        <DirectoryTable<Order>
          id="orders"
          urlPrefix=""
          label="Orders"
          columns={columns}
          rows={rows}
          totalCount={counts.tabs[tab]}
          notice={readyNotice}
          searchText={orderSearchText}
          defaultSort={{ key: 'updated', direction: 'DESC' }}
          pageSizes={[10, 25, 50]}
          onRowClick={(order) =>
            panelFits ? select(order.id === selected?.id ? null : order.id) : navigate(`/orders/${order.id}`)
          }
          filterCategories={[
            // Paid and cancelled orders have a single status each, so the Status category only exists for the open section.
            ...(tab === 'open'
              ? [
                  {
                    key: 'status',
                    label: 'Status',
                    options: STATUS_VIEWS.map((view) => ({
                      id: view.id,
                      label: `${view.label} (${counts.views[view.id]})`,
                    })),
                  },
                ]
              : []),
            ...(tab === 'attention'
              ? [
                  {
                    key: 'attention',
                    label: 'Needs attention',
                    options: ORDER_ATTENTION_KEYS.map((id) => ({
                      id,
                      label: `${ATTENTION_LABEL[id]} (${counts.reasons[id]})`,
                    })),
                  },
                ]
              : []),
            {
              key: 'invoice',
              label: 'Invoice',
              options: INVOICE_KEYS.map((id) => ({ id, label: `${invoiceLabel(id)} (${counts.invoices[id]})` })),
            },
            { key: 'type', label: 'Customer type', options: customerTypeOptions },
            ...(tab === 'attention' ? [] : customerAndCreated),
          ]}
          toolbarAction={
            <>
              {readySummary.jobs > 0 && (
                <>
                  <span id="orders-review-hint" className="cds--visually-hidden">
                    {formatCents(readySummary.total)} from {readySummary.customers}{' '}
                    {readySummary.customers === 1 ? 'customer' : 'customers'}
                  </span>
                  <Button
                    kind="secondary"
                    size="lg"
                    renderIcon={ListChecked}
                    className="sales-toolbar-action"
                    aria-describedby="orders-review-hint"
                    onClick={() => setParam({ review: '1' })}
                  >
                    Review jobs ({readySummary.jobs})
                  </Button>
                </>
              )}
              {canWrite && (
                <Button
                  kind="primary"
                  size="lg"
                  renderIcon={Add}
                  className="sales-toolbar-action"
                  onClick={() => setCreating(true)}
                >
                  New order
                </Button>
              )}
            </>
          }
          empty={{
            title: orders.length === 0 ? 'No orders yet' : EMPTY_TITLE[tab],
            description:
              orders.length === 0
                ? 'Orders are created from finished jobs or by hand.'
                : tab === 'attention'
                  ? 'Overdue balances, changed jobs, open invoice requests, partly paid orders and old drafts appear here.'
                  : 'Orders appear here as they move through their life.',
            action:
              canWrite && orders.length === 0 ? (
                <Button kind="tertiary" onClick={() => setCreating(true)}>
                  New order
                </Button>
              ) : undefined,
          }}
        />
        {orderActions.dialogs}
        {reviewing && <ReadyToBillModal canCreate={canWrite} onClose={() => setParam({ review: null })} />}
        {creating && (
          <EditOrderModal order={null} onClose={() => setCreating(false)} onSaved={(id) => navigate(`/orders/${id}`)} />
        )}
      </ListWithPanel>
    </PageShell>
  );
}

const ORDERS_CRUMBS = [{ label: 'Sales & payments', to: '/orders' }, { label: 'Orders' }];

export function OrdersPage() {
  const query = useQuery(allOrdersQuery());
  // The table owns the page shell: its tabs under the title carry the counts of the loaded orders.
  if (query.data) return <OrdersTable orders={query.data} />;
  return (
    <PageShell className="sales-page" title="Orders" width="wide" breadcrumbs={ORDERS_CRUMBS}>
      <QueryBoundary query={query} errorMessage="The orders could not be loaded.">
        {() => null}
      </QueryBoundary>
    </PageShell>
  );
}
