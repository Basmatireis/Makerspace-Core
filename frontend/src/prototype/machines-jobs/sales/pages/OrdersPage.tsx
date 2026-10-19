import { useMemo, useState, type ReactNode } from 'react';
import {
  ActionableNotification, Button, Checkbox, CheckboxGroup, DataTable, DismissibleTag, Link as CarbonLink, Pagination, Popover, PopoverContent, Select, SelectItem, Tab, TabList, Table, TableBody,
  TableCell, TableContainer, TableHead, TableHeader, TableRow, TableToolbar, TableToolbarContent, TableToolbarSearch, Tabs,
} from '@carbon/react';
import { Add, Filter } from '@carbon/icons-react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { DateInput } from '../../../../app/DateInput';
import { PageShell } from '../../../../app/PageShell';
import { EmptyState } from '../../../../app/PageState';
import { QueryBoundary } from '../../components/QueryBoundary';
import { useStore } from '../../store';
import { RequirePermission } from '../components/RequirePermission';
import { EditOrderModal } from '../dialogs/EditOrderModal';
import { ReadyToBillModal } from '../dialogs/ReadyToBillModal';
import { dateInAppTimeZone, formatDateTime, formatEur } from '../format';
import { customerKindLabel } from '../labels';
import { activeItems, readyToBill, requestNext, requestReadiness, type OrderView } from '../logic';
import { orderStatus, OrderStatusTag, orderStatusOptions, RequestStateTag, type OrderStatusKey } from '../status';
import { useSalesData } from '../useSalesData';
import '../sales.scss';

