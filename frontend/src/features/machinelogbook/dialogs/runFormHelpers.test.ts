import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { instantToZonedDateTimeValue } from '../../../app/dateTime';
import { resolveTimes, type RunValues } from './runFormHelpers';

const now = new Date('2026-11-14T12:00:00Z');
const past = (startsAt: string, runtimeHours: number, runtimeMinutes = 0): RunValues => ({
  when: 'past',
  startsAt: instantToZonedDateTimeValue(startsAt),
  runtimeHours,
  runtimeMinutes,
  outcome: 'successful',
});

describe('resolveTimes', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());

  it('keeps a new run that is already done as entered when it ended before now', () => {
    expect(resolveTimes(past('2026-11-14T09:00:00Z', 2))).toEqual({
      startsAt: '2026-11-14T09:00:00.000Z',
      endsAt: '2026-11-14T11:00:00.000Z',
    });
  });

  it('moves the start of a new run that is already done back so that it ends now', () => {
    expect(resolveTimes(past('2026-11-14T11:00:00Z', 3, 30))).toEqual({
      startsAt: '2026-11-14T08:30:00.000Z',
      endsAt: '2026-11-14T12:00:00.000Z',
    });
  });

  it('moves a start in the future back as well', () => {
    expect(resolveTimes(past('2026-11-15T08:00:00Z', 1))).toEqual({
      startsAt: '2026-11-14T11:00:00.000Z',
      endsAt: '2026-11-14T12:00:00.000Z',
    });
  });

  it('keeps an end ahead when an existing run is edited', () => {
    const original = { startsAt: '2026-11-14T11:00:00Z', endsAt: '2026-11-14T13:00:00Z' };
    expect(resolveTimes(past('2026-11-14T11:00:00Z', 3), original)).toEqual({
      startsAt: '2026-11-14T11:00:00.000Z',
      endsAt: '2026-11-14T14:00:00.000Z',
    });
  });
});
