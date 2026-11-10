import type { SignageAspectRatio } from '../../../api/generated/models';

// Pure aspect-ratio helpers. They live next to the renderer because the player imports them; the admin helpers re-export them.

export type Orientation = 'landscape' | 'portrait';

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** Divides both parts by their greatest common divisor, like the server does (1920:1080 becomes 16:9). */
export function reduceRatio(ratio: SignageAspectRatio): SignageAspectRatio {
  const divisor = gcd(ratio.width, ratio.height) || 1;
  return { width: ratio.width / divisor, height: ratio.height / divisor };
}

export const sameRatio = (a: SignageAspectRatio, b: SignageAspectRatio) => {
  const left = reduceRatio(a);
  const right = reduceRatio(b);
  return left.width === right.width && left.height === right.height;
};

/** Landscape when the screen is at least as wide as high. */
export const orientationOf = (ratio: SignageAspectRatio): Orientation =>
  ratio.width >= ratio.height ? 'landscape' : 'portrait';

/** "16:9". */
export const aspectLabel = (ratio: SignageAspectRatio) => {
  const reduced = reduceRatio(ratio);
  return `${reduced.width}:${reduced.height}`;
};

/** Length of a scene's short side in grid units; block geometry and block style lengths are integers in these units. */
export const GRID_SHORT_SIDE = 1080;
/** The old design unit `u` (1 % of the short side) in grid units; default widget sizes are multiples of it. */
export const GRID_UNIT = GRID_SHORT_SIDE / 100;

/**
 * The layout grid of an aspect ratio: the short side is 1080 units (landscape and square `round(1080 · w / h) × 1080`,
 * portrait `1080 × round(1080 · h / w)`), like the server's conversion. Scenes are laid out at exactly this many CSS
 * pixels and scaled as a whole, so every screen of that shape shows the same picture.
 */
export function sceneGridSize(ratio: SignageAspectRatio): { width: number; height: number } {
  if (ratio.width >= ratio.height)
    return { width: Math.round((GRID_SHORT_SIDE * ratio.width) / ratio.height), height: GRID_SHORT_SIDE };
  return { width: GRID_SHORT_SIDE, height: Math.round((GRID_SHORT_SIDE * ratio.height) / ratio.width) };
}

/** Scale that fits a `width` × `height` scene into a `boxWidth` × `boxHeight` box (0 while the box has no size). */
export function frameScale(boxWidth: number, boxHeight: number, width: number, height: number): number {
  if (!(boxWidth > 0) || !(width > 0) || !(height > 0)) return 0;
  return boxHeight > 0 ? Math.min(boxWidth / width, boxHeight / height) : boxWidth / width;
}
