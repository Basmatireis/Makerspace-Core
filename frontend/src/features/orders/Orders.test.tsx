import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { as, everything, finalized, ids, order, orderList, paid } from './testData';

vi.mock('@carbon/charts-react', () => ({ LineChart: () => <div />, SimpleBarChart: () => <div /> }));

const draft = order({ id: 'd1', reference: 'O-2026-000010', customerName: 'Draft customer' });
const awaiting = finalized({ id: 'a1', reference: 'O-2026-000011', customerName: 'Awaiting customer', customerKind: 'person', customer: { kind: 'person', id: 'p1' } });
const submitted = finalized({ id: 's1', reference: 'O-2026-000012', customerName: 'Invoice customer', activeExternalRequestId: ids.request, activeExternalRequestReference: 'W-1', activeExternalRequestState: 'submitted' });
const done = paid({ id: 'p1', reference: 'O-2026-000013', customerName: 'Paid customer' });
const cancelled = order({ id: 'c1', reference: 'O-2026-000014', status: 'cancelled', customerName: 'Cancelled customer' });
const all = [draft, awaiting, submitted, done, cancelled];
const rows = () => within(screen.getByRole('table', { name: 'Orders' })).getAllByRole('row').slice(1).map((row) => row.textContent ?? '');

describe('orders list', () => {
  it('shows the open section by default with counts and switches sections through the URL', async () => {
    as(everything);
    orderList(all);
    const user = userEvent.setup();
    const { router } = renderRoute(<App />, '/orders');
    expect(await screen.findByRole('tab', { name: 'Open (3)' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Paid (1)' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Cancelled (1)' })).toBeInTheDocument();
    expect(rows()).toHaveLength(3);
    await user.click(screen.getByRole('tab', { name: 'Cancelled (1)' }));
    await waitFor(() => expect(router.state.location.search).toContain('section=cancelled'));
    expect(rows().join(' ')).toContain('O-2026-000014');
    expect(rows()).toHaveLength(1);
  });

  it('reads the section and status from the URL', async () => {
    as(everything);
    orderList(all);
    renderRoute(<App />, '/orders?section=paid');
    await screen.findByRole('table', { name: 'Orders' });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain('O-2026-000013');
  });

  it('applies the awaiting-payment status preset of the overview', async () => {
    as(everything);
    orderList(all);
    renderRoute(<App />, '/orders?status=awaiting');
    await screen.findByRole('table', { name: 'Orders' });
    expect(rows().join(' ')).toContain('O-2026-000011');
    expect(rows().join(' ')).toContain('O-2026-000012');
    expect(rows().join(' ')).not.toContain('O-2026-000010');
  });

  it('lands on the section that has orders with the requested invoice state', async () => {
    as(everything);
    orderList(all);
    renderRoute(<App />, '/orders?invoice=submitted');
    await screen.findByRole('table', { name: 'Orders' });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain('Awaiting approval');
  });

  it('filters by invoice state and customer type through the filter panel', async () => {
    as(everything);
    orderList(all);
    const user = userEvent.setup();
    const { router } = renderRoute(<App />, '/orders');
    await screen.findByRole('table', { name: 'Orders' });
    await user.click(screen.getByLabelText('Filters', { selector: 'button' }));
    await user.click(screen.getByRole('checkbox', { name: /^Person/ }));
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    await waitFor(() => expect(router.state.location.search).toContain('type=person'));
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain('Awaiting customer');
  });

  it('offers the review of billable jobs with their value and opens it from the URL', async () => {
    as(everything);
    orderList([]);
    server.use(http.get('*/api/v1/machine-logbook/work-items', () => HttpResponse.json({
      items: [{ kind: 'job', id: 'j1', displayId: 'J-2026-000001', title: 'Gear', runCount: 1, machineId: 'm', machineName: 'Laser', customer: { kind: 'person', id: 'p1', displayName: 'Ada Lovelace', pricingGroupAssignmentVersion: 0 }, status: 'successful', source: 'manual', startedAt: '2026-10-01T10:00:00Z', endsAt: '2026-10-01T11:00:00Z', effectivePrice: '12.50', billing: { state: 'not_on_order' }, version: 4 }],
      page: 1, pageSize: 100, total: 1,
    })));
    renderRoute(<App />, '/orders?review=1');
    expect(await screen.findByRole('button', { name: 'Review jobs (1)' })).toBeInTheDocument();
    const dialog = await screen.findByRole('dialog', { name: 'Jobs ready to bill' });
    expect(await within(dialog).findByText('Ada Lovelace')).toBeInTheDocument();
    expect(within(dialog).getAllByText('€12.50').length).toBeGreaterThan(0);
  });

  it('hides the write actions without the permission', async () => {
    as([PermissionId.ordersread]);
    orderList(all);
    renderRoute(<App />, '/orders');
    await screen.findByRole('table', { name: 'Orders' });
    expect(screen.queryByRole('button', { name: 'New order' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Review jobs/ })).not.toBeInTheDocument();
  });

  it('redirects the former external invoicing page', async () => {
    as(everything);
    orderList(all);
    const { router } = renderRoute(<App />, '/external-invoicing');
    await waitFor(() => expect(router.state.location.pathname).toBe('/orders'));
    expect(router.state.location.search).toBe('?invoice=draft,submitted');
  });
});
