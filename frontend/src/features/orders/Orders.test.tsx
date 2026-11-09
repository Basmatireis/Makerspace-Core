import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { as, everything, finalized, ids, order, orderList, paid } from './testData';

vi.mock('@carbon/charts-react', () => ({ LineChart: () => <div />, SimpleBarChart: () => <div /> }));

const draft = order({ id: 'd1', reference: 'O-2026-000010', customerName: 'Draft customer' });
const awaiting = finalized({
  id: 'a1',
  reference: 'O-2026-000011',
  customerName: 'Awaiting customer',
  customerKind: 'person',
  customer: { kind: 'person', id: 'p1' },
});
const submitted = finalized({
  id: 's1',
  reference: 'O-2026-000012',
  customerName: 'Invoice customer',
  activeExternalRequestId: ids.request,
  activeExternalRequestReference: 'W-1',
  activeExternalRequestState: 'submitted',
});
const done = paid({ id: 'p1', reference: 'O-2026-000013', customerName: 'Paid customer' });
const cancelled = order({
  id: 'c1',
  reference: 'O-2026-000014',
  status: 'cancelled',
  customerName: 'Cancelled customer',
});
const reinvoice = finalized({
  id: 'r1',
  reference: 'O-2026-000015',
  customerName: 'Cancelled invoice customer',
  latestExternalRequestId: ids.request,
  latestExternalRequestReference: 'W-1',
  latestExternalRequestState: 'cancelled',
});
const all = [draft, awaiting, submitted, done, cancelled];
const rows = () =>
  within(screen.getByRole('table', { name: 'Orders' }))
    .getAllByRole('row')
    .slice(1)
    .map((row) => row.textContent ?? '');

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

  it('filters orders whose latest invoice request was cancelled', async () => {
    as(everything);
    orderList([...all, reinvoice]);
    renderRoute(<App />, '/orders?invoice=cancelled');
    await screen.findByRole('table', { name: 'Orders' });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain('Cancelled invoice customer');
    expect(rows()[0]).toContain('Cancelled');
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

  it('searches the invoice request reference and the status label, not only reference and customer', async () => {
    as(everything);
    orderList(all);
    const user = userEvent.setup();
    renderRoute(<App />, '/orders');
    await screen.findByRole('table', { name: 'Orders' });
    const search = screen.getByLabelText('Search orders', { selector: 'input' });
    await user.type(search, 'W-1');
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toContain('O-2026-000012');
    await user.clear(search);
    await user.type(search, 'awaiting payment');
    await waitFor(() => expect(rows()).not.toHaveLength(3));
    expect(rows().join(' ')).toContain('O-2026-000011');
    expect(rows().join(' ')).not.toContain('O-2026-000010');
  });

  it('offers the review of billable jobs with their value and opens it from the URL', async () => {
    as(everything);
    orderList([]);
    server.use(
      http.get('*/api/v1/machine-logbook/work-items', () =>
        HttpResponse.json({
          items: [
            {
              kind: 'job',
              id: 'j1',
              displayId: 'J-2026-000001',
              title: 'Gear',
              runCount: 1,
              machineId: 'm',
              machineName: 'Laser',
              customer: { kind: 'person', id: 'p1', displayName: 'Ada Lovelace', pricingGroupAssignmentVersion: 0 },
              status: 'successful',
              source: 'manual',
              startedAt: '2026-10-01T10:00:00Z',
              endsAt: '2026-10-01T11:00:00Z',
              effectivePrice: '12.50',
              billing: { state: 'not_on_order' },
              version: 4,
            },
          ],
          page: 1,
          pageSize: 100,
          total: 1,
        }),
      ),
    );
    renderRoute(<App />, '/orders?review=1');
    expect(await screen.findByRole('button', { name: 'Review jobs (1)' })).toBeInTheDocument();
    const dialog = await screen.findByRole('dialog', { name: 'Jobs ready to bill' });
    expect(await within(dialog).findByText('Ada Lovelace')).toBeInTheDocument();
    expect(within(dialog).getAllByText('€12.50').length).toBeGreaterThan(0);
  });

  it('searches the job numbers and machine names of the jobs ready to bill', async () => {
    as(everything);
    orderList([]);
    const job = (n: number, machineName: string, customer: string) => ({
      kind: 'job',
      id: `j${n}`,
      displayId: `J-2026-00000${n}`,
      title: `Part ${n}`,
      runCount: 1,
      machineId: `m${n}`,
      machineName,
      customer: { kind: 'person', id: `p${n}`, displayName: customer, pricingGroupAssignmentVersion: 0 },
      status: 'successful',
      source: 'manual',
      startedAt: '2026-10-01T10:00:00Z',
      endsAt: '2026-10-01T11:00:00Z',
      effectivePrice: '12.50',
      billing: { state: 'not_on_order' },
      version: 4,
    });
    server.use(
      http.get('*/api/v1/machine-logbook/work-items', () =>
        HttpResponse.json({
          items: [job(1, 'Laser', 'Ada Lovelace'), job(2, 'Prusa', 'Grace Hopper')],
          page: 1,
          pageSize: 100,
          total: 2,
        }),
      ),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/orders?review=1');
    const dialog = await screen.findByRole('dialog', { name: 'Jobs ready to bill' });
    expect(await within(dialog).findByText('Grace Hopper')).toBeInTheDocument();
    const search = within(dialog).getByLabelText('Search customers and jobs', { selector: 'input' });
    await user.type(search, 'prusa');
    await waitFor(() => expect(within(dialog).queryByText('Ada Lovelace')).not.toBeInTheDocument());
    expect(within(dialog).getByText('Grace Hopper')).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, 'J-2026-000001');
    await waitFor(() => expect(within(dialog).queryByText('Grace Hopper')).not.toBeInTheDocument());
    expect(within(dialog).getByText('Ada Lovelace')).toBeInTheDocument();
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

describe('orders list with the detail panel', () => {
  const originalMatchMedia = window.matchMedia;
  const wide = (matches: boolean) => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: matches && query === '(min-width: 66rem)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
  };
  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });
  /** A Carbon icon button or attention flag, found through the tooltip that labels it. */
  const byTooltip = (text: string) => {
    const label = screen.getByText(text).closest('[id]')!;
    return document.querySelector<HTMLElement>(`[aria-labelledby="${label.id}"]`)!;
  };
  const overdue = finalized({
    ...awaiting,
    attention: [{ code: 'balance_overdue', message: 'The balance has been open for 21 days.' }],
  });

  it('flags orders that need attention at the end of the row, before the row menu', async () => {
    wide(false);
    as(everything);
    orderList([overdue, draft]);
    renderRoute(<App />, '/orders');
    const row = (await screen.findByText('O-2026-000011')).closest('tr')!;
    const flag = byTooltip('The balance has been open for 21 days.');
    expect(row.lastElementChild!.previousElementSibling).toContainElement(flag);
    expect(row.lastElementChild).toContainElement(byTooltip('Actions for O-2026-000011'));
  });

  it('selects a row into the panel on wide screens and keeps it in the URL', async () => {
    wide(true);
    as(everything);
    orderList([overdue, draft]);
    const user = userEvent.setup();
    const { router } = renderRoute(<App />, '/orders');
    const panel = await screen.findByRole('complementary', { name: 'Order details' });
    expect(within(panel).getByText('Select an order to see its items, payments and invoice.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'O-2026-000011' }));
    await waitFor(() => expect(router.state.location.search).toContain(`order=${overdue.id}`));
    expect(within(panel).getByRole('heading', { name: 'Awaiting customer' })).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'Open order' })).toHaveAttribute('href', `/orders/${overdue.id}`);
    expect(within(panel).getByRole('table', { name: 'Items of the selected order' })).toHaveTextContent(
      'Machine service',
    );
    await user.click(byTooltip('Close panel'));
    await waitFor(() => expect(router.state.location.search).not.toContain('order='));
  });

  it('opens the order page from a row on narrow screens', async () => {
    wide(false);
    as(everything);
    orderList([overdue]);
    renderRoute(<App />, '/orders');
    expect(await screen.findByRole('link', { name: 'O-2026-000011' })).toHaveAttribute('href', `/orders/${overdue.id}`);
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });
});

