import { createElement, type ComponentProps } from 'react';
import { ChartTheme, ScaleTypes } from '@carbon/charts';
import {
  DonutChart as CarbonDonutChart,
  HeatmapChart as CarbonHeatmapChart,
  LineChart as CarbonLineChart,
  SimpleBarChart as CarbonSimpleBarChart,
  StackedBarChart as CarbonStackedBarChart,
} from '@carbon/charts-react';
import '@carbon/charts-react/styles.css';
import { useColorScheme } from './colorScheme';

// Every chart takes the Carbon theme of the active color scheme, so callers never pass `theme` themselves.
const useChartTheme = () => (useColorScheme() === 'dark' ? ChartTheme.G100 : ChartTheme.WHITE);

export function SimpleBarChart(props: ComponentProps<typeof CarbonSimpleBarChart>) {
  const theme = useChartTheme();
  return createElement(CarbonSimpleBarChart, { ...props, options: { ...props.options, theme } });
}

export function LineChart(props: ComponentProps<typeof CarbonLineChart>) {
  const theme = useChartTheme();
  return createElement(CarbonLineChart, { ...props, options: { ...props.options, theme } });
}

export function StackedBarChart(props: ComponentProps<typeof CarbonStackedBarChart>) {
  const theme = useChartTheme();
  return createElement(CarbonStackedBarChart, { ...props, options: { ...props.options, theme } });
}

export function DonutChart(props: ComponentProps<typeof CarbonDonutChart>) {
  const theme = useChartTheme();
  return createElement(CarbonDonutChart, { ...props, options: { ...props.options, theme } });
}

export function HeatmapChart(props: ComponentProps<typeof CarbonHeatmapChart>) {
  const theme = useChartTheme();
  return createElement(CarbonHeatmapChart, { ...props, options: { ...props.options, theme } });
}

export { ScaleTypes };
