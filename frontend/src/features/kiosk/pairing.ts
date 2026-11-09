import {
  pollManagedDevicePairing,
  startManagedDevicePairing,
} from '../../api/generated/managed-devices/managed-devices';
import type { ManagedDevicePairingPoll, ManagedDevicePairingStart } from '../../api/generated/models';
import { ApiError, apiErrorCode } from '../../api/http-client';

// The pairing flow of an unregistered kiosk browser: ask for a code, show it, poll until staff claimed it. Written as
// a plain async loop with injected time so the transitions can be tested without React or real timers. The poll
// secret and, once claimed, the device credential travel only in HttpOnly cookies; JavaScript never sees them.

export type KioskPairingTrouble = 'rate_limited' | 'offline';

export type KioskPairingState =
  | { kind: 'starting' }
  | { kind: 'waiting'; code: string; expiresAt: number; trouble?: KioskPairingTrouble }
  /** A restart found the request already claimed by staff (409): the credential is collected with the stored cookie. */
  | { kind: 'claimed'; trouble?: KioskPairingTrouble }
  /** 403 pairing_network_denied: this network may not register kiosks. */
  | { kind: 'denied' }
  | { kind: 'retrying'; reason: KioskPairingTrouble }
  | { kind: 'paired' };

export type KioskPairingApi = {
  start: () => Promise<ManagedDevicePairingStart>;
  poll: () => Promise<ManagedDevicePairingPoll>;
};

export const kioskPairingApi: KioskPairingApi = {
  start: () => startManagedDevicePairing({ credentialDelivery: 'bindBrowser' }),
  poll: () => pollManagedDevicePairing(),
};

export const POLL_MS = 3_000;
const RETRY_MS = 10_000;
const DENIED_RETRY_MS = 30_000;

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

const troubleOf = (error: unknown): KioskPairingTrouble =>
  error instanceof ApiError && error.status === 429 ? 'rate_limited' : 'offline';

export type KioskPairingDeps = {
  api?: KioskPairingApi;
  onState: (state: KioskPairingState) => void;
  signal: AbortSignal;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

/** Runs until the kiosk is paired (`true`) or the signal aborts (`false`). */
export async function runKioskPairing({
  api = kioskPairingApi,
  onState,
  signal,
  sleep = defaultSleep,
}: KioskPairingDeps): Promise<boolean> {
  onState({ kind: 'starting' });
  while (!signal.aborted) {
    let shown: Extract<KioskPairingState, { kind: 'waiting' | 'claimed' }>;
    try {
      const start = await api.start();
      shown = { kind: 'waiting', code: start.code, expiresAt: Date.parse(start.expiresAt) };
    } catch (error) {
      if (signal.aborted) break;
      if (error instanceof ApiError && error.status === 409 && apiErrorCode(error) === 'pairing_claimed') {
        shown = { kind: 'claimed' };
      } else if (
        error instanceof ApiError &&
        error.status === 403 &&
        apiErrorCode(error) === 'pairing_network_denied'
      ) {
        onState({ kind: 'denied' });
        await sleep(DENIED_RETRY_MS, signal);
        continue;
      } else {
        onState({ kind: 'retrying', reason: troubleOf(error) });
        await sleep(RETRY_MS, signal);
        continue;
      }
    }
    onState(shown);
    // Poll until claimed (paired), expired (start over) or aborted. A failing poll keeps the code on screen.
    while (!signal.aborted) {
      await sleep(POLL_MS, signal);
      if (signal.aborted) break;
      try {
        const poll = await api.poll();
        if (poll.status === 'paired') {
          onState({ kind: 'paired' });
          return true;
        }
        if (poll.status === 'expired') break;
        onState(shown);
      } catch (error) {
        if (signal.aborted) break;
        onState({ ...shown, trouble: troubleOf(error) });
        await sleep(RETRY_MS, signal);
      }
    }
  }
  return false;
}
