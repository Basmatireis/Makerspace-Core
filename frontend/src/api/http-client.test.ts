import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, ApiError } from './http-client';

function unauthorizedResponse() {
  return new Response(
    JSON.stringify({ code: 'invalid_session', message: 'Sign in required.' }),
    {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

describe('session expiry events', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('lets the auth query handle an unauthenticated current-user probe', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(unauthorizedResponse()));
    const dispatch = vi.spyOn(window, 'dispatchEvent');

    await expect(apiFetch('/api/v1/auth/me')).rejects.toBeInstanceOf(ApiError);

    expect(dispatch).not.toHaveBeenCalled();
  });

  it('emits expiry for a 401 from another authenticated request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(unauthorizedResponse()));
    const dispatch = vi.spyOn(window, 'dispatchEvent');

    await expect(apiFetch('/api/v1/auth/password', { method: 'PUT' })).rejects.toBeInstanceOf(
      ApiError,
    );

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0].type).toBe('makerspace:session-expired');
  });
});
