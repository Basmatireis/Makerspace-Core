import {
  addCalendarDays,
  dateInAppTimeZone,
  timeInAppTimeZone,
  zonedDateTimeToISO as appZonedDateTimeToISO,
} from '../../app/dateTime';

export function dateInTimeZone(instant: string, _timeZone: string) {
  void _timeZone;
  return dateInAppTimeZone(instant);
}

export function timeInTimeZone(instant: string, _timeZone: string) {
  void _timeZone;
  return timeInAppTimeZone(instant);
}

export function zonedDateTimeToISO(date: string, clock: string, _timeZone: string) {
  void _timeZone;
  return appZonedDateTimeToISO(date, clock);
}

export function nextCalendarDate(date: string) {
  return addCalendarDays(date, 1);
}

export function validateLocalInstant(instant: string, timeZone: string) {
  zonedDateTimeToISO(dateInTimeZone(instant, timeZone), timeInTimeZone(instant, timeZone), timeZone);
}
