import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerApiError, PlayerNetworkError, type PlayerApi } from './api';
import { createPlayerStore, type PlayerStore } from './cache';
import { ASSET_CACHE, assetKey, TIMELAPSE_CACHE } from './cacheKeys';
import { openTimelapseCache, type TimelapseEnv } from './timelapseCache';
import { PERSISTED_LIVE_MAX_AGE_MS, PlayerRuntime } from './runtime';
import { fakeCaches, type FakeCaches } from './testCaches';
import { asset, fakeApi, live, manifest, only, rule, scene } from './testFixtures';

/** Advances the fake clock and lets the chains of cache promises finish. */
const settle = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 100; i += 1) await Promise.resolve();
};
const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((a) => {
    resolve = a;
  });
  return { promise, resolve };
};
const offlineApi = (patch: Partial<PlayerApi> = {}) =>
  fakeApi({
    manifest: async () => {
      throw new PlayerNetworkError();
    },
    live: async () => {
      throw new PlayerNetworkError();
    },
    heartbeat: async () => {
      throw new PlayerNetworkError();
    },
    ...patch,
  });

type Env = {
  caches: FakeCaches;
  downloads: string[];
  usage: { usage: number; quota: number };
  store: PlayerStore;
  gate?: Promise<unknown>;
};
function env(options: { gate?: (url: string) => Promise<unknown> | undefined } = {}): Env {
  const caches = fakeCaches();
  const downloads: string[] = [];
  const usage = { usage: 1_000, quota: 100_000 };
  const fetchImpl = (async (url: string) => {
    downloads.push(url);
    await options.gate?.(url);
    return new Response(`content of ${url}`);
  }) as unknown as typeof fetch;
  const store = createPlayerStore({
    caches,
    fetch: fetchImpl,
    storage: { estimate: async () => ({ ...usage }), persist: async () => true },
  })!;
  return { caches, downloads, usage, store };
}