type SortKey = 'order' | 'payment' | 'total' | 'updated';
type ViewId = 'all' | 'drafts' | 'awaiting' | 'paid' | 'invoice';
const PAGE_SIZES = [10, 25, 50];
const FILTER_KEYS = ['status', 'type', 'from', 'to', 'customer'] as const;
const TYPE_OPTIONS = [{ id: 'person', label: customerKindLabel('person') }, { id: 'organization', label: customerKindLabel('organization') }];
const VIEWS: { id: ViewId; label: string; has: (order: OrderView) => boolean }[] = [
  { id: 'all', label: 'All', has: () => true },
  { id: 'drafts', label: 'Drafts', has: (order) => order.status === 'draft' },
  { id: 'awaiting', label: 'Awaiting payment', has: (order) => order.status === 'finalized' && order.outstanding > 0 },
  { id: 'paid', label: 'Paid', has: (order) => order.status === 'finalized' && (order.settlement === 'paid' || order.settlement === 'no_payment_due') },
  { id: 'invoice', label: 'Invoice requested', has: (order) => order.activeRequest !== null },
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
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [searchKey, setSearchKey] = useState(0);
  const [sort, setSort] = useState<{ key: SortKey; direction: 'ASC' | 'DESC' }>({ key: 'updated', direction: 'DESC' });
  const canWrite = store.can('orders.write');
  const view = VIEWS.find((item) => item.id === params.get('view')) ?? VIEWS[0];
  const statuses = list(params.get('status'));
  const types = list(params.get('type'));
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const customerId = params.get('customer') ?? '';
  const customerName = customerId ? views.find((order) => order.customer.id === customerId)?.customerLabel ?? 'Unknown customer' : '';
  const search = params.get('q') ?? '';
  const activeFilters = FILTER_KEYS.filter((key) => params.get(key)).length;

  const update = (patch: Record<string, string | null>) => setParams((previous) => {
    const next = new URLSearchParams(previous);
    for (const [key, value] of Object.entries(patch)) { if (value) next.set(key, value); else next.delete(key); }
    if (!('page' in patch)) next.delete('page');
    return next;
  }, { replace: true });
  const toggleIn = (key: string, current: string[], id: string, checked: boolean) => update({ [key]: (checked ? [...current, id] : current.filter((item) => item !== id)).join(',') || null });
  const clearAll = () => { update({ ...Object.fromEntries(FILTER_KEYS.map((key) => [key, null])), q: null }); setSearchKey((value) => value + 1); };
  const setView = (id: ViewId) => update({ view: id === 'all' ? null : id });
  const counts = useMemo(() => Object.fromEntries(VIEWS.map((item) => [item.id, views.filter((order) => item.has(order) && (!customerId || order.customer.id === customerId)).length])) as Record<ViewId, number>, [views, customerId]);

  const visible = useMemo(() => {
    const direction = sort.direction === 'ASC' ? 1 : -1;
    const needle = search.trim().toLowerCase();
    return views.filter((order) => {
      const day = dateInAppTimeZone(order.createdAt);
      return view.has(order)
        && (statuses.length === 0 || statuses.includes(orderStatus(order).key))
        && (types.length === 0 || types.includes(order.customerKind))
        && (!customerId || order.customer.id === customerId)
        && (!from || day >= from) && (!to || day <= to)
        && (!needle || `${order.reference} ${order.customerName}`.toLowerCase().includes(needle));
    }).sort((a, b) => {
      const value = (order: OrderView) => sort.key === 'order' ? order.reference : sort.key === 'total' ? order.total : sort.key === 'payment' ? order.outstanding : order.updatedAt;
      const x = value(a); const y = value(b);
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * direction;
    });
  }, [views, sort, search, view, statuses.join(','), types.join(','), from, to, customerId]); // eslint-disable-line react-hooks/exhaustive-deps

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
      <div className="sales-period">
        <div className="mj-hide-narrow">
          <Tabs selectedIndex={VIEWS.indexOf(view)} onChange={({ selectedIndex }) => setView(VIEWS[selectedIndex].id)}>
            <TabList aria-label="Order views" contained>
              {VIEWS.map((item) => <Tab key={item.id}>{`${item.label} (${counts[item.id]})`}</Tab>)}
            </TabList>
          </Tabs>
        </div>
        <div className="mj-show-narrow">
          <Select id="orders-view" labelText="Show" value={view.id} onChange={(event) => setView(event.target.value as ViewId)}>
            {VIEWS.map((item) => <SelectItem key={item.id} value={item.id} text={`${item.label} (${counts[item.id]})`} />)}
          </Select>
        </div>
        {customerId && <DismissibleTag type="blue" size="md" text={`Customer: ${customerName}`} title="Remove the customer filter" dismissTitle="Remove the customer filter" onClose={() => update({ customer: null })} />}
      </div>
      <DataTable key={`${page}-${pageSize}-${params.toString()}-${sort.key}-${sort.direction}`} rows={tableRows} headers={HEADERS.map(({ key, header }) => ({ key, header }))}>
        {({ rows, headers, getRowProps, getTableProps }) => (
          <TableContainer className="mj-table-container">
            {notice}
            <TableToolbar aria-label="Orders table toolbar">
              <TableToolbarContent>
                <TableToolbarSearch key={searchKey} id="orders-search" labelText="Search orders" placeholder="Search by reference or customer" defaultValue={search} onChange={(_event, value) => update({ q: value ?? '' })} onClear={() => update({ q: null })} />
                <Popover open={filtersOpen} align="bottom-end" className="sales-filter-popover">
                  <Button hasIconOnly kind={activeFilters ? 'primary' : 'ghost'} size="md" renderIcon={Filter} iconDescription={activeFilters ? `Filters (${activeFilters} active)` : 'Filters'} aria-expanded={filtersOpen} onClick={() => setFiltersOpen((open) => !open)} />
                  <PopoverContent>
                    <div className="sales-filters" role="group" aria-label="Order filters">
                      <CheckboxGroup legendText="Status" helperText="Reversed and cancelled orders show up here.">
                        {orderStatusOptions.map((option) => <Checkbox key={option.id} id={`orders-status-${option.id}`} labelText={option.label} checked={statuses.includes(option.id)} onChange={(_event, { checked }) => toggleIn('status', statuses, option.id as OrderStatusKey, checked)} />)}
                      </CheckboxGroup>
                      <CheckboxGroup legendText="Customer type">
                        {TYPE_OPTIONS.map((option) => <Checkbox key={option.id} id={`orders-type-${option.id}`} labelText={option.label} checked={types.includes(option.id)} onChange={(_event, { checked }) => toggleIn('type', types, option.id, checked)} />)}
                      </CheckboxGroup>
                      <DateInput id="orders-from" labelText="Created from" value={from} onChange={(value) => update({ from: value || null })} />
                      <DateInput id="orders-to" labelText="Created through" value={to} onChange={(value) => update({ to: value || null })} />
                      <div className="sales-filters__actions">
                        <Button kind="ghost" size="sm" disabled={activeFilters === 0} onClick={() => update(Object.fromEntries(FILTER_KEYS.map((key) => [key, null])))}>Clear filters</Button>
                        <Button kind="secondary" size="sm" onClick={() => setFiltersOpen(false)}>Done</Button>
                      </div>
                    </div>
                  </PopoverContent>
                </Popover>
                {canWrite && <Button kind="primary" size="lg" renderIcon={Add} onClick={() => setCreating(true)}>New order</Button>}
              </TableToolbarContent>
            </TableToolbar>
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
              : <EmptyState title="No orders found" description={view.id === 'all' ? 'Try different search terms or filters.' : `No order matches “${view.label}” and the filters.`} action={<Button kind="tertiary" onClick={() => { clearAll(); setView('all'); }}>Clear filters</Button>} />)}
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
  const [reviewing, setReviewing] = useState(false);
  const groups = useMemo(() => readyToBill(data.jobs, data.orders, data.prints, Date.now()), [data.jobs, data.orders, data.prints]);
  const readyCount = groups.reduce((total, group) => total + group.ready.length, 0);
  const readyCustomers = groups.filter((group) => group.ready.length > 0).length;

  return (
    <RequirePermission permission="orders.read" title="Orders" crumbs={[{ label: 'Sales & payments' }, { label: 'Orders' }]}>
      <PageShell title="Orders" description="Charges for jobs and items, what has been paid and what is invoiced." width="wide" breadcrumbs={[{ label: 'Sales & payments', to: '/sales' }, { label: 'Orders' }]}>
        <QueryBoundary query={query} errorMessage="The orders could not be loaded.">
          <OrdersTable
            views={views} loadingEmpty={store.scenario === 'empty'}
            notice={readyCount > 0 && (
              <ActionableNotification inline lowContrast hideCloseButton kind="info" className="sales-ready-notice" title={`${readyCount} finished ${readyCount === 1 ? 'job is' : 'jobs are'} ready to bill`}
                subtitle={`${readyCustomers} ${readyCustomers === 1 ? 'customer' : 'customers'} have finished jobs that are on no order yet.`} actionButtonLabel="Review jobs" onActionButtonClick={() => setReviewing(true)} />
            )}
          />
          {reviewing && <ReadyToBillModal jobs={data.jobs} orders={data.orders} prints={data.prints} canCreate={store.can('orders.write')} onClose={() => setReviewing(false)} />}
        </QueryBoundary>
      </PageShell>
    </RequirePermission>
  );
}
