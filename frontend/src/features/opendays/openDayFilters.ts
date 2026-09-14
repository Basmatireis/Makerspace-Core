import type { OpenDay } from '../../api/generated/models';

export type OpenDayFilter = 'all' | 'needs-staff' | 'mine';

export const openDayFilterOptions: Array<{ value: OpenDayFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'needs-staff', label: 'Needs staff' },
  { value: 'mine', label: 'My Open Days' },
];

export function hasOpenSupervisorPosition(day: OpenDay) {
  if (day.status === 'cancelled') return false;
  const supervisor = day.requirements.find((requirement) => requirement.kind === 'supervisor');
  return Boolean(supervisor && supervisor.assignedCount < supervisor.requiredCount);
}

export function filterOpenDays(days: OpenDay[], filter: OpenDayFilter) {
  if (filter === 'needs-staff') return days.filter(hasOpenSupervisorPosition);
  if (filter === 'mine') return days.filter((day) => Boolean(day.myAssignment));
  return days;
}
