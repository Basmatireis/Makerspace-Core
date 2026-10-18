import { useMemo, useState } from 'react';
import {
  Button, Checkbox, CheckboxGroup, Link as CarbonLink, Pagination, Popover, PopoverContent, Select, SelectItem, Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow,
  TableToolbar, TableToolbarContent, TableToolbarSearch, Tag, Toggle,
} from '@carbon/react';
import { Add, Filter } from '@carbon/icons-react';
import { Link, useNavigate } from 'react-router-dom';
import { PageShell } from '../../../../app/PageShell';
import { EmptyState } from '../../../../app/PageState';
import { QueryBoundary } from '../../components/QueryBoundary';
import { useStore } from '../../store';
import { RequirePermission } from '../components/RequirePermission';
import { NewRequestModal } from '../dialogs/NewRequestModal';
import { formatDateTime, formatEur } from '../format';
import { requestStateLabel } from '../labels';
import { requestNext, type OrderView } from '../logic';
import { RequestStateTag } from '../status';
import { useSalesData } from '../useSalesData';
import { useUrlParams } from '../useUrlParams';
import type { InvoiceRequest, InvoiceRequestState } from '../types';
import '../sales.scss';

type SortKey = 'request' | 'amount' | 'updated';
const PAGE_SIZES = [10, 25, 50];
const FILTER_KEYS = ['state', 'customer', 'open'] as const;
const STATES = Object.keys(requestStateLabel) as InvoiceRequestState[];
const lastChange = (request: InvoiceRequest) => request.events.at(-1)?.at ?? request.createdAt;
/** Still needs a step from us: not cancelled, and not an issued invoice whose payment is confirmed. */
const isOpen = (request: InvoiceRequest, order: OrderView | undefined) => request.state !== 'cancelled' && !(request.state === 'issued' && order?.settlement === 'paid');

