// Date helpers of the renderer. Displays show English (en-GB) dates in the makerspace time zone; names come from fixed
// tables so every browser prints the same text ("Sep", not "Sept").

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
export const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** A wall-clock reading in the display's time zone. `month` is 0-based and `weekday` 0 (Sunday) to 6. */
export type WallTime = { year: number; month: number; day: number; weekday: number; hour: number; minute: number };

const formats = new Map<string, Intl.DateTimeFormat>();
function formatFor(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? '';
  let format = formats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    });
    formats.set(key, format);
  }
  return format;
}

/** The wall-clock reading of an instant (epoch milliseconds or an ISO timestamp) in `timeZone`. */
export function wallTime(instant: number | string, timeZone?: string): WallTime {
  const parts = formatFor(timeZone).formatToParts(new Date(instant));
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const year = value('year');
  const month = value('month') - 1;
  const day = value('day');
  return {
    year,
    month,
    day,
    weekday: new Date(Date.UTC(year, month, day)).getUTCDay(),
    hour: value('hour'),
    minute: value('minute'),
  };
}

const pad = (value: number) => String(value).padStart(2, '0');
export const timeText = (time: WallTime) => `${pad(time.hour)}:${pad(time.minute)}`;
/** `YYYY-MM-DD`, comparable as text. */
export const dayKey = (year: number, month: number, day: number) => {
  const date = new Date(Date.UTC(year, month, day));
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
};
export const dayKeyOf = (time: WallTime) => dayKey(time.year, time.month, time.day);
/** "Thu 23 Oct". */
export const dateText = (time: WallTime) =>
  `${WEEKDAYS[time.weekday].slice(0, 3)} ${time.day} ${MONTHS[time.month].slice(0, 3)}`;
