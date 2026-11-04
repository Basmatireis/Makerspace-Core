import { ContainedList, ContainedListItem, Tag } from '@carbon/react';
import type { PublicPresence } from '../../../api/generated/models';
import { formatTime, initials } from './format';

export function PresencePanel({
  items,
  onSelect,
}: {
  items: PublicPresence[];
  /** Set only when names may be tapped to check out (public_tap). */
  onSelect?: (visit: PublicPresence) => void;
}) {
  const sorted = [...items].sort((a, b) => a.checkedInAt.localeCompare(b.checkedInAt));

  return (
    <aside className="tablet-presence">
      <ContainedList
        kind="on-page"
        size="xl"
        label={
          <span className="tablet-presence__label">
            Currently here
            <Tag type="cool-gray" size="sm">
              {items.length}
            </Tag>
          </span>
        }
      >
        {sorted.length === 0 && <ContainedListItem>Nobody is checked in.</ContainedListItem>}
        {sorted.map((visit) => (
          <ContainedListItem
            key={visit.visitId}
            className="tablet-person"
            onClick={onSelect ? () => onSelect(visit) : undefined}
          >
            <span className="tablet-person__row">
              <span className="tablet-person__avatar" aria-hidden="true">
                {initials(visit.displayName)}
              </span>
              <span className="tablet-person__name">{visit.displayName}</span>
              <span className="tablet-person__since">since {formatTime(visit.checkedInAt)}</span>
            </span>
          </ContainedListItem>
        ))}
      </ContainedList>
      {onSelect && items.length > 0 && <p className="tablet-presence__hint">Leaving? Tap your name to check out.</p>}
    </aside>
  );
}