describe('orders list: needs attention', () => {
  const now = new Date().toISOString();
  const fresh = order({ id: 'f1', reference: 'O-2026-000020', customerName: 'Fresh draft', createdAt: now });
  const old = order({ id: 'o1', reference: 'O-2026-000021', customerName: 'Old draft customer' });
  const overdue = finalized({
    id: 'b1',
    reference: 'O-2026-000022',
    customerName: 'Overdue customer',
    createdAt: now,
    attention: [{ code: 'balance_overdue', message: 'The balance has been open for 21 days.' }],
  });
  const changedJob = finalized({
    id: 'c2',
    reference: 'O-2026-000023',
    customerName: 'Changed customer',
    createdAt: now,
    attention: [{ code: 'source_changed', message: 'A job changed after it was charged.' }],
  });
  const approval = finalized({
    id: 'i1',
    reference: 'O-2026-000024',
    customerName: 'Approval customer',
    createdAt: now,
    attention: [{ code: 'invoice_request_open', message: 'The invoice request W-1 awaits approval.' }],
  });
  const partly = finalized({
    id: 'pp',
    reference: 'O-2026-000025',
    customerName: 'Partly customer',
    createdAt: now,
    settlementState: 'partially_paid',
    settledAmount: '4.00',
    outstandingAmount: '6.00',
  });
  const settled = paid({ id: 'pd', reference: 'O-2026-000026', customerName: 'Paid customer', createdAt: now });
  const attentionOrders = [fresh, old, overdue, changedJob, approval, partly, settled];
  const readyJob = {
    kind: 'job',
    id: 'j1',
    displayId: 'J-2026-000001',
    title: 'Gear',
    runCount: 1,
    machineId: 'm',
    machineName: 'Laser',
    customer: { kind: 'person', id: 'p1', displayName: 'Ada Lovelace', pricingGroupAssignmentVersion: 0 },
    status: 'successful',
    source: 'manual',
    startedAt: '2026-10-01T10:00:00Z',
    endsAt: '2026-10-01T11:00:00Z',
    effectivePrice: '12.50',
    billing: { state: 'not_on_order' },
    version: 4,
  };
  const serveJobs = (items: object[]) =>
    server.use(
      http.get('*/api/v1/machine-logbook/work-items', () =>
        HttpResponse.json({ items, page: 1, pageSize: 100, total: items.length }),
      ),
    );

  it('lists the API reasons, partly paid orders and old drafts in their own tab with a count', async () => {
    as(everything);
    orderList(attentionOrders);
    serveJobs([]);
    const user = userEvent.setup();
    const { router } = renderRoute(<App />, '/orders');
    await user.click(await screen.findByRole('tab', { name: 'Needs attention (5)' }));
    await waitFor(() => expect(router.state.location.search).toContain('section=attention'));
    const listed = rows().join(' ');
    for (const reference of ['O-2026-000021', 'O-2026-000022', 'O-2026-000023', 'O-2026-000024', 'O-2026-000025'])
      expect(listed).toContain(reference);
    expect(listed).not.toContain('O-2026-000020');
    expect(listed).not.toContain('O-2026-000026');
    expect(screen.getByText(/Partly paid: €6\.00 still open\./)).toBeInTheDocument();
  });

  it('narrows the tab by reason through the Needs attention filter', async () => {
    as(everything);
    orderList(attentionOrders);
    serveJobs([]);
    const user = userEvent.setup();
    const { router } = renderRoute(<App />, '/orders?section=attention');
    await screen.findByRole('table', { name: 'Orders' });
    await user.click(screen.getByLabelText('Filters', { selector: 'button' }));
    for (const name of [
      /^Outstanding for over two weeks \(1\)/,
      /^Changed since billed \(1\)/,
      /^Invoice awaits approval \(1\)/,
      /^Partly paid \(1\)/,
      /^Old draft \(1\)/,
    ])
      expect(screen.getByRole('checkbox', { name })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Customer' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /^Old draft/ }));
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    await waitFor(() => expect(router.state.location.search).toContain('attention=old_draft'));
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain('O-2026-000021');
  });

  it('says so when nothing needs attention', async () => {
    as(everything);
    orderList([fresh, settled]);
    serveJobs([]);
    renderRoute(<App />, '/orders?section=attention');
    expect(await screen.findByText('Nothing needs attention right now.')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Needs attention (0)' })).toBeInTheDocument();
  });

  it('names the finished jobs without an order only in this tab and opens their review', async () => {
    as(everything);
    orderList(attentionOrders);
    serveJobs([readyJob]);
    const user = userEvent.setup();
    renderRoute(<App />, '/orders');
    await screen.findByRole('button', { name: 'Review jobs (1)' });
    expect(screen.queryByText('1 finished job is not on an order')).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /^Needs attention/ }));
    expect(await screen.findByText('1 finished job is not on an order')).toBeInTheDocument();
    expect(screen.getByText(/J-2026-000001 · €12\.50 ready to bill\./)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Review jobs' }));
    expect(await screen.findByRole('dialog', { name: 'Jobs ready to bill' })).toBeInTheDocument();
  });
});

