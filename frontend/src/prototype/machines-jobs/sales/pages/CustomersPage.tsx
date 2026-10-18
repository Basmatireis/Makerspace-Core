import { useMemo, useState } from 'react';
import {
  Button, Checkbox, CheckboxGroup, Link as CarbonLink, Pagination, Popover, PopoverContent, Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow, TableToolbar, TableToolbarContent,
  TableToolbarSearch, Tag, Toggle,
} from '@carbon/react';
import { Filter } from '@carbon/icons-react';
import { Link, useNavigate } from 'react-router-dom';
import { PageShell } from '../../../../app/PageShell';
import { EmptyState } from '../../../../app/PageState';
import { QueryBoundary } from '../../components/QueryBoundary';
import { useNow, useStore } from '../../store';
import { RequirePermission } from '../components/RequirePermission';
import { formatDateTime, formatEur } from '../format';
import { customerKindLabel } from '../labels';
import { customerSummaries } from '../logic';
import { effectiveGroup } from '../pricing';
import { useSalesData } from '../useSalesData';
import { useUrlParams } from '../useUrlParams';
import '../sales.scss';

type SortKey = 'name' | 'balance' | 'activity';
const PAGE_SIZES = [10, 25, 50];
const FILTER_KEYS = ['type', 'group', 'balance'] as const;

