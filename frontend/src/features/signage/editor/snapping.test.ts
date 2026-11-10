import { describe, expect, it } from 'vitest';
import { GRID, block } from './testBlocks';
import { NO_TARGETS, boundsOf, clampRect, marqueeHits, snapMove, snapResize, snapTargets } from './snapping';

describe('snapTargets', () => {
  it('has screen edges, centre and margins', () => {
    const t = snapTargets([], GRID, 48);
    expect(t.xs.map((x) => x.at)).toEqual([0, 960, 1920, 48, 1872]);
    expect(t.ys.map((y) => y.at)).toEqual([0, 540, 1080, 48, 1032]);
  });
  it('adds edges, centre, gaps and mirrors of other blocks and skips excluded and hidden ones', () => {
    const blocks = [
      block('a', 100, 200, 300, 100),
      block('b', 0, 0, 10, 10, { hidden: true }),
      block('c', 5, 5, 20, 20),
    ];
    const t = snapTargets(blocks, GRID, 48, ['c']);
    const plain = t.xs.filter((x) => !x.mirror).map((x) => x.at);
    expect(plain).toEqual(expect.arrayContaining([100, 250, 400, 76, 424]));
    expect(t.xs.filter((x) => x.mirror).map((x) => x.at)).toEqual([1920 - 400, 1920 - 100]);
    expect(t.ys.filter((y) => y.mirror).map((y) => y.at)).toEqual([1080 - 300, 1080 - 200]);
    expect(t.xs).toHaveLength(5 + 7);
  });
});

describe('snapMove', () => {
  const targets = snapTargets([block('a', 400, 100, 200, 100)], GRID, 48);
  it('snaps the left edge to another block and reports a guide', () => {
    const r = snapMove({ x: 403, y: 500, w: 100, h: 100 }, targets, 6);
    expect(r.rect.x).toBe(400);
    expect(r.guides).toContainEqual({ axis: 'x', at: 400, mirror: false });
  });
  it('snaps a centre', () => {
    const r = snapMove({ x: 910, y: 500, w: 100, h: 100 }, targets, 6);
    expect(r.rect.x).toBe(910);
    expect(r.guides.find((g) => g.axis === 'x')?.at).toBe(960);
  });
  it('falls back to the 8 grid per axis when nothing is near', () => {
    const r = snapMove({ x: 1203, y: 614, w: 100, h: 100 }, targets, 6);
    expect(r.rect).toEqual({ x: 1200, y: 616, w: 100, h: 100 });
    expect(r.guides).toEqual([]);
  });
  it('snaps to the mirror image and marks the guide', () => {
    // a mirrors to x = 1920-600 .. 1920-400 = 1320 .. 1520
    const r = snapMove({ x: 1318, y: 800, w: 100, h: 100 }, targets, 6);
    expect(r.rect.x).toBe(1320);
    expect(r.guides).toContainEqual({ axis: 'x', at: 1320, mirror: true });
  });
  it('prefers a plain target over a mirror at equal distance', () => {
    const t = {
      xs: [
        { at: 100, mirror: true },
        { at: 100, mirror: false },
      ],
      ys: [],
    };
    expect(snapMove({ x: 98, y: 0, w: 50, h: 50 }, t, 6).guides[0].mirror).toBe(false);
    const t2 = {
      xs: [
        { at: 100, mirror: false },
        { at: 100, mirror: true },
      ],
      ys: [],
    };
    expect(snapMove({ x: 98, y: 0, w: 50, h: 50 }, t2, 6).guides[0].mirror).toBe(false);
  });
  it('picks the nearest target', () => {
    const t = {
      xs: [
        { at: 100, mirror: false },
        { at: 104, mirror: false },
      ],
      ys: [],
    };
    expect(snapMove({ x: 103, y: 0, w: 50, h: 50 }, t, 6).rect.x).toBe(104);
  });
  it('without a grid step only rounds', () => {
    expect(snapMove({ x: 12.4, y: 7.6, w: 50, h: 50 }, NO_TARGETS, 6, 0).rect).toMatchObject({ x: 12, y: 8 });
  });
  it('clamps to the API limits', () => {
    expect(snapMove({ x: 99999, y: -99999, w: 50, h: 50 }, NO_TARGETS, 6).rect).toMatchObject({ x: 8000, y: -8000 });
  });
});

