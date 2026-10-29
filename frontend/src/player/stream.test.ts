import { describe, expect, it, vi } from 'vitest';
import {
  CLOSE_FORBIDDEN,
  CLOSE_GONE,
  closeError,
  KEEP_PLAYED_S,
  LIVE_LAG_S,
  LIVE_MARGIN_S,
  streamSocketUrl,
  tidyBuffer,
} from './stream';
import { jitteredBackoffMs } from './timing';

const path = '/api/v1/signage/player/cameras/0192f6f8-743e-7c77-a349-cd07c3e8a201/stream';

describe('streamSocketUrl', () => {
  it('uses wss on https pages and ws otherwise, always on the page origin', () => {
    expect(streamSocketUrl(path, { protocol: 'https:', host: 'core.example.org' })).toBe(
      `wss://core.example.org${path}`,
    );
    expect(streamSocketUrl(path, { protocol: 'http:', host: 'localhost:5173' })).toBe(`ws://localhost:5173${path}`);
  });
});

describe('closeError', () => {
  it('treats 4403 and 4404 as final and everything else as retryable', () => {
    expect(closeError(CLOSE_FORBIDDEN)).toMatchObject({ code: 'forbidden', final: true, closeCode: 4403 });
    expect(closeError(CLOSE_GONE)).toMatchObject({ code: 'gone', final: true, closeCode: 4404 });
    for (const code of [4503, 1006, 1000, 1011, undefined]) {
      expect(closeError(code)).toMatchObject({ code: 'closed', final: false });
    }
  });
});

describe('tidyBuffer', () => {
  const video = (start: number, end: number, currentTime: number) => ({
    buffered: { length: 1, start: () => start, end: () => end } as unknown as TimeRanges,
    currentTime,
  });
  const buffer = (updating = false) => ({ updating, remove: vi.fn() });

  it('jumps to the live edge when playback lags more than 3 seconds', () => {
    const lagging = video(0, 10, 6.5);
    tidyBuffer(lagging, buffer());
    expect(lagging.currentTime).toBe(10 - LIVE_MARGIN_S);
  });

  it('leaves playback near the live edge alone', () => {
    const close = video(0, 10, 10 - LIVE_LAG_S);
    tidyBuffer(close, buffer());
    expect(close.currentTime).toBe(10 - LIVE_LAG_S);
  });

  it('removes played data older than the keep window', () => {
    const old = video(0, 60, 59.5);
    const sink = buffer();
    tidyBuffer(old, sink);
    expect(sink.remove).toHaveBeenCalledWith(0, 59.5 - KEEP_PLAYED_S);
  });

  it('does nothing while the buffer is updating or empty', () => {
    const busy = video(0, 10, 0);
    tidyBuffer(busy, buffer(true));
    expect(busy.currentTime).toBe(0);
    const empty = { buffered: { length: 0 } as unknown as TimeRanges, currentTime: 0 };
    const sink = buffer();
    tidyBuffer(empty, sink);
    expect(sink.remove).not.toHaveBeenCalled();
  });
});

describe('jitteredBackoffMs', () => {
  it('doubles from 1 s up to 30 s and spreads downwards by at most 20 %', () => {
    const full = (attempt: number) => jitteredBackoffMs(attempt, 1_000, 30_000, () => 1);
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(full)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
    expect(jitteredBackoffMs(5, 1_000, 30_000, () => 0)).toBe(24_000);
  });
});
