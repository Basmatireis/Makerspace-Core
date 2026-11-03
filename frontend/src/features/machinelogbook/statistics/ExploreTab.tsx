import { useSearchParams } from 'react-router-dom';
import type { MachineLogbookStatistics } from '../../../api/generated/models';
import { FuzzySelectField } from '../../../app/components/FuzzyComboBox';
import { StackCard } from '../../../app/components/CardList';
import { Chart } from './ChartCard';
import type { ChartSpec, LabelledValue } from './chartSpec';
import {
  byProcess,
  formatCompactHours,
  formatCompactMoney,
  formatEuro,
  formatHoursValue,
  formatInteger,
  formatPercent,
  HOURS,
  machineRows,
  points,
  round2,
  sum,
  WEEKDAYS,
} from './model';
import { monthLabel, monthsOf, type DateRange } from './period';
import { StatsTable } from './StatsTable';

type Metric = 'jobs' | 'runtime' | 'charges' | 'cost' | 'failure';
type Dimension = 'machine' | 'process' | 'type' | 'group' | 'weekday' | 'hour' | 'month';

const METRICS: { id: Metric; label: string; format: (value: number) => string; axis: (value: number) => string }[] = [
  { id: 'jobs', label: 'Jobs', format: formatInteger, axis: formatInteger },
  { id: 'runtime', label: 'Runtime (h)', format: formatHoursValue, axis: formatCompactHours },
  { id: 'charges', label: 'Charges (€)', format: formatEuro, axis: formatCompactMoney },
  { id: 'cost', label: 'Material cost (€)', format: formatEuro, axis: formatCompactMoney },
  { id: 'failure', label: 'Failure rate (%)', format: formatPercent, axis: formatPercent },
];

const DIMENSIONS: { id: Dimension; label: string }[] = [
  { id: 'machine', label: 'Machine' },
  { id: 'process', label: 'Process' },
  { id: 'type', label: 'Material type' },
  { id: 'group', label: 'Pricing group' },
  { id: 'weekday', label: 'Weekday' },
  { id: 'hour', label: 'Hour of day' },
  { id: 'month', label: 'Month' },
];

/** Breakdowns in a natural order are drawn as columns in that order; the others as bars, largest first. */
const ORDERED: Dimension[] = ['weekday', 'hour', 'month'];

/** The breakdowns the statistics API provides for each figure; nothing is estimated or apportioned. */
const AVAILABLE: Record<Metric, Dimension[]> = {
  jobs: ['machine', 'process', 'group'],
  runtime: ['machine', 'process', 'weekday', 'hour'],
  charges: ['machine', 'process', 'group', 'month'],
  cost: ['type', 'month'],
  failure: ['machine'],
};

function breakdown(stats: MachineLogbookStatistics, range: DateRange, metric: Metric, dimension: Dimension) {
  const machines = machineRows(stats);
  const machineValue = { jobs: 'jobs', runtime: 'runtimeHours', charges: 'charges', failure: 'failureRate' } as const;
  if (dimension === 'machine' && metric !== 'cost')
    return machines.map((row) => ({ label: row.name, value: round2(row[machineValue[metric]]) }));
  if (dimension === 'process' && (metric === 'jobs' || metric === 'runtime' || metric === 'charges'))
    return byProcess(machines, (row) => row[machineValue[metric]]);
  if (dimension === 'type') return points(stats.materialCostByType);
  if (dimension === 'group')
    return stats.pricingGroups.map((group) => ({
      label: group.pricingGroupName,
      value: metric === 'jobs' ? group.jobs : Number(group.charges),
    }));
  if (dimension === 'weekday' || dimension === 'hour') {
    const labels = dimension === 'weekday' ? WEEKDAYS : HOURS;
    const minutes = labels.map((_, index) =>
      sum(
        stats.usageByWeekdayHour
          .filter((cell) => (dimension === 'weekday' ? cell.weekday : cell.hour) === index)
          .map((cell) => Number(cell.minutes)),
      ),
    );
    return labels.map((label, index) => ({ label, value: round2(minutes[index] / 60) }));
  }
  const byMonth = new Map(stats.months.map((point) => [point.month, point]));
  return monthsOf(range).map((month) => ({
    label: monthLabel(month),
    value: Number((metric === 'cost' ? byMonth.get(month)?.materialCost : byMonth.get(month)?.charges) ?? 0),
  }));
}

export function ExploreTab({
  stats,
  range,
  periodText,
}: {
  stats: MachineLogbookStatistics;
  range: DateRange;
  periodText: string;
}) {
  const [params, setParams] = useSearchParams();
  const metric = METRICS.find((item) => item.id === params.get('metric')) ?? METRICS[1];
  const available = DIMENSIONS.filter((item) => AVAILABLE[metric.id].includes(item.id));
  const dimension = available.find((item) => item.id === params.get('by')) ?? available[0];
  const set = (key: string, value: string | null) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );

  const ordered = ORDERED.includes(dimension.id);
  const rows: LabelledValue[] = breakdown(stats, range, metric.id, dimension.id);
  const sorted = ordered ? rows : [...rows].sort((a, b) => b.value - a.value);
  // A rate has no meaningful total or share.
  const total = metric.id === 'failure' ? null : sum(rows.map((row) => row.value));
  const title = `${metric.label} by ${dimension.label.toLowerCase()}`;
  const common = {
    description: `${title}, ${periodText}`,
    category: dimension.label,
    format: metric.format,
    axisFormat: metric.axis,
  };
  const spec: ChartSpec = ordered
    ? {
        ...common,
        kind: 'column',
        labels: sorted.map((row) => row.label),
        series: { name: metric.label, values: sorted.map((row) => row.value) },
      }
    : { ...common, kind: 'bar', rows: sorted, valueName: metric.label };

  return (
    <StackCard title={title} className="stats-card">
      <div className="stats-explore__controls">
        <FuzzySelectField
          id="stats-explore-metric"
          titleText="Metric"
          options={METRICS}
          value={metric.id}
          onChange={(id) => set('metric', id)}
        />
        <FuzzySelectField
          id="stats-explore-by"
          titleText="By"
          options={available}
          value={dimension.id}
          onChange={(id) => set('by', id)}
        />
      </div>
      <p className="stats-card__note">{periodText}</p>
      <Chart spec={spec} />
      {sorted.length > 0 && (
        <StatsTable
          label={title}
          columns={[
            { key: 'label', header: dimension.label },
            { key: 'value', header: metric.label, numeric: true },
            ...(total ? [{ key: 'share', header: 'Share', numeric: true }] : []),
          ]}
          rows={sorted.map((row) => ({
            id: row.label,
            cells: [row.label, metric.format(row.value), ...(total ? [formatPercent((row.value / total) * 100)] : [])],
          }))}
          total={total ? ['Total', metric.format(total), formatPercent(100)] : undefined}
        />
      )}
    </StackCard>
  );
}
