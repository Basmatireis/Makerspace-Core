import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { UpdateWiRefDeliverySettingsRequest, WiRefDeliverySettings } from '../../api/generated/models';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { InvoicingSettingsPage } from './InvoicingSettingsPage';

const settings: WiRefDeliverySettings = {
  enabled: false,
  recipientEmail: '',
  ccEmails: [],
  mailSubject: 'Invoice request {{anforderungsnummer}}',
  mailIntro: 'Intro',
  mailClosing: 'Closing',
  pdfTitle: 'Title',
  pdfIntro: 'PDF intro',
  pdfClosing: 'PDF closing',
  showContactPerson: true,
  showApprover: true,
  showPurchaseOrder: true,
  showServicePeriod: true,
  showServiceDescription: true,
  placeholders: [
    { token: '{{organisation}}', description: 'Name of the invoice recipient.' },
    { token: '{{summe}}', description: 'Amount to invoice.' },
  ],
  version: 1,
  updatedAt: '2026-10-21T00:00:00Z',
};

describe('invoicing settings', () => {
  it('lists the placeholders and saves recipient, CC list and toggles with the version', async () => {
    let submitted: UpdateWiRefDeliverySettingsRequest | undefined;
    server.use(
      http.get('*/api/v1/invoicing/wiref-settings', () => HttpResponse.json(settings)),
      http.put('*/api/v1/invoicing/wiref-settings', async ({ request }) => {
        submitted = (await request.json()) as UpdateWiRefDeliverySettingsRequest;
        return HttpResponse.json({ ...settings, ...submitted, version: 2 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<InvoicingSettingsPage />, '/settings/invoicing');
    expect(await screen.findByRole('heading', { name: 'Sales & invoicing' })).toBeInTheDocument();
    expect(await screen.findByText('{{organisation}}')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send test mail' })).toBeDisabled();
    await user.click(screen.getByRole('switch', { name: 'Send approved requests to wiRef' }));
    await user.type(screen.getByLabelText('wiRef email address'), 'wiref@example.test');
    await user.type(screen.getByLabelText('CC addresses'), 'a@example.test{enter}b@example.test');
    await user.click(screen.getByLabelText('Approver name'));
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() =>
      expect(submitted).toMatchObject({
        enabled: true,
        recipientEmail: 'wiref@example.test',
        ccEmails: ['a@example.test', 'b@example.test'],
        showApprover: false,
        showContactPerson: true,
        expectedVersion: 1,
      }),
    );
    expect(await screen.findByText('Settings saved')).toBeInTheDocument();
  });

  it('shows the server message when a template is rejected', async () => {
    server.use(
      http.get('*/api/v1/invoicing/wiref-settings', () => HttpResponse.json(settings)),
      http.put('*/api/v1/invoicing/wiref-settings', () =>
        HttpResponse.json(
          { error: { code: 'wiref_template_invalid', message: 'Unknown placeholder {{nobody}}' } },
          { status: 422 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderRoute(<InvoicingSettingsPage />, '/settings/invoicing');
    await user.type(await screen.findByLabelText('Introduction', { selector: '#wiref-mail-intro' }), ' {{nobody}}');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('Settings not saved')).toBeInTheDocument();
  });

  it('renders the mail preview in a script-free sandboxed frame', async () => {
    server.use(
      http.get('*/api/v1/invoicing/wiref-settings', () => HttpResponse.json(settings)),
      http.post('*/api/v1/invoicing/wiref-settings/preview', () =>
        HttpResponse.json({ subject: 'Sample subject', text: 'x', html: '<p>Sample mail</p>' }),
      ),
    );
    const user = userEvent.setup();
    renderRoute(<InvoicingSettingsPage />, '/settings/invoicing');
    await user.click(await screen.findByRole('button', { name: 'Preview mail' }));
    const frame = await screen.findByTitle('Mail preview');
    expect(frame).toHaveAttribute('sandbox', '');
    expect(frame).toHaveAttribute('srcdoc', '<p>Sample mail</p>');
    expect(screen.getByText('Sample subject')).toBeInTheDocument();
  });
});
