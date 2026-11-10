// Pure snapping and hit-test maths of the screen editor's canvas. Lengths are grid units (see render/aspect.ts); the
// caller converts pointer pixels to grid units. Nothing here knows about React or the DOM.
import type { SignageBlock } from '../../../api/generated/models';
import { LIMITS } from '../widgets';

export type Rect = { x: number; y: number; w: number; h: number };
export type Grid = { width: number; height: number };
export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** A line a block edge or centre may snap to; `mirror` marks the mirror image of another block across the screen centre. */
export type SnapTarget = { at: number; mirror: boolean };
export type SnapTargets = { xs: SnapTarget[]; ys: SnapTarget[] };
/** `axis: 'x'` is a vertical guide line at x = `at`; `axis: 'y'` a horizontal one at y = `at`. */
export type Guide = { axis: 'x' | 'y'; at: number; mirror: boolean };

export const SNAP_GAP = 24;
export const GRID_STEP = 8;
export const MIN_BLOCK_SIZE = 40;
export const NO_TARGETS: SnapTargets = { xs: [], ys: [] };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Rounds to integers and clamps to the API limits. */
export function clampRect(rect: Rect): Rect {
  const limit = LIMITS.blockCoordinate;
  return {
    x: clamp(Math.round(rect.x), -limit, limit),
    y: clamp(Math.round(rect.y), -limit, limit),
    w: clamp(Math.round(rect.w), LIMITS.blockMinExtent, LIMITS.blockMaxExtent),
    h: clamp(Math.round(rect.h), LIMITS.blockMinExtent, LIMITS.blockMaxExtent),
  };
}

/**
 * Lines blocks snap to: the screen edges, centre and margins, and for every visible block outside `excludeIds` its
 * edges, centre, the 24-unit gap lines beside it and its mirror image across the screen centre.
 */
export function snapTargets(
  blocks: readonly SignageBlock[],
  grid: Grid,
  margin: number,
  excludeIds: readonly string[] = [],
): SnapTargets {
  const skip = new Set(excludeIds);
  const plain = (...values: number[]): SnapTarget[] => values.map((at) => ({ at, mirror: false }));
  const xs = plain(0, grid.width / 2, grid.width, margin, grid.width - margin);
  const ys = plain(0, grid.height / 2, grid.height, margin, grid.height - margin);
  for (const block of blocks) {
    if (skip.has(block.id) || block.hidden) continue;
    const { x, y, w, h } = block;
    xs.push(
      ...plain(x, x + w / 2, x + w, x - SNAP_GAP, x + w + SNAP_GAP),
      { at: grid.width - x - w, mirror: true },
      { at: grid.width - x, mirror: true },
    );
    ys.push(
      ...plain(y, y + h / 2, y + h, y - SNAP_GAP, y + h + SNAP_GAP),
      { at: grid.height - y - h, mirror: true },
      { at: grid.height - y, mirror: true },
    );
  }
  return { xs, ys };
}

type Best = { delta: number; at: number; mirror: boolean };

/** The nearest target within `threshold` of any edge; a plain alignment wins a tie with a mirror target. */
function bestSnap(edges: number[], targets: readonly SnapTarget[], threshold: number): Best | null {
  let best: Best | null = null;
  for (const edge of edges) {
    for (const target of targets) {
      const delta = target.at - edge;
      if (Math.abs(delta) > threshold) continue;
      if (
        !best ||
        Math.abs(delta) < Math.abs(best.delta) ||
        (Math.abs(delta) === Math.abs(best.delta) && best.mirror && !target.mirror)
      )
        best = { delta, at: target.at, mirror: target.mirror };
    }
  }
  return best;
}

const toGrid = (value: number, step: number) => (step > 0 ? Math.round(value / step) * step : value);

/** Snaps one coordinate: onto a target (recording a guide) or, failing that, onto the grid. */
function snapAxis(
  axis: 'x' | 'y',
  edges: number[],
  targets: readonly SnapTarget[],
  threshold: number,
  step: number,
  guides: Guide[],
): number {
  const best = bestSnap(edges, targets, threshold);
  if (!best) return toGrid(edges[0], step) - edges[0];
  guides.push({ axis, at: best.at, mirror: best.mirror });
  return best.delta;
}

/** Moves a rectangle (a block or the bounds of a selection) that the pointer dragged to `rect`; edges and centres snap. */
export function snapMove(
  rect: Rect,
  targets: SnapTargets,
  threshold: number,
  gridStep = GRID_STEP,
): { rect: Rect; guides: Guide[] } {
  const guides: Guide[] = [];
  const dx = snapAxis('x', [rect.x, rect.x + rect.w / 2, rect.x + rect.w], targets.xs, threshold, gridStep, guides);
  const dy = snapAxis('y', [rect.y, rect.y + rect.h / 2, rect.y + rect.h], targets.ys, threshold, gridStep, guides);
  return { rect: clampRect({ ...rect, x: rect.x + dx, y: rect.y + dy }), guides };
}

/**
 * Resizes `rect0` by dragging `handle` by (dx, dy). Only the dragged edges move and snap (to targets, else the
 * grid); the opposite edges stay put and no side gets shorter than `minSize`.
 */
export function snapResize(
  rect0: Rect,
  handle: Handle,
  dx: number,
  dy: number,
  targets: SnapTargets,
  threshold: number,
  gridStep = GRID_STEP,
  minSize = MIN_BLOCK_SIZE,
): { rect: Rect; guides: Guide[] } {
  const guides: Guide[] = [];
  const moved = (axis: 'x' | 'y', edge: number) =>
    edge + snapAxis(axis, [edge], axis === 'x' ? targets.xs : targets.ys, threshold, gridStep, guides);
  let left = rect0.x;
  let top = rect0.y;
  let right = rect0.x + rect0.w;
  let bottom = rect0.y + rect0.h;
  if (handle.includes('e')) right = Math.max(left + minSize, Math.round(moved('x', right + dx)));
  if (handle.includes('w')) left = Math.min(right - minSize, Math.round(moved('x', left + dx)));
  if (handle.includes('s')) bottom = Math.max(top + minSize, Math.round(moved('y', bottom + dy)));
  if (handle.includes('n')) top = Math.min(bottom - minSize, Math.round(moved('y', top + dy)));
  return { rect: clampRect({ x: left, y: top, w: right - left, h: bottom - top }), guides };
}

/** The bounds of a set of rectangles (null when empty). */
export function boundsOf(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return {
    x,
    y,
    w: Math.max(...rects.map((r) => r.x + r.w)) - x,
    h: Math.max(...rects.map((r) => r.y + r.h)) - y,
  };
}

/** Ids of the visible, unlocked blocks a marquee frame touches (blocks only edge to edge do not count), back to front. */
export function marqueeHits(blocks: readonly SignageBlock[], rect: Rect): string[] {
  return blocks
    .filter(
      (b) =>
        !b.hidden &&
        !b.locked &&
        b.x < rect.x + rect.w &&
        b.x + b.w > rect.x &&
        b.y < rect.y + rect.h &&
        b.y + b.h > rect.y,
    )
    .map((b) => b.id);
}