function CustomerList({ empty }: { empty: boolean }) {
  const store = useStore();
  const navigate = useNavigate();
  const now = useNow();
  const { data, views } = useSalesData();
  const { params, update, list, toggleIn } = useUrlParams();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [searchKey, setSearchKey] = useState(0);
  const [sort, setSort] = useState<{ key: SortKey; direction: 'ASC' | 'DESC' }>({ key: 'name', direction: 'ASC' });
  const types = list('type'); const groups = list('group');
  const balanceOnly = params.get('balance') === '1';
  const search = params.get('q') ?? '';
  const activeFilters = FILTER_KEYS.filter((key) => params.get(key)).length;
  const summaries = useMemo(() => empty ? [] : customerSummaries(store.customers, views, data.jobs, data.prints, now), [empty, store.customers, views, data.jobs, data.prints, now]);
  const groupOf = (customer: (typeof store.customers)[number]) => effectiveGroup(store.pricing, customer.pricingGroup).name;

  const visible = useMemo(() => {
    const direction = sort.direction === 'ASC' ? 1 : -1;
    const needle = search.trim().toLowerCase();
    return summaries.filter((item) => (types.length === 0 || types.includes(item.customer.kind)) && (groups.length === 0 || groups.includes(effectiveGroup(store.pricing, item.customer.pricingGroup).name))
      && (!balanceOnly || item.openBalance > 0) && (!needle || item.customer.displayName.toLowerCase().includes(needle))).sort((a, b) => {
      const x = sort.key === 'name' ? a.customer.displayName : sort.key === 'balance' ? a.openBalance : a.lastActivity ?? '';
      const y = sort.key === 'name' ? b.customer.displayName : sort.key === 'balance' ? b.openBalance : b.lastActivity ?? '';
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * direction;
    });
  }, [summaries, sort, search, types.join(','), groups.join(','), balanceOnly, store.pricing]); // eslint-disable-line react-hooks/exhaustive-deps

  const pageSize = PAGE_SIZES.includes(Number(params.get('pageSize'))) ? Number(params.get('pageSize')) : 10;
  const page = Math.max(1, Math.min(Number(params.get('page')) || 1, Math.ceil(visible.length / pageSize) || 1));
  const rows = visible.slice((page - 1) * pageSize, page * pageSize);
  const clearAll = () => { update({ ...Object.fromEntries(FILTER_KEYS.map((key) => [key, null])), q: null }); setSearchKey((value) => value + 1); };
  const sortBy = (key: SortKey) => setSort((current) => current.key === key ? { key, direction: current.direction === 'ASC' ? 'DESC' : 'ASC' } : { key, direction: key === 'name' ? 'ASC' : 'DESC' });
  const header = (key: SortKey, text: string, className?: string) => <TableHeader className={className} isSortable isSortHeader={sort.key === key} sortDirection={sort.key === key ? sort.direction : 'NONE'} onClick={() => sortBy(key)}>{text}</TableHeader>;

  return (
    <TableContainer className="mj-table-container">
      <TableToolbar aria-label="Customers toolbar">
        <TableToolbarContent>
          <TableToolbarSearch key={searchKey} id="customers-search" labelText="Search customers" placeholder="Search by name" defaultValue={search} onChange={(_event, value) => update({ q: value ?? '' })} onClear={() => update({ q: null })} />
          <Popover open={filtersOpen} align="bottom-end" className="sales-filter-popover">
            <Button hasIconOnly kind={activeFilters ? 'primary' : 'ghost'} size="md" renderIcon={Filter} iconDescription={activeFilters ? `Filters (${activeFilters} active)` : 'Filters'} aria-expanded={filtersOpen} onClick={() => setFiltersOpen((open) => !open)} />
            <PopoverContent>
              <div className="sales-filters" role="group" aria-label="Customer filters">
                <CheckboxGroup legendText="Type">
                  {(['person', 'organization'] as const).map((kind) => <Checkbox key={kind} id={`customers-type-${kind}`} labelText={customerKindLabel(kind)} checked={types.includes(kind)} onChange={(_event, { checked }) => toggleIn('type', kind, checked)} />)}
                </CheckboxGroup>
                <CheckboxGroup legendText="Pricing group">
                  {store.pricing.groups.map((group) => <Checkbox key={group.id} id={`customers-group-${group.id}`} labelText={group.name} checked={groups.includes(group.name)} onChange={(_event, { checked }) => toggleIn('group', group.name, checked)} />)}
                </CheckboxGroup>
                <Toggle id="customers-balance" size="sm" labelText="Balance" labelA="Any" labelB="Only with an open balance" toggled={balanceOnly} onToggle={(checked) => update({ balance: checked ? '1' : null })} />
                <div className="sales-filters__actions">
                  <Button kind="ghost" size="sm" disabled={activeFilters === 0} onClick={() => update(Object.fromEntries(FILTER_KEYS.map((key) => [key, null])))}>Clear filters</Button>
                  <Button kind="secondary" size="sm" onClick={() => setFiltersOpen(false)}>Done</Button>
                </div>
              </div>
            </PopoverContent>
          </Popover>
        </TableToolbarContent>
      </TableToolbar>
      <Table aria-label="Customers">
        <TableHead>
          <TableRow>
            {header('name', 'Customer')}<TableHeader className="mj-hide-narrow">Pricing group</TableHeader>{header('balance', 'Open balance', 'sales-num')}
            <TableHeader className="sales-num mj-hide-narrow">Orders</TableHeader>{header('activity', 'Last activity', 'mj-hide-narrow')}
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map(({ customer, orders, openBalance, lastActivity }) => (
            <TableRow key={customer.id} className="mj-table-row" onClick={() => navigate(`/sales/customers/${customer.kind}/${customer.id}`)}>
              <TableCell>
                <div className="mj-cell-stack">
                  <CarbonLink as={Link} to={`/sales/customers/${customer.kind}/${customer.id}`} onClick={(event: React.MouseEvent) => event.stopPropagation()}>{customer.displayName}</CarbonLink>
                  <span><Tag type={customer.kind === 'organization' ? 'blue' : 'cool-gray'} size="sm">{customerKindLabel(customer.kind)}</Tag></span>
                </div>
              </TableCell>
              <TableCell className="mj-hide-narrow">{groupOf(customer)}{customer.pricingGroup === null && <span className="mj-secondary"> (default)</span>}</TableCell>
              <TableCell className={`sales-num${openBalance > 0 ? ' sales-num--due' : ''}`}>{formatEur(openBalance)}</TableCell>
              <TableCell className="sales-num mj-hide-narrow">{orders.filter((order) => order.status !== 'draft' && order.status !== 'cancelled').length}</TableCell>
              <TableCell className="mj-hide-narrow">{lastActivity ? formatDateTime(lastActivity) : '—'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {visible.length === 0 && (empty
        ? <EmptyState title="No customers yet" description="People and organizations show up here once they have a job or an order." />
        : <EmptyState title="No customers found" description="Try different search terms or filters." action={<Button kind="tertiary" onClick={clearAll}>Clear filters</Button>} />)}
      <Pagination page={page} pageSize={pageSize} pageSizes={PAGE_SIZES} totalItems={visible.length} onChange={({ page: nextPage, pageSize: nextSize }) => update({ page: String(nextPage), pageSize: String(nextSize) })} />
    </TableContainer>
  );
}

export function CustomersPage() {
  const store = useStore();
  const { query } = useSalesData();
  return (
    <RequirePermission permission="orders.read" title="Customers" crumbs={[{ label: 'Sales & payments', to: '/sales' }, { label: 'Customers' }]}>
      <PageShell title="Customers" description="People and organizations who are billed, with what they owe." width="wide" breadcrumbs={[{ label: 'Sales & payments', to: '/sales' }, { label: 'Customers' }]}>
        <QueryBoundary query={query} errorMessage="The customers could not be loaded.">
          <CustomerList empty={store.scenario === 'empty'} />
        </QueryBoundary>
      </PageShell>
    </RequirePermission>
  );
}
