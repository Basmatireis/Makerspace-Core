import { describe, expect, it } from 'vitest';
import { clampCropView, cropSourceRect, imageExtent } from './profilePhotoCrop';

describe('profile photo crop geometry', () => {
  it('crops the centred short-side square at zoom 1', () => {
    expect(cropSourceRect(1600, 1200, { zoom: 1, x: 0, y: 0 })).toEqual({ sx: 200, sy: 0, size: 1200 });
    expect(cropSourceRect(900, 1200, { zoom: 1, x: 0, y: 0 })).toEqual({ sx: 0, sy: 150, size: 900 });
  });

  it('zooming narrows the window around the centre', () => {
    expect(cropSourceRect(1000, 1000, { zoom: 2, x: 0, y: 0 })).toEqual({ sx: 250, sy: 250, size: 500 });
  });

  it('moving the image right shows the part to its left', () => {
    // At zoom 2 the image is two masks wide, so it may move half a mask either way.
    const rect = cropSourceRect(1000, 1000, { zoom: 2, x: 0.5, y: 0 });
    expect(rect).toEqual({ sx: 0, sy: 250, size: 500 });
    expect(cropSourceRect(1000, 1000, { zoom: 2, x: -0.5, y: 0.5 })).toEqual({ sx: 500, sy: 0, size: 500 });
  });

  it('never lets the mask leave the image', () => {
    expect(clampCropView(1000, 1000, { zoom: 1, x: 3, y: -3 })).toEqual({ zoom: 1, x: 0, y: 0 });
    expect(clampCropView(1000, 1000, { zoom: 2, x: 9, y: -9 })).toEqual({ zoom: 2, x: 0.5, y: -0.5 });
    // A landscape image has slack only along its long side.
    expect(clampCropView(2000, 1000, { zoom: 1, x: 5, y: 5 })).toEqual({ zoom: 1, x: 0.5, y: 0 });
    const rect = cropSourceRect(2000, 1000, { zoom: 1, x: 5, y: 5 });
    expect(rect).toEqual({ sx: 0, sy: 0, size: 1000 });
  });

  it('limits the zoom to the supported range', () => {
    expect(clampCropView(1000, 1000, { zoom: 9, x: 0, y: 0 }).zoom).toBe(3);
    expect(clampCropView(1000, 1000, { zoom: 0.2, x: 0, y: 0 }).zoom).toBe(1);
    expect(imageExtent(2000, 1000, 2)).toEqual({ width: 4, height: 2 });
  });
});
