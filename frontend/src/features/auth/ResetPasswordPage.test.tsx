import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { server } from '../../test/server';
import { renderRoute } from '../../test/render';
import { EmailVerificationPage, ResetPasswordPage } from './ResetPasswordPage';

describe('password reset code handling', () => {
  it('uses an enumeration-safe request followed by one-time code completion', async () => {
    const requested = vi.fn();
    const completed = vi.fn();
    server.use(
      http.post('*/api/v1/auth/password-reset/request', async ({ request }) => {
        requested(await request.json());
        return new HttpResponse(null, { status: 202 });
      }),
      http.post('*/api/v1/auth/password-reset/complete-code', async ({ request }) => {
        completed(await request.json());
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { queryClient } = renderRoute(<ResetPasswordPage />, '/reset-password');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Login email'), 'member@example.test');
    await user.click(screen.getByRole('button', { name: 'Send reset code' }));
    await waitFor(() => expect(requested).toHaveBeenCalledWith({ email: 'member@example.test' }));
    await user.type(screen.getByLabelText('Reset code'), 'ABCD2345');
    await user.type(screen.getByLabelText('New password', { exact: true }), 'Workshop satellite passphrase 48');
    await user.type(screen.getByLabelText('Confirm new password'), 'Workshop satellite passphrase 48');
    await user.click(screen.getByRole('button', { name: 'Update password' }));

    await waitFor(() => expect(completed).toHaveBeenCalledWith({
      email: 'member@example.test', code: 'ABCD2345', newPassword: 'Workshop satellite passphrase 48',
    }));
    expect(await screen.findByRole('link', { name: 'Continue to sign in' })).toBeInTheDocument();
    expect(queryClient.getMutationCache().getAll()).toHaveLength(2);
    for (const mutation of queryClient.getMutationCache().getAll()) {
      expect(mutation.state.variables).toBeUndefined();
    }
  });
});

describe('standalone email verification', () => {
  it('normalizes the one-time code and clears secret mutation variables after completion', async () => {
    const completed = vi.fn();
    server.use(
      http.post('*/api/v1/auth/email-verification/complete', async ({ request }) => {
        completed(await request.json());
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { queryClient } = renderRoute(<EmailVerificationPage />, '/verify-email?email=member%40example.test');
    const user = userEvent.setup();

    expect(screen.getByLabelText('Login email')).toHaveValue('member@example.test');
    await user.type(screen.getByLabelText('Verification code'), 'abcd2345');
    await user.click(screen.getByRole('button', { name: 'Verify email' }));

    await waitFor(() => expect(completed).toHaveBeenCalledWith({
      email: 'member@example.test',
      code: 'ABCD2345',
    }));
    expect(await screen.findByText('Email verified')).toBeInTheDocument();
    const mutations = queryClient.getMutationCache().getAll();
    expect(mutations).toHaveLength(1);
    expect(mutations[0].state.variables).toBeUndefined();
  });
});
