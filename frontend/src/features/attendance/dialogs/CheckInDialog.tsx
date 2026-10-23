import { ComposedModal } from '@carbon/react';
import { useState } from 'react';
import type { AttendanceHold } from '../../../api/generated/models';
import { AssistedCheckInStep } from './AssistedCheckInStep';
import { ConfirmLabRulesForm } from './ConfirmLabRulesForm';

// One dialog for both ways in: confirming a held check-in (hold given) and assisted check-in (person picked). An
// assisted check-in that comes back held continues in the same dialog with the Lab Rules confirmation.
export function CheckInDialog({
  open,
  hold: initialHold,
  canConfirm,
  excludedPersonIds,
  onClose,
  onWaiting,
}: {
  open: boolean;
  hold: AttendanceHold | null;
  canConfirm: boolean;
  excludedPersonIds: ReadonlySet<string>;
  onClose: () => void;
  onWaiting: (hold: AttendanceHold) => void;
}) {
  const [heldAfterPick, setHeldAfterPick] = useState<AttendanceHold | null>(null);
  const hold = initialHold ?? heldAfterPick;

  function close() {
    setHeldAfterPick(null);
    onClose();
  }

  return (
    <ComposedModal open={open} size="md" preventCloseOnClickOutside onClose={close}>
      {open &&
        (hold ? (
          <ConfirmLabRulesForm key={hold.id} hold={hold} onCancel={close} onDone={close} />
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
