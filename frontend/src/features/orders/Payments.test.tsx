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
  amount: '20.00',
  reason: 'safe',
  note: 'To the safe',
  occurredAt: new Date().toISOString(),
  createdAt: at,
  recordedBy: { id: 'x', displayName: 'Sara Kofler' },
};
const register = {
  receipts: '10.00',
  refunds: '0.00',
  withdrawals: '20.00',
  deposits: '50.00',
  expected: '40.00',
  to: null,
};

function serveCashbook(requests: URL[] = []) {
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
    http.get('*/api/v1/payments/cash-register', () => HttpResponse.json(register)),
  );
}

describe('cashbook', () => {
  it('states the active period, shows the tiles and the cash movement as a line', async () => {
    as(everything);
    serveCashbook();
    renderRoute(<App />, '/payments');
    expect(await screen.findByText(/^All time · up to \d{2}\.\d{2}\.\d{4}$/)).toBeInTheDocument();
    for (const label of ['Net takings', 'Cash', 'Card', 'Invoice (wiRef)'])
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    expect(await screen.findByText('Cash in register (expected)')).toBeInTheDocument();
    expect((await screen.findAllByText('€40.00')).length).toBeGreaterThan(0);
    const table = await screen.findByRole('table', { name: 'Payments' });
    expect(await within(table).findByText('C-2026-000001')).toBeInTheDocument();
    expect(within(table).getByText('Cash withdrawal')).toBeInTheDocument();
    expect(within(table).getByText('−€20.00')).toBeInTheDocument();
    expect(await within(table).findByRole('link', { name: 'P-2026-000001' })).toHaveAttribute(
      'href',
      `/payments/${ids.payment}`,
    );
  });

  it('explains in a toggletip that only cash goes through the register', async () => {
    as(everything);
    serveCashbook();
    const user = userEvent.setup();
    renderRoute(<App />, '/payments');
    await user.click(await screen.findByRole('button', { name: 'Show how the expected cash is calculated' }));
    expect(await screen.findByText(/Card and invoice payments never go through the register/)).toBeInTheDocument();
  });

  it('loads the period from the URL and resets to all time', async () => {
    as(everything);
    const requests: URL[] = [];
    serveCashbook(requests);
    const user = userEvent.setup();
    const { router } = renderRoute(<App />, '/payments?period=yesterday');
    expect(await screen.findByText(/^Yesterday · /)).toBeInTheDocument();
    const yesterdayFrom = requests.at(-1)?.searchParams.get('from');
    expect(yesterdayFrom).toBeTruthy();
    await user.click(screen.getByLabelText(/^Filters/, { selector: 'button' }));
    expect(screen.getByRole('radio', { name: 'Yesterday' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Reset filters' }));
    await waitFor(() => expect(router.state.location.search).toBe(''));
    expect(await screen.findByText(/^All time · /)).toBeInTheDocument();
    await waitFor(() => expect(requests.at(-1)?.searchParams.get('from')).toBe(new Date(0).toISOString()));
  });

  it('applies a custom range with both dates', async () => {
    as(everything);
    const requests: URL[] = [];
    serveCashbook(requests);
    renderRoute(<App />, '/payments?period=custom&from=2026-10-01&to=2026-10-05');
    expect(await screen.findByText('Custom range · 01.10.2026 to 05.10.2026')).toBeInTheDocument();
    await waitFor(() =>
      expect(requests.at(-1)?.searchParams.get('to')).toBe(new Date('2026-10-05T22:00:00Z').toISOString()),
    );
  });

  it('records a cash withdrawal with a reason and the register limit', async () => {
    as(everything);
    serveCashbook();
    let body: Record<string, unknown> | undefined;
    server.use(
      http.post('*/api/v1/cash-movements', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(movement, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/payments');
    await user.click(await screen.findByRole('button', { name: 'Record cash withdrawal' }));
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

  it('hides cash movements and the register without the cash permissions', async () => {
    as([PermissionId.paymentsread, PermissionId.ordersread]);
    serveCashbook();
    renderRoute(<App />, '/payments');
    await screen.findByRole('table', { name: 'Payments' });
    expect(screen.queryByText('Cash in register (expected)')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record cash withdrawal' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record cash deposit' })).not.toBeInTheDocument();
  });

  it('exports the visible lines as a CSV file', async () => {
    as(everything);
    serveCashbook();
    const created: Blob[] = [];
    Object.defineProperty(URL, 'createObjectURL', {
      value: (blob: Blob) => {
        created.push(blob);
        return 'blob:x';
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', { value: () => undefined, configurable: true, writable: true });
    const user = userEvent.setup();
    renderRoute(<App />, '/payments');
    await screen.findByText('C-2026-000001');
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(created).toHaveLength(1);
    const bytes = new Uint8Array(await created[0].arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(await created[0].text()).toContain(';Cash withdrawal;Cash;-20,00;');
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
