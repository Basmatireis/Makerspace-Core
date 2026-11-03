import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionId, type CashJournal, type CashJournalEntry } from '../../api/generated/models';
import { App } from '../../app/App';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { as, everything } from './testData';

vi.mock('@carbon/charts-react', () => ({ LineChart: () => <div />, SimpleBarChart: () => <div /> }));

const base = {
  occurredAt: '2026-10-31T09:15:30Z',
  day: '2026-10-31',
  recordedBy: { id: 'x', displayName: 'Sara Kofler' },
  order: null,
  paymentReason: '',
  reversedPaymentReference: null,
  updatedAt: '2026-10-31T09:15:30Z',
};
const withdrawal: CashJournalEntry = {
  ...base,
  id: 'm1',
  source: 'movement',
  kind: 'withdrawal',
  reference: 'C-2026-000001',
  amountIn: null,
  amountOut: '20.00',
  balanceAfter: '40.00',
  movementReason: 'safe',
  note: 'To the safe',
  count: null,
  version: 3,
  updatedAt: '2026-11-01T08:00:00Z',
};
const count: CashJournalEntry = {
  ...base,
  id: 'k1',
  source: 'count',
  kind: 'count',
  reference: 'K-2026-0001',
  occurredAt: '2026-10-31T10:00:00Z',
  amountIn: null,
  amountOut: null,
  balanceAfter: '40.00',
  movementReason: null,
  note: '',
  count: {
    id: 'k1',
    reference: 'K-2026-0001',
    countedAmount: '37.50',
    expectedAmount: '40.00',
    difference: '-2.50',
    reason: 'counting_error',
  },
  version: 2,
};
const receipt: CashJournalEntry = {
  ...base,
  id: 'p1',
  source: 'payment',
  kind: 'receipt',
  reference: 'P-2026-000001',
  amountIn: '10.00',
  amountOut: null,
  balanceAfter: '60.00',
  movementReason: null,
  note: '',
  count: null,
  version: null,
  updatedAt: null,
};
const register = {
  receipts: '10.00',
  refunds: '0.00',
  paymentCorrections: '0.00',
  corrections: '2.50',
  countSurpluses: '0.00',
  countShortfalls: '2.50',
  refundsAndCorrections: '2.50',
  withdrawals: '20.00',
  deposits: '50.00',
  expected: '37.50',
  to: null,
  lastCount: null,
};
const journal: CashJournal = {
  from: null,
  to: null,
  items: [count, withdrawal, receipt],
  page: 1,
  pageSize: 25,
  total: 3,
  days: [{ date: '2026-10-31', openingBalance: '50.00', closingBalance: '37.50', cashIn: '10.00', cashOut: '22.50' }],
  openingBalance: '0.00',
  register,
  facts: {
    cashIn: '60.00',
    cashInEntries: 2,
    receipts: 1,
    deposits: 1,
    cashOut: '22.50',
    cashOutEntries: 2,
    refunds: 0,
    corrections: 1,
    withdrawals: 1,
    net: '37.50',
    counts: 1,
  },
};

const manager = [...everything, PermissionId.cash_movementsmanage];

// The entry panel sits next to the journal from 1056 px on.
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
  server.use(
    http.get('*/api/v1/payments/cash-journal', () => HttpResponse.json(journal)),
    http.get('*/api/v1/payments/cash-register', () => HttpResponse.json(register)),
    http.get('*/api/v1/payments', () => HttpResponse.json({ items: [], page: 1, pageSize: 100, total: 0 })),
  );
});
afterEach(() => {
  window.matchMedia = defaultMatchMedia;
});

