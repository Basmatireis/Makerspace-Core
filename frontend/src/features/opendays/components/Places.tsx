import { Checkmark } from '@carbon/icons-react';
import { Tag } from '@carbon/react';
import type { OpenDay, OpenDayStaffRequirement, OpenDayTimeslot } from '../../../api/generated/models';
import { useCurrentUser } from '../../auth/auth';
import { initialsOf } from '../model/people';
import { free, slotEnded, type StateTagInfo } from '../model/state';

export function StateTag({ info }: { info: StateTagInfo | null }) {
  if (!info) return null;
  return (
    <Tag
      size="sm"
      type={info.color}
      renderIcon={info.color === 'green' ? Checkmark : undefined}
      className="od-state-tag"
    >
      {info.label}
    </Tag>
  );
}

/** The signed-in person's own place: their profile image when they have one, otherwise their initials on green. */
export function OwnDot({ initials = '' }: { initials?: string }) {
  const image = useCurrentUser().person.profileImage;
  return (
    <i className="od-av is-me" title="You">
      {image ? <img className="od-av__img" src={image.downloadUrl} alt="" /> : initials}
    </i>
  );
}

const kindLabel = (kind: string) => (kind === 'supervisor' ? 'Supervisors' : 'Trainees');

/**
 * The places of one requirement as avatars: filled = taken, dashed = free, blue = free and yours to take, red dashed =
 * a supervisor place that is still needed, green filled or your profile image = you.
 */
export function PlaceDots({
  day,
  slot,
  requirement,
  now,
  max = 4,
}: {
  day: OpenDay;
  slot: OpenDayTimeslot;
  requirement: OpenDayStaffRequirement | undefined;
  now: Date;
  max?: number;
}) {
  if (!requirement) return <span className="od-none">—</span>;
  const open = day.status !== 'cancelled' && !slotEnded(slot, now);
  const taken = requirement.assignments
    ? requirement.assignments.map((assignment) =>
        assignment.isCurrentUser ? (
          <OwnDot key={assignment.id} initials={initialsOf(assignment.displayName)} />
        ) : (
          <i key={assignment.id} className="od-av" title={assignment.displayName}>
            {initialsOf(assignment.displayName)}
          </i>
        ),
      )
    : Array.from({ length: requirement.assignedCount }, (_, index) => {
        // Without the names the own place still shows: it is the first taken dot.
        const mine = index === 0 && slot.myAssignment?.requirementId === requirement.id;
        return mine ? <OwnDot key={`taken-${index}`} /> : <i key={`taken-${index}`} className="od-av od-av--anon" />;
      });
  const empty = Array.from({ length: free(requirement) }, (_, index) => (
    <i
      key={`free-${index}`}
      className={`od-av od-av--free${requirement.canJoin ? ' is-for-me' : ''}${requirement.kind === 'supervisor' && open ? ' is-needed' : ''}`}
    />
  ));
  const all = [...taken, ...empty];
  const shown =
    all.length > max
      ? [
          ...all.slice(0, max - 1),
          <i key="more" className="od-av od-av--more">
            +{all.length - max + 1}
          </i>,
        ]
      : all;
  return (
    <span
      className="od-places"
      title={`${kindLabel(requirement.kind)}: ${requirement.assignedCount} of ${requirement.requiredCount}`}
    >
      <span className="od-places__dots">{shown.length ? shown : <span className="od-none">—</span>}</span>
      <span className="od-places__n">
        {requirement.assignedCount}/{requirement.requiredCount}
      </span>
    </span>
  );
}
