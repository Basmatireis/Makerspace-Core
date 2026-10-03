import { describe, expect, it } from 'vitest';
import {
  formatDate,
  formatDateTime,
  formatLongDate,
  formatTime,
  instantToZonedDateTimeValue,
  parseDisplayDate,
  zonedDateTimeValueToISO,
} from './dateTime';

describe('application date and time format', () => {
  it('uses DD.MM.YYYY and a 24-hour Vienna clock', () => {
    expect(formatDateTime('2026-10-03T22:15:00Z')).toBe('04.10.2026, 00:15');
    expect(formatTime('2026-10-03T14:05:00Z')).toBe('16:05');
    expect(formatDate('2026-02-09')).toBe('09.02.2026');
  });

  it('writes weekdays and months in English', () => {
    expect(formatLongDate('2026-10-02')).toBe('Friday, 02.10.2026');
  });

  it('parses display dates and Vienna wall times without using the browser timezone', () => {
    expect(parseDisplayDate('03.10.2026')).toBe('2026-10-03');
    expect(parseDisplayDate('31.02.2026')).toBeNull();
    expect(instantToZonedDateTimeValue('2026-10-03T12:00:00Z')).toBe('2026-10-03T14:00');
    expect(zonedDateTimeValueToISO('2026-10-03T14:00')).toBe('2026-10-03T12:00:00.000Z');
  });
});
