import { describe, expect, it } from 'vitest';
import { clamp01, hexToHsv, hsvToHex, normalizeHex } from './colors';

describe('colour maths', () => {
  it('converts the primary colours to hue, saturation and brightness', () => {
    expect(hexToHsv('#ff0000')).toEqual([0, 1, 1]);
    expect(hexToHsv('#00ff00')).toEqual([120, 1, 1]);
    expect(hexToHsv('#0000ff')).toEqual([240, 1, 1]);
    expect(hexToHsv('#ffffff')).toEqual([0, 0, 1]);
    expect(hexToHsv('#000000')).toEqual([0, 0, 0]);
  });
  it('round-trips hex colours', () => {
    for (const hex of ['#0f62fe', '#161616', '#d0103a', '#8a3ffc', '#f4f4f4', '#7f7f7f', '#3c3c3c']) {
      expect(hsvToHex(...hexToHsv(hex))).toBe(hex);
    }
  });
  it('turns hsv into hex', () => {
    expect(hsvToHex(0, 1, 1)).toBe('#ff0000');
    expect(hsvToHex(210, 0.5, 0.5)).toBe('#406080');
  });
  it('treats anything but six hex digits as black', () => {
    expect(hexToHsv('transparent')).toEqual([0, 0, 0]);
    expect(hexToHsv('#fff')).toEqual([0, 0, 0]);
  });
  it('normalizes typed hex values', () => {
    expect(normalizeHex(' 0F62FE ')).toBe('#0f62fe');
    expect(normalizeHex('#12345')).toBeNull();
    expect(normalizeHex('#12345g')).toBeNull();
  });
  it('clamps to 0..1', () => {
    expect([clamp01(-1), clamp01(0.4), clamp01(3)]).toEqual([0, 0.4, 1]);
  });
});
