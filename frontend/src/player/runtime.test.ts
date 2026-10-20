import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignagePlayerHeartbeat } from '../api/generated/models';
import { PlayerApiError, PlayerNetworkError } from './api';
import type { AssetLoader } from './assets';
import { noCameraSource, type CameraSource } from './camera';
import { PlayerRuntime } from './runtime';
import { asset, fakeApi, live, manifest, rule, scene } from './testFixtures';

const settle = async (ms = 0) => { await vi.advanceTimersByTimeAsync(ms); };
const deferred = <T = void>() => { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

describe('PlayerRuntime', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 19, 12, 0, 0)); });
  afterEach(() => { vi.useRealTimers(); });

  it('plays the first revision once it is loaded', async () => {
    const runtime = new PlayerRuntime({ api: fakeApi(), loadAsset: async () => 'ready' });
    runtime.start();
    await settle();
    expect(runtime.getSnapshot()).toMatchObject({ status: 'playing', revision: 1, online: true });
    expect(runtime.getSnapshot().view?.sceneId).toBe('scene-a');
    runtime.stop();
  });

  it('activates a new revision only after all its assets are loaded', async () => {
    const gate = deferred<'ready'>();
    const loaded: string[] = [];
    const loadAsset: AssetLoader = (item) => { loaded.push(item.id); return item.id === 'img-2' ? gate.promise : Promise.resolve('ready'); };
    let latest = manifest(1);
    const api = fakeApi({ manifest: async (known) => (known === latest.revision ? { unchanged: true } : { unchanged: false, manifest: latest }), live: async () => live({ revision: latest.revision }) });
    const runtime = new PlayerRuntime({ api, loadAsset });
    runtime.start();
    await settle();
    expect(runtime.getSnapshot().revision).toBe(1);

    latest = manifest(2, { assets: [asset('img-1'), asset('img-2')], scenes: [scene('scene-a'), scene('scene-b')], rules: [rule('r', { targetId: 'scene-b' })] });
    await settle(10_000); // the next live poll reports revision 2
    expect(loaded).toEqual(['img-1', 'img-2']);
    expect(runtime.getSnapshot().revision).toBe(1); // still the old one while img-2 loads
    await settle(5_000);
    expect(runtime.getSnapshot().revision).toBe(1);

    gate.resolve('ready');
    await settle();
    expect(runtime.getSnapshot().revision).toBe(2);
    expect(runtime.getSnapshot().view?.data.assetUrl('img-1')).toBe(asset('img-1').url);
    runtime.stop();
  });

  it('keeps the old revision when an asset fails and reports it in the heartbeat', async () => {
    let latest = manifest(1);
    const loadAsset: AssetLoader = async (item) => { if (item.id === 'broken') throw new Error('x'); return 'ready'; };
    const api = fakeApi({ manifest: async () => ({ unchanged: false, manifest: latest }), live: async () => live({ revision: latest.revision }) });
    const runtime = new PlayerRuntime({ api, loadAsset });
    runtime.start();
    await settle();
    latest = manifest(2, { assets: [asset('broken')] });
    await settle(60_000);
    expect(runtime.getSnapshot().revision).toBe(1);
    expect(runtime.heartbeatPayload().errors.join(' ')).toContain('Revision 2');
    runtime.stop();
  });

  it('sends the heartbeat payload every 30 s', async () => {
    const heartbeat = vi.fn<(body: SignagePlayerHeartbeat) => Promise<void>>(async () => undefined);
    const runtime = new PlayerRuntime({ api: fakeApi({ heartbeat }), loadAsset: async () => 'ready', playerVersion: '9.9.9' });
    runtime.start();
    await settle(31_000);
    expect(heartbeat.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(heartbeat).toHaveBeenLastCalledWith({ revision: 1, currentRule: 'default', currentSceneId: 'scene-a', playerVersion: '9.9.9', cacheUsedBytes: 0, cacheQuotaBytes: 0, errors: [] });
    expect(heartbeat.mock.calls[0][0]).toMatchObject({ revision: null, currentRule: null, currentSceneId: null });
    runtime.stop();
  });

  it('goes back to pairing (revoked) on 401 or 403', async () => {
    for (const status of [401, 403]) {
      const runtime = new PlayerRuntime({ api: fakeApi({ manifest: async () => { throw new PlayerApiError(status, 'x', 'x'); } }) });
      runtime.start();
      await settle();
      expect(runtime.getSnapshot().status).toBe('revoked');
      runtime.stop();
    }
    const live401 = new PlayerRuntime({ api: fakeApi({ live: async () => { throw new PlayerApiError(401, null, 'x'); } }), loadAsset: async () => 'ready' });
    live401.start();
    await settle();
    expect(live401.getSnapshot().status).toBe('revoked');
    expect(live401.getSnapshot().view).toBeNull();
    const heartbeat401 = new PlayerRuntime({ api: fakeApi({ heartbeat: async () => { throw new PlayerApiError(401, null, 'x'); } }), loadAsset: async () => 'ready' });
    heartbeat401.start();
    await settle();
    expect(heartbeat401.getSnapshot().status).toBe('revoked');
  });

  it('waits for content before the first publication', async () => {
    const runtime = new PlayerRuntime({ api: fakeApi({ manifest: async () => { throw new PlayerApiError(404, 'signage_not_published', 'x'); } }) });
    runtime.start();
    await settle();
    expect(runtime.getSnapshot()).toMatchObject({ status: 'unpublished', view: null });
    runtime.stop();
  });

  it('keeps playing offline, shows the offline state and backs off', async () => {
    let offline = false;
    const liveCalls = vi.fn(async () => { if (offline) throw new PlayerNetworkError(); return live(); });
    const runtime = new PlayerRuntime({ api: fakeApi({ live: liveCalls, manifest: async () => { if (offline) throw new PlayerNetworkError(); return { unchanged: false, manifest: manifest(1) }; } }), loadAsset: async () => 'ready' });
    runtime.start();
    await settle();
    offline = true;
    await settle(10_000);
    expect(runtime.getSnapshot()).toMatchObject({ status: 'playing', online: false, revision: 1 });
    expect(runtime.getSnapshot().view).not.toBeNull();
    const before = liveCalls.mock.calls.length;
    await settle(120_000);
    // Backoff: far fewer than the 12 polls a fixed 10 s interval would make.
    expect(liveCalls.mock.calls.length - before).toBeLessThan(8);
    offline = false;
    await settle(130_000);
    expect(runtime.getSnapshot().online).toBe(true);
    runtime.stop();
  });

  it('switches to the live_data_unavailable rule after 60 s without a successful poll', async () => {
    let failing = false;
    const api = fakeApi({
      manifest: async () => ({ unchanged: false, manifest: manifest(1, { rules: [rule('offline', { targetId: 'scene-b' })] }) }),
      live: async () => { if (failing) throw new PlayerNetworkError(); return live(); },
    });
    const runtime = new PlayerRuntime({ api, loadAsset: async () => 'ready' });
    runtime.start();
    await settle();
    expect(runtime.getSnapshot().view?.sceneId).toBe('scene-a');
    failing = true;
    await settle(50_000);
    expect(runtime.getSnapshot().view?.sceneId).toBe('scene-a');
    await settle(20_000);
    expect(runtime.getSnapshot().view?.sceneId).toBe('scene-b');
    expect(runtime.getSnapshot().view?.data.liveAvailable).toBe(false);
    runtime.stop();
  });

  it('holds a rule for its minimum display time', async () => {
    let printing = true;
    const machine = () => ({ machineId: 'm1', name: 'H2D', state: printing ? ('printing' as const) : ('idle' as const), progressPercent: null, remainingMinutes: null, observedAt: null, stale: false });
    const api = fakeApi({
      manifest: async () => ({ unchanged: false, manifest: manifest(1, { rules: [rule('print', { kind: 'machine_printing', machineIds: ['m1'], machineMatch: 'any', targetId: 'scene-b', minSeconds: 45 })] }) }),
      live: async () => live({ machines: [machine()] }),
    });
    const runtime = new PlayerRuntime({ api, loadAsset: async () => 'ready' });
    runtime.start();
    await settle();
    expect(runtime.getSnapshot().view?.sceneId).toBe('scene-b');
    printing = false;
    await settle(20_000);
    expect(runtime.getSnapshot().view?.sceneId).toBe('scene-b');
    await settle(30_000);
    expect(runtime.getSnapshot().view?.sceneId).toBe('scene-a');
    runtime.stop();
  });

  it('hands the streams of every live poll to the camera source and reports its problems in the heartbeat', async () => {
    let report: (message: string) => void = () => undefined;
    const setStreams = vi.fn();
    const dispose = vi.fn();
    const camera: CameraSource = { ...noCameraSource, setStreams, dispose, setErrorSink: (sink) => { report = sink; } };
    const streams = [{ machineId: 'm1', webrtcUrl: 'https://gw/api/webrtc?src=a', mseUrl: 'wss://gw/api/ws?src=a', ticket: 't', expiresAt: new Date().toISOString() }];
    const runtime = new PlayerRuntime({ api: fakeApi({ live: async () => live({ streams }) }), loadAsset: async () => 'ready', camera });
    runtime.start();
    await settle();
    expect(setStreams).toHaveBeenCalledWith(streams);
    report('Camera m1 unavailable: no picture within 8 seconds');
    expect(runtime.heartbeatPayload().errors).toContain('Camera m1 unavailable: no picture within 8 seconds');
    runtime.stop();
    expect(dispose).toHaveBeenCalled();
  });
});
