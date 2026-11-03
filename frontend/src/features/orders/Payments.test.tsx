import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { as, at, everything, finalized, ids, invoiceRequest, orderList, paid, receipt } from './testData';

vi.mock('@carbon/charts-react', () => ({ LineChart: () => <div />, SimpleBarChart: () => <div /> }));

const movement = {
  id: 'm1',
  reference: 'C-2026-000001',
  kind: 'withdrawal',
  direction: 'out',
  amount: '20.00',
  reason: 'safe',
  note: 'To the safe',
  occurredAt: new Date().toISOString(),
  createdAt: at,
  recordedBy: { id: 'x', displayName: 'Sara Kofler' },
  cashCountId: null,
  cashCountReference: null,
};
const register = {
  receipts: '10.00',
  refunds: '0.00',
  paymentCorrections: '0.00',
  corrections: '0.00',
  countSurpluses: '0.00',
  countShortfalls: '0.00',
  refundsAndCorrections: '0.00',
  withdrawals: '20.00',
  deposits: '50.00',
  expected: '40.00',
  to: null,
  lastCount: null,
};
const journalEntry = {
  id: ids.payment,
  source: 'payment',
  kind: 'receipt',
  reference: 'P-2026-000001',
  occurredAt: '2026-10-31T10:00:00Z',
  day: '2026-10-31',
  amountIn: '10.00',
  amountOut: null,
  balanceAfter: '60.00',
  recordedBy: { id: 'x', displayName: 'Sara Kofler' },
  order: { id: ids.order, reference: 'O-2026-000001', customerName: 'Ada Lovelace' },
  paymentReason: '',
  reversedPaymentReference: null,
  movementReason: null,
  note: '',
  count: null,
};
const journal = {
  from: null,
  to: null,
  items: [journalEntry],
  page: 1,
  pageSize: 25,
  total: 1,
  days: [{ date: '2026-10-31', openingBalance: '50.00', closingBalance: '60.00', cashIn: '10.00', cashOut: '0.00' }],
  openingBalance: '0.00',
  register,
  facts: {
    cashIn: '60.00',
    cashInEntries: 2,
    receipts: 1,
    deposits: 1,
    cashOut: '20.00',
    cashOutEntries: 1,
    refunds: 0,
    corrections: 0,
    withdrawals: 1,
    net: '40.00',
    counts: 0,
  },
};

const lastOf = (requests: URL[], suffix: string) => requests.filter((url) => url.pathname.endsWith(suffix)).at(-1);

function servePayments(requests: URL[] = []) {
  const onOrder = paid({
    allocations: [
      {
        id: 'a1',
        paymentId: ids.payment,
        paymentReference: 'P-2026-000001',
        orderId: ids.order,
        orderReference: 'O-2026-000001',
        amount: '10.00',
        operationId: 'op',
        createdAt: at,
      },
    ],
  });
  orderList([onOrder]);
  server.use(
    http.get('*/api/v1/payments', ({ request }) => {
      requests.push(new URL(request.url));
      return HttpResponse.json({
        items: [receipt({ allocations: onOrder.allocations })],
        page: 1,
        pageSize: 100,
        total: 1,
      });
    }),
    http.get('*/api/v1/cash-movements', () =>
      HttpResponse.json({ items: [movement], page: 1, pageSize: 100, total: 1 }),
    ),
    http.get('*/api/v1/payments/cash-register', ({ request }) => {
      requests.push(new URL(request.url));
      return HttpResponse.json(register);
    }),
    http.get('*/api/v1/payments/cash-journal', ({ request }) => {
      requests.push(new URL(request.url));
      return HttpResponse.json(journal);
    }),
  );
}

