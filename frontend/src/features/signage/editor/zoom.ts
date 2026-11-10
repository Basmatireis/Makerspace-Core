/** `fit` follows the canvas size; a number is a fixed scale between MIN_ZOOM and MAX_ZOOM. */
export type Zoom = 'fit' | number;
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;

export const clampZoom = (value: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
