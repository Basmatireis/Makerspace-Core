import type { OpenDay } from '../../../api/generated/models';
import { zonedDateTimeToISO } from '../../../app/dateTime';
import { shortDate, timeRange } from './dates';
import { findOverlap } from './overlap';
import { slotsError } from './timeslots';
import type { DayValues } from './workingCopy';

const placesOk = (value: number) => Number.isInteger(value) && value >= 0 && value <= 100;

/** The first problem with an open day form, or an empty string. */
export function dayError(
  values: DayValues,
  bounds: { startsOn: string; endsOn: string },
  others: readonly OpenDay[],
  ignoreId?: string,
): string {
  if (!values.date) return 'Choose a date.';
  if (values.date < bounds.startsOn || values.date > bounds.endsOn) return 'The date must lie within the period.';
  const slots = slotsError(values.slots);
  if (slots) return slots;
  if (!placesOk(values.supervisorPlaces) || !placesOk(values.traineePlaces))
    return 'Places must be a whole number from 0 to 100.';
  try {
    for (const slot of values.slots) {
      zonedDateTimeToISO(values.date, slot.start);
      zonedDateTimeToISO(values.date, slot.end);
    }
  } catch (error) {
    return error instanceof Error ? error.message : 'Choose valid local times.';
  }
  const clash = findOverlap(others, values.date, values.slots, ignoreId);
  if (clash)
    return `${shortDate(values.date)} already has an open day from ${timeRange(clash.startsAt, clash.endsAt)}. Choose times that do not overlap.`;
  return '';
}

/** The first problem with a series form, or an empty string. */
export function seriesError(args: {
  slots: readonly { start: string; end: string }[];
  fromDate: string;
  untilDate: string;
  applyFrom?: string;
  periodEndsOn: string;
  supervisorPlaces: number;
  traineePlaces: number;
}): string {
  const slots = slotsError(args.slots);
  if (slots) return slots;
  if (!args.untilDate) return 'Choose when the series ends.';
  if (args.untilDate < args.fromDate) return 'The series must not end before it starts.';
  if (args.untilDate > args.periodEndsOn) return 'The series must end within the period.';
  if (args.applyFrom && args.untilDate < args.applyFrom)
    return 'The series must run at least until the date the changes apply from.';
  if (!placesOk(args.supervisorPlaces) || !placesOk(args.traineePlaces))
    return 'Places must be a whole number from 0 to 100.';
  return '';
}
