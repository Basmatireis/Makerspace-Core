import { isRouteErrorResponse } from 'react-router-dom';
import type { ErrorSummary } from './errorSummary';

const appVersion: string = import.meta.env.VITE_APP_VERSION || 'development';
const maxMessageLength = 300;
const maxStackLines = 12;

// Identifiers in routes and messages are UUIDs; they help to find the record and are not secret.
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Removes what must not end up in a copied bug report: query strings and fragments (which may hold tokens), e-mail
 * addresses and long token-like strings. Also strips this site's origin so the text stays short.
 */
export function sanitize(text: string): string {
  return text
    .split(window.location.origin)
    .join('')
    .replace(/\?[^\s)'"]*=[^\s)'"]*/g, '?…')
    .replace(/(\/[^\s#]*)#[^\s)'"]+/g, '$1#…')
    .replace(/[\w.%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}\b/gi, '[email]')
    .replace(/[A-Za-z0-9_-]{24,}/g, (match) =>
      uuidPattern.test(match) || !/\d/.test(match) || !/[A-Za-z]/.test(match) ? match : '[redacted]',
    );
}

function firstLines(text: string | null | undefined) {
  const lines = (text ?? '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean);
  if (lines.length === 0) return undefined;
  const shown = lines.slice(0, maxStackLines).join('\n');
  return sanitize(lines.length > maxStackLines ? `${shown}\n…` : shown);
}

function describe(error: unknown): string {
  if (isRouteErrorResponse(error)) return `ErrorResponse: ${error.status} ${error.statusText}`.trim();
  if (error instanceof Error) return `${error.name || 'Error'}: ${error.message}`;
  if (typeof error === 'string') return error;
  return `A ${typeof error} value was thrown instead of an Error.`;
}

/**
 * Plain-text details for a bug report, sanitized and shortened. Nothing is sent anywhere; the text is only shown and
 * copied by the person.
 */
export function formatErrorDetails(error: unknown, summary: ErrorSummary, componentStack?: string): string {
  const message = sanitize(describe(error));
  const lines = [
    `Error code: ${summary.code}`,
    `Reference: ${summary.reference}`,
    `Time: ${summary.occurredAt}`,
    `Page: ${sanitize(window.location.pathname)}`,
    `Version: ${appVersion}`,
    `Browser: ${navigator.userAgent}`,
    `Error: ${message.length > maxMessageLength ? `${message.slice(0, maxMessageLength)}…` : message}`,
  ];
  if (summary.status !== undefined) lines.push(`HTTP status: ${summary.status}`);
  if (summary.requestId) lines.push(`Request id: ${summary.requestId}`);
  const stack = error instanceof Error ? firstLines(error.stack) : undefined;
  if (stack) lines.push('', 'Stack:', stack);
  const components = firstLines(componentStack);
  if (components) lines.push('', 'Component stack:', components);
  return lines.join('\n');
}
