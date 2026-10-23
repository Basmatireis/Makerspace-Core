import { ContainedList, ContainedListItem, Tag } from '@carbon/react';
import type { PublicPresence, PublicWaiting } from '../../../api/generated/models';
import { formatTime, initials } from './format';

export function PresencePanel({
  items,
  waiting,
  onSelect,
}: {
  items: PublicPresence[];
  waiting: PublicWaiting[];
  /** Set only when names may be tapped to check out (public_tap). */
  onSelect?: (visit: PublicPresence) => void;
}) {
  const sorted = [...items].sort((a, b) => a.checkedInAt.localeCompare(b.checkedInAt));

  return (
    <aside className="tablet-presence">
      {waiting.length > 0 && (
        <ContainedList
          kind="on-page"
          size="xl"
          className="tablet-presence__pending"
          label={
            <span className="tablet-presence__label">
              Waiting for Lab Rules
              <Tag type="red" size="sm">
                {waiting.length}
              </Tag>
            </span>
          }
        >
          {waiting.map((item) => (
            <ContainedListItem key={item.holdId} className="tablet-person">
              <span className="tablet-person__row">
                <span className="tablet-person__avatar tablet-person__avatar--hold" aria-hidden="true">
                  {initials(item.displayName)}
                </span>
                <span className="tablet-person__name">{item.displayName}</span>
                <span className="tablet-person__since">not checked in</span>
              </span>
            </ContainedListItem>
          ))}
        </ContainedList>
      )}
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
