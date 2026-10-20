import { PLAYER_PAGE, respond, SHELL_CACHE_PREFIX } from './swCore';

// Service worker of the signage player, served at /player/sw.js (scope /player/). It keeps the player shell and the
// published assets available without a network. The build (vite.config.ts) fills in the shell file list.

type Extendable = { waitUntil(promise: Promise<unknown>): void };
type FetchEvent = Extendable & { request: Request; respondWith(response: Promise<Response>): void };
type Scope = {
  addEventListener(type: 'install' | 'activate', listener: (event: Extendable) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
};
const scope = self as unknown as Scope;

// Replaced by the build with the hashed files of the player entry and a hash of them (see vite.config.ts).
const SHELL_FILES = '__PLAYER_SHELL_FILES__' as unknown as string[];
const SHELL_CACHE = `${SHELL_CACHE_PREFIX}${'__PLAYER_SHELL_VERSION__'}`;

scope.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // `reload` bypasses the HTTP cache so the precache never holds a stale mix of files.
      await Promise.all(
        [PLAYER_PAGE, ...SHELL_FILES].map(async (path) => {
          const response = await fetch(path, { cache: 'reload' });
          if (!response.ok) throw new Error(`Cannot cache ${path}`);
          await cache.put(path, response);
        }),
      );
      await scope.skipWaiting();
    })(),
  );
});

scope.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys())
        if (name.startsWith(SHELL_CACHE_PREFIX) && name !== SHELL_CACHE) await caches.delete(name);
      await scope.clients.claim();
    })(),
  );
});

scope.addEventListener('fetch', (event) => {
  event.respondWith(
    (async () =>
      (await respond(event.request, { caches, fetch: (request) => fetch(request), shellCache: SHELL_CACHE })) ??
      fetch(event.request))(),
  );
});
