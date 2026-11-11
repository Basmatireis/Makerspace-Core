import { describe, expect, it } from 'vitest';
import { clampCrop, cropSourceRect, indicatorPlacement, previewPlacement } from './cameraCrop';

describe('camera crop calibration', () => {
  it('takes the centred largest square without a calibration', () => {
    expect(cropSourceRect(null, 1280, 720)).toEqual({ x: 280, y: 0, side: 720 });
    expect(cropSourceRect(undefined, 720, 1280)).toEqual({ x: 0, y: 280, side: 720 });
  });

  it('maps centre and size onto the frame', () => {
    // A lens at the right of the tablet: the face sits right of the frame centre.
    expect(cropSourceRect({ centerX: 0.7, centerY: 0.5, size: 0.5 }, 1280, 720)).toEqual({ x: 716, y: 180, side: 360 });
  });

  it('keeps the square inside the frame', () => {
    expect(cropSourceRect({ centerX: 1, centerY: 0, size: 0.5 }, 1280, 720)).toEqual({ x: 920, y: 0, side: 360 });
    expect(cropSourceRect({ centerX: 0, centerY: 1, size: 1 }, 1280, 720)).toEqual({ x: 0, y: 0, side: 720 });
  });

  it('bounds the size to the allowed zoom', () => {
    expect(cropSourceRect({ centerX: 0.5, centerY: 0.5, size: 0.05 }, 1000, 1000).side).toBe(200);
    expect(cropSourceRect({ centerX: 0.5, centerY: 0.5, size: 3 }, 1000, 500).side).toBe(500);
  });

  it('reports the centre of the clamped square', () => {
    expect(clampCrop({ centerX: 1, centerY: 0.5, size: 0.5 }, 1280, 720)).toEqual({
      centerX: 1100 / 1280,
      centerY: 0.5,
      size: 0.5,
    });
  });

  it('places the frame so the crop fills the square preview', () => {
    const rect = cropSourceRect({ centerX: 0.7, centerY: 0.5, size: 0.5 }, 1280, 720);
    const style = previewPlacement(rect, 1280, 720);
    expect(parseFloat(String(style.inlineSize))).toBeCloseTo((1280 / 360) * 100);
    expect(parseFloat(String(style.blockSize))).toBeCloseTo(200);
    expect(parseFloat(String(style.insetInlineStart))).toBeCloseTo((-716 / 360) * 100);
    expect(parseFloat(String(style.insetBlockStart))).toBeCloseTo(-50);
  });

  it('puts the lens pointer on its edge at the offset', () => {
    expect(indicatorPlacement({ edge: 'top', offset: 62.5 })).toEqual({ top: 0, left: '62.5%' });
    expect(indicatorPlacement({ edge: 'right', offset: 10 })).toEqual({ right: 0, top: '10%' });
  });
});
