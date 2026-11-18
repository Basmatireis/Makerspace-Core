import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/http-client';
import { formatErrorDetails, sanitize } from './errorDetails';
import { summarizeError } from './errorSummary';

describe('errorDetails', () => {
  it('removes query strings, e-mail addresses and token-like strings but keeps ids and package paths', () => {
    const id = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
    const text = sanitize(
      `GET /api/v1/reset?token=abc123 by ada@example.org with xK9dF2mQ7vL3pR8sT1wZ5yB4nH6jC0eA for /people/${id} and /x#access_token=1`,
    );
    expect(text).not.toContain('abc123');
    expect(text).not.toContain('ada@example.org');
    expect(text).not.toContain('xK9dF2mQ7vL3pR8sT1wZ5yB4nH6jC0eA');
    expect(text).not.toContain('access_token');
    expect(text).toContain(id);
    expect(text).toContain('[email]');
    expect(text).toContain('[redacted]');
    expect(sanitize('at /node_modules/@carbon/react/lib/index.js:1:2')).toContain('@carbon/react/lib/index.js');
    expect(sanitize(`${window.location.origin}/assets/a.js`)).toBe('/assets/a.js');
  });

  it('formats every field a bug report needs', () => {
    const error = new ApiError(500, { message: 'Internal error', requestId: 'req-42' });
    const summary = summarizeError(error);
    const text = formatErrorDetails(error, summary, '\n    at Editor\n    at Page');
    expect(text).toContain('Error code: API_500');
    expect(text).toContain(`Reference: ${summary.reference}`);
    expect(text).toContain(`Time: ${summary.occurredAt}`);
    expect(text).toContain(`Page: ${window.location.pathname}`);
    expect(text).toMatch(/Version: \S+/);
    expect(text).toContain('Error: ApiError: Internal error');
    expect(text).toContain('HTTP status: 500');
    expect(text).toContain('Request id: req-42');
    expect(text).toContain('Component stack:\n    at Editor\n    at Page');
  });

  it('shortens long messages and stacks', () => {
    const error = new Error('x'.repeat(1000));
    error.stack = Array.from({ length: 40 }, (_, i) => `at frame${i} (/assets/a.js:1:${i})`).join('\n');
    const text = formatErrorDetails(error, summarizeError(error));
    expect(text).toContain(`Error: Error: ${'x'.repeat(293)}…\n`);
    expect(text).toContain('at frame11 ');
    expect(text).not.toContain('at frame12 ');
  });

  it('describes values that are not errors', () => {
    expect(formatErrorDetails('plain text', summarizeError('plain text'))).toContain('Error: plain text');
    expect(formatErrorDetails(42, summarizeError(42))).toContain('A number value was thrown');
  });
});
