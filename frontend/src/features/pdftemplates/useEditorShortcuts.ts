import { useEffect } from 'react';
import { useLatestCallback } from '../../app/useLatestCallback';
import { isTypingTarget, OWNS_KEYS_SELECTOR, useEditorKeys } from '../signage/editor/useEditorKeys';
import type { ToolType } from './model';
import { toolForKey } from './toolbox';

export type PdfKeyAction = 'delete' | 'duplicate' | 'copy' | 'cut' | 'paste' | 'save' | 'help';

/** The structure and the page preview (or nothing in particular): where Delete, copy and paste work on blocks. */
const inBlockScope = (target: EventTarget | null) =>
  target === null ||
  target === document.body ||
  target === document.documentElement ||
  (target instanceof Element && !!target.closest('[role="tree"], [data-canvas-region]'));

/**
 * The block action of a key press, or null. Pure, so the mapping is testable. Save works everywhere, also in a field; the
 * rest only in the structure and the preview and never while typing, so fields keep their own copy and paste.
 */
export function pdfKeyAction(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'target'>,
): PdfKeyAction | null {
  const mod = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();
  if (mod && !event.altKey && !event.shiftKey && key === 's') return 'save';
  if (isTypingTarget(event.target) || !inBlockScope(event.target)) return null;
  if (mod && !event.altKey && !event.shiftKey) {
    if (key === 'd') return 'duplicate';
    if (key === 'c') return 'copy';
    if (key === 'x') return 'cut';
    if (key === 'v') return 'paste';
    return null;
  }
  if (mod || event.altKey) return null;
  if (event.key === 'Delete' || event.key === 'Backspace') return 'delete';
  if (event.key === '?') return 'help';
  return null;
}

interface Options {
  /** Block keys (delete, duplicate, copy, cut, paste, save, help): true when the action did something. */
  onKey?: (action: PdfKeyAction) => boolean;
  enabled: boolean;
  undo: () => void;
  redo: () => void;
  /** V (null) or a tool's letter. */
  onTool: (tool: ToolType | null) => void;
  /** Escape: false when there was nothing to cancel. */
  onEscape: () => boolean;
  /** An arrow key on the page: nudge in mm (0.5, Shift 5). False when nothing moved. */
  onNudge: (dx: number, dy: number) => boolean;
}

/** Nudge steps in mm: the signage editor's 1/10 px steps become 0.5/5 mm. */
const MM_PER_STEP = 0.5;

/**
 * Keyboard of the template editor: undo/redo (Ctrl or ⌘ + Z, Shift for redo), Escape, arrow nudges of the selected page
 * element, and the tool letters V T H R O L I. Keys typed into fields, dialogs and menus are left alone.
 */
export function useEditorShortcuts({ enabled, undo, redo, onTool, onEscape, onNudge, onKey }: Options) {
  useEditorKeys(enabled, (action) => {
    switch (action.kind) {
      case 'undo':
        undo();
        return true;
      case 'redo':
        redo();
        return true;
      case 'escape':
        return onEscape();
      case 'nudge':
        return onNudge(action.dx * MM_PER_STEP, action.dy * MM_PER_STEP);
      default:
        return false;
    }
  });

  const blockKey = useLatestCallback((event: KeyboardEvent) => {
    if (event.defaultPrevented || !onKey) return;
    const target = event.target;
    if (
      document.body.classList.contains('cds--body--with-modal-open') ||
      (target instanceof Element && target.closest(OWNS_KEYS_SELECTOR))
    )
      return;
    const action = pdfKeyAction(event);
    if (action && onKey(action)) event.preventDefault();
  });
  useEffect(() => {
    if (!enabled) return;
    window.addEventListener('keydown', blockKey);
    return () => window.removeEventListener('keydown', blockKey);
  }, [enabled, blockKey]);

  const pick = useLatestCallback((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
    if (isTypingTarget(event.target)) return;
    if (document.body.classList.contains('cds--body--with-modal-open')) return;
    if (event.target instanceof Element && event.target.closest(OWNS_KEYS_SELECTOR)) return;
    if (event.key.toUpperCase() === 'V') return onTool(null);
    const tool = toolForKey(event.key);
    if (tool) onTool(tool);
  });
  useEffect(() => {
    if (!enabled) return;
    window.addEventListener('keydown', pick);
    return () => window.removeEventListener('keydown', pick);
  }, [enabled, pick]);
}
