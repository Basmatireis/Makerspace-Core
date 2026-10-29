import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveStreams } from './camera';
import { CameraManager, IDLE_GRACE_MS, STREAM_DEADLINE_MS } from './cameraManager';
import type { StreamEnv } from './stream';

const MACHINE = '0192f6f8-743e-7c77-a349-cd07c3e8a201';
const OTHER = '0192f6f8-743e-7c77-a349-cd07c3e8a202';
const MIME = 'video/mp4; codecs="avc1.640029"';

class FakeSocket {
  static all: FakeSocket[] = [];
  binaryType = '';
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(text: string) {
    this.sent.push(text);
  }
  close() {
    this.closed = true;
  }
  receive(data: unknown) {
    this.onmessage?.({ data });
  }
  /** The peer ends the connection with a close code. */
  end(code: number) {
    this.onclose?.({ code });
  }
}

class FakeBuffer {
  updating = false;
  mode = '';
  appended: unknown[] = [];
  addEventListener() {}
  appendBuffer(data: unknown) {
    this.appended.push(data);
  }
  remove() {}
}

class FakeMediaSource {
  static isTypeSupported = (type: string) => type.includes('avc1.640029');
  static last: FakeMediaSource | null = null;
  readyState = 'open';
  buffer = new FakeBuffer();
  private opener: (() => void) | null = null;
  constructor() {
    FakeMediaSource.last = this;
  }
  addEventListener(_name: string, listener: () => void) {
    this.opener = listener;
  }
  open() {
    this.opener?.();
  }
  addSourceBuffer() {
    return this.buffer;
  }
  endOfStream() {}
}

const env: StreamEnv = {
  WebSocket: FakeSocket as unknown as typeof WebSocket,
  MediaSource: FakeMediaSource as unknown as typeof MediaSource,
  location: { protocol: 'https:', host: 'makerspace.example.org' },
};

const stream = (machineId = MACHINE): LiveStreams[number] => ({
  machineId,
  path: `/api/v1/signage/player/cameras/${machineId}/stream`,
});

const settle = (ms = 0) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

/** Plays the go2rtc side of the handshake: the mime text frame, then the initialisation segment. */
const goLive = async (socket: FakeSocket) => {
  socket.onopen?.();
  socket.receive(JSON.stringify({ type: 'mse', value: MIME }));
  socket.receive(new ArrayBuffer(8));
  await settle();
};

