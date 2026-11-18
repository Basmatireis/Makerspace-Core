import { addCalendarDays, dateInAppTimeZone } from '../../app/dateTime';
import type {
  WorkingGroupPerson,
  WorkingGroupTicket,
  WorkingGroupTicketKind,
  WorkingGroupTodo,
} from '../../api/generated/models';

export type TaskKind = 'ticket' | 'todo';
/** `new` is a ticket in the inbox, `open` a planned ticket or an undone to-do. */
export type TaskState = 'new' | 'open' | 'done' | 'declined';
export type StatusKey = 'inbox' | 'overdue' | 'week' | 'later';
export type Bucket = 'inbox' | 'overdue' | 'week' | 'nextWeek' | 'later' | 'none' | 'done';

/** One row of the combined list: a ticket or a to-do, flattened to what the page needs. */
export interface Task {
  key: string;
  kind: TaskKind;
  id: string;
  groupId: string;
  groupName: string;
  title: string;
  state: TaskState;
  columnId?: string;
  dueOn?: string;
  assignee?: WorkingGroupPerson;
  author?: WorkingGroupPerson;
  followerCount: number;
  commentCount: number;
  isMine: boolean;
  isFollowing: boolean;
  /** Tickets: the caller is inside the group. To-dos are only ever listed to people inside. */
  inside: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  repeatEveryDays?: number;
  ticket?: WorkingGroupTicket;
  todo?: WorkingGroupTodo;
}

export function ticketTask(ticket: WorkingGroupTicket): Task {
  return {
    key: `ticket:${ticket.id}`,
    kind: 'ticket',
    id: ticket.id,
    groupId: ticket.groupId,
    groupName: ticket.groupName,
    title: ticket.subject,
    state: ticket.status === 'planned' ? 'open' : ticket.status,
    columnId: ticket.columnId,
    dueOn: ticket.dueOn,
    assignee: ticket.assignee,
    author: ticket.author,
    followerCount: ticket.followerCount,
    commentCount: ticket.commentCount,
    isMine: ticket.isMine,
    isFollowing: ticket.isFollowing,
    inside: ticket.inside,
    version: ticket.version,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    ticket,
  };
}

export function todoTask(todo: WorkingGroupTodo): Task {
  return {
    key: `todo:${todo.id}`,
    kind: 'todo',
    id: todo.id,
    groupId: todo.groupId,
    groupName: todo.groupName,
    title: todo.title,
    state: todo.done ? 'done' : 'open',
    columnId: todo.columnId,
    dueOn: todo.dueOn,
    assignee: todo.assignee,
    author: todo.createdBy,
    followerCount: 0,
    commentCount: todo.commentCount,
    isMine: todo.isMine,
    isFollowing: false,
    inside: true,
    version: todo.version,
    createdAt: todo.createdAt,
    updatedAt: todo.updatedAt,
    repeatEveryDays: todo.repeatEveryDays,
    todo,
  };
}

export const isOpen = (task: Task) => task.state === 'new' || task.state === 'open';

// Dates are plain `YYYY-MM-DD` strings; "today" is the calendar day in the app time zone.
export const todayOn = () => dateInAppTimeZone(new Date());
const dayMs = 86_400_000;
export const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) / dayMs);
export const addDays = addCalendarDays;

export function bucketOf(task: Task, today: string): Bucket {
  if (!isOpen(task)) return 'done';
  if (task.state === 'new') return 'inbox';
  if (!task.dueOn) return 'none';
  const days = daysBetween(today, task.dueOn);
  if (days < 0) return 'overdue';
  if (days < 7) return 'week';
  if (days < 14) return 'nextWeek';
  return 'later';
}

/** The status column an open task counts in; closed tasks count in none. */
export function statusOf(task: Task, today: string): StatusKey | null {
  const bucket = bucketOf(task, today);
  if (bucket === 'done') return null;
  if (bucket === 'inbox' || bucket === 'overdue' || bucket === 'week') return bucket;
  return 'later';
}

