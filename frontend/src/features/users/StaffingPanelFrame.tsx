import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';

/** From 92 rem the panel sits beside the table; below that it opens as a bottom sheet. */
const DOCK_QUERY = '(min-width: 92rem)';
const HEADER_OFFSET = 64;
const GAP = 16;

function subscribe(listener: () => void) {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const media = window.matchMedia(DOCK_QUERY);
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}

const isDocked = () => typeof window.matchMedia === 'function' && window.matchMedia(DOCK_QUERY).matches;

function useDocked(): boolean {
  return useSyncExternalStore(subscribe, isDocked);
}

/**
 * The fixed detail panel of the staffing page. Docked it sticks below the shell header and, when taller than the
 * window, scrolls along with the page until its end is visible; as a sheet it covers the bottom of the screen over a
 * scrim and leaves the table's scroll position alone.
 */
export function StaffingPanelFrame({
  label,
  open,
  placeholder,
  onClose,
  children,
}: {
  label: string;
  /** Whether a person is selected. Without one the docked panel shows the placeholder and the sheet is closed. */
  open: boolean;
  placeholder: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const docked = useDocked();
  const ref = useRef<HTMLElement>(null);
  const sheetOpen = !docked && open;

  useEffect(() => {
    const element = ref.current;
    if (!element || !docked) return undefined;
    // Sticky offset: just below the header, or higher when the panel is taller than the window.
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
  }, [docked]);

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
      <aside ref={ref} className="st-panel-frame st-panel-frame--docked" aria-label={label}>
        {open ? children : <div className="st-panel-empty">{placeholder}</div>}
      </aside>
    );
  if (!open) return null;
  return (
    <>
      <div className="st-scrim" onClick={onClose} aria-hidden="true" />
      <aside
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="st-panel-frame st-panel-frame--sheet"
        onKeyDown={(event) => {
          // Dialogs opened from the sheet are portalled but bubble through React; only the sheet's own keys count.
          if (event.key === 'Escape' && ref.current?.contains(event.target as Node)) {
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
