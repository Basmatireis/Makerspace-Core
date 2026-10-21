import { Tag } from '@carbon/react';
import type { Event, EventShiftStatus, EventStatus } from '../../../api/generated/models';
import { SHIFT_LABEL, signupTag, STATUS_LABEL } from '../logic';

const STATUS_TYPE: Record<EventStatus, 'cool-gray' | 'blue' | 'green' | 'red'> = {
  draft: 'cool-gray',
  confirmed: 'blue',
  completed: 'green',
  cancelled: 'red',
};
const SHIFT_TYPE: Record<EventShiftStatus, 'cool-gray' | 'green' | 'gray' | 'red'> = {
  draft: 'cool-gray',
  open: 'green',
  closed: 'gray',
  cancelled: 'red',
};

type Size = 'sm' | 'md';

export const EventStatusTag = ({ status, size }: { status: EventStatus; size?: Size }) => (
  <Tag type={STATUS_TYPE[status]} size={size}>
    {STATUS_LABEL[status]}
  </Tag>
);

export function PublicPageTag({ event, size }: { event: Pick<Event, 'goLive'>; size?: Size }) {
  const live = event.goLive.publicPage.state === 'live';
  return (
    <Tag type={live ? 'green' : 'gray'} size={size}>
      {live ? 'Live' : 'Off'}
    </Tag>
  );
}

export function SignupStateTag({ event, size }: { event: Pick<Event, 'goLive'>; size?: Size }) {
  const tag = signupTag(event.goLive);
  return (
    <Tag type={tag.type} size={size}>
      {tag.label}
    </Tag>
  );
}

export const VisibilityTag = ({ isPublic, size = 'sm' }: { isPublic: boolean; size?: Size }) => (
  <Tag type={isPublic ? 'green' : 'outline'} size={size}>
    {isPublic ? 'Public' : 'Internal'}
  </Tag>
);

export const ShiftStatusTag = ({ status, size = 'sm' }: { status: EventShiftStatus; size?: Size }) => (
  <Tag type={SHIFT_TYPE[status]} size={size}>
    {SHIFT_LABEL[status]}
  </Tag>
);
