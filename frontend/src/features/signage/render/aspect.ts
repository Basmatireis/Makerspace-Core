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
