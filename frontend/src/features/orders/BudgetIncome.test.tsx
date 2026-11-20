import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PermissionId,
  type CashJournal,
  type WorkingGroupBudget,
  type WorkingGroupBudgetPeriod,
  type WorkingGroupIncome,
} from '../../api/generated/models';
import { App } from '../../app/App';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { as, everything } from './testData';

vi.mock('@carbon/charts-react', () => ({ LineChart: () => <div />, SimpleBarChart: () => <div /> }));

const periodId = '0192f6f8-743e-7c77-a349-cd07c3e8a001';
const aheadId = '0192f6f8-743e-7c77-a349-cd07c3e8c001';
const finance = [...everything, PermissionId.working_groupsread, PermissionId.working_group_financesmanage];

const register = {
  receipts: '300.00',
  refunds: '0.00',
  paymentCorrections: '0.00',
  corrections: '0.00',
  countSurpluses: '0.00',
  countShortfalls: '0.00',
  refundsAndCorrections: '0.00',
  withdrawals: '0.00',
  deposits: '0.00',
  expected: '300.00',
  to: null,
  lastCount: null,
};
const journalFor = (bookedAhead?: string): CashJournal => ({
  from: null,
  to: null,
  items: [],
  page: 1,
  pageSize: 25,
  total: 0,
  days: [],
  openingBalance: '0.00',
  register: { ...register, ...(bookedAhead ? { bookedAhead } : {}) },
  facts: {
    cashIn: '0.00',
    cashInEntries: 0,
    receipts: 0,
    deposits: 0,
    cashOut: '0.00',
    cashOutEntries: 0,
    refunds: 0,
    corrections: 0,
    withdrawals: 0,
    net: '0.00',
    counts: 0,
  },
});
const ahead: WorkingGroupIncome = {
  id: aheadId,
  periodId,
  amount: '120.00',
  occurredOn: '2026-11-10',
  note: 'Sales so far',
  where: 'cash',
  cashMovementId: null,
  createdByName: 'Ada Lovelace',
  createdAt: '2026-11-10T10:00:00Z',
};
const period: WorkingGroupBudgetPeriod = {
  id: periodId,
  name: 'Winter 2026',
  startsOn: '2026-10-01',
  endsOn: '2026-12-31',
  totalAmount: '1000.00',
  incomeTotal: '170.00',
  incomeDeposited: '50.00',
  incomeBookedAhead: '120.00',
  closed: false,
  current: true,
  version: 1,
  createdAt: '2026-10-01T00:00:00Z',
};

type Bodies = { movement?: Record<string, unknown>; booking?: Record<string, unknown>; undone?: string };

