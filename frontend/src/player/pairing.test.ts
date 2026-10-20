import { describe, expect, it } from 'vitest';
import { PlayerApiError, PlayerNetworkError } from './api';
import { runPairing, type PairingState } from './pairing';
import { fakeApi } from './testFixtures';

type Script<T> = (T | Error)[];
function scripted<T>(items: Script<T>, fallback: T) {
  const queue = [...items];
  return async (): Promise<T> => {
    const next = queue.length > 0 ? queue.shift()! : fallback;
    if (next instanceof Error) throw next;
    return next;
  };
}

/** Runs the flow with instant sleeps; `until` aborts when a state arrives that ends the scenario. */
async function run(options: {
  start?: Script<{ code: string; expiresAt: string }>;
  poll?: Script<{ status: 'pending' | 'expired' | 'paired' }>;
  until: (state: PairingState) => boolean;
}) {
  const controller = new AbortController();
  const states: PairingState[] = [];
  const sleeps: number[] = [];
  const api = {
    startPairing: scripted(options.start ?? [], {
      code: 'ABC234',
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    }),
    pollPairing: scripted(options.poll ?? [], { status: 'pending' as const }),
  };
  const paired = await runPairing({
    api,
    signal: controller.signal,
    now: () => 0,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    onState: (state) => {
      states.push(state);
      if (options.until(state)) controller.abort();
    },
  });
  return { paired, states, sleeps };
}

const start = (code: string) => ({ code, expiresAt: new Date(Date.now() + 900_000).toISOString() });
const error = (status: number, code: string, retryAfterMs: number | null = null) =>
  new PlayerApiError(status, code, code, retryAfterMs);

describe('pairing', () => {
  it('shows the code, polls every 3 s and finishes when paired', async () => {
    const { paired, states, sleeps } = await run({
      start: [start('K7M2QX')],
      poll: [{ status: 'pending' }, { status: 'pending' }, { status: 'paired' }],
      until: () => false,
    });
    expect(paired).toBe(true);
    expect(states.map((state) => state.kind)).toEqual(['starting', 'waiting', 'paired']);
    expect(states[1]).toMatchObject({ kind: 'waiting', code: 'K7M2QX' });
    expect(sleeps).toEqual([3000, 3000, 3000]);
  });

  it('requests a new code when the old one expired', async () => {
    const { paired, states } = await run({
      start: [start('AAAAAA'), start('BBBBBB')],
      poll: [{ status: 'expired' }, { status: 'paired' }],
      until: () => false,
    });
    expect(paired).toBe(true);
    expect(states.filter((state) => state.kind === 'waiting').map((state) => (state as { code: string }).code)).toEqual(
      ['AAAAAA', 'BBBBBB'],
    );
  });

  it('continues polling when a restart finds the request already claimed (409)', async () => {
    const { paired, states } = await run({
      start: [error(409, 'pairing_claimed')],
      poll: [{ status: 'pending' }, { status: 'paired' }],
      until: () => false,
    });
    expect(paired).toBe(true);
    expect(states.map((state) => state.kind)).toEqual(['starting', 'claimed', 'paired']);
  });

  it('shows that the network may not pair displays (403) and retries later', async () => {
    const { states, sleeps } = await run({
      start: [error(403, 'pairing_network_denied'), start('CCCCCC')],
      until: (state) => state.kind === 'waiting',
    });
    expect(states.map((state) => state.kind)).toEqual(['starting', 'denied', 'waiting']);
    expect(sleeps[0]).toBe(30_000);
  });

  it('backs off exponentially on 429 and honours Retry-After', async () => {
    const { states, sleeps } = await run({
      start: [
        error(429, 'rate_limited'),
        error(429, 'rate_limited'),
        error(429, 'rate_limited', 120_000),
        start('DDDDDD'),
      ],
      until: (state) => state.kind === 'waiting',
    });
    expect(states.filter((state) => state.kind === 'retrying')).toHaveLength(3);
    expect(states[1]).toMatchObject({ kind: 'retrying', reason: 'rate_limited' });
    expect(sleeps.slice(0, 3)).toEqual([5000, 10_000, 120_000]);
  });

  it('backs off when the server is unreachable and recovers', async () => {
    const { states, sleeps } = await run({
      start: [new PlayerNetworkError(), start('EEEEEE')],
      until: (state) => state.kind === 'waiting',
    });
    expect(states[1]).toMatchObject({ kind: 'retrying', reason: 'offline' });
    expect(sleeps[0]).toBe(5000);
  });

  it('keeps the code on screen while polls fail, then restores the plain state', async () => {
    const { paired, states } = await run({
      start: [start('FFFFFF')],
      poll: [new PlayerNetworkError(), { status: 'pending' }, { status: 'paired' }],
      until: () => false,
    });
    expect(paired).toBe(true);
    expect(states[2]).toMatchObject({ kind: 'waiting', code: 'FFFFFF', trouble: 'offline' });
    expect(states[3]).toEqual(states[1]);
  });

  it('stops when aborted', async () => {
    const { paired } = await run({ until: (state) => state.kind === 'waiting' });
    expect(paired).toBe(false);
  });

  it('is usable with the shared fake API', () => {
    expect(typeof fakeApi().startPairing).toBe('function');
  });
});