describe('snapResize', () => {
  const r0 = { x: 200, y: 200, w: 400, h: 300 };
  const targets = snapTargets([block('a', 700, 600, 100, 100)], GRID, 48);
  it('moves only the dragged edge (east) and snaps it', () => {
    const r = snapResize(r0, 'e', 98, 55, targets, 6);
    expect(r.rect).toEqual({ x: 200, y: 200, w: 500, h: 300 });
    expect(r.guides).toEqual([{ axis: 'x', at: 700, mirror: false }]);
  });
  it('resizes from the north-west corner keeping the opposite corner', () => {
    const r = snapResize(r0, 'nw', -53, -61, NO_TARGETS, 6);
    expect(r.rect).toEqual({ x: 144, y: 136, w: 456, h: 364 });
  });
  it('resizes south and west with grid fallback', () => {
    const r = snapResize(r0, 'sw', -13, 13, NO_TARGETS, 6);
    expect(r.rect).toEqual({ x: 184, y: 200, w: 416, h: 312 });
  });
  it('keeps the minimum size, also when dragged past the opposite edge', () => {
    expect(snapResize(r0, 'e', -900, 0, NO_TARGETS, 6).rect.w).toBe(40);
    const w = snapResize(r0, 'w', 900, 0, NO_TARGETS, 6).rect;
    expect(w.w).toBe(40);
    expect(w.x + w.w).toBe(600);
    const n = snapResize(r0, 'n', 0, 900, NO_TARGETS, 6).rect;
    expect(n.h).toBe(40);
    expect(n.y + n.h).toBe(500);
    expect(snapResize(r0, 's', 0, -900, NO_TARGETS, 6, 8, 100).rect.h).toBe(100);
  });
  it('snaps to a mirror target', () => {
    const t = snapTargets([block('a', 100, 100, 200, 100)], GRID, 48); // mirror x 1620..1820
    const r = snapResize({ x: 1000, y: 0, w: 400, h: 100 }, 'e', 218, 0, t, 6);
    expect(r.rect.x + r.rect.w).toBe(1620);
    expect(r.guides[0]).toMatchObject({ at: 1620, mirror: true });
  });
});

describe('geometry helpers', () => {
  it('clampRect rounds and limits', () => {
    expect(clampRect({ x: 1.5, y: -9000, w: 2, h: 9000.4 })).toEqual({ x: 2, y: -8000, w: 8, h: 8000 });
  });
  it('boundsOf', () => {
    expect(boundsOf([])).toBeNull();
    expect(
      boundsOf([
        { x: 10, y: 20, w: 30, h: 40 },
        { x: 0, y: 50, w: 20, h: 100 },
      ]),
    ).toEqual({ x: 0, y: 20, w: 40, h: 130 });
  });
});

describe('marqueeHits', () => {
  const blocks = [
    block('a', 0, 0, 100, 100),
    block('b', 200, 0, 100, 100),
    block('c', 50, 50, 100, 100, { hidden: true }),
    block('d', 60, 60, 100, 100, { locked: true }),
  ];
  it('returns touched visible unlocked blocks', () => {
    expect(marqueeHits(blocks, { x: 90, y: 90, w: 100, h: 5 })).toEqual(['a']);
    expect(marqueeHits(blocks, { x: 0, y: 0, w: 1000, h: 1000 })).toEqual(['a', 'b']);
  });
  it('does not count edge contact', () => {
    expect(marqueeHits(blocks, { x: 100, y: 0, w: 100, h: 100 })).toEqual([]);
  });
});
