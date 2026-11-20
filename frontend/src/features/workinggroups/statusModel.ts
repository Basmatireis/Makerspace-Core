import type { WorkingGroupStatus } from '../../api/generated/models';
import { dateParts, type Task } from './taskModel';

export const STATUS_LABEL: Record<WorkingGroupStatus, string> = {
  ok: 'Working',
  limited: 'Limited',
  maintenance: 'Maintenance',
  out_of_order: 'Out of order',
};

export const STATUS_CHOICES: WorkingGroupStatus[] = ['ok', 'limited', 'maintenance', 'out_of_order'];

export const STATUS_TAG: Record<WorkingGroupStatus, 'green' | 'magenta' | 'blue' | 'red'> = {
  ok: 'green',
  limited: 'magenta',
  maintenance: 'blue',
  out_of_order: 'red',
};

/** Worst first, for lists that show what needs attention at the top. */
export const STATUS_SEVERITY: Record<WorkingGroupStatus, number> = {
  out_of_order: 0,
  maintenance: 1,
  limited: 2,
  ok: 3,
};

export const STATUS_WINDOW_DAYS = 90;

/** "back around 3 Dec" for a plain `YYYY-MM-DD` date. */
export function backAround(until: string | undefined): string | null {
  if (!until) return null;
  const parts = dateParts(until.slice(0, 10));
  return `back around ${parts.day} ${parts.month}`;
}

/** What a status dialog needs to know about the machine or place it changes. */
export interface StatusTarget {
  kind: 'machine' | 'place';
  id: string;
  groupId: string;
  name: string;
  status: WorkingGroupStatus;
  note?: string;
  until?: string;
}

/** The tasks page with one ticket or to-do selected. */
export const taskLink = (task: Task) =>
  `/working-groups/tasks?group=${task.groupId}&item=${encodeURIComponent(task.key)}`;
