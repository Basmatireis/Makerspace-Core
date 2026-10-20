import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { as, at, everything, finalized, ids, order, paid, receipt } from './testData';

vi.mock('@carbon/charts-react', () => ({ LineChart: () => <div />, SimpleBarChart: () => <div /> }));

const allocation = (id: string, paymentId: string, reference: string, amount: string) => ({
  id,
  paymentId,
  paymentReference: reference,
  orderId: ids.order,
  orderReference: 'O-2026-000001',
  amount,
  operationId: 'op',
  createdAt: at,
});
const cashShare = allocation('a1', ids.payment, 'P-2026-000001', '4.00');
const partial = finalized({
  settlementState: 'partially_paid',
  settledAmount: '4.00',
  outstandingAmount: '6.00',
  allocations: [cashShare],
});
const full = paid({ allocations: [allocation('a1', ids.payment, 'P-2026-000001', '10.00')] });

function serve(
  current: ReturnType<typeof order>,
  payments = [receipt({ amount: current.settledAmount, allocations: current.allocations })],
) {
  server.use(
    http.get(`*/api/v1/orders/${current.id}`, () => HttpResponse.json(current)),
    ...payments.map((payment) => http.get(`*/api/v1/payments/${payment.id}`, () => HttpResponse.json(payment))),
    http.get('*/api/v1/payments', () => HttpResponse.json({ items: [], page: 1, pageSize: 100, total: 0 })),
  );
}

afterEach(() => vi.restoreAllMocks());

