import { describe, expect, it } from 'vitest';
import { aspectLabel, orientationOf, parseAspectRatio, reduceRatio, sameRatio } from './helpers';

describe('aspect ratios', () => {
  it('derives the orientation: landscape unless the screen is taller than wide', () => {
    expect(orientationOf({ width: 16, height: 9 })).toBe('landscape');
    expect(orientationOf({ width: 1, height: 1 })).toBe('landscape');
    expect(orientationOf({ width: 9, height: 16 })).toBe('portrait');
    expect(orientationOf({ width: 3, height: 4 })).toBe('portrait');
  });

  it('reduces by the greatest common divisor', () => {
    expect(reduceRatio({ width: 1920, height: 1080 })).toEqual({ width: 16, height: 9 });
    expect(reduceRatio({ width: 7, height: 5 })).toEqual({ width: 7, height: 5 });
    expect(aspectLabel({ width: 3840, height: 2160 })).toBe('16:9');
  });

  it('compares ratios regardless of scale', () => {
    expect(sameRatio({ width: 32, height: 18 }, { width: 16, height: 9 })).toBe(true);
    expect(sameRatio({ width: 9, height: 16 }, { width: 16, height: 9 })).toBe(false);
  });

  it('parses a custom ratio', () => {
    expect(parseAspectRatio('16:10')).toEqual({ width: 8, height: 5 });
    expect(parseAspectRatio(' 21 : 9 ')).toEqual({ width: 7, height: 3 });
    expect(parseAspectRatio('1920x1080')).toEqual({ width: 16, height: 9 });
    expect(parseAspectRatio('1920:1080')).toEqual({ width: 16, height: 9 });
    expect(parseAspectRatio('100:1')).toEqual({ width: 100, height: 1 });
  });

  it('rejects input that is not two integers from 1 to 100 after reduction', () => {
    for (const text of ['', '16', '16:', ':9', 'a:b', '0:9', '16:0', '101:1', '1.5:1', '-4:3', '16:9:1', '1921:1080'])
      expect(parseAspectRatio(text), text).toBeNull();
  });
});
