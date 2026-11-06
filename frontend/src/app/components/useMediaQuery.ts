import { useSyncExternalStore } from 'react';

/** From here on a fixed detail panel sits beside the content; below it opens as a bottom sheet. */
export const PANEL_DOCK_QUERY = '(min-width: 92rem)';

/** Whether a media query currently matches; false where `matchMedia` does not exist (tests). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      if (typeof window.matchMedia !== 'function') return () => undefined;
      const media = window.matchMedia(query);
      media.addEventListener('change', listener);
      return () => media.removeEventListener('change', listener);
    },
    () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
  );
}
