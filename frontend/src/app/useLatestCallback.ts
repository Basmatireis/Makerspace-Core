import { useCallback, useLayoutEffect, useRef } from 'react';

/** Keep event listeners installed by a child in sync without changing their identity. */
export function useLatestCallback<Args extends unknown[], Result>(callback: (...args: Args) => Result) {
  const callbackRef = useRef(callback);
  useLayoutEffect(() => {
    callbackRef.current = callback;
  });
  return useCallback((...args: Args): Result => callbackRef.current(...args), []);
}
