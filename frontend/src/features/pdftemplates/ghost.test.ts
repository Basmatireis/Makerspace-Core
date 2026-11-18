import { describe, expect, it } from 'vitest';
import { ghostLayout, moved, sourceRect, stretchesOnResize } from './ghost';

const page = { width: 210, height: 297 };

describe('sourceRect', () => {
  it('covers the box and a margin with whole device pixels, and reports the area they cover', () => {
    // 3 px per mm.
    const r = sourceRect({ x: 10, y: 20, w: 40, h: 10 }, page, { width: 630, height: 891 }, 0.5)!;
    expect(r).toMatchObject({ sx: 28, sy: 58, sw: 124, sh: 34 });
    expect(Number.isInteger(r.sx + r.sy + r.sw + r.sh)).toBe(true);
    expect(r.area.x).toBeCloseTo(28 / 3);
    expect(r.area.x + r.area.w).toBeGreaterThanOrEqual(50.5);
    expect(r.area.y + r.area.h).toBeGreaterThanOrEqual(30.5);
  });
  it('is exact for a non-integer device ratio', () => {
    const r = sourceRect({ x: 0, y: 0, w: 210, h: 297 }, page, { width: 1000, height: 1414 })!;
    expect(r).toMatchObject({ sx: 0, sy: 0, sw: 1000, sh: 1414 });
  });
  it('clamps to the canvas and gives nothing for a box off the page', () => {
    expect(sourceRect({ x: 200, y: 290, w: 40, h: 40 }, page, { width: 210, height: 297 })).toMatchObject({
      sx: 199,
      sy: 289,
      sw: 11,
      sh: 8,
    });
    expect(sourceRect({ x: 300, y: 10, w: 5, h: 5 }, page, { width: 210, height: 297 })).toBeNull();
    expect(sourceRect({ x: 0, y: 0, w: 1, h: 1 }, page, { width: 0, height: 0 })).toBeNull();
  });
  it('copes with a line that has no height', () => {
    expect(sourceRect({ x: 20, y: 100, w: 100, h: 0 }, page, { width: 210, height: 297 }, 0.6)!.sh).toBeGreaterThan(0);
  });
});

describe('ghostLayout', () => {
  const from = { x: 10, y: 20, w: 40, h: 10 };
  const area = { x: 9.5, y: 19.5, w: 41, h: 11 };
  it('moves the copy by the distance the box moved', () => {
    const at = ghostLayout(from, { ...from, x: 15, y: 25 }, area, 2, false, 0.5);
    expect(at.window).toEqual({ left: 29, top: 49, width: 82, height: 22 });
    // The copy starts where the window does: it was cut out one margin before the box.
    expect(at.picture).toEqual({ left: 0, top: 0, width: 82, height: 22 });
  });
  it('stretches the copy with the box, or keeps its size and lets the window clip it', () => {
    const wider = { ...from, w: 80 };
    expect(ghostLayout(from, wider, area, 1, true, 0.5).picture.width).toBeCloseTo(82);
    const clipped = ghostLayout(from, wider, area, 1, false, 0.5);
    expect(clipped.picture.width).toBeCloseTo(41);
    expect(clipped.window.width).toBeCloseTo(81);
  });
  it('does not divide by a zero size', () => {
    const line = { x: 0, y: 5, w: 50, h: 0 };
    const out = ghostLayout(line, { ...line, w: 80, h: 0 }, { x: 0, y: 4.4, w: 51, h: 1.2 }, 1, true);
    expect(Number.isFinite(out.picture.height)).toBe(true);
  });
});

describe('moved and stretching kinds', () => {
  it('tells a changed box from rounding noise', () => {
    expect(moved({ x: 1, y: 2, w: 3, h: 4 }, { x: 1.001, y: 2, w: 3, h: 4 })).toBe(false);
    expect(moved({ x: 1, y: 2, w: 3, h: 4 }, { x: 1, y: 2.5, w: 3, h: 4 })).toBe(true);
  });
  it('stretches shapes and images, not text', () => {
    expect(stretchesOnResize('rect')).toBe(true);
    expect(stretchesOnResize('ptext')).toBe(false);
  });
});
