import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { PANEL_DOCK_QUERY, useMediaQuery } from './useMediaQuery';
import './blocks.scss';

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
 * The fixed detail panel of the list-and-panel pages (Open Days, Staffing). From 92 rem it sits beside the content and
 * follows the page scroll; below that it is a bottom sheet over a scrim, so the list keeps its width and scroll
 * position. The page lays out the two columns; this frame only places the panel.
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
    // Lets the sheet leave the content stacking context so it also covers the side navigation (see index.scss).
    document.body.classList.add('panel-sheet-open');
    ref.current?.focus({ preventScroll: true });
    return () => {
      document.body.style.overflow = previous;
      document.body.classList.remove('panel-sheet-open');
    };
  }, [sheetOpen]);

  if (docked)
    return (
      <aside ref={ref} className="panel-frame panel-frame--docked" aria-label={label}>
        {open ? children : <div className="panel-frame__empty">{placeholder}</div>}
      </aside>
    );
  if (!open) return null;
  return (
    // The layer has no box of its own (display: contents); it only receives the sheet's Escape key from React's bubbling.
    <div
      className="panel-frame__layer"
      role="presentation"
      onKeyDown={(event) => {
        // Dialogs opened from the sheet are portalled but bubble through React; only the sheet's own keys count.
        if (event.key === 'Escape' && ref.current?.contains(event.target as Node)) {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="panel-frame__scrim" onClick={onClose} aria-hidden="true" />
      <aside
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="panel-frame panel-frame--sheet"
      >
        {children}
      </aside>
    </div>
  );
}
