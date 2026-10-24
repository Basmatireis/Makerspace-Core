import { ComposedModal } from '@carbon/react';
import { useState } from 'react';
import type { AttendanceHold } from '../../../api/generated/models';
import { type ConfirmSubject, subjectFromHold } from '../presentation';
import { AssistedCheckInStep } from './AssistedCheckInStep';
import { ConfirmLabRulesForm } from './ConfirmLabRulesForm';

// One dialog for both ways in: confirming a held check-in (hold given) and assisted check-in (person picked). An
// assisted check-in that comes back held continues in the same dialog with the Lab Rules confirmation.
export function CheckInDialog({
  open,
  hold: initialHold,
  subject: initialSubject,
  canConfirm,
  excludedPersonIds,
  onClose,
  onWaiting,
}: {
  open: boolean;
  hold: AttendanceHold | null;
  /** Confirm a queue request directly (no held check-in involved). */
  subject?: ConfirmSubject | null;
  canConfirm: boolean;
  excludedPersonIds: ReadonlySet<string>;
  onClose: () => void;
  onWaiting: (hold: AttendanceHold) => void;
}) {
  const [heldAfterPick, setHeldAfterPick] = useState<AttendanceHold | null>(null);
  const hold = initialHold ?? heldAfterPick;
  const subject = initialSubject ?? (hold ? subjectFromHold(hold) : null);

  function close() {
    setHeldAfterPick(null);
    onClose();
  }

  return (
    <ComposedModal open={open} size="md" preventCloseOnClickOutside onClose={close}>
      {open &&
        (subject ? (
          <ConfirmLabRulesForm key={subject.key} subject={subject} onCancel={close} onDone={close} />
        ) : (
          <AssistedCheckInStep
            excludedPersonIds={excludedPersonIds}
            onCancel={close}
            onDone={close}
            onHeld={(held) => {
              if (canConfirm && held.laborordnungRequestId) setHeldAfterPick(held);
              else {
                close();
                onWaiting(held);
              }
            }}
          />
        ))}
    </ComposedModal>
  );
}
