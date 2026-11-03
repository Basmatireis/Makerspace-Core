import { lazy, Suspense, useState, type CSSProperties, type ReactNode } from 'react';
import { IconButton, SkeletonPlaceholder } from '@carbon/react';
import { ChartColumn, DataTable } from '@carbon/icons-react';
import { StackCard } from '../../../app/components/CardList';
import type { ChartSpec } from './chartSpec';
import { StatsTable, type StatsColumn, type StatsRow } from './StatsTable';

// Carbon Charts and their stylesheet load only through this lazy boundary.
const StatisticsChart = lazy(() => import('./StatisticsChart'));

const skeletonHeight = (spec: ChartSpec) =>
  spec.height ??
  (spec.kind === 'bar' ? Math.max(160, spec.rows.length * 36 + 56) : spec.kind === 'heatmap' ? 320 : 280);

const hasData = (spec: ChartSpec) => {
  switch (spec.kind) {
    case 'line':
    case 'stacked':
      return spec.labels.length > 0 && spec.series.some((series) => series.values.some((value) => value !== 0));
    case 'column':
      return spec.series.values.some((value) => value !== 0);
    case 'bar':
    case 'donut':
      return spec.rows.some((row) => row.value !== 0);
    case 'heatmap':
      return spec.cells.some((cell) => cell.value !== 0);
  }
};

/** The chart's data as table columns and rows: the textual equivalent behind the card's table toggle. */
function tableOf(spec: ChartSpec): { columns: StatsColumn[]; rows: StatsRow[] } {
  const first: StatsColumn = { key: 'category', header: spec.category };
  switch (spec.kind) {
    case 'line':
    case 'stacked':
      return {
        columns: [first, ...spec.series.map((series) => ({ key: series.name, header: series.name, numeric: true }))],
        rows: spec.labels.map((label, index) => ({
          id: label,
          cells: [label, ...spec.series.map((series) => spec.format(series.values[index] ?? 0))],
        })),
      };
    case 'column':
      return {
        columns: [first, { key: 'value', header: spec.series.name, numeric: true }],
        rows: spec.labels.map((label, index) => ({
          id: label,
          cells: [label, spec.format(spec.series.values[index] ?? 0)],
        })),
      };
    case 'bar':
    case 'donut':
      return {
        columns: [
          first,
          { key: 'value', header: spec.kind === 'bar' ? spec.valueName : spec.centerLabel, numeric: true },
        ],
        rows: spec.rows.map((row) => ({ id: row.label, cells: [row.label, spec.format(row.value)] })),
      };
    case 'heatmap': {
      const value = new Map(spec.cells.map((cell) => [`${cell.row}|${cell.column}`, cell.value]));
      return {
        columns: [first, ...spec.columns.map((column) => ({ key: column, header: column, numeric: true }))],
        rows: spec.rows.map((row) => ({
          id: row,
          cells: [row, ...spec.columns.map((column) => spec.format(value.get(`${row}|${column}`) ?? 0))],
        })),
      };
    }
  }
}

/** A Carbon chart behind the lazy boundary, with a placeholder of the same height while it loads. */
export function Chart({ spec }: { spec: ChartSpec }) {
  if (!hasData(spec)) return <p className="stats-card__empty">No data in this period.</p>;
  return (
    <Suspense
      fallback={
        <SkeletonPlaceholder
          className="stats-card__skeleton"
          style={{ '--stats-chart-height': `${skeletonHeight(spec)}px` } as CSSProperties}
        />
      }
    >
      <div className="stats-card__chart">
        <StatisticsChart spec={spec} />
      </div>
    </Suspense>
  );
}

/**
 * A titled card of the statistics stack (`.card--chart`): title with a chart/table toggle, optional note and controls,
 * then the chart or its data as a table, then any further content.
 */
export function ChartCard({
  title,
  note,
  controls,
  spec,
  tableToggle = true,
  children,
}: {
  title: string;
  note?: ReactNode;
  /** Pickers that shape the chart, shown above it. */
  controls?: ReactNode;
  spec?: ChartSpec;
  /** Off where the card already shows the same table below the chart. */
  tableToggle?: boolean;
  children?: ReactNode;
}) {
  const [asTable, setAsTable] = useState(false);
  const toggle = spec && tableToggle && hasData(spec);
  const table = toggle && asTable ? tableOf(spec) : null;
  return (
    <StackCard
      title={title}
      className="stats-card"
      action={
        toggle && (
          <IconButton
            kind="ghost"
            size="sm"
            align="left"
            label={asTable ? `Show ${title} as chart` : `Show ${title} as table`}
            onClick={() => setAsTable(!asTable)}
          >
            {asTable ? <ChartColumn /> : <DataTable />}
          </IconButton>
        )
      }
    >
      {note && <p className="stats-card__note">{note}</p>}
      {controls}
      {spec && (table ? <StatsTable label={title} columns={table.columns} rows={table.rows} /> : <Chart spec={spec} />)}
      {children}
    </StackCard>
  );
}
