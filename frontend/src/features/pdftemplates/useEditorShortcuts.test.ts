import { describe, expect, it } from 'vitest';
import { pdfKeyAction } from './useEditorShortcuts';

const press = (key: string, extra: Partial<KeyboardEvent> = {}, target: EventTarget | null = document.body) =>
  pdfKeyAction({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, target, ...extra });

describe('pdfKeyAction', () => {
  it('maps the block keys on the page body', () => {
    expect(press('Delete')).toBe('delete');
    expect(press('Backspace')).toBe('delete');
    expect(press('d', { ctrlKey: true })).toBe('duplicate');
    expect(press('c', { metaKey: true })).toBe('copy');
    expect(press('x', { ctrlKey: true })).toBe('cut');
    expect(press('v', { ctrlKey: true })).toBe('paste');
    expect(press('?', { shiftKey: true })).toBe('help');
  });

  it('works in the structure and the preview region, not on other controls', () => {
    document.body.innerHTML =
      '<ul role="tree"><li id="row" role="treeitem" tabindex="0"></li></ul><div data-canvas-region id="canvas"></div><button id="b"></button>';
    expect(press('Delete', {}, document.getElementById('row'))).toBe('delete');
    expect(press('Delete', {}, document.getElementById('canvas'))).toBe('delete');
    expect(press('Delete', {}, document.getElementById('b'))).toBeNull();
  });

  it('leaves keys to fields while typing, except save', () => {
    const input = document.createElement('input');
    input.type = 'text';
    document.body.append(input);
    expect(press('Delete', {}, input)).toBeNull();
    expect(press('c', { ctrlKey: true }, input)).toBeNull();
    expect(press('v', { metaKey: true }, input)).toBeNull();
    expect(press('s', { ctrlKey: true }, input)).toBe('save');
  });

  it('saves with Ctrl or Cmd+S and ignores other combinations', () => {
    expect(press('s', { ctrlKey: true })).toBe('save');
    expect(press('S', { metaKey: true })).toBe('save');
    expect(press('s')).toBeNull();
    expect(press('Delete', { ctrlKey: true })).toBeNull();
    expect(press('d', { ctrlKey: true, shiftKey: true })).toBeNull();
  });
});
