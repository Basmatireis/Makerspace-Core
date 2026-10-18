import { useMemo, useState } from 'react';
import {
  Button, Checkbox, CheckboxGroup, DataTable, Link as CarbonLink, Pagination, Popover, PopoverContent, Tab, Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow,
  TableToolbar, TableToolbarContent, TableToolbarSearch, TabList, TabPanel, TabPanels, Tabs, Tag, Toggle,
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
import { dateInAppTimeZone, formatDateTime, formatEur } from '../format';
import { activeItems, readyToBill, type OrderView } from '../logic';
import { orderStatus, OrderStatusTag, orderStatusOptions, type OrderStatusKey } from '../status';
import { useSalesData } from '../useSalesData';
import { ReadyToBillTab } from './ReadyToBillTab';
import '../sales.scss';

type SortKey = 'order' | 'total' | 'outstanding' | 'updated';
const PAGE_SIZES = [10, 25, 50];
const FILTER_KEYS = ['status', 'type', 'from', 'to', 'outstanding', 'wiref'] as const;
const TYPE_OPTIONS = [{ id: 'person', label: 'Person' }, { id: 'organization', label: 'Organization' }, { id: 'walk_in', label: 'Walk-in customer' }];
const HEADERS: { key: string; header: string; sort?: SortKey; narrow?: boolean }[] = [
  { key: 'order', header: 'Order', sort: 'order' }, { key: 'status', header: 'Status' }, { key: 'items', header: 'Items', narrow: true },
  { key: 'total', header: 'Total', sort: 'total' }, { key: 'outstanding', header: 'Outstanding', sort: 'outstanding' }, { key: 'updated', header: 'Updated', sort: 'updated', narrow: true },
];
const list = (value: string | null) => (value ?? '').split(',').filter(Boolean);

function AllOrders({ views, loadingEmpty }: { views: OrderView[]; loadingEmpty: boolean }) {
  const store = useStore();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [searchKey, setSearchKey] = useState(0);
  const [sort, setSort] = useState<{ key: SortKey; direction: 'ASC' | 'DESC' }>({ key: 'updated', direction: 'DESC' });
  const canWrite = store.can('orders.write');
  const statuses = list(params.get('status'));
  const types = list(params.get('type'));
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const outstandingOnly = params.get('outstanding') === '1';
  const wirefOnly = params.get('wiref') === '1';
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

  const visible = useMemo(() => {
    const direction = sort.direction === 'ASC' ? 1 : -1;
    const needle = search.trim().toLowerCase();
    return views.filter((order) => {
      const day = dateInAppTimeZone(order.createdAt);
      return (statuses.length === 0 || statuses.includes(orderStatus(order).key))
        && (types.length === 0 || types.includes(order.customerKind))
        && (!from || day >= from) && (!to || day <= to)
        && (!outstandingOnly || order.outstanding > 0)
        && (!wirefOnly || order.activeRequest !== null || order.latestRequest !== null)
        && (!needle || `${order.reference} ${order.customerName ?? 'walk-in customer'}`.toLowerCase().includes(needle));
    }).sort((a, b) => {
      const value = (order: OrderView) => sort.key === 'order' ? order.reference : sort.key === 'total' ? order.total : sort.key === 'outstanding' ? order.outstanding : order.updatedAt;
      const x = value(a); const y = value(b);
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * direction;
    });
  }, [views, sort, search, statuses.join(','), types.join(','), from, to, outstandingOnly, wirefOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  const pageSize = PAGE_SIZES.includes(Number(params.get('pageSize'))) ? Number(params.get('pageSize')) : 10;
  const page = Math.max(1, Math.min(Number(params.get('page')) || 1, Math.ceil(visible.length / pageSize) || 1));
  const pageRows = visible.slice((page - 1) * pageSize, page * pageSize);
  const byId = new Map(views.map((order) => [order.id, order]));
  const sortBy = (key: SortKey) => setSort((current) => current.key === key ? { key, direction: current.direction === 'ASC' ? 'DESC' : 'ASC' } : { key, direction: key === 'order' ? 'ASC' : 'DESC' });
  const tableRows = pageRows.map((order) => ({ id: order.id, order: order.reference, status: order.status, items: activeItems(order).length, total: order.total, outstanding: order.outstanding, updated: order.updatedAt }));

  const renderCell = (order: OrderView, key: string) => {
    if (key === 'order') {
      return (
        <div className="mj-cell-stack">
          <CarbonLink as={Link} to={`/sales/orders/${order.id}`} onClick={(event: React.MouseEvent) => event.stopPropagation()}>{order.reference}</CarbonLink>
          <span className="mj-secondary">{order.customerLabel}</span>
        </div>
      );
    }
    if (key === 'status') return <div className="mj-cell-stack"><OrderStatusTag order={order} size="sm" />{order.replacedBy && <span className="mj-secondary">Replaced by {order.replacedBy.reference}</span>}{order.replaces && <span className="mj-secondary">Replaces {order.replaces.reference}</span>}</div>;
    if (key === 'items') { const count = activeItems(order).length; return `${count} ${count === 1 ? 'item' : 'items'}`; }
    if (key === 'total') return <span className="sales-num">{formatEur(order.total)}</span>;
    if (key === 'outstanding') return <span className={`sales-num${order.outstanding > 0 ? ' sales-num--due' : ''}`}>{order.status === 'finalized' ? formatEur(order.outstanding) : '—'}</span>;
    return formatDateTime(order.updatedAt);
  };

  return (
    <DataTable key={`${page}-${pageSize}-${params.toString()}-${sort.key}-${sort.direction}`} rows={tableRows} headers={HEADERS.map(({ key, header }) => ({ key, header }))}>
      {({ rows, headers, getRowProps, getTableProps }) => (
        <TableContainer className="mj-table-container">
          <TableToolbar aria-label="Orders table toolbar">
            <TableToolbarContent>
              <TableToolbarSearch key={searchKey} id="orders-search" labelText="Search orders" placeholder="Search by reference or customer" defaultValue={search} onChange={(_event, value) => update({ q: value ?? '' })} onClear={() => update({ q: null })} />
              <Popover open={filtersOpen} align="bottom-end" className="sales-filter-popover">
                <Button hasIconOnly kind={activeFilters ? 'primary' : 'ghost'} size="md" renderIcon={Filter} iconDescription={activeFilters ? `Filters (${activeFilters} active)` : 'Filters'} aria-expanded={filtersOpen} onClick={() => setFiltersOpen((open) => !open)} />
                <PopoverContent>
                  <div className="sales-filters" role="group" aria-label="Order filters">
                    <CheckboxGroup legendText="Status">
                      {orderStatusOptions.map((option) => <Checkbox key={option.id} id={`orders-status-${option.id}`} labelText={option.label} checked={statuses.includes(option.id)} onChange={(_event, { checked }) => toggleIn('status', statuses, option.id as OrderStatusKey, checked)} />)}
                    </CheckboxGroup>
                    <CheckboxGroup legendText="Customer type">
                      {TYPE_OPTIONS.map((option) => <Checkbox key={option.id} id={`orders-type-${option.id}`} labelText={option.label} checked={types.includes(option.id)} onChange={(_event, { checked }) => toggleIn('type', types, option.id, checked)} />)}
                    </CheckboxGroup>
                    <DateInput id="orders-from" labelText="Created from" value={from} onChange={(value) => update({ from: value || null })} />
                    <DateInput id="orders-to" labelText="Created through" value={to} onChange={(value) => update({ to: value || null })} />
                    <Toggle id="orders-outstanding" size="sm" labelText="Outstanding amount" labelA="Any" labelB="Only with an outstanding amount" toggled={outstandingOnly} onToggle={(checked) => update({ outstanding: checked ? '1' : null })} />
                    <Toggle id="orders-wiref" size="sm" labelText="Invoicing" labelA="Any" labelB="Only with a wiRef request" toggled={wirefOnly} onToggle={(checked) => update({ wiref: checked ? '1' : null })} />
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
                  const className = meta?.narrow ? 'mj-hide-narrow' : meta?.key === 'total' || meta?.key === 'outstanding' ? 'sales-num' : undefined;
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
                      return <TableCell key={cell.id} className={meta?.narrow ? 'mj-hide-narrow' : meta?.key === 'total' || meta?.key === 'outstanding' ? 'sales-num' : undefined}>{renderCell(order, cell.info.header)}</TableCell>;
                    })}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {visible.length === 0 && (views.length === 0 || loadingEmpty
            ? <EmptyState title="No orders yet" description="Orders are created from the counter sale, from finished jobs, or by hand." action={canWrite ? <Button kind="tertiary" onClick={() => setCreating(true)}>New order</Button> : undefined} />
            : <EmptyState title="No orders found" description="Try different search terms or filters." action={<Button kind="tertiary" onClick={clearAll}>Clear filters</Button>} />)}
          <Pagination page={page} pageSize={pageSize} pageSizes={PAGE_SIZES} totalItems={visible.length} onChange={({ page: nextPage, pageSize: nextSize }) => update({ page: String(nextPage), pageSize: String(nextSize) })} />
          {creating && <EditOrderModal order={null} onClose={() => setCreating(false)} onSaved={(id) => navigate(`/sales/orders/${id}`)} />}
        </TableContainer>
      )}
    </DataTable>
  );
}

