import { describe, expect, it } from 'vitest';
import { endDayOf, overnightHint } from './format';

describe('overnight spans', () => {
  it('moves an end earlier than the start to the next day', () => {
    expect(endDayOf('2026-12-17', '23:00', '01:00')).toBe('2026-12-18');
    expect(endDayOf('2026-12-31', '22:00', '02:00')).toBe('2027-01-01');
    expect(endDayOf('2026-12-17', '10:00', '12:00')).toBe('2026-12-17');
  });

  it('keeps an end day that was chosen explicitly', () => {
    expect(endDayOf('2026-12-17', '23:00', '01:00', '2026-12-19')).toBe('2026-12-19');
    expect(overnightHint('2026-12-17', '23:00', '01:00', '2026-12-19')).toBeUndefined();
  });

  it('says on which day an overnight span ends', () => {
    expect(overnightHint('2026-12-17', '23:00', '01:00')).toMatch(/^Ends the next day, .*18.*Dec/);
    expect(overnightHint('2026-12-17', '10:00', '12:00')).toBeUndefined();
  });
});
