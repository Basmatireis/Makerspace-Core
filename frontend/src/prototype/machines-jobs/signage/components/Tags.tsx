import { Tag } from '@carbon/react';
import { pluralize, relativeTime } from '../helpers';
import type { Display } from '../types';

export function StatusTag({ display, now }: { display: Display; now: number }) {
  if (display.revoked) return <Tag type="gray" size="md">Revoked</Tag>;
  if (display.status === 'online') return <Tag type="green" size="md">Online</Tag>;
  if (display.status === 'syncing') return <Tag type="blue" size="md">Syncing {display.syncPercent} %</Tag>;
  return <div className="mj-cell-stack"><Tag type="red" size="md">Offline</Tag><span className="mj-secondary">last seen {relativeTime(display.lastSeenAt, now)}</span></div>;
}

export function PublicationTag({ display }: { display: Display }) {
  if (display.pending.length === 0) return <Tag type="green" size="md">Up to date</Tag>;
  return <Tag type="warm-gray" size="md">{pluralize(display.pending.length, 'unpublished change')}</Tag>;
}
