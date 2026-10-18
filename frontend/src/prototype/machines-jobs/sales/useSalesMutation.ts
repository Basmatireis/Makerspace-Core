import { useCallback, useState } from 'react';

/** Like useSimulatedMutation, but a thrown SalesError (a violated backend rule) becomes `error` instead of an uncaught exception. */
export function useSalesMutation<A extends unknown[], R>(fn: (...args: A) => R, delay = 450) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mutate = useCallback((...args: A) => new Promise<{ ok: true; value: R } | { ok: false }>((resolve) => {
    setPending(true);
    setError(null);
    window.setTimeout(() => {
      try {
        const value = fn(...args);
        setPending(false);
        resolve({ ok: true, value });
      } catch (caught) {
        setPending(false);
        setError(caught instanceof Error ? caught.message : 'The action failed.');
        resolve({ ok: false });
      }
    }, delay);
  }), [fn, delay]);
  return { mutate, pending, error, clearError: () => setError(null) };
}
