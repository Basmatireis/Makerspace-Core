/**
 * The live "ghost" of a page-layer element while it is moved or resized: the rendered pixels of its box are copied once,
 * and shown at the new place until the server's next render replaces the page. Pure geometry, so it can be tested without
 * a canvas. All lengths are millimetres on the page unless a name says px.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Margin around the box that is copied too, for glyphs and strokes that stick out of it. */
export const GHOST_PAD_MM = 0.6;

export interface SourceRect {
  /** Pixels of the page canvas to copy (whole pixels, inside the canvas). */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** The same area in mm, which is what the pixels cover exactly. */
  area: Rect;
}

/**
 * The pixels of the page canvas that cover `box` plus a margin, rounded outwards to whole device pixels and clamped to the
 * canvas, with the area those pixels cover in mm. Null when nothing is left to copy.
 */
export function sourceRect(
  box: Rect,
  page: { width: number; height: number },
  canvas: { width: number; height: number },
  pad = GHOST_PAD_MM,
): SourceRect | null {
  if (!page.width || !page.height || !canvas.width || !canvas.height) return null;
  const kx = canvas.width / page.width;
  const ky = canvas.height / page.height;
  const sx = Math.max(0, Math.floor((box.x - pad) * kx));
  const sy = Math.max(0, Math.floor((box.y - pad) * ky));
  const ex = Math.min(canvas.width, Math.ceil((box.x + box.w + pad) * kx));
  const ey = Math.min(canvas.height, Math.ceil((box.y + box.h + pad) * ky));
  if (ex <= sx || ey <= sy) return null;
  return { sx, sy, sw: ex - sx, sh: ey - sy, area: { x: sx / kx, y: sy / ky, w: (ex - sx) / kx, h: (ey - sy) / ky } };
}

/** Kinds whose picture can be stretched when they are resized: shapes and images. Text is clipped instead. */
const STRETCH = ['rect', 'ellipse', 'line', 'graphic', 'picture', 'qr', 'barcode'];
export const stretchesOnResize = (type: string): boolean => STRETCH.includes(type);

export interface GhostLayout {
  /** The clipping window, in px: the new box with the margin. */
  window: { left: number; top: number; width: number; height: number };
  /** The copied picture inside the window, in px. */
  picture: { left: number; top: number; width: number; height: number };
}

/**
 * Where the copy goes when the element is at `now`: it keeps its look and moves with the box; when the size changed it is
 * stretched to the new box (`stretch`) or kept at its size and clipped by the new box.
 */
export function ghostLayout(
  from: Rect,
  now: Rect,
  area: Rect,
  k: number,
  stretch: boolean,
  pad = GHOST_PAD_MM,
): GhostLayout {
  const fx = stretch && from.w > 0 ? now.w / from.w : 1;
  const fy = stretch && from.h > 0 ? now.h / from.h : 1;
  const window = {
    left: (now.x - pad) * k,
    top: (now.y - pad) * k,
    width: (now.w + 2 * pad) * k,
    height: (now.h + 2 * pad) * k,
  };
  // The picture's offset from the top-left corner of the window (which sits `pad` before the box).
  const picture = {
    left: (area.x - from.x + pad) * fx * k,
    top: (area.y - from.y + pad) * fy * k,
    width: area.w * fx * k,
    height: area.h * fy * k,
  };
  return { window, picture };
}

/** True when the element is not where the render drew it (beyond rounding). */
export const moved = (from: Rect, now: Rect, eps = 0.005): boolean =>
  Math.abs(from.x - now.x) > eps ||
  Math.abs(from.y - now.y) > eps ||
  Math.abs(from.w - now.w) > eps ||
  Math.abs(from.h - now.h) > eps;
