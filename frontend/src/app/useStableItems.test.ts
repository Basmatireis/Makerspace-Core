import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useStableItems } from './useStableItems';

describe('useStableItems', () => {
  it('reuses an item while its id and label are unchanged', () => {
    const { result, rerender } = renderHook(({ items }) => useStableItems(items), {
      initialProps: { items: [{ id: 'a', label: 'PLA' }] },
    });
    const first = result.current[0];
    rerender({ items: [{ id: 'a', label: 'PLA' }] });
    expect(result.current[0]).toBe(first);
    rerender({ items: [{ id: 'a', label: 'PLA (g)' }] });
    expect(result.current[0]).not.toBe(first);
    expect(result.current[0].label).toBe('PLA (g)');
  });
});
