// Overflow detection and "shrink text to fit", shared by the renderer and the scene editor. Both measure layout boxes
// (offsetTop/offsetHeight of the block's content), not glyph ink: a large clock at line-height 1 does not overflow
// because of its descenders. Layout sizes ignore CSS transforms, so the scene is measured in grid pixels and the result
// is the same at every preview scale and on every display of that shape (given the same fonts).

/** Smallest size "shrink text to fit" goes down to: the smallest text size a block can have. */
export const MIN_FIT_TEXT_SIZE = 8;

/** One pixel of tolerance against sub-pixel rounding. */
const TOLERANCE = 1;

/**
 * True when the children of a block's content box (`.sg-block__in`) do not fit inside its padding box: a child starts
 * above the top padding (vertically centred content that is too tall), ends below the bottom padding, or is wider than
 * the content box. Absolutely positioned children (overlays) and style elements are ignored.
 */
export function contentOverflows(inner: HTMLElement): boolean {
  const view = inner.ownerDocument.defaultView;
  if (!view) return false;
  const computed = view.getComputedStyle(inner);
  const top = parseFloat(computed.paddingTop) || 0;
  const bottom = inner.clientHeight - (parseFloat(computed.paddingBottom) || 0);
  const right = inner.clientWidth - (parseFloat(computed.paddingRight) || 0);
  for (const child of Array.from(inner.children)) {
    if (!(child instanceof view.HTMLElement) || child.tagName === 'STYLE') continue;
    if (view.getComputedStyle(child).position === 'absolute') continue;
    if (
      child.offsetTop < top - TOLERANCE ||
      child.offsetTop + child.offsetHeight > bottom + TOLERANCE ||
      child.offsetLeft + Math.max(child.offsetWidth, child.scrollWidth) > right + TOLERANCE
    )
      return true;
  }
  return false;
}

/** True when the content of a rendered block (an element with `data-block-id`) does not fit; empty blocks never do. */
export function blockOverflows(block: Element): boolean {
  const inner = block.querySelector<HTMLElement>(':scope > .sg-block__in');
  return inner !== null && inner.children.length > 0 && contentOverflows(inner);
}

/** Ids of the rendered blocks under `root` whose content does not fit, in stacking order. */
export function overflowingBlockIds(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-block-id]'))
    .filter(blockOverflows)
    .map((block) => block.dataset.blockId!);
}

/**
 * The largest integer font size from `min` to `max` for which `fits` is true (binary search, at most ten steps for the
 * largest text size), or `min` when nothing fits. Integer sizes keep the result identical on every screen.
 */
export function fitTextSize(max: number, fits: (size: number) => boolean, min = MIN_FIT_TEXT_SIZE): number {
  const top = Math.max(min, Math.floor(max));
  if (fits(top)) return top;
  let low = min;
  let high = top - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * Shrinks `element` (the text of a text block, a child of `.sg-block__in`) to the largest font size up to `max` at
 * which the block's content fits, sets it as its inline font size and returns it.
 */
export function shrinkToFit(element: HTMLElement, max: number): number {
  const inner = element.parentElement;
  if (!inner) return max;
  const size = fitTextSize(max, (candidate) => {
    element.style.fontSize = `${candidate}px`;
    return !contentOverflows(inner);
  });
  element.style.fontSize = `${size}px`;
  return size;
}
