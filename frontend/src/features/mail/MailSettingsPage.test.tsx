import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { UpdateMailConfigurationRequest } from '../../api/generated/models';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { MailSettingsPage } from './MailSettingsPage';

describe('mail settings', () => {
  it('configures SMTP without ever receiving the stored password', async () => {
    let submitted: UpdateMailConfigurationRequest | undefined;
    server.use(
      http.get('*/api/v1/mail/configuration', () => HttpResponse.json({ enabled: false, provider: 'smtp', host: '', port: 587, tlsMode: 'starttls', username: '', passwordConfigured: false, fromAddress: '', fromName: '', baseUrl: '', version: 1, updatedAt: '2026-09-20T00:00:00Z' })),
      http.put('*/api/v1/mail/configuration', async ({ request }) => {
        submitted = await request.json() as UpdateMailConfigurationRequest;
        return HttpResponse.json({ enabled: true, provider: 'smtp', host: submitted.host, port: submitted.port, tlsMode: submitted.tlsMode, username: submitted.username, passwordConfigured: true, fromAddress: submitted.fromAddress, fromName: submitted.fromName, baseUrl: submitted.baseUrl, version: 2, updatedAt: '2026-09-20T00:01:00Z' });
      }),
    );
    const user = userEvent.setup();
    const { queryClient } = renderRoute(<MailSettingsPage />, '/settings/mail');
    expect(await screen.findByRole('heading', { name: 'Email delivery' })).toBeInTheDocument();
    await user.click(await screen.findByLabelText('Enable email delivery'));
    await user.type(screen.getByLabelText('SMTP host'), 'smtp.example.test');
    await user.type(screen.getByLabelText('SMTP username'), 'mailer');
    await user.type(screen.getByLabelText('SMTP password'), 'secret-password');
    await user.type(screen.getByLabelText('From address'), 'makerspace@example.test');
    await user.type(screen.getByLabelText('From name'), 'Makerspace');
    await user.clear(screen.getByLabelText('Public application URL'));
    await user.type(screen.getByLabelText('Public application URL'), 'https://makerspace.example.test');
    await user.click(screen.getByRole('button', { name: 'Save email configuration' }));
    await waitFor(() => expect(submitted).toMatchObject({ enabled: true, host: 'smtp.example.test', username: 'mailer', password: 'secret-password', fromAddress: 'makerspace@example.test', baseUrl: 'https://makerspace.example.test', expectedVersion: 1 }));
    expect(await screen.findByText('Email configuration saved')).toBeInTheDocument();
    expect(queryClient.getMutationCache().getAll().every((mutation) =>
      mutation.state.variables === undefined,
    )).toBe(true);
    expect(screen.getByLabelText('SMTP password')).toHaveValue('');
  });

  it('keeps a failed SMTP password submission out of mutation variables', async () => {
    server.use(
      http.get('*/api/v1/mail/configuration', () => HttpResponse.json({ enabled: false, provider: 'smtp', host: '', port: 587, tlsMode: 'starttls', username: '', passwordConfigured: false, fromAddress: '', fromName: '', baseUrl: '', version: 1, updatedAt: '2026-09-20T00:00:00Z' })),
      http.put('*/api/v1/mail/configuration', () => HttpResponse.json({ code: 'validation_failed', message: 'Invalid configuration' }, { status: 422 })),
    );
    const user = userEvent.setup();
    const { queryClient } = renderRoute(<MailSettingsPage />, '/settings/mail');
    await user.type(await screen.findByLabelText('SMTP password'), 'failed-submission-secret');
    await user.click(screen.getByRole('button', { name: 'Save email configuration' }));
    expect(await screen.findByText('Configuration not saved')).toBeInTheDocument();
    expect(queryClient.getMutationCache().getAll().every((mutation) =>
      mutation.state.variables === undefined,
    )).toBe(true);
  });
});
