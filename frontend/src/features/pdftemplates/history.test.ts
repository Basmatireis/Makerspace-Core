import { describe, expect, it } from 'vitest';
import { canRedo, canUndo, commit, createHistory, HISTORY_LIMIT, redo, TYPING_WINDOW_MS, undo } from './history';

describe('document history', () => {
  it('starts empty and ignores a change to the same value', () => {
    const h = createHistory('a');
    expect(canUndo(h)).toBe(false);
    expect(commit(h, 'a', 'step', 0)).toBe(h);
  });

  it('records every structural action as a step', () => {
    let h = createHistory('a');
    h = commit(h, 'b', 'step', 0);
    h = commit(h, 'c', 'step', 10);
    expect(h.past).toEqual(['a', 'b']);
    h = undo(h);
    expect(h.present).toBe('b');
    h = undo(h);
    expect(h.present).toBe('a');
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(true);
    h = redo(redo(h));
    expect(h.present).toBe('c');
  });

  it('merges typing within 700 ms into one step', () => {
    let h = createHistory('');
    h = commit(h, 'H', 'typing', 1000);
    h = commit(h, 'He', 'typing', 1300);
    h = commit(h, 'Hel', 'typing', 1300 + TYPING_WINDOW_MS);
    expect(h.past).toEqual(['']);
    expect(undo(h).present).toBe('');
  });

  it('starts a new step after a pause, and after a structural action', () => {
    let h = createHistory('');
    h = commit(h, 'a', 'typing', 0);
    h = commit(h, 'ab', 'typing', TYPING_WINDOW_MS + 1);
    expect(h.past).toEqual(['', 'a']);
    h = commit(h, 'ab!', 'step', TYPING_WINDOW_MS + 2);
    h = commit(h, 'ab!c', 'typing', TYPING_WINDOW_MS + 3);
    expect(h.past).toEqual(['', 'a', 'ab', 'ab!']);
  });

  it('drops the redo list on a new edit', () => {
    let h = createHistory(1);
    h = commit(commit(h, 2, 'step', 0), 3, 'step', 0);
    h = undo(h);
    expect(h.future).toEqual([3]);
    h = commit(h, 9, 'step', 0);
    expect(h.future).toEqual([]);
  });

  it('keeps at most 200 steps', () => {
    let h = createHistory(0);
    for (let i = 1; i <= HISTORY_LIMIT + 20; i += 1) h = commit(h, i, 'step', 0);
    expect(h.past).toHaveLength(HISTORY_LIMIT);
    expect(h.past[0]).toBe(20);
  });
});
