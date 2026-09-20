const CSRF_COOKIE_NAMES = ['__Host-makerspace_csrf', 'makerspace_csrf'] as const;
const CSRF_HEADER_NAME = 'X-CSRF-Token';
const ENROLLMENT_CSRF_COOKIE_NAMES = ['__Host-makerspace_enrollment_csrf', 'makerspace_enrollment_csrf'] as const;
const ENROLLMENT_CSRF_HEADER_NAME = 'X-Enrollment-CSRF-Token';

type ErrorEnvelope = {
  code?: string;
  message?: string;
  details?: unknown;
  requestId?: string;
};

export class ApiError<T = ErrorEnvelope> extends Error {
  readonly status: number;
  readonly data?: T;
  readonly requestId?: string;

  constructor(status: number, data?: T, fallbackMessage?: string) {
    const envelope = data as ErrorEnvelope | undefined;
    super(envelope?.message ?? fallbackMessage ?? `Request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
    this.requestId = envelope?.requestId;
  }
}

export type ErrorType<T> = ApiError<T>;
export type BodyType<T> = T;

function readCookie(name: string): string | undefined {
  const prefix = `${encodeURIComponent(name)}=`;
  const part = document.cookie
    .split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith(prefix));

  return part ? decodeURIComponent(part.slice(prefix.length)) : undefined;
}

function hasBody(response: Response): boolean {
  return ![204, 205, 304].includes(response.status);
}

async function readResponse(response: Response): Promise<unknown> {
  if (!hasBody(response)) {
    return undefined;
  }

  const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (contentType === 'application/json' || contentType.endsWith('+json')) {
    return response.json();
  }
  if (contentType.startsWith('image/') || contentType === 'application/pdf') {
    return response.blob();
  }

  return response.text();
}

export async function apiFetch<T>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  const method = (options.method ?? 'GET').toUpperCase();
  const csrfToken = CSRF_COOKIE_NAMES.map(readCookie).find(Boolean);
  const enrollmentCSRFToken = ENROLLMENT_CSRF_COOKIE_NAMES.map(readCookie).find(Boolean);

  headers.set('Accept', 'application/json');
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && csrfToken) {
    headers.set(CSRF_HEADER_NAME, csrfToken);
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && url.includes('/visitor-enrollment/') && enrollmentCSRFToken) {
    headers.set(ENROLLMENT_CSRF_HEADER_NAME, enrollmentCSRFToken);
  }

  const response = await fetch(url, {
    ...options,
    cache: 'no-store',
    credentials: 'same-origin',
    headers,
  });
  const data = await readResponse(response);

  if (!response.ok) {
    const pathname = new URL(url, window.location.origin).pathname;
    const isPublicAuthenticationRequest =
      pathname.endsWith('/auth/login') || pathname.endsWith('/auth/pin/login') ||
      pathname.endsWith('/auth/password-reset/complete') || pathname.includes('/visitor-enrollment/');
    const isCurrentUserProbe =
      method === 'GET' &&
      pathname.endsWith('/auth/me');
    if (
      response.status === 401 &&
      !isPublicAuthenticationRequest &&
      !isCurrentUserProbe
    ) {
      window.dispatchEvent(new CustomEvent('makerspace:session-expired'));
    }
    throw new ApiError(response.status, data, response.statusText);
  }

  return data as T;
}
