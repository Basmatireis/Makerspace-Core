import { StrictMode } from 'react';
import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { server } from '../../test/server';
import { renderRoute } from '../../test/render';
import { ResetPasswordPage } from './ResetPasswordPage';

describe('password reset token handling', () => {
  it('retains the fragment token under Strict Mode while clearing it from the URL', async () => {
    const token = 'opaque-reset-token-value-with-at-least-32-characters';
    const submitted = vi.fn();
    server.use(
      http.post('*/api/v1/auth/password-reset/complete', async ({ request }) => {
        submitted(await request.json());
        return new HttpResponse(null, { status: 204 });
      }),
    );
    window.history.replaceState(null, '', `/reset-password#token=${token}`);

    const { queryClient } = renderRoute(
      <StrictMode>
        <ResetPasswordPage />
      </StrictMode>,
      '/reset-password',
    );

    await waitFor(() => expect(window.location.hash).toBe(''));
    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText('New password', { exact: true }),
      'Workshop satellite passphrase 48',
    );
    await user.type(
      screen.getByLabelText('Confirm new password'),
      'Workshop satellite passphrase 48',
    );
    await user.click(screen.getByRole('button', { name: 'Update password' }));

    await waitFor(() =>
      expect(submitted).toHaveBeenCalledWith({
        token,
        newPassword: 'Workshop satellite passphrase 48',
      }),
    );
    expect(
      await screen.findByRole('link', { name: 'Continue to sign in' }),
    ).toBeInTheDocument();
    expect(queryClient.getMutationCache().getAll()).toHaveLength(1);
    expect(queryClient.getMutationCache().getAll()[0]?.state.variables).toBeUndefined();
  });
});
