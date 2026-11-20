import { IconButton, Link as CarbonLink } from '@carbon/react';
import { ArrowRight } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { workingGroupTicketOptions, workingGroupTodoOptions } from './queries';
import { taskLink } from './statusModel';
import { firstName, type Task } from './taskModel';
import { Avatar } from './TaskList';

const SHOWN = 3;
const MINUTE = 60_000;
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 24 * 60 * MINUTE],
  ['hour', 60 * MINUTE],
  ['minute', MINUTE],
];
const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "2 hours ago", "yesterday"; anything older than a month is a plain date. */
function relativeTime(value: string, now = Date.now()): string {
  const elapsed = new Date(value).getTime() - now;
  if (Math.abs(elapsed) < MINUTE) return 'just now';
  if (Math.abs(elapsed) > 30 * 24 * 60 * MINUTE) {
    return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(new Date(value));
  }
  const [unit, size] = UNITS.find(([, size]) => Math.abs(elapsed) >= size) ?? UNITS[2];
  return relative.format(Math.round(elapsed / size), unit);
}

/**
 * The latest three comments of a ticket or to-do under its list row. The list responses carry only a count, so the
 * comments are fetched per visible row (rows of other pages are not mounted) and cached for a short while.
 */
export function RowComments({ task }: { task: Task }) {
  const isTicket = task.kind === 'ticket';
  const ticket = useQuery({
    ...workingGroupTicketOptions(task.id),
    enabled: isTicket && task.commentCount > 0,
    staleTime: 30_000,
  });
  const todo = useQuery({
    ...workingGroupTodoOptions(task.id),
    enabled: !isTicket && task.commentCount > 0,
    staleTime: 30_000,
  });
  const comments = (isTicket ? ticket.data?.comments : todo.data?.comments) ?? [];
  if (comments.length === 0) return null;
  const more = Math.max(task.commentCount, comments.length) - SHOWN;
  return (
    <ul className="wg-rowcomments" aria-label={`Latest comments on ${task.title}`}>
      {comments.slice(-SHOWN).map((comment) => (
        <li key={comment.id} className="wg-rowcomment">
          <Avatar name={comment.author} />
          <span className="wg-rowcomment__text">
            <strong>{firstName(comment.author)}</strong>
            <span className="wg-muted">{relativeTime(comment.createdAt)}</span>
            <span className="wg-rowcomment__line">{comment.text}</span>
          </span>
        </li>
      ))}
      {more > 0 && (
        <li>
          <CarbonLink as={Link} to={taskLink(task)}>
            {more} more
          </CarbonLink>
        </li>
      )}
    </ul>
  );
}

/** The icon-only "Open" of a ticket or to-do row. */
export function OpenButton({ task }: { task: Task }) {
  const navigate = useNavigate();
  return (
    <IconButton kind="ghost" size="sm" label="Open" align="left" onClick={() => void navigate(taskLink(task))}>
      <ArrowRight />
    </IconButton>
  );
}
