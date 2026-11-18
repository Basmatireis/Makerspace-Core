import { useEffect } from 'react';
import { useLatestCallback } from '../../app/useLatestCallback';
import { isTypingTarget, OWNS_KEYS_SELECTOR, useEditorKeys } from '../signage/editor/useEditorKeys';
import type { ToolType } from './model';
import { toolForKey } from './toolbox';

interface Options {
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
export function useEditorShortcuts({ enabled, undo, redo, onTool, onEscape, onNudge }: Options) {
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
