import { PlayerApiError, PlayerNetworkError, type PlayerApi } from './api';
import { backoffMs, sleep as defaultSleep } from './timing';

// The pairing flow of an unpaired display: ask for a code, show it, poll until staff claimed it. Written as a plain async
// loop with injected time so the transitions can be tested without React or real timers.

export type PairingTrouble = 'rate_limited' | 'offline' | 'error';

export type PairingState =
  | { kind: 'starting' }
  | { kind: 'waiting'; code: string; expiresAt: number; trouble?: PairingTrouble }
  /** A restart found the request already claimed by staff (409): the credential is collected with the stored cookie. */
  | { kind: 'claimed'; trouble?: PairingTrouble }
  /** 403 pairing_network_denied: this network may not pair displays. */
  | { kind: 'denied' }
  | { kind: 'retrying'; reason: PairingTrouble; retryAt: number }
  | { kind: 'paired' };

export type PairingDeps = {
  api: Pick<PlayerApi, 'startPairing' | 'pollPairing'>;
  onState: (state: PairingState) => void;
  signal: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  pollMs?: number;
  deniedRetryMs?: number;
};

const troubleOf = (error: unknown): PairingTrouble =>
  error instanceof PlayerNetworkError
    ? 'offline'
    : error instanceof PlayerApiError && error.status === 429
      ? 'rate_limited'
      : 'error';

export const POLL_MS = 3_000;
export const DENIED_RETRY_MS = 30_000;

/** Runs until the display is paired (`true`) or the signal aborts (`false`). */
export async function runPairing(deps: PairingDeps): Promise<boolean> {
  const { api, onState, signal } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const pollMs = deps.pollMs ?? POLL_MS;
  let failures = 0;

  const retry = async (reason: PairingTrouble, minimum = 0) => {
    const delay = Math.max(minimum, backoffMs(failures));
    failures += 1;
    onState({ kind: 'retrying', reason, retryAt: now() + delay });
    await sleep(delay, signal);
  };

  onState({ kind: 'starting' });
  while (!signal.aborted) {
    // 1. Get a code.
    let shown: Extract<PairingState, { kind: 'waiting' | 'claimed' }>;
    let troubled = false;
    try {
      const start = await api.startPairing();
      failures = 0;
      shown = { kind: 'waiting', code: start.code, expiresAt: Date.parse(start.expiresAt) };
      onState(shown);
    } catch (error) {
      if (signal.aborted) break;
      if (error instanceof PlayerApiError && error.status === 409 && error.code === 'pairing_claimed') {
        failures = 0;
        shown = { kind: 'claimed' };
        onState(shown);
      } else if (error instanceof PlayerApiError && error.status === 403 && error.code === 'pairing_network_denied') {
        onState({ kind: 'denied' });
        await sleep(deps.deniedRetryMs ?? DENIED_RETRY_MS, signal);
        continue;
      } else if (error instanceof PlayerApiError && error.status === 429) {
        await retry('rate_limited', error.retryAfterMs ?? 0);
        continue;
      } else {
        await retry(troubleOf(error), error instanceof PlayerApiError ? (error.retryAfterMs ?? 0) : 0);
        continue;
      }
    }
    // 2. Poll until it is claimed (paired), expired (start over) or the signal aborts. A failing poll keeps the code on screen.
    while (!signal.aborted) {
      await sleep(pollMs, signal);
      if (signal.aborted) break;
      try {
        const poll = await api.pollPairing();
        failures = 0;
        if (poll.status === 'paired') {
          onState({ kind: 'paired' });
          return true;
        }
        if (poll.status === 'expired') break;
        if (troubled) {
          troubled = false;
          onState(shown);
        }
      } catch (error) {
        if (signal.aborted) break;
        const trouble = troubleOf(error);
        troubled = true;
        onState({ ...shown, trouble });
        const delay = Math.max(
          error instanceof PlayerApiError ? (error.retryAfterMs ?? 0) : 0,
          backoffMs(failures, pollMs),
        );
        failures += 1;
        await sleep(delay, signal);
      }
    }
  }
  return false;
}
