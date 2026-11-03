import { useEffect, useRef, type ReactNode } from 'react';
import {
  DonutChart,
  HeatmapChart,
  LineChart,
  ScaleTypes,
  SimpleBarChart,
  StackedBarChart,
} from '../../../app/charting';
import type { ChartSpec } from './chartSpec';

const DEFAULT_HEIGHT: Record<ChartSpec['kind'], number> = {
  line: 280,
  column: 280,
  stacked: 280,
  bar: 0,
  donut: 280,
  heatmap: 320,
};

/** Horizontal bars grow with their rows, so long lists stay readable. */
const barHeight = (rows: number) => Math.max(160, rows * 36 + 56);

// Tooltips pass labels through the same formatter; only numbers are formatted.
const formatter = (format: (value: number) => string) => (value: unknown) =>
  typeof value === 'number' ? format(value) : String(value);

function baseOptions(spec: ChartSpec) {
  const height = spec.height ?? (spec.kind === 'bar' ? barHeight(spec.rows.length) : DEFAULT_HEIGHT[spec.kind]);
  return {
    title: '',
    height: `${height}px`,
    accessibility: { svgAriaLabel: spec.description },
    // The card's title row carries the table toggle (the textual equivalent), so the chart needs no toolbar row.
    toolbar: { enabled: false },
    tooltip: { valueFormatter: formatter(spec.format) },
  };
}

const valueTicks = (spec: ChartSpec) => ({ formatter: formatter(spec.axisFormat ?? spec.format) });

/** Carbon Charts live behind React.lazy: this module is the only place on the page that imports them. */
export default function StatisticsChart({ spec }: { spec: ChartSpec }) {
  const options = baseOptions(spec);
  switch (spec.kind) {
    case 'line':
    case 'stacked': {
      const data = spec.series.flatMap((series) =>
        series.values.map((value, index) => ({ group: series.name, key: spec.labels[index], value })),
      );
      const axes = {
        bottom: { mapsTo: 'key', scaleType: ScaleTypes.LABELS, domain: spec.labels },
        left: {
          mapsTo: 'value',
          scaleType: ScaleTypes.LINEAR,
          stacked: spec.kind === 'stacked',
          ticks: valueTicks(spec),
        },
      };
      const legend = { enabled: spec.series.length > 1, alignment: 'left' as const };
      if (spec.kind === 'stacked')
        return <StackedBarChart data={data} options={{ ...options, axes, legend, bars: { maxWidth: 40 } }} />;
      return (
        <LineChart
          data={data}
          options={{ ...options, axes, legend, curve: 'curveMonotoneX' as const, points: { radius: 3 } }}
        />
      );
    }
    case 'column': {
      const data = spec.series.values.map((value, index) => ({
        group: spec.series.name,
        key: spec.labels[index],
        value,
      }));
      return (
        <SimpleBarChart
          data={data}
          options={{
            ...options,
            axes: {
              bottom: { mapsTo: 'key', scaleType: ScaleTypes.LABELS, domain: spec.labels },
              left: { mapsTo: 'value', scaleType: ScaleTypes.LINEAR, ticks: valueTicks(spec) },
            },
            bars: { maxWidth: 24 },
            legend: { enabled: false },
          }}
        />
      );
    }
    case 'bar': {
      const data = spec.rows.map((row) => ({ group: spec.valueName, key: row.label, value: row.value }));
      return (
        <SimpleBarChart
          data={data}
          options={{
            ...options,
            axes: {
              // A label axis lists its domain from the bottom up; reversed, the first row is on top.
              left: {
                mapsTo: 'key',
                scaleType: ScaleTypes.LABELS,
                domain: spec.rows.map((row) => row.label).reverse(),
              },
              bottom: { mapsTo: 'value', scaleType: ScaleTypes.LINEAR, ticks: valueTicks(spec) },
            },
            bars: { maxWidth: 20 },
            legend: { enabled: false },
          }}
        />
      );
    }
    case 'donut':
      return (
        <DonutChart
          data={spec.rows.map((row) => ({ group: row.label, value: row.value }))}
          options={{
            ...options,
            donut: {
              center: { label: spec.centerLabel, numberFormatter: spec.axisFormat ?? spec.format },
              alignment: 'center',
            },
            pie: { alignment: 'center' },
            legend: { alignment: 'center' },
          }}
        />
      );
    case 'heatmap':
      return (
        <LabelledCells>
          <HeatmapChart
            data={spec.cells.map((cell) => ({ column: cell.column, row: cell.row, value: cell.value }))}
            options={{
              ...options,
              axes: {
                bottom: {
                  mapsTo: 'column',
                  scaleType: ScaleTypes.LABELS,
                  domain: spec.columns,
                  title: spec.columnTitle,
                },
                left: { mapsTo: 'row', scaleType: ScaleTypes.LABELS, domain: [...spec.rows].reverse() },
              },
              heatmap: { colorLegend: { title: spec.legendTitle } },
            }}
          />
        </LabelledCells>
      );
  }
}

/**
 * Carbon's heatmap gives each cell an `aria-label` but no role, so assistive technology must ignore the label. The
 * cells get `role="img"` once Carbon has drawn them (it redraws on resize and data changes), which keeps both the
 * labels and the hover tooltips.
 */
function LabelledCells({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const label = () =>
      root.querySelectorAll('rect[aria-label]:not([role])').forEach((cell) => cell.setAttribute('role', 'img'));
    label();
    const observer = new MutationObserver(label);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return <div ref={ref}>{children}</div>;
}
