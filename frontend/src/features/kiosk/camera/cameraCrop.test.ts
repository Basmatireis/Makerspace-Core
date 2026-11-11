import { describe, expect, it, vi } from 'vitest';
import { clampCrop, cropSourceRect, displayedRect, drawCrop, indicatorPlacement, previewPlacement } from './cameraCrop';

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

  it('keeps the source square when mirrored and only flips where the preview shows it', () => {
    const crop = { centerX: 0.7, centerY: 0.5, size: 0.5 };
    expect(cropSourceRect(crop, 1280, 720)).toEqual({ x: 716, y: 180, side: 360 });
    const rect = cropSourceRect(crop, 1280, 720);
    expect(displayedRect(rect, 1280, false)).toEqual(rect);
    expect(displayedRect(rect, 1280, true)).toEqual({ x: 204, y: 180, side: 360 });
    const style = previewPlacement(rect, 1280, 720, true);
    expect(style.transform).toBe('scaleX(-1)');
    expect(parseFloat(String(style.insetInlineStart))).toBeCloseTo((-204 / 360) * 100);
    expect(previewPlacement(rect, 1280, 720).transform).toBeUndefined();
  });

  it('draws the capture flipped only when mirrored, from the same source rectangle', () => {
    const make = () => ({ drawImage: vi.fn(), save: vi.fn(), restore: vi.fn(), translate: vi.fn(), scale: vi.fn() });
    const video = {} as CanvasImageSource;
    const rect = { x: 716, y: 180, side: 360 };
    const plain = make();
    drawCrop(plain, video, rect, 360, false);
    expect(plain.scale).not.toHaveBeenCalled();
    expect(plain.drawImage).toHaveBeenCalledWith(video, 716, 180, 360, 360, 0, 0, 360, 360);
    const mirrored = make();
    drawCrop(mirrored, video, rect, 360, true);
    expect(mirrored.translate).toHaveBeenCalledWith(360, 0);
    expect(mirrored.scale).toHaveBeenCalledWith(-1, 1);
    expect(mirrored.drawImage).toHaveBeenCalledWith(video, 716, 180, 360, 360, 0, 0, 360, 360);
    expect(mirrored.restore).toHaveBeenCalled();
  });

  it('lets the square reach every edge of the frame', () => {
    expect(cropSourceRect({ centerX: 0, centerY: 0, size: 0.3 }, 1600, 1200)).toMatchObject({ x: 0, y: 0 });
    const far = cropSourceRect({ centerX: 1, centerY: 1, size: 0.3 }, 1600, 1200);
    expect(far.x + far.side).toBe(1600);
    expect(far.y + far.side).toBe(1200);
    expect(cropSourceRect({ centerX: 0.5, centerY: 0.5, size: 1 }, 1600, 1200).side).toBe(1200);
  });
});
