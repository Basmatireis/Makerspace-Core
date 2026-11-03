import { http, HttpResponse } from 'msw';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { StatisticsPage } from './StatisticsPage';

// The chart components stand in for Carbon Charts: they show their groups or labels so tests can read what is drawn.
type Point = { group?: string; key?: string; row?: string; column?: string; value: number };
const groups = (data: Point[]) => [...new Set(data.map((point) => point.group))].join('|');
vi.mock('../../app/charting', () => ({
  ScaleTypes: { LINEAR: 'linear', LABELS: 'labels' },
  LineChart: ({ data }: { data: Point[] }) => <div data-testid="line-chart">{groups(data)}</div>,
  SimpleBarChart: ({ data }: { data: Point[] }) => (
    <div data-testid="bar-chart">{data.map((point) => `${point.key}=${point.value}`).join('|')}</div>
  ),
  StackedBarChart: ({ data }: { data: Point[] }) => <div data-testid="stacked-chart">{groups(data)}</div>,
  DonutChart: ({ data }: { data: Point[] }) => (
    <div data-testid="donut-chart">{data.map((point) => `${point.group}=${point.value}`).join('|')}</div>
  ),
  HeatmapChart: ({ data }: { data: Point[] }) => (
    <div data-testid="heatmap-chart">
      {data.map((point) => `${point.row} ${point.column}=${point.value}`).join('|')}
    </div>
  ),
}));

const ids = [
  '0192f6f8-743e-7c77-a349-cd07c3e8a911',
  '0192f6f8-743e-7c77-a349-cd07c3e8a912',
  '0192f6f8-743e-7c77-a349-cd07c3e8a913',
  '0192f6f8-743e-7c77-a349-cd07c3e8a914',
  '0192f6f8-743e-7c77-a349-cd07c3e8a915',
  '0192f6f8-743e-7c77-a349-cd07c3e8a916',
];
const typeIds = ['0192f6f8-743e-7c77-a349-cd07c3e8b001', '0192f6f8-743e-7c77-a349-cd07c3e8b002'];
const totals = (jobs: number, runtimeHours: string, charges: string, materialCost: string, failureRate: string) => ({
  jobs,
  runtimeHours,
  charges,
  materialCost,
  failureRate,
  notBilled: '80.00',
  discounts: '30.00',
  utilization: '10.0',
  openDayUtilization: '40.0',
});
const machine = (index: number, name: string, processName: string, runtimeHours: string, jobs: number) => ({
  machineId: ids[index],
  name,
  processName,
  jobs,
  runtimeHours,
  failureRate: `${index + 1}.0`,
  charges: '100.00',
  runtimeShare: '10.0',
  utilization: '12.5',
  openDayUtilization: '40.0',
});
const statistics = {
  totals: totals(120, '300.0', '1500.00', '400.00', '7.5'),
  previousTotals: { ...totals(100, '0', '1500.00', '200.00', '5.0'), openDayUtilization: '35.0' },
  months: [
    { month: '2026-09', charges: '900.00', materialCost: '200.00', losses: '12.00' },
    { month: '2026-10', charges: '600.00', materialCost: '200.00', losses: '0.00' },
  ],
  runtimeGranularity: 'month',
  runtime: [{ bucketStart: '2026-09-01', machineId: ids[1], hours: '10.0' }],
  materialCostByType: [
    { key: typeIds[0], label: 'PLA', value: '300.00' },
    { key: typeIds[1], label: 'Plywood', value: '100.00' },
  ],
  machines: [
    machine(0, 'Alpha', '3D printer', '50.0', 10),
    machine(1, 'Bravo', '3D printer', '120.0', 40),
    machine(2, 'Charlie', 'Laser cutter', '90.0', 30),
    machine(3, 'Delta', 'Laser cutter', '10.0', 5),
    machine(4, 'Echo', 'CNC', '8.0', 2),
    machine(5, 'Foxtrot', 'CNC', '4.0', 1),
  ],
  materialUsageByType: [],
  machineRuntimeHours: [],
  machineJobCounts: [],
  acquisitionCost: [],
  customerCharges: [],
  adjustmentLoss: [],
  machineFailureRates: [],
  usageByWeekdayHour: [
    { weekday: 0, hour: 9, runs: 2, minutes: '90' },
    { weekday: 6, hour: 23, runs: 1, minutes: '30' },
  ],
  jobsByOutcome: [
    { outcome: 'successful', jobs: 100 },
    { outcome: 'unknown', jobs: 20 },
  ],
  jobsByWeek: [
    { weekStart: '2026-09-07', jobs: 12 },
    { weekStart: '2026-09-14', jobs: 0 },
  ],
  materialByMonth: [
    {
      month: '2026-09',
      materialTypeId: typeIds[0],
      materialTypeName: 'PLA',
      unit: 'g',
      quantity: '1200',
      cost: '300.00',
    },
    {
      month: '2026-10',
      materialTypeId: typeIds[1],
      materialTypeName: 'Plywood',
      unit: 'sheet',
      quantity: '4',
      cost: '100.00',
    },
  ],
  materialLossByType: [{ key: typeIds[0], label: 'PLA', value: '12.00' }],
  materialChargesByType: [
    { key: typeIds[0], label: 'PLA', value: '420.00' },
    { key: typeIds[1], label: 'Plywood', value: '90.00' },
  ],
  pricingGroups: [
    { pricingGroupName: 'Members', jobs: 90, charges: '900.00', discounts: '20.00' },
    { pricingGroupName: 'External', jobs: 30, charges: '600.00', discounts: '10.00' },
  ],
  pricingGroupMonths: [
    { month: '2026-09', pricingGroupName: 'Members', charges: '500.00' },
    { month: '2026-10', pricingGroupName: 'External', charges: '600.00' },
  ],
};

