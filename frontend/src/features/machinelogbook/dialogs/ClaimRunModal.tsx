import { useState } from 'react';
import { Modal, RadioButton, RadioButtonGroup } from '@carbon/react';

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
  const [choice, setChoice] = useState<ClaimChoice>('create');
  return (
    <Modal
      open={open}
      size="sm"
      modalHeading="Claim run"
      primaryButtonText="Continue"
      secondaryButtonText="Cancel"
      onRequestClose={onClose}
      onRequestSubmit={() => onChoose(choice)}
    >
      <RadioButtonGroup
        name="claim-run"
        legendText="Record this run as"
        valueSelected={choice}
        orientation="vertical"
        onChange={(value) => setChoice(value as ClaimChoice)}
      >
        <RadioButton id="claim-run-create" labelText="A new job" value="create" />
        <RadioButton id="claim-run-attach" labelText="Part of an existing job" value="attach" />
      </RadioButtonGroup>
    </Modal>
  );
}