describe('orders list: row actions', () => {
  it('offers the draft actions and cancels a draft after confirmation', async () => {
    as(everything);
    orderList([draft]);
    let body: Record<string, unknown> | undefined;
    server.use(
      http.post(`*/api/v1/orders/${draft.id}/cancel`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...draft, status: 'cancelled' });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/orders');
    const row = (await screen.findByText('O-2026-000010')).closest('tr')!;
    await user.click(row.querySelector<HTMLButtonElement>('.cds--overflow-menu')!);
    expect(await screen.findByText('Edit customer')).toBeInTheDocument();
    expect(screen.queryByText('Create replacement draft')).not.toBeInTheDocument();
    await user.click(screen.getByText('Cancel draft'));
    expect(await screen.findByText('Cancel this draft?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel draft' }));
    await waitFor(() => expect(body).toMatchObject({ expectedVersion: draft.version }));
    expect(body?.operationKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('offers the replacement draft and the correction for a finalized order', async () => {
    as(everything);
    orderList([awaiting]);
    let replaced = false;
    server.use(
      http.post(`*/api/v1/orders/${awaiting.id}/replacements`, () => {
        replaced = true;
        return HttpResponse.json(order({ id: 'n1', reference: 'O-2026-000030', replacesOrderId: awaiting.id }));
      }),
    );
    const user = userEvent.setup();
    const { router } = renderRoute(<App />, '/orders');
    const row = (await screen.findByText('O-2026-000011')).closest('tr')!;
    await user.click(row.querySelector<HTMLButtonElement>('.cds--overflow-menu')!);
    expect(await screen.findByText('Correct order…')).toBeInTheDocument();
    expect(screen.queryByText('Cancel draft')).not.toBeInTheDocument();
    await user.click(screen.getByText('Create replacement draft'));
    await waitFor(() => expect(replaced).toBe(true));
    await waitFor(() => expect(router.state.location.pathname).toBe('/orders/n1'));
  });

  it('has no row menu without the permissions', async () => {
    as([PermissionId.ordersread]);
    orderList([draft, awaiting]);
    renderRoute(<App />, '/orders');
    const row = (await screen.findByText('O-2026-000010')).closest('tr')!;
    expect(row.lastElementChild).toBeEmptyDOMElement();
  });
});