describe('PlayerRuntime offline cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 19, 12, 0, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('activates a revision only after every asset is in the cache, and persists it', async () => {
    const gate = deferred();
    const slow = asset('img-2');
    const { store, caches } = env({ gate: (url) => (url === slow.url ? gate.promise : undefined) });
    let latest = manifest(1);
    const api = fakeApi({
      manifest: async (known) =>
        known === latest.revision ? { unchanged: true } : { unchanged: false, manifest: latest },
      live: async () => live({ revision: latest.revision }),
    });
    const runtime = new PlayerRuntime({ api, store });
    runtime.start();
    await settle();
    expect(runtime.getSnapshot().revision).toBe(1);

    latest = manifest(2, { assets: [asset('img-1'), slow] });
    await settle(10_000);
    expect(caches.keysOf(ASSET_CACHE)).toContain(assetKey(asset('img-1').sha256));
    expect(caches.keysOf(ASSET_CACHE)).not.toContain(assetKey(slow.sha256));
    expect(runtime.getSnapshot().revision).toBe(1);
    expect((await store.loadManifest())?.revision).toBe(1);

    gate.resolve();
    await settle();
    expect(runtime.getSnapshot().revision).toBe(2);
    expect((await store.loadManifest())?.revision).toBe(2);
    expect(await store.hasAll(latest.assets)).toBe(true);
    runtime.stop();
  });

  it('evicts assets the active revision no longer references', async () => {
    const { store, caches } = env();
    let latest = manifest(1, { assets: [asset('old-1'), asset('shared')] });
    const api = fakeApi({
      manifest: async (known) =>
        known === latest.revision ? { unchanged: true } : { unchanged: false, manifest: latest },
      live: async () => live({ revision: latest.revision }),
    });
    const runtime = new PlayerRuntime({ api, store });
    runtime.start();
    await settle();
    expect(caches.keysOf(ASSET_CACHE)).toHaveLength(2);
    latest = manifest(2, { assets: [asset('shared'), asset('new-1')] });
    await settle(10_000);
    expect(runtime.getSnapshot().revision).toBe(2);
    expect(caches.keysOf(ASSET_CACHE).sort()).toEqual(
      [assetKey(asset('new-1').sha256), assetKey(asset('shared').sha256)].sort(),
    );
    runtime.stop();
  });

  it('plays the persisted revision on a cold start without network (and does not show pairing)', async () => {
    const { store } = env();
    const first = new PlayerRuntime({
      api: fakeApi({
        manifest: async () => ({ unchanged: false, manifest: manifest(7, { assets: [asset('img-1')] }) }),
      }),
      store,
    });
    first.start();
    await settle();
    first.stop();

    const second = new PlayerRuntime({ api: offlineApi(), store });
    second.start();
    await settle(5_000);
    expect(second.getSnapshot()).toMatchObject({ status: 'playing', revision: 7, online: false });
    expect(second.getSnapshot().view?.sceneId).toBe('scene-a');
    expect(second.getSnapshot().view?.data.assetUrl('img-1')).toBe(asset('img-1').url);
    second.stop();
  });

  it('does not restore a revision whose assets went missing', async () => {
    const { store, caches } = env();
    await store.saveManifest(manifest(7, { assets: [asset('img-1')] }));
    expect(caches.keysOf(ASSET_CACHE)).toEqual([]);
    const runtime = new PlayerRuntime({ api: offlineApi(), store });
    runtime.start();
    await settle(5_000);
    expect(runtime.getSnapshot()).toMatchObject({ status: 'starting', revision: null });
    runtime.stop();
  });

  it('forgets everything when the credential is revoked', async () => {
    const { store, caches } = env();
    await store.ensureAsset(asset('img-1'));
    await store.saveManifest(manifest(7, { assets: [asset('img-1')] }));
    const runtime = new PlayerRuntime({
      api: fakeApi({
        manifest: async () => {
          throw new PlayerApiError(401, null, 'x');
        },
      }),
      store,
    });
    runtime.start();
    await settle();
    expect(runtime.getSnapshot().status).toBe('revoked');
    expect(caches.keysOf(ASSET_CACHE)).toEqual([]);
    expect(await store.loadManifest()).toBeNull();
  });

  describe('live data lifetime', () => {
    const announcement = (id: string, endsAt: string | null) =>
      ({
        id,
        templateId: 't',
        tone: 'info',
        title: id,
        body: '',
        startsAt: new Date(2026, 9, 19, 8).toISOString(),
        endsAt,
      }) as never;
    const machine = {
      machineId: 'm1',
      name: 'H2D',
      state: 'printing' as const,
      progressPercent: 10,
      remainingMinutes: 5,
      observedAt: null,
      stale: false,
    };

    async function seed(store: PlayerStore, savedAgoMs: number) {
      await store.saveManifest(manifest(1));
      await store.saveLive({
        savedAt: Date.now() - savedAgoMs,
        skewMs: 0,
        announcements: [
          announcement('timed', new Date(2026, 9, 19, 14).toISOString()),
          announcement('expired', new Date(2026, 9, 19, 11).toISOString()),
          announcement('open', null),
        ],
        openDays: [{ startsAt: 'a', endsAt: 'b', status: 'open', competencies: [] }],
        events: [],
      });
    }

    describe('announcement images', () => {
      const withImage = (id: string, image: ReturnType<typeof asset> | null) =>
        ({
          ...(announcement(id, null) as object),
          color: '#0f62fe',
          textColor: '#ffffff',
          image: image && { assetId: image.id, sha256: image.sha256, url: image.url },
        }) as never;

      it('caches the image of a listed announcement, keeps it offline and evicts it when unlisted', async () => {
        const { store, caches } = env();
        const photo = asset('photo');
        let announcements = [withImage('a', photo)];
        const online = new PlayerRuntime({
          api: fakeApi({
            manifest: async () => ({ unchanged: false, manifest: manifest(1, { assets: [asset('img-1')] }) }),
            live: async () => live({ announcements }),
          }),
          store,
        });
        online.start();
        await settle(5_000);
        expect(caches.keysOf(ASSET_CACHE)).toContain(assetKey(photo.sha256));
        expect(caches.keysOf(ASSET_CACHE)).toContain(assetKey(asset('img-1').sha256));
        online.stop();

        // Offline restart: the persisted announcement still names the cached image, and a new revision keeps it.
        const offline = new PlayerRuntime({ api: offlineApi(), store });
        offline.start();
        await settle(5_000);
        expect(offline.getSnapshot().view?.data.announcements[0]).toMatchObject({
          color: '#0f62fe',
          textColor: '#ffffff',
          imageUrl: photo.url,
        });
        expect(caches.keysOf(ASSET_CACHE)).toContain(assetKey(photo.sha256));
        offline.stop();

        // Unlisted images go; the manifest's assets stay.
        announcements = [];
        const later = new PlayerRuntime({
          api: fakeApi({
            manifest: async () => ({ unchanged: true }),
            live: async () => live({ announcements }),
          }),
          store,
        });
        later.start();
        await settle(5_000);
        expect(caches.keysOf(ASSET_CACHE)).toEqual([assetKey(asset('img-1').sha256)]);
        later.stop();
      });

      it('keeps listed images when a new revision evicts the old assets', async () => {
        const { store, caches } = env();
        const photo = asset('photo');
        let latest = manifest(1, { assets: [asset('img-1')] });
        const runtime = new PlayerRuntime({
          api: fakeApi({
            manifest: async (known) =>
              known === latest.revision ? { unchanged: true } : { unchanged: false, manifest: latest },
            live: async () => live({ announcements: [withImage('a', photo)] }),
          }),
          store,
        });
        runtime.start();
        await settle(5_000);
        latest = manifest(2, { assets: [asset('img-2')] });
        await runtime.refreshManifest();
        await settle(5_000);
        expect(caches.keysOf(ASSET_CACHE).sort()).toEqual(
          [assetKey(photo.sha256), assetKey(asset('img-2').sha256)].sort(),
        );
        runtime.stop();
      });
    });

    it('shows persisted announcements and open days after an offline restart, never machines', async () => {
      const { store } = env();
      await seed(store, 3_600_000);
      const runtime = new PlayerRuntime({ api: offlineApi(), store });
      runtime.start();
      await settle(5_000);
      const data = runtime.getSnapshot().view?.data;
      expect(data?.announcements.map((item) => item.id)).toEqual(['timed', 'open']);
      expect(data?.openDays).toHaveLength(1);
      expect(data?.machines).toEqual([]);
      expect(data?.liveAvailable).toBe(false);
      runtime.stop();
    });

    it('drops persisted live data older than the maximum age', async () => {
      const { store } = env();
      await seed(store, PERSISTED_LIVE_MAX_AGE_MS + 1_000);
      const runtime = new PlayerRuntime({ api: offlineApi(), store });
      runtime.start();
      await settle(5_000);
      expect(runtime.getSnapshot().view?.data.announcements).toEqual([]);
      expect(runtime.getSnapshot().view?.data.openDays).toEqual([]);
      runtime.stop();
    });

    it('persists the live calendar like open days and restores it after an offline restart', async () => {
      const { store } = env();
      const calendar = {
        from: '2026-09-24',
        to: '2026-12-10',
        holidays: [{ date: '2026-10-26', name: 'National Day' }],
        breaks: [],
        openDays: [],
        events: [],
      };
      const online = new PlayerRuntime({
        api: fakeApi({
          manifest: async () => ({ unchanged: false, manifest: manifest(1) }),
          live: async () => live({ calendar }),
        }),
        store,
      });
      online.start();
      await settle(5_000);
      expect(online.getSnapshot().view?.data.calendar).toEqual(calendar);
      online.stop();
      expect((await store.loadLive())?.calendar).toEqual(calendar);

      const offline = new PlayerRuntime({ api: offlineApi(), store });
      offline.start();
      await settle(5_000);
      const data = offline.getSnapshot().view?.data;
      expect(data?.calendar).toEqual(calendar);
      offline.stop();
    });

    it('copes with live data saved before calendars existed', async () => {
      const { store } = env();
      await seed(store, 3_600_000); // saved without a calendar
      const runtime = new PlayerRuntime({ api: offlineApi(), store });
      runtime.start();
      await settle(5_000);
      expect(runtime.getSnapshot().view?.data.calendar).toBeNull();
      runtime.stop();
    });

    it('keeps announcements until endsAt while offline and marks machines unknown after 60 s', async () => {
      const { store } = env();
      let offline = false;
      const endsAt = new Date(2026, 9, 19, 12, 5, 0).toISOString();
      const runtime = new PlayerRuntime({
        api: fakeApi({
          live: async () => {
            if (offline) throw new PlayerNetworkError();
            return live({
              announcements: [announcement('a', endsAt), announcement('open', null)],
              machines: [machine],
            });
          },
        }),
        store,
      });
      runtime.start();
      await settle();
      expect(runtime.getSnapshot().view?.data).toMatchObject({ liveAvailable: true });
      offline = true;
      await settle(70_000);
      const data = runtime.getSnapshot().view?.data;
      expect(data?.liveAvailable).toBe(false);
      expect(data?.announcements.map((item) => item.id)).toEqual(['a', 'open']);
      await settle(5 * 60_000);
      expect(runtime.getSnapshot().view?.data.announcements.map((item) => item.id)).toEqual(['open']);
      runtime.stop();
    });

    it('rewrites unchanged live data only every few minutes', async () => {
      const { store } = env();
      const save = vi.spyOn(store, 'saveLive');
      const runtime = new PlayerRuntime({ api: fakeApi(), store });
      runtime.start();
      await settle(60_000);
      expect(save).toHaveBeenCalledTimes(1);
      await settle(5 * 60_000);
      expect(save.mock.calls.length).toBeLessThanOrEqual(3);
      runtime.stop();
    });
  });

  describe('pairing state', () => {
    it('sends no live poll or heartbeat while the device has no credential', async () => {
      const heartbeat = vi.fn(async () => undefined);
      const liveCall = vi.fn(async () => live());
      const runtime = new PlayerRuntime({
        api: fakeApi({
          manifest: async () => {
            throw new PlayerApiError(401, null, 'x');
          },
          heartbeat,
          live: liveCall,
        }),
        store: null,
      });
      runtime.start();
      await settle(60_000);
      expect(heartbeat).not.toHaveBeenCalled();
      expect(liveCall).not.toHaveBeenCalled();
      expect(runtime.getSnapshot().status).toBe('revoked');
    });

    it('waits for the first answer of the manifest call before the other loops start', async () => {
      const first = deferred<void>();
      const heartbeat = vi.fn(async () => undefined);
      const liveCall = vi.fn(async () => live());
      const runtime = new PlayerRuntime({
        api: fakeApi({
          manifest: async () => {
            await first.promise;
            return { unchanged: false, manifest: manifest(1) };
          },
          heartbeat,
          live: liveCall,
        }),
        store: null,
        loadAsset: async () => 'ready',
      });
      runtime.start();
      await settle(5_000);
      expect(heartbeat).not.toHaveBeenCalled();
      expect(liveCall).not.toHaveBeenCalled();
      first.resolve();
      await settle();
      expect(heartbeat).toHaveBeenCalledTimes(1);
      expect(liveCall).toHaveBeenCalledTimes(1);
      runtime.stop();
    });

    it('stays quiet and keeps retrying when a first start has no network and nothing cached', async () => {
      const heartbeat = vi.fn(async () => undefined);
      const manifestCall = vi.fn(async () => {
        throw new PlayerNetworkError();
      });
      const runtime = new PlayerRuntime({ api: fakeApi({ manifest: manifestCall, heartbeat }), store: env().store });
      runtime.start();
      await settle(60_000);
      expect(manifestCall.mock.calls.length).toBeGreaterThan(1);
      expect(heartbeat).not.toHaveBeenCalled();
      expect(runtime.getSnapshot().status).toBe('starting');
      runtime.stop();
    });

    it('starts the loops when the display is paired but not published yet', async () => {
      const heartbeat = vi.fn(async () => undefined);
      const runtime = new PlayerRuntime({
        api: fakeApi({
          manifest: async () => {
            throw new PlayerApiError(404, 'signage_not_published', 'x');
          },
          heartbeat,
        }),
        store: null,
      });
      runtime.start();
      await settle();
      expect(heartbeat).toHaveBeenCalledTimes(1);
      runtime.stop();
    });

    it('still returns to pairing on a 401 while playing', async () => {
      let revoked = false;
      const runtime = new PlayerRuntime({
        api: fakeApi({
          live: async () => {
            if (revoked) throw new PlayerApiError(401, null, 'x');
            return live();
          },
        }),
        store: env().store,
      });
      runtime.start();
      await settle();
      revoked = true;
      await settle(10_000);
      expect(runtime.getSnapshot().status).toBe('revoked');
    });
  });

  describe('storage quota', () => {
    it('refuses a revision whose assets do not fit, keeps the old one and reports it', async () => {
      const { store, usage, downloads } = env();
      usage.quota = 10_000;
      let latest = manifest(1);
      const api = fakeApi({
        manifest: async (known) =>
          known === latest.revision ? { unchanged: true } : { unchanged: false, manifest: latest },
        live: async () => live({ revision: latest.revision }),
      });
      const runtime = new PlayerRuntime({ api, store });
      runtime.start();
      await settle();
      latest = manifest(2, { assets: [asset('huge', 'video', 50_000)], scenes: [scene('scene-a')] });
      await settle(10_000);
      expect(runtime.getSnapshot().revision).toBe(1);
      expect(downloads).toEqual([]);
      expect(runtime.heartbeatPayload().errors.join(' ')).toMatch(/Revision 2 not activated: Not enough storage/);
      expect((await store.loadManifest())?.revision).toBe(1);
      runtime.stop();
    });

    it('refuses when the disk fills up during the download and removes the partial download', async () => {
      const { store, caches } = env();
      let latest = manifest(1, { assets: [asset('keep')] });
      const api = fakeApi({
        manifest: async (known) =>
          known === latest.revision ? { unchanged: true } : { unchanged: false, manifest: latest },
        live: async () => live({ revision: latest.revision }),
      });
      const runtime = new PlayerRuntime({ api, store });
      runtime.start();
      await settle();
      latest = manifest(2, { assets: [asset('fresh')] });
      caches.failPuts(true);
      await settle(10_000);
      caches.failPuts(false);
      expect(runtime.getSnapshot().revision).toBe(1);
      expect(runtime.heartbeatPayload().errors.join(' ')).toContain('Revision 2 not activated');
      expect(caches.keysOf(ASSET_CACHE)).toEqual([assetKey(asset('keep').sha256)]);
      await settle(60_000); // the next poll succeeds once space is back
      expect(runtime.getSnapshot().revision).toBe(2);
      runtime.stop();
    });

    it('reports cache usage and quota in the heartbeat', async () => {
      const { store, usage } = env();
      usage.usage = 123;
      usage.quota = 456_789;
      const heartbeat = vi.fn(async () => undefined);
      const runtime = new PlayerRuntime({ api: fakeApi({ heartbeat }), store });
      runtime.start();
      await settle(1_000);
      expect(heartbeat).toHaveBeenLastCalledWith(
        expect.objectContaining({ cacheUsedBytes: 123, cacheQuotaBytes: 456_789 }),
      );
      runtime.stop();
    });

    it('asks for persistent storage', async () => {
      const persist = vi.fn(async () => true);
      const store = createPlayerStore({
        caches: fakeCaches(),
        storage: { estimate: async () => ({ usage: 0, quota: 1 }), persist },
      })!;
      const runtime = new PlayerRuntime({ api: fakeApi(), store });
      runtime.start();
      await settle();
      expect(persist).toHaveBeenCalled();
      runtime.stop();
    });
  });

  it('uses rules with the persisted manifest offline (time windows keep working)', async () => {
    const { store } = env();
    await store.saveManifest(manifest(1, { rules: [rule('offline', { scenes: only('scene-b') })] }));
    const runtime = new PlayerRuntime({ api: offlineApi(), store });
    runtime.start();
    await settle(5_000);
    expect(runtime.getSnapshot().view?.sceneId).toBe('scene-b'); // live_data_unavailable matches
    runtime.stop();
  });

  it('does not restore a persisted manifest of an older shape (no manifestVersion, or before blocks)', async () => {
    for (const manifestVersion of [undefined, 3]) {
      const { store } = env();
      await store.saveManifest({ ...manifest(1), manifestVersion } as unknown as ReturnType<typeof manifest>);
      const runtime = new PlayerRuntime({ api: offlineApi(), store });
      runtime.start();
      await settle(5_000);
      expect(runtime.getSnapshot().view).toBeNull();
      runtime.stop();
    }
  });

  it('restores a persisted manifest of version 4 and refetches an old one once the server answers', async () => {
    const { store } = env();
    await store.saveManifest(manifest(1));
    const offline = new PlayerRuntime({ api: offlineApi(), store });
    offline.start();
    await settle(5_000);
    expect(offline.getSnapshot().view?.sceneId).toBe('scene-a');
    offline.stop();

    await store.saveManifest({ ...manifest(1), manifestVersion: 3 });
    let known: number | null = -1;
    const online = new PlayerRuntime({
      api: fakeApi({
        manifest: async (revision) => {
          known = revision;
          return { unchanged: false, manifest: manifest(2) };
        },
      }),
      store,
    });
    online.start();
    await settle(5_000);
    // The old revision is not offered as known: the server sends the whole current manifest.
    expect(known).toBeNull();
    expect(online.getSnapshot().view?.sceneId).toBe('scene-a');
    expect((await store.loadManifest())?.manifestVersion).toBe(4);
    online.stop();
  });

  describe('timelapses', () => {
    const SHA = 'ab'.repeat(32);
    const clip = {
      runId: 'r1',
      machineId: 'm1',
      machineName: 'MK4',
      endedAt: new Date(2026, 9, 18).toISOString(),
      sha256: SHA,
      sizeBytes: 100,
      url: `/api/v1/signage/player/timelapses/r1/${SHA}`,
    };
    const opener = (setup: Env) => {
      const opened: string[] = [];
      const open = (hooks: TimelapseEnv) => {
        opened.push('open');
        return openTimelapseCache({
          ...hooks,
          caches: setup.caches,
          fetch: (async (url: string) => {
            setup.downloads.push(url);
            return new Response('video');
          }) as unknown as typeof fetch,
          storage: { estimate: async () => ({ ...setup.usage }) },
        });
      };
      return { opened, open };
    };

    it('plays a clip once it is cached, persists the list and restores it offline', async () => {
      const setup = env();
      const { opened, open } = opener(setup);
      const online = new PlayerRuntime({
        api: fakeApi({
          manifest: async () => ({ unchanged: false, manifest: manifest(1) }),
          live: async () => live({ timelapses: [clip] }),
        }),
        store: setup.store,
        openTimelapses: open,
      });
      online.start();
      await settle(5_000);
      const data = online.getSnapshot().view?.data;
      expect(data?.timelapses).toEqual([clip]);
      expect(data?.timelapseUrl?.(clip)).toBe(clip.url);
      expect(setup.caches.keysOf(TIMELAPSE_CACHE)).toEqual([clip.url]);
      expect(data?.timelapseUrl?.({ ...clip, url: '/api/v1/signage/player/timelapses/r2/x' })).toBeNull();
      expect(opened).toHaveLength(1);
      online.stop();
      expect((await setup.store.loadLive())?.timelapses).toEqual([clip]);

      const offline = new PlayerRuntime({ api: offlineApi(), store: setup.store, openTimelapses: open });
      offline.start();
      await settle(5_000);
      const restored = offline.getSnapshot().view?.data;
      expect(restored?.timelapses).toEqual([clip]);
      expect(restored?.timelapseUrl?.(clip)).toBe(clip.url);
      offline.stop();
    });

    it('never loads the clip cache for a display without timelapses', async () => {
      const setup = env();
      const { opened, open } = opener(setup);
      const runtime = new PlayerRuntime({
        api: fakeApi({ manifest: async () => ({ unchanged: false, manifest: manifest(1) }), live: async () => live() }),
        store: setup.store,
        openTimelapses: open,
      });
      runtime.start();
      await settle(15_000);
      expect(opened).toEqual([]);
      expect(runtime.getSnapshot().view?.data.timelapses).toBeNull();
      runtime.stop();
    });

    it('streams the clips from the network without Cache Storage', async () => {
      const setup = env();
      const { opened, open } = opener(setup);
      const runtime = new PlayerRuntime({
        api: fakeApi({
          manifest: async () => ({ unchanged: false, manifest: manifest(1) }),
          live: async () => live({ timelapses: [clip] }),
        }),
        store: null,
        loadAsset: async () => 'ready',
        openTimelapses: open,
      });
      runtime.start();
      await settle(5_000);
      expect(runtime.getSnapshot().view?.data.timelapseUrl?.(clip)).toBe(clip.url);
      expect(opened).toEqual([]);
      runtime.stop();
    });

    it('removes the clips when the display is revoked', async () => {
      const setup = env();
      const { open } = opener(setup);
      let revoked = false;
      const runtime = new PlayerRuntime({
        api: fakeApi({
          manifest: async () => ({ unchanged: false, manifest: manifest(1) }),
          live: async () => {
            if (revoked) throw new PlayerApiError(401, null, 'x');
            return live({ timelapses: [clip] });
          },
        }),
        store: setup.store,
        openTimelapses: open,
      });
      runtime.start();
      await settle(5_000);
      expect(setup.caches.keysOf(TIMELAPSE_CACHE)).toEqual([clip.url]);
      revoked = true;
      await settle(11_000);
      expect(setup.caches.keysOf(TIMELAPSE_CACHE)).toEqual([]);
      runtime.stop();
    });
  });
});
