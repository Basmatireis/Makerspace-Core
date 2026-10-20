import type {
  SignagePairingPoll,
  SignagePairingStart,
  SignagePlayerHeartbeat,
  SignagePlayerLive,
  SignagePlayerManifestResponse,
} from '../api/generated/models';

// A tiny fetch wrapper for the player endpoints. The player must not load the application's HTTP client stack, so this
// only knows the five calls it needs. The device cookie and the pairing poll-secret cookie travel with `same-origin`.

const BASE = '/api/v1';
const REQUEST_TIMEOUT_MS = 15_000;

/** The server answered with an error status. */
export class PlayerApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  /** Milliseconds from a `Retry-After` header, when the server sent one. */
  readonly retryAfterMs: number | null;
  constructor(status: number, code: string | null, message: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = 'PlayerApiError';
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

/** The server could not be reached (offline, DNS, timeout, reset). */
export class PlayerNetworkError extends Error {
  constructor(message = 'Network unreachable') {
    super(message);
    this.name = 'PlayerNetworkError';
  }
}

export type PlayerApi = {
  startPairing(): Promise<SignagePairingStart>;
  pollPairing(): Promise<SignagePairingPoll>;
  manifest(known: number | null): Promise<SignagePlayerManifestResponse>;
  live(): Promise<SignagePlayerLive>;
  heartbeat(body: SignagePlayerHeartbeat): Promise<void>;
};

/** Revoked credentials answer 401 or 403 on the player endpoints. */
export const isRevoked = (error: unknown) =>
  error instanceof PlayerApiError && (error.status === 401 || error.status === 403);

function retryAfter(response: Response): number | null {
  const seconds = Number(response.headers.get('Retry-After'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) * 1000 : null;
}

export function createPlayerApi(fetchImpl: typeof fetch = (input, init) => fetch(input, init)): PlayerApi {
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(`${BASE}${path}`, {
        ...init,
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new PlayerNetworkError();
    }
    if (!response.ok) {
      let code: string | null = null;
      let message = response.statusText || `Request failed (${response.status})`;
      try {
        const body = (await response.json()) as { code?: string; message?: string };
        code = body.code ?? null;
        message = body.message ?? message;
      } catch {
        /* The body is optional. */
      }
      throw new PlayerApiError(response.status, code, message, retryAfter(response));
    }
    if (response.status === 204) return undefined as T;
    try {
      return (await response.json()) as T;
    } catch {
      throw new PlayerNetworkError('Unreadable response');
    }
  }
  return {
    startPairing: () => request('/public/signage/pairing', { method: 'POST' }),
    pollPairing: () => request('/public/signage/pairing'),
    manifest: (known) => request(`/signage/player/manifest${known === null ? '' : `?known=${known}`}`),
    live: () => request('/signage/player/live'),
    heartbeat: (body) => request('/signage/player/heartbeat', { method: 'POST', body: JSON.stringify(body) }),
  };
}
