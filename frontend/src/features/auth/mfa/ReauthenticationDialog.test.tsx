import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../api/generated/models';
import { testQueryClient } from '../../../test/render';
import { server } from '../../../test/server';
import { authQueryKey } from '../auth';
import { ReauthenticationDialog } from './ReauthenticationDialog';

const withheld = {
  permissionId: 'privacy.requests.manage',
  requiredAssurance: 'strong_mfa',
  withinMinutes: 10,
} as const;

const user = {
  permissions: ['privacy.read'],
  authentication: {
    method: 'password',
    assurance: 'strong_mfa',
    authenticatedAt: '2026-10-29T08:00:00Z',
    authenticatedAssurance: 'strong_mfa',
    mfaEnrolled: true,
    mfaRequired: true,
    mfaSetupRequired: false,
    secondFactorMethods: ['totp'],
    reauthenticationRequired: [withheld],
  },
} as unknown as CurrentUser;

describe('reauthentication dialog', () => {
  it('grants the withheld permissions in the cached user as soon as the fresh sign-in succeeds', async () => {
    const typing = userEvent.setup();
    server.use(
      http.post('*/api/v1/auth/reauthenticate', () =>
        HttpResponse.json({
          ...user.authentication,
          authenticatedAt: '2026-10-29T09:00:00Z',
          reauthenticationRequired: [],
        }),
      ),
    );
    const queryClient = testQueryClient();
    queryClient.setQueryData(authQueryKey, user);
    const onFinish = vi.fn();
    render(
      <QueryClientProvider client={queryClient}>
        <ReauthenticationDialog request={{ requiredAssurance: 'strong_mfa', withinMinutes: 10 }} onFinish={onFinish} />
      </QueryClientProvider>,
    );
    await typing.type(screen.getByLabelText('Password'), 'workshop password');
    await typing.type(screen.getByLabelText('Authentication code'), '123456');
    await typing.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(onFinish).toHaveBeenCalledWith(true));
    const cached = queryClient.getQueryData<CurrentUser>(authQueryKey);
    expect(cached?.permissions).toEqual(['privacy.read', 'privacy.requests.manage']);
    expect(cached?.authentication.reauthenticationRequired).toEqual([]);
  });
});
