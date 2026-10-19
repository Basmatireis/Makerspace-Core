/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SignageWidget } from '../../api/generated/models';
import { emptyZones, LAYOUTS, layoutById, remapZones } from './layouts';

const openapi = readFileSync(resolve(process.cwd(), '../api/openapi.yaml'), 'utf8');

describe('layouts', () => {
  it('lists exactly the layout ids of the OpenAPI contract', () => {
    const enumLine = /SignageLayoutId:\s*\n\s*type: string\n\s*description:[^\n]*\n\s*enum: \[([^\]]+)\]/.exec(openapi);
    expect(enumLine).not.toBeNull();
    expect(LAYOUTS.map((layout) => layout.id)).toEqual(enumLine![1].split(',').map((id) => id.trim()));
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
    expect(remapZones({ header: text, main: clock, footer: text }, 'stack3', 'split')).toEqual({ left: text, right: clock });
    expect(remapZones({ main: clock }, 'full', 'banner_main')).toEqual({ banner: clock, main: { type: 'empty' } });
    expect(emptyZones('split')).toEqual({ left: { type: 'empty' }, right: { type: 'empty' } });
  });
});
