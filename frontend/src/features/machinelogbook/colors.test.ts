import { describe, expect, it } from 'vitest';
import { colorDistance, colorsClearlyDiffer, reportedToMaterialHex } from './colors';

describe('detected colour comparison', () => {
  it('measures the RGB distance and ignores missing or malformed codes', () => {
    expect(colorDistance('#000000', '#000000')).toBe(0);
    expect(colorDistance('#FF0000', '#00FF00')).toBeCloseTo(360.6, 1);
    expect(colorDistance(null, '#FFFFFF')).toBeNull();
    expect(colorDistance('#FFFFFF', undefined)).toBeNull();
    expect(colorDistance('red', '#FFFFFF')).toBeNull();
  });

  it('flags only clear differences and skips when either colour is missing', () => {
    expect(colorsClearlyDiffer('#C62828', 'C62828')).toBe(false);
    expect(colorsClearlyDiffer('#C62828', reportedToMaterialHex('c92b2b'))).toBe(false);
    expect(colorsClearlyDiffer('#C62828', '#1A1A1A')).toBe(true);
    expect(colorsClearlyDiffer(null, '#1A1A1A')).toBe(false);
    expect(colorsClearlyDiffer('#C62828', null)).toBe(false);
  });

  it('turns a reported RRGGBB code into the stored form', () => {
    expect(reportedToMaterialHex('c62828')).toBe('#C62828');
  });
});
