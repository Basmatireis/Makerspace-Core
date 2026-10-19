import { useEffect, useState } from 'react';

/** True while the media query matches. Used to switch the invoice progress indicator to vertical on phones. */
export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(query).matches);
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);
  return matches;
}
