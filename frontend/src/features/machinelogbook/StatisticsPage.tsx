import { lazy, Suspense } from 'react';
import { ContentSwitcher, Link as CarbonLink, InlineNotification, SkeletonPlaceholder, SkeletonText, Switch, Tile, DataTableSkeleton } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import type { MachineLogbookStatistics, StatisticTotals } from '../../api/generated/models';
import { dateInAppTimeZone } from '../../app/dateTime';
import { DateInput } from '../../app/DateInput';
import { PageShell } from '../../app/PageShell';
import { EmptyState } from '../../app/PageState';
import type { RuntimeBucket, StatisticsChartsData } from './components/StatisticsCharts';
import { statisticsQuery } from './queries';
import { DirectoryTable, useUrlState, type Column, type Option } from './shared/DirectoryTable';
import { formatMoney } from './shared/format';
import { machineLogbookPaths } from './shared/paths';
import { QueryBoundary } from './shared/QueryBoundary';
import './styles.scss';
import './styles/statistics.scss';

// Carbon Charts and their stylesheet load only through this lazy boundary.
const StatisticsCharts = lazy(() => import('./components/StatisticsCharts'));

type Period = '30d' | '6m' | '12m' | 'custom';
type DateRange = { from: string; to: string };
type MachineRow = {
  id: string; name: string; typeName: string; jobs: number; runtimeHours: number; failureRate: number; charges: number; runtimeShare: number;
};
type Totals = { jobs: number; runtimeHours: number; charges: number; materialCost: number; failureRate: number };

const PERIODS: { id: Period; label: string }[] = [
  { id: '30d', label: '30 days' }, { id: '6m', label: '6 months' }, { id: '12m', label: '12 months' }, { id: 'custom', label: 'Custom' },
];
const MAX_DAYS = 1830;

const integer = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1, minimumFractionDigits: 1 });

const DAY_MS = 86_400_000;
const parseDay = (value: string) => Date.parse(`${value}T12:00:00Z`);
const formatDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (value: string, days: number) => formatDay(parseDay(value) + days * DAY_MS);
const daysBetween = (from: string, to: string) => Math.round((parseDay(to) - parseDay(from)) / DAY_MS) + 1;
function addMonths(value: string, months: number) {
  const date = new Date(parseDay(value));
  date.setUTCMonth(date.getUTCMonth() + months);
  return formatDay(date.getTime());
}
const weekStart = (day: string) => addDays(day, -((new Date(parseDay(day)).getUTCDay() + 6) % 7));
const weekLabel = (day: string) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(parseDay(day)));
const monthLabel = (month: string) => new Intl.DateTimeFormat('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' }).format(new Date(`${month}-01T12:00:00Z`));

/** The URL and the pickers use an inclusive last day; the API range is half-open, so its `to` is the day after. */
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

const toTotals = (totals: StatisticTotals): Totals => ({
  jobs: totals.jobs, runtimeHours: Number(totals.runtimeHours), charges: Number(totals.charges), materialCost: Number(totals.materialCost), failureRate: Number(totals.failureRate),
});

