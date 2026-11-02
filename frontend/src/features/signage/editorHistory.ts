/** Undo/redo history of an editor draft; pure so it can be tested without the editor. */
export const HISTORY_LIMIT = 100;
export const COALESCE_MS = 500;

export type History<T> = {
  past: readonly T[];
  present: T;
  future: readonly T[];
  /** Key and time of the latest edit; an edit with the same key shortly after it extends that entry. */
  lastKey: string | null;
  lastAt: number;
};

export const createHistory = <T>(present: T): History<T> => ({
  past: [],
  present,
  future: [],
  lastKey: null,
  lastAt: 0,
});

export const canUndo = (history: History<unknown>) => history.past.length > 0;
export const canRedo = (history: History<unknown>) => history.future.length > 0;

/** Records `next` as the new present. Edits with the same `key` within `COALESCE_MS` share one entry. */
export function pushEdit<T>(history: History<T>, next: T, key: string | null, now: number): History<T> {
  if (Object.is(next, history.present)) return history;
  const coalesce = key !== null && key === history.lastKey && now - history.lastAt <= COALESCE_MS;
  if (coalesce) return { ...history, present: next, future: [], lastAt: now };
  const past = [...history.past, history.present];
  if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT);
  return { past, present: next, future: [], lastKey: key, lastAt: now };
}

export function undo<T>(history: History<T>): History<T> {
  if (history.past.length === 0) return history;
  return {
    past: history.past.slice(0, -1),
    present: history.past[history.past.length - 1],
    future: [history.present, ...history.future],
    lastKey: null,
    lastAt: 0,
  };
}

export function redo<T>(history: History<T>): History<T> {
  if (history.future.length === 0) return history;
  return {
    past: [...history.past, history.present],
    present: history.future[0],
    future: history.future.slice(1),
    lastKey: null,
    lastAt: 0,
  };
}

/** Structural equality for plain JSON-like values (key order does not matter). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left).filter((key) => left[key] !== undefined);
  const otherKeys = Object.keys(right).filter((key) => right[key] !== undefined);
  return keys.length === otherKeys.length && keys.every((key) => deepEqual(left[key], right[key]));
}
