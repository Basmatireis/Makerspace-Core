import type { PublicOpenDay } from '../../api/generated/models';
import { APP_LOCALE, APP_TIME_ZONE, dateInAppTimeZone, formatTime } from '../../app/dateTime';

const DAY_MS = 86_400_000;

const weekdayFormat = new Intl.DateTimeFormat(APP_LOCALE, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: APP_TIME_ZONE,
});
const longDayFormat = new Intl.DateTimeFormat(APP_LOCALE, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  timeZone: APP_TIME_ZONE,
});
const hourFormat = new Intl.DateTimeFormat(APP_LOCALE, { hour: 'numeric', hourCycle: 'h23', timeZone: APP_TIME_ZONE });
const monthYearFormat = new Intl.DateTimeFormat(APP_LOCALE, {
  month: 'long',
  year: 'numeric',
  timeZone: APP_TIME_ZONE,
});
const shortDateFormat = new Intl.DateTimeFormat(APP_LOCALE, { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** "Today", "Tomorrow" or "Sat 24 Oct", in the makerspace time zone. */
export function dayLabel(startsAt: string, now: number): string {
  const day = dateInAppTimeZone(startsAt);
  if (day === dateInAppTimeZone(new Date(now))) return 'Today';
  if (day === dateInAppTimeZone(new Date(now + DAY_MS))) return 'Tomorrow';
  return weekdayFormat.format(new Date(startsAt));
}

/** "Today · 14:00–18:00". */
export function when(startsAt: string, endsAt: string, now: number): string {
  return `${dayLabel(startsAt, now)} · ${formatTime(startsAt)}–${formatTime(endsAt)}`;
}

export function countdown(startsAt: string, endsAt: string, now: number): string {
  const start = new Date(startsAt).getTime();
  if (start <= now) return `Happening now · until ${formatTime(endsAt)}`;
  const hours = (start - now) / 3_600_000;
  if (hours < 1) return `Starts in ${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 24) return `Starts in ${Math.round(hours)} h`;
  const days = Math.round(hours / 24);
  return `In ${days} ${days === 1 ? 'day' : 'days'}`;
}

export function greeting(now: number): string {
  const hour = Number(hourFormat.format(new Date(now)));
  if (hour < 5) return 'Still up';
  if (hour < 12) return 'Good morning';
  return hour < 18 ? 'Good afternoon' : 'Good evening';
}

export function longToday(now: number): string {
  return longDayFormat.format(new Date(now));
}

/** "less than a month", "5 months" or "1.5 years". */
export function memberFor(since: string, now: number): string {
  const months = Math.floor((now - new Date(since).getTime()) / (30.4 * DAY_MS));
  if (months < 1) return 'less than a month';
  if (months < 12) return `${months} ${months === 1 ? 'month' : 'months'}`;
  return `${new Intl.NumberFormat(APP_LOCALE, { maximumFractionDigits: 1 }).format(months / 12)} years`;
}

export function monthYear(value: string): string {
  return monthYearFormat.format(new Date(value));
}

/** A date-only value such as a semester end, "31 Jan". */
export function shortDate(value: string): string {
  return shortDateFormat.format(new Date(`${value}T12:00:00Z`));
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export function upcomingOpenDays(days: PublicOpenDay[], now: number): PublicOpenDay[] {
  return days.filter((day) => day.status !== 'cancelled' && new Date(day.endsAt).getTime() > now);
}