export function OrdersPage() {
  const store = useStore();
  const [params, setParams] = useSearchParams();
  const { query, data, views } = useSalesData();
  const tab = params.get('tab') === 'ready' ? 'ready' : 'all';
  const readyCount = useMemo(() => readyToBill(data.jobs, data.orders, data.prints, Date.now()).reduce((total, group) => total + group.ready.length, 0), [data.jobs, data.orders, data.prints]);
  const selectTab = (index: number) => setParams((previous) => { const next = new URLSearchParams(); if (index === 1) next.set('tab', 'ready'); else if (previous.get('q')) next.set('q', previous.get('q')!); return next; }, { replace: true });

  return (
    <RequirePermission permission="orders.read" title="Orders" crumbs={[{ label: 'Sales & payments' }, { label: 'Orders' }]}>
      <PageShell title="Orders" description="Charges for jobs and items, and what has been paid." width="wide" breadcrumbs={[{ label: 'Sales & payments', to: '/sales' }, { label: 'Orders' }]}>
        <QueryBoundary query={query} errorMessage="The orders could not be loaded.">
          <Tabs selectedIndex={tab === 'ready' ? 1 : 0} onChange={({ selectedIndex }) => selectTab(selectedIndex)}>
            <TabList aria-label="Order sections" contained>
              <Tab>All orders</Tab>
              <Tab>Ready to bill{readyCount > 0 && <Tag type="blue" size="sm" className="sales-tab-count">{readyCount}</Tag>}</Tab>
            </TabList>
            <TabPanels>
              <TabPanel className="sales-tab-panel"><AllOrders views={views} loadingEmpty={store.scenario === 'empty'} /></TabPanel>
              <TabPanel className="sales-tab-panel"><ReadyToBillTab jobs={data.jobs} orders={data.orders} prints={data.prints} canCreate={store.can('orders.write')} /></TabPanel>
            </TabPanels>
          </Tabs>
        </QueryBoundary>
      </PageShell>
    </RequirePermission>
  );
}
