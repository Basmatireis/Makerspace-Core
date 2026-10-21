import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import type { ExternalInvoiceRequest } from '../../api/generated/models';
import { App } from '../../app/App';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { as, everything, finalized, ids, invoiceRequest, order } from './testData';

vi.mock('@carbon/charts-react', () => ({ LineChart: () => <div />, SimpleBarChart: () => <div /> }));

const issuedOrder = finalized({
  activeExternalRequestId: ids.request,
  activeExternalRequestReference: 'W-2026-000001',
  activeExternalRequestState: 'issued',
});

function serve(current: ReturnType<typeof order>, request: ExternalInvoiceRequest) {
  server.use(
    http.get(`*/api/v1/orders/${current.id}`, () => HttpResponse.json(current)),
    http.get(`*/api/v1/external-invoice-requests/${ids.request}`, () => HttpResponse.json(request)),
    http.get('*/api/v1/orders', () => HttpResponse.json({ items: [current], page: 1, pageSize: 100, total: 1 })),
    http.get('*/api/v1/organizations/:id/invoicing-requirements', () =>
      HttpResponse.json({ requirePurchaseOrderReference: false, version: 1 }),
    ),
  );
}

const approve = [...everything, PermissionId.external_invoice_requestsapprove];

describe('invoice delivery to wiRef', () => {
  it('shows a sent request with the time and lets an approver resend it', async () => {
    as(approve);
    serve(
      issuedOrder,
      invoiceRequest({
        state: 'issued',
        wirefDelivery: { status: 'sent', attemptedAt: '2026-10-06T10:00:00Z', failureCode: '' },
      }),
    );
    let resent = false;
    server.use(
      http.post(`*/api/v1/external-invoice-requests/${ids.request}/resend-to-wiref`, () => {
        resent = true;
        return HttpResponse.json(
          invoiceRequest({
            state: 'issued',
            wirefDelivery: { status: 'sent', attemptedAt: '2026-10-06T11:00:00Z', failureCode: '' },
          }),
        );
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/orders/${ids.order}`);
    expect(await screen.findByText('Sent to wiRef')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Resend to wiRef' }));
    await waitFor(() => expect(resent).toBe(true));
  });

  it('points to the settings when nothing was configured at forwarding time', async () => {
    as([...approve, PermissionId.invoicingsettingsmanage]);
    serve(
      issuedOrder,
      invoiceRequest({
        state: 'issued',
        wirefDelivery: { status: 'not_configured', attemptedAt: '2026-10-06T10:00:00Z', failureCode: '' },
      }),
    );
    renderRoute(<App />, `/orders/${ids.order}`);
    expect(await screen.findByText('Not sent to wiRef')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set up the wiRef delivery' })).toHaveAttribute(
      'href',
      '/settings/invoicing',
    );
  });

  it('explains a failed delivery and hides resend without the approve permission', async () => {
    as(everything);
    serve(
      issuedOrder,
      invoiceRequest({
        state: 'issued',
        wirefDelivery: { status: 'failed', attemptedAt: '2026-10-06T10:00:00Z', failureCode: 'send_failed' },
      }),
    );
    renderRoute(<App />, `/orders/${ids.order}`);
    expect(await screen.findByText('Not delivered to wiRef')).toBeInTheDocument();
    expect(screen.getByText(/did not accept the message/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resend to wiRef' })).not.toBeInTheDocument();
  });
});
