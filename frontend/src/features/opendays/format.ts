import type { OpenDay, OpenDayPeriod } from '../../api/generated/models';

export function periodRange(period: Pick<OpenDayPeriod, 'startsOn' | 'endsOn'>) {
  const formatter = new Intl.DateTimeFormat(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
  return `${formatter.format(new Date(`${period.startsOn}T00:00:00Z`))} – ${formatter.format(new Date(`${period.endsOn}T00:00:00Z`))}`;
}

export function longDate(instant: string, timeZone: string) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone,
  }).format(new Date(instant));
}

export function timeRange(day: Pick<OpenDay, 'startsAt' | 'endsAt'>, timeZone: string) {
  const formatter = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit', minute: '2-digit', timeZone,
  });
  return `${formatter.format(new Date(day.startsAt))}–${formatter.format(new Date(day.endsAt))}`;
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
