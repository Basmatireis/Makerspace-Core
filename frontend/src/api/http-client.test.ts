import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, ApiError, setReauthenticationHandler } from './http-client';

function unauthorizedResponse(details?: unknown) {
  return new Response(JSON.stringify({ code: 'invalid_session', message: 'Sign in required.', details }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
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
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(unauthorizedResponse({ postSessionDestination: 'visitor_terminal' })),
    );
    const dispatch = vi.spyOn(window, 'dispatchEvent');

    await expect(apiFetch('/api/v1/auth/password', { method: 'PUT' })).rejects.toBeInstanceOf(ApiError);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0].type).toBe('makerspace:session-expired');
    expect((dispatch.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      code: 'invalid_session',
      message: 'Sign in required.',
      details: { postSessionDestination: 'visitor_terminal' },
    });
  });

  it.each(['/api/v1/auth/login', '/api/v1/auth/pin/login?test=1'])(
    'does not expire an existing session after failed login at %s',
    async (url) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(unauthorizedResponse()));
      const dispatch = vi.spyOn(window, 'dispatchEvent');
      await expect(apiFetch(url, { method: 'POST' })).rejects.toBeInstanceOf(ApiError);
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it('parses SCIM JSON and binary media types with parameters', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response('{"totalResults":0}', {
            headers: { 'Content-Type': 'application/scim+json; charset=utf-8' },
          }),
        )
        .mockResolvedValueOnce(
          new Response('pdf', {
            headers: { 'Content-Type': 'application/pdf; charset=binary' },
          }),
        ),
    );
    expect(await apiFetch('/api/scim/v2/Users')).toEqual({ totalResults: 0 });
    expect(await apiFetch('/api/v1/laborordnung/current/pdf')).toBeInstanceOf(Blob);
  });
});

describe('step-up reauthentication', () => {
  const stale = () =>
    new Response(
      JSON.stringify({
        code: 'reauthentication_required',
        message: 'Sign in again.',
        details: { requiredAssurance: 'strong_mfa', withinMinutes: 10 },
      }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    );
  const ok = () => new Response(JSON.stringify({ done: true }), { headers: { 'Content-Type': 'application/json' } });

  afterEach(() => {
    setReauthenticationHandler(null);
    vi.unstubAllGlobals();
  });

  it('repeats the request once after the prompt confirms', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(stale()).mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetchMock);
    const handler = vi.fn().mockResolvedValue(true);
    setReauthenticationHandler(handler);

    await expect(apiFetch('/api/v1/roles', { method: 'POST', body: '{}' })).resolves.toEqual({ done: true });

    expect(handler).toHaveBeenCalledWith({ requiredAssurance: 'strong_mfa', withinMinutes: 10 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up without a second request when the prompt is cancelled', async () => {
    const fetchMock = vi.fn().mockResolvedValue(stale());
    vi.stubGlobal('fetch', fetchMock);
    setReauthenticationHandler(vi.fn().mockResolvedValue(false));

    await expect(apiFetch('/api/v1/roles', { method: 'POST', body: '{}' })).rejects.toBeInstanceOf(ApiError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('prompts at most once per request even when the repeat is still refused', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(stale()));
    vi.stubGlobal('fetch', fetchMock);
    const handler = vi.fn().mockResolvedValue(true);
    setReauthenticationHandler(handler);

    await expect(apiFetch('/api/v1/roles', { method: 'POST', body: '{}' })).rejects.toBeInstanceOf(ApiError);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shares one prompt between requests that fail together', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(stale())
      .mockResolvedValueOnce(stale())
      .mockImplementation(() => Promise.resolve(ok()));
    vi.stubGlobal('fetch', fetchMock);
    const handler = vi.fn().mockResolvedValue(true);
    setReauthenticationHandler(handler);

    await Promise.all([apiFetch('/api/v1/a', { method: 'POST' }), apiFetch('/api/v1/b', { method: 'POST' })]);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('never prompts for the reauthentication endpoints themselves', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stale()));
    const handler = vi.fn().mockResolvedValue(true);
    setReauthenticationHandler(handler);

    await expect(apiFetch('/api/v1/auth/reauthenticate', { method: 'POST' })).rejects.toBeInstanceOf(ApiError);

    expect(handler).not.toHaveBeenCalled();
  });
});
