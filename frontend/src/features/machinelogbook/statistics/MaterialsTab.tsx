import type { MachineLogbookStatistics } from '../../../api/generated/models';
import { formatQuantity } from '../shared/format';
import { ChartCard } from './ChartCard';
import type { Series } from './chartSpec';
import { formatCompactMoney, formatEuro, formatSignedMoney, materialTypeRows, points, round2, sum } from './model';
import { monthLabel, monthsOf, type DateRange } from './period';
import { StatsTable } from './StatsTable';

/** How many material types the monthly cost chart stacks on their own; the rest are summed as "Other". */
const STACKED_TYPES = 4;

export function MaterialsTab({ stats, range }: { stats: MachineLogbookStatistics; range: DateRange }) {
  const rows = materialTypeRows(stats);
  const months = monthsOf(range);
  const top = rows.filter((row) => row.cost > 0).slice(0, STACKED_TYPES);
  const topIds = new Set(top.map((row) => row.id));
  const costIn = (month: string, match: (typeId: string) => boolean) =>
    round2(
      sum(
        stats.materialByMonth
          .filter((point) => point.month === month && match(point.materialTypeId))
          .map((point) => Number(point.cost)),
      ),
    );
  const series: Series[] = top.map((row) => ({
    name: row.name,
    values: months.map((month) => costIn(month, (id) => id === row.id)),
  }));
  const other = months.map((month) => costIn(month, (id) => !topIds.has(id)));
  if (other.some((value) => value !== 0)) series.push({ name: 'Other', values: other });

  return (
    <>
      <div className="stats-row">
        <ChartCard
          title="Material cost per month by material type"
          note="The four most expensive material types, stacked; the others as Other."
          spec={{
            kind: 'stacked',
            description: 'Inventory value consumed per month, stacked by material type',
            category: 'Month',
            labels: months.map(monthLabel),
            series,
            format: formatEuro,
            axisFormat: formatCompactMoney,
          }}
        />
        <ChartCard
          title="Lost on failed runs and disposal"
          note="Inventory value consumed by failed or cancelled runs, plus disposals and stock corrections."
          spec={{
            kind: 'bar',
            description: 'Inventory value lost in euro per material type',
            category: 'Material type',
            rows: points(stats.materialLossByType),
            valueName: 'Lost',
            format: formatEuro,
            axisFormat: formatCompactMoney,
          }}
        />
      </div>
      <ChartCard
        title="By material type"
        note="Charged is the makerspace material on the period's jobs at their pricing rates, before price adjustments."
      >
        {rows.length === 0 ? (
          <p className="stats-card__empty">No material was used in this period.</p>
        ) : (
          <StatsTable
            label="Material types"
            columns={[
              { key: 'type', header: 'Material type' },
              { key: 'consumed', header: 'Consumed', numeric: true },
              { key: 'cost', header: 'Cost', numeric: true },
              { key: 'charged', header: 'Charged', numeric: true },
              { key: 'margin', header: 'Margin', numeric: true },
              { key: 'lost', header: 'Lost', numeric: true },
            ]}
            rows={rows.map((row) => ({
              id: row.id,
              cells: [
                row.name,
                row.unit ? `${formatQuantity(row.quantity)} ${row.unit}` : '—',
                formatEuro(row.cost),
                formatEuro(row.charged),
                formatSignedMoney(row.charged - row.cost),
                formatEuro(row.lost),
              ],
            }))}
          />
        )}
      </ChartCard>
    </>
  );
}
