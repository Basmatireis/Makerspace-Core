import { Link as CarbonLink } from '@carbon/react';
import { Link } from 'react-router-dom';
import type { MachineLogbookStatistics } from '../../../api/generated/models';
import { Fact, FactsGrid, FactTiles } from '../../../app/components/Facts';
import { machineLogbookPaths } from '../shared/paths';
import { ChartCard } from './ChartCard';
import {
  byProcess,
  comparison,
  formatCompactHours,
  formatCompactMoney,
  formatEuro,
  formatHoursValue,
  formatInteger,
  formatPercent,
  integer,
  isoWeek,
  machineRows,
  materialTypeRows,
  oneDecimal,
  round2,
  sum,
  toTotals,
} from './model';
import { monthLabel, monthsOf, type DateRange } from './period';

/** The six headline figures with the change against the previous period of the same length. */
export function KeyFigures({ stats }: { stats: MachineLogbookStatistics }) {
  const totals = toTotals(stats.totals);
  const previous = toTotals(stats.previousTotals);
  return (
    <FactTiles
      label="Key figures"
      items={[
        {
          label: 'Jobs',
          value: integer.format(totals.jobs),
          helper: comparison(totals.jobs, previous.jobs, 'percent'),
        },
        {
          label: 'Machine runtime',
          value: `${integer.format(totals.runtimeHours)} h`,
          helper: comparison(totals.runtimeHours, previous.runtimeHours, 'percent'),
        },
        {
          label: 'Charges',
          value: formatEuro(totals.charges),
          helper: comparison(totals.charges, previous.charges, 'percent'),
        },
        {
          label: 'Material cost',
          value: formatEuro(totals.materialCost),
          helper: comparison(totals.materialCost, previous.materialCost, 'percent'),
        },
        {
          label: 'Failure rate',
          value: `${oneDecimal.format(totals.failureRate)} %`,
          helper: comparison(totals.failureRate, previous.failureRate, 'points'),
        },
        {
          label: 'Utilisation on open days',
          value: `${oneDecimal.format(totals.openDayUtilization)} %`,
          helper: comparison(totals.openDayUtilization, previous.openDayUtilization, 'points'),
        },
      ]}
    />
  );
}

export function OverviewTab({ stats, range }: { stats: MachineLogbookStatistics; range: DateRange }) {
  const totals = toTotals(stats.totals);
  const machines = machineRows(stats);
  const months = monthsOf(range);
  const byMonth = new Map(stats.months.map((point) => [point.month, point]));
  const busiest = machines.find((row) => row.runtimeHours > 0);
  const failing = [...machines].filter((row) => row.jobs > 0).sort((a, b) => b.failureRate - a.failureRate)[0];
  const topType = materialTypeRows(stats).find((row) => row.cost > 0);
  const lost = sum(stats.materialLossByType.map((point) => Number(point.value)));
  const weeks = stats.jobsByWeek;
  // Week numbers repeat in periods longer than a year; the year then keeps the labels apart.
  const longPeriod = weeks.length > 52;
  const weekLabel = (start: string) => `W${isoWeek(start)}${longPeriod ? ` ’${start.slice(2, 4)}` : ''}`;
  return (
    <>
      <KeyFigures stats={stats} />
      <div className="stats-row">
        <ChartCard
          title="Charges vs. material cost per month"
          spec={{
            kind: 'line',
            description: 'Charges and material cost in euro per month of the period',
            category: 'Month',
            labels: months.map(monthLabel),
            series: [
              { name: 'Charges', values: months.map((month) => round2(Number(byMonth.get(month)?.charges ?? 0))) },
              {
                name: 'Material cost',
                values: months.map((month) => round2(Number(byMonth.get(month)?.materialCost ?? 0))),
              },
            ],
            format: formatEuro,
            axisFormat: formatCompactMoney,
          }}
        />
        <ChartCard
          title="Jobs per week"
          spec={{
            kind: 'column',
            description: 'Jobs started per calendar week of the period',
            category: 'Week',
            labels: weeks.map((week) => weekLabel(week.weekStart)),
            series: { name: 'Jobs', values: weeks.map((week) => week.jobs) },
            format: formatInteger,
          }}
        />
      </div>
      <div className="stats-row">
        <ChartCard title="Highlights">
          <FactsGrid columns={2}>
            <Fact label="Busiest machine">
              {busiest ? (
                <>
                  <CarbonLink as={Link} to={machineLogbookPaths.machine(busiest.id)}>
                    {busiest.name}
                  </CarbonLink>{' '}
                  · {formatHoursValue(busiest.runtimeHours)}, {formatPercent(busiest.openDayUtilization)} of open-day
                  hours
                </>
              ) : (
                '—'
              )}
            </Fact>
            <Fact label="Most used material type">
              {topType
                ? `${topType.name} · ${formatEuro(topType.cost)} cost, ${formatEuro(topType.charged)} charged`
                : '—'}
            </Fact>
            <Fact label="Highest failure rate">
              {failing ? `${failing.name} · ${formatPercent(failing.failureRate)}` : '—'}
            </Fact>
            <Fact label="Material lost on failed runs and disposal">
              {formatEuro(lost)}
              {totals.materialCost > 0 && ` · ${formatPercent((lost / totals.materialCost) * 100)} of material cost`}
            </Fact>
            <Fact label="Not billed yet">{formatEuro(totals.notBilled)} in finished jobs without an order</Fact>
            <Fact label="Discounts granted">{formatEuro(totals.discounts)}</Fact>
          </FactsGrid>
        </ChartCard>
        <ChartCard
          title="Runtime by process"
          spec={{
            kind: 'bar',
            description: 'Machine runtime in hours per process',
            category: 'Process',
            rows: byProcess(machines, (row) => row.runtimeHours),
            valueName: 'Runtime',
            format: formatHoursValue,
            axisFormat: formatCompactHours,
          }}
        />
      </div>
    </>
  );
}
