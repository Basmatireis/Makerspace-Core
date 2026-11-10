import { describe, expect, it } from 'vitest';
import { editorKeyAction } from './useEditorKeys';

const key = (
  init: Partial<Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>> & {
    target?: EventTarget | null;
  },
) =>
  editorKeyAction({
    key: '',
    code: '',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target: document.body,
    ...init,
  });

describe('editor keyboard shortcuts', () => {
  it('nudges by one unit, or ten with Shift', () => {
    expect(key({ key: 'ArrowLeft' })).toEqual({ kind: 'nudge', dx: -1, dy: 0 });
    expect(key({ key: 'ArrowDown', shiftKey: true })).toEqual({ kind: 'nudge', dx: 0, dy: 10 });
  });

  it('maps undo, redo, select all, duplicate and delete', () => {
    expect(key({ key: 'z', metaKey: true })).toEqual({ kind: 'undo' });
    expect(key({ key: 'Z', ctrlKey: true, shiftKey: true })).toEqual({ kind: 'redo' });
    expect(key({ key: 'a', metaKey: true })).toEqual({ kind: 'selectAll' });
    expect(key({ key: 'd', ctrlKey: true })).toEqual({ kind: 'duplicate' });
    expect(key({ key: 'Backspace' })).toEqual({ kind: 'delete' });
    expect(key({ key: 'Enter' })).toEqual({ kind: 'editText' });
  });

  it('orders with the bracket keys by their code, all the way with Alt', () => {
    expect(key({ key: ']', code: 'BracketRight', metaKey: true })).toEqual({ kind: 'order', step: 'front' });
    expect(key({ key: '‘', code: 'BracketRight', metaKey: true, altKey: true })).toEqual({
      kind: 'order',
      step: 'top',
    });
    expect(key({ key: '[', code: 'BracketLeft', ctrlKey: true })).toEqual({ kind: 'order', step: 'back' });
    expect(key({ key: '“', code: 'BracketLeft', ctrlKey: true, altKey: true })).toEqual({
      kind: 'order',
      step: 'bottom',
    });
  });

  it('applies Delete, Enter and arrows only on the canvas region or the body', () => {
    const button = document.createElement('button');
    const radio = Object.assign(document.createElement('input'), { type: 'radio' });
    const region = document.createElement('div');
    region.setAttribute('data-canvas-region', '');
    for (const key_ of ['Delete', 'Backspace', 'Enter', 'ArrowLeft']) {
      expect(key({ key: key_, target: button })).toBeNull();
      expect(key({ key: key_, target: radio })).toBeNull();
      expect(key({ key: key_, target: region })).not.toBeNull();
    }
    // Modified shortcuts still work on a focused button.
    expect(key({ key: 'z', metaKey: true, target: button })).toEqual({ kind: 'undo' });
  });

  it('leaves keys to text fields, except Escape outside them', () => {
    const input = document.createElement('input');
    expect(key({ key: 'Backspace', target: input })).toBeNull();
    expect(key({ key: 'z', metaKey: true, target: input })).toBeNull();
    expect(key({ key: 'Escape', target: input })).toBeNull();
    expect(key({ key: 'Escape' })).toEqual({ kind: 'escape' });
    const checkbox = Object.assign(document.createElement('input'), { type: 'checkbox' });
    expect(key({ key: 'ArrowUp', target: checkbox })).toBeNull();
  });
});
