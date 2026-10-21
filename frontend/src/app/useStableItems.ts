import { useRef } from 'react';

/**
 * Keeps combo box items referentially stable while their id and label stay the same. Carbon's
 * ComboBox compares the selected item by identity; new objects on every render would reset what
 * the user is typing.
 */
export function useStableItems<T extends { id: string; label: string }>(items: T[]): T[] {
  const cache = useRef(new Map<string, T>());
  // eslint-disable-next-line react-hooks/refs -- the cache must survive across renders and be filled while mapping; it is never read for output.
  return items.map((item) => {
    const cached = cache.current.get(item.id);
    if (cached && cached.label === item.label) return cached;
    cache.current.set(item.id, item);
    return item;
  });
}
