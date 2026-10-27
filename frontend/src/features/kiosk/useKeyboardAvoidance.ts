import { useEffect } from 'react';

// How much smaller than the layout the visual viewport must be before we call it an on-screen keyboard. Pinch-zoom and
// browser chrome changes stay below this.
export const keyboardThresholdPx = 150;

/** Pure so the decision is testable: the keyboard is open when a text field is focused and the visible area shrank. */
export function isKeyboardOpen(baselineHeight: number, visualHeight: number, fieldFocused: boolean): boolean {
  return fieldFocused && baselineHeight - visualHeight > keyboardThresholdPx;
}

// Fields that open a software keyboard (a checkbox, file input or slider does not).
const noKeyboardTypes = new Set(['button', 'checkbox', 'color', 'file', 'image', 'radio', 'range', 'reset', 'submit']);

function focusedTextField(): HTMLElement | undefined {
  const active = document.activeElement;
  if (active instanceof HTMLTextAreaElement) return active;
  if (active instanceof HTMLInputElement && !noKeyboardTypes.has(active.type)) return active;
  return undefined;
}

/**
 * Keeps the focused field and the primary action visible above the on-screen keyboard of a kiosk tablet (iPad
 * Safari, Android WebView). While the keyboard is open the root element carries `data-keyboard-open` and the CSS
 * variables `--visual-viewport-height` / `--visual-viewport-top`, which kiosk layouts use to fit the visible area
 * and to drop secondary columns. The focused field is scrolled to the middle of what is left.
 */
export function useKeyboardAvoidance() {
  useEffect(startKeyboardAvoidance, []);
}

export function startKeyboardAvoidance(): (() => void) | undefined {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const root = document.documentElement;
  let baseline = Math.max(window.innerHeight, viewport.height);
  let scrollTimer: number | undefined;

  const reveal = () => focusedTextField()?.scrollIntoView({ block: 'center', inline: 'nearest' });
  const update = () => {
    const field = focusedTextField();
    // The baseline is only re-measured while no keyboard can be up, so rotation and browser chrome are followed.
    if (!field) baseline = Math.max(window.innerHeight, viewport.height);
    if (isKeyboardOpen(baseline, viewport.height, field !== undefined)) {
      root.setAttribute('data-keyboard-open', '');
      root.style.setProperty('--visual-viewport-height', `${viewport.height}px`);
      root.style.setProperty('--visual-viewport-top', `${viewport.offsetTop}px`);
      reveal();
    } else {
      root.removeAttribute('data-keyboard-open');
      root.style.removeProperty('--visual-viewport-height');
      root.style.removeProperty('--visual-viewport-top');
    }
  };
  // The keyboard animates in after focus; measure again once it has settled.
  const onFocusChange = () => {
    window.clearTimeout(scrollTimer);
    scrollTimer = window.setTimeout(update, 300);
    update();
  };

  viewport.addEventListener('resize', update);
  viewport.addEventListener('scroll', update);
  document.addEventListener('focusin', onFocusChange);
  document.addEventListener('focusout', onFocusChange);
  return () => {
    window.clearTimeout(scrollTimer);
    viewport.removeEventListener('resize', update);
    viewport.removeEventListener('scroll', update);
    document.removeEventListener('focusin', onFocusChange);
    document.removeEventListener('focusout', onFocusChange);
    root.removeAttribute('data-keyboard-open');
    root.style.removeProperty('--visual-viewport-height');
    root.style.removeProperty('--visual-viewport-top');
  };
}
