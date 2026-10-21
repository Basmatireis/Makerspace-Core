import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type {
  PersonalBalance,
  PersonalDashboard,
  PersonalJobStatistics,
  PersonalOrder,
  PersonalRecentJob,
} from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

vi.mock('../../app/charting', () => ({
  ScaleTypes: { LINEAR: 'linear', LABELS: 'labels' },
  LineChart: () => <div />,
  SimpleBarChart: ({ data }: { data: unknown[] }) => <div data-testid="bar-chart">{data.length} bars</div>,
}));

const orderA = '0192f6f8-743e-7c77-a349-cd07c3e8c001';
const orderB = '0192f6f8-743e-7c77-a349-cd07c3e8c002';
const jobA = '0192f6f8-743e-7c77-a349-cd07c3e8c003';
const newOrder = '0192f6f8-743e-7c77-a349-cd07c3e8c004';
const periodId = '0192f6f8-743e-7c77-a349-cd07c3e8c005';
const openDayId = '0192f6f8-743e-7c77-a349-cd07c3e8c006';

function order(
  id: string,
  reference: string,
  outstanding: string,
  overrides: Partial<PersonalOrder> = {},
): PersonalOrder {
  return {
    id,
    reference,
    status: 'finalized',
    createdAt: '2026-10-01T10:00:00Z',
    itemSummary: `Items of ${reference}`,
    itemCount: 1,
    netCharge: outstanding,
    outstandingAmount: outstanding,
    settlementState: 'unpaid',
    invoiced: false,
    payable: true,
    ...overrides,
  };
}

const balance: PersonalBalance = {
  unpaidOrders: [order(orderA, 'O-1', '10.00'), order(orderB, 'O-2', '5.50')],
  unbilledJobs: [
    {
      id: jobA,
      displayId: 'J-7',
      title: 'Gearbox',
      machineName: 'Prusa MK4',
      startedAt: '2026-10-02T10:00:00Z',
      price: '4.00',
    },
  ],
  unpaidOrdersTotal: '15.50',
  unbilledJobsTotal: '4.00',
  total: '19.50',
};

const emptyBalance: PersonalBalance = {
  unpaidOrders: [],
  unbilledJobs: [],
  unpaidOrdersTotal: '0.00',
  unbilledJobsTotal: '0.00',
  total: '0.00',
};

const months = Array.from({ length: 12 }, (_, index) => ({
  month: `2026-${String(index + 1).padStart(2, '0')}`,
  jobs: index === 9 ? 3 : 0,
}));

function jobStats(overrides: Partial<PersonalJobStatistics> = {}): PersonalJobStatistics {
  return {
    jobs: 4,
    successfulJobs: 3,
    finishedJobs: 4,
    successRate: 75,
    materialGrams: 47,
    machineSeconds: 9000,
    favouriteMachine: { name: 'Prusa MK4', jobs: 3 },
    jobsPerMonth: months,
    ...overrides,
  };
}

const recentJobs: PersonalRecentJob[] = [
  {
    id: jobA,
    displayId: 'J-7',
    title: 'Gearbox',
    machineName: 'Prusa MK4',
    startedAt: '2026-10-02T10:00:00Z',
    endedAt: '2026-10-02T12:00:00Z',
    status: 'successful',
    price: '4.00',
    own: true,
    billingState: 'not_on_order',
    orderReference: null,
  },
  {
    id: '0192f6f8-743e-7c77-a349-cd07c3e8c010',
    displayId: 'J-8',
    title: 'Guest bracket',
    machineName: 'Laser',
    startedAt: '2026-10-03T10:00:00Z',
    endedAt: null,
    status: 'running',
    price: null,
    own: false,
    billingState: null,
    orderReference: null,
  },
];

const payers = [PermissionId.ordersread, PermissionId.paymentsread, PermissionId.paymentsrecord];
const jobPayers = [...payers, PermissionId.orderswrite, PermissionId.ordersfinalize];

function serve(data: Partial<PersonalDashboard>, permissions: PermissionId[]) {
  const state = { loads: 0, data };
  server.use(
    http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(permissions))),
    http.get('*/api/v1/me/dashboard', () => {
      state.loads += 1;
      return HttpResponse.json({ person: { firstName: 'Ada', memberSince: '2025-01-01T00:00:00Z' }, ...state.data });
    }),
    http.get('*/api/v1/laborordnung/status/me', () => HttpResponse.json({}, { status: 404 })),
    http.get('*/api/v1/public/open-days', () => HttpResponse.json({ items: [] })),
  );
  return state;
}

async function openPayDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Pay now' }));
  return screen.findByRole('dialog');
}

