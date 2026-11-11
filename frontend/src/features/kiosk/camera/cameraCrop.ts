import type { KioskCameraCrop, KioskCameraIndicator } from '../../../api/generated/models';
import type { CSSProperties } from 'react';

/** The default crop: the centred largest square of the frame, which is what an uncalibrated kiosk uses. */
export const defaultCrop: KioskCameraCrop = { centerX: 0.5, centerY: 0.5, size: 1 };
export const minCropSize = 0.2;

/** A square in camera-frame pixels: its top-left corner and side. */
export type SourceRect = { x: number; y: number; side: number };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Maps a kiosk's calibrated crop onto a camera frame of `width`×`height` pixels. The side is a fraction of the shorter
 * frame side and the square is pushed back inside the frame, so a calibration made at one resolution still yields a
 * valid square at another. The live preview and the captured photo both use this rectangle.
 */
export function cropSourceRect(crop: KioskCameraCrop | null | undefined, width: number, height: number): SourceRect {
  const { centerX, centerY, size } = crop ?? defaultCrop;
  const side = clamp(size, minCropSize, 1) * Math.min(width, height);
  return {
    x: clamp(centerX * width - side / 2, 0, width - side),
    y: clamp(centerY * height - side / 2, 0, height - side),
    side,
  };
}

/** The crop that `cropSourceRect` actually used, so a calibration never stores a centre outside its clamped square. */
export function clampCrop(crop: KioskCameraCrop, width: number, height: number): KioskCameraCrop {
  const rect = cropSourceRect(crop, width, height);
  return {
    centerX: (rect.x + rect.side / 2) / width,
    centerY: (rect.y + rect.side / 2) / height,
    size: rect.side / Math.min(width, height),
  };
}

/**
 * Positions the whole camera frame inside a square viewport so that exactly `rect` fills it. Percentages of a square
 * box are the same along both axes, so the viewport may have any size.
 */
export function previewPlacement(rect: SourceRect, width: number, height: number): CSSProperties {
  const scale = 100 / rect.side;
  return {
    position: 'absolute',
    inlineSize: `${width * scale}%`,
    blockSize: `${height * scale}%`,
    insetInlineStart: `${-rect.x * scale}%`,
    insetBlockStart: `${-rect.y * scale}%`,
    maxInlineSize: 'none',
    objectFit: 'fill',
  };
}

/** Where the lens pointer sits: on the given screen edge, `offset` percent along it (from the left or the top). */
export function indicatorPlacement(indicator: KioskCameraIndicator): CSSProperties {
  const along = `${clamp(indicator.offset, 0, 100)}%`;
  switch (indicator.edge) {
    case 'top':
      return { top: 0, left: along };
    case 'bottom':
      return { bottom: 0, left: along };
    case 'left':
      return { left: 0, top: along };
    case 'right':
      return { right: 0, top: along };
  }
}