function RequestList({ requests, views, empty }: { requests: InvoiceRequest[]; views: OrderView[]; empty: boolean }) {
  const store = useStore();
  const navigate = useNavigate();
  const { params, update, list, toggleIn } = useUrlParams();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [searchKey, setSearchKey] = useState(0);
  const [sort, setSort] = useState<{ key: SortKey; direction: 'ASC' | 'DESC' }>({ key: 'updated', direction: 'DESC' });
  const states = list('state');
  const customer = params.get('customer') ?? '';
  const openOnly = params.get('open') === '1';
  const search = params.get('q') ?? '';
  const activeFilters = FILTER_KEYS.filter((key) => params.get(key)).length;
  const orderOf = (request: InvoiceRequest) => views.find((order) => order.id === request.orderId);
  const customers = useMemo(() => [...new Map(requests.flatMap((request) => { const order = views.find((item) => item.id === request.orderId); return order?.customer ? [[order.customer.id, order.customerLabel] as const] : []; })).entries()].sort((a, b) => a[1].localeCompare(b[1])), [requests, views]);

  const visible = useMemo(() => {
    const direction = sort.direction === 'ASC' ? 1 : -1;
    const needle = search.trim().toLowerCase();
    return requests.filter((request) => {
      const order = views.find((item) => item.id === request.orderId);
      return (states.length === 0 || states.includes(request.state)) && (!customer || order?.customer?.id === customer) && (!openOnly || isOpen(request, order))
        && (!needle || `${request.reference} ${request.orderReference} ${request.details.recipientName} ${order?.customerLabel ?? ''}`.toLowerCase().includes(needle));
    }).sort((a, b) => {
      const x = sort.key === 'request' ? a.reference : sort.key === 'amount' ? a.requestedAmount : lastChange(a);
      const y = sort.key === 'request' ? b.reference : sort.key === 'amount' ? b.requestedAmount : lastChange(b);
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * direction;
    });
  }, [requests, views, sort, search, states.join(','), customer, openOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  const pageSize = PAGE_SIZES.includes(Number(params.get('pageSize'))) ? Number(params.get('pageSize')) : 10;
  const page = Math.max(1, Math.min(Number(params.get('page')) || 1, Math.ceil(visible.length / pageSize) || 1));
  const rows = visible.slice((page - 1) * pageSize, page * pageSize);
  const canManage = store.can('external_invoice_requests.manage');
  const clearAll = () => { update({ ...Object.fromEntries(FILTER_KEYS.map((key) => [key, null])), q: null }); setSearchKey((value) => value + 1); };
  const sortBy = (key: SortKey) => setSort((current) => current.key === key ? { key, direction: current.direction === 'ASC' ? 'DESC' : 'ASC' } : { key, direction: key === 'request' ? 'ASC' : 'DESC' });
  const header = (key: SortKey, text: string, className?: string) => <TableHeader className={className} isSortable isSortHeader={sort.key === key} sortDirection={sort.key === key ? sort.direction : 'NONE'} onClick={() => sortBy(key)}>{text}</TableHeader>;

  return (
    <TableContainer className="mj-table-container">
      <TableToolbar aria-label="wiRef requests toolbar">
        <TableToolbarContent>
          <TableToolbarSearch key={searchKey} id="invoicing-search" labelText="Search requests" placeholder="Search by request, order or customer" defaultValue={search} onChange={(_event, value) => update({ q: value ?? '' })} onClear={() => update({ q: null })} />
          <Popover open={filtersOpen} align="bottom-end" className="sales-filter-popover">
            <Button hasIconOnly kind={activeFilters ? 'primary' : 'ghost'} size="md" renderIcon={Filter} iconDescription={activeFilters ? `Filters (${activeFilters} active)` : 'Filters'} aria-expanded={filtersOpen} onClick={() => setFiltersOpen((open) => !open)} />
            <PopoverContent>
              <div className="sales-filters" role="group" aria-label="Request filters">
                <CheckboxGroup legendText="State">
                  {STATES.map((state) => <Checkbox key={state} id={`invoicing-state-${state}`} labelText={requestStateLabel[state]} checked={states.includes(state)} onChange={(_event, { checked }) => toggleIn('state', state, checked)} />)}
                </CheckboxGroup>
                <Select id="invoicing-customer" labelText="Customer" value={customer} onChange={(event) => update({ customer: event.target.value || null })}>
                  <SelectItem value="" text="All customers" />
                  {customers.map(([id, name]) => <SelectItem key={id} value={id} text={name} />)}
                </Select>
                <Toggle id="invoicing-open" size="sm" labelText="Progress" labelA="All requests" labelB="Only requests that need a step" toggled={openOnly} onToggle={(checked) => update({ open: checked ? '1' : null })} />
                <div className="sales-filters__actions">
                  <Button kind="ghost" size="sm" disabled={activeFilters === 0} onClick={() => update(Object.fromEntries(FILTER_KEYS.map((key) => [key, null])))}>Clear filters</Button>
                  <Button kind="secondary" size="sm" onClick={() => setFiltersOpen(false)}>Done</Button>
                </div>
              </div>
            </PopoverContent>
          </Popover>
          {canManage && <Button kind="primary" size="lg" renderIcon={Add} onClick={() => setCreating(true)}>New request</Button>}
        </TableToolbarContent>
      </TableToolbar>
      <Table aria-label="wiRef requests">
        <TableHead>
          <TableRow>
            {header('request', 'Request')}<TableHeader>Customer</TableHeader><TableHeader>State</TableHeader>{header('amount', 'Amount', 'sales-num')}
            <TableHeader className="mj-hide-narrow">Next step</TableHeader>{header('updated', 'Updated', 'mj-hide-narrow')}
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((request) => {
            const order = orderOf(request);
            const paid = order?.settlement === 'paid';
            return (
              <TableRow key={request.id} className="mj-table-row" onClick={() => navigate(`/sales/invoicing/${request.id}`)}>
                <TableCell>
                  <div className="mj-cell-stack">
                    <CarbonLink as={Link} to={`/sales/invoicing/${request.id}`} onClick={(event: React.MouseEvent) => event.stopPropagation()}>{request.reference}</CarbonLink>
                    <CarbonLink as={Link} to={`/sales/orders/${request.orderId}`} onClick={(event: React.MouseEvent) => event.stopPropagation()}>{request.orderReference}</CarbonLink>
                  </div>
                </TableCell>
                <TableCell>{order?.customerLabel ?? request.details.recipientName}</TableCell>
                <TableCell><div className="mj-cell-stack"><RequestStateTag request={request} />{request.state === 'issued' && paid && <Tag type="green" size="sm">Paid</Tag>}</div></TableCell>
                <TableCell className="sales-num">{formatEur(request.requestedAmount)}</TableCell>
                <TableCell className="mj-hide-narrow">{requestNext(request, paid)}</TableCell>
                <TableCell className="mj-hide-narrow">{formatDateTime(lastChange(request))}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {visible.length === 0 && (requests.length === 0 || empty
        ? <EmptyState title="No wiRef request yet" description="Customers who get an invoice instead of paying at the desk need a request. Prepare one from a finalized order." action={canManage ? <Button kind="tertiary" onClick={() => setCreating(true)}>New request</Button> : undefined} />
        : <EmptyState title="No requests found" description="Try different search terms or filters." action={<Button kind="tertiary" onClick={clearAll}>Clear filters</Button>} />)}
      <Pagination page={page} pageSize={pageSize} pageSizes={PAGE_SIZES} totalItems={visible.length} onChange={({ page: nextPage, pageSize: nextSize }) => update({ page: String(nextPage), pageSize: String(nextSize) })} />
      {creating && <NewRequestModal views={views} onClose={() => setCreating(false)} onCreated={(id) => navigate(`/sales/invoicing/${id}`)} />}
    </TableContainer>
  );
}

export function InvoicingPage() {
  const store = useStore();
  const { query, data, views } = useSalesData();
  return (
    <RequirePermission permission="external_invoice_requests.read" title="Invoicing" crumbs={[{ label: 'Sales & payments', to: '/sales' }, { label: 'Invoicing' }]}>
      <PageShell title="Invoicing" description="wiRef invoice requests, from preparation to the confirmed payment." width="wide" breadcrumbs={[{ label: 'Sales & payments', to: '/sales' }, { label: 'Invoicing' }]}>
        <QueryBoundary query={query} errorMessage="The invoice requests could not be loaded.">
          <RequestList requests={data.requests} views={views} empty={store.scenario === 'empty'} />
        </QueryBoundary>
      </PageShell>
    </RequirePermission>
  );
}
