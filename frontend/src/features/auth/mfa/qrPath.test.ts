import { describe, expect, it } from 'vitest';
import { qrModulesToPath } from './qrPath';

describe('qrModulesToPath', () => {
  it('draws one unit square per dark module offset by the margin', () => {
    // 2x2 matrix: dark at (0,0) and (1,1)
    expect(qrModulesToPath([1, 0, 0, 1], 2, 2)).toBe('M2 2h1v1h-1zM3 3h1v1h-1z');
  });

  it('returns an empty path for an empty symbol', () => {
    expect(qrModulesToPath([0, 0, 0, 0], 2)).toBe('');
  });
});