function serve(bodies: Bodies = {}) {
  server.use(
    http.get('*/api/v1/payments/cash-journal', () => HttpResponse.json(journalFor('120.00'))),
    http.get('*/api/v1/payments/cash-register', () => HttpResponse.json({ ...register, bookedAhead: '120.00' })),
    http.get('*/api/v1/payments', () => HttpResponse.json({ items: [], page: 1, pageSize: 100, total: 0 })),
    http.get('*/api/v1/working-group-income', () => HttpResponse.json({ items: [ahead] })),
    http.get('*/api/v1/working-group-budget-periods', () => HttpResponse.json({ items: [period] })),
    http.post('*/api/v1/cash-movements', async ({ request }) => {
      bodies.movement = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json(
        {
          id: 'm1',
          reference: 'C-2026-000009',
          kind: 'withdrawal',
          direction: 'out',
          amount: '30.00',
          reason: 'bank_deposit',
          note: '',
          occurredAt: '2026-11-10T10:00:00Z',
          createdAt: '2026-11-10T10:00:00Z',
          recordedBy: null,
          cashCountId: null,
          cashCountReference: null,
          version: 1,
          updatedAt: '2026-11-10T10:00:00Z',
        },
        { status: 201 },
      );
    }),
    http.post('*/api/v1/working-group-income', async ({ request }) => {
      bodies.booking = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ ...ahead, id: 'new', amount: '40.00', note: 'More sales' }, { status: 201 });
    }),
    http.delete('*/api/v1/working-group-income/:id', ({ params }) => {
      bodies.undone = String(params.id);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return bodies;
}

const defaultMatchMedia = window.matchMedia;
beforeEach(() => {
  window.matchMedia = (query: string) => ({
    media: query,
    matches: query === '(min-width: 66rem)',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  });
});
afterEach(() => {
  window.matchMedia = defaultMatchMedia;
});

describe('income from the cash register', () => {
  it('shows no budget choice and no booking ahead without working_group_finances.manage', async () => {
    as(everything);
    server.use(http.get('*/api/v1/payments/cash-journal', () => HttpResponse.json(journalFor())));
    serve();
    server.use(http.get('*/api/v1/payments/cash-journal', () => HttpResponse.json(journalFor())));
    const user = userEvent.setup();
    renderRoute(<App />, '/payments');
    await user.click(await screen.findByRole('button', { name: 'Withdraw' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Record cash withdrawal' })).toBeInTheDocument();
    expect(within(dialog).queryByText('Budget')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Book ahead to the budget' })).not.toBeInTheDocument();
    expect(screen.queryByText('Booked ahead to the budget')).not.toBeInTheDocument();
  });

  it('shows the booked-ahead line and lists the bookings for finance managers', async () => {
    as(finance);
    serve();
    renderRoute(<App />, '/payments');
    expect(await screen.findByRole('button', { name: 'Book ahead to the budget' })).toBeInTheDocument();
    expect(await screen.findByText('Sales so far')).toBeInTheDocument();
    expect(screen.getAllByText('Booked ahead to the budget').length).toBeGreaterThanOrEqual(2);
  });

  it('sends a partial withdrawal of a booking ahead with the budget choice', async () => {
    as(finance);
    const bodies = serve();
    const user = userEvent.setup();
    renderRoute(<App />, '/payments');
    await user.click(await screen.findByRole('button', { name: 'Withdraw' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Not for the budget')).toBeChecked();
    expect(await within(dialog).findByLabelText(/Into the budget \(Winter 2026\)/)).toBeInTheDocument();
    await user.click(await within(dialog).findByLabelText(/Money booked ahead \(€120\.00 is in the budget already\)/));
    expect(within(dialog).getByText('A smaller amount takes only part of it.')).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText('Which booking'), aheadId);
    await user.type(within(dialog).getByLabelText('Amount (€)'), '30');
    await user.click(within(dialog).getByRole('button', { name: 'Record' }));
    await waitFor(() => expect(bodies.movement).toBeDefined());
    expect(bodies.movement).toMatchObject({
      kind: 'withdrawal',
      amount: '30.00',
      budget: { mode: 'ahead', incomeId: aheadId },
    });
  });

  it('presets the withdrawal dialog to the booking whose Withdraw button was used', async () => {
    as(finance);
    serve();
    const user = userEvent.setup();
    renderRoute(<App />, '/payments');
    await user.click(await screen.findByRole('button', { name: 'Withdraw Sales so far' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByLabelText('Which booking')).toHaveValue(aheadId));
    expect(within(dialog).getByLabelText(/Money booked ahead/)).toBeChecked();
  });

  it('sends "into the budget" for a plain withdrawal into the period', async () => {
    as(finance);
    const bodies = serve();
    const user = userEvent.setup();
    renderRoute(<App />, '/payments');
    await user.click(await screen.findByRole('button', { name: 'Withdraw' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByLabelText(/Into the budget/));
    await user.type(within(dialog).getByLabelText('Amount (€)'), '30');
    await user.click(within(dialog).getByRole('button', { name: 'Record' }));
    await waitFor(() => expect(bodies.movement).toBeDefined());
    expect(bodies.movement).toMatchObject({ budget: { mode: 'new' } });
    expect(bodies.movement).not.toHaveProperty('budget.incomeId');
  });

  it('books ahead to the budget', async () => {
    as(finance);
    const bodies = serve();
    const user = userEvent.setup();
    renderRoute(<App />, '/payments');
    await user.click(await screen.findByRole('button', { name: 'Book ahead to the budget' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('€180.00 in the register is not booked yet.')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Amount (€)'), '40');
    await user.type(within(dialog).getByLabelText('Reason'), 'More sales');
    await user.click(within(dialog).getByRole('button', { name: 'Book' }));
    await waitFor(() => expect(bodies.booking).toEqual({ amount: '40.00', note: 'More sales' }));
  });

  it('refuses to book more than is free in the register', async () => {
    as(finance);
    const bodies = serve();
    const user = userEvent.setup();
    renderRoute(<App />, '/payments');
    await user.click(await screen.findByRole('button', { name: 'Book ahead to the budget' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('€180.00 in the register is not booked yet.');
    await user.type(within(dialog).getByLabelText('Amount (€)'), '181');
    await user.type(within(dialog).getByLabelText('Reason'), 'Too much');
    await user.click(within(dialog).getByRole('button', { name: 'Book' }));
    expect(await within(dialog).findByText('Only €180.00 in the register is not booked yet')).toBeInTheDocument();
    expect(bodies.booking).toBeUndefined();
  });

  it('undoes a booking after confirming', async () => {
    as(finance);
    const bodies = serve();
    const user = userEvent.setup();
    renderRoute(<App />, '/payments');
    const row = (await screen.findByText('Sales so far')).closest('li')!;
    // The row has Withdraw and the icon button that undoes the booking.
    await user.click(within(row).getAllByRole('button')[1]);
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Undo booking' }));
    await waitFor(() => expect(bodies.undone).toBe(aheadId));
  });
});

describe('the budget page with income', () => {
  const budget: WorkingGroupBudget = {
    period,
    groups: [],
    totals: {
      totalAmount: '1170.00',
      givenSum: '400.00',
      keptBack: '770.00',
      spentSum: '0.00',
      reservedSum: '0.00',
      freeSum: '400.00',
    },
  };

  it('splits the budget into HTU and income and shows the income from sales', async () => {
    as(finance);
    serve();
    server.use(
      http.get('*/api/v1/working-groups', () => HttpResponse.json({ items: [] })),
      http.get('*/api/v1/working-group-budget', () => HttpResponse.json(budget)),
    );
    renderRoute(<App />, '/working-groups/budget');
    const budgetTile = (await screen.findByText('Given to groups')).closest('.wg-minetile') as HTMLElement;
    expect(within(budgetTile).getByText('€1,170.00')).toBeInTheDocument();
    expect(within(budgetTile).getByText('From HTU')).toBeInTheDocument();
    expect(within(budgetTile).getByText('Kept back')).toBeInTheDocument();
    const income = (await screen.findByText('Income from sales')).closest('.wg-minetile') as HTMLElement;
    expect(within(income).getByText('Deposited')).toBeInTheDocument();
    expect(within(income).getByText('Booked ahead')).toBeInTheDocument();
    expect(await within(income).findByText('Register now')).toBeInTheDocument();
    expect(within(income).getByRole('link', { name: 'Cash register' })).toHaveAttribute('href', '/payments');
  });
});