/** Every week (Monday) or month of the period, so machines without runtime in a bucket still show a zero. */
function runtimeBuckets(stats: MachineLogbookStatistics, range: DateRange): RuntimeBucket[] {
  const week = stats.runtimeGranularity === 'week';
  const keys: string[] = [];
  const last = range.to;
  if (week) {
    for (let day = weekStart(range.from); day <= last; day = addDays(day, 7)) keys.push(day);
  } else {
    for (let month = range.from.slice(0, 7); `${month}-01` <= last; month = addMonths(`${month}-01`, 1).slice(0, 7)) keys.push(`${month}-01`);
  }
  for (const point of stats.runtime) if (!keys.includes(point.bucketStart)) keys.push(point.bucketStart);
  keys.sort();
  return keys.map((key) => ({
    key, label: week ? weekLabel(key) : monthLabel(key.slice(0, 7)),
    hoursByMachine: Object.fromEntries(stats.runtime.filter((point) => point.bucketStart === key).map((point) => [point.machineId, Number(point.hours)])),
  }));
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

const columns: Column<MachineRow>[] = [
  { key: 'machine', header: 'Machine', render: (row) => <CarbonLink as={Link} to={machineLogbookPaths.machine(row.id)}>{row.name}</CarbonLink>, sortValue: (row) => row.name },
  { key: 'jobs', header: 'Jobs', render: (row) => integer.format(row.jobs), sortValue: (row) => row.jobs, firstDirection: 'DESC' },
  { key: 'runtime', header: 'Runtime (h)', render: (row) => integer.format(row.runtimeHours), sortValue: (row) => row.runtimeHours, firstDirection: 'DESC' },
  { key: 'failure', header: 'Failure rate (%)', render: (row) => oneDecimal.format(row.failureRate), sortValue: (row) => row.failureRate, firstDirection: 'DESC', narrow: true },
  { key: 'charges', header: 'Charges (€)', render: (row) => formatMoney(row.charges), sortValue: (row) => row.charges, firstDirection: 'DESC' },
  { key: 'share', header: 'Share of runtime (%)', render: (row) => oneDecimal.format(row.runtimeShare), sortValue: (row) => row.runtimeShare, firstDirection: 'DESC', narrow: true },
];

export function StatisticsPage() {
  const [params, setParams] = useSearchParams();
  const url = useUrlState('');
  const today = dateInAppTimeZone(new Date());
  const periodParam = params.get('period');
  const period: Period = PERIODS.some((item) => item.id === periodParam) ? periodParam as Period : '6m';
  const fallback = presetRange('6m', today);
  const range: DateRange = period === 'custom'
    ? { from: params.get('from') ?? fallback.from, to: params.get('to') ?? fallback.to }
    : presetRange(period, today);
  const validRange = Boolean(range.from && range.to && range.from <= range.to && daysBetween(range.from, range.to) <= MAX_DAYS);
  const rangeError = range.from && range.to && range.from <= range.to ? 'Choose a period of at most five years.' : 'The end date must be on or after the start date.';
  // The API range is half-open: `to` is the first day after the period.
  const query = useQuery({ ...statisticsQuery({ from: range.from, to: validRange ? addDays(range.to, 1) : range.to }), enabled: validRange });

  const update = (patch: Record<string, string | null>) => url.set(patch);
  const choosePeriod = (next: Period) => update(next === 'custom'
    ? { period: next, from: range.from, to: range.to }
    : { period: next === '6m' ? null : next, from: null, to: null });

  const typeIds = url.list('type');

  const renderBody = (stats: MachineLogbookStatistics) => {
    if (stats.totals.jobs === 0) return <EmptyState title="No activity in this period" description="Try a longer period, or check back after jobs have been recorded." />;
    const totals = toTotals(stats.totals);
    const previous = toTotals(stats.previousTotals);
    const machines: MachineRow[] = stats.machines.map((row) => ({
      id: row.machineId, name: row.name, typeName: row.machineTypeName, jobs: row.jobs, runtimeHours: Number(row.runtimeHours),
      failureRate: Number(row.failureRate), charges: Number(row.charges), runtimeShare: Number(row.runtimeShare),
    }));
    const byRuntime = [...machines].sort((a, b) => b.runtimeHours - a.runtimeHours);
    // Default comparison: the three busiest machines of the period; an explicit choice lives in the URL.
    const machinesParam = params.get('machines');
    const selectedMachineIds = machinesParam === null ? byRuntime.slice(0, 3).map((row) => row.id) : machinesParam.split(',').filter(Boolean);
    const chartData: StatisticsChartsData = {
      months: stats.months.map((point) => ({
        month: point.month, label: monthLabel(point.month), charges: Number(point.charges), materialCost: Number(point.materialCost), losses: Number(point.losses),
      })),
      granularity: stats.runtimeGranularity,
      runtime: runtimeBuckets(stats, range),
      machines: byRuntime.map((row) => ({ id: row.id, name: row.name, runtimeHours: row.runtimeHours })),
      selectedMachineIds,
      onSelectMachines: (ids: string[]) => setParams((current) => { const next = new URLSearchParams(current); next.set('machines', ids.join(',')); return next; }, { replace: true }),
      materialByType: stats.materialCostByType.map((point) => ({ label: point.label, value: Number(point.value) })),
    };
    const typeOptions: Option[] = [...new Set(machines.map((row) => row.typeName))].sort().map((name) => ({ id: name, label: name }));
    const filtered = machines.filter((row) => typeIds.length === 0 || typeIds.includes(row.typeName));
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

        <h2 className="mj-stats-chart__title">Per machine</h2>
        <DirectoryTable
          id="stats" urlPrefix="" label="Machines" columns={columns} rows={filtered} totalCount={machines.length}
          searchText={(row) => `${row.name} ${row.typeName}`} defaultSort={{ key: 'runtime', direction: 'DESC' }}
          empty={{ title: 'No machines found', description: 'Try different search terms or filters.' }}
          filterCategories={[{ key: 'type', label: 'Type', options: typeOptions }]}
        />
      </>
    );
  };

  return (
    <PageShell
      title="Statistics" description="Usage, runtime and money for the selected period." width="wide" className="machine-logbook-page"
      breadcrumbs={[{ label: 'Workshop', to: machineLogbookPaths.overview() }, { label: 'Statistics' }]}
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
        {validRange
          ? <QueryBoundary query={query} loading={<StatisticsSkeleton />} errorMessage="Statistics could not be loaded.">{(data) => renderBody(data)}</QueryBoundary>
          : <InlineNotification kind="warning" lowContrast hideCloseButton title="Choose a valid period" subtitle={rangeError} />}
      </div>
    </PageShell>
  );
}
