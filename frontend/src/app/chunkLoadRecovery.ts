// A tab opened before a deploy still references the previous build's hashed chunks, which no longer exist.
// Browsers word the failed dynamic import differently, so match each of them.
const chunkLoadErrorPatterns = [
  'failed to fetch dynamically imported module',
  'error loading dynamically imported module',
  'importing a module script failed',
  'unable to preload css',
];

const reloadAttemptKey = 'makerspace.chunkReloadAt';
const reloadAttemptWindowMs = 10_000;

export function isChunkLoadError(error: unknown) {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const normalized = message.toLowerCase();
  return chunkLoadErrorPatterns.some((pattern) => normalized.includes(pattern));
}

// Reloads at most once per window so a chunk that is genuinely missing shows the error page instead of looping.
export function claimChunkReload(now = Date.now()) {
  try {
    const previous = Number(window.sessionStorage.getItem(reloadAttemptKey));
    if (previous && now - previous < reloadAttemptWindowMs) {
      return false;
    }
    window.sessionStorage.setItem(reloadAttemptKey, String(now));
    return true;
  } catch {
    return false;
  }
}

// Render may run twice for the same error (StrictMode), so the reload decision is made once per error.
const reloadDecisions = new WeakMap<object, boolean>();

export function shouldReloadForChunkError(error: unknown) {
  if (!isChunkLoadError(error)) {
    return false;
  }
  if (typeof error !== 'object' || error === null) {
    return claimChunkReload();
  }
  let decision = reloadDecisions.get(error);
  if (decision === undefined) {
    decision = claimChunkReload();
    reloadDecisions.set(error, decision);
  }
  return decision;
}
