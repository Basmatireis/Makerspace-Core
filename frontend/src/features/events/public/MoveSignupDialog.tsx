import { InlineNotification, Modal, Select, SelectItem } from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { updateOwnPublicEventAssignment } from '../../../api/generated/public-events/public-events';
import type { EventSignup, PublicEvent } from '../../../api/generated/models';
import { fmtDay, fmtRange } from '../format';
import { eventKeys } from '../queries';

/** Moves a signed-in member's signup to another open place. */
export function MoveSignupDialog({
  event,
  assignment,
  onClose,
}: {
  event: PublicEvent;
  assignment: EventSignup;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const options = event.shifts.flatMap((shift) =>
    shift.requirements
      .filter(
        (requirement) => requirement.availability === 'available' || requirement.availability === 'authenticated_only',
      )
      .filter((requirement) => requirement.id !== assignment.requirementId)
      .map((requirement) => ({ shift, requirement, value: `${shift.id}:${requirement.id}` })),
  );
  const [choice, setChoice] = useState(options[0]?.value ?? '');
  const move = useMutation({
    mutationFn: () => {
      const [shiftId, requirementId] = choice.split(':');
      return updateOwnPublicEventAssignment(event.publicId, assignment.id, {
        shiftId,
        requirementId,
        expectedVersion: assignment.version,
      });
    },
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: eventKeys.public(event.publicId) }),
        client.invalidateQueries({ queryKey: eventKeys.own(event.publicId) }),
      ]);
      onClose();
    },
  });
  return (
    <Modal
      open
      size="sm"
      modalHeading="Move signup"
      modalLabel={event.title}
      primaryButtonText={move.isPending ? 'Moving…' : 'Move signup'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={!choice || move.isPending}
      preventCloseOnClickOutside
      onRequestClose={() => {
        if (!move.isPending) onClose();
      }}
      onRequestSubmit={() => move.mutate()}
    >
      {move.isError && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Signup not moved"
          subtitle="The place may be full, closed or overlap another shift."
        />
      )}
      {options.length === 0 ? (
        <p>No other place is open right now.</p>
      ) : (
        <Select id="move-place" labelText="New place" value={choice} onChange={(e) => setChoice(e.target.value)}>
          {options.map(({ shift, requirement, value }) => (
            <SelectItem
              key={value}
              value={value}
              text={`${shift.name} · ${requirement.name} (${fmtDay(shift.startsAt)}, ${fmtRange(shift.startsAt, shift.endsAt)})`}
            />
          ))}
        </Select>
      )}
    </Modal>
  );
}
