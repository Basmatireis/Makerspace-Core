import { IconButton, Link as CarbonLink } from '@carbon/react';
import { ArrowRight } from '@carbon/icons-react';
import { Link, useNavigate } from 'react-router-dom';
import { relativeTime } from './linkModel';
import { taskLink } from './statusModel';
import { firstName, type Task } from './taskModel';
import { Avatar } from './TaskList';

const SHOWN = 3;

/**
 * The latest three comments of a ticket or to-do under its list row. The list responses carry them (newest first), so
 * a row needs no request of its own.
 */
export function RowComments({ task }: { task: Task }) {
  const latest = (task.ticket ?? task.todo)?.latestComments ?? [];
  const comments = [...latest].slice(0, SHOWN).reverse();
  if (comments.length === 0) return null;
  const more = task.commentCount - comments.length;
  return (
    <ul className="wg-rowcomments" aria-label={`Latest comments on ${task.title}`}>
      {comments.map((comment) => (
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