describe('receipt action', () => {
  it('is offered on a paid order and opens the receipt route', async () => {
    as(everything);
    serve(full);
    const user = userEvent.setup();
    const { router } = renderRoute(<App />, `/orders/${ids.order}`);
    await user.click(await screen.findByRole('button', { name: 'Print receipt' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/orders/${ids.order}/receipt`));
  });

  it('is offered on a partially paid order', async () => {
    as(everything);
    serve(partial);
    renderRoute(<App />, `/orders/${ids.order}`);
    expect(await screen.findByRole('button', { name: 'Print receipt' })).toBeInTheDocument();
  });

  it.each([
    ['an unpaid order', finalized()],
    ['a draft', order()],
  ])('is not offered on %s', async (_name, current) => {
    as(everything);
    serve(current);
    renderRoute(<App />, `/orders/${ids.order}`);
    await screen.findByRole('heading', { name: 'O-2026-000001' });
    expect(screen.queryByRole('button', { name: 'Print receipt' })).not.toBeInTheDocument();
  });

  it('is not offered without the permission to read payments', async () => {
    as(everything.filter((permission) => permission !== PermissionId.paymentsread));
    serve(full);
    renderRoute(<App />, `/orders/${ids.order}`);
    await screen.findByRole('heading', { name: 'O-2026-000001' });
    expect(screen.queryByRole('button', { name: 'Print receipt' })).not.toBeInTheDocument();
  });

  it('is offered on the payment and opens the receipt of that payment', async () => {
    as(everything);
    serve(full);
    const user = userEvent.setup();
    const { router } = renderRoute(<App />, `/payments/${ids.payment}`);
    await user.click(await screen.findByRole('button', { name: 'Print receipt' }));
    await waitFor(() =>
      expect(router.state.location.pathname + router.state.location.search).toBe(
        `/orders/${ids.order}/receipt?payment=${ids.payment}`,
      ),
    );
  });

  it('is not offered on a refund line', async () => {
    as(everything);
    const refund = receipt({
      id: 'r1',
      reference: 'P-2026-000002',
      entryKind: 'reversal',
      reversesPaymentId: ids.payment,
      reversedPaymentReference: 'P-2026-000001',
      reasonKind: 'refund',
      reason: 'Back',
      allocations: [{ ...cashShare, paymentId: 'r1', amount: '-4.00' }],
    });
    serve(partial, [refund, receipt({ allocations: [cashShare] })]);
    renderRoute(<App />, '/payments/r1');
    await screen.findByRole('heading', { name: 'P-2026-000002' });
    expect(screen.queryByRole('button', { name: 'Print receipt' })).not.toBeInTheDocument();
  });
});

describe('receipt page', () => {
  it('lists items, payments and what is outstanding, without a receipt number of its own', async () => {
    as(everything);
    serve(partial, [
      receipt({
        amount: '4.00',
        method: 'card',
        externalSource: 'Terminal 1',
        externalReference: 'c-1',
        allocations: [cashShare],
      }),
    ]);
    renderRoute(<App />, `/orders/${ids.order}/receipt`);
    const article = await screen.findByRole('article', { name: 'Receipt for O-2026-000001' });
    expect(within(article).getByText('Example institute')).toBeInTheDocument();
    const items = within(article).getByRole('table', { name: 'Items' });
    expect(within(items).getByText('Machine service')).toBeInTheDocument();
    expect(within(items).getAllByText('€10.00').length).toBeGreaterThan(0);
    const payments = await within(article).findByRole('table', { name: 'Payments' });
    expect(await within(payments).findByText('Card')).toBeInTheDocument();
    expect(within(payments).getByText('P-2026-000001')).toBeInTheDocument();
    expect(within(payments).getByText('Outstanding')).toBeInTheDocument();
    expect(within(payments).getByText('€6.00')).toBeInTheDocument();
    expect(within(article).getByText(/not an invoice/)).toBeInTheDocument();
    expect(within(article).queryByText(/Receipt no/i)).not.toBeInTheDocument();
  });

  it('shows no outstanding line for a paid order and prints through the browser', async () => {
    as(everything);
    serve(full);
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    const user = userEvent.setup();
    renderRoute(<App />, `/orders/${ids.order}/receipt`);
    const article = await screen.findByRole('article', { name: 'Receipt for O-2026-000001' });
    expect(await within(article).findByText('Cash')).toBeInTheDocument();
    expect(within(article).queryByText('Outstanding')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Print' }));
    expect(print).toHaveBeenCalledOnce();
  });

  it('notes an invoice issued through wiRef', async () => {
    as(everything);
    serve(full, [
      receipt({
        method: 'external',
        externalSource: 'wiRef',
        externalReference: 'W-2026-000001',
        allocations: full.allocations,
      }),
    ]);
    renderRoute(<App />, `/orders/${ids.order}/receipt`);
    expect(await screen.findByText(/Settled by the wiRef invoice request W-2026-000001/)).toBeInTheDocument();
  });

  it('restricts the receipt to one payment when asked', async () => {
    as(everything);
    const second = allocation('a2', 'pay-2', 'P-2026-000002', '3.00');
    const both = finalized({
      settlementState: 'partially_paid',
      settledAmount: '7.00',
      outstandingAmount: '3.00',
      allocations: [cashShare, second],
    });
    serve(both, [
      receipt({ amount: '4.00', allocations: [cashShare] }),
      receipt({ id: 'pay-2', reference: 'P-2026-000002', amount: '3.00', allocations: [second] }),
    ]);
    renderRoute(<App />, `/orders/${ids.order}/receipt?payment=pay-2`);
    const payments = await screen.findByRole('table', { name: 'Payments' });
    expect(within(payments).getByText('P-2026-000002')).toBeInTheDocument();
    expect(within(payments).queryByText('P-2026-000001')).not.toBeInTheDocument();
  });

  it('has no receipt for an order without payments', async () => {
    as(everything);
    serve(finalized());
    renderRoute(<App />, `/orders/${ids.order}/receipt`);
    expect(await screen.findByText('No receipt available')).toBeInTheDocument();
  });

  it('needs the permission to read payments', async () => {
    as(everything.filter((permission) => permission !== PermissionId.paymentsread));
    serve(full);
    renderRoute(<App />, `/orders/${ids.order}/receipt`);
    await waitFor(() => expect(screen.queryByRole('article')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Print' })).not.toBeInTheDocument();
  });
});
