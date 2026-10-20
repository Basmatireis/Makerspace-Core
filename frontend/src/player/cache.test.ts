import { describe, expect, it } from 'vitest';
import { CacheQuotaError, createPlayerStore } from './cache';
import { ASSET_CACHE, assetKey } from './cacheKeys';
import { assetKey as workerAssetKey } from './swCore';
import { asset, manifest } from './testFixtures';
import { fakeCaches } from './testCaches';

const okFetch = (async () => new Response('bytes')) as unknown as typeof fetch;

describe('player store', () => {
  it('has no store without Cache Storage', () => {
    expect(createPlayerStore({ fetch: okFetch })).toBeNull(); // jsdom has no Cache Storage
  });

  it('keeps the worker and page cache keys in step', () => {
    expect(workerAssetKey('ab'.repeat(32))).toBe(assetKey('ab'.repeat(32)));
  });

  it('caches an asset once, keyed by sha256', async () => {
    const caches = fakeCaches();
    let downloads = 0;
    const store = createPlayerStore({
      caches,
      fetch: (async () => {
        downloads += 1;
        return new Response('x');
      }) as unknown as typeof fetch,
    })!;
    await store.ensureAsset(asset('img-1'));
    await store.ensureAsset(asset('img-1'));
    expect(downloads).toBe(1);
    expect(caches.keysOf(ASSET_CACHE)).toEqual([assetKey(asset('img-1').sha256)]);
  });

  it('rejects a failing download and caches nothing', async () => {
    const caches = fakeCaches();
    const store = createPlayerStore({
      caches,
      fetch: (async () => new Response('no', { status: 500 })) as unknown as typeof fetch,
    })!;
    await expect(store.ensureAsset(asset('img-1'))).rejects.toThrow('500');
    expect(caches.keysOf(ASSET_CACHE)).toEqual([]);
  });

  it('turns a full disk into a CacheQuotaError', async () => {
    const caches = fakeCaches();
    const store = createPlayerStore({ caches, fetch: okFetch })!;
    caches.failPuts(true);
    await expect(store.ensureAsset(asset('img-1'))).rejects.toBeInstanceOf(CacheQuotaError);
  });

  it('refuses assets that do not fit and counts only what is missing', async () => {
    const caches = fakeCaches();
    const store = createPlayerStore({
      caches,
      fetch: okFetch,
      storage: { estimate: async () => ({ usage: 900, quota: 1_000 }), persist: async () => true },
    })!;
    await expect(store.assertFits([asset('big', 'video', 500)])).rejects.toBeInstanceOf(CacheQuotaError);
    await store.ensureAsset(asset('big', 'video', 500));
    await expect(store.assertFits([asset('big', 'video', 500)])).resolves.toBeUndefined();
  });

  it('evicts assets that are not kept and clears everything', async () => {
    const caches = fakeCaches();
    const store = createPlayerStore({ caches, fetch: okFetch })!;
    await store.ensureAsset(asset('a'));
    await store.ensureAsset(asset('b'));
    await store.retain([asset('b')]);
    expect(caches.keysOf(ASSET_CACHE)).toEqual([assetKey(asset('b').sha256)]);
    await store.saveManifest(manifest(3));
    expect((await store.loadManifest())?.revision).toBe(3);
    await store.clear();
    expect(await store.loadManifest()).toBeNull();
    expect(caches.keysOf(ASSET_CACHE)).toEqual([]);
  });
});
