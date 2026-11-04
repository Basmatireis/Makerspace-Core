import { ComposedModal } from '@carbon/react';
import { AssistedCheckInStep } from './AssistedCheckInStep';

/** Assisted check-in: a staff member picks the person who is arriving. */
export function CheckInDialog({
  open,
  excludedPersonIds,
  onClose,
}: {
  open: boolean;
  excludedPersonIds: ReadonlySet<string>;
  onClose: () => void;
}) {
  return (
    <ComposedModal open={open} size="md" preventCloseOnClickOutside onClose={onClose}>
      {open && <AssistedCheckInStep excludedPersonIds={excludedPersonIds} onCancel={onClose} onDone={onClose} />}
    </ComposedModal>
  );
}
