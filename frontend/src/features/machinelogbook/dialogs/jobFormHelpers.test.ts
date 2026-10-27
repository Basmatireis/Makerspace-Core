import { describe, expect, it } from 'vitest';
import { blankUsage, isBlankUsage, toUsageInputs } from './jobFormHelpers';

describe('material rows', () => {
  it('records no material for an untouched row', () => {
    expect(isBlankUsage(blankUsage())).toBe(true);
    expect(toUsageInputs([blankUsage()])).toEqual([]);
  });

  it('keeps a row as soon as it names a material or a quantity', () => {
    const external = { ...blankUsage(), ownership: 'external' as const, externalName: 'Customer PLA' };
    const quantityOnly = { ...blankUsage(), quantity: '12' };
    expect(isBlankUsage(external)).toBe(false);
    expect(isBlankUsage(quantityOnly)).toBe(false);
    expect(toUsageInputs([blankUsage(), external])).toHaveLength(1);
  });
});