describe('CameraManager', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    // Backoff without jitter: the full delay.
    vi.spyOn(Math, 'random').mockReturnValue(1);
    FakeSocket.all = [];
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: () => 'blob:camera', revokeObjectURL: () => undefined }),
    );
    HTMLMediaElement.prototype.play = vi.fn(async () => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('offers no stream for a machine Core does not list', () => {
    const manager = new CameraManager({ env });
    expect(manager.hasStream(MACHINE)).toBe(false);
    manager.setStreams([stream()]);
    expect(manager.hasStream(MACHINE)).toBe(true);
    manager.setStreams([]);
    expect(manager.hasStream(MACHINE)).toBe(false);
  });

  it('connects a same-origin websocket to the listed path and shows the stream muted and inline', async () => {
    const manager = new CameraManager({ env });
    manager.setStreams([stream()]);
    const view = render(
      <>
        {manager.view({
          machineId: MACHINE,
          name: 'Prusa',
          state: 'printing',
          progressPercent: null,
          remainingMinutes: null,
          stale: false,
        })}
      </>,
    );
    await settle();
    expect(FakeSocket.all).toHaveLength(1);
    const socket = FakeSocket.all[0];
    expect(socket.url).toBe(`wss://makerspace.example.org/api/v1/signage/player/cameras/${MACHINE}/stream`);
    expect(socket.binaryType).toBe('arraybuffer');
    socket.onopen?.();
    expect(JSON.parse(socket.sent[0])).toEqual({ type: 'mse', value: 'avc1.640029' });
    expect(manager.feed(MACHINE)).toBeNull();
    await goLive(socket);
    const video = view.container.querySelector('video')!;
    expect(video.muted).toBe(true);
    expect(video.hasAttribute('playsinline')).toBe(true);
    expect(video.autoplay).toBe(true);
    expect(manager.feed(MACHINE)).not.toBeNull();
    view.unmount();
    manager.dispose();
  });

  it('feeds the initialisation segment and later fragments into the video element', async () => {
    const manager = new CameraManager({ env });
    manager.setStreams([stream()]);
    const release = manager.acquire(MACHINE);
    await settle();
    const socket = FakeSocket.all[0];
    socket.onopen?.();
    socket.receive(JSON.stringify({ type: 'mse', value: MIME }));
    const init = new ArrayBuffer(8);
    socket.receive(init);
    await settle();
    const detach = manager.feed(MACHINE)!.attach(document.createElement('video'));
    FakeMediaSource.last!.open();
    expect(FakeMediaSource.last!.buffer.appended).toEqual([init]);
    const fragment = new ArrayBuffer(4);
    socket.receive(fragment);
    expect(FakeMediaSource.last!.buffer.appended).toEqual([init, fragment]);
    detach();
    release();
    manager.dispose();
  });

  it('reports a camera that shows nothing within 8 seconds, without the path, and tries again later', async () => {
    const reports: string[] = [];
    const manager = new CameraManager({ env });
    manager.setErrorSink((message) => reports.push(message));
    manager.setStreams([stream()]);
    const release = manager.acquire(MACHINE);
    await settle(STREAM_DEADLINE_MS + 100);
    expect(manager.hasStream(MACHINE)).toBe(false);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('unavailable');
    expect(reports[0]).not.toContain('/api/');
    expect(reports[0]).not.toContain('makerspace.example.org');
    release(); // the tile is gone while the fallback shows
    await settle(1_100);
    expect(manager.hasStream(MACHINE)).toBe(true);
    const sockets = FakeSocket.all.length;
    manager.acquire(MACHINE); // the tile mounts again
    await settle();
    expect(FakeSocket.all.length).toBe(sockets + 1);
    await goLive(FakeSocket.all[sockets]);
    expect(manager.feed(MACHINE)).not.toBeNull();
    manager.dispose();
  });

  it('shares one connection between zones and closes it after the last one is gone', async () => {
    const manager = new CameraManager({ env });
    manager.setStreams([stream()]);
    const first = manager.acquire(MACHINE);
    const second = manager.acquire(MACHINE);
    await settle();
    await goLive(FakeSocket.all[0]);
    expect(FakeSocket.all).toHaveLength(1);
    first();
    await settle(IDLE_GRACE_MS + 100);
    expect(FakeSocket.all[0].closed).toBe(false);
    second();
    await settle(IDLE_GRACE_MS - 100);
    expect(FakeSocket.all[0].closed).toBe(false); // still within the grace period
    await settle(200);
    expect(FakeSocket.all[0].closed).toBe(true);
    expect(manager.feed(MACHINE)).toBeNull();
    // A tile coming back reconnects.
    manager.acquire(MACHINE);
    await settle();
    expect(FakeSocket.all).toHaveLength(2);
    manager.dispose();
  });

  it('closes a connection when Core stops listing the stream', async () => {
    const manager = new CameraManager({ env });
    manager.setStreams([stream(), stream(OTHER)]);
    manager.acquire(MACHINE);
    await settle();
    await goLive(FakeSocket.all[0]);
    manager.setStreams([stream(OTHER)]);
    expect(FakeSocket.all[0].closed).toBe(true);
    expect(manager.hasStream(MACHINE)).toBe(false);
    manager.dispose();
  });

  it('keeps a healthy stream across live polls', async () => {
    const manager = new CameraManager({ env });
    manager.setStreams([stream()]);
    manager.acquire(MACHINE);
    await settle();
    await goLive(FakeSocket.all[0]);
    manager.setStreams([stream()]);
    await settle(2_000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(FakeSocket.all[0].closed).toBe(false);
    expect(manager.feed(MACHINE)).not.toBeNull();
    manager.dispose();
  });

  it('reconnects a lost connection with exponential backoff without showing the fallback', async () => {
    const manager = new CameraManager({ env });
    manager.setStreams([stream()]);
    manager.acquire(MACHINE);
    await settle();
    await goLive(FakeSocket.all[0]);
    FakeSocket.all[0].end(1006);
    await settle();
    expect(manager.hasStream(MACHINE)).toBe(true);
    expect(manager.feed(MACHINE)).toBeNull();
    await settle(900);
    expect(FakeSocket.all).toHaveLength(1);
    await settle(200); // 1 s
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1].end(1006); // the second attempt fails as well
    await settle(1_900);
    expect(FakeSocket.all).toHaveLength(2);
    await settle(200); // 2 s
    expect(FakeSocket.all).toHaveLength(3);
    await goLive(FakeSocket.all[2]);
    expect(manager.feed(MACHINE)).not.toBeNull();
    // A healthy connection starts the backoff over.
    FakeSocket.all[2].end(1006);
    await settle(1_100);
    expect(FakeSocket.all).toHaveLength(4);
    manager.dispose();
  });

  it('retries with backoff when the local service is offline (4503)', async () => {
    const manager = new CameraManager({ env });
    manager.setStreams([stream()]);
    manager.acquire(MACHINE);
    await settle();
    await goLive(FakeSocket.all[0]);
    FakeSocket.all[0].end(4503);
    await settle(1_100);
    expect(manager.hasStream(MACHINE)).toBe(true);
    expect(FakeSocket.all).toHaveLength(2);
    manager.dispose();
  });

  it.each([4403, 4404])(
    'stops on close code %i and shows the fallback until a live poll lists the stream again',
    async (code) => {
      const reports: string[] = [];
      const manager = new CameraManager({ env });
      manager.setErrorSink((message) => reports.push(message));
      manager.setStreams([stream()]);
      manager.acquire(MACHINE);
      await settle();
      await goLive(FakeSocket.all[0]);
      FakeSocket.all[0].end(code);
      await settle();
      expect(manager.hasStream(MACHINE)).toBe(false);
      expect(manager.feed(MACHINE)).toBeNull();
      expect(reports).toHaveLength(1);
      expect(reports[0]).not.toContain('/api/');
      await settle(10 * 60_000);
      expect(FakeSocket.all).toHaveLength(1); // neither a retry nor a revive
      expect(manager.hasStream(MACHINE)).toBe(false);

      manager.setStreams([stream()]); // the next live poll still lists it
      expect(manager.hasStream(MACHINE)).toBe(true);
      await settle();
      expect(FakeSocket.all).toHaveLength(2);
      await goLive(FakeSocket.all[1]);
      expect(manager.feed(MACHINE)).not.toBeNull();
      manager.dispose();
    },
  );

  it('stops on 4403 before the first picture as well', async () => {
    const manager = new CameraManager({ env });
    manager.setStreams([stream()]);
    manager.acquire(MACHINE);
    await settle();
    FakeSocket.all[0].end(4403);
    await settle(60_000);
    expect(manager.hasStream(MACHINE)).toBe(false);
    expect(FakeSocket.all).toHaveLength(1);
    manager.dispose();
  });

  it('builds the websocket URL from the page protocol', async () => {
    const manager = new CameraManager({ env: { ...env, location: { protocol: 'http:', host: 'localhost:5173' } } });
    manager.setStreams([stream()]);
    manager.acquire(MACHINE);
    await settle();
    expect(FakeSocket.all[0].url).toBe(`ws://localhost:5173/api/v1/signage/player/cameras/${MACHINE}/stream`);
    manager.dispose();
  });
});
