import { useMemo, useState, type ReactNode } from 'react';
import {
  Button, ComboBox, InlineNotification, DataTable, Link as CarbonLink, Pagination, Table, TableBody,
  TableCell, TableContainer, TableHead, TableHeader, TableRow, TableToolbar, TableToolbarContent, TableToolbarSearch,
} from '@carbon/react';
import { Add, ListChecked } from '@carbon/icons-react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { DateInput } from '../../../../app/DateInput';
import { PageShell } from '../../../../app/PageShell';
import { EmptyState } from '../../../../app/PageState';
import { BatchFilter, toPatch, type FilterValues } from '../../components/BatchFilter';
import { QueryBoundary } from '../../components/QueryBoundary';
import { useStore } from '../../store';
import { RequirePermission } from '../components/RequirePermission';
import { EditOrderModal } from '../dialogs/EditOrderModal';
import { ReadyToBillModal } from '../dialogs/ReadyToBillModal';
import { dateInAppTimeZone, formatDateTime, formatEur } from '../format';
import { customerKindLabel } from '../labels';
import { activeItems, readyToBill, requestNext, requestReadiness, type OrderView } from '../logic';
import { OrderStatusTag, RequestStateTag } from '../status';
import { useSalesData } from '../useSalesData';
import { SectionSwitcher } from '../../components/SectionSwitcher';
import '../sales.scss';

type SortKey = 'order' | 'payment' | 'total' | 'updated';
type ViewId = 'all' | 'drafts' | 'awaiting' | 'paid' | 'invoice' | 'closed';
const PAGE_SIZES = [10, 25, 50];
const FILTER_KEYS = ['view', 'type', 'from', 'to', 'customer'] as const;
const TYPE_OPTIONS = [{ id: 'person', label: customerKindLabel('person') }, { id: 'organization', label: customerKindLabel('organization') }];
const VIEWS: { id: Exclude<ViewId, 'all'>; label: string; has: (order: OrderView) => boolean }[] = [
  { id: 'drafts', label: 'Drafts', has: (order) => order.status === 'draft' },
  { id: 'awaiting', label: 'Awaiting payment', has: (order) => order.status === 'finalized' && order.outstanding > 0 },
  { id: 'paid', label: 'Paid', has: (order) => order.status === 'finalized' && (order.settlement === 'paid' || order.settlement === 'no_payment_due') },
  { id: 'invoice', label: 'Invoice requested', has: (order) => order.activeRequest !== null },
  { id: 'closed', label: 'Reversed & cancelled', has: (order) => order.status === 'reversed' || order.status === 'cancelled' },
];
const HEADERS: { key: string; header: string; sort?: SortKey; narrow?: boolean; num?: boolean }[] = [
  { key: 'order', header: 'Order', sort: 'order' }, { key: 'status', header: 'Status' }, { key: 'payment', header: 'Payment', sort: 'payment' }, { key: 'invoice', header: 'Invoice', narrow: true },
  { key: 'total', header: 'Total', sort: 'total', num: true }, { key: 'updated', header: 'Updated', sort: 'updated', narrow: true },
];
const list = (value: string | null) => (value ?? '').split(',').filter(Boolean);