describe('cash register', () => {
  it('shows the journal by day and what should be in the register', async () => {
    as(everything);
    servePayments();
    renderRoute(<App />, '/payments');
    const table = await screen.findByRole('table', { name: 'Cash journal' });
    expect(within(table).getByText('Saturday 31 October')).toBeInTheDocument();
    expect(within(table).getByText(/opening balance €50\.00/)).toBeInTheDocument();
    expect(within(table).getByText('O-2026-000001 · Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('Expected in the register')).toBeInTheDocument();
    expect(screen.getByLabelText('How the expected cash is calculated')).toHaveTextContent('= Expected€40.00');
    expect(screen.getByText('Not counted yet.')).toBeInTheDocument();
  });

  it('sends the period as whole days and the kind filter to the journal', async () => {
    as(everything);
    const requests: URL[] = [];
    servePayments(requests);
    renderRoute(<App />, '/payments?period=custom&from=2026-10-01&to=2026-10-05&kind=count');
    await screen.findByRole('table', { name: 'Cash journal' });
    expect(screen.getByText('1 – 5 Oct 2026', { selector: '.cds--tag *' })).toBeInTheDocument();
    await waitFor(() => {
      const last = lastOf(requests, '/cash-journal');
      expect(last?.searchParams.get('from')).toBe('2026-10-01');
      expect(last?.searchParams.get('to')).toBe('2026-10-05');
      expect(last?.searchParams.getAll('kind')).toEqual(['count']);
      expect(last?.searchParams.get('direction')).toBe('desc');
    });
  });

  it('records a count with the expected amount at the counting time', async () => {
    as(everything);
    const requests: URL[] = [];
    servePayments(requests);
    let body: Record<string, unknown> | undefined;
    server.use(
      http.post('*/api/v1/payments/cash-counts', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          {
            id: 'k',
            reference: 'K-2026-0001',
            countedAmount: '37.50',
            expectedAmount: '40.00',
            difference: '-2.50',
            reason: 'counting_error',
            note: '',
            countedAt: body.countedAt,
            createdAt: body.countedAt,
            recordedBy: null,
            correction: { id: 'c', reference: 'C-2026-000009' },
          },
          { status: 201 },
        );
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/payments');
    await user.click(await screen.findByRole('button', { name: 'Count' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(lastOf(requests, '/cash-register')?.searchParams.get('to')).toMatch(/\.000001Z$/));
    await user.type(within(dialog).getByLabelText('Counted amount (€)'), '37,50');
    expect(await within(dialog).findByText('Less cash than expected.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Record count and book −€2.50' }));
    expect(await within(dialog).findByText('Say why the count differs')).toBeInTheDocument();
    expect(body).toBeUndefined();
    await user.selectOptions(within(dialog).getByLabelText('Reason for the difference'), 'counting_error');
    await user.click(within(dialog).getByRole('button', { name: 'Record count and book −€2.50' }));
    await waitFor(() =>
      expect(body).toMatchObject({ countedAmount: '37.50', reason: 'counting_error', expectedAmount: '40.00' }),
    );
    expect(await screen.findByText('Difference −€2.50 booked as a correction')).toBeInTheDocument();
  });

  it('records a cash withdrawal from the register panel with the register limit', async () => {
    as(everything);
    servePayments();
    let body: Record<string, unknown> | undefined;
    server.use(
      http.post('*/api/v1/cash-movements', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(movement, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/payments');
    await user.click(await screen.findByRole('button', { name: 'Withdraw' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Amount (€)'), '100');
    await user.click(within(dialog).getByRole('button', { name: 'Record' }));
    expect(await within(dialog).findByText('The register should only hold €40.00')).toBeInTheDocument();
    expect(body).toBeUndefined();
    await user.clear(within(dialog).getByLabelText('Amount (€)'));
    await user.type(within(dialog).getByLabelText('Amount (€)'), '20,50');
    await user.click(within(dialog).getByRole('button', { name: 'Record' }));
    await waitFor(() => expect(body).toMatchObject({ kind: 'withdrawal', amount: '20.50', reason: 'bank_deposit' }));
  });

  it('downloads the cashbook export from the server', async () => {
    as(everything);
    servePayments();
    let exported: URL | undefined;
    server.use(
      http.get('*/api/v1/payments/cashbook-export', ({ request }) => {
        exported = new URL(request.url);
        return new HttpResponse('%PDF-1.4', {
          headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="x.pdf"' },
        });
      }),
    );
    Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:x', configurable: true, writable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: () => undefined, configurable: true, writable: true });
    const user = userEvent.setup();
    renderRoute(<App />, '/payments?period=custom&from=2026-10-01&to=2026-10-31');
    await user.click(await screen.findByRole('button', { name: 'Export' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Download PDF' }));
    await waitFor(() =>
      expect(exported?.searchParams.toString()).toBe('from=2026-10-01&to=2026-10-31&contents=cash_register&format=pdf'),
    );
    expect(await screen.findByText('Cashbook downloaded')).toBeInTheDocument();
  });

  it('shows only the cashbook without the cash permissions', async () => {
    as([PermissionId.paymentsread, PermissionId.ordersread]);
    servePayments();
    renderRoute(<App />, '/payments');
    await screen.findByRole('table', { name: 'Payments' });
    expect(screen.queryByRole('tab', { name: 'Cash register' })).not.toBeInTheDocument();
    expect(screen.queryByText('Expected in the register')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Export' })).not.toBeInTheDocument();
  });
});

describe('cashbook', () => {
  it('shows the tiles and the cash movement as a line', async () => {
    as(everything);
    servePayments();
    renderRoute(<App />, '/payments?tab=cashbook');
    for (const label of ['Net takings', 'Cash', 'Card', 'Invoice (wiRef)'])
      expect((await screen.findAllByText(label)).length).toBeGreaterThan(0);
    const table = await screen.findByRole('table', { name: 'Payments' });
    expect(await within(table).findByText('C-2026-000001')).toBeInTheDocument();
    expect(within(table).getByText('Not tied to an order')).toBeInTheDocument();
    expect(within(table).getByText('−€20.00')).toBeInTheDocument();
    expect(await within(table).findByRole('link', { name: 'P-2026-000001' })).toHaveAttribute(
      'href',
      `/payments/${ids.payment}`,
    );
  });

  it('searches the kind labels of payments and cash movements', async () => {
    as(everything);
    servePayments();
    const user = userEvent.setup();
    renderRoute(<App />, '/payments?tab=cashbook');
    const table = await screen.findByRole('table', { name: 'Payments' });
    expect(await within(table).findByRole('link', { name: 'P-2026-000001' })).toBeInTheDocument();
    const search = screen.getByLabelText('Search payments', { selector: 'input' });
    await user.type(search, 'withdrawal');
    await waitFor(() => expect(within(table).queryByRole('link', { name: 'P-2026-000001' })).not.toBeInTheDocument());
    expect(within(table).getByText('C-2026-000001')).toBeInTheDocument();
  });

  it('shows the period as a removable tag and resets to all time', async () => {
    as(everything);
    const requests: URL[] = [];
    servePayments(requests);
    const user = userEvent.setup();
    const { router } = renderRoute(<App />, '/payments?tab=cashbook&period=month');
    await screen.findByRole('table', { name: 'Payments' });
    await waitFor(() => expect(lastOf(requests, '/payments')?.searchParams.get('from')).toBeTruthy());
    // jsdom gives the tag's close button no name (it is labelled by a tooltip), so it is found through the tag.
    const tag = screen.getByText('This month', { selector: '.cds--tag *' }).closest('.cds--tag')!;
    await user.click(within(tag as HTMLElement).getByRole('button'));
    await waitFor(() => expect(router.state.location.search).toBe('?tab=cashbook'));
    await waitFor(() => expect(lastOf(requests, '/payments')?.searchParams.has('from')).toBe(false));
  });
});

describe('payment detail', () => {
  it('refunds a cash payment with the current order version', async () => {
    as(everything);
    const onOrder = paid({
      allocations: [
        {
          id: 'a1',
          paymentId: ids.payment,
          paymentReference: 'P-2026-000001',
          orderId: ids.order,
          orderReference: 'O-2026-000001',
          amount: '10.00',
          operationId: 'op',
          createdAt: at,
        },
      ],
    });
    let body: Record<string, unknown> | undefined;
    server.use(
      http.get(`*/api/v1/payments/${ids.payment}`, () =>
        HttpResponse.json(receipt({ allocations: onOrder.allocations })),
      ),
      http.get('*/api/v1/payments', () => HttpResponse.json({ items: [], page: 1, pageSize: 100, total: 0 })),
      http.get(`*/api/v1/orders/${ids.order}`, () => HttpResponse.json(onOrder)),
      http.post(`*/api/v1/payments/${ids.payment}/reverse`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(finalized());
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/payments/${ids.payment}`);
    await user.click(await screen.findByRole('button', { name: 'Refund or correct' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Reason'), 'Cash refunded');
    await user.click(within(dialog).getByRole('button', { name: 'Refund payment' }));
    await waitFor(() =>
      expect(body).toMatchObject({
        expectedVersion: 2,
        reversal: { paymentId: ids.payment, reasonKind: 'refund', reason: 'Cash refunded' },
      }),
    );
  });

  it('asks for the wiRef cancellation first while an invoice states what was paid', async () => {
    as(everything);
    const locked = paid({
      activeExternalRequestId: ids.request,
      activeExternalRequestReference: 'W-2026-000001',
      activeExternalRequestState: 'submitted',
      allocations: [
        {
          id: 'a1',
          paymentId: ids.payment,
          paymentReference: 'P-2026-000001',
          orderId: ids.order,
          orderReference: 'O-2026-000001',
          amount: '10.00',
          operationId: 'op',
          createdAt: at,
        },
      ],
    });
    server.use(
      http.get(`*/api/v1/payments/${ids.payment}`, () =>
        HttpResponse.json(receipt({ allocations: locked.allocations })),
      ),
      http.get('*/api/v1/payments', () => HttpResponse.json({ items: [], page: 1, pageSize: 100, total: 0 })),
      http.get(`*/api/v1/orders/${ids.order}`, () => HttpResponse.json(locked)),
      http.get(`*/api/v1/external-invoice-requests/${ids.request}`, () => HttpResponse.json(invoiceRequest())),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/payments/${ids.payment}`);
    await user.click(await screen.findByRole('button', { name: 'Refund or correct' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Cancel the wiRef request first')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Refund payment' })).toBeDisabled();
  });
});