describe('dashboard balance', () => {
  it('shows two lines and the sum, and the Pay now button at the bottom of the tile', async () => {
    serve({ balance }, jobPayers);
    renderRoute(<App />, '/dashboard');
    const tile = (await screen.findByText('Open balance')).closest('.cds--tile') as HTMLElement;
    expect(within(tile).getByText('€19.50')).toBeInTheDocument();
    expect(within(tile).getByText('Unpaid orders (2)')).toBeInTheDocument();
    expect(within(tile).getByText('€15.50')).toBeInTheDocument();
    expect(within(tile).getByText('1 job not on an order')).toBeInTheDocument();
    expect(within(tile).getByText('€4.00')).toBeInTheDocument();
    const button = within(tile).getByRole('button', { name: 'Pay now' });
    expect(tile.lastElementChild).toContainElement(button);
  });

  it('is shown at 0.00 without a pay button', async () => {
    serve({ balance: emptyBalance }, jobPayers);
    renderRoute(<App />, '/dashboard');
    const tile = (await screen.findByText('Open balance')).closest('.cds--tile') as HTMLElement;
    expect(within(tile).getAllByText('€0.00')).toHaveLength(3);
    expect(within(tile).getByText(/Nothing to pay/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pay now' })).not.toBeInTheDocument();
  });

  it('is absent without orders.read', async () => {
    serve({}, [PermissionId.machine_jobsread]);
    renderRoute(<App />, '/dashboard');
    expect(await screen.findByRole('heading', { name: /Ada$/ })).toBeInTheDocument();
    expect(screen.queryByText('Open balance')).not.toBeInTheDocument();
  });

  it('shows the balance but no pay button without payments.record', async () => {
    serve({ balance }, [PermissionId.ordersread, PermissionId.paymentsread]);
    renderRoute(<App />, '/dashboard');
    expect(await screen.findByText('Open balance')).toBeInTheDocument();
    expect(screen.getByText('€19.50')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pay now' })).not.toBeInTheDocument();
  });

  it('lists jobs but cannot tick them without orders.write and orders.finalize, and explains why', async () => {
    serve({ balance }, payers);
    const user = userEvent.setup();
    renderRoute(<App />, '/dashboard');
    const dialog = await openPayDialog(user);
    const job = within(dialog).getByRole('checkbox', { name: /J-7/ });
    expect(job).toBeDisabled();
    expect(job).not.toBeChecked();
    expect(
      within(dialog).getByText(/Jobs can only be paid by someone who may create and finalize orders/),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Pay €15.50' })).toBeEnabled();
  });
});

describe('pay dialog', () => {
  it('starts with everything ticked and pays orders and jobs in one request', async () => {
    const state = serve({ balance }, jobPayers);
    let body: Record<string, unknown> | undefined;
    server.use(
      http.post('*/api/v1/me/payments', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        state.data = { balance: emptyBalance };
        return HttpResponse.json(
          {
            total: '19.50',
            createdOrderId: newOrder,
            orders: [
              { orderId: orderA, reference: 'O-1', amount: '10.00' },
              { orderId: orderB, reference: 'O-2', amount: '5.50' },
              { orderId: newOrder, reference: 'O-3', amount: '4.00' },
            ],
          },
          { status: 201 },
        );
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/dashboard');
    const dialog = await openPayDialog(user);
    for (const name of [/O-1/, /O-2/, /J-7/]) expect(within(dialog).getByRole('checkbox', { name })).toBeChecked();
    expect(within(dialog).getByText('Recorded under your name')).toBeInTheDocument();
    expect(within(dialog).getByText(/put on a new order for you/)).toBeInTheDocument();
    const loads = state.loads;
    await user.click(within(dialog).getByRole('button', { name: 'Pay €19.50' }));
    await waitFor(() =>
      expect(body).toMatchObject({
        orderIds: [orderA, orderB],
        jobIds: [jobA],
        expectedTotal: '19.50',
        payments: [{ method: 'cash', amount: '19.50' }],
      }),
    );
    expect(body?.operationKey).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(state.loads).toBeGreaterThan(loads));
    expect(await screen.findByText(/Nothing to pay/)).toBeInTheDocument();
  });

  it('pays a subset after unticking, with the amount following the selection', async () => {
    serve({ balance }, jobPayers);
    let body: Record<string, unknown> | undefined;
    server.use(
      http.post('*/api/v1/me/payments', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ total: '10.00', createdOrderId: null, orders: [] }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/dashboard');
    const dialog = await openPayDialog(user);
    await user.click(within(dialog).getByRole('checkbox', { name: /O-2/ }));
    await user.click(within(dialog).getByRole('checkbox', { name: /J-7/ }));
    expect(within(dialog).getByRole('checkbox', { name: /Everything/ })).toBePartiallyChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Pay €10.00' }));
    await waitFor(() =>
      expect(body).toMatchObject({
        orderIds: [orderA],
        jobIds: [],
        expectedTotal: '10.00',
        payments: [{ method: 'cash', amount: '10.00' }],
      }),
    );
  });

  it('cannot pay with nothing selected', async () => {
    serve({ balance }, jobPayers);
    const user = userEvent.setup();
    renderRoute(<App />, '/dashboard');
    const dialog = await openPayDialog(user);
    await user.click(within(dialog).getByRole('checkbox', { name: /Everything/ }));
    expect(within(dialog).getByRole('button', { name: 'Select something to pay' })).toBeDisabled();
  });

  it('shows the message and refetches when the balance changed meanwhile', async () => {
    const state = serve({ balance }, jobPayers);
    server.use(
      http.post('*/api/v1/me/payments', () => {
        state.data = {
          balance: {
            ...balance,
            unpaidOrders: [order(orderA, 'O-1', '10.00')],
            unpaidOrdersTotal: '10.00',
            total: '14.00',
          },
        };
        return HttpResponse.json({ code: 'payment_total_changed', message: 'The total changed.' }, { status: 409 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/dashboard');
    const dialog = await openPayDialog(user);
    const loads = state.loads;
    await user.click(within(dialog).getByRole('button', { name: 'Pay €19.50' }));
    expect(await within(dialog).findByText(/Your open balance changed while this dialog was open/)).toBeInTheDocument();
    await waitFor(() => expect(state.loads).toBeGreaterThan(loads));
    // O-2 is gone from the list; the remaining selection and the amount are updated.
    await waitFor(() => expect(within(dialog).queryByRole('checkbox', { name: /O-2/ })).not.toBeInTheDocument());
    expect(await within(dialog).findByRole('button', { name: 'Pay €14.00' })).toBeEnabled();
  });

  it('shows the server message for other refusals', async () => {
    serve({ balance }, jobPayers);
    server.use(
      http.post('*/api/v1/me/payments', () =>
        HttpResponse.json({ code: 'payment_total_mismatch', message: 'The payments do not add up.' }, { status: 422 }),
      ),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/dashboard');
    const dialog = await openPayDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Pay €19.50' }));
    expect(await within(dialog).findByText('The payments do not add up.')).toBeInTheDocument();
  });

  it('requires the terminal evidence for a card payment', async () => {
    serve({ balance }, jobPayers);
    const user = userEvent.setup();
    renderRoute(<App />, '/dashboard');
    const dialog = await openPayDialog(user);
    await user.click(within(dialog).getByRole('radio', { name: /Card/ }));
    expect(within(dialog).getByRole('button', { name: 'Pay €19.50' })).toBeDisabled();
    expect(within(dialog).getByText('Enter the reference from the terminal slip')).toBeInTheDocument();
  });
});

describe('recent orders and jobs', () => {
  it('lists orders with tags and pays a single unpaid order from its menu', async () => {
    serve(
      {
        balance,
        recentOrders: [
          order(orderA, 'O-1', '10.00'),
          order(orderB, 'O-2', '0.00', { settlementState: 'paid', payable: false }),
        ],
      },
      jobPayers,
    );
    let body: Record<string, unknown> | undefined;
    server.use(
      http.post('*/api/v1/me/payments', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ total: '10.00', createdOrderId: null, orders: [] }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/dashboard');
    const panel = (await screen.findByText('Recent orders')).closest('.cds--contained-list') as HTMLElement;
    expect(within(panel).getByText('Unpaid')).toBeInTheDocument();
    expect(within(panel).getByText('Paid')).toBeInTheDocument();
    // Only the unpaid order has a menu.
    expect(within(panel).getAllByText(/^Actions for/, { selector: '.cds--tooltip-content' })).toHaveLength(1);
    const tooltip = within(panel).getByText('Actions for O-1', { selector: '.cds--tooltip-content' });
    await user.click(tooltip.closest('.cds--popover-container')!.querySelector('button') as HTMLElement);
    await user.click(await screen.findByText('Pay €10.00'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('checkbox', { name: /O-1/ })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: /O-2/ })).not.toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: /J-7/ })).not.toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Pay €10.00' }));
    await waitFor(() => expect(body).toMatchObject({ orderIds: [orderA], jobIds: [], expectedTotal: '10.00' }));
  });

  it('offers no pay menu without payments.record', async () => {
    serve({ balance, recentOrders: [order(orderA, 'O-1', '10.00')] }, [PermissionId.ordersread]);
    renderRoute(<App />, '/dashboard');
    const panel = (await screen.findByText('Recent orders')).closest('.cds--contained-list') as HTMLElement;
    expect(within(panel).getByText('Unpaid')).toBeInTheDocument();
    expect(within(panel).queryAllByText(/^Actions for/, { selector: '.cds--tooltip-content' })).toHaveLength(0);
  });

  it('lists own jobs with billing state and jobs run for others without it', async () => {
    serve({ recentJobs }, [PermissionId.machine_jobsread]);
    renderRoute(<App />, '/dashboard');
    const panel = (await screen.findByText('Recent jobs')).closest('.cds--contained-list') as HTMLElement;
    expect(within(panel).getByRole('link', { name: 'Gearbox' })).toBeInTheDocument();
    expect(within(panel).getByText(/€4\.00 · not on an order yet/)).toBeInTheDocument();
    expect(within(panel).getByText('Successful')).toBeInTheDocument();
    expect(within(panel).getByText(/Run for someone else · Laser/)).toBeInTheDocument();
    expect(within(panel).getByText('Running')).toBeInTheDocument();
  });
});

describe('job statistics', () => {
  const statistics = (jobs: PersonalJobStatistics) => ({
    openDaysStaffed: 0,
    openDayHours: 0,
    eventShifts: 0,
    eventShiftHours: 0,
    memberSince: '2025-01-01T00:00:00Z',
    jobs,
  });

  it('shows jobs, success rate, material in Benchys, machine time and the favourite machine', async () => {
    serve({ statistics: statistics(jobStats()) }, [PermissionId.machine_jobsread]);
    renderRoute(<App />, '/dashboard');
    expect(await screen.findByText('75 % came out right')).toBeInTheDocument();
    expect(screen.getByText('47 g')).toBeInTheDocument();
    expect(screen.getByText('About 3 Benchys’ worth')).toBeInTheDocument();
    expect(screen.getByText('2.5 h')).toBeInTheDocument();
    expect(screen.getByText('Favourite: Prusa MK4 (3 jobs)')).toBeInTheDocument();
  });

  it('says so when not a single Benchy has been printed and shows kilograms for large amounts', async () => {
    serve({ statistics: statistics(jobStats({ materialGrams: 1500, successRate: null, favouriteMachine: null })) }, [
      PermissionId.machine_jobsread,
    ]);
    renderRoute(<App />, '/dashboard');
    expect(await screen.findByText('1.5 kg')).toBeInTheDocument();
    expect(screen.getByText('About 100 Benchys’ worth')).toBeInTheDocument();
    expect(screen.getByText('No favourite machine yet')).toBeInTheDocument();
  });

  it('loads the jobs-per-month chart lazily and hides it without jobs', async () => {
    serve({ statistics: statistics(jobStats()) }, [PermissionId.machine_jobsread]);
    const view = renderRoute(<App />, '/dashboard');
    expect(await screen.findByTestId('bar-chart')).toHaveTextContent('12 bars');
    expect(screen.getByRole('table', { name: 'Your jobs per month' })).toBeInTheDocument();
    view.unmount();

    serve({ statistics: statistics(jobStats({ jobs: 0, successRate: null, materialGrams: 0 })) }, [
      PermissionId.machine_jobsread,
    ]);
    renderRoute(<App />, '/dashboard');
    expect(await screen.findByText('Your first job is waiting')).toBeInTheDocument();
    expect(screen.queryByTestId('bar-chart')).not.toBeInTheDocument();
  });
});

describe('open day deep links', () => {
  it('links coming-up open days to their period', async () => {
    serve(
      {
        staffing: {
          kind: 'supervisor',
          semester: { periodId, name: 'Autumn', startsOn: '2026-10-01', endsOn: '2027-01-31' },
          minimum: 2,
          traineeThreshold: 3,
          staffed: 1,
          booked: 0,
          staffedAsTrainee: 0,
          status: 'missing',
          missing: 1,
          nextOpenPlace: null,
          nextOpenDay: null,
        },
        comingUp: [
          {
            kind: 'open_day',
            id: openDayId,
            openDayId,
            periodId,
            title: 'Open day · Autumn',
            startsAt: new Date(Date.now() + 30 * 3_600_000).toISOString(),
            endsAt: new Date(Date.now() + 34 * 3_600_000).toISOString(),
          },
        ],
      },
      [PermissionId.open_daysread],
    );
    renderRoute(<App />, '/dashboard');
    const panel = (await screen.findByText('Coming up')).closest('.cds--contained-list') as HTMLElement;
    expect(within(panel).getByRole('link', { name: 'Open day · Autumn' })).toHaveAttribute(
      'href',
      `/open-days/${periodId}/days/${openDayId}`,
    );
    expect(screen.getByRole('link', { name: 'Open day details' })).toHaveAttribute(
      'href',
      `/open-days/${periodId}/days/${openDayId}`,
    );
  });
});
