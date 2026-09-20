import { http, HttpResponse } from 'msw';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { SCIMConnectorsPage } from './SCIMConnectorsPage';

const provisionalAccountId = '0192f6f8-743e-7c77-a349-cd07c3e8ac01';
const targetAccountId = '0192f6f8-743e-7c77-a349-cd07c3e8ac02';

describe('SCIM connector administration', () => {
  it('shows a newly issued bearer token once', async () => {
    server.use(
      http.get('*/api/v1/scim/connectors', () => HttpResponse.json({ items: [] })),
      http.post('*/api/v1/scim/connectors', () => HttpResponse.json({
        connector: {
          id: '0192f6f8-743e-7c77-a349-cd07c3e8ac03',
          name: 'Authentik',
          oidcProviderId: null,
          enabled: true,
          tokenExpiresAt: '2026-12-20T00:00:00Z',
          tokenRevokedAt: null,
          version: 1,
          createdAt: '2026-09-20T00:00:00Z',
          updatedAt: '2026-09-20T00:00:00Z',
        },
        bearerToken: 'scim_secret_shown_once',
      }, { status: 201 })),
    );
    const user = userEvent.setup();
    renderRoute(<SCIMConnectorsPage />);

    await user.click(await screen.findByRole('button', { name: 'Add connector' }));
    await user.type(screen.getByLabelText('Connector name'), 'Authentik');
    await user.click(screen.getByRole('button', { name: 'Create connector' }));

    expect(await screen.findByText('Copy this bearer token now')).toBeInTheDocument();
    expect(screen.getByText('scim_secret_shown_once')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'I have stored the token' }));
    expect(screen.queryByText('scim_secret_shown_once')).not.toBeInTheDocument();
  });

  it('keeps reconciliation disabled when preflight reports a preservation conflict', async () => {
    server.use(
      http.get('*/api/v1/scim/connectors', () => HttpResponse.json({ items: [] })),
      http.post('*/api/v1/scim/reconciliation/preflight', () => HttpResponse.json({
        canReconcile: false,
        completed: false,
        provisionalAccountId,
        targetAccountId,
        conflicts: [{
          code: 'open_day_assignment_conflict',
          message: 'Both People have different positions on the same Open Day.',
          resourceId: '0192f6f8-743e-7c77-a349-cd07c3e8ac04',
        }],
      })),
    );
    const user = userEvent.setup();
    renderRoute(<SCIMConnectorsPage />);

    await user.type(await screen.findByLabelText('Provisional SCIM Account ID'), provisionalAccountId);
    await user.type(screen.getByLabelText('Established target Account ID'), targetAccountId);
    await user.click(screen.getByRole('button', { name: 'Run preflight' }));

    expect(await screen.findByText('Conflicts must be resolved first')).toBeInTheDocument();
    expect(screen.getByText('Both People have different positions on the same Open Day.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconcile Accounts' })).toBeDisabled();
  });
});
