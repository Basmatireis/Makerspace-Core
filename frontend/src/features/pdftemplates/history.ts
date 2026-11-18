import { useCallback, useReducer } from 'react';

/**
 * Undo/redo history of the working document, as snapshots. Typing in one field within 700 ms is one step, every
 * structural action is a step of its own, at most 200 steps are kept. The reducer is pure (the clock is an argument) so
 * it can be tested without timers.
 */
export const HISTORY_LIMIT = 200;
export const TYPING_WINDOW_MS = 700;

/** `typing` edits of one field coalesce; `step` is an action of its own. */
export type ChangeKind = 'typing' | 'step';

export interface History<T> {
  past: readonly T[];
  present: T;
  future: readonly T[];
  /** Time of the latest typing edit while its step is still open, else null. */
  typingAt: number | null;
}

export const createHistory = <T>(present: T): History<T> => ({ past: [], present, future: [], typingAt: null });
export const canUndo = (h: History<unknown>) => h.past.length > 0;
export const canRedo = (h: History<unknown>) => h.future.length > 0;

const capped = <T>(past: readonly T[]): readonly T[] =>
  past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past;

/** Records `next` as the present. */
export function commit<T>(h: History<T>, next: T, kind: ChangeKind, now: number): History<T> {
  if (Object.is(next, h.present)) return h;
  if (kind === 'typing') {
    if (h.typingAt !== null && now - h.typingAt <= TYPING_WINDOW_MS)
      return { ...h, present: next, typingAt: now, future: [] };
    return { past: capped([...h.past, h.present]), present: next, future: [], typingAt: now };
  }
  return { past: capped([...h.past, h.present]), present: next, future: [], typingAt: null };
}

export function undo<T>(h: History<T>): History<T> {
  if (!h.past.length) return h;
  return {
    past: h.past.slice(0, -1),
    present: h.past[h.past.length - 1],
    future: [h.present, ...h.future],
    typingAt: null,
  };
}

export function redo<T>(h: History<T>): History<T> {
  if (!h.future.length) return h;
  return { past: capped([...h.past, h.present]), present: h.future[0], future: h.future.slice(1), typingAt: null };
}

type Action<T> =
  | { type: 'commit'; next: T; kind: ChangeKind; now: number }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'reset'; doc: T };

function reducer<T>(h: History<T>, action: Action<T>): History<T> {
  switch (action.type) {
    case 'commit':
      return commit(h, action.next, action.kind, action.now);
    case 'undo':
      return undo(h);
    case 'redo':
      return redo(h);
    case 'reset':
      return createHistory(action.doc);
  }
}

/** The working document with its history. `set` is the `onChange` of the editor panels. */
export function useDocumentHistory<T>(initial: T) {
  const [history, dispatch] = useReducer(reducer<T>, initial, createHistory<T>);
  const set = useCallback(
    (next: T, kind: ChangeKind = 'step') => dispatch({ type: 'commit', next, kind, now: Date.now() }),
    [],
  );
  const undoStep = useCallback(() => dispatch({ type: 'undo' }), []);
  const redoStep = useCallback(() => dispatch({ type: 'redo' }), []);
  const reset = useCallback((doc: T) => dispatch({ type: 'reset', doc }), []);
  return {
    doc: history.present,
    set,
    undo: undoStep,
    redo: redoStep,
    reset,
    canUndo: canUndo(history),
    canRedo: canRedo(history),
  };
}
