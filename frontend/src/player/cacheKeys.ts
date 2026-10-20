// Names and keys of the player's Cache Storage entries. `swCore.ts` repeats the asset key helpers on purpose: the service
// worker is a separate build entry and must not share a chunk with the page (src/player/swCore.test.ts keeps them equal).

export const ASSET_CACHE = 'signage-assets-v1';
export const STATE_CACHE = 'signage-state-v1';
export const SHELL_CACHE_PREFIX = 'signage-player-shell-';

/** Asset responses are stored under their content hash, so an unchanged file is never downloaded twice. */
export const assetKey = (sha256: string) => `/player/cache/asset/${sha256}`;
export const MANIFEST_KEY = '/player/cache/state/manifest';
export const LIVE_KEY = '/player/cache/state/live';
