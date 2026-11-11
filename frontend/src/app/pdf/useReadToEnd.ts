import { useCallback, useState } from 'react';

/** How close to the bottom counts as the end, so rounding and the last page's shadow do not keep it locked. */
const endTolerance = 8;

/** Whether a scrolling box shows its last pixels (or needs no scrolling at all). */
export function scrolledToEnd(box: HTMLElement) {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= endTolerance;
}

/**
 * Tracks whether a scrolling PDF box has been scrolled to its end once. `check` is called on scroll and when the
 * document finished rendering: a document that fits without scrolling counts as read as soon as it is shown. A
 * document that could not be rendered unlocks too (`unlock`), so a broken PDF never blocks someone from confirming.
 */
export function useReadToEnd() {
  const [read, setRead] = useState(false);
  const check = useCallback((box: HTMLElement | null | undefined) => {
    if (box && scrolledToEnd(box)) setRead(true);
  }, []);
  const unlock = useCallback(() => setRead(true), []);
  const reset = useCallback(() => setRead(false), []);
  return { read, check, unlock, reset };
}
