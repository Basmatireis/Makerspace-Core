import type { MachineLogbookStatistics } from '../../../api/generated/models';
import { FactTiles } from '../../../app/components/Facts';
import { ChartCard } from './ChartCard';
import {
  byProcess,
  comparison,
  formatCompactMoney,
  formatEuro,
  formatPercent,
  formatSignedMoney,
  integer,
  machineRows,
  materialTypeRows,
  round2,
  sum,
  toTotals,
} from './model';
import { monthLabel, monthsOf, type DateRange } from './period';
import { StatsTable } from './StatsTable';

export function MoneyTab({ stats, range }: { stats: MachineLogbookStatistics; range: DateRange }) {
  const totals = toTotals(stats.totals);
  const previous = toTotals(stats.previousTotals);
  const materials = materialTypeRows(stats);
  const margin = sum(materials.map((row) => row.charged)) - sum(materials.map((row) => row.cost));
  const months = monthsOf(range);
  const groups = stats.pricingGroups
    .map((group) => ({
      name: group.pricingGroupName,
      jobs: group.jobs,
      charges: Number(group.charges),
      discounts: Number(group.discounts),
    }))
    .sort((a, b) => b.charges - a.charges || a.name.localeCompare(b.name));
  const groupCharges = sum(groups.map((group) => group.charges));
  // Groups that charged nothing in the period still appear in the table, but not as empty stacks.
  const monthGroups = [...new Set(stats.pricingGroupMonths.map((point) => point.pricingGroupName))].sort(
    (a, b) =>
      groups.findIndex((group) => group.name === a) - groups.findIndex((group) => group.name === b) ||
      a.localeCompare(b),
  );
  const chargeOf = (month: string, group: string) =>
    round2(
      sum(
        stats.pricingGroupMonths
          .filter((point) => point.month === month && point.pricingGroupName === group)
          .map((point) => Number(point.charges)),
      ),
    );

  return (
    <>
      <FactTiles
        label="Money figures"
        items={[
          {
            label: 'Charges',
            value: formatEuro(totals.charges),
            helper: comparison(totals.charges, previous.charges, 'percent'),
          },
          { label: 'Not billed yet', value: formatEuro(totals.notBilled), helper: 'Finished jobs without an order' },
          {
            label: 'Discounts granted',
            value: formatEuro(totals.discounts),
            helper: totals.charges > 0 ? `${formatPercent((totals.discounts / totals.charges) * 100)} of charges` : '',
          },
          {
            label: 'Material margin',
            value: formatSignedMoney(margin),
            helper: 'Material charged minus inventory cost',
          },
        ]}
      />
      <div className="stats-row">
        <ChartCard
          title="Charges per month by pricing group"
          spec={{
            kind: 'stacked',
            description: 'Charges in euro per month, stacked by pricing group',
            category: 'Month',
            labels: months.map(monthLabel),
            series: monthGroups.map((group) => ({
              name: group,
              values: months.map((month) => chargeOf(month, group)),
            })),
            format: formatEuro,
            axisFormat: formatCompactMoney,
          }}
        />
        <ChartCard
          title="Share of charges by pricing group"
          spec={{
            kind: 'donut',
            description: 'Share of the period’s charges per pricing group',
            category: 'Pricing group',
            rows: groups.map((group) => ({ label: group.name, value: round2(group.charges) })),
            centerLabel: 'Charges',
            format: formatEuro,
            axisFormat: formatCompactMoney,
          }}
        />
      </div>
      <div className="stats-row">
        <ChartCard
          title="Charges by process"
          spec={{
            kind: 'bar',
            description: 'Charges in euro per process',
            category: 'Process',
            rows: byProcess(machineRows(stats), (row) => row.charges),
            valueName: 'Charges',
            format: formatEuro,
            axisFormat: formatCompactMoney,
          }}
        />
        <ChartCard
          title="By pricing group"
          note="Recipients are counted only by pricing group; there are no figures per person."
        >
          {groups.length === 0 ? (
            <p className="stats-card__empty">No jobs in this period.</p>
          ) : (
            <StatsTable
              label="Pricing groups"
              columns={[
                { key: 'group', header: 'Group' },
                { key: 'jobs', header: 'Jobs', numeric: true },
                { key: 'charges', header: 'Charges', numeric: true },
                { key: 'average', header: 'Avg. per job', numeric: true },
                { key: 'discounts', header: 'Discounts', numeric: true },
                { key: 'share', header: 'Share', numeric: true },
              ]}
              rows={groups.map((group) => ({
                id: group.name,
                cells: [
                  group.name,
                  integer.format(group.jobs),
                  formatEuro(group.charges),
                  group.jobs > 0 ? formatEuro(group.charges / group.jobs) : '—',
                  formatEuro(group.discounts),
                  groupCharges > 0 ? formatPercent((group.charges / groupCharges) * 100) : '—',
                ],
              }))}
            />
          )}
        </ChartCard>
      </div>
    </>
  );
}
