import { http, HttpResponse } from 'msw';
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { as, everything, finalized, ids, orderList, receipt } from './testData';

vi.mock('@carbon/charts-react', () => ({ LineChart: () => <div />, SimpleBarChart: () => <div /> }));

const submitted = finalized({ activeExternalRequestId: ids.request, activeExternalRequestReference: 'W-2026-000001', activeExternalRequestState: 'submitted' });
const unpaid = finalized({ id: 'u1', reference: 'O-2026-000020', customerName: 'Unpaid customer', outstandingAmount: '25.00', netCharge: '25.00', totalAmount: '25.00' });

function serve() {
  orderList([submitted, unpaid]);
  server.use(
    http.get('*/api/v1/payments', () => HttpResponse.json({ items: [receipt({ amount: '12.00' })], page: 1, pageSize: 100, total: 1 })),
    http.get('*/api/v1/payments/cash-register', () => HttpResponse.json({ receipts: '12.00', refunds: '0.00', withdrawals: '0.00', deposits: '0.00', expected: '12.00', to: null })),
    http.get('*/api/v1/machine-logbook/work-items', () => HttpResponse.json({
      items: [
        { kind: 'job', id: 'j1', displayId: 'J-1', runCount: 1, machineId: 'm', machineName: 'Laser', customer: { kind: 'person', id: 'p1', displayName: 'Ada', pricingGroupAssignmentVersion: 0 }, status: 'successful', source: 'manual', startedAt: '2026-10-01T10:00:00Z', endsAt: '2026-10-01T11:00:00Z', effectivePrice: '7.50', version: 1 },
        { kind: 'job', id: 'j2', displayId: 'J-2', runCount: 1, machineId: 'm', machineName: 'Laser', customer: { kind: 'person', id: 'p1', displayName: 'Ada', pricingGroupAssignmentVersion: 0 }, status: 'successful', source: 'manual', startedAt: '2026-10-02T10:00:00Z', endsAt: '2026-10-02T11:00:00Z', effectivePrice: '2.50', version: 1 },
      ], page: 1, pageSize: 100, total: 2,
    })),
  );
}

describe('sales overview', () => {
  it('shows the tiles with links that set the matching filters', async () => {
    as([...everything, PermissionId.external_invoice_requestsapprove]);
    serve();
    renderRoute(<App />, '/sales');
    const figures = await screen.findByRole('region', { name: 'Key figures' });
    expect((await within(figures).findAllByText('€12.00')).length).toBeGreaterThan(0);
    const link = (name: RegExp) => within(figures).getByRole('link', { name });
    expect(link(/Cash in register/)).toHaveAttribute('href', '/payments');
    expect(link(/Takings today/)).toHaveAttribute('href', '/payments');
    expect(link(/Awaiting payment/)).toHaveAttribute('href', '/orders?status=awaiting');
    expect(link(/Invoices to approve/)).toHaveAttribute('href', '/orders?invoice=submitted');
    const ready = link(/Jobs ready to bill/);
    expect(ready).toHaveAttribute('href', '/orders?review=1');
    expect(await within(ready).findByText('2')).toBeInTheDocument();
    expect(within(ready).getByText(/€10\.00 · 1 customer/)).toBeInTheDocument();
    expect(await screen.findByText('To approve')).toBeInTheDocument();
  });

  it('hides tiles the person has no permission for', async () => {
    as([PermissionId.paymentsread]);
    serve();
    renderRoute(<App />, '/sales');
    const figures = await screen.findByRole('region', { name: 'Key figures' });
    expect(within(figures).getByRole('link', { name: /Takings today/ })).toBeInTheDocument();
    expect(within(figures).queryByRole('link', { name: /Cash in register/ })).not.toBeInTheDocument();
    expect(within(figures).queryByRole('link', { name: /Awaiting payment/ })).not.toBeInTheDocument();
    expect(within(figures).queryByRole('link', { name: /Invoices to approve/ })).not.toBeInTheDocument();
    expect(within(figures).queryByRole('link', { name: /Jobs ready to bill/ })).not.toBeInTheDocument();
  });

  it('only approvers get the invoices-to-approve tile', async () => {
    as(everything);
    serve();
    renderRoute(<App />, '/sales');
    const figures = await screen.findByRole('region', { name: 'Key figures' });
    await within(figures).findByRole('link', { name: /Awaiting payment/ });
    expect(within(figures).queryByRole('link', { name: /Invoices to approve/ })).not.toBeInTheDocument();
  });
});
