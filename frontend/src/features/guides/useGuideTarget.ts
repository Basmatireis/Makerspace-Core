import { useEffect, useState } from 'react';

/** How long a step waits for its target to appear before it falls back to a centered panel. */
export const TARGET_TIMEOUT_MS = 4000;

export type TargetState =
  { status: 'none' | 'pending' | 'missing'; element: null } | { status: 'found'; element: HTMLElement };

function hasBox(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0;
}

/**
 * Finds the step's target. The page may still be loading or navigating, so it keeps watching the DOM (and notices when
 * the target is replaced) and reports `missing` once the timeout passes without a match.
 */
export function useGuideTarget(selector: string | undefined): TargetState {
  const [found, setFound] = useState<{ selector: string; element: HTMLElement | null } | null>(null);
  const [timedOutFor, setTimedOutFor] = useState<string | null>(null);

  useEffect(() => {
    if (!selector) return;
    let frame = 0;
    const find = () => {
      const match = document.querySelector<HTMLElement>(selector);
      const element = match && hasBox(match) ? match : null;
      setFound((previous) =>
        previous?.selector === selector && previous.element === element ? previous : { selector, element },
      );
    };
    find();
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(find);
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'hidden'],
    });
    const timer = window.setTimeout(() => setTimedOutFor(selector), TARGET_TIMEOUT_MS);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [selector]);

  if (!selector) return { status: 'none', element: null };
  const element = found?.selector === selector ? found.element : null;
  if (element) return { status: 'found', element };
  return { status: timedOutFor === selector ? 'missing' : 'pending', element: null };
}

export interface TargetRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** The viewport rectangle of an element, kept current while the page scrolls, resizes or reflows. */
export function useElementRect(element: HTMLElement | null): TargetRect | null {
  const [rect, setRect] = useState<{ element: HTMLElement; rect: TargetRect } | null>(null);

  useEffect(() => {
    if (!element) return;
    let frame = 0;
    const measure = () => {
      const box = element.getBoundingClientRect();
      const next = { top: box.top, left: box.left, width: box.width, height: box.height };
      setRect((previous) =>
        previous?.element === element &&
        previous.rect.top === next.top &&
        previous.rect.left === next.left &&
        previous.rect.width === next.width &&
        previous.rect.height === next.height
          ? previous
          : { element, rect: next },
      );
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    // Capture: scrolling inside any container moves the target.
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    observer?.observe(element);
    observer?.observe(document.body);
    return () => {
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      observer?.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [element]);

  return element && rect?.element === element ? rect.rect : null;
}

const OPEN_MODAL = '.cds--modal.is-visible:not(.guide-modal)';

/** Whether a Carbon modal of the page itself (not the tour's own panel) is open. */
export function useAppModalOpen(): boolean {
  const [open, setOpen] = useState(() => document.querySelector(OPEN_MODAL) !== null);
  useEffect(() => {
    const check = () => setOpen(document.querySelector(OPEN_MODAL) !== null);
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return open;
}
