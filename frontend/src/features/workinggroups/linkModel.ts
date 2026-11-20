import { formatDate } from '../../app/dateTime';

export const purchaseLink = (groupId: string, id: string) =>
  `/working-groups/purchases?group=${groupId}&item=${encodeURIComponent(id)}`;
export const projectLink = (id: string) => `/working-groups/projects/${id}`;
export const taskItemLink = (groupId: string, kind: 'ticket' | 'todo', id: string) =>
  `/working-groups/tasks?group=${groupId}&item=${encodeURIComponent(`${kind}:${id}`)}`;

/** "5 minutes ago", "yesterday"; older than a week as a date. */
export function relativeTime(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return formatDate(iso);
}
