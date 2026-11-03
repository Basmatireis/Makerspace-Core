import { describe, expect, it } from 'vitest';
import { fuzzyScore, fuzzySort } from './fuzzy';

describe('fuzzyScore', () => {
  it('matches everything for an empty query', () => {
    expect(fuzzyScore('', 'PLA Basic')).toBe(1);
    expect(fuzzyScore('   ', 'PLA Basic')).toBe(1);
  });

  it('scores substrings above in-order characters and word starts above inner matches', () => {
    const substring = fuzzyScore('basic', 'PLA Basic Black');
    const scattered = fuzzyScore('bsc', 'PLA Basic Black');
    expect(substring).toBeGreaterThan(scattered);
    expect(scattered).toBeGreaterThan(0);
    expect(fuzzyScore('pla', 'PLA Basic')).toBeGreaterThan(fuzzyScore('pla', 'Explain'));
  });

  it('ignores case and requires every token', () => {
    expect(fuzzyScore('BLACK pla', 'PLA Basic Black')).toBeGreaterThan(0);
    expect(fuzzyScore('pla petg', 'PLA Basic Black')).toBe(0);
    expect(fuzzyScore('xyz', 'PLA Basic Black')).toBe(0);
  });

  it('needs the characters of a scattered match in order', () => {
    expect(fuzzyScore('pb', 'PLA Basic')).toBeGreaterThan(0);
    expect(fuzzyScore('bp', 'PLA Basic')).toBe(0);
  });
});

describe('fuzzySort', () => {
  it('drops non-matches and orders by score, keeping the original order on ties', () => {
    const items = ['Petg Black', 'PLA Basic Black', 'Black PLA', 'Silk White'];
    expect(fuzzySort(items, 'black', (item) => item)).toEqual(['Black PLA', 'Petg Black', 'PLA Basic Black']);
    expect(fuzzySort(items, '', (item) => item)).toEqual(items);
  });
});
