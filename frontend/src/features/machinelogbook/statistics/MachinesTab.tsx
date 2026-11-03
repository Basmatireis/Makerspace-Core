import { Link as CarbonLink, MultiSelect } from '@carbon/react';
import { Link, useSearchParams } from 'react-router-dom';
import type { MachineLogbookStatistics } from '../../../api/generated/models';
import { DirectoryTable, useUrlState, type Column, type Option } from '../shared/DirectoryTable';
import { formatMoney } from '../shared/format';
import { machineLogbookPaths } from '../shared/paths';
import { ChartCard } from './ChartCard';
import type { HeatmapCell } from './chartSpec';
import {
  formatCompactHours,
  formatHoursValue,
  formatInteger,
  formatPercent,
  HOURS,
  integer,
  machineRows,
  oneDecimal,
  OUTCOME_LABELS,
  WEEKDAYS,
  type MachineRow,
} from './model';
import { addDays, addMonths, dayMonthLabel, monthLabel, weekStart, type DateRange } from './period';

/** How many machines the runtime chart compares at once, and how many it starts with. */
const MAX_COMPARED = 5;
const DEFAULT_COMPARED = 4;

/** Every week (Monday) or month of the period, so machines without runtime in a bucket still show a zero. */
function runtimeBuckets(stats: MachineLogbookStatistics, range: DateRange) {
  const week = stats.runtimeGranularity === 'week';
  const keys: string[] = [];
  if (week) {
    for (let day = weekStart(range.from); day <= range.to; day = addDays(day, 7)) keys.push(day);
  } else {
    for (let month = range.from.slice(0, 7); `${month}-01` <= range.to; month = addMonths(`${month}-01`, 1).slice(0, 7))
      keys.push(`${month}-01`);
  }
  for (const point of stats.runtime) if (!keys.includes(point.bucketStart)) keys.push(point.bucketStart);
  keys.sort();
  return keys.map((key) => ({
    key,
    label: week ? dayMonthLabel(key) : monthLabel(key.slice(0, 7)),
    hoursByMachine: new Map(
      stats.runtime.filter((point) => point.bucketStart === key).map((point) => [point.machineId, Number(point.hours)]),
    ),
  }));
}

const columns: Column<MachineRow>[] = [
  {
    key: 'machine',
    header: 'Machine',
    render: (row) => (
      <div className="stats-cell-2">
        <CarbonLink as={Link} to={machineLogbookPaths.machine(row.id)}>
          {row.name}
        </CarbonLink>
        <span className="stats-secondary">{row.processName}</span>
      </div>
    ),
    sortValue: (row) => row.name,
  },
  {
    key: 'jobs',
    header: 'Jobs',
    render: (row) => integer.format(row.jobs),
    sortValue: (row) => row.jobs,
    firstDirection: 'DESC',
  },
  {
    key: 'runtime',
    header: 'Runtime (h)',
    render: (row) => integer.format(row.runtimeHours),
    sortValue: (row) => row.runtimeHours,
    firstDirection: 'DESC',
  },
  {
    key: 'open',
    header: 'Open-day utilisation (%)',
    render: (row) => oneDecimal.format(row.openDayUtilization),
    sortValue: (row) => row.openDayUtilization,
    firstDirection: 'DESC',
    narrow: true,
  },
  {
    key: 'utilization',
    header: '24 h utilisation (%)',
    render: (row) => oneDecimal.format(row.utilization),
    sortValue: (row) => row.utilization,
    firstDirection: 'DESC',
    narrow: true,
  },
  {
    key: 'failure',
    header: 'Failure rate (%)',
    render: (row) => oneDecimal.format(row.failureRate),
    sortValue: (row) => row.failureRate,
    firstDirection: 'DESC',
    narrow: true,
  },
  {
    key: 'charges',
    header: 'Charges (€)',
    render: (row) => formatMoney(row.charges),
    sortValue: (row) => row.charges,
    firstDirection: 'DESC',
  },
  {
    key: 'share',
    header: 'Share of runtime (%)',
    render: (row) => oneDecimal.format(row.runtimeShare),
    sortValue: (row) => row.runtimeShare,
    firstDirection: 'DESC',
    narrow: true,
  },
];

