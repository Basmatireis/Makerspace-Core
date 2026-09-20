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

  it.each(['/api/v1/auth/login', '/api/v1/auth/pin/login?test=1'])('does not expire an existing session after failed login at %s', async (url) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(unauthorizedResponse()));
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    await expect(apiFetch(url, { method: 'POST' })).rejects.toBeInstanceOf(ApiError);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('parses SCIM JSON and binary media types with parameters', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('{"totalResults":0}', {
      headers: { 'Content-Type': 'application/scim+json; charset=utf-8' },
    })).mockResolvedValueOnce(new Response('pdf', {
      headers: { 'Content-Type': 'application/pdf; charset=binary' },
    })));
    expect(await apiFetch('/api/scim/v2/Users')).toEqual({ totalResults: 0 });
    expect(await apiFetch('/api/v1/laborordnung/current/pdf')).toBeInstanceOf(Blob);
  });
});
