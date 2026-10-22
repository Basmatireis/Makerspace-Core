/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SignageWidget } from '../../api/generated/models';
import { emptyZones, LAYOUTS, layoutById, remapZones, resolveLayout, type CustomLayoutShape } from './layouts';

const openapi = readFileSync(resolve(process.cwd(), '../api/openapi.yaml'), 'utf8');

describe('layouts', () => {
  it('lists exactly the layout ids of the OpenAPI contract', () => {
    const enumLine = /SignageLayoutId:\s*\n\s*type: string\n\s*description:[^\n]*\n\s*enum: \[([^\]]+)\]/.exec(openapi);
    expect(enumLine).not.toBeNull();
    // `custom` is not a fixed layout: it names a custom layout record instead.
    const contractIds = enumLine![1]
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id !== 'custom');
    expect(LAYOUTS.map((layout) => layout.id)).toEqual(contractIds);
    expect(enumLine![1]).toContain('custom');
  });

  it('keeps every zone inside its grid', () => {
    for (const layout of LAYOUTS) {
      const columns = layout.columns.split(' ').length;
      const rows = layout.rows.split(' ').length;
      for (const zone of layout.zones) {
        expect(zone.col + zone.colSpan - 1).toBeLessThanOrEqual(columns);
        expect(zone.row + zone.rowSpan - 1).toBeLessThanOrEqual(rows);
      }
    }
  });

  it('falls back to the first layout for unknown ids', () => {
    expect(layoutById('nope').id).toBe('full');
  });

  it('remaps widgets by position and drops or empties the rest', () => {
    const text: SignageWidget = { type: 'text', text: 'Hello', size: 'm', align: 'start' };
    const clock: SignageWidget = { type: 'clock', mode: 'time' };
    expect(remapZones({ header: text, main: clock, footer: text }, 'stack3', 'split')).toEqual({
      left: text,
      right: clock,
    });
    expect(remapZones({ main: clock }, 'full', 'banner_main')).toEqual({ banner: clock, main: { type: 'empty' } });
    expect(emptyZones('split')).toEqual({ left: { type: 'empty' }, right: { type: 'empty' } });
  });

  describe('resolveLayout', () => {
    const gridLayout: CustomLayoutShape = {
      id: 'grid-1',
      mode: 'grid',
      columns: [2, 1],
      rows: [1, 3, 1],
      zones: [
        { id: 'a', label: 'A', grid: { col: 1, row: 1, colSpan: 2, rowSpan: 1 }, rect: null },
        { id: 'b', label: 'B', grid: { col: 2, row: 2, colSpan: 1, rowSpan: 2 }, rect: null },
      ],
    };
    const freeLayout: CustomLayoutShape = {
      id: 'free-1',
      mode: 'free',
      columns: [1],
      rows: [1],
      zones: [
        { id: 'back', label: 'Back', grid: null, rect: { x: 0, y: 0, width: 100, height: 100 } },
        { id: 'badge', label: 'Badge', grid: null, rect: { x: 62.5, y: 5.25, width: 30, height: 12.5 } },
      ],
    };

    it('resolves built-in layouts to a grid, ignoring a custom id', () => {
      const split = resolveLayout('split', null, []);
      expect(split).toEqual({ kind: 'grid', columns: '1fr 1fr', rows: '1fr', zones: layoutById('split').zones });
      expect(resolveLayout('split', 'grid-1', [gridLayout]).kind).toBe('grid');
    });

    it('turns custom grid weights into fr tracks and zones into placements', () => {
      expect(resolveLayout('custom', 'grid-1', [gridLayout])).toEqual({
        kind: 'grid',
        columns: '2fr 1fr',
        rows: '1fr 3fr 1fr',
        zones: [
          { id: 'a', label: 'A', col: 1, row: 1, colSpan: 2, rowSpan: 1 },
          { id: 'b', label: 'B', col: 2, row: 2, colSpan: 1, rowSpan: 2 },
        ],
      });
    });

    it('keeps free zones as percent rects in stacking order', () => {
      expect(resolveLayout('custom', 'free-1', [freeLayout, gridLayout])).toEqual({
        kind: 'free',
        zones: [
          { id: 'back', label: 'Back', x: 0, y: 0, width: 100, height: 100 },
          { id: 'badge', label: 'Badge', x: 62.5, y: 5.25, width: 30, height: 12.5 },
        ],
      });
    });

    it('falls back to the first built-in layout for unknown ids and missing custom layouts', () => {
      const first = { kind: 'grid', columns: '1fr', rows: '1fr', zones: LAYOUTS[0].zones };
      expect(resolveLayout('nope', null, undefined)).toEqual(first);
      expect(resolveLayout('custom', 'gone', [gridLayout])).toEqual(first);
      expect(resolveLayout('custom', null, [gridLayout])).toEqual(first);
      expect(resolveLayout('custom', 'grid-1', undefined)).toEqual(first);
    });

    it('remaps and empties zones of resolved custom layouts by position', () => {
      const text: SignageWidget = { type: 'text', text: 'Hello', size: 'm', align: 'start' };
      const grid = resolveLayout('custom', 'grid-1', [gridLayout]);
      const free = resolveLayout('custom', 'free-1', [freeLayout]);
      expect(remapZones({ header: text }, 'stack3', grid)).toEqual({ a: text, b: { type: 'empty' } });
      expect(remapZones({ a: text }, grid, free)).toEqual({ back: text, badge: { type: 'empty' } });
      expect(remapZones({ back: text }, free, 'full')).toEqual({ main: text });
      expect(emptyZones(free)).toEqual({ back: { type: 'empty' }, badge: { type: 'empty' } });
    });
  });
});
