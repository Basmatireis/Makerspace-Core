import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveStreams } from './camera';
import { CameraManager, IDLE_GRACE_MS, STREAM_DEADLINE_MS } from './cameraManager';
import type { StreamEnv } from './stream';

const MACHINE = '0192f6f8-743e-7c77-a349-cd07c3e8a201';
const OTHER = '0192f6f8-743e-7c77-a349-cd07c3e8a202';

class FakePeer {
  static all: FakePeer[] = [];
  static autoConnect = true;
  connectionState = 'new';
  iceGatheringState = 'complete';
  localDescription = { sdp: 'v=0 offer' };
  ontrack: ((event: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  closed = false;
  stream = { id: 'stream' };
  constructor() { FakePeer.all.push(this); }
  addEventListener() {}
  removeEventListener() {}
  addTransceiver() {}
  async createOffer() { return { type: 'offer', sdp: 'v=0 offer' }; }
  async setLocalDescription() {}
  async setRemoteDescription() { if (FakePeer.autoConnect) this.up(); }
  up() {
    this.ontrack?.({ streams: [this.stream], track: {} });
    this.connectionState = 'connected';
    this.onconnectionstatechange?.();
  }
  drop() { this.connectionState = 'failed'; this.onconnectionstatechange?.(); }
  close() { this.closed = true; }
}

class FakeSocket {
  static all: FakeSocket[] = [];
  binaryType = '';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(readonly url: string) { FakeSocket.all.push(this); }
  send(text: string) { this.sent.push(text); }
  close() { this.closed = true; }
  receive(data: unknown) { this.onmessage?.({ data }); }
}

class FakeBuffer {
  updating = false;
  mode = '';
  appended: unknown[] = [];
  addEventListener() {}
  appendBuffer(data: unknown) { this.appended.push(data); }
  remove() {}
}

class FakeMediaSource {
  static isTypeSupported = (type: string) => type.includes('avc1.640029');
  static last: FakeMediaSource | null = null;
  readyState = 'open';
  buffer = new FakeBuffer();
  private opener: (() => void) | null = null;
  constructor() { FakeMediaSource.last = this; }
  addEventListener(_name: string, listener: () => void) { this.opener = listener; }
  open() { this.opener?.(); }
  addSourceBuffer() { return this.buffer; }
  endOfStream() {}
}

type FetchPlan = { status: number };
let fetchPlan: FetchPlan = { status: 200 };
const fetchCalls: { url: string; body: string }[] = [];
const fakeFetch = (async (url: string, init: RequestInit) => {
  fetchCalls.push({ url: String(url), body: String(init.body) });
  return { status: fetchPlan.status, ok: fetchPlan.status < 300, text: async () => 'v=0 answer' } as Response;
}) as unknown as typeof fetch;

const env: StreamEnv = {
  RTCPeerConnection: FakePeer as unknown as typeof RTCPeerConnection,
  WebSocket: FakeSocket as unknown as typeof WebSocket,
  MediaSource: FakeMediaSource as unknown as typeof MediaSource,
  fetch: fakeFetch,
};

const stream = (machineId = MACHINE, ticket = 'ticket-1'): LiveStreams[number] => ({
  machineId, ticket, expiresAt: new Date(Date.now() + 300_000).toISOString(),
  webrtcUrl: `https://gw.example.org:8443/api/webrtc?src=cam-${machineId}`, mseUrl: `wss://gw.example.org:8443/api/ws?src=cam-${machineId}`,
} as LiveStreams[number]);

const settle = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe('CameraManager', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    FakePeer.all = []; FakePeer.autoConnect = true; FakeSocket.all = []; fetchCalls.length = 0; fetchPlan = { status: 200 };
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:camera', revokeObjectURL: () => undefined }));
    HTMLMediaElement.prototype.play = vi.fn(async () => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('offers no stream for a machine without a ticket', () => {
    const manager = new CameraManager({ env });
    expect(manager.hasStream(MACHINE)).toBe(false);
    manager.setStreams([stream()]);
    expect(manager.hasStream(MACHINE)).toBe(true);
    manager.setStreams([]);
    expect(manager.hasStream(MACHINE)).toBe(false);
  });

  it('connects over WebRTC with the ticket as query parameter and shows the stream muted and inline', async () => {
    const manager = new CameraManager({ env });
    manager.setStreams([stream()]);
    const view = render(<>{manager.view({ machineId: MACHINE, name: 'Prusa', state: 'printing', progressPercent: null, remainingMinutes: null, stale: false })}</>);
    await settle();
    expect(fetchCalls).toHaveLength(1);
    const url = new URL(fetchCalls[0].url);
    expect(url.searchParams.get('src')).toBe(`cam-${MACHINE}`);
    expect(url.searchParams.get('ticket')).toBe('ticket-1');
    expect(fetchCalls[0].body).toBe('v=0 offer');
    const video = view.container.querySelector('video')!;
    expect(video.muted).toBe(true);
    expect(video.hasAttribute('playsinline')).toBe(true);
    expect(video.autoplay).toBe(true);
    expect(video.srcObject).toBe(FakePeer.all[0].stream);
    expect(manager.hasStream(MACHINE)).toBe(true);
    view.unmount();
    manager.dispose();
  });

  it('falls back to MSE over the websocket when WebRTC signalling fails', async () => {
    fetchPlan = { status: 502 };
    const manager = new CameraManager({ env });
    manager.setStreams([stream()]);
    const release = manager.acquire(MACHINE);
    await settle();
    expect(FakeSocket.all).toHaveLength(1);
    const socket = FakeSocket.all[0];
    expect(new URL(socket.url).searchParams.get('ticket')).toBe('ticket-1');
    socket.onopen?.();
    expect(JSON.parse(socket.sent[0])).toEqual({ type: 'mse', value: 'avc1.640029' });
    expect(manager.feed(MACHINE)).toBeNull();
    socket.receive(JSON.stringify({ type: 'mse', value: 'video/mp4; codecs="avc1.640029"' }));
    const init = new ArrayBuffer(8);
    socket.receive(init);
    await settle();
    const feed = manager.feed(MACHINE);
    expect(feed).not.toBeNull();
    const video = document.createElement('video');
    const detach = feed!.attach(video);
    FakeMediaSource.last!.open();
    expect(FakeMediaSource.last!.buffer.appended).toEqual([init]);
    socket.receive(new ArrayBuffer(4));
    detach();
    release();
    manager.dispose();
  });

  it('falls back to MSE when WebRTC does not come up within its budget', async () => {
    FakePeer.autoConnect = false;
    const manager = new CameraManager({ env });
    manager.setStreams([stream()]);
    manager.acquire(MACHINE);
    await settle(4_100);
    expect(FakePeer.all[0].closed).toBe(true);
    expect(FakeSocket.all).toHaveLength(1);
    manager.dispose();
  });

  it('reports a camera that shows nothing within 8 seconds, without the ticket, and tries again later', async () => {
    fetchPlan = { status: 502 };
    const reports: string[] = [];
    const manager = new CameraManager({ env });
    manager.setErrorSink((message) => reports.push(message));
    manager.setStreams([stream(MACHINE, 'secret-ticket')]);
    const release = manager.acquire(MACHINE);
    await settle(STREAM_DEADLINE_MS + 100);
    expect(manager.hasStream(MACHINE)).toBe(false);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('unavailable');
    expect(reports[0]).not.toContain('secret-ticket');
    expect(reports[0]).not.toContain('gw.example.org');
    release(); // the tile is gone while the fallback shows
    await settle(15_100);
    expect(manager.hasStream(MACHINE)).toBe(true);
    FakePeer.all = [];
    fetchPlan = { status: 200 };
    manager.acquire(MACHINE); // the tile mounts again
    await settle();
    expect(manager.feed(MACHINE)).not.toBeNull();
    manager.dispose();
  });

  it('shares one connection between zones and closes it after the last one is gone', async () => {
    const manager = new CameraManager({ env });
    manager.setStreams([stream()]);
    const first = manager.acquire(MACHINE);
    const second = manager.acquire(MACHINE);
    await settle();
    expect(FakePeer.all).toHaveLength(1);
    first();
    await settle(IDLE_GRACE_MS + 100);
    expect(FakePeer.all[0].closed).toBe(false);
    second();
    await settle(IDLE_GRACE_MS - 100);
    expect(FakePeer.all[0].closed).toBe(false); // still within the grace period
    await settle(200);
    expect(FakePeer.all[0].closed).toBe(true);
    expect(manager.feed(MACHINE)).toBeNull();
    // A tile coming back reconnects.
    manager.acquire(MACHINE);
    await settle();
    expect(FakePeer.all).toHaveLength(2);
    manager.dispose();
  });

  it('closes a connection when Core stops offering the stream', async () => {
    const manager = new CameraManager({ env });
    manager.setStreams([stream(), stream(OTHER)]);
    manager.acquire(MACHINE);
    await settle();
    manager.setStreams([stream(OTHER)]);
    expect(FakePeer.all[0].closed).toBe(true);
    expect(manager.hasStream(MACHINE)).toBe(false);
    manager.dispose();
  });

  it('keeps a healthy stream when a new ticket arrives and reconnects with the newest one after a drop', async () => {
    const manager = new CameraManager({ env });
    manager.setStreams([stream(MACHINE, 'ticket-1')]);
    manager.acquire(MACHINE);
    await settle();
    manager.setStreams([stream(MACHINE, 'ticket-2')]);
    await settle(1_000);
    expect(FakePeer.all).toHaveLength(1);
    expect(FakePeer.all[0].closed).toBe(false);
    FakePeer.all[0].drop();
    await settle(1_100);
    expect(FakePeer.all).toHaveLength(2);
    expect(new URL(fetchCalls[1].url).searchParams.get('ticket')).toBe('ticket-2');
    expect(manager.feed(MACHINE)).not.toBeNull();
    manager.dispose();
  });

  it('does not retry a refused ticket until live data brings a new one', async () => {
    fetchPlan = { status: 401 };
    const manager = new CameraManager({ env });
    manager.setStreams([stream(MACHINE, 'old')]);
    manager.acquire(MACHINE);
    await settle(3_000);
    expect(fetchCalls).toHaveLength(1);
    expect(FakeSocket.all).toHaveLength(0); // MSE would use the same ticket
    fetchPlan = { status: 200 };
    manager.setStreams([stream(MACHINE, 'new')]);
    await settle();
    expect(fetchCalls).toHaveLength(2);
    expect(new URL(fetchCalls[1].url).searchParams.get('ticket')).toBe('new');
    expect(manager.feed(MACHINE)).not.toBeNull();
    manager.dispose();
  });

  it('reconnects an MSE stream closed by the gateway with the newest ticket, without showing the fallback', async () => {
    fetchPlan = { status: 502 };
    const manager = new CameraManager({ env });
    manager.setStreams([stream(MACHINE, 'ticket-1')]);
    manager.acquire(MACHINE);
    await settle();
    const first = FakeSocket.all[0];
    first.receive(JSON.stringify({ type: 'mse', value: 'video/mp4; codecs="avc1.640029"' }));
    first.receive(new ArrayBuffer(8));
    await settle();
    expect(manager.feed(MACHINE)).not.toBeNull();
    manager.setStreams([stream(MACHINE, 'ticket-2')]); // arrives with the next live poll; the healthy stream stays
    expect(first.closed).toBe(false);
    first.onclose?.(); // the gateway closes the websocket when the ticket expires
    await settle(0);
    expect(manager.hasStream(MACHINE)).toBe(true);
    await settle(1_100);
    const second = FakeSocket.all[1];
    expect(new URL(second.url).searchParams.get('ticket')).toBe('ticket-2');
    second.receive(JSON.stringify({ type: 'mse', value: 'video/mp4; codecs="avc1.640029"' }));
    second.receive(new ArrayBuffer(8));
    await settle();
    expect(manager.feed(MACHINE)).not.toBeNull();
    manager.dispose();
  });
});
