// Geometry of the round profile photo mask. Everything is expressed in units of the mask diameter, so it does not
// depend on how large the mask is drawn: at zoom 1 the image just covers the mask, and the offset is how far the
// image centre has moved from the mask centre.

export const cropOutputSize = 512;
export const minZoom = 1;
export const maxZoom = 3;

export type CropView = { zoom: number; x: number; y: number };
export type CropRect = { sx: number; sy: number; size: number };

/** Displayed image size in mask diameters. */
export function imageExtent(naturalWidth: number, naturalHeight: number, zoom: number) {
  const shortSide = Math.min(naturalWidth, naturalHeight);
  return { width: (naturalWidth / shortSide) * zoom, height: (naturalHeight / shortSide) * zoom };
}

/** Clamps zoom and offset so the mask is always completely covered by the image. */
export function clampCropView(naturalWidth: number, naturalHeight: number, view: CropView): CropView {
  const zoom = Math.min(maxZoom, Math.max(minZoom, view.zoom));
  const extent = imageExtent(naturalWidth, naturalHeight, zoom);
  const limitX = (extent.width - 1) / 2;
  const limitY = (extent.height - 1) / 2;
  return {
    zoom,
    // "+ 0" turns a negative zero (from a zero limit) into a plain zero.
    x: Math.min(limitX, Math.max(-limitX, view.x)) + 0,
    y: Math.min(limitY, Math.max(-limitY, view.y)) + 0,
  };
}

/** The square of source pixels that lies under the mask. */
export function cropSourceRect(naturalWidth: number, naturalHeight: number, view: CropView): CropRect {
  const { zoom, x, y } = clampCropView(naturalWidth, naturalHeight, view);
  const size = Math.min(naturalWidth, naturalHeight) / zoom;
  // The offset moves the image, so the visible window moves the opposite way.
  const centerX = naturalWidth / 2 - x * size;
  const centerY = naturalHeight / 2 - y * size;
  return { sx: centerX - size / 2, sy: centerY - size / 2, size };
}

/** Draws the cropped square as a JPEG; transparent areas of a PNG or WebP become white. */
export function renderCrop(image: CanvasImageSource, rect: CropRect): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = cropOutputSize;
  canvas.height = cropOutputSize;
  const context = canvas.getContext('2d');
  if (!context) return Promise.reject(new Error('Canvas is not available'));
  context.fillStyle = '#fff';
  context.fillRect(0, 0, cropOutputSize, cropOutputSize);
  context.drawImage(image, rect.sx, rect.sy, rect.size, rect.size, 0, 0, cropOutputSize, cropOutputSize);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('The photo could not be encoded'))),
      'image/jpeg',
      0.9,
    );
  });
}
