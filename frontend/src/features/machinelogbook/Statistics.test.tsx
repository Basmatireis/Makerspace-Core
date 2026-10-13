import { http, HttpResponse } from 'msw';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { StatisticsPage } from './StatisticsPage';

vi.mock('../../app/charting', () => ({
  ScaleTypes: { LINEAR: 'linear', LABELS: 'labels' },
  LineChart: ({ data }: { data: { group: string }[] }) => <div data-testid="line-chart">{[...new Set(data.map((point) => point.group))].join('|')}</div>,
  SimpleBarChart: () => <div data-testid="bar-chart" />,
}));

const ids = ['0192f6f8-743e-7c77-a349-cd07c3e8a911', '0192f6f8-743e-7c77-a349-cd07c3e8a912', '0192f6f8-743e-7c77-a349-cd07c3e8a913', '0192f6f8-743e-7c77-a349-cd07c3e8a914'];
const totals = (jobs: number, runtimeHours: string, charges: string, materialCost: string, failureRate: string) => ({ jobs, runtimeHours, charges, materialCost, failureRate });
const machine = (index: number, name: string, runtimeHours: string, jobs: number) => ({
  machineId: ids[index], name, machineTypeName: index === 3 ? 'Laser cutter' : '3D printer', jobs, runtimeHours, failureRate: '5.0', charges: '100.00', runtimeShare: '10.0',
});
const statistics = {
  totals: totals(120, '300.0', '1500.00', '400.00', '7.5'),
  previousTotals: totals(100, '0', '1500.00', '200.00', '5.0'),
  months: [{ month: '2026-09', charges: '900.00', materialCost: '200.00', losses: '12.00' }, { month: '2026-10', charges: '600.00', materialCost: '200.00', losses: '0.00' }],
  runtimeGranularity: 'month',
  runtime: [{ bucketStart: '2026-09-01', machineId: ids[0], hours: '10.0' }],
  materialCostByCategory: [{ key: 'filament', label: 'Filament', value: '300.00' }],
  machines: [machine(0, 'Alpha', '50.0', 10), machine(1, 'Bravo', '120.0', 40), machine(2, 'Charlie', '90.0', 30), machine(3, 'Delta', '10.0', 5)],
  materialUsageByCategory: [], machineRuntimeHours: [], machineJobCounts: [], acquisitionCost: [], customerCharges: [], adjustmentLoss: [], machineFailureRates: [],
};

let requests: URLSearchParams[] = [];
function serve(body: object = statistics) {
  server.use(http.get('*/api/v1/machine-logbook/statistics', ({ request }) => { requests.push(new URL(request.url).searchParams); return HttpResponse.json(body); }));
}