export function MachinesTab({ stats, range }: { stats: MachineLogbookStatistics; range: DateRange }) {
  const [params, setParams] = useSearchParams();
  const url = useUrlState('');
  const machines = machineRows(stats);
  // Default comparison: the busiest machines of the period; an explicit choice lives in the URL.
  const machinesParam = params.get('machines');
  const selectedIds =
    machinesParam === null
      ? machines.slice(0, DEFAULT_COMPARED).map((row) => row.id)
      : machinesParam.split(',').filter(Boolean).slice(0, MAX_COMPARED);
  const full = selectedIds.length >= MAX_COMPARED;
  const items = machines.map((row) => ({ ...row, disabled: full && !selectedIds.includes(row.id) }));
  const selected = items.filter((row) => selectedIds.includes(row.id));
  const buckets = runtimeBuckets(stats, range);
  const unit = stats.runtimeGranularity === 'week' ? 'week' : 'month';

  // Only hours with a run are cells; the others stay empty instead of taking the scale's lowest colour.
  const cells: HeatmapCell[] = stats.usageByWeekdayHour
    .filter((cell) => WEEKDAYS[cell.weekday] && HOURS[cell.hour])
    .map((cell) => ({ row: WEEKDAYS[cell.weekday], column: HOURS[cell.hour], value: cell.runs }));

  const processIds = url.list('process');
  const processOptions: Option[] = [...new Set(machines.map((row) => row.processName))]
    .sort()
    .map((name) => ({ id: name, label: name }));
  const filtered = machines.filter((row) => processIds.length === 0 || processIds.includes(row.processName));

  return (
    <>
      <ChartCard
        title={`Runtime per ${unit}`}
        note="Up to five machines at once; pick which ones."
        controls={
          <MultiSelect
            id="stats-runtime-machines"
            className="stats-card__picker"
            titleText="Machines"
            label={selected.length ? `${selected.length} selected` : 'Select machines'}
            size="md"
            autoAlign
            items={items}
            itemToString={(machine) => machine?.name ?? ''}
            sortItems={(list) => [...list]}
            selectedItems={selected}
            onChange={({ selectedItems }) =>
              setParams(
                (current) => {
                  const next = new URLSearchParams(current);
                  next.set(
                    'machines',
                    (selectedItems ?? [])
                      .slice(0, MAX_COMPARED)
                      .map((machine) => machine.id)
                      .join(','),
                  );
                  return next;
                },
                { replace: true },
              )
            }
          />
        }
        spec={
          selected.length === 0
            ? undefined
            : {
                kind: 'line',
                description: `Runtime in hours per ${unit} for ${selected.map((machine) => machine.name).join(', ')}`,
                category: unit === 'week' ? 'Week' : 'Month',
                labels: buckets.map((bucket) => bucket.label),
                series: selected.map((machine) => ({
                  name: machine.name,
                  values: buckets.map((bucket) => Math.round((bucket.hoursByMachine.get(machine.id) ?? 0) * 10) / 10),
                })),
                format: formatHoursValue,
                axisFormat: formatCompactHours,
              }
        }
      >
        {selected.length === 0 && (
          <p className="stats-card__empty">Select one or more machines to compare their runtime.</p>
        )}
      </ChartCard>
      <ChartCard
        title="When the workshop is busy"
        note="Runs in progress per weekday and hour over the period, in the workshop's time zone."
        spec={{
          kind: 'heatmap',
          description: 'Number of runs in progress per weekday and hour of the day',
          category: 'Weekday',
          columns: HOURS,
          rows: WEEKDAYS,
          cells,
          columnTitle: 'Hour of day',
          legendTitle: 'Runs in progress',
          format: formatInteger,
        }}
      />
      <div className="stats-row">
        <ChartCard
          title="Failure rate by machine"
          note="Failed and partially failed jobs as a share of the jobs with a recorded outcome."
          spec={{
            kind: 'bar',
            description: 'Failure rate in percent per machine',
            category: 'Machine',
            rows: machines
              .filter((row) => row.jobs > 0)
              .map((row) => ({ label: row.name, value: row.failureRate }))
              .sort((a, b) => b.value - a.value),
            valueName: 'Failure rate',
            format: formatPercent,
          }}
        />
        <ChartCard
          title="Jobs by outcome"
          spec={{
            kind: 'donut',
            description: 'Jobs started in the period by outcome',
            category: 'Outcome',
            rows: stats.jobsByOutcome.map((row) => ({ label: OUTCOME_LABELS[row.outcome], value: row.jobs })),
            centerLabel: 'Jobs',
            format: formatInteger,
          }}
        />
      </div>
      <div className="stats-table-block">
        <DirectoryTable
          id="stats"
          urlPrefix=""
          label="Machines"
          columns={columns}
          rows={filtered}
          totalCount={machines.length}
          searchText={(row) => `${row.name} ${row.processName}`}
          defaultSort={{ key: 'runtime', direction: 'DESC' }}
          empty={{ title: 'No machines found', description: 'Try different search terms or filters.' }}
          filterCategories={[{ key: 'process', label: 'Process', options: processOptions }]}
        />
        <p className="stats-card__note stats-table-block__note">
          Open-day utilisation is the time runs occupied a machine during scheduled open days, as a share of the
          open-day hours. 24 h utilisation counts the whole calendar; printers run unattended, so both matter.
        </p>
      </div>
    </>
  );
}
