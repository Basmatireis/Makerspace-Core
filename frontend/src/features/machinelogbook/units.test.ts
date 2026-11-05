import { describe, expect, it } from 'vitest';
import {
  allUnits,
  articleUnitLabel,
  convertQuantity,
  dimensionOf,
  unitNames,
  unitsOfDimension,
  unitSymbol,
} from './units';

describe('units', () => {
  it('knows the dimension of every unit', () => {
    expect(allUnits).toHaveLength(10);
    expect(dimensionOf('kg')).toBe('mass');
    expect(dimensionOf('mm')).toBe('length');
    expect(dimensionOf('m2')).toBe('area');
    expect(dimensionOf('l')).toBe('volume');
    expect(dimensionOf('piece')).toBe('count');
    for (const unit of allUnits) expect(unitsOfDimension(dimensionOf(unit))).toContain(unit);
  });

  it('shows symbols and count labels', () => {
    expect(unitSymbol('cm2')).toBe('cm²');
    expect(unitSymbol('m2')).toBe('m²');
    expect(unitSymbol('piece')).toBe('pcs');
    expect(unitSymbol('kg')).toBe('kg');
    expect(articleUnitLabel('piece', 'sheet')).toBe('sheet');
    expect(articleUnitLabel('piece', null)).toBe('pcs');
    expect(articleUnitLabel('g', 'sheet')).toBe('g');
    expect(unitNames.piece).toBe('Pieces');
  });

  it('converts within a dimension', () => {
    expect(convertQuantity(2, 'm2', 'cm2')).toBe(20000);
    expect(convertQuantity(500, 'g', 'kg')).toBe(0.5);
  });
});
