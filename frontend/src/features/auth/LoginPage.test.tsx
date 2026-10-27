import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { LoginPage } from './LoginPage';

afterEach(() => vi.unstubAllGlobals());

function pendingLogin(methods: string[]) {
  return http.post('*/api/v1/auth/login', () =>
    HttpResponse.json(
      { status: 'second_factor_required', methods, expiresAt: '2099-01-01T00:00:00Z' },
      { status: 202 },
    ),
  );
}

describe('second factor during sign-in', () => {
  it('asks for the authenticator code after a 202 and signs in with it', async () => {
    let signedIn = false;
    const completed = vi.fn();
    server.use(
      pendingLogin(['totp', 'recovery_code']),
      http.post('*/api/v1/auth/login/second-factor', async ({ request }) => {
        completed(await request.json());
        signedIn = true;
        return new HttpResponse(null, { status: 204 });
      }),
      http.get('*/api/v1/auth/me', () =>
        signedIn
          ? HttpResponse.json(currentUserFixture())
          : HttpResponse.json({ code: 'unauthenticated', message: 'x' }, { status: 401 }),
      ),
    );
    const user = userEvent.setup();
    renderRoute(<LoginPage />, '/login');

    await user.type(await screen.findByLabelText('Email'), 'ada@example.test');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    const code = await screen.findByLabelText('Authentication code');
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    expect(code).toHaveAttribute('inputmode', 'numeric');
    await user.type(code, '123456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() => expect(completed).toHaveBeenCalledWith({ method: 'totp', code: '123456' }));
  });

  it('switches to a recovery code and explains an expired pending login', async () => {
    const attempts = vi.fn();
    server.use(
      pendingLogin(['totp', 'recovery_code']),
      http.post('*/api/v1/auth/login/second-factor', async ({ request }) => {
        attempts(await request.json());
        return HttpResponse.json({ code: 'second_factor_pending_invalid', message: 'Expired.' }, { status: 401 });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<LoginPage />, '/login');

    await user.type(await screen.findByLabelText('Email'), 'ada@example.test');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await user.click(await screen.findByRole('button', { name: 'Use a recovery code' }));
    await user.type(screen.getByLabelText('Recovery code'), 'ABCD-EFGH-1234');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    expect(await screen.findByText('This sign-in expired. Start again.')).toBeInTheDocument();
    expect(attempts).toHaveBeenCalledWith({ method: 'recovery_code', code: 'ABCD-EFGH-1234' });
    await user.click(screen.getByRole('button', { name: 'Start again' }));
    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
  });

  it('offers a passkey only when the account has one and the browser supports it', async () => {
    vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {});
    server.use(pendingLogin(['totp', 'passkey']));
    const user = userEvent.setup();
    renderRoute(<LoginPage />, '/login');

    await user.type(await screen.findByLabelText('Email'), 'ada@example.test');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('button', { name: 'Use a passkey' })).toBeInTheDocument();
  });
});

describe('passkey sign-in button', () => {
  it('is hidden when the browser has no WebAuthn support', async () => {
    renderRoute(<LoginPage />, '/login');
    await screen.findByLabelText('Email');
    expect(screen.queryByRole('button', { name: 'Sign in with passkey' })).not.toBeInTheDocument();
  });

  it('is shown when WebAuthn is available', async () => {
    vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {});
    renderRoute(<LoginPage />, '/login');
    expect(await screen.findByRole('button', { name: 'Sign in with passkey' })).toBeInTheDocument();
  });
});
