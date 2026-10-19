import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { as, everything, finalized, ids, invoiceRequest, order, paid } from './testData';

vi.mock('@carbon/charts-react', () => ({ LineChart: () => <div />, SimpleBarChart: () => <div /> }));

const approve = [...everything, PermissionId.external_invoice_requestsapprove];
const awaitingApproval = finalized({ activeExternalRequestId: ids.request, activeExternalRequestReference: 'W-2026-000001', activeExternalRequestState: 'submitted' });

function serve(current: ReturnType<typeof order>, request = invoiceRequest()) {
  server.use(
    http.get(`*/api/v1/orders/${current.id}`, () => HttpResponse.json(current)),
    http.get(`*/api/v1/external-invoice-requests/${ids.request}`, () => HttpResponse.json(request)),
    http.get('*/api/v1/orders', () => HttpResponse.json({ items: [current], page: 1, pageSize: 100, total: 1 })),
    http.get('*/api/v1/organizations/:id/invoicing-requirements', () => HttpResponse.json({ requirePurchaseOrderReference: false, version: 1 })),
  );
}

describe('order detail: payments', () => {
  it('records a card payment with terminal evidence and the current version', async () => {
    as(everything);
    serve(finalized());
    let body: Record<string, unknown> | undefined;
    server.use(http.post(`*/api/v1/orders/${ids.order}/payments`, async ({ request }) => { body = await request.json() as Record<string, unknown>; return HttpResponse.json(paid({ version: 3 })); }));
    const user = userEvent.setup();
    renderRoute(<App />, `/orders/${ids.order}`);
    await user.click(await screen.findByRole('button', { name: 'Record payment' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('radio', { name: /Card/ }));
    await user.type(within(dialog).getByLabelText('Terminal or provider'), 'Terminal 1');
    await user.type(within(dialog).getByLabelText('Terminal transaction reference'), 'card-123');
    await user.click(within(dialog).getByRole('button', { name: 'Record payment' }));
    await waitFor(() => expect(body).toMatchObject({ expectedVersion: 2, payment: { method: 'card', amount: '10.00', externalSource: 'Terminal 1', externalReference: 'card-123' } }));
    expect(body?.operationKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('requires the terminal evidence for card payments', async () => {
    as(everything);
    serve(finalized());
    const user = userEvent.setup();
    renderRoute(<App />, `/orders/${ids.order}`);
    await user.click(await screen.findByRole('button', { name: 'Record payment' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('radio', { name: /Card/ }));
    expect(within(dialog).getByRole('button', { name: 'Record payment' })).toBeDisabled();
    expect(within(dialog).getByText('Enter the reference from the terminal slip')).toBeInTheDocument();
  });

  it('offers the invoice as a payment choice that opens the invoice request without recording anything', async () => {
    as(everything);
    serve(finalized());
    let recorded = false;
    server.use(http.post(`*/api/v1/orders/${ids.order}/payments`, () => { recorded = true; return HttpResponse.json(finalized()); }));
    const user = userEvent.setup();
    renderRoute(<App />, `/orders/${ids.order}`);
    await user.click(await screen.findByRole('button', { name: 'Record payment' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('radio', { name: /Invoice/ }));
    expect(within(dialog).getByText('No payment now.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Request invoice' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(recorded).toBe(false);
  });

  it('finalizes and takes payment in one step for a draft', async () => {
    as(everything);
    serve(order());
    let body: Record<string, unknown> | undefined;
    server.use(http.post(`*/api/v1/orders/${ids.order}/checkout`, async ({ request }) => { body = await request.json() as Record<string, unknown>; return HttpResponse.json(paid()); }));
    const user = userEvent.setup();
    renderRoute(<App />, `/orders/${ids.order}`);
    expect(screen.queryByRole('button', { name: /without payment/i })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Finalize and take payment' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Finalize and record payment' }));
    await waitFor(() => expect(body).toMatchObject({ expectedVersion: 2, payments: [{ method: 'cash', amount: '10.00' }] }));
  });

  it('pauses payments inside the table while an invoice awaits approval', async () => {
    as(everything);
    serve(awaitingApproval);
    renderRoute(<App />, `/orders/${ids.order}`);
    const table = await screen.findByRole('table', { name: 'Payments' });
    expect(within(table).getByText('Payments paused')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record payment' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View invoice' })).toBeInTheDocument();
  });
});

describe('order detail: invoice approval', () => {
  it('lets an approver copy the data and mark the request as forwarded', async () => {
    as(approve);
    serve(awaitingApproval, invoiceRequest({ itemSummary: [{ id: ids.item, position: 1, kind: 'manual', description: 'Laser', quantity: '1', unit: 'job', unitPrice: '10', amount: '10.00', sourceChanged: false, createdAt: '2026-10-06T10:00:00Z' }] }));
    let body: Record<string, unknown> | undefined;
    server.use(http.post(`*/api/v1/external-invoice-requests/${ids.request}/forward`, async ({ request }) => { body = await request.json() as Record<string, unknown>; return HttpResponse.json(invoiceRequest({ state: 'issued' }), { status: 201 }); }));
    const user = userEvent.setup();
    renderRoute(<App />, `/orders/${ids.order}`);
    await user.click(await screen.findByRole('button', { name: 'Copy for wiRef' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Recipient: Example institute/)).toBeInTheDocument();
    expect(within(dialog).getByText(/1\. Laser/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Mark as forwarded to wiRef' }));
    await waitFor(() => expect(body).toMatchObject({ expectedVersion: 3 }));
  });

  it('returns a request for correction only with a comment', async () => {
    as(approve);
    serve(awaitingApproval);
    let body: Record<string, unknown> | undefined;
    server.use(http.post(`*/api/v1/external-invoice-requests/${ids.request}/return`, async ({ request }) => { body = await request.json() as Record<string, unknown>; return HttpResponse.json(invoiceRequest({ state: 'draft' }), { status: 201 }); }));
    const user = userEvent.setup();
    renderRoute(<App />, `/orders/${ids.order}`);
    await user.click(await screen.findByRole('button', { name: 'Return for correction' }));
    const dialog = await screen.findByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: 'Return for correction' });
    expect(submit).toBeDisabled();
    await user.type(within(dialog).getByLabelText('What has to be corrected?'), 'Fix the address');
    await user.click(submit);
    await waitFor(() => expect(body).toMatchObject({ reason: 'Fix the address', expectedVersion: 3 }));
  });

  it('shows the read-only waiting state without the approve permission', async () => {
    as(everything);
    serve(awaitingApproval);
    renderRoute(<App />, `/orders/${ids.order}`);
    expect(await screen.findByText('Waiting for approval')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy for wiRef' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Return for correction' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit for approval' })).not.toBeInTheDocument();
  });

  it('shows the returned comment and lets staff submit a complete draft again', async () => {
    as(everything);
    const draftRequest = invoiceRequest({ state: 'draft', events: [{ id: 'e1', kind: 'returned', externalReference: '', reconciliationKind: '', reason: 'Fix the address', effectiveAt: '2026-10-06T10:00:00Z', recordedAt: '2026-10-06T10:00:00Z', recordedBy: { id: 'x', displayName: 'Manager' } }] });
    serve(finalized({ activeExternalRequestId: ids.request, activeExternalRequestReference: 'W-2026-000001', activeExternalRequestState: 'draft' }), draftRequest);
    let submitted = false;
    server.use(http.post(`*/api/v1/external-invoice-requests/${ids.request}/submit`, () => { submitted = true; return HttpResponse.json(invoiceRequest(), { status: 201 }); }));
    const user = userEvent.setup();
    renderRoute(<App />, `/orders/${ids.order}`);
    expect((await screen.findAllByText('Returned for correction')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Fix the address').length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Submit for approval' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Submit for approval' }));
    await waitFor(() => expect(submitted).toBe(true));
  });

  it('says that an issued invoice makes the order paid', async () => {
    as(everything);
    serve(paid({ activeExternalRequestId: ids.request, activeExternalRequestReference: 'W-2026-000001', activeExternalRequestState: 'issued', status: 'finalized' }), invoiceRequest({ state: 'issued' }));
    renderRoute(<App />, `/orders/${ids.order}`);
    expect(await screen.findByText('Issued, the order is paid')).toBeInTheDocument();
    expect(screen.queryByText('Payments paused')).not.toBeInTheDocument();
  });

  it('does not load private recipient details without the read permission', async () => {
    as([PermissionId.ordersread]);
    let loaded = false;
    serve(awaitingApproval);
    server.use(http.get(`*/api/v1/external-invoice-requests/${ids.request}`, () => { loaded = true; return HttpResponse.json(invoiceRequest()); }));
    renderRoute(<App />, `/orders/${ids.order}`);
    expect(await screen.findByText(/Recipient details need the permission/)).toBeInTheDocument();
    expect(loaded).toBe(false);
  });
});

describe('order detail: cancelled invoice requests', () => {
  const second = '01995ea6-6d00-7000-8000-000000000204';
  const cancelledRequest = invoiceRequest({
    state: 'cancelled', supersedesRequestId: second,
    events: [{ id: 'e9', kind: 'cancelled', externalReference: 'GS-77', reconciliationKind: 'credit_note', reason: 'Wrong recipient', effectiveAt: '2026-10-06T10:00:00Z', recordedAt: '2026-10-06T10:00:00Z', recordedBy: { id: 'x', displayName: 'Manager' } }],
  });
  const earlierRequest = invoiceRequest({ id: second, reference: 'W-2026-000000', state: 'cancelled', events: [] });
  const afterCancellation = finalized({ latestExternalRequestId: ids.request, latestExternalRequestReference: 'W-2026-000001', latestExternalRequestState: 'cancelled' });

  it('keeps the cancelled request with its reference and history, and offers a new request', async () => {
    as(everything);
    serve(afterCancellation, cancelledRequest);
    server.use(http.get('*/api/v1/external-invoice-requests', () => HttpResponse.json({ items: [cancelledRequest, earlierRequest], page: 1, pageSize: 100, total: 2 })));
    const user = userEvent.setup();
    renderRoute(<App />, `/orders/${ids.order}`);
    expect((await screen.findAllByText('This request is cancelled')).length).toBeGreaterThan(0);
    expect(screen.getByText(/Cancellation reference GS-77/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /History \(1\)/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Request invoice again' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('lists earlier requests collapsed', async () => {
    as(everything);
    serve(afterCancellation, cancelledRequest);
    let query: URL | undefined;
    server.use(http.get('*/api/v1/external-invoice-requests', ({ request }) => { query = new URL(request.url); return HttpResponse.json({ items: [cancelledRequest, earlierRequest], page: 1, pageSize: 100, total: 2 }); }));
    const user = userEvent.setup();
    renderRoute(<App />, `/orders/${ids.order}`);
    await user.click(await screen.findByRole('button', { name: 'Earlier requests (1)' }));
    expect(await screen.findByRole('button', { name: /W-2026-000000/ })).toBeInTheDocument();
    expect(query?.searchParams.get('orderId')).toBe(ids.order);
  });

  it('only shows the state without the permission to read requests', async () => {
    as([PermissionId.ordersread]);
    serve(afterCancellation);
    renderRoute(<App />, `/orders/${ids.order}`);
    expect(await screen.findByText(/Recipient details need the permission/)).toBeInTheDocument();
    expect(screen.getAllByText('Cancelled').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Request invoice again' })).not.toBeInTheDocument();
  });

  it('does not offer a new request without the permission to manage them', async () => {
    as(everything.filter((permission) => permission !== PermissionId.external_invoice_requestsmanage));
    serve(afterCancellation, cancelledRequest);
    renderRoute(<App />, `/orders/${ids.order}`);
    expect((await screen.findAllByText('This request is cancelled')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Request invoice again' })).not.toBeInTheDocument();
  });
});

describe('order detail: draft', () => {
  it('edits a custom item with exact decimals and the current version', async () => {
    as(everything);
    serve(order());
    let body: Record<string, unknown> | undefined;
    server.use(http.patch(`*/api/v1/orders/${ids.order}/items/${ids.item}`, async ({ request }) => { body = await request.json() as Record<string, unknown>; return HttpResponse.json(order({ version: 3 })); }));
    const user = userEvent.setup();
    renderRoute(<App />, `/orders/${ids.order}`);
    await user.click(await screen.findByLabelText('Edit Machine service'));
    const dialog = await screen.findByRole('dialog');
    await user.clear(within(dialog).getByLabelText('Unit price (€)'));
    await user.type(within(dialog).getByLabelText('Unit price (€)'), '2.005');
    await user.click(within(dialog).getByRole('button', { name: 'Save item' }));
    await waitFor(() => expect(body).toMatchObject({ kind: 'manual', unitPrice: '2.005', quantity: '1', expectedVersion: 2 }));
  });

  it('keeps write actions away from readers', async () => {
    as([PermissionId.ordersread]);
    serve(order());
    renderRoute(<App />, `/orders/${ids.order}`);
    await screen.findByRole('heading', { name: 'O-2026-000001' });
    expect(screen.queryByRole('button', { name: 'Finalize' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add items' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument();
  });
});
