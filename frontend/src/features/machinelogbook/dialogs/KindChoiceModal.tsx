import { useState } from 'react';
import { Modal, RadioButton, RadioButtonGroup } from '@carbon/react';
import type { MaterialKind } from '../../../api/generated/models';
import { kindNames } from '../components/inventoryShared';

/** Asks which kind an action applies to when the current view mixes several kinds. */
export function KindChoiceModal({
  heading,
  kinds,
  labels = kindNames,
  onChoose,
  onClose,
}: {
  heading: string;
  kinds: MaterialKind[];
  labels?: Record<MaterialKind, string>;
  onChoose: (kind: MaterialKind) => void;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<MaterialKind>(kinds[0]);
  return (
    <Modal
      open
      size="sm"
      modalHeading={heading}
      primaryButtonText="Continue"
      secondaryButtonText="Cancel"
      onRequestClose={onClose}
      onRequestSubmit={() => onChoose(kind)}
    >
      <RadioButtonGroup
        name="kind-choice"
        legendText="Kind"
        valueSelected={kind}
        orientation="vertical"
        onChange={(value) => setKind(value as MaterialKind)}
      >
        {kinds.map((item) => (
          <RadioButton key={item} id={`kind-choice-${item}`} labelText={labels[item]} value={item} />
        ))}
      </RadioButtonGroup>
    </Modal>
  );
}
