import { describe, expect, it } from 'vitest';
import { slotsError, splitByHours, splitIntoParts } from './timeslots';

describe('timeslot editor helpers', () => {
  it('splits a range into hour slots and cuts the last one', () => {
    expect(splitByHours('09:00', '15:00', 3)).toEqual([
      { start: '09:00', end: '12:00' },
      { start: '12:00', end: '15:00' },
    ]);
    expect(splitByHours('17:00', '21:00', 3)).toEqual([
      { start: '17:00', end: '20:00' },
      { start: '20:00', end: '21:00' },
    ]);
  });

  it('splits into about N equal slots rounded to quarter hours', () => {
    expect(splitIntoParts('09:00', '18:00', 3)).toHaveLength(3);
    expect(splitIntoParts('16:00', '20:00', 2)).toEqual([
      { start: '16:00', end: '18:00' },
      { start: '18:00', end: '20:00' },
    ]);
  });

  it('reports empty, reversed and overlapping timeslots', () => {
    expect(slotsError([])).toMatch(/at least one/);
    expect(slotsError([{ start: '10:00', end: '09:00' }])).toMatch(/end after/);
    expect(
      slotsError([
        { start: '09:00', end: '12:00' },
        { start: '11:00', end: '14:00' },
      ]),
    ).toMatch(/overlap/);
    expect(
      slotsError([
        { start: '09:00', end: '12:00' },
        { start: '12:00', end: '14:00' },
      ]),
    ).toBe('');
  });
});
