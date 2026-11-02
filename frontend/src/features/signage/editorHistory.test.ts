import { describe, expect, it } from 'vitest';
import {
  canRedo,
  canUndo,
  COALESCE_MS,
  createHistory,
  deepEqual,
  HISTORY_LIMIT,
  pushEdit,
  redo,
  undo,
} from './editorHistory';

describe('editor history', () => {
  it('records edits and walks back and forth', () => {
    let history = createHistory('a');
    expect(canUndo(history)).toBe(false);
    history = pushEdit(history, 'b', null, 0);
    history = pushEdit(history, 'c', null, 10);
    expect(history.present).toBe('c');
    history = undo(history);
    expect(history.present).toBe('b');
    expect(canRedo(history)).toBe(true);
    history = undo(history);
    expect(history.present).toBe('a');
    expect(canUndo(history)).toBe(false);
    expect(undo(history)).toBe(history);
    history = redo(redo(history));
    expect(history.present).toBe('c');
    expect(redo(history)).toBe(history);
  });

  it('drops the redo branch on a new edit and ignores no-op edits', () => {
    let history = pushEdit(pushEdit(createHistory('a'), 'b', null, 0), 'c', null, 1);
    history = undo(history);
    expect(pushEdit(history, 'b', null, 2)).toBe(history);
    history = pushEdit(history, 'd', null, 3);
    expect(canRedo(history)).toBe(false);
    expect(history.past).toEqual(['a', 'b']);
  });

  it('coalesces edits of the same key within the window only', () => {
    let history = createHistory('');
    history = pushEdit(history, 'h', 'text', 0);
    history = pushEdit(history, 'he', 'text', 200);
    history = pushEdit(history, 'hel', 'text', 200 + COALESCE_MS);
    expect(history.past).toEqual(['']);
    history = pushEdit(history, 'hell', 'text', 200 + COALESCE_MS + COALESCE_MS + 1);
    expect(history.past).toEqual(['', 'hel']);
    history = pushEdit(history, 'hello', 'other', 1300);
    expect(history.past).toEqual(['', 'hel', 'hell']);
    history = pushEdit(history, 'hello!', null, 1301);
    history = pushEdit(history, 'hello!!', null, 1302);
    expect(history.past).toHaveLength(5);
  });

  it('does not coalesce after an undo', () => {
    let history = pushEdit(createHistory('a'), 'b', 'k', 0);
    history = undo(history);
    history = pushEdit(history, 'c', 'k', 10);
    expect(history.past).toEqual(['a']);
    expect(history.present).toBe('c');
  });

  it('keeps at most 100 entries', () => {
    let history = createHistory(0);
    for (let index = 1; index <= HISTORY_LIMIT + 20; index += 1) history = pushEdit(history, index, null, index);
    expect(history.past).toHaveLength(HISTORY_LIMIT);
    expect(history.past[0]).toBe(20);
  });
});

describe('deepEqual', () => {
  it('compares structurally regardless of key order', () => {
    expect(deepEqual({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual([1, 2], [1])).toBe(false);
    expect(deepEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(deepEqual({ a: null }, { a: 0 })).toBe(false);
  });
});
