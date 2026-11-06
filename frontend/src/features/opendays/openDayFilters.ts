import type { OpenDay } from '../../api/generated/models';
import { dayRequirements, myAssignment } from './timeslots';

export type OpenDayFilter = 'all' | 'needs-staff' | 'mine';

export const openDayFilterOptions: Array<{ value: OpenDayFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'needs-staff', label: 'Open position' },
  { value: 'mine', label: 'My Open Days' },
];

export function hasOpenSupervisorPosition(day: OpenDay) {
  if (day.status === 'cancelled') return false;
  const supervisor = dayRequirements(day).find((requirement) => requirement.kind === 'supervisor');
  return Boolean(supervisor && supervisor.assignedCount < supervisor.requiredCount);
}

export function filterOpenDays(days: OpenDay[], filter: OpenDayFilter) {
  if (filter === 'needs-staff') return days.filter(hasOpenSupervisorPosition);
  if (filter === 'mine') return days.filter((day) => Boolean(myAssignment(day)));
  return days;
}
