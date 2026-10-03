export const APP_LOCALE = 'en-GB';
export const APP_TIME_ZONE = 'Europe/Vienna';
export const APP_DATE_PLACEHOLDER = 'DD.MM.YYYY';

type DateParts = {
  day: string;
  month: string;
  year: string;
};

function instant(value: string | Date): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date;
}

function partsInTimeZone(value: string | Date, timeZone = APP_TIME_ZONE): Record<string, string> | null {
  const date = instant(value);
  if (!date) return null;
  const values: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat(`${APP_LOCALE}-u-ca-gregory`, {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)) {
    if (part.type !== 'literal') values[part.type] = part.value;
  }
  return values;
}

function dateParts(value: string | Date): DateParts | null {
  if (typeof value === 'string') {
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (dateOnly) return { year: dateOnly[1], month: dateOnly[2], day: dateOnly[3] };
  }
  const parts = partsInTimeZone(value);
  return parts ? { year: parts.year, month: parts.month, day: parts.day } : null;
}

export function formatDate(value: string | Date): string {
  const parts = dateParts(value);
  return parts ? `${parts.day}.${parts.month}.${parts.year}` : String(value);
}

export function formatTime(value: string | Date): string {
  const parts = partsInTimeZone(value);
  return parts ? `${parts.hour}:${parts.minute}` : String(value);
}

export function formatDateTime(value: string | Date): string {
  const date = instant(value);
  return date ? `${formatDate(date)}, ${formatTime(date)}` : String(value);
}

export function formatDateTimeRange(startsAt: string | Date, endsAt: string | Date): string {
  return `${formatDate(startsAt)}, ${formatTime(startsAt)}–${formatTime(endsAt)}`;
}

export function formatLongDate(value: string | Date): string {
  const date = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T12:00:00Z`)
    : instant(value);
  if (!date) return String(value);
  const weekday = new Intl.DateTimeFormat(APP_LOCALE, {
    weekday: 'long',
    timeZone: APP_TIME_ZONE,
  }).format(date);
  return `${weekday}, ${formatDate(value)}`;
}

export function formatMonthYear(value: Date): string {
  return new Intl.DateTimeFormat(APP_LOCALE, {
    month: 'long',
    year: 'numeric',
    timeZone: APP_TIME_ZONE,
  }).format(value);
}

export function parseDisplayDate(value: string): string | null {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value.trim());
  if (!match) return null;
  const [, day, month, year] = match;
  const candidate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    candidate.getUTCFullYear() !== Number(year)
    || candidate.getUTCMonth() !== Number(month) - 1
    || candidate.getUTCDate() !== Number(day)
  ) return null;
  return `${year}-${month}-${day}`;
}

export function dateOnlyToPickerDate(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
}

export function pickerDateToDateOnly(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

export function dateInAppTimeZone(value: string | Date): string {
  const parts = partsInTimeZone(value);
  return parts ? `${parts.year}-${parts.month}-${parts.day}` : '';
}

export function timeInAppTimeZone(value: string | Date): string {
  const parts = partsInTimeZone(value);
  return parts ? `${parts.hour}:${parts.minute}` : '';
}

export function zonedDateTimeToISO(date: string, clock: string, timeZone = APP_TIME_ZONE): string {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = clock.split(':').map(Number);
  const wallTimestamp = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = new Set<number>();
  for (const hours of [-48, -24, 0, 24, 48]) {
    const sample = wallTimestamp + hours * 3_600_000;
    const parts = partsInTimeZone(new Date(sample), timeZone)!;
    offsets.add(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) - sample);
  }
  const candidates = [...offsets].map((offset) => wallTimestamp - offset).filter((candidate) => {
    const parts = partsInTimeZone(new Date(candidate), timeZone)!;
    return `${parts.year}-${parts.month}-${parts.day}` === date && `${parts.hour}:${parts.minute}` === clock;
  });
  if (candidates.length !== 1) {
    const reason = candidates.length > 1 ? 'is ambiguous' : 'does not exist';
    throw new Error(`Local time ${formatDate(date)} ${clock} ${reason} in ${timeZone}. Choose a different time.`);
  }
  return new Date(candidates[0]).toISOString();
}

export function instantToZonedDateTimeValue(value: string | Date): string {
  const parts = partsInTimeZone(value);
  return parts ? `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}` : '';
}

export function zonedDateTimeValueToISO(value: string): string {
  const [date, clock] = value.split('T');
  return zonedDateTimeToISO(date, clock);
}

export function isZonedDateTimeValue(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function addCalendarDays(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