function OrdersTable({ views, loadingEmpty, notice }: { views: OrderView[]; loadingEmpty: boolean; notice?: ReactNode }) {
  const store = useStore();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const [searchKey, setSearchKey] = useState(0);
  const [sort, setSort] = useState<{ key: SortKey; direction: 'ASC' | 'DESC' }>({ key: 'updated', direction: 'DESC' });
  const canWrite = store.can('orders.write');
  const paidView = VIEWS.find((item) => item.id === 'paid')!;
  const section: 'open' | 'paid' = params.get('section') === 'paid' ? 'paid' : 'open';
  const sectionViews = VIEWS.filter((item) => item.id !== 'paid');
  const selectedViews = section === 'open' ? sectionViews.filter((item) => list(params.get('view')).includes(item.id)) : [];
  const types = list(params.get('type'));
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const customerId = params.get('customer') ?? '';
  const search = params.get('q') ?? '';
  const appliedFilters: FilterValues = Object.fromEntries(FILTER_KEYS.map((key) => [key, list(params.get(key))]));

  const update = (patch: Record<string, string | null>) => setParams((previous) => {
    const next = new URLSearchParams(previous);
    for (const [key, value] of Object.entries(patch)) { if (value) next.set(key, value); else next.delete(key); }
    if (!('page' in patch)) next.delete('page');
    return next;
  }, { replace: true });
  const clearAll = () => { update({ ...Object.fromEntries(FILTER_KEYS.map((key) => [key, null])), q: null }); setSearchKey((value) => value + 1); };
  const counts = useMemo(() => Object.fromEntries(VIEWS.map((item) => [item.id, views.filter((order) => item.has(order)).length])) as Record<ViewId, number>, [views]);
  const customers = useMemo(() => [...new Map(views.map((order) => [order.customer.id, { id: order.customer.id, label: order.customerLabel }])).values()].sort((a, b) => a.label.localeCompare(b.label)), [views]);

  const visible = useMemo(() => {
    const direction = sort.direction === 'ASC' ? 1 : -1;
    const needle = search.trim().toLowerCase();
    return views.filter((order) => {
      const day = dateInAppTimeZone(order.createdAt);
      return (section === 'paid' ? paidView.has(order) : !paidView.has(order))
        && (selectedViews.length === 0 || selectedViews.some((item) => item.has(order)))
        && (types.length === 0 || types.includes(order.customerKind))
        && (!customerId || order.customer.id === customerId)
        && (!from || day >= from) && (!to || day <= to)
        && (!needle || `${order.reference} ${order.customerName}`.toLowerCase().includes(needle));
    }).sort((a, b) => {
      const value = (order: OrderView) => sort.key === 'order' ? order.reference : sort.key === 'total' ? order.total : sort.key === 'payment' ? order.outstanding : order.updatedAt;
      const x = value(a); const y = value(b);
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * direction;
    });
  }, [views, sort, search, section, selectedViews.map((item) => item.id).join(','), types.join(','), from, to, customerId]); // eslint-disable-line react-hooks/exhaustive-deps

  const pageSize = PAGE_SIZES.includes(Number(params.get('pageSize'))) ? Number(params.get('pageSize')) : 10;
  const page = Math.max(1, Math.min(Number(params.get('page')) || 1, Math.ceil(visible.length / pageSize) || 1));
  const pageRows = visible.slice((page - 1) * pageSize, page * pageSize);
  const byId = new Map(views.map((order) => [order.id, order]));
  const sortBy = (key: SortKey) => setSort((current) => current.key === key ? { key, direction: current.direction === 'ASC' ? 'DESC' : 'ASC' } : { key, direction: key === 'order' ? 'ASC' : 'DESC' });
  const tableRows = pageRows.map((order) => ({ id: order.id, order: order.reference, status: order.status, payment: order.outstanding, invoice: order.latestRequest?.state ?? '', total: order.total, updated: order.updatedAt }));

  const renderCell = (order: OrderView, key: string) => {
    if (key === 'order') {
      return (
        <div className="mj-cell-stack">
          <CarbonLink as={Link} to={`/sales/orders/${order.id}`} onClick={(event: React.MouseEvent) => event.stopPropagation()}>{order.reference}</CarbonLink>
          <span className="mj-secondary">{order.customerLabel} · {activeItems(order).length} {activeItems(order).length === 1 ? 'item' : 'items'}</span>
        </div>
      );
    }
    if (key === 'status') return <div className="mj-cell-stack"><OrderStatusTag order={order} size="sm" />{order.replacedBy && <span className="mj-secondary">Replaced by {order.replacedBy.reference}</span>}{order.replaces && <span className="mj-secondary">Replaces {order.replaces.reference}</span>}</div>;
    if (key === 'payment') {
      if (order.status !== 'finalized') return <span className="mj-secondary">—</span>;
      if (order.net === 0) return <span className="mj-secondary">No payment due</span>;
      return order.outstanding > 0
        ? <div className="mj-cell-stack"><span className="sales-num--due">{formatEur(order.outstanding)} outstanding</span><span className="mj-secondary">{formatEur(order.settled)} paid of {formatEur(order.net)}</span></div>
        : <div className="mj-cell-stack"><span>Paid in full</span><span className="mj-secondary">{formatEur(order.settled)}</span></div>;
    }
    if (key === 'invoice') {
      const request = order.activeRequest;
      if (!request) return <span className="mj-secondary">—</span>;
      return <div className="mj-cell-stack"><RequestStateTag request={request} /><span className="mj-secondary">{requestNext(request, order.settlement === 'paid', requestReadiness(request, order.customer).every((item) => item.ok))}</span></div>;
    }
    if (key === 'total') return <span className="sales-num">{formatEur(order.total)}</span>;
    return formatDateTime(order.updatedAt);
  };

  return (
    <div className="mj-stack">
      <DataTable key={`${page}-${pageSize}-${params.toString()}-${sort.key}-${sort.direction}`} rows={tableRows} headers={HEADERS.map(({ key, header }) => ({ key, header }))}>
        {({ rows, headers, getRowProps, getTableProps }) => (
          <TableContainer className="mj-table-container">
            <TableToolbar aria-label="Orders table toolbar">
              <SectionSwitcher
                label="Order sections" selected={section}
                sections={[{ id: 'open', label: `Open (${views.filter((order) => !paidView.has(order)).length})` }, { id: 'paid', label: `Paid (${counts.paid})` }]}
                onChange={(id) => update({ section: id === 'paid' ? 'paid' : null, view: null })}
              />
              <TableToolbarContent>
                <TableToolbarSearch key={searchKey} id="orders-search" labelText="Search orders" placeholder="Search by reference or customer" defaultValue={search} onChange={(_event, value) => update({ q: value ?? '' })} onClear={() => update({ q: null })} />
                <BatchFilter
                  id="orders" label="Orders" applied={appliedFilters} onApply={(values) => update(toPatch(values, [...FILTER_KEYS]))} onReset={() => update(Object.fromEntries(FILTER_KEYS.map((key) => [key, null])))}
                  categories={[
                    ...(section === 'open' ? [{ key: 'view', label: 'Status', options: sectionViews.map((item) => ({ id: item.id, label: `${item.label} (${counts[item.id]})` })) }] : []),
                    { key: 'type', label: 'Customer type', options: TYPE_OPTIONS },
                    {
                      key: 'customer', label: 'Customer', keys: ['customer'],
                      render: ({ idPrefix, staged, set }) => (
                        <ComboBox<{ id: string; label: string }>
                          id={`${idPrefix}-customer`} titleText="Customer" placeholder="Any customer" items={customers} itemToString={(item) => item?.label ?? ''}
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
                />
                {canWrite && <Button kind="primary" size="lg" renderIcon={Add} className="sales-toolbar-action" onClick={() => setCreating(true)}>New order</Button>}
              </TableToolbarContent>
            </TableToolbar>
            {notice}
            <Table {...getTableProps()} aria-label="Orders">
              <TableHead>
                <TableRow>
                  {headers.map((header) => {
                    const meta = HEADERS.find((item) => item.key === header.key);
                    const className = meta?.narrow ? 'mj-hide-narrow' : meta?.num ? 'sales-num' : undefined;
                    return meta?.sort
                      ? <TableHeader key={header.key} className={className} isSortable isSortHeader={sort.key === meta.sort} sortDirection={sort.key === meta.sort ? sort.direction : 'NONE'} onClick={() => sortBy(meta.sort!)}>{header.header}</TableHeader>
                      : <TableHeader key={header.key} className={className}>{header.header}</TableHeader>;
                  })}
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((tableRow) => {
                  const order = byId.get(tableRow.id);
                  if (!order) return null;
                  const { key, ...rowProps } = getRowProps({ row: tableRow });
                  return (
                    <TableRow key={key} {...rowProps} className="mj-table-row" onClick={() => navigate(`/sales/orders/${order.id}`)}>
                      {tableRow.cells.map((cell) => {
                        const meta = HEADERS.find((item) => item.key === cell.info.header);
                        return <TableCell key={cell.id} className={meta?.narrow ? 'mj-hide-narrow' : meta?.num ? 'sales-num' : undefined}>{renderCell(order, cell.info.header)}</TableCell>;
                      })}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {visible.length === 0 && (views.length === 0 || loadingEmpty
              ? <EmptyState title="No orders yet" description="Orders are created from finished jobs or by hand." action={canWrite ? <Button kind="tertiary" onClick={() => setCreating(true)}>New order</Button> : undefined} />
              : <EmptyState title="No orders found" description="Try different search terms or filters." action={<Button kind="tertiary" onClick={clearAll}>Clear filters</Button>} />)}
            <Pagination page={page} pageSize={pageSize} pageSizes={PAGE_SIZES} totalItems={visible.length} onChange={({ page: nextPage, pageSize: nextSize }) => update({ page: String(nextPage), pageSize: String(nextSize) })} />
            {creating && <EditOrderModal order={null} initialCustomer={null} onClose={() => setCreating(false)} onSaved={(id) => navigate(`/sales/orders/${id}`)} />}
          </TableContainer>
        )}
      </DataTable>
    </div>
  );
}

export function OrdersPage() {
  const store = useStore();
  const { query, data, views } = useSalesData();
  // `?review=1` opens the ready-to-bill review, so links from the overview land on it directly.
  const [params, setParams] = useSearchParams();
  const reviewing = params.get('review') === '1';
  const setReviewing = (open: boolean) => setParams((previous) => {
    const next = new URLSearchParams(previous);
    if (open) next.set('review', '1'); else next.delete('review');
    return next;
  }, { replace: true });
  const groups = useMemo(() => readyToBill(data.jobs, data.orders, data.prints, Date.now()), [data.jobs, data.orders, data.prints]);
  const readyCount = groups.reduce((total, group) => total + group.ready.length, 0);
  const readyCustomers = groups.filter((group) => group.ready.length > 0).length;
  const readyValue = groups.reduce((total, group) => total + group.total, 0);

  return (
    <RequirePermission permission="orders.read" title="Orders" crumbs={[{ label: 'Sales & payments' }, { label: 'Orders' }]}>
      <PageShell title="Orders" description="Charges for jobs and items, what has been paid and what is invoiced." width="wide" breadcrumbs={[{ label: 'Sales & payments', to: '/sales' }, { label: 'Orders' }]}>
        <QueryBoundary query={query} errorMessage="The orders could not be loaded.">
          <OrdersTable
            views={views} loadingEmpty={store.scenario === 'empty'}
            notice={readyCount > 0 && (
              <div className="sales-ready-bar">
                <InlineNotification lowContrast hideCloseButton kind="info" className="sales-ready-notice" title={`${readyCount} finished ${readyCount === 1 ? 'job is' : 'jobs are'} ready to bill`}
                  subtitle={`${formatEur(readyValue)} from ${readyCustomers} ${readyCustomers === 1 ? 'customer' : 'customers'}, on no order yet.`} />
                <Button kind="secondary" size="lg" renderIcon={ListChecked} className="sales-toolbar-action" onClick={() => setReviewing(true)}>Review jobs</Button>
              </div>
            )}
          />
          {reviewing && <ReadyToBillModal jobs={data.jobs} orders={data.orders} prints={data.prints} canCreate={store.can('orders.write')} onClose={() => setReviewing(false)} />}
        </QueryBoundary>
      </PageShell>
    </RequirePermission>
  );
}
