import { ContainedList, ContainedListItem } from '@carbon/react';
import { eventIcons, ProposedTag } from '../status';
import { formatDateTime } from '../format';
import { LinkifiedText } from '../../components/RefLink';
import type { Order } from '../types';

/** Newest first. [proposed] needs an order audit read endpoint: today's audit events carry identifiers and field names only. */
export function OrderTimeline({ order }: { order: Order }) {
  const events = [...order.events].sort((a, b) => b.at.localeCompare(a.at));
  return (
    <ContainedList label={<span className="mj-inline">Timeline <ProposedTag hint="Needs an order audit read endpoint" /></span>} kind="on-page" className="sales-timeline">
      {events.map((event) => {
        const Icon = eventIcons[event.kind];
        return (
          <ContainedListItem key={event.id} renderIcon={Icon}>
            <span className="mj-cell-stack"><span><LinkifiedText text={event.text} /></span><span className="mj-secondary">{event.actor} · {formatDateTime(event.at)}</span></span>
          </ContainedListItem>
        );
      })}
    </ContainedList>
  );
}
