import { useEffect, useState } from 'react';

/** How long a step waits for its target to appear before it falls back to a centered panel. */
export const TARGET_TIMEOUT_MS = 4000;

export type TargetState =
  { status: 'none' | 'pending' | 'missing'; element: null } | { status: 'found'; element: HTMLElement };

const NARROW_SHELL_QUERY = '(max-width: 65.98rem)';

// Collapsed navigation is opened for a step and closed again once no step needs it. A new step's lookup runs
// before the delayed close, so moving between two navigation steps keeps it open.
const revealed = new Set<() => void>();
let revealTouched = 0;

/** Opens the collapsed side navigation (narrow screens) and collapsed menus around a target inside it. */
function revealInSideNav(element: HTMLElement) {
  const nav = element.closest<HTMLElement>('.cds--side-nav');
  if (!nav) return;
  revealTouched += 1;
  const toggle = document.querySelector<HTMLElement>('.cds--header__menu-toggle');
  if (
    toggle &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(NARROW_SHELL_QUERY).matches &&
    !nav.classList.contains('cds--side-nav--expanded')
  ) {
    toggle.click();
    revealed.add(() => {
      if (toggle.isConnected && nav.classList.contains('cds--side-nav--expanded')) toggle.click();
    });
  }
  for (let ancestor = element.parentElement; ancestor && ancestor !== nav; ancestor = ancestor.parentElement) {
    if (!ancestor.matches('li')) continue;
    const button = ancestor.querySelector<HTMLElement>(':scope > button[aria-expanded="false"]');
    if (!button) continue;
    button.click();
    revealed.add(() => {
      if (button.isConnected && button.getAttribute('aria-expanded') === 'true') button.click();
    });
  }
}

function scheduleHideRevealed() {
  const touched = revealTouched;
  window.setTimeout(() => {
    if (touched !== revealTouched) return;
    revealed.forEach((undo) => undo());
    revealed.clear();
  }, 60);
}

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
      if (match) revealInSideNav(match);
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
      attributeFilter: ['class', 'hidden', 'aria-expanded'],
    });
    const timer = window.setTimeout(() => setTimedOutFor(selector), TARGET_TIMEOUT_MS);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      scheduleHideRevealed();
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

export type Highlight = 'content' | 'element';

const CONTENT_SELECTOR = 'a, button, input, select, textarea, img, [role="tab"], [role="menuitem"], li > a';
const MAX_TEXT_NODES = 400;

function boxOf(rect: DOMRect): TargetRect {
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

function isShown(element: Element | null): boolean {
  return !element || typeof element.checkVisibility !== 'function' || element.checkVisibility();
}

/**
 * The union of what a person actually sees inside the element (text and controls), clipped to its box. A tab bar
 * spans the page, but its tabs do not; falls back to the element's box when nothing measurable is inside.
 */
export function contentRect(element: HTMLElement): TargetRect {
  const box = element.getBoundingClientRect();
  const whole = boxOf(box);
  if (element.matches(CONTENT_SELECTOR)) return whole;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  const add = (rect: { left: number; top: number; right: number; bottom: number }) => {
    const l = Math.max(rect.left, box.left);
    const t = Math.max(rect.top, box.top);
    const r = Math.min(rect.right, box.right);
    const b = Math.min(rect.bottom, box.bottom);
    if (r - l <= 1 || b - t <= 1) return;
    left = Math.min(left, l);
    top = Math.min(top, t);
    right = Math.max(right, r);
    bottom = Math.max(bottom, b);
  };
  const controls = element.querySelectorAll(CONTENT_SELECTOR);
  if (controls.length > MAX_TEXT_NODES) return whole;
  controls.forEach((control) => {
    if (isShown(control)) add(control.getBoundingClientRect());
  });
  if (typeof document.createRange === 'function') {
    const range = document.createRange();
    if (typeof range.getClientRects === 'function') {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let seen = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.nodeValue?.trim()) continue;
        if (++seen > MAX_TEXT_NODES) return whole;
        if (!isShown(node.parentElement)) continue;
        range.selectNodeContents(node);
        for (const rect of Array.from(range.getClientRects())) add(rect);
      }
    }
  }
  if (right <= left || bottom <= top) return whole;
  return { top, left, width: right - left, height: bottom - top };
}

/** The viewport rectangle of an element (or of its visible content), kept current while the page changes. */
export function useElementRect(element: HTMLElement | null, highlight: Highlight = 'element'): TargetRect | null {
  const [rect, setRect] = useState<{ element: HTMLElement; highlight: Highlight; rect: TargetRect } | null>(null);

  useEffect(() => {
    if (!element) return;
    let frame = 0;
    const measure = () => {
      const next = highlight === 'content' ? contentRect(element) : boxOf(element.getBoundingClientRect());
      setRect((previous) =>
        previous?.element === element &&
        previous.highlight === highlight &&
        previous.rect.top === next.top &&
        previous.rect.left === next.left &&
        previous.rect.width === next.width &&
        previous.rect.height === next.height
          ? previous
          : { element, highlight, rect: next },
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
    const mutations = new MutationObserver(schedule);
    mutations.observe(element, { childList: true, subtree: true, characterData: true });
    // Transitions (a drawer opening, a modal sliding in) and layout shifts nobody observes settle within moments.
    const poll = window.setInterval(measure, 250);
    return () => {
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      observer?.disconnect();
      mutations.disconnect();
      window.clearInterval(poll);
      cancelAnimationFrame(frame);
    };
  }, [element, highlight]);

  return element && rect?.element === element && rect.highlight === highlight ? rect.rect : null;
}

const OPEN_MODAL = '.cds--modal.is-visible:not(.guide-modal) .cds--modal-container';

function useOpenElement(selector: string): HTMLElement | null {
  const [element, setElement] = useState<HTMLElement | null>(() => document.querySelector<HTMLElement>(selector));
  useEffect(() => {
    const check = () => setElement(document.querySelector<HTMLElement>(selector));
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [selector]);
  return element;
}

/** The box of a Carbon modal of the page itself (not the tour's own panel) while one is open. */
export function useAppModal(): HTMLElement | null {
  return useOpenElement(OPEN_MODAL);
}

/** A page modal or an expanded header panel (profile, notifications) while one is open. */
export function useAppOverlay(): HTMLElement | null {
  return useOpenElement(`${OPEN_MODAL}, .cds--header-panel--expanded`);
}
