import type { SignagePlayerAsset } from '../api/generated/models';

// Preloading: a new revision only goes on screen when every asset of it can be shown without a stall.

const IMAGE_TIMEOUT_MS = 60_000;
/** Videos stream, so a slow buffer does not block the switch forever: after this long the video counts as ready. */
export const VIDEO_TIMEOUT_MS = 30_000;

/** Resolves with 'ready', or 'slow' when a video did not buffer in time; rejects when the asset cannot be loaded. */
export type AssetLoader = (asset: Pick<SignagePlayerAsset, 'id' | 'kind' | 'url'>) => Promise<'ready' | 'slow'>;

export const loadAsset: AssetLoader = (asset) => new Promise((resolve, reject) => {
  const isVideo = asset.kind === 'video';
  const element = isVideo ? document.createElement('video') : new Image();
  let timer = 0;
  const finish = (outcome: 'ready' | 'slow' | Error) => {
    clearTimeout(timer);
    element.onerror = null;
    if (element instanceof HTMLVideoElement) { element.oncanplaythrough = null; element.removeAttribute('src'); element.load(); } else element.onload = null;
    if (outcome instanceof Error) reject(outcome); else resolve(outcome);
  };
  element.onerror = () => finish(new Error(`Asset ${asset.id} could not be loaded`));
  timer = window.setTimeout(() => finish(isVideo ? 'slow' : new Error(`Asset ${asset.id} timed out`)), isVideo ? VIDEO_TIMEOUT_MS : IMAGE_TIMEOUT_MS);
  if (element instanceof HTMLVideoElement) {
    element.preload = 'auto';
    element.muted = true;
    element.oncanplaythrough = () => finish('ready');
  } else {
    element.onload = () => finish('ready');
  }
  element.src = asset.url;
});

/** Runs `task` over `items` with at most `limit` in flight; resolves with every outcome in order. */
export async function settleLimited<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      try { results[index] = { status: 'fulfilled', value: await task(items[index]) }; } catch (reason) { results[index] = { status: 'rejected', reason }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