let requests: URLSearchParams[] = [];
function serve(body: object = statistics) {
  server.use(
    http.get('*/api/v1/machine-logbook/statistics', ({ request }) => {
      requests.push(new URL(request.url).searchParams);
      return HttpResponse.json(body);
    }),
  );
}

const figures = () => screen.getByLabelText('Key figures');

describe('Statistics page', () => {
  beforeEach(() => {
    requests = [];
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-15T10:00:00Z') });
  });
  afterEach(() => vi.useRealTimers());

  it('requests the six month default with an exclusive end and shows key figures with changes', async () => {
    serve();
    renderRoute(<StatisticsPage />);
    await screen.findByLabelText('Key figures');
    expect(requests[0].get('from')).toBe('2026-04-15');
    expect(requests[0].get('to')).toBe('2026-10-16');
    const tiles = figures();
    expect(within(tiles).getByText('+20 % vs previous period')).toBeInTheDocument();
    expect(within(tiles).getByText('No data in previous period')).toBeInTheDocument();
    expect(within(tiles).getByText('+5.0 pp vs previous period')).toBeInTheDocument();
    expect(within(tiles).getByText('+100 % vs previous period')).toBeInTheDocument();
    expect(within(tiles).getByText('+2.5 pp vs previous period')).toBeInTheDocument();
    expect(within(tiles).getByText('€1,500.00')).toBeInTheDocument();
    expect(within(tiles).getByText('Utilisation on open days')).toBeInTheDocument();
  });

  it('draws the overview charts from months, weeks and processes', async () => {
    serve();
    renderRoute(<StatisticsPage />);
    expect(await screen.findByTestId('line-chart')).toHaveTextContent('Charges|Material cost');
    const bars = screen.getAllByTestId('bar-chart').map((chart) => chart.textContent);
    expect(bars).toContain('W37=12|W38=0');
    expect(bars).toContain('3D printer=170|Laser cutter=100|CNC=12');
    expect(screen.getByRole('link', { name: 'Bravo' })).toHaveAttribute('href', `/workshop/machines/${ids[1]}`);
    expect(screen.getByText('PLA · €300.00 cost, €420.00 charged')).toBeInTheDocument();
  });

  it('shows a chart as a table on request', async () => {
    serve();
    const user = userEvent.setup();
    renderRoute(<StatisticsPage />);
    await screen.findByTestId('line-chart');
    await user.click(screen.getByLabelText('Show Charges vs. material cost per month as table'));
    const table = screen.getByRole('table', { name: 'Charges vs. material cost per month' });
    expect(within(table).getByRole('row', { name: /Sept ’26 €900.00 €200.00/ })).toBeInTheDocument();
    expect(screen.queryByTestId('line-chart')).not.toBeInTheDocument();
    await user.click(screen.getByLabelText('Show Charges vs. material cost per month as chart'));
    expect(await screen.findByTestId('line-chart')).toBeInTheDocument();
  });

  it('switches the period and builds the matching range', async () => {
    serve();
    const user = userEvent.setup();
    const { router } = renderRoute(<StatisticsPage />);
    await screen.findByLabelText('Key figures');
    await user.click(screen.getByRole('combobox', { name: 'Period' }));
    await user.click(screen.getByRole('option', { name: 'Last 30 days' }));
    await waitFor(() => expect(requests.at(-1)?.get('from')).toBe('2026-09-16'));
    expect(requests.at(-1)?.get('to')).toBe('2026-10-16');
    expect(router.state.location.search).toContain('period=30d');
    await user.click(screen.getByRole('combobox', { name: 'Period' }));
    await user.click(screen.getByRole('option', { name: 'Last 3 months' }));
    await waitFor(() => expect(requests.at(-1)?.get('from')).toBe('2026-07-15'));
  });

  it('opens a dialog for a custom range and applies it', async () => {
    serve();
    const user = userEvent.setup();
    const { router } = renderRoute(<StatisticsPage />);
    await screen.findByLabelText('Key figures');
    await user.click(screen.getByRole('combobox', { name: 'Period' }));
    await user.click(screen.getByRole('option', { name: 'Custom range…' }));
    const dialog = await screen.findByRole('dialog', { name: /Custom period/ });
    const from = within(dialog).getByLabelText('From');
    const to = within(dialog).getByLabelText('To');
    await user.clear(from);
    await user.type(from, '01.01.2026');
    await user.clear(to);
    await user.type(to, '31.01.2026');
    await user.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(router.state.location.search).toContain('period=custom'));
    expect(router.state.location.search).toContain('from=2026-01-01');
    expect(router.state.location.search).toContain('to=2026-01-31');
    await waitFor(() => expect(requests.at(-1)?.get('to')).toBe('2026-02-01'));
  });

  it('uses a custom range from the URL with the day after its end as exclusive bound', async () => {
    serve();
    renderRoute(<StatisticsPage />, '/?period=custom&from=2026-01-01&to=2026-01-31');
    await screen.findByLabelText('Key figures');
    expect(requests[0].get('from')).toBe('2026-01-01');
    expect(requests[0].get('to')).toBe('2026-02-01');
    expect(screen.getByRole('combobox', { name: 'Period' })).toHaveTextContent('Custom · 01.01.2026 – 31.01.2026');
    expect(screen.getByLabelText('Change dates')).toBeInTheDocument();
  });

  it('allows a single day and does not query an invalid range', async () => {
    serve();
    renderRoute(<StatisticsPage />, '/?period=custom&from=2026-09-15&to=2026-09-15');
    await screen.findByLabelText('Key figures');
    expect(requests[0].get('from')).toBe('2026-09-15');
    expect(requests[0].get('to')).toBe('2026-09-16');

    cleanup();
    requests = [];
    renderRoute(<StatisticsPage />, '/?period=custom&from=2026-09-16&to=2026-09-15');
    expect(await screen.findByText('Choose a valid period')).toBeInTheDocument();
    expect(screen.getByText('The end date must be on or after the start date.')).toBeInTheDocument();
    expect(requests).toHaveLength(0);
  });

  it('compares the four busiest machines by default, keeps a choice in the URL and allows at most five', async () => {
    serve();
    const user = userEvent.setup();
    const { router } = renderRoute(<StatisticsPage />, '/?tab=machines');
    const picker = await screen.findByRole('combobox', { name: /Machines/ });
    expect(picker).toHaveTextContent('4 selected');
    expect(screen.getByTestId('line-chart')).toHaveTextContent('Bravo|Charlie|Alpha|Delta');
    await user.click(picker);
    const option = (name: string) => document.querySelector(`[role="option"][aria-label="${name}"]`) as HTMLElement;
    await user.click(option('Echo'));
    await waitFor(() => expect(router.state.location.search).toContain('machines='));
    expect(option('Foxtrot')).toHaveAttribute('aria-disabled', 'true');
    await user.click(option('Bravo'));
    await waitFor(() => expect(router.state.location.search).toContain(`machines=${ids[2]}%2C${ids[0]}%2C${ids[3]}`));
  });

  it('draws when the workshop is busy, failure rates and outcomes on the machines tab', async () => {
    serve();
    renderRoute(<StatisticsPage />, '/?tab=machines');
    expect(await screen.findByTestId('heatmap-chart')).toHaveTextContent('Mon 09:00=2|Sun 23:00=1');
    expect(screen.getByTestId('donut-chart')).toHaveTextContent('Successful=100|Not recorded=20');
    const table = screen.getByRole('table', { name: 'Machines' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(7);
    expect(within(rows[1]).getByRole('link', { name: 'Bravo' })).toHaveAttribute(
      'href',
      `/workshop/machines/${ids[1]}`,
    );
  });

  it('lists material types with cost, charges, margin and losses', async () => {
    serve();
    renderRoute(<StatisticsPage />, '/?tab=materials');
    expect(await screen.findByTestId('stacked-chart')).toHaveTextContent('PLA|Plywood');
    const table = screen.getByRole('table', { name: 'Material types' });
    expect(
      within(table).getByRole('row', { name: /PLA 1,200 g €300.00 €420.00 \+€120.00 €12.00/ }),
    ).toBeInTheDocument();
    expect(
      within(table).getByRole('row', { name: /Plywood 4 sheet €100.00 €90.00 −€10.00 €0.00/ }),
    ).toBeInTheDocument();
  });

  it('shows money figures and pricing groups', async () => {
    serve();
    renderRoute(<StatisticsPage />, '/?tab=money');
    const tiles = await screen.findByLabelText('Money figures');
    expect(within(tiles).getByText('€80.00')).toBeInTheDocument();
    expect(within(tiles).getByText('+€110.00')).toBeInTheDocument();
    expect(screen.getByTestId('stacked-chart')).toHaveTextContent('Members|External');
    expect(screen.getByTestId('donut-chart')).toHaveTextContent('Members=900|External=600');
    const table = screen.getByRole('table', { name: 'Pricing groups' });
    expect(within(table).getByRole('row', { name: /Members 90 €900.00 €10.00 €20.00 60.0 %/ })).toBeInTheDocument();
  });

  it('breaks a chosen figure down by a dimension the data provides', async () => {
    serve();
    const user = userEvent.setup();
    const { router } = renderRoute(<StatisticsPage />, '/?tab=explore');
    expect(await screen.findByRole('heading', { name: 'Runtime (h) by machine' })).toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: 'By' }));
    await user.click(screen.getByRole('option', { name: 'Weekday' }));
    await waitFor(() => expect(router.state.location.search).toContain('by=weekday'));
    expect(screen.getByRole('heading', { name: 'Runtime (h) by weekday' })).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Runtime (h) by weekday' });
    expect(within(table).getByRole('row', { name: /Mon 1.5 h 75.0 %/ })).toBeInTheDocument();
    expect(within(table).getByRole('row', { name: /Total 2.0 h 100.0 %/ })).toBeInTheDocument();

    // Material cost has no weekday breakdown; the choice falls back to one the data provides.
    await user.click(screen.getByRole('combobox', { name: 'Metric' }));
    await user.click(screen.getByRole('option', { name: 'Material cost (€)' }));
    expect(await screen.findByRole('heading', { name: 'Material cost (€) by material type' })).toBeInTheDocument();
  });

  it('shows an empty state without activity', async () => {
    serve({
      ...statistics,
      totals: totals(0, '0', '0.00', '0.00', '0'),
      machines: [],
      usageByWeekdayHour: [],
      materialByMonth: [],
    });
    renderRoute(<StatisticsPage />);
    expect(await screen.findByText('No activity in this period')).toBeInTheDocument();
  });

  it('shows an error state', async () => {
    server.use(
      http.get('*/api/v1/machine-logbook/statistics', () => HttpResponse.json({ message: 'x' }, { status: 500 })),
    );
    renderRoute(<StatisticsPage />);
    expect(await screen.findByText('Statistics could not be loaded.')).toBeInTheDocument();
  });
});
