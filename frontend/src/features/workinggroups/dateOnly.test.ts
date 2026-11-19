import { describe, expect, it } from 'vitest';
import { formatDateOnly } from './taskModel';

describe('formatDateOnly', () => {
  it('keeps the calendar day whatever the browser time zone is', () => {
    expect(formatDateOnly('2026-03-01')).toBe('01.03.2026');
    expect(formatDateOnly('2026-12-31')).toBe('31.12.2026');
    expect(formatDateOnly('2026-03-01T00:00:00Z')).toBe('01.03.2026');
  });
});