export const STATUS_COLUMNS: { key: StatusKey; label: string }[] = [
  { key: 'inbox', label: 'Inbox' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'week', label: 'Due this week' },
  { key: 'later', label: 'Later' },
];

export const BUCKETS: { key: Bucket; label: string }[] = [
  { key: 'inbox', label: 'Inbox' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'week', label: 'This week' },
  { key: 'nextWeek', label: 'Next week' },
  { key: 'later', label: 'Later' },
  { key: 'none', label: 'No due date' },
  { key: 'done', label: 'Done' },
];

export const FORMER = 'Former member';
export const personName = (person: WorkingGroupPerson | undefined | null) => person?.displayName ?? FORMER;
export const firstName = (person: WorkingGroupPerson | undefined | null) =>
  person ? person.displayName.split(' ')[0] : FORMER;
export function initials(person: WorkingGroupPerson | undefined | null): string {
  if (!person) return '?';
  return person.displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
}

export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export interface DueHint {
  text: string;
  tone: 'error' | 'warning' | 'plain';
}

export function dueHint(task: Task, today: string): DueHint | null {
  if (!isOpen(task) || !task.dueOn) return null;
  const days = daysBetween(today, task.dueOn);
  if (days < 0) return { text: `${plural(-days, 'day')} late`, tone: 'error' };
  if (days === 0) return { text: 'due today', tone: 'error' };
  if (days < 7) return { text: `due in ${plural(days, 'day')}`, tone: 'warning' };
  return { text: `in ${plural(days, 'day')}`, tone: 'plain' };
}

export function dateParts(date: string) {
  const day = new Date(`${date}T00:00:00Z`);
  const format = (options: Intl.DateTimeFormatOptions) =>
    day.toLocaleDateString('en-GB', { ...options, timeZone: 'UTC' });
  return { weekday: format({ weekday: 'short' }), day: format({ day: 'numeric' }), month: format({ month: 'short' }) };
}

export const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

export const TICKET_KIND_LABEL: Record<WorkingGroupTicketKind, string> = {
  problem: 'Problem',
  request: 'Request',
  question: 'Question',
};

export const REPEAT_CHOICES: { days: number; label: string }[] = [
  { days: 7, label: 'Every week' },
  { days: 14, label: 'Every 2 weeks' },
  { days: 30, label: 'Every month' },
  { days: 90, label: 'Every 3 months' },
  { days: 180, label: 'Every 6 months' },
];

export function repeatLabel(days: number | undefined): string {
  if (!days) return 'Does not repeat';
  return REPEAT_CHOICES.find((choice) => choice.days === days)?.label ?? `Every ${plural(days, 'day')}`;
}

/** The second line of a row: "Ticket · Problem · Prusa CORE One" or "To-do · repeats every 7 days". */
export function kindLine(task: Task): string {
  if (task.ticket) {
    return `Ticket · ${TICKET_KIND_LABEL[task.ticket.kind]} · ${task.ticket.machineName ?? 'General'}`;
  }
  return task.repeatEveryDays ? `To-do · repeats every ${plural(task.repeatEveryDays, 'day')}` : 'To-do';
}

export interface Stage {
  steps: string[];
  index: number;
  label: string;
}

/** Inbox → the group's columns → Done, and where the task stands. */
export function stageOf(task: Task, columns: readonly { id: string; name: string }[]): Stage {
  const steps = ['Inbox', ...columns.map((column) => column.name), 'Done'];
  if (task.state === 'new') return { steps, index: 0, label: 'Inbox' };
  if (task.state === 'done') return { steps, index: steps.length - 1, label: 'Done' };
  if (task.state === 'declined') return { steps, index: steps.length - 1, label: 'Declined' };
  const at = Math.max(
    0,
    columns.findIndex((column) => column.id === task.columnId),
  );
  return { steps, index: 1 + at, label: columns[at]?.name ?? 'Planned' };
}

/** Whether a task counts as the caller's: assigned to them, or a ticket they wrote or follow. */
export function isMineTask(task: Task, me: string): boolean {
  if (task.assignee?.personId === me) return true;
  return task.kind === 'ticket' && (task.author?.personId === me || task.isFollowing);
}
