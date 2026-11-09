import { describe, expect, it, vi } from 'vitest';
import type { ManagedDevicePairingPoll } from '../../api/generated/models';
import { ApiError } from '../../api/http-client';
import { runKioskPairing, type KioskPairingApi, type KioskPairingState } from './pairing';

const start = { code: 'K7F2QX', expiresAt: '2099-01-01T00:15:00Z' };
const noSleep = () => Promise.resolve();

function run(api: KioskPairingApi, signal = new AbortController().signal) {
  const states: KioskPairingState[] = [];
  const done = runKioskPairing({ api, signal, onState: (state) => states.push(state), sleep: noSleep });
  return { states, done };
}

describe('kiosk pairing loop', () => {
  it('shows the code, keeps polling while pending and finishes once paired', async () => {
    const polls: ManagedDevicePairingPoll[] = [{ status: 'pending' }, { status: 'pending' }, { status: 'paired' }];
    const api = { start: vi.fn().mockResolvedValue(start), poll: vi.fn(() => Promise.resolve(polls.shift()!)) };
    const { states, done } = run(api);
    await expect(done).resolves.toBe(true);
    expect(api.start).toHaveBeenCalledTimes(1);
    expect(api.poll).toHaveBeenCalledTimes(3);
    expect(states[0]).toEqual({ kind: 'starting' });
    expect(states).toContainEqual({ kind: 'waiting', code: 'K7F2QX', expiresAt: Date.parse(start.expiresAt) });
    expect(states.at(-1)).toEqual({ kind: 'paired' });
  });

  it('requests a new code when the old one expired', async () => {
    const polls: ManagedDevicePairingPoll[] = [{ status: 'expired' }, { status: 'paired' }];
    const api = {
      start: vi
        .fn()
        .mockResolvedValueOnce(start)
        .mockResolvedValueOnce({ ...start, code: 'ABC234' }),
      poll: vi.fn(() => Promise.resolve(polls.shift()!)),
    };
    const { states, done } = run(api);
    await expect(done).resolves.toBe(true);
    expect(api.start).toHaveBeenCalledTimes(2);
    expect(states.some((state) => state.kind === 'waiting' && state.code === 'ABC234')).toBe(true);
  });

  it('collects the credential of an already claimed request after a restart', async () => {
    const api = {
      start: vi.fn().mockRejectedValue(new ApiError(409, { code: 'pairing_claimed' })),
      poll: vi.fn().mockResolvedValue({ status: 'paired' }),
    };
    const { states, done } = run(api);
    await expect(done).resolves.toBe(true);
    expect(states).toContainEqual({ kind: 'claimed' });
  });

  it('stops and lets the page re-check when the browser is already registered', async () => {
    const api = {
      start: vi.fn().mockRejectedValue(new ApiError(409, { code: 'device_already_registered' })),
      poll: vi.fn(),
    };
    const { done } = run(api);
    await expect(done).resolves.toBe(true);
    expect(api.poll).not.toHaveBeenCalled();
  });

  it('reports a denied network and rate limits without losing the code', async () => {
    const controller = new AbortController();
    const api = {
      start: vi
        .fn()
        .mockRejectedValueOnce(new ApiError(403, { code: 'pairing_network_denied' }))
        .mockResolvedValue(start),
      poll: vi
        .fn()
        .mockRejectedValueOnce(new ApiError(429, { code: 'rate_limited' }))
        .mockImplementation(() => {
          controller.abort();
          return Promise.resolve({ status: 'pending' });
        }),
    };
    const { states, done } = run(api, controller.signal);
    await expect(done).resolves.toBe(false);
    expect(states).toContainEqual({ kind: 'denied' });
    expect(states).toContainEqual({
      kind: 'waiting',
      code: 'K7F2QX',
      expiresAt: Date.parse(start.expiresAt),
      trouble: 'rate_limited',
    });
  });
});
