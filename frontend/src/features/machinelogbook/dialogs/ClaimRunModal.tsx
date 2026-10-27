import { Modal } from '@carbon/react';

export type ClaimChoice = 'create' | 'attach';

/** Asks whether an unassigned run starts a new job or joins an existing one; the chosen dialog then opens. */
export function ClaimRunModal({
  open,
  onChoose,
  onClose,
}: {
  open: boolean;
  onChoose: (choice: ClaimChoice) => void;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      size="xs"
      modalHeading="Claim run"
      primaryButtonText="New job"
      secondaryButtonText="Existing job"
      onRequestClose={onClose}
      onRequestSubmit={() => onChoose('create')}
      onSecondarySubmit={() => onChoose('attach')}
    >
      <p>Record this run as a new job, or add it to an existing job on the same machine.</p>
    </Modal>
  );
}
