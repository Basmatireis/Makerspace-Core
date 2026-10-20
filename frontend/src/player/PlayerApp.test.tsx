import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerApiError } from './api';
import { PlayerApp } from './PlayerApp';
import { fakeApi } from './testFixtures';

describe('PlayerApp', () => {
  beforeEach(() => {
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
