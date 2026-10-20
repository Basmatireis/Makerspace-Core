import { describe, expect, it } from 'vitest';
import { ASSET_CACHE, assetKey, respond, type WorkerDeps } from './swCore';
import { fakeCaches } from './testCaches';

const SHA = 'cd'.repeat(32);
const request = (path: string, init: { mode?: string; range?: string; method?: string } = {}) => ({ url: `https://core.test${path}`, method: init.method ?? 'GET', mode: init.mode ?? 'cors', headers: new Headers(init.range ? { Range: init.range } : {}) }) as unknown as Request;

async function setup(network: WorkerDeps['fetch'] = async () => { throw new TypeError('offline'); }) {
  const caches = fakeCaches();
  await (await caches.open(ASSET_CACHE)).put(assetKey(SHA), new Response('0123456789', { headers: { 'Content-Type': 'video/mp4' } }));
  const shell = await caches.open('signage-player-shell-v1');
  await shell.put('/player/', new Response('<html>cached</html>'));
  await shell.put('/assets/player-1.js', new Response('js'));
  return { caches, deps: { caches, fetch: network, shellCache: 'signage-player-shell-v1', timeoutMs: 20 } satisfies WorkerDeps };
}

describe('player service worker', () => {
  it('serves cached assets from their sha256, whatever the id in the URL', async () => {
    const { deps } = await setup();
    const response = await respond(request(`/api/v1/signage/player/assets/any-id/${SHA}`), deps);
    expect(await response?.text()).toBe('0123456789');
  });

  it('answers byte ranges with 206 so videos can play', async () => {
    const { deps } = await setup();
    const url = `/api/v1/signage/player/assets/x/${SHA}`;
    const middle = await respond(request(url, { range: 'bytes=2-5' }), deps);
    expect(middle?.status).toBe(206);
    expect(middle?.headers.get('Content-Range')).toBe('bytes 2-5/10');
    expect(await middle?.text()).toBe('2345');
    const open = await respond(request(url, { range: 'bytes=7-' }), deps);
    expect(await open?.text()).toBe('789');
    const suffix = await respond(request(url, { range: 'bytes=-3' }), deps);
    expect(await suffix?.text()).toBe('789');
    expect((await respond(request(url, { range: 'bytes=50-' }), deps))?.status).toBe(416);
  });

  it('leaves uncached assets, the API and other methods to the network', async () => {
    const { deps } = await setup();
    expect(await respond(request(`/api/v1/signage/player/assets/x/${'ee'.repeat(32)}`), deps)).toBeNull();
    expect(await respond(request('/api/v1/signage/player/live'), deps)).toBeNull();
    expect(await respond(request('/player/other'), deps)).toBeNull();
    expect(await respond(request(`/api/v1/signage/player/assets/x/${SHA}`, { method: 'POST' }), deps)).toBeNull();
  });

  it('starts the player without network from the cached shell', async () => {
    const { deps } = await setup();
    const page = await respond(request('/player/', { mode: 'navigate' }), deps);
    expect(await page?.text()).toBe('<html>cached</html>');
    expect(await (await respond(request('/assets/player-1.js'), deps))?.text()).toBe('js');
  });

  it('prefers the network page and refreshes the cache, but falls back after the timeout', async () => {
    const fresh = await setup(async () => new Response('<html>fresh</html>'));
    expect(await (await respond(request('/player/', { mode: 'navigate' }), fresh.deps))?.text()).toBe('<html>fresh</html>');
    expect(await (await (await fresh.caches.open('signage-player-shell-v1')).match('/player/'))?.text()).toBe('<html>fresh</html>');
    const hung = await setup(() => new Promise<Response>(() => undefined));
    expect(await (await respond(request('/player/', { mode: 'navigate' }), hung.deps))?.text()).toBe('<html>cached</html>');
  });
});
