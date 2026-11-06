import { describe, expect, it } from 'vitest';
import { period } from '../testData';
import { currentPeriod } from './currentPeriod';
import { newPeriodDefaults } from './periodDefaults';
import { breakError } from './breaks';

describe('current period', () => {
  const winter = period({ id: 'w', startsOn: '2026-10-01', endsOn: '2027-01-31' });
  const summer = period({ id: 's', startsOn: '2027-03-01', endsOn: '2027-06-30' });
  const draft = period({ id: 'd', status: 'draft', startsOn: '2026-11-01', endsOn: '2026-12-31' });

  it('prefers the running period and never a draft', () => {
    expect(currentPeriod([summer, draft, winter], '2026-11-06')?.id).toBe('w');
  });

  it('falls back to the next, then the latest period', () => {
    expect(currentPeriod([winter, summer], '2027-02-15')?.id).toBe('s');
    expect(currentPeriod([winter, summer], '2028-01-01')?.id).toBe('s');
    expect(currentPeriod([draft], '2026-11-06')).toBeUndefined();
  });

  it('suggests a following period with the latest series to copy', () => {
    expect(newPeriodDefaults([winter], '2026-11-06')).toMatchObject({
      startsOn: '2027-03-01',
      endsOn: '2027-06-30',
      copySeriesFromPeriodId: 'w',
    });
  });

  it('validates breaks', () => {
    expect(breakError({ name: '', startsOn: '2026-12-24', endsOn: '2027-01-06' })).toMatch(/name/);
    expect(breakError({ name: 'X', startsOn: '2027-01-06', endsOn: '2026-12-24' })).toMatch(/end after/);
    expect(breakError({ name: 'X', startsOn: '2026-12-24', endsOn: '2027-01-06' })).toBe('');
  });
});
