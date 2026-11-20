import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckmarkOutline, Document, Folder, Pin, ShoppingCart, Ticket } from '@carbon/icons-react';
import { Button, Link as CarbonLink, Tile } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { WorkingGroupActivityEntry } from '../../api/generated/models';
import { Avatar } from './TaskList';
import { projectLink, purchaseLink, relativeTime, taskItemLink } from './linkModel';
import { LATELY_FIRST, workingGroupActivityOptions } from './queries';

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

/** Without a known actor the sentence has no subject: "Purchase LED strip approved". */
const PASSIVE: Record<WorkingGroupActivityEntry['kind'], [string, string]> = {
  ticket_created: ['Ticket', 'written'],
  ticket_planned: ['Ticket', 'planned'],
  ticket_closed: ['Ticket', 'closed'],
  todo_done: ['To-do', 'done'],
  note_pinned: ['Note pinned:', ''],
  purchase_submitted: ['Purchase', 'asked for'],
  purchase_approved: ['Purchase', 'approved'],
  project_submitted: ['Project', 'handed in'],
  project_approved: ['Project', 'approved'],
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

/** The latest events of a group: five at first, "Show more" up to fifty. */
export function Lately({ groupId }: { groupId: string }) {
  const [limit, setLimit] = useState(LATELY_FIRST);
  const [focusFrom, setFocusFrom] = useState<number | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const activity = useQuery({
    ...workingGroupActivityOptions(groupId, limit),
    placeholderData: (previous) => previous,
  });
  const items = useMemo(() => activity.data?.items ?? [], [activity.data]);
  // Entries have no id of their own: kind, target and time identify one; a repeat of all three gets its index.
  const keys = useMemo(() => {
    const seen = new Set<string>();
    return items.map((entry, index) => {
      const key = `${entry.kind}:${entry.targetId}:${entry.at}`;
      const unique = seen.has(key) ? `${key}:${index}` : key;
      seen.add(unique);
      return unique;
    });
  }, [items]);

  // After "Show more" focus moves to the first newly loaded entry, since the button is gone.
  const settled = focusFrom !== null && !activity.isPlaceholderData && activity.isSuccess;
  useEffect(() => {
    if (!settled || focusFrom === null) return;
    const row = list.current?.children[focusFrom];
    const target = row instanceof HTMLElement ? (row.querySelector<HTMLElement>('a') ?? row) : list.current;
    target?.focus();
    setFocusFrom(null);
  }, [settled, focusFrom]);
  if (activity.isError || (activity.isSuccess && items.length === 0)) return null;
  return (
    <Tile className="wg-ov-side" aria-label="Lately">
      <h3 className="wg-ov-side__title">Lately</h3>
      <ul className="wg-lately" ref={list} tabIndex={-1}>
        {items.map((entry, index) => {
          const Icon = entry.targetKind in ICON ? ICON[entry.targetKind] : Document;
          const href = target(groupId, entry);
          const title = entry.title;
          const subject = href ? (
            <CarbonLink as={Link} to={href}>
              {title}
            </CarbonLink>
          ) : (
            title
          );
          return (
            <li key={keys[index]} tabIndex={-1}>
              {entry.actor ? <Avatar name={entry.actor} /> : <Icon size={16} aria-hidden />}
              <span>
                {entry.actor ? (
                  <>
                    <strong>{entry.actor.displayName.split(' ')[0]}</strong> {VERB[entry.kind]}{' '}
                  </>
                ) : (
                  <>{PASSIVE[entry.kind][0]} </>
                )}
                {subject}
                {!entry.actor && PASSIVE[entry.kind][1] ? ` ${PASSIVE[entry.kind][1]}` : ''}
              </span>
              <time className="wg-muted" dateTime={entry.at}>
                {relativeTime(entry.at)}
              </time>
            </li>
          );
        })}
      </ul>
      {limit < MAX && items.length >= limit && (
        <Button
          kind="ghost"
          size="sm"
          onClick={() => {
            setFocusFrom(items.length);
            setLimit(MAX);
          }}
        >
          Show more
        </Button>
      )}
    </Tile>
  );
}
