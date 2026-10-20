// Request handling of the player's service worker, kept free of service worker globals so tests can drive it with fakes.
// The worker (sw.ts) is a separate build entry: this file must not import other player files (they would end up in a
// chunk shared with the page). The asset key is therefore repeated here; swCore.test.ts checks it against cacheKeys.ts.

export const ASSET_CACHE = 'signage-assets-v1';
export const SHELL_CACHE_PREFIX = 'signage-player-shell-';
export const PLAYER_PAGE = '/player/';
const ASSET_URL = /^\/api\/v1\/signage\/player\/assets\/[^/]+\/([0-9a-f]{64})$/;
/** A player start must not wait for a hung network: after this long the cached shell is used. */
export const NAVIGATION_TIMEOUT_MS = 4_000;

export const assetKey = (sha256: string) => `/player/cache/asset/${sha256}`;

export type WorkerDeps = {
  caches: CacheStorage;
  fetch: (request: Request) => Promise<Response>;
  shellCache: string;
  timeoutMs?: number;
};

/** The asset's sha256 when `pathname` is a player asset URL. */
export const assetSha = (pathname: string) => ASSET_URL.exec(pathname)?.[1] ?? null;

/** Media elements ask for byte ranges; a cached 200 has to be answered as 206 or videos cannot seek or even start. */
export async function rangeResponse(request: Request, cached: Response): Promise<Response> {
  const header = request.headers.get('Range');
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!match || cached.status !== 200 || (match[1] === '' && match[2] === '')) return cached;
  const blob = await cached.blob();
  const size = blob.size;
  let start: number;
  let end: number;
  if (match[1] === '') {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || start > end)
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  const headers = new Headers({
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Content-Length': String(end - start + 1),
    'Accept-Ranges': 'bytes',
  });
  const type = cached.headers.get('Content-Type');
  if (type) headers.set('Content-Type', type);
  return new Response(blob.slice(start, end + 1), { status: 206, headers });
}

async function navigation(request: Request, deps: WorkerDeps): Promise<Response> {
  const cache = await deps.caches.open(deps.shellCache);
  const fromCache = async () => (await cache.match(PLAYER_PAGE)) ?? Response.error();
  const network = deps.fetch(request).then(async (response) => {
    if (response.ok) await cache.put(PLAYER_PAGE, response.clone());
    return response;
  });
  // A slow request keeps running after the timeout and refreshes the cache for the next start.
  network.catch(() => undefined);
  const timeout = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), deps.timeoutMs ?? NAVIGATION_TIMEOUT_MS),
  );
  try {
    return (await Promise.race([network, timeout])) ?? (await fromCache());
  } catch {
    return fromCache();
  }
}

/** Answers a request from the caches, or resolves null to let the browser use the network. */
export async function respond(request: Request, deps: WorkerDeps): Promise<Response | null> {
  if (request.method !== 'GET') return null;
  const url = new URL(request.url);
  const sha = assetSha(url.pathname);
  if (sha) {
    const cached = await (await deps.caches.open(ASSET_CACHE)).match(assetKey(sha));
    return cached ? rangeResponse(request, cached) : null;
  }
  if (url.pathname === '/player' || url.pathname === PLAYER_PAGE) {
    return request.mode === 'navigate' ? navigation(request, deps) : null;
  }
  // Hashed build files never change: cache first. Other files (the application's) are not ours.
  if (url.pathname.startsWith('/assets/')) {
    const cache = await deps.caches.open(deps.shellCache);
    return (await cache.match(url.pathname)) ?? null;
  }
  return null;
}