describe('Statistics page', () => {
  beforeEach(() => { requests = []; vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-15T10:00:00Z') }); });
  afterEach(() => vi.useRealTimers());

  it('requests the six month default with an exclusive end and shows key figures with changes', async () => {
    serve();
    renderRoute(<StatisticsPage />);
    const figures = await screen.findByRole('region', { name: 'Key figures' });
    expect(requests[0].get('from')).toBe('2026-04-15');
    expect(requests[0].get('to')).toBe('2026-10-16');
    expect(within(figures).getByText('+20 % vs previous period')).toBeInTheDocument();
    expect(within(figures).getByText('No data in previous period')).toBeInTheDocument();
    expect(within(figures).getByText('No change vs previous period')).toBeInTheDocument();
    expect(within(figures).getByText('+100 % vs previous period')).toBeInTheDocument();
    expect(within(figures).getByText('+2.5 pp vs previous period')).toBeInTheDocument();
    expect(within(figures).getByText('€1,500.00')).toBeInTheDocument();
  });

  it('switches the period and builds the matching range', async () => {
    serve();
    const user = userEvent.setup();
    const { router } = renderRoute(<StatisticsPage />);
    await screen.findByRole('region', { name: 'Key figures' });
    await user.click(screen.getByRole('tab', { name: '30 days' }));
    await waitFor(() => expect(requests.at(-1)?.get('from')).toBe('2026-09-16'));
    expect(requests.at(-1)?.get('to')).toBe('2026-10-16');
    expect(router.state.location.search).toContain('period=30d');
    await user.click(screen.getByRole('tab', { name: '12 months' }));
    await waitFor(() => expect(requests.at(-1)?.get('from')).toBe('2025-10-15'));
  });

  it('uses a custom range from the URL with the day after its end as exclusive bound', async () => {
    serve();
    renderRoute(<StatisticsPage />, '/?period=custom&from=2026-01-01&to=2026-01-31');
    await screen.findByRole('region', { name: 'Key figures' });
    expect(requests[0].get('from')).toBe('2026-01-01');
    expect(requests[0].get('to')).toBe('2026-02-01');
    expect(screen.getByLabelText('From')).toHaveValue('01.01.2026');
  });

  it('does not query an invalid range', async () => {
    serve();
    renderRoute(<StatisticsPage />, '/?period=custom&from=2026-02-01&to=2026-01-01');
    expect(await screen.findByText('Choose a valid period')).toBeInTheDocument();
    expect(requests).toHaveLength(0);
  });

  it('allows a single day and keeps the date inputs available for an invalid range', async () => {
    serve();
    renderRoute(<StatisticsPage />, '/?period=custom&from=2026-09-15&to=2026-09-15');
    await screen.findByRole('region', { name: 'Key figures' });
    expect(requests[0].get('from')).toBe('2026-09-15');
    expect(requests[0].get('to')).toBe('2026-09-16');

    cleanup();
    requests = [];
    renderRoute(<StatisticsPage />, '/?period=custom&from=2026-09-16&to=2026-09-15');
    expect(await screen.findByText('Choose a valid period')).toBeInTheDocument();
    expect(screen.getByText('The end date must be on or after the start date.')).toBeInTheDocument();
    expect(screen.getByLabelText('From')).toBeInTheDocument();
    expect(screen.getByLabelText('To')).toBeInTheDocument();
    expect(requests).toHaveLength(0);
  });

  it('compares the three busiest machines by default and keeps a choice in the URL', async () => {
    serve();
    const user = userEvent.setup();
    const { router } = renderRoute(<StatisticsPage />);
    const picker = await screen.findByRole('combobox', { name: /Machines/ });
    expect(picker).toHaveTextContent('3 selected');
    await user.click(picker);
    const option = (name: string) => document.querySelector(`[role="option"][aria-label="${name}"]`) as HTMLElement;
    const bravo = option('Bravo');
    expect(bravo).toHaveAttribute('aria-selected', 'true');
    expect(option('Delta')).toHaveAttribute('aria-selected', 'false');
    await user.click(bravo);
    await waitFor(() => expect(router.state.location.search).toContain(`machines=${ids[2]}%2C${ids[0]}`));
  });

  it('lists every machine in the per-machine table', async () => {
    serve();
    renderRoute(<StatisticsPage />);
    const table = await screen.findByRole('table', { name: 'Machines' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(5);
    expect(within(rows[1]).getByRole('link', { name: 'Bravo' })).toHaveAttribute('href', `/machine-logbook/machines/${ids[1]}`);
    expect(within(rows[1]).getByText('120')).toBeInTheDocument();
    expect(within(rows[1]).getByText('€100.00')).toBeInTheDocument();
  });

  it('shows an empty state without jobs and an error with retry', async () => {
    serve({ ...statistics, totals: totals(0, '0', '0.00', '0.00', '0'), machines: [] });
    renderRoute(<StatisticsPage />);
    expect(await screen.findByText('No activity in this period')).toBeInTheDocument();
  });

  it('shows an error state', async () => {
    server.use(http.get('*/api/v1/machine-logbook/statistics', () => HttpResponse.json({ message: 'x' }, { status: 500 })));
    renderRoute(<StatisticsPage />);
    expect(await screen.findByText('Statistics could not be loaded.')).toBeInTheDocument();
  });
});
