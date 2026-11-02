import type { SignagePlayerTimelapse } from '../api/generated/models';
import { TIMELAPSE_CACHE } from './cacheKeys';

// Timelapse clips on disk (docs/signage.md, "Timelapse widget"). Loaded lazily by the runtime on the first live payload
// that lists clips, so the player's initial JavaScript stays within its budget. Clips are cached under their player URL,
// which names the video's sha256; the service worker answers that URL from here, byte ranges included. Only the
// `signage-timelapses-v1` cache is touched: published assets live in their own cache and are never evicted here.

type Clip = Pick<SignagePlayerTimelapse, 'runId' | 'sizeBytes' | 'url'>;

export type TimelapseCache = {
  /** True when the clip at `url` is on disk, so it plays without network. */
  isCached(url: string): boolean;
  /**
   * Makes the cache follow the listed clips: evicts the ones no longer listed, then downloads the missing ones one at a
   * time once `ready` resolves (the manifest's assets go first). Resolves when this round is done.
   */
  sync(clips: readonly Clip[], ready?: () => Promise<unknown>): Promise<void>;
};

export type TimelapseEnv = {
  caches?: CacheStorage;
  fetch?: typeof fetch;
  storage?: Pick<StorageManager, 'estimate'>;
  /** A short problem for the heartbeat errors (a clip that failed or does not fit). */
  report?: (message: string) => void;
  /** A clip was added or removed, so the screen can pick it up. */
  changed?: () => void;
};

const pathOf = (url: string) => new URL(url, 'http://player.invalid').pathname;
const isQuotaError = (error: unknown) =>
  error instanceof DOMException && (error.name === 'QuotaExceededError' || error.code === 22);

/** The clip cache; null without Cache Storage (the widget then streams the clips from the network). */
export async function openTimelapseCache(env: TimelapseEnv = {}): Promise<TimelapseCache | null> {
  const cacheStorage = env.caches ?? (typeof caches === 'undefined' ? undefined : caches);
  if (!cacheStorage) return null;
  const doFetch = env.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const storage = env.storage ?? (typeof navigator === 'undefined' ? undefined : navigator.storage);
  const report = env.report ?? (() => undefined);
  const changed = env.changed ?? (() => undefined);
  const cache = await cacheStorage.open(TIMELAPSE_CACHE);
  const cached = new Set((await cache.keys()).map((request) => pathOf(request.url)));
  let wanted: readonly Clip[] = [];
  let running: Promise<void> | null = null;

  const listed = (path: string) => wanted.some((clip) => pathOf(clip.url) === path);

  const evict = async () => {
    let removed = false;
    for (const path of [...cached])
      if (!listed(path)) {
        cached.delete(path);
        await cache.delete(path);
        removed = true;
      }
    if (removed) changed();
  };

  const free = async () => {
    try {
      const estimate = await storage?.estimate();
      return estimate?.quota === undefined || estimate.usage === undefined ? Infinity : estimate.quota - estimate.usage;
    } catch {
      return Infinity;
    }
  };

  const download = async (clip: Clip) => {
    const path = pathOf(clip.url);
    if (clip.sizeBytes > (await free())) {
      report(`Timelapse ${clip.runId} skipped: not enough storage`);
      return;
    }
    try {
      const response = await doFetch(clip.url, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error(`answered ${response.status}`);
      await cache.put(path, response);
    } catch (error) {
      report(
        isQuotaError(error)
          ? `Timelapse ${clip.runId} skipped: not enough storage`
          : `Timelapse ${clip.runId} failed to download`,
      );
      return;
    }
    // The list may have changed while the clip downloaded.
    if (!listed(path)) {
      await cache.delete(path);
      return;
    }
    cached.add(path);
    changed();
  };

  const run = async (ready: () => Promise<unknown>) => {
    // Each clip is tried once per round; the next live poll starts another round for what is still missing.
    const tried = new Set<string>();
    for (;;) {
      const next = wanted.find((clip) => !cached.has(pathOf(clip.url)) && !tried.has(clip.url));
      if (!next) return;
      tried.add(next.url);
      await ready().catch(() => undefined);
      if (!listed(pathOf(next.url))) continue;
      await download(next);
    }
  };

  return {
    isCached: (url) => cached.has(pathOf(url)),
    async sync(clips, ready = () => Promise.resolve()) {
      wanted = clips;
      await evict();
      running ??= run(ready).finally(() => {
        running = null;
      });
      await running;
    },
  };
}
