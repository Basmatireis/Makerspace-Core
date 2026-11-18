/** Replaces the item at `index` with a patched copy. */
export const patchAt = <T>(list: readonly T[], index: number, patch: Partial<T>): T[] =>
  list.map((item, i) => (i === index ? { ...item, ...patch } : item));
export const removeAt = <T>(list: readonly T[], index: number): T[] => list.filter((_, i) => i !== index);