describe('editing and deleting cash register entries', () => {
  it('offers Edit and Delete on withdrawals, deposits and counts only with cash_movements.manage', async () => {
    as(everything);
    renderRoute(<App />, `/payments?entry=${withdrawal.id}`);
    expect(await screen.findByRole('heading', { name: withdrawal.reference })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('shows Edit and Delete with the permission, never on payments', async () => {
    as(manager);
    const user = userEvent.setup();
    renderRoute(<App />, `/payments?entry=${withdrawal.id}`);
    expect(await screen.findByRole('heading', { name: withdrawal.reference })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.getByText('Last edited')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: receipt.reference }));
    expect(await screen.findByRole('heading', { name: receipt.reference })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('edits a withdrawal in the record dialog and keeps the stored time when it is untouched', async () => {
    as(manager);
    let body: Record<string, unknown> | undefined;
    server.use(
      http.patch('*/api/v1/cash-movements/m1', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          id: 'm1',
          reference: withdrawal.reference,
          kind: 'withdrawal',
          direction: 'out',
          amount: '25.00',
          reason: 'safe',
          note: 'To the safe',
          occurredAt: withdrawal.occurredAt,
          createdAt: withdrawal.occurredAt,
          recordedBy: null,
          cashCountId: null,
          cashCountReference: null,
          version: 4,
          updatedAt: '2026-11-02T08:00:00Z',
        });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/payments?entry=${withdrawal.id}`);
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Edit withdrawal' })).toBeInTheDocument();
    const amount = within(dialog).getByLabelText('Amount (€)');
    expect(amount).toHaveValue('20,00');
    expect(within(dialog).getByLabelText('Note (optional)')).toHaveValue('To the safe');
    expect(
      await within(dialog).findByText('Without this withdrawal the register should hold €57.50 now.'),
    ).toBeVisible();
    await user.clear(amount);
    await user.type(amount, '25');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(body).toEqual({ expectedVersion: 3, amount: '25.00', reason: 'safe', note: 'To the safe' }),
    );
    expect(await screen.findByText('Withdrawal saved')).toBeInTheDocument();
  });

  it('edits a count without counting its own correction as expected', async () => {
    as(manager);
    let body: Record<string, unknown> | undefined;
    server.use(
      http.patch('*/api/v1/payments/cash-counts/k1', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          id: 'k1',
          reference: 'K-2026-0001',
          countedAmount: '40.00',
          expectedAmount: '40.00',
          difference: '0.00',
          reason: null,
          note: '',
          countedAt: count.occurredAt,
          createdAt: count.occurredAt,
          recordedBy: null,
          correction: null,
          version: 3,
          updatedAt: '2026-11-02T08:00:00Z',
        });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/payments?entry=${count.id}`);
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Edit count' })).toBeInTheDocument();
    const amount = within(dialog).getByLabelText('Counted amount (€)');
    expect(amount).toHaveValue('37,50');
    // The register figures include the count's own −€2.50 correction; the dialog leaves it out.
    expect(await within(dialog).findByText('−€2.50')).toBeInTheDocument();
    await user.clear(amount);
    await user.type(amount, '40');
    expect(await within(dialog).findByText('The count matches.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(body).toEqual({ expectedVersion: 2, countedAmount: '40.00', note: '', expectedAmount: '40.00' }),
    );
    expect(await screen.findByText('Count saved')).toBeInTheDocument();
  });

  it('deletes a count after confirming that its correction goes too', async () => {
    as(manager);
    let body: Record<string, unknown> | undefined;
    server.use(
      http.delete('*/api/v1/payments/cash-counts/k1', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/payments?entry=${count.id}`);
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByRole('heading', { name: 'Delete count?' })).toBeInTheDocument();
    expect(dialog).toHaveTextContent('Count K-2026-0001 found €37.50. Its correction is removed too');
    expect(dialog).toHaveTextContent('This cannot be undone.');
    expect(body).toBeUndefined();
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(body).toEqual({ expectedVersion: 2 }));
    expect(await screen.findByText('Count deleted')).toBeInTheDocument();
  });

  it('deletes a withdrawal naming its reference and amount', async () => {
    as(manager);
    let deleted = false;
    server.use(
      http.delete('*/api/v1/cash-movements/m1', () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/payments?entry=${withdrawal.id}`);
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('The withdrawal C-2026-000001 of €20.00 is removed from the cash register.');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleted).toBe(true));
    expect(await screen.findByText('Withdrawal deleted')).toBeInTheDocument();
  });
});
