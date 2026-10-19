import { lazy, Suspense, useMemo, useState } from 'react';
import {
  ContentSwitcher, DataTable, DataTableSkeleton, InlineNotification, Link as CarbonLink, SkeletonPlaceholder, SkeletonText, Switch,
  Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow, TableToolbar, TableToolbarContent, TableToolbarSearch,
  Button, Pagination, Tile,
} from '@carbon/react';
import { Link, useSearchParams } from 'react-router-dom';
import { dateInAppTimeZone } from '../../../app/dateTime';
import { DateInput } from '../../../app/DateInput';
import { PageShell } from '../../../app/PageShell';
import { EmptyState } from '../../../app/PageState';
import { BatchFilter, toPatch } from '../components/BatchFilter';
import { QueryBoundary } from '../components/QueryBoundary';
import { formatMoney } from '../derived';
import { addDays, addMonths, buildStatistics, daysBetween, type DateRange, type MachineStat, type Totals } from '../statsData';
import { lookups, useSimulatedQuery, useStore } from '../store';
import type { Job, Machine, MachineType, Material } from '../types';
import '../styles/statistics.scss';

// Carbon Charts and their stylesheet load only through this lazy boundary.
const StatisticsCharts = lazy(() => import('../components/StatisticsCharts'));

type Period = '30d' | '6m' | '12m' | 'custom';
type Option = { id: string; label: string };
type SortKey = 'machine' | 'jobs' | 'runtime' | 'failure' | 'charges' | 'share';
type Inputs = { machines: Machine[]; machineTypes: MachineType[]; jobs: Job[]; materials: Material[] };

const PERIODS: { id: Period; label: string }[] = [
  { id: '30d', label: '30 days' }, { id: '6m', label: '6 months' }, { id: '12m', label: '12 months' }, { id: 'custom', label: 'Custom' },
];
const MAX_DAYS = 1830;
const PAGE_SIZES = [10, 25, 50];
const EMPTY: Inputs = { machines: [], machineTypes: [], jobs: [], materials: [] };
const HEADERS: { key: SortKey; header: string; narrow?: boolean }[] = [
  { key: 'machine', header: 'Machine' },
  { key: 'jobs', header: 'Jobs' },
  { key: 'runtime', header: 'Runtime (h)' },
  { key: 'failure', header: 'Failure rate (%)', narrow: true },
  { key: 'charges', header: 'Charges (€)' },
  { key: 'share', header: 'Share of runtime (%)', narrow: true },
];

const integer = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1, minimumFractionDigits: 1 });

function presetRange(period: Exclude<Period, 'custom'>, today: string): DateRange {
  if (period === '30d') return { from: addDays(today, -29), to: today };
  return { from: addMonths(today, period === '6m' ? -6 : -12), to: today };
}

/** "+12 % vs previous period"; the sign and wording carry the meaning, never colour. */
function comparison(current: number, previous: number, mode: 'percent' | 'points') {
  if (mode === 'points') {
    if (previous === 0 && current === 0) return 'No data in previous period';
    const delta = current - previous;
    if (Math.abs(delta) < 0.05) return 'No change vs previous period';
    return `${delta > 0 ? '+' : '−'}${oneDecimal.format(Math.abs(delta))} pp vs previous period`;
  }
  if (previous === 0) return 'No data in previous period';
  const delta = Math.round(((current - previous) / previous) * 100);
  if (delta === 0) return 'No change vs previous period';
  return `${delta > 0 ? '+' : '−'}${integer.format(Math.abs(delta))} % vs previous period`;
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <Tile className="mj-stat">
      <span className="mj-stat__label">{label}</span>
      <span className="mj-stat__value">{value}</span>
      <span className="mj-secondary">{detail}</span>
    </Tile>
  );
}

