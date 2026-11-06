import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { PANEL_DOCK_QUERY, useMediaQuery } from './useMedia';

const HEADER_OFFSET = 64;
const GAP = 16;

/**
 * Keeps a docked panel in view while the page scrolls: it sticks below the shell header, and when it is taller than
 * the window it scrolls along with the page until its end is visible (no inner scrollbar).
 */
function useStickyTop(ref: RefObject<HTMLElement | null>, enabled: boolean) {
  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return undefined;
    const update = () => {
      element.style.top = `${Math.min(HEADER_OFFSET, window.innerHeight - element.offsetHeight - GAP)}px`;
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(element);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [ref, enabled]);
}

export type PanelFrameProps = {
  /** Accessible name, for example "Open day details". */
  label: string;
  /** Whether something is selected. Without it the docked panel shows the placeholder and the sheet is closed. */
  open: boolean;
  placeholder: ReactNode;
  onClose: () => void;
  children: ReactNode;
};

/**
 * The fixed detail panel of the Open Days pages. From 92 rem it sits beside the content and follows the page scroll;
 * below that it is a bottom sheet over a scrim, so the list and calendar keep their width.
 */
export function PanelFrame({ label, open, placeholder, onClose, children }: PanelFrameProps) {
  const docked = useMediaQuery(PANEL_DOCK_QUERY);
  const ref = useRef<HTMLElement>(null);
  useStickyTop(ref, docked);
  const sheetOpen = !docked && open;

  useEffect(() => {
    if (!sheetOpen) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.focus({ preventScroll: true });
    return () => {
      document.body.style.overflow = previous;
    };
  }, [sheetOpen]);

  if (docked)
    return (
      <aside ref={ref} className="od-panel-frame od-panel-frame--docked" aria-label={label}>
        {open ? children : <div className="od-panel-empty">{placeholder}</div>}
      </aside>
    );
  if (!open) return null;
  return (
    <>
      <div className="od-scrim" onClick={onClose} aria-hidden="true" />
      <aside
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="od-panel-frame od-panel-frame--sheet"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        {children}
      </aside>
    </>
  );
}
