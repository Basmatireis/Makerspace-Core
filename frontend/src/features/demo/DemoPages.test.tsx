import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { queryClient } from '../../api/query-client';
import { renderRoute } from '../../test/render';
import { enterDemoMode, exitDemoMode } from './demoMode';
import { demoTestUser } from './demoTestUser';
import { DEMO_IDS } from './fake/ids';

vi.mock('@carbon/charts-react', () => ({
  LineChart: () => <div data-testid="line-chart" />,
  SimpleBarChart: () => <div data-testid="bar-chart" />,
}));

afterEach(async () => {
  await exitDemoMode();
  queryClient.clear();
});

// Every page of the three demo areas must load from the fake backend without an error notification.
const pages: [string, string | RegExp][] = [
  ['/dashboard', /Alex Demo|Ada|Good|Hello|Welcome|Hi/],
  ['/workshop/jobs', 'Phone stand'],
  ['/workshop/jobs/runs/' + DEMO_IDS.unassignedRun, 'Not part of a job'],
  ['/workshop/jobs/' + DEMO_IDS.job, 'Phone stand'],
  ['/workshop/machines', 'Prusa CORE One'],
  ['/workshop/inventory', /PLA Basic Black/],
  ['/orders', /ORD-0001/],
  ['/orders/' + DEMO_IDS.order, /ORD-0001/],
  ['/payments', /PAY-0001/],
  ['/pricing', /Members/],
  ['/open-days', 'Demo semester'],
  ['/open-days/' + DEMO_IDS.period, /Demo semester/],
  [`/open-days/${DEMO_IDS.period}/days/${DEMO_IDS.openDay}`, /Supervisor/i],
];

describe('pages in demo mode', () => {
  it.each(pages)('%s loads without an error', async (route, expected) => {
    await enterDemoMode(demoTestUser());
    renderRoute(<App />, route);
    expect((await screen.findAllByText(expected))[0]).toBeInTheDocument();
    expect(screen.queryByText(/unable to load|could not load|something went wrong/i)).not.toBeInTheDocument();
  });
});
