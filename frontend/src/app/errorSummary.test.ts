import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/http-client';
import { componentStackOf, errorHint, rememberComponentStack, summarizeError } from './errorSummary';

describe('errorSummary', () => {
  const online = { online: true };

  it('classifies the common causes with stable codes', () => {
    expect(summarizeError(new Error('boom'), online).code).toBe('RENDER');
    expect(summarizeError(new TypeError('Importing a module script failed.'), online).code).toBe('CHUNK_LOAD');
    expect(summarizeError(new TypeError('Load failed'), online).code).toBe('NETWORK');
    expect(summarizeError(new TypeError('Failed to fetch'), online).code).toBe('NETWORK');
    expect(summarizeError(new TypeError('Importing a module script failed.'), { online: false }).code).toBe('OFFLINE');
    expect(summarizeError(new ApiError(503, { message: 'down', requestId: 'req-1' }), online)).toMatchObject({
      kind: 'api',
      code: 'API_503',
      status: 503,
      requestId: 'req-1',
    });
  });

  it('gives a hint for stale chunks, offline, network and some API errors only', () => {
    const hint = (error: unknown, isOnline = true) => errorHint(summarizeError(error, { online: isOnline }));
    expect(hint(new TypeError('error loading dynamically imported module: /assets/A.js'))).toMatch(/new version/);
    expect(hint(new Error('x'), false)).toMatch(/offline/);
    expect(hint(new TypeError('Failed to fetch'))).toMatch(/server could not be reached/);
    expect(hint(new ApiError(500))).toMatch(/request id/);
    expect(hint(new ApiError(401))).toMatch(/sign in again/);
    expect(hint(new ApiError(403))).toMatch(/permission/);
    expect(hint(new ApiError(409))).toBeUndefined();
    expect(hint(new Error('boom'))).toBeUndefined();
  });

  it('creates a fresh reference per occurrence and records the time', () => {
    const now = new Date('2026-11-18T10:00:00Z');
    const a = summarizeError(new Error('boom'), { now });
    const b = summarizeError(new Error('boom'), { now });
    expect(a.reference).toMatch(/^[A-Z2-9]{8}$/);
    expect(a.reference).not.toBe(b.reference);
    expect(a.occurredAt).toBe('2026-11-18T10:00:00.000Z');
  });

  it('remembers component stacks per error', () => {
    const error = new Error('boom');
    rememberComponentStack(error, 'at Page');
    expect(componentStackOf(error)).toBe('at Page');
    expect(componentStackOf(new Error('other'))).toBeUndefined();
  });
});
