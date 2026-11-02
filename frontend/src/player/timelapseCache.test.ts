import { describe, expect, it } from 'vitest';
import { ASSET_CACHE, assetKey, TIMELAPSE_CACHE } from './cacheKeys';
import { TIMELAPSE_CACHE as WORKER_TIMELAPSE_CACHE } from './swCore';
import { fakeCaches } from './testCaches';
import { openTimelapseCache, type TimelapseEnv } from './timelapseCache';

const clip = (run: string, sizeBytes = 100) => {
  const sha = run.repeat(64).slice(0, 64);
  return { runId: run, sizeBytes, url: `/api/v1/signage/player/timelapses/${run}/${sha}` };
};

function setup(patch: Partial<TimelapseEnv> = {}) {
  const caches = fakeCaches();
  const downloads: string[] = [];
  const reports: string[] = [];
  let changes = 0;
  const usage = { usage: 0, quota: 10_000 };
  const env: TimelapseEnv = {
    caches,
    fetch: (async (url: string) => {
      downloads.push(url);
      return new Response(`video ${url}`, { headers: { 'Content-Type': 'video/mp4' } });
    }) as unknown as typeof fetch,
    storage: { estimate: async () => ({ ...usage }) },
    report: (message) => reports.push(message),
    changed: () => {
      changes += 1;
    },
    ...patch,
  };
  return { caches, downloads, reports, usage, env, changes: () => changes };
}

describe('timelapse cache', () => {
  it('uses the same cache name as the service worker', () => {
    expect(WORKER_TIMELAPSE_CACHE).toBe(TIMELAPSE_CACHE);
  });

  it('has no cache without Cache Storage', async () => {
    expect(await openTimelapseCache({ caches: undefined })).toBeNull();
  });

  it('downloads listed clips one at a time after the assets, keyed by their URL', async () => {
    const { caches, downloads, env, changes } = setup();
    const cache = (await openTimelapseCache(env))!;
    let releaseAssets!: () => void;
    const assets = new Promise<void>((resolve) => {
      releaseAssets = resolve;
    });
    const done = cache.sync([clip('a'), clip('b')], () => assets);
    await Promise.resolve();
    expect(downloads).toEqual([]);
    releaseAssets();
    await done;
    expect(downloads).toEqual([clip('a').url, clip('b').url]);
    expect(caches.keysOf(TIMELAPSE_CACHE)).toEqual([clip('a').url, clip('b').url]);
    expect(cache.isCached(clip('a').url)).toBe(true);
    expect(changes()).toBe(2);
    // Already cached: nothing is downloaded again, also after a restart.
    await cache.sync([clip('a'), clip('b')]);
    const reopened = (await openTimelapseCache(env))!;
    await reopened.sync([clip('a'), clip('b')]);
    expect(downloads).toHaveLength(2);
    expect(reopened.isCached(clip('b').url)).toBe(true);
  });

  it('evicts clips that are no longer listed and never touches the asset cache', async () => {
    const { caches, env } = setup();
    await (await caches.open(ASSET_CACHE)).put(assetKey('ee'.repeat(32)), new Response('asset'));
    const cache = (await openTimelapseCache(env))!;
    await cache.sync([clip('a'), clip('b')]);
    await cache.sync([clip('b')]);
    expect(caches.keysOf(TIMELAPSE_CACHE)).toEqual([clip('b').url]);
    expect(cache.isCached(clip('a').url)).toBe(false);
    await cache.sync([]);
    expect(caches.keysOf(TIMELAPSE_CACHE)).toEqual([]);
    expect(caches.keysOf(ASSET_CACHE)).toEqual([assetKey('ee'.repeat(32))]);
  });

  it('skips a clip that does not fit the free space and reports it', async () => {
    const { caches, downloads, reports, usage, env } = setup();
    usage.usage = 9_950;
    const cache = (await openTimelapseCache(env))!;
    await cache.sync([clip('a', 100), clip('b', 20)]);
    expect(downloads).toEqual([clip('b').url]);
    expect(caches.keysOf(TIMELAPSE_CACHE)).toEqual([clip('b').url]);
    expect(reports).toEqual(['Timelapse a skipped: not enough storage']);
  });

  it('reports a full disk and failed downloads without caching anything', async () => {
    const full = setup();
    full.caches.failPuts(true);
    await (await openTimelapseCache(full.env))!.sync([clip('a')]);
    expect(full.reports).toEqual(['Timelapse a skipped: not enough storage']);

    const failing = setup({ fetch: (async () => new Response('', { status: 404 })) as unknown as typeof fetch });
    const cache = (await openTimelapseCache(failing.env))!;
    await cache.sync([clip('a')]);
    expect(failing.reports).toEqual(['Timelapse a failed to download']);
    expect(cache.isCached(clip('a').url)).toBe(false);
  });
});
