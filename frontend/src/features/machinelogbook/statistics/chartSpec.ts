/** One named series of a line, column or stacked chart, one value per label. */
export type Series = { name: string; values: number[] };
/** One labelled value of a horizontal bar or donut chart. */
export type LabelledValue = { label: string; value: number };
export type HeatmapCell = { column: string; row: string; value: number };

type CommonSpec = {
  /** Read by screen readers instead of the drawing; the card title is the visible name. */
  description: string;
  /** Header of the label column when the card shows the chart as a table ("Month", "Machine"). */
  category: string;
  /** Formats values in tooltips and the data table. */
  format: (value: number) => string;
  /** Formats the value axis; defaults to `format`. */
  axisFormat?: (value: number) => string;
  /** Pixel height of the drawing; each kind has a default. */
  height?: number;
};

/**
 * What a statistics card draws. The page builds these plain descriptions; only the lazy chart module turns them into
 * Carbon Charts, so the chart code and its stylesheet stay out of the page chunk.
 */
export type ChartSpec = CommonSpec &
  (
    | { kind: 'line'; labels: string[]; series: Series[] }
    | { kind: 'column'; labels: string[]; series: Series }
    | { kind: 'stacked'; labels: string[]; series: Series[] }
    | { kind: 'bar'; rows: LabelledValue[]; valueName: string }
    | { kind: 'donut'; rows: LabelledValue[]; centerLabel: string }
    | {
        kind: 'heatmap';
        columns: string[];
        rows: string[];
        cells: HeatmapCell[];
        columnTitle: string;
        legendTitle: string;
      }
  );
