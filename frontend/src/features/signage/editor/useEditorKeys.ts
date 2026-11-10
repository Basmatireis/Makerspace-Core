import { useEffect } from 'react';
import { useLatestCallback } from '../../../app/useLatestCallback';

// Keyboard shortcuts of the screen editor. `editorKeyAction` is pure so the mapping can be tested without the page.

const isApple = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
/** Modifier names as the person's platform prints them, for tooltips. */
export const KEYS = {
  mod: isApple ? '⌘' : 'Ctrl+',
  alt: isApple ? '⌥' : 'Alt+',
  shift: isApple ? '⇧' : 'Shift+',
  del: isApple ? '⌫' : 'Delete',
};

export type EditorKeyAction =
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'selectAll' }
  | { kind: 'escape' }
  | { kind: 'delete' }
  | { kind: 'duplicate' }
  | { kind: 'order'; step: 'front' | 'back' | 'top' | 'bottom' }
  | { kind: 'nudge'; dx: number; dy: number }
  | { kind: 'editText' };

/** True while the person types in a field, where keys belong to the field. */
export const isTypingTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLInputElement &&
      !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'file', 'color'].includes(target.type)));

const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/** The editor action of a key press, or null when the editor leaves the key alone. */
export function editorKeyAction(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'target'>,
): EditorKeyAction | null {
  if (event.key === 'Escape') return isTypingTarget(event.target) ? null : { kind: 'escape' };
  if (isTypingTarget(event.target)) return null;
  const mod = event.metaKey || event.ctrlKey;
  const letter = event.key.toLowerCase();
  if (mod && letter === 'z') return event.shiftKey ? { kind: 'redo' } : { kind: 'undo' };
  if (mod && letter === 'y' && !event.shiftKey) return { kind: 'redo' };
  if (mod && letter === 'a') return { kind: 'selectAll' };
  if (mod && letter === 'd') return { kind: 'duplicate' };
  // e.code: Alt changes e.key on macOS.
  if (mod && (event.code === 'BracketRight' || event.code === 'BracketLeft')) {
    const forward = event.code === 'BracketRight';
    return { kind: 'order', step: forward ? (event.altKey ? 'top' : 'front') : event.altKey ? 'bottom' : 'back' };
  }
  if (mod || event.altKey) return null;
  if (event.key === 'Delete' || event.key === 'Backspace') return { kind: 'delete' };
  if (event.key === 'Enter') return { kind: 'editText' };
  const arrow = ARROWS[event.key];
  if (arrow) {
    const step = event.shiftKey ? 10 : 1;
    return { kind: 'nudge', dx: arrow[0] * step, dy: arrow[1] * step };
  }
  return null;
}

/**
 * Listens for editor shortcuts on the window while `enabled`. Keys inside dialogs, menus and fields are left alone;
 * `handle` returns false for an action that did nothing, so the browser keeps the key.
 */
export function useEditorKeys(enabled: boolean, handle: (action: EditorKeyAction) => boolean) {
  const run = useLatestCallback(handle);
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target;
      if (
        document.body.classList.contains('cds--body--with-modal-open') ||
        (target instanceof Element && target.closest('[role="dialog"], [role="menu"], .cds--overflow-menu-options'))
      )
        return;
      const action = editorKeyAction(event);
      if (action && run(action)) event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled, run]);
}
