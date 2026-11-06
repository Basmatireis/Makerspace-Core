import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerApiError } from './api';
import { PlayerApp } from './PlayerApp';
import { fakeApi, live } from './testFixtures';

describe('PlayerApp', () => {
  beforeEach(async () => {
    await import('./PairingScreen'); // The lazy pairing screen resolves within the fake-timer steps below.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the scene of a paired display', async () => {
    render(<PlayerApp api={fakeApi()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(screen.getByText('scene-a')).toBeInTheDocument();
  });

  it('returns to the pairing screen with a new code when the credential is revoked', async () => {
    const startPairing = vi.fn(async () => ({
      code: 'QWERTY',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    }));
    render(
      <PlayerApp
        api={fakeApi({
          manifest: async () => {
            throw new PlayerApiError(401, 'unauthenticated', 'x');
          },
          startPairing,
        })}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(startPairing).toHaveBeenCalledTimes(1);
    expect(screen.getByText('QWERTY')).toBeInTheDocument();
    expect(screen.getByText(/expires in 10:0\d/)).toBeInTheDocument();
  });

  it('reloads into the playing state after pairing succeeded', async () => {
    const onPaired = vi.fn();
    let polls = 0;
    render(
      <PlayerApp
        onPaired={onPaired}
        api={fakeApi({
          manifest: async () => {
            throw new PlayerApiError(401, 'unauthenticated', 'x');
          },
          pollPairing: async () => ({ status: ++polls < 2 ? 'pending' : 'paired' }),
        })}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(onPaired).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_000);
    });
    expect(onPaired).toHaveBeenCalledTimes(1);
  });

  it('explains when the network may not pair displays', async () => {
    render(
      <PlayerApp
        api={fakeApi({
          manifest: async () => {
            throw new PlayerApiError(401, null, 'x');
          },
          startPairing: async () => {
            throw new PlayerApiError(403, 'pairing_network_denied', 'x');
          },
        })}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(screen.getByRole('alert')).toHaveTextContent('This network may not pair displays');
  });
});

describe('PlayerApp rule notices', () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a rule notice above the scene until it ends', async () => {
    const endsAt = new Date(Date.now() + 60_000).toISOString();
    render(
      <PlayerApp
        api={fakeApi({
          live: async () =>
            live({
              ruleNotices: [
                {
                  id: '0192f6f8-743e-7c77-a349-cd07c3e8a950',
                  tone: 'critical',
                  title: 'Fire drill',
                  body: 'Leave the building.',
                  startsAt: new Date(Date.now() - 1000).toISOString(),
                  endsAt,
                },
              ],
            }),
        })}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(screen.getByText('scene-a')).toBeInTheDocument();
    expect(screen.getByText('Fire drill')).toBeInTheDocument();
    expect(screen.getByText('Leave the building.')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(screen.queryByText('Fire drill')).not.toBeInTheDocument();
  });
});
