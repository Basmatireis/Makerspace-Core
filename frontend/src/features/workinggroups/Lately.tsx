import { useState } from 'react';
import { CheckmarkOutline, Document, Folder, Pin, ShoppingCart, Ticket } from '@carbon/icons-react';
import { Button, Link as CarbonLink, Tile } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { WorkingGroupActivityEntry } from '../../api/generated/models';
import { projectLink, purchaseLink, relativeTime, taskItemLink } from './linkModel';
import { workingGroupActivityOptions } from './queries';

const FIRST = 10;
const MAX = 50;

const VERB: Record<WorkingGroupActivityEntry['kind'], string> = {
  ticket_created: 'wrote the ticket',
  ticket_planned: 'planned the ticket',
  ticket_closed: 'closed the ticket',
  todo_done: 'finished the to-do',
  note_pinned: 'pinned a note:',
  purchase_submitted: 'asked for',
  purchase_approved: 'approved the purchase',
  project_submitted: 'handed in the project',
  project_approved: 'approved the project',
};

const ICON = {
  ticket: Ticket,
  todo: CheckmarkOutline,
  note: Pin,
  purchase: ShoppingCart,
  project: Folder,
} as const;

function target(groupId: string, entry: WorkingGroupActivityEntry): string | null {
  switch (entry.targetKind) {
    case 'ticket':
    case 'todo':
      return taskItemLink(groupId, entry.targetKind, entry.targetId);
    case 'purchase':
      return purchaseLink(groupId, entry.targetId);
    case 'project':
      return projectLink(entry.targetId);
    default:
      return null;
  }
}

/** The latest events of a group: ten at first, "Show more" up to fifty. */
export function Lately({ groupId }: { groupId: string }) {
  const [limit, setLimit] = useState(FIRST);
  const activity = useQuery({
    ...workingGroupActivityOptions(groupId, limit),
    placeholderData: (previous) => previous,
  });
  const items = activity.data?.items ?? [];
  if (activity.isError || (activity.isSuccess && items.length === 0)) return null;
  return (
    <Tile className="wg-lately-card" aria-label="Lately">
      <h3>Lately</h3>
      <ul className="wg-lately">
        {items.map((entry) => {
          const Icon = entry.targetKind in ICON ? ICON[entry.targetKind] : Document;
          const href = target(groupId, entry);
          const title = entry.title;
          return (
            <li key={`${entry.kind}:${entry.targetId}:${entry.at}`}>
              <Icon size={16} aria-hidden />
              <span>
                <strong>{entry.actor ? entry.actor.displayName.split(' ')[0] : 'Someone'}</strong> {VERB[entry.kind]}{' '}
                {href ? (
                  <CarbonLink as={Link} to={href}>
                    {title}
                  </CarbonLink>
                ) : (
                  title
                )}
              </span>
              <time className="wg-muted" dateTime={entry.at}>
                {relativeTime(entry.at)}
              </time>
            </li>
          );
        })}
      </ul>
      {limit < MAX && items.length >= limit && (
        <Button kind="ghost" size="sm" onClick={() => setLimit(MAX)}>
          Show more
        </Button>
      )}
    </Tile>
  );
}
