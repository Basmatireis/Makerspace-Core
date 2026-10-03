import type { OpenDay, OpenDayPeriod } from '../../api/generated/models';
import { APP_LOCALE, formatLongDate, formatTime } from '../../app/dateTime';

function periodDate(value: string) {
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat(APP_LOCALE, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

export function periodRange(period: Pick<OpenDayPeriod, 'startsOn' | 'endsOn'>) {
  return `${periodDate(period.startsOn)} – ${periodDate(period.endsOn)}`;
}

export function longDate(instant: string, _timeZone: string) {
  void _timeZone;
  return formatLongDate(instant);
}

export function timeRange(day: Pick<OpenDay, 'startsAt' | 'endsAt'>, _timeZone: string) {
  void _timeZone;
  return `${formatTime(day.startsAt)}–${formatTime(day.endsAt)}`;
}

export function isFullyStaffed(day: OpenDay) {
  return day.requirements.every((item) => item.assignedCount >= item.requiredCount);
}

export function registeredPeopleCount(day: Pick<OpenDay, 'requirements'>) {
  return day.requirements.reduce((total, requirement) => total + requirement.assignedCount, 0);
}

export function staffingLabel(day: OpenDay) {
  if (day.status === 'cancelled') return 'Cancelled';
  if (isFullyStaffed(day)) return 'Fully staffed';
  const missing = day.requirements
    .filter((item) => item.assignedCount < item.requiredCount)
    .map((item) => item.kind === 'supervisor' ? 'supervisor' : 'trainee');
  return `Needs ${missing.join(' and ')}`;
}

export function statusTagType(status: string): 'blue' | 'green' | 'purple' | 'gray' | 'red' {
  if (status === 'published' || status === 'Fully staffed') return 'green';
  if (status === 'staffing') return 'purple';
  if (status === 'draft') return 'blue';
  if (status.startsWith('Needs')) return 'red';
  return 'gray';
}
