/** Exponential backoff: `base`, 2x, 4x ... up to `max` (milliseconds); `attempt` counts from 0. */
export const backoffMs = (attempt: number, base = 5_000, max = 300_000) => Math.min(max, base * 2 ** Math.min(attempt, 20));

/** Resolves after `ms`, or immediately when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}
