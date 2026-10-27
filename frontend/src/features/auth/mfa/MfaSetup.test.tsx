import { http, HttpResponse } from 'msw';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { currentUserFixture } from '../../../test/fixtures';
import { renderRoute } from '../../../test/render';
import { server } from '../../../test/server';
import { ProtectedRoute } from '../auth';
import { ReauthenticationDialog } from './ReauthenticationDialog';

function userRequiringSetup(required: boolean) {
  const user = currentUserFixture();
  user.authentication = { ...user.authentication, mfaRequired: required, mfaSetupRequired: required };
  return user;
}

describe('forced second-factor setup', () => {
  it('replaces the application with the setup screen and shows recovery codes before continuing', async () => {
    let enrolled = false;
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(userRequiringSetup(!enrolled))),
      http.post('*/api/v1/auth/second-factors/totp/enrollment', () =>
        HttpResponse.json({
          secret: 'JBSWY3DPEHPK3PXP',
          otpauthUri: 'otpauth://totp/Makerspace:ada?secret=JBSWY3DPEHPK3PXP',
          expiresAt: '2099-01-01T00:00:00Z',
        }),
      ),
      http.post('*/api/v1/auth/second-factors/totp/enrollment/confirm', () => {
        enrolled = true;
        return HttpResponse.json({
          secondFactors: { enrolled: true, totp: null, passkeys: [], recoveryCodesRemaining: 2 },
          recoveryCodes: ['AAAA-1111', 'BBBB-2222'],
        });
      }),
    );
    const user = userEvent.setup();
    renderRoute(
      <ProtectedRoute>
        <p>Application content</p>
      </ProtectedRoute>,
    );

    expect(await screen.findByRole('heading', { name: 'Set up a second factor' })).toBeInTheDocument();
    expect(screen.queryByText('Application content')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Set up authenticator app' }));
    expect(await screen.findByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Authentication code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Confirm and turn on' }));

    expect(await screen.findByText(/AAAA-1111/)).toBeInTheDocument();
    expect(screen.queryByText('Application content')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'I have saved these codes' }));
    expect(await screen.findByText('Application content')).toBeInTheDocument();
  });

  it('shows the application when no setup is required', async () => {
    server.use(http.get('*/api/v1/auth/me', () => HttpResponse.json(userRequiringSetup(false))));
    renderRoute(
      <ProtectedRoute>
        <p>Application content</p>
      </ProtectedRoute>,
    );
    expect(await screen.findByText('Application content')).toBeInTheDocument();
  });
});

describe('Confirm it is you dialog', () => {
  it('sends the password and authenticator code and reports success', async () => {
    let body: unknown;
    server.use(
      http.post('*/api/v1/auth/reauthenticate', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(currentUserFixture().authentication);
      }),
    );
    const { queryClient } = renderRoute(<p>host</p>);
    const user = currentUserFixture();
    user.authentication = { ...user.authentication, mfaEnrolled: true, secondFactorMethods: ['totp'] };
    queryClient.setQueryData(['auth', 'current-user'], user);
    let result: boolean | undefined;
    render(
      <QueryClientProvider client={queryClient}>
        <ReauthenticationDialog request={{ withinMinutes: 10 }} onFinish={(value) => (result = value)} />
      </QueryClientProvider>,
    );
    const events = userEvent.setup();

    await events.type(await screen.findByLabelText('Password'), 'correct horse battery');
    await events.type(screen.getByLabelText('Authentication code'), '123456');
    await events.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(result).toBe(true));
    expect(body).toEqual({ password: 'correct horse battery', totpCode: '123456' });
  });

  it('reports false when cancelled', async () => {
    const { queryClient } = renderRoute(<p>host</p>);
    let result: boolean | undefined;
    render(
      <QueryClientProvider client={queryClient}>
        <ReauthenticationDialog request={{}} onFinish={(value) => (result = value)} />
      </QueryClientProvider>,
    );
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(result).toBe(false);
  });
});
