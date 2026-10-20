import { useEffect, useState } from 'react';

export const phoneOpenDaysQuery = '(max-width: 41.98rem)';
export const coarsePointerQuery = '(pointer: coarse)';

export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.(query).matches === true,
  );

  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);

  return matches;
}

export function useOpenDaysLayout() {
  return {
    isPhone: useMediaQuery(phoneOpenDaysQuery),
    hasCoarsePointer: useMediaQuery(coarsePointerQuery),
  };
}
