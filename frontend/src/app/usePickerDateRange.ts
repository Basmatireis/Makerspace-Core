import { useMemo } from 'react';
import { dateOnlyToPickerDate } from './dateTime';

/**
 * Value for a Carbon range DatePicker. Carbon calls flatpickr's setDate whenever
 * the value array changes identity, which drops a half-picked range and jumps
 * the calendar back to the selected month, so the array only changes with the dates.
 */
export function usePickerDateRange(startsOn: string, endsOn: string): Date[] {
  return useMemo(() => {
    const start = dateOnlyToPickerDate(startsOn);
    if (!start) return [];
    const end = dateOnlyToPickerDate(endsOn);
    return end ? [start, end] : [start];
  }, [startsOn, endsOn]);
}
