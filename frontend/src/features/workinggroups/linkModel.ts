import { formatDate } from '../../app/dateTime';

export const purchaseLink = (groupId: string, id: string) =>
  `/working-groups/purchases?group=${groupId}&item=${encodeURIComponent(id)}`;
export const projectLink = (id: string) => `/working-groups/projects/${id}`;
export const taskItemLink = (groupId: string, kind: 'ticket' | 'todo', id: string) =>
  `/working-groups/tasks?group=${groupId}&item=${encodeURIComponent(`${kind}:${id}`)}`;

const MINUTE = 60_000;
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 24 * 60 * MINUTE],
  ['hour', 60 * MINUTE],
  ['minute', MINUTE],
];
const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "2 hours ago", "yesterday"; anything older than a month is a plain date. */
export function relativeTime(value: string, now = Date.now()): string {
  const elapsed = new Date(value).getTime() - now;
  if (Math.abs(elapsed) < MINUTE) return 'just now';
  if (Math.abs(elapsed) > 30 * 24 * 60 * MINUTE) return formatDate(value);
  const [unit, size] = UNITS.find(([, size]) => Math.abs(elapsed) >= size) ?? UNITS[2];
  return relative.format(Math.round(elapsed / size), unit);
}
