import { isRouteErrorResponse } from 'react-router-dom';
import { ApiError } from '../api/http-client';
import { isChunkLoadError } from './chunkLoadRecovery';

/** The class of a failure; its code is stable, so a supervisor can quote it in an issue. */
export type ErrorKind = 'chunk_load' | 'offline' | 'network' | 'api' | 'not_found' | 'render';

/** What the error page shows right away. The full, sanitized details load on demand (errorDetails.ts). */
export type ErrorSummary = {
  kind: ErrorKind;
  /** Short and stable, such as `RENDER` or `API_500`. */
  code: string;
  /** Generated per occurrence, so several reports of the same crash can be told apart. */
  reference: string;
  occurredAt: string;
  status?: number;
  requestId?: string;
};

// Browsers word a failed fetch differently; none of these carry a response.
const networkErrorPatterns = [
  'failed to fetch',
  'networkerror when attempting to fetch',
  'load failed',
  'network request failed',
];

function classify(error: unknown, online: boolean): Pick<ErrorSummary, 'kind' | 'code' | 'status'> {
  if (isRouteErrorResponse(error)) {
    return error.status === 404
      ? { kind: 'not_found', code: 'NOT_FOUND', status: 404 }
      : { kind: 'api', code: `HTTP_${error.status}`, status: error.status };
  }
  if (error instanceof ApiError) return { kind: 'api', code: `API_${error.status}`, status: error.status };
  if (!online) return { kind: 'offline', code: 'OFFLINE' };
  if (isChunkLoadError(error)) return { kind: 'chunk_load', code: 'CHUNK_LOAD' };
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (error instanceof TypeError && networkErrorPatterns.some((pattern) => message.includes(pattern))) {
    return { kind: 'network', code: 'NETWORK' };
  }
  return { kind: 'render', code: 'RENDER' };
}

function newReference() {
  const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export function summarizeError(error: unknown, options: { now?: Date; online?: boolean } = {}): ErrorSummary {
  return {
    ...classify(error, options.online ?? navigator.onLine),
    reference: newReference(),
    occurredAt: (options.now ?? new Date()).toISOString(),
    requestId: error instanceof ApiError && error.requestId ? error.requestId.slice(0, 64) : undefined,
  };
}

/** A short hint for the common causes, or undefined when there is nothing specific to suggest. */
export function errorHint({ kind, status }: ErrorSummary): string | undefined {
  if (kind === 'chunk_load') return 'A new version was probably deployed while this tab was open. Reload the page.';
  if (kind === 'offline') return 'This device seems to be offline. Check the connection, then reload the page.';
  if (kind === 'network') return 'The server could not be reached. Check the connection, then reload the page.';
  if (status === 401) return 'Your session has ended. Reload the page and sign in again.';
  if (status === 403) return 'You do not have permission for this page or action.';
  if (status !== undefined && status >= 500) return 'The server failed to handle a request. Quote the request id.';
  return undefined;
}

// React reports the component stack of a caught error to the root's onCaughtError after the error page rendered, so it
// is kept here per error and read once the page has mounted.
const componentStacks = new WeakMap<object, string>();

export function rememberComponentStack(error: unknown, componentStack: string | null | undefined) {
  if (typeof error === 'object' && error !== null && componentStack) componentStacks.set(error, componentStack);
}

export function componentStackOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? componentStacks.get(error) : undefined;
}
