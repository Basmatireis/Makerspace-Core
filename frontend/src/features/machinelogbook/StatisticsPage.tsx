import { Button, Tile } from '@carbon/react';
import { LineChart, SimpleBarChart } from '@carbon/charts-react';
import { ScaleTypes } from '@carbon/charts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { PageShell } from '../../app/PageShell';
import { ErrorState, FullPageLoading } from '../../app/PageState';
import { DateInput } from '../../app/DateInput';
import { dateInAppTimeZone, formatMonthYear } from '../../app/dateTime';
import type { StatisticPoint } from '../../api/generated/models';
import { formatDecimal } from './formatting';
import { statisticsQuery } from './queries';

export function StatisticsPage() {
  const now = new Date();
  const today = dateInAppTimeZone(now);
  const earlier = new Date(`${today}T12:00:00Z`);
  earlier.setUTCMonth(earlier.getUTCMonth() - 6);
  const [from, setFrom] = useState(earlier.toISOString().slice(0, 10));
  const [to, setTo] = useState(today);
  const query = useQuery(statisticsQuery({ from, to }));
  if (query.isPending) return <FullPageLoading label="Loading statistics" />;
  if (query.isError) return <ErrorState message="Statistics could not be loaded." onRetry={() => query.refetch()} />;

  return (
    <PageShell
      title="Statistics"
      description="Date-filtered operational and financial reporting."
      breadcrumbs={[{ label: 'Machines', to: '/machine-logbook' }, { label: 'Statistics' }]}
      actions={<div className="date-filter"><DateInput id="statistics-from" labelText="From" value={from} onChange={setFrom} /><DateInput id="statistics-to" labelText="To" value={to} onChange={setTo} /><Button kind="secondary" onClick={() => query.refetch()}>Refresh</Button></div>}
      width="wide"
      className="machine-logbook-page"
    >
      <div className="statistics-grid">
        <StatisticChart title="Material usage by category" points={query.data.materialUsageByCategory} kind="bar" suffix="" />
        <StatisticChart title="Machine runtime (hours)" points={query.data.machineRuntimeHours} kind="bar" suffix=" h" />
        <StatisticChart title="Jobs per machine" points={query.data.machineJobCounts} kind="bar" suffix="" />
        <ComparisonChart acquisition={query.data.acquisitionCost} charges={query.data.customerCharges} />
        <StatisticChart title="Adjustments / disposal loss" points={query.data.adjustmentLoss} kind="bar" suffix="" />
        <StatisticChart title="Machine failure rate" points={query.data.machineFailureRates} kind="bar" suffix="%" />
      </div>
    </PageShell>
  );
}

function StatisticChart({ title, points, kind, suffix }: { title: string; points: StatisticPoint[]; kind: 'bar' | 'line'; suffix: string }) {
  const data = points.map((point) => ({ group: title, key: formatStatisticLabel(point.label), value: Number(point.value) }));
  const options = { title, axes: { left: { mapsTo: 'value', scaleType: ScaleTypes.LINEAR }, bottom: { mapsTo: 'key', scaleType: ScaleTypes.LABELS } }, height: '300px', legend: { enabled: false }, toolbar: { enabled: false }, accessibility: { svgAriaLabel: title } };
  return <Tile className="chart-tile">{kind === 'line' ? <LineChart data={data} options={options} /> : <SimpleBarChart data={data} options={options} />}<table className="accessible-data-table"><caption>{title}</caption><thead><tr><th>Category</th><th>Value</th></tr></thead><tbody>{points.map((point) => <tr key={point.key}><td>{formatStatisticLabel(point.label)}</td><td>{formatDecimal(point.value)}{suffix}</td></tr>)}</tbody></table></Tile>;
}

function ComparisonChart({ acquisition, charges }: { acquisition: StatisticPoint[]; charges: StatisticPoint[] }) {
  const data = [...acquisition.map((point) => ({ group: 'Acquisition cost', key: formatStatisticLabel(point.label), value: Number(point.value) })), ...charges.map((point) => ({ group: 'Effective charges', key: formatStatisticLabel(point.label), value: Number(point.value) }))];
  const options = { title: 'Acquisition cost vs. effective charges (€)', axes: { left: { mapsTo: 'value', scaleType: ScaleTypes.LINEAR }, bottom: { mapsTo: 'key', scaleType: ScaleTypes.LABELS } }, height: '300px', curve: 'curveMonotoneX' as const, toolbar: { enabled: false }, accessibility: { svgAriaLabel: 'Monthly acquisition cost and effective customer charges' } };
  const months = [...new Set([...acquisition, ...charges].map((point) => point.label))];
  return <Tile className="chart-tile"><LineChart data={data} options={options} /><table className="accessible-data-table"><caption>Acquisition cost versus effective charges</caption><thead><tr><th>Month</th><th>Acquisition cost</th><th>Charges</th></tr></thead><tbody>{months.map((month) => <tr key={month}><td>{formatStatisticLabel(month)}</td><td>€ {formatDecimal(acquisition.find((point) => point.label === month)?.value ?? '0')}</td><td>€ {formatDecimal(charges.find((point) => point.label === month)?.value ?? '0')}</td></tr>)}</tbody></table></Tile>;
}

function formatStatisticLabel(value: string) {
  return /^\d{4}-\d{2}$/.test(value) ? formatMonthYear(new Date(`${value}-01T12:00:00Z`)) : value;
}