function ChartsSkeleton() {
  return (
    <div className="mj-stats-charts" aria-busy="true">
      {[true, false, false, false].map((wide, index) => (
        <Tile key={index} className={`mj-stats-chart${wide ? ' mj-stats-chart--wide' : ''}`}>
          <SkeletonText heading width="40%" />
          <SkeletonPlaceholder className="mj-stats-chart-skeleton" />
        </Tile>
      ))}
    </div>
  );
}

function StatisticsSkeleton() {
  return (
    <>
      <div className="mj-stats-metrics">
        {[1, 2, 3, 4, 5].map((item) => <Tile key={item} className="mj-stat"><SkeletonText width="60%" /><SkeletonText heading width="40%" /></Tile>)}
      </div>
      <ChartsSkeleton />
      <DataTableSkeleton columnCount={6} rowCount={5} showHeader={false} showToolbar={false} />
    </>
  );
}

export function StatisticsPage() {
  const store = useStore();
  const [params, setParams] = useSearchParams();
  const [sort, setSort] = useState<{ key: SortKey; direction: 'ASC' | 'DESC' }>({ key: 'runtime', direction: 'DESC' });
  const canRead = store.can('statistics.read');
  const query = useSimulatedQuery<Inputs>((data) => ({
    machines: data.machines, machineTypes: data.machineTypes, jobs: data.jobs,
    // The inventory work may move materials into the store; fall back to the static lookups.
    materials: (data as { materials?: Material[] }).materials ?? lookups.materials,
  }), EMPTY);

  const today = dateInAppTimeZone(new Date());
  const periodParam = params.get('period');
  const period: Period = PERIODS.some((item) => item.id === periodParam) ? periodParam as Period : '6m';
  const fallback = presetRange('6m', today);
  const range: DateRange = period === 'custom'
    ? { from: params.get('from') ?? fallback.from, to: params.get('to') ?? fallback.to }
    : presetRange(period, today);
  const validRange = Boolean(range.from && range.to && range.from <= range.to && daysBetween(range.from, range.to) <= MAX_DAYS);
  const rangeError = range.from && range.to && range.from <= range.to ? 'Choose a period of at most five years.' : 'The end date must be on or after the start date.';

  const search = params.get('q') ?? '';
  const typeIds = (params.get('type') ?? '').split(',').filter(Boolean);

  const update = (patch: Record<string, string | null>) => setParams((previous) => {
    const next = new URLSearchParams(previous);
    for (const [key, value] of Object.entries(patch)) { if (value) next.set(key, value); else next.delete(key); }
    if (!('page' in patch)) next.delete('page');
    return next;
  }, { replace: true });
  const choosePeriod = (next: Period) => update(next === 'custom'
    ? { period: next, from: range.from, to: range.to }
    : { period: next === '6m' ? null : next, from: null, to: null });

  const stats = useMemo(
    () => (validRange ? buildStatistics(range, query.data) : null),
    [validRange, range.from, range.to, query.data], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const typeOptions: Option[] = query.data.machineTypes.map((type) => ({ id: type.id, label: type.name }));
  const visible = useMemo(() => {
    const direction = sort.direction === 'ASC' ? 1 : -1;
    const value = (row: MachineStat): string | number => ({
      machine: row.name, jobs: row.jobs, runtime: row.runtimeHours, failure: row.failureRate, charges: row.charges, share: row.runtimeShare,
    })[sort.key];
    return (stats?.machines ?? [])
      .filter((row) => (typeIds.length === 0 || typeIds.includes(row.typeId)) && (!search || `${row.name} ${row.typeName}`.toLowerCase().includes(search.toLowerCase())))
      .sort((a, b) => {
        const x = value(a);
        const y = value(b);
        return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'en', { numeric: true })) * direction;
      });
  }, [stats, sort, search, params]); // eslint-disable-line react-hooks/exhaustive-deps

  const paginate = visible.length > PAGE_SIZES[0];
  const pageSize = PAGE_SIZES.includes(Number(params.get('pageSize'))) ? Number(params.get('pageSize')) : 10;
  const page = Math.max(1, Math.min(Number(params.get('page')) || 1, Math.ceil(visible.length / pageSize) || 1));
  const pageRows = paginate ? visible.slice((page - 1) * pageSize, page * pageSize) : visible;
  const rowsById = new Map(pageRows.map((row) => [row.id, row]));
  const tableKey = `${page}-${pageSize}-${sort.key}-${sort.direction}-${visible.map((row) => row.id).join()}`;
  const sortBy = (key: SortKey) => setSort((current) => current.key === key
    ? { key, direction: current.direction === 'ASC' ? 'DESC' : 'ASC' }
    : { key, direction: key === 'machine' ? 'ASC' : 'DESC' });

  if (!canRead) {
    return (
      <PageShell title="Statistics" description="Usage, runtime and money for the selected period." width="wide" breadcrumbs={[{ label: 'Workshop', to: '/' }, { label: 'Statistics' }]}>
        <EmptyState title="Statistics are not available to you" description="You need the statistics.read permission to see usage, runtime and money figures. Ask a supervisor for access." />
      </PageShell>
    );
  }

  const renderBody = () => {
    if (!validRange) return <InlineNotification kind="warning" lowContrast hideCloseButton title="Choose a valid period" subtitle={rangeError} />;
    if (!stats || stats.totals.jobs === 0) return <EmptyState title="No activity in this period" description="Try a longer period, or check back after jobs have been recorded." />;
    const { totals, previous } = { totals: stats.totals, previous: stats.previous as Totals };
    const byRuntime = [...stats.machines].sort((a, b) => b.runtimeHours - a.runtimeHours);
    // Default comparison: the three busiest machines of the period; an explicit choice lives in the URL.
    const machinesParam = params.get('machines');
    const selectedMachineIds = machinesParam === null ? byRuntime.slice(0, 3).map((row) => row.id) : machinesParam.split(',').filter(Boolean);
    const chartData = {
      months: stats.months,
      granularity: stats.granularity,
      runtime: stats.runtime,
      machines: byRuntime.map((row) => ({ id: row.id, name: row.name, runtimeHours: row.runtimeHours })),
      selectedMachineIds,
      onSelectMachines: (ids: string[]) => setParams((current) => { const next = new URLSearchParams(current); next.set('machines', ids.join(',')); return next; }, { replace: true }),
      materialByCategory: stats.materialByCategory,
    };
    const headers = HEADERS.map(({ key, header: text }) => ({ key, header: text }));
    const cell = (row: MachineStat, key: string) => {
      if (key === 'machine') return <CarbonLink as={Link} to={`/machines/${row.id}`}>{row.name}</CarbonLink>;
      if (key === 'jobs') return integer.format(row.jobs);
      if (key === 'runtime') return integer.format(row.runtimeHours);
      if (key === 'failure') return oneDecimal.format(row.failureRate);
      if (key === 'charges') return formatMoney(row.charges);
      return oneDecimal.format(row.runtimeShare);
    };
    return (
      <>
        <section aria-label="Key figures" className="mj-stats-metrics">
          <Metric label="Jobs" value={integer.format(totals.jobs)} detail={comparison(totals.jobs, previous.jobs, 'percent')} />
          <Metric label="Machine runtime (h)" value={integer.format(totals.runtimeHours)} detail={comparison(totals.runtimeHours, previous.runtimeHours, 'percent')} />
          <Metric label="Customer charges (€)" value={formatMoney(totals.charges)} detail={comparison(totals.charges, previous.charges, 'percent')} />
          <Metric label="Material cost (€)" value={formatMoney(totals.materialCost)} detail={comparison(totals.materialCost, previous.materialCost, 'percent')} />
          <Metric label="Failure rate (%)" value={oneDecimal.format(totals.failureRate)} detail={comparison(totals.failureRate, previous.failureRate, 'points')} />
        </section>

        <Suspense fallback={<ChartsSkeleton />}>
          <StatisticsCharts data={chartData} />
        </Suspense>

        <DataTable key={tableKey} rows={pageRows.map((row) => ({ id: row.id, machine: row.name }))} headers={headers}>
          {({ rows, headers: tableHeaders, getRowProps, getTableProps }) => (
            <TableContainer className="mj-table-container" title="Per machine">
              <TableToolbar aria-label="Per machine table toolbar">
                <TableToolbarContent>
                  <TableToolbarSearch
                    id="stats-search" labelText="Search machines" placeholder="Search machines" defaultValue={search}
                    onChange={(_event, value) => update({ q: value ?? '' })} onClear={() => update({ q: null })}
                  />
                  <BatchFilter
                    id="stats" label="Per machine" applied={{ type: typeIds }} onApply={(values) => update(toPatch(values, ['type']))} onReset={() => update({ type: null })}
                    categories={[{ key: 'type', label: 'Type', options: typeOptions }]}
                  />
                </TableToolbarContent>
              </TableToolbar>
              <Table {...getTableProps()} aria-label="Statistics per machine">
                <TableHead>
                  <TableRow>
                    {tableHeaders.map((column) => {
                      const meta = HEADERS.find((item) => item.key === column.key)!;
                      return (
                        <TableHeader
                          key={column.key} className={meta.narrow ? 'mj-hide-narrow' : undefined} isSortable
                          isSortHeader={sort.key === meta.key} sortDirection={sort.key === meta.key ? sort.direction : 'NONE'}
                          onClick={() => sortBy(meta.key)}
                        >
                          {column.header}
                        </TableHeader>
                      );
                    })}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.map((tableRow) => {
                    const row = rowsById.get(tableRow.id);
                    if (!row) return null;
                    const { key, ...rowProps } = getRowProps({ row: tableRow });
                    return (
                      <TableRow key={key} {...rowProps}>
                        {tableRow.cells.map((tableCell) => (
                          <TableCell key={tableCell.id} className={HEADERS.find((item) => item.key === tableCell.info.header)?.narrow ? 'mj-hide-narrow' : undefined}>
                            {cell(row, tableCell.info.header)}
                          </TableCell>
                        ))}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              {visible.length === 0 && (
                <EmptyState
                  title="No machines found" description="Try different search terms or filters."
                  action={<Button kind="tertiary" onClick={() => update({ q: null, type: null })}>Clear filters</Button>}
                />
              )}
              {paginate && (
                <Pagination
                  page={page} pageSize={pageSize} pageSizes={PAGE_SIZES} totalItems={visible.length}
                  onChange={({ page: nextPage, pageSize: nextSize }) => update({ page: String(nextPage), pageSize: String(nextSize) })}
                />
              )}
            </TableContainer>
          )}
        </DataTable>
      </>
    );
  };

  return (
    <PageShell
      title="Statistics" description="Usage, runtime and money for the selected period." width="wide"
      breadcrumbs={[{ label: 'Workshop', to: '/' }, { label: 'Statistics' }]}
      actions={(
        <div className="mj-stats-period">
          <ContentSwitcher
            size="md" aria-label="Period" selectedIndex={PERIODS.findIndex((item) => item.id === period)}
            onChange={({ index }) => choosePeriod(PERIODS[index ?? 0].id)}
          >
            {PERIODS.map((item) => <Switch key={item.id} name={item.id} text={item.label} />)}
          </ContentSwitcher>
        </div>
      )}
    >
      <div className="mj-stats">
        {period === 'custom' && (
          <div className="mj-stats-custom">
            <DateInput id="stats-from" labelText="From" value={range.from} onChange={(value) => update({ from: value || null })} />
            <DateInput id="stats-to" labelText="To" value={range.to} onChange={(value) => update({ to: value || null })} />
          </div>
        )}
        <QueryBoundary query={query} loading={<StatisticsSkeleton />} errorMessage="Statistics could not be loaded.">
          {renderBody()}
        </QueryBoundary>
      </div>
    </PageShell>
  );
}
