import { createElement, type ComponentProps } from 'react';
import { ChartTheme, ScaleTypes } from '@carbon/charts';
import { LineChart as CarbonLineChart, SimpleBarChart as CarbonSimpleBarChart } from '@carbon/charts-react';
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

export { ScaleTypes };
