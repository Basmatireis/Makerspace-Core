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

  it('sends the recipient’s own material with its label and type and never a spool', () => {
    const own = {
      ...blankUsage(),
      ownership: 'external' as const,
      externalName: ' Prusament Galaxy Black ',
      materialTypeId: 'type-1',
      spoolId: 'spool-1',
      quantity: '12,5',
    };
    expect(toUsageInputs([own])).toEqual([
      {
        ownership: 'external',
        materialId: null,
        spoolId: null,
        materialTypeId: 'type-1',
        label: 'Prusament Galaxy Black',
        quantity: '12.5',
        quantityBasis: 'actual',
      },
    ]);
    expect(isBlankUsage({ ...blankUsage(), ownership: 'external', materialTypeId: 'type-1' })).toBe(false);
  });
});
