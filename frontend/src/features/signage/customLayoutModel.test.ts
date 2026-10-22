import { describe, expect, it } from 'vitest';
import type { SignageCustomLayoutZone } from '../../api/generated/models';
import {
  affectedScenes,
  blankLayout,
  dragRect,
  fitZonesToGrid,
  gridToRects,
  layoutError,
  nextZoneId,
  normalizeRect,
  rectsToGrid,
} from './customLayoutModel';

const gridZone = (id: string, col: number, row: number, colSpan = 1, rowSpan = 1): SignageCustomLayoutZone => ({
  id,
  label: id.toUpperCase(),
  grid: { col, row, colSpan, rowSpan },
  rect: null,
});
const freeZone = (id: string, x: number, y: number, width: number, height: number): SignageCustomLayoutZone => ({
  id,
  label: id.toUpperCase(),
  grid: null,
  rect: { x, y, width, height },
});

describe('custom layout model', () => {
  it('generates the smallest unused zone id and keeps existing ones', () => {
    expect(nextZoneId([])).toBe('z1');
    expect(nextZoneId([{ id: 'z1' }, { id: 'z3' }])).toBe('z2');
    expect(nextZoneId([{ id: 'z1' }, { id: 'z2' }])).toBe('z3');
  });

  it('turns grid zones into rectangles by track weights', () => {
    const rects = gridToRects([2, 1], [1, 1], [gridZone('z1', 1, 1, 1, 2), gridZone('z2', 2, 2)]);
    expect(rects[0].rect).toEqual({ x: 0, y: 0, width: 66.67, height: 100 });
    expect(rects[1].rect).toEqual({ x: 66.67, y: 50, width: 33.33, height: 50 });
    expect(rects.every((zone) => zone.grid === null)).toBe(true);
  });

  it('turns rectangles into the smallest grid that holds them and drops overlapping zones', () => {
    const result = rectsToGrid([
      freeZone('z1', 0, 0, 50, 100),
      freeZone('z2', 50, 0, 50, 50),
      freeZone('z3', 51, 50, 49, 50),
      freeZone('z4', 0, 0, 50, 50),
    ]);
    expect(result.columns).toEqual([51, 50]);
    expect(result.rows).toEqual([50, 50]);
    expect(result.zones.map((zone) => [zone.id, zone.grid])).toEqual([
      ['z1', { col: 1, row: 1, colSpan: 1, rowSpan: 2 }],
      ['z2', { col: 2, row: 1, colSpan: 1, rowSpan: 1 }],
      ['z3', { col: 2, row: 2, colSpan: 1, rowSpan: 1 }],
    ]);
    expect(result.dropped.map((zone) => zone.id)).toEqual(['z4']);
    expect(
      layoutError({ name: 'x', mode: 'grid', columns: result.columns, rows: result.rows, zones: result.zones }),
    ).toBe(null);
  });

  it('keeps conversions within twelve tracks', () => {
    const zones = Array.from({ length: 12 }, (_, index) => freeZone(`z${index + 1}`, index * 7.7, index * 7.7, 7, 7));
    const result = rectsToGrid(zones);
    expect(result.columns.length).toBeLessThanOrEqual(12);
    expect(result.rows.length).toBeLessThanOrEqual(12);
  });

  it('clips zones when the grid shrinks', () => {
    const fitted = fitZonesToGrid([gridZone('z1', 1, 1, 3), gridZone('z2', 3, 1)], 2, 1);
    expect(fitted.zones.map((zone) => zone.grid?.colSpan)).toEqual([2]);
    expect(fitted.removed.map((zone) => zone.id)).toEqual(['z2']);
  });

  it('snaps moves and resizes to half a percent and keeps zones on the screen', () => {
    const start = { x: 10, y: 10, width: 20, height: 20 };
    expect(dragRect(start, 3.3, -50)).toEqual({ x: 13.5, y: 0, width: 20, height: 20 });
    expect(dragRect(start, 500, 0)).toEqual({ x: 80, y: 10, width: 20, height: 20 });
    expect(dragRect(start, 10.2, 5, { s: true, e: true })).toEqual({ x: 10, y: 10, width: 30, height: 25 });
    expect(dragRect(start, 100, 0, { w: true })).toEqual({ x: 29, y: 10, width: 1, height: 20 });
    expect(normalizeRect({ x: 99, y: 0, width: 10, height: 0 }, 0.01)).toEqual({ x: 90, y: 0, width: 10, height: 1 });
  });

  it('mirrors the backend rules in layoutError', () => {
    const base = blankLayout();
    expect(layoutError({ ...base, name: 'Two columns' })).toBeNull();
    expect(layoutError({ ...base, name: '  ' })).toMatch(/name/);
    expect(layoutError({ ...base, name: 'x', zones: [gridZone('z1', 1, 1, 2), gridZone('z2', 2, 1)] })).toMatch(
      /overlap/,
    );
    expect(layoutError({ ...base, name: 'x', zones: [gridZone('z1', 2, 1, 2)] })).toMatch(/outside/);
    expect(layoutError({ ...base, name: 'x', columns: [1, 101] })).toMatch(/weights/);
    expect(layoutError({ ...base, name: 'x', mode: 'free', zones: [freeZone('z1', 95, 0, 10, 10)] })).toMatch(/screen/);
    expect(layoutError({ ...base, name: 'x', mode: 'free', zones: [freeZone('z1', 0, 0, 10.123, 10)] })).toMatch(
      /decimals/,
    );
    const many = Array.from({ length: 13 }, (_, index) => gridZone(`z${index + 1}`, 1, 1));
    expect(layoutError({ ...base, name: 'x', zones: many })).toMatch(/at most 12/);
  });

  it('lists scenes that lose a non-empty widget in a removed zone', () => {
    const scenes: Parameters<typeof affectedScenes>[0] = [
      {
        id: 's1',
        name: 'Poster',
        customLayoutId: 'L',
        zones: {
          z1: { type: 'text' as const, text: 'x', size: 'm' as const, align: 'start' as const },
          z2: { type: 'empty' as const },
        },
      },
      {
        id: 's2',
        name: 'Empty',
        customLayoutId: 'L',
        zones: { z1: { type: 'empty' as const }, z2: { type: 'empty' as const } },
      },
      {
        id: 's3',
        name: 'Other layout',
        customLayoutId: 'M',
        zones: { z1: { type: 'clock' as const, mode: 'time' as const } },
      },
    ];
    const before = [
      { id: 'z1', label: 'Header' },
      { id: 'z2', label: 'Main' },
    ];
    expect(affectedScenes(scenes, 'L', before, [{ id: 'z2' }])).toEqual([
      { id: 's1', name: 'Poster', zones: ['Header'] },
    ]);
    expect(affectedScenes(scenes, 'L', before, before)).toEqual([]);
  });
});
