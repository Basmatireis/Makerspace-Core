import { dateInTimeZone, timeInTimeZone } from './dateTime';

export const openDayWeekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
export type OpenDayWeekday = (typeof openDayWeekdays)[number];

export type OpenDayDateTimeFilter = {
  weekdays: OpenDayWeekday[];
  startTimes: string[];
};

export const allOpenDayDateTimeFilters: OpenDayDateTimeFilter = {
  weekdays: [],
  startTimes: [],
};

export function filterOpenDaysByDateTime<T extends { startsAt: string }>(items: T[], filter: OpenDayDateTimeFilter, timeZone: string) {
  return items.filter((item) => (
    (filter.weekdays.length === 0 || filter.weekdays.includes(weekdayInTimeZone(item.startsAt, timeZone)))
    && (filter.startTimes.length === 0 || filter.startTimes.includes(timeInTimeZone(item.startsAt, timeZone)))
  ));
}

function weekdayInTimeZone(instant: string, timeZone: string): OpenDayWeekday {
  const date = dateInTimeZone(instant, timeZone);
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return openDayWeekdays[(day + 6) % 7];
}
