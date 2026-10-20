import type { SignagePlayerLiveAnnouncement, SignagePlayerAsset, SignagePlayerLive, SignagePlayerManifest } from '../api/generated/models';
import { ASSET_CACHE, assetKey, LIVE_KEY, MANIFEST_KEY, STATE_CACHE } from './cacheKeys';

// The offline cache. Only published signage content lives here (the manifest, its assets and the last announcements, open
// days and events): the same things the display shows on the wall. Never credentials, tokens or machine status.

/** The device ran out of storage (or would). The old revision keeps playing. */
export class CacheQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CacheQuotaError';
  }
}

/** The part of the last live payload that survives a restart. Machines are never kept: their status is only fresh when polled. */
export type PersistedLive = {
  savedAt: number;
  skewMs: number;
  announcements: SignagePlayerLiveAnnouncement[];
  openDays: SignagePlayerLive['openDays'];
  events: SignagePlayerLive['events'];
};

export type StorageUse = { usedBytes: number; quotaBytes: number };

export type PlayerStore = {
  /** Downloads the asset into the cache unless it is there already. Rejects with `CacheQuotaError` when it does not fit. */
  ensureAsset(asset: SignagePlayerAsset): Promise<void>;
  hasAll(assets: readonly SignagePlayerAsset[]): Promise<boolean>;
  /** Throws `CacheQuotaError` when the assets that are not cached yet cannot fit into the remaining space. */
  assertFits(assets: readonly SignagePlayerAsset[]): Promise<void>;
  /** Deletes every cached asset that is not in `keep`. */
  retain(keep: readonly SignagePlayerAsset[]): Promise<void>;
  saveManifest(manifest: SignagePlayerManifest): Promise<void>;
  loadManifest(): Promise<SignagePlayerManifest | null>;
  saveLive(live: PersistedLive): Promise<void>;
  loadLive(): Promise<PersistedLive | null>;
  /** Removes everything (a revoked display must not keep its content). */
  clear(): Promise<void>;
  usage(): Promise<StorageUse | null>;
  /** Asks the browser not to evict the cache under storage pressure (best effort). */
  requestPersistence(): Promise<void>;
};

export type StoreEnv = {
  caches: CacheStorage;
  fetch?: typeof fetch;
  storage?: Pick<StorageManager, 'estimate' | 'persist'>;
};

const isQuotaError = (error: unknown) => error instanceof DOMException && (error.name === 'QuotaExceededError' || error.code === 22);
const mb = (bytes: number) => `${Math.max(0, Math.round(bytes / 1024 / 1024))} MB`;

const jsonResponse = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

/** The store on top of Cache Storage; null when the browser has none (insecure origin), then the player preloads in memory only. */
export function createPlayerStore(env: Partial<StoreEnv> = {}): PlayerStore | null {
  const cacheStorage = env.caches ?? (typeof caches === 'undefined' ? undefined : caches);
  if (!cacheStorage) return null;
  const doFetch = env.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const storage = env.storage ?? (typeof navigator === 'undefined' ? undefined : navigator.storage);

  const readJson = async <T>(key: string): Promise<T | null> => {
    try {
      const response = await (await cacheStorage.open(STATE_CACHE)).match(key);
      return response ? ((await response.json()) as T) : null;
    } catch { return null; }
  };
  const writeJson = async (key: string, value: unknown) => { await (await cacheStorage.open(STATE_CACHE)).put(key, jsonResponse(value)); };

  const usage = async (): Promise<StorageUse | null> => {
    try {
      const estimate = await storage?.estimate();
      if (!estimate || estimate.quota === undefined || estimate.usage === undefined) return null;
      return { usedBytes: estimate.usage, quotaBytes: estimate.quota };
    } catch { return null; }
  };

  const missing = async (assets: readonly SignagePlayerAsset[]) => {
    const cache = await cacheStorage.open(ASSET_CACHE);
    const result: SignagePlayerAsset[] = [];
    for (const asset of assets) if (!(await cache.match(assetKey(asset.sha256)))) result.push(asset);
    return result;
  };

  return {
    async ensureAsset(asset) {
      const cache = await cacheStorage.open(ASSET_CACHE);
      const key = assetKey(asset.sha256);
      if (await cache.match(key)) return;
      const response = await doFetch(asset.url, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error(`Asset ${asset.id} answered ${response.status}`);
      try {
        await cache.put(key, response);
      } catch (error) {
        if (isQuotaError(error)) throw new CacheQuotaError(`Storage is full while caching asset ${asset.id}`);
        throw error;
      }
    },
    async hasAll(assets) { return (await missing(assets)).length === 0; },
    async assertFits(assets) {
      const use = await usage();
      if (!use) return;
      const needed = (await missing(assets)).reduce((sum, asset) => sum + asset.sizeBytes, 0);
      const free = use.quotaBytes - use.usedBytes;
      if (needed > free) throw new CacheQuotaError(`Not enough storage: ${mb(needed)} needed, ${mb(free)} free`);
    },
    async retain(keep) {
      const wanted = new Set(keep.map((asset) => assetKey(asset.sha256)));
      const cache = await cacheStorage.open(ASSET_CACHE);
      for (const request of await cache.keys()) {
        if (!wanted.has(new URL(request.url, 'http://player.invalid').pathname)) await cache.delete(request);
      }
    },
    saveManifest: (manifest) => writeJson(MANIFEST_KEY, manifest),
    loadManifest: () => readJson<SignagePlayerManifest>(MANIFEST_KEY),
    saveLive: (live) => writeJson(LIVE_KEY, live),
    loadLive: () => readJson<PersistedLive>(LIVE_KEY),
    async clear() {
      await Promise.all([cacheStorage.delete(ASSET_CACHE), cacheStorage.delete(STATE_CACHE)]);
    },
    usage,
    async requestPersistence() {
      try { await storage?.persist?.(); } catch { /* Best effort. */ }
    },
  };
}
